import {
  cfApi,
  cfAuth,
  cfEnv,
  cfEnvDirect,
  cfTargetSpace,
  classifyCfError,
  extractHanaBindingsFromCfEnv,
  formatCurrentCfAppSelector,
  getApiEndpointForRegion,
  readCurrentCfTarget,
  withCfSession,
} from "./cf.js";
import { readSapCredentials } from "./config.js";
import { CfHanaError, CredentialsNotFoundError } from "./errors.js";
import type { CredentialSource, DbUserRole, HanaBinding } from "./types.js";

export interface ResolveBindingsOptions {
  readonly refresh?: boolean;
  readonly email?: string;
  readonly password?: string;
}

export interface ResolvedBindings {
  readonly selector: string;
  readonly appName: string;
  readonly bindings: readonly HanaBinding[];
  readonly source: CredentialSource;
}

export interface BindingSelector {
  readonly bindingName?: string;
  readonly bindingIndex?: number;
}

export interface SelectedConnectionTarget {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly schema: string;
  readonly certificate: string;
  readonly databaseId: string;
}

/**
 * Resolve an app's HANA bindings.
 *
 * Bare app name: Use current `cf target` to "nối" the app name.
 *   - First try the user's *existing* CF session directly via cfEnvDirect (no re-auth).
 *   - Only fall back to SAP + isolated re-auth if the error is classified as auth/session problem.
 * Explicit selector: Always full authenticated isolated path.
 *
 * This is the professional realization of the request:
 * "khi user truyền app thôi + đã cf target → chỉ nối tên app là đủ".
 * Auth/re-auth ONLY on session/unauthorize (per user feedback).
 */
export async function resolveAppBindings(
  rawSelector: string,
  options: ResolveBindingsOptions,
): Promise<ResolvedBindings> {
  const selector = rawSelector.trim();
  if (!selector) {
    throw new CfHanaError("CONFIG", "App selector is required");
  }

  let target: {
    selector: string;
    apiEndpoint?: string | undefined;
    orgName: string;
    spaceName: string;
    appName: string;
  };

  const isBare = !selector.includes("/");

  if (isBare) {
    // Bare: read current target, "nối" app name
    const current = await readCurrentCfTarget();
    if (!current) {
      throw new CfHanaError(
        "CONFIG",
        "No current CF target found. Run `cf target -o <org> -s <space>` or pass a full region/org/space/app selector.",
      );
    }
    const displaySelector = current.regionKey
      ? formatCurrentCfAppSelector(current, selector)
      : `current/${current.orgName}/${current.spaceName}/${selector}`;
    target = {
      selector: displaySelector,
      apiEndpoint: current.regionKey ? getApiEndpointForRegion(current.regionKey) : undefined,
      orgName: current.orgName,
      spaceName: current.spaceName,
      appName: selector,
    };
  } else {
    // Explicit: region/org/space/app
    const parts = selector.split("/").map((p) => p.trim());
    if (parts.length !== 4 || !parts[0] || !parts[1] || !parts[2] || !parts[3]) {
      throw new CfHanaError(
        "CONFIG",
        `Invalid selector "${selector}". Use region/org/space/app or a bare app name.`,
      );
    }
    const [regionKey, orgName, spaceName, appName] = parts as [string, string, string, string];
    const apiEndpoint = getApiEndpointForRegion(regionKey);
    if (!apiEndpoint) {
      throw new CfHanaError(
        "CONFIG",
        `Unknown region key "${regionKey}". Use a known region or the current CF target.`,
      );
    }
    target = { selector, apiEndpoint, orgName, spaceName, appName };
  }

  let bindings: readonly HanaBinding[];
  const source: CredentialSource = "live";

  if (isBare) {
    // Preferred fast path for bare: use whatever CF context the user already has.
    // NO re-auth, NO new CF_HOME.
    try {
      const stdout = await cfEnvDirect(target.appName);
      bindings = extractHanaBindingsFromCfEnv(stdout);
    } catch (directError: unknown) {
      // Professional classification: only re-auth for real auth/session problems.
      let stderr = '';
      if (directError && typeof directError === 'object') {
        const e = directError as { stderr?: unknown; message?: unknown };
        stderr = (typeof e.stderr === 'string' ? e.stderr : '') || (typeof e.message === 'string' ? e.message : '');
      }
      const classified = classifyCfError(stderr);
      if (classified.isAuthError) {
        const sap = readSapCredentials({ email: options.email, password: options.password });
        if (!sap) {
          throw new CredentialsNotFoundError(
            `Current CF session problem for bare app "${target.appName}" (${classified.reason}).\n` +
              `Run "cf login" + "cf target", or provide SAP_EMAIL + SAP_PASSWORD.`,
            { cause: directError }
          );
        }
        if (!target.apiEndpoint) {
          throw new CfHanaError("CONFIG", "Cannot determine API endpoint for fallback auth.");
        }
        const api = target.apiEndpoint;
        bindings = await withCfSession(async (ctx) => {
          await cfApi(api, ctx);
          await cfAuth(sap.email, sap.password, ctx);
          await cfTargetSpace(target.orgName, target.spaceName, ctx);
          const stdout = await cfEnv(target.appName, ctx);
          return extractHanaBindingsFromCfEnv(stdout);
        });
      } else {
        // Not auth-related (e.g. app not present in current space)
        throw new CfHanaError(
          "CONFIG",
          `Failed to get HANA bindings for bare app "${target.appName}" using current target (org=${target.orgName}, space=${target.spaceName}). ` +
            `Verify with "cf target" and "cf env ${target.appName}". ${stderr ? `Details: ${stderr}` : ""}`,
          { cause: directError }
        );
      }
    }
  } else {
    // Explicit selector always uses full authenticated isolated path
    const sap = readSapCredentials({ email: options.email, password: options.password });
    if (!sap) {
      throw new CredentialsNotFoundError(
        `SAP_EMAIL and SAP_PASSWORD are required to fetch HANA bindings for explicit selector "${selector}".`,
      );
    }
    if (!target.apiEndpoint) {
      throw new CfHanaError("CONFIG", "Invalid explicit selector.");
    }
    const api = target.apiEndpoint;
    bindings = await withCfSession(async (ctx) => {
      await cfApi(api, ctx);
      await cfAuth(sap.email, sap.password, ctx);
      await cfTargetSpace(target.orgName, target.spaceName, ctx);
      const stdout = await cfEnv(target.appName, ctx);
      return extractHanaBindingsFromCfEnv(stdout);
    });
  }

  if (bindings.length === 0) {
    throw new CredentialsNotFoundError(`App "${target.selector}" has no HANA service binding.`);
  }

  return {
    selector: target.selector,
    appName: target.appName,
    bindings,
    source,
  };
}

