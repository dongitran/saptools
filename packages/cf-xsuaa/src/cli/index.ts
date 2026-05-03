import process from "node:process";

import { Command } from "commander";

import { fetchSecret, getToken, getTokenCached } from "../commands/index.js";
import { xsuaaDataPath } from "../paths.js";

import { addAppRefOptions, toAppRef } from "./app-ref.js";
import type { AppRefOptions } from "./app-ref.js";

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();
  program
    .name("cf-xsuaa")
    .description(`Manage XSUAA secrets and OAuth2 tokens in ${xsuaaDataPath()}`);

  addAppRefOptions(program.command("fetch-secret"))
    .description("Fetch XSUAA client credentials from the app's VCAP_SERVICES and save them")
    .action(async (opts: AppRefOptions): Promise<void> => {
      const ref = toAppRef(opts);
      const entry = await fetchSecret(ref);
      process.stdout.write(
        `✔ Secret stored for ${ref.region}/${ref.org}/${ref.space}/${ref.app}\n` +
          `  clientId: ${entry.credentials.clientId}\n` +
          `  url: ${entry.credentials.url}\n`,
      );
    });

  addAppRefOptions(program.command("get-token"))
    .description("Fetch a fresh OAuth2 access token (auto-fetches secret if missing)")
    .action(async (opts: AppRefOptions): Promise<void> => {
      const ref = toAppRef(opts);
      const token = await getToken(ref);
      process.stdout.write(`${token}\n`);
    });

  addAppRefOptions(program.command("get-token-cached"))
    .description("Return cached token if still valid, otherwise fetch a new one")
    .action(async (opts: AppRefOptions): Promise<void> => {
      const ref = toAppRef(opts);
      const token = await getTokenCached(ref);
      process.stdout.write(`${token}\n`);
    });

  await program.parseAsync([...argv]);
}
