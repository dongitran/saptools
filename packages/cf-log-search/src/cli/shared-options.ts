import type { Command } from "commander";

import { collectRepeatable, parseNonNegativeIntOption } from "./output.js";

export function withTargetOptions(command: Command): Command {
  return command
    .option("--region <key>", "SAP BTP region key, e.g. br10 (falls back to ambient 'cf target')")
    .option("--org <name>", "Cloud Foundry org (falls back to ambient 'cf target')")
    .option("--space <name>", "Cloud Foundry space (falls back to ambient 'cf target')");
}

/**
 * Deliberately no `--allow-mint-credential` — unlike `cf-otel`/`cf-metrics`,
 * this package has no `saml-toggle.ts` (minting is out of scope for v1; see
 * the Global Constraints note). If credential discovery fails, the error
 * message from `@saptools/core`'s `discoverDashboardsCredential` names
 * `--service-key`/`--fallback-binding-app` as the ways to narrow the search —
 * it also mentions `--allow-mint-credential` generically (that message is
 * shared verbatim with the siblings), which is misleading here; Task 7's
 * `withOpenSearchClient` rewrites that one substring in the caught error
 * before surfacing it, rather than forking the shared message.
 */
export function withCredentialOptions(command: Command): Command {
  return command
    .option("--service-instance <name>", "Cloud Logging service instance name (default: auto-discover)")
    .option("--service-key <name>", "service key name to try (repeatable)", collectRepeatable, [])
    .option("--fallback-binding-app <name>", "app whose binding to try as a pre-SAML credential fallback (repeatable)", collectRepeatable, [])
    .option("--refresh-credential", "ignore the cached dashboards credential and rediscover it (the result replaces the cached one)", false)
    .option("--verbose", "print which credential-discovery step succeeded and why", false);
}

export function withFormatOption(command: Command): Command {
  return command.option("--format <format>", "output format: table, json, json-compact, or csv", "table");
}

export function withSaveOption(command: Command): Command {
  return command.option("--save", "save the full result and print a ref instead of printing it", false);
}

export function withTimeRangeOptions(command: Command): Command {
  return command
    .option("--since <time>", "relative (15m, 1h, 2d) or absolute ISO-8601 start time (default: 1h)")
    .option("--until <time>", "relative or absolute ISO-8601 end time");
}

export function withLimitOption(command: Command, defaultValue: number, description = "maximum rows to fetch"): Command {
  return command.option("--limit <n>", description, parseNonNegativeIntOption, defaultValue);
}
