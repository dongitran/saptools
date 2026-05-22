import { fetchAppDbBindings, readDbAppView } from "@saptools/cf-sync";
import type { AppDbBinding } from "@saptools/cf-sync";

import { readSapCredentials } from "./config.js";
import { CfHanaError, CredentialsNotFoundError } from "./errors.js";
import type { CredentialSource, DbUserRole } from "./types.js";

export interface ResolveBindingsOptions {
  readonly refresh?: boolean;
  readonly email?: string;
  readonly password?: string;
}

export interface ResolvedBindings {
  readonly selector: string;
  readonly appName: string;
  readonly bindings: readonly AppDbBinding[];
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
 * Resolve an app's HANA bindings for a `region/org/space/app` selector (or a
 * bare app name): cache-first via `cf-sync`, falling back to a live CF fetch.
 */
export async function resolveAppBindings(
  selector: string,
  options: ResolveBindingsOptions,
): Promise<ResolvedBindings> {
  if (options.refresh !== true) {
    const view = await readDbAppView(selector);
    if (view !== undefined && view.entry.bindings.length > 0) {
      return {
        selector: view.entry.selector,
        appName: view.entry.appName,
        bindings: view.entry.bindings,
        source: "cache",
      };
    }
  }

  const credentials = readSapCredentials({
    email: options.email,
    password: options.password,
  });
  if (credentials === undefined) {
    throw new CredentialsNotFoundError(
      `No cached HANA credentials for "${selector}". ` +
        `Run \`cf-sync db-sync ${selector}\` first, or set SAP_EMAIL and ` +
        `SAP_PASSWORD to fetch them live.`,
    );
  }

  const fetched = await fetchAppDbBindings({
    selector,
    email: credentials.email,
    password: credentials.password,
  });
  if (fetched.bindings.length === 0) {
    throw new CredentialsNotFoundError(
      `App "${fetched.selector}" has no HANA service binding.`,
    );
  }
  return {
    selector: fetched.selector,
    appName: fetched.appName,
    bindings: fetched.bindings,
    source: "fresh",
  };
}

/** Pick a single HANA binding from an app's bindings. */
export function selectBinding(
  bindings: readonly AppDbBinding[],
  selector: BindingSelector,
): AppDbBinding {
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
  binding: AppDbBinding,
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
    databaseId: credentials.databaseId,
  };
}
