import { readSapCredentials } from "../config.js";
import { discoverDashboardsCredential } from "../dashboards-credentials.js";
import { CredentialsNotFoundError } from "../errors.js";
import type { OpenSearchClient } from "../opensearch-client.js";
import { createOpenSearchClient } from "../opensearch-client.js";
import { printResolvedTarget, resolveTarget } from "../target.js";

import type { CredentialOpts, TargetOpts } from "./commandTypes.js";

/**
 * Every subcommand does the full login -> target -> credential-discovery ->
 * client dance itself; there is no separate "login" step to run first.
 */
export async function withOpenSearchClient<T>(
  opts: TargetOpts & CredentialOpts,
  work: (client: OpenSearchClient) => Promise<T>,
): Promise<T> {
  const target = await resolveTarget(opts);
  printResolvedTarget(target);

  const sap = readSapCredentials();
  if (sap === undefined) {
    throw new CredentialsNotFoundError("SAP_EMAIL and SAP_PASSWORD environment variables are required.");
  }

  const credential = await discoverDashboardsCredential(target, sap, {
    ...(opts.serviceInstance === undefined ? {} : { serviceInstance: opts.serviceInstance }),
    ...(opts.serviceKey.length > 0 ? { serviceKeyNames: opts.serviceKey } : {}),
    ...(opts.fallbackBindingApp.length > 0 ? { fallbackBindingApps: opts.fallbackBindingApp } : {}),
    allowMintCredential: opts.allowMintCredential,
    verbose: opts.verbose,
  });

  return await work(
    createOpenSearchClient({
      dashboardsEndpoint: credential.dashboardsEndpoint,
      username: credential.username,
      password: credential.password,
    }),
  );
}
