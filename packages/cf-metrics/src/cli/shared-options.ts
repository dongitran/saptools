import type { Command } from "commander";

import { DEFAULT_WATCH_INTERVAL_MS, DEFAULT_WATCH_LOOKBACK } from "../config.js";

import { collectRepeatable, parseNonNegativeIntOption, parsePositiveIntOption } from "./output.js";

export function withTargetOptions(command: Command): Command {
  return command
    .option("--region <key>", "SAP BTP region key, e.g. eu10 (falls back to ambient 'cf target')")
    .option("--org <name>", "Cloud Foundry org (falls back to ambient 'cf target')")
    .option("--space <name>", "Cloud Foundry space (falls back to ambient 'cf target')");
}

export function withCredentialOptions(command: Command): Command {
  return command
    .option("--service-instance <name>", "Cloud Logging service instance name (default: auto-discover)")
    .option("--service-key <name>", "service key name to try (repeatable)", collectRepeatable, [])
    .option(
      "--fallback-binding-app <name>",
      "app whose binding to try as a pre-SAML credential fallback (repeatable)",
      collectRepeatable,
      [],
    )
    .option(
      "--allow-mint-credential",
      "last resort: temporarily disable SAML to mint a new key (disruptive to shared SSO login)",
      false,
    )
    .option(
      "--refresh-credential",
      "ignore the cached dashboards credential and rediscover it (the result replaces the cached one)",
      false,
    )
    .option("--verbose", "print which credential-discovery step succeeded and why", false);
}

export function withFormatOption(command: Command): Command {
  return command.option("--format <format>", "output format: table, json, json-compact, or csv", "table");
}

export function withSaveOption(command: Command): Command {
  return command.option("--save", "save the full result and print a ref instead of printing it", false);
}

export function withServiceOption(command: Command, required: boolean): Command {
  return required
    ? command.requiredOption("--service <name>", "filter by CF app name")
    : command.option("--service <name>", "filter by CF app name");
}

export function withTimeRangeOptions(command: Command): Command {
  return command
    .option("--since <time>", "relative (24h, 30m) or absolute ISO-8601 start time")
    .option("--until <time>", "relative or absolute ISO-8601 end time");
}

export function withLimitOption(command: Command, defaultValue: number, description = "maximum rows to return"): Command {
  return command.option("--limit <n>", description, parseNonNegativeIntOption, defaultValue);
}

export function withWatchOptions(command: Command): Command {
  return command
    .option(
      "--interval <ms>",
      "polling interval in milliseconds",
      parsePositiveIntOption,
      DEFAULT_WATCH_INTERVAL_MS,
    )
    .option("--lookback <duration>", "initial look-back window on start, e.g. 2m", DEFAULT_WATCH_LOOKBACK)
    .option("--json", "emit NDJSON instead of text, one point per line", false);
}
