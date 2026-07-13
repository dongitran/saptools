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
  normalizeSapCfApiEndpoint,
  readCurrentCfTarget,
  withCfSession,
} from "./cf.js";
import { readSapCredentials } from "./config.js";
import type { SapCredentials } from "./config.js";
import { CfHanaError, CredentialsNotFoundError } from "./errors.js";
import type { CredentialSource, DbUserRole, HanaBinding, SelectorSource } from "./types.js";

export interface ResolveBindingsOptions {
  /** Deprecated compatibility flag. Binding discovery is always live. */
  readonly refresh?: boolean;
  readonly email?: string;
  readonly password?: string;
}

function errorMessageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid or untrusted CF API endpoint.";
}

export interface ResolvedBindings {
  readonly selector: string;
  readonly appName: string;
  readonly bindings: readonly HanaBinding[];
  readonly source: CredentialSource;
  readonly selectorSource: SelectorSource;
  readonly regionConfirmed: boolean;
  readonly selectorCanBePinned: boolean;
}

interface ResolvedAppTarget {
  readonly selector: string;
  readonly apiEndpoint: string;
  readonly orgName: string;
  readonly spaceName: string;
  readonly appName: string;
  readonly selectorSource: SelectorSource;
  readonly regionConfirmed: boolean;
  readonly selectorCanBePinned: boolean;
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

function parseExplicitTarget(selector: string): ResolvedAppTarget {
  const [regionKey, orgName, spaceName, appName, extra] = selector
    .split("/")
    .map((part) => part.trim());
  if (extra !== undefined || !regionKey || !orgName || !spaceName || !appName) {
    throw new CfHanaError(
      "CONFIG",
      `Invalid selector "${selector}". Use region/org/space/app or a bare app name.`,
    );
  }
  const apiEndpoint = getApiEndpointForRegion(regionKey);
  if (apiEndpoint === undefined) {
    throw new CfHanaError(
      "CONFIG",
      `Unknown SAP CF region "${regionKey}". Verify the current SAP region list or use the current CF target.`,
    );
  }
  try {
    return {
      selector,
      apiEndpoint: normalizeSapCfApiEndpoint(apiEndpoint),
      orgName,
      spaceName,
      appName,
      selectorSource: "explicit",
      regionConfirmed: true,
      selectorCanBePinned: true,
    };
  } catch (error) {
    throw new CfHanaError("CONFIG", errorMessageFromUnknown(error), { cause: error });
  }
}

async function resolveTarget(selector: string): Promise<ResolvedAppTarget> {
  if (selector.includes("/")) {
    return parseExplicitTarget(selector);
  }
  const current = await readCurrentCfTarget();
  if (current === undefined) {
    throw new CfHanaError(
      "CONFIG",
      "No current CF target found. Run `cf target -o <org> -s <space>` or pass a full region/org/space/app selector.",
    );
  }
  return {
    selector: formatCurrentCfAppSelector(current, selector),
    apiEndpoint: current.apiEndpoint,
    orgName: current.orgName,
    spaceName: current.spaceName,
    appName: selector,
    selectorSource: "ambient",
    regionConfirmed: current.regionKey !== undefined,
    selectorCanBePinned:
      current.regionKey !== undefined && getApiEndpointForRegion(current.regionKey) !== undefined,
  };
}

function commandErrorText(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }
  if ("stderr" in error && typeof error.stderr === "string" && error.stderr.length > 0) {
    return error.stderr;
  }
  return "message" in error && typeof error.message === "string" ? error.message : "";
}

function isSameTarget(
  target: ResolvedAppTarget,
  current: Awaited<ReturnType<typeof readCurrentCfTarget>>,
): boolean {
  return (
    current?.apiEndpoint === target.apiEndpoint &&
    current.orgName === target.orgName &&
    current.spaceName === target.spaceName
  );
}

async function assertAmbientTargetUnchanged(target: ResolvedAppTarget): Promise<void> {
  const current = await readCurrentCfTarget();
  if (!isSameTarget(target, current)) {
    throw new CfHanaError(
      "CONFIG",
      "CF target changed during binding discovery; no database connection was opened. Retry or use an explicit region/org/space/app selector.",
    );
  }
}

async function readIsolatedBindings(
  target: ResolvedAppTarget,
  sap: SapCredentials,
): Promise<readonly HanaBinding[]> {
  return await withCfSession(async (ctx) => {
    await cfApi(target.apiEndpoint, ctx);
    await cfAuth(sap.email, sap.password, ctx);
    await cfTargetSpace(target.orgName, target.spaceName, ctx);
    return extractHanaBindingsFromCfEnv(await cfEnv(target.appName, ctx));
  });
}

async function readBareBindings(
  target: ResolvedAppTarget,
  options: ResolveBindingsOptions,
): Promise<readonly HanaBinding[]> {
  let stdout: string;
  try {
    stdout = await cfEnvDirect(target.appName);
  } catch (directError) {
    const classified = classifyCfError(commandErrorText(directError));
    if (!classified.isAuthError) {
      throw new CfHanaError(
        "CONFIG",
        `Failed to get HANA bindings for bare app "${target.appName}" using current target (org=${target.orgName}, space=${target.spaceName}). ` +
          `Verify with "cf target" and "cf env ${target.appName}".`,
        { cause: directError },
      );
    }
    const sap = readSapCredentials({ email: options.email, password: options.password });
    if (sap === undefined) {
      throw new CredentialsNotFoundError(
        `Current CF session problem for bare app "${target.appName}" (${classified.reason}).\n` +
          `Run "cf login" + "cf target", or provide SAP_EMAIL + SAP_PASSWORD.`,
        { cause: directError },
      );
    }
    return await readIsolatedBindings(target, sap);
  }
  await assertAmbientTargetUnchanged(target);
  return extractHanaBindingsFromCfEnv(stdout);
}

/** Resolve every HANA binding for a pinned selector or the current CF target. */
export async function resolveAppBindings(
  rawSelector: string,
  options: ResolveBindingsOptions,
): Promise<ResolvedBindings> {
  const selector = rawSelector.trim();
  if (selector.length === 0) {
    throw new CfHanaError("CONFIG", "App selector is required");
  }
  const target = await resolveTarget(selector);
  const bindings =
    target.selectorSource === "ambient"
      ? await readBareBindings(target, options)
      : await readExplicitBindings(target, options);
  if (bindings.length === 0) {
    throw new CredentialsNotFoundError(`App "${target.selector}" has no HANA service binding.`);
  }
  return {
    selector: target.selector,
    appName: target.appName,
    bindings,
    source: "live",
    selectorSource: target.selectorSource,
    regionConfirmed: target.regionConfirmed,
    selectorCanBePinned: target.selectorCanBePinned,
  };
}

async function readExplicitBindings(
  target: ResolvedAppTarget,
  options: ResolveBindingsOptions,
): Promise<readonly HanaBinding[]> {
  const sap = readSapCredentials({ email: options.email, password: options.password });
  if (sap === undefined) {
    throw new CredentialsNotFoundError(
      `SAP_EMAIL and SAP_PASSWORD are required to fetch HANA bindings for explicit selector "${target.selector}".`,
    );
  }
  return await readIsolatedBindings(target, sap);
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
