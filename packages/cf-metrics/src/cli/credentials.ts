import type { Command } from "commander";

import { clearCredentialCache, credentialCacheOptionsFromEnv, listCachedCredentials } from "../credential-cache.js";
import { formatResult } from "../format.js";

import { parseFormat, print } from "./output.js";
import { withFormatOption } from "./shared-options.js";

interface ListOptions {
  readonly format: string;
}

async function runList(options: ListOptions): Promise<void> {
  const entries = await listCachedCredentials(credentialCacheOptionsFromEnv());
  print(
    formatResult(
      entries.map((entry) => ({
        TARGET: `${entry.region}/${entry.org}/${entry.space}`,
        INSTANCE: entry.instance,
        SOURCE: entry.source,
        ENDPOINT: entry.dashboardsEndpoint,
        CACHED_AT: entry.cachedAt,
        EXPIRES_AT: entry.expiresAt,
      })),
      parseFormat(options.format),
    ),
  );
}

async function runClear(): Promise<void> {
  print(`removed=${String(await clearCredentialCache(credentialCacheOptionsFromEnv()))}`);
}

export function registerCredentialCommands(program: Command): void {
  const credential = program
    .command("credential")
    .description("inspect or remove the cached Cloud Logging dashboards credentials (the secret itself is never shown)");

  const list = credential
    .command("list")
    .description("list cached credentials by target, instance, source, endpoint and expiry — never the username or password");
  withFormatOption(list);
  list.action(async (_options: unknown, command: Command) => {
    await runList(command.opts<ListOptions>());
  });

  credential
    .command("clear")
    .description("forget every cached credential; the next command rediscovers it")
    .action(async () => {
      await runClear();
    });
}