/** Pick a single HANA binding from an app's bindings. */
export function selectBinding(
  bindings: readonly HanaBinding[],
  selector: BindingSelector,
): HanaBinding {
  if (selector.bindingName !== undefined) {
    const match = bindings.find((binding) => binding.name === selector.bindingName);
    if (match === undefined) {
      throw new CfHanaError(
        "AMBIGUOUS_BINDING",
        `No HANA binding named "${selector.bindingName}"`,
      );
    }
    return match;
  }

  if (selector.bindingIndex !== undefined) {
    const match = bindings[selector.bindingIndex];
    if (match === undefined) {
      throw new CfHanaError(
        "AMBIGUOUS_BINDING",
        `No HANA binding at index ${String(selector.bindingIndex)}`,
      );
    }
    return match;
  }

  const first = bindings[0];
  if (first === undefined) {
    throw new CredentialsNotFoundError("No HANA bindings are available for this app");
  }
  if (bindings.length > 1) {
    const labels = bindings
      .map((binding, index) => binding.name ?? `#${String(index)}`)
      .join(", ");
    throw new CfHanaError(
      "AMBIGUOUS_BINDING",
      `App has multiple HANA bindings (${labels}); ` +
        `choose one with bindingName or bindingIndex`,
    );
  }
  return first;
}

/** Map a HANA binding to concrete connection parameters for the chosen role. */
export function toConnectionTarget(
  binding: HanaBinding,
  role: DbUserRole,
): SelectedConnectionTarget {
  const credentials = binding.credentials;
  const port = Number.parseInt(credentials.port, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new CfHanaError("CONFIG", `Invalid HANA port in binding: "${credentials.port}"`);
  }
  return {
    host: credentials.host,
    port,
    user: role === "hdi" ? credentials.hdiUser : credentials.user,
    password: role === "hdi" ? credentials.hdiPassword : credentials.password,
    schema: credentials.schema,
    certificate: credentials.certificate,
    databaseId: credentials.databaseId ?? "",
  };
}