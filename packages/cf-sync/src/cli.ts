import process from "node:process";

import { Command } from "commander";

import { cfStructurePath } from "./paths.js";
import { runSync } from "./sync.js";
import { REGION_KEYS } from "./types.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    process.stderr.write(`Missing required environment variable: ${name}\n`);
    process.exit(1);
  }
  return v;
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();

  program
    .name("cf-sync")
    .description("Sync SAP BTP Cloud Foundry structure to ~/.saptools/cf-structure.json");

  program
    .command("sync")
    .description("Authenticate and walk region → org → space → app for all accessible CF regions")
    .option("--verbose", "Print progress lines to stdout", false)
    .option("--no-interactive", "Disable spinner (auto-detected in CI)")
    .option(
      "--only <keys>",
      "Comma-separated list of region keys to sync (default: all)",
    )
    .action(
      async (opts: { verbose?: boolean; interactive?: boolean; only?: string }): Promise<void> => {
        const email = requireEnv("SAP_EMAIL");
        const password = requireEnv("SAP_PASSWORD");

        const onlyRegions = opts.only
          ? opts.only
              .split(",")
              .map((s) => s.trim())
              .filter((s): s is (typeof REGION_KEYS)[number] =>
                (REGION_KEYS as readonly string[]).includes(s),
              )
          : undefined;

        const isInteractive =
          opts.interactive !== false && process.stdout.isTTY && process.env["CI"] !== "true";

        const result = await runSync({
          email,
          password,
          verbose: opts.verbose ?? false,
          interactive: isInteractive,
          ...(onlyRegions ? { onlyRegions } : {}),
        });

        process.stdout.write(
          `✔ Structure written to ${cfStructurePath()}\n` +
            `  Accessible regions: ${result.accessibleRegions.length.toString()}\n` +
            `  Inaccessible regions: ${result.inaccessibleRegions.length.toString()}\n`,
        );
      },
    );

  await program.parseAsync([...argv]);
}

try {
  await main(process.argv);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}
