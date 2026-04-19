import process from "node:process";

import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { Command } from "commander";

import { readContext } from "./context.js";
import { runBruno } from "./run.js";
import { setupApp } from "./setup-app.js";
import { useContext } from "./use.js";

function resolveRoot(explicit: string | undefined): string {
  if (explicit) {
    return explicit;
  }
  if (process.env["SAPTOOLS_BRUNO_ROOT"]) {
    return process.env["SAPTOOLS_BRUNO_ROOT"];
  }
  return process.cwd();
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();

  program
    .name("saptools-bruno")
    .description("Smart runner for Bruno with CF-aware env metadata and automatic token injection")
    .option("--root <dir>", "Root directory of the bruno collection (default: cwd)");

  program
    .command("setup-app")
    .description("Interactively scaffold a bruno app folder and seed __cf_* variables")
    .action(async (): Promise<void> => {
      const root = resolveRoot(program.opts<{ root?: string }>().root);
      const result = await setupApp({
        root,
        prompts: {
          selectRegion: async (choices) => await select({ message: "Select region", choices: [...choices] }),
          selectOrg: async (choices) => await select({ message: "Select org", choices: [...choices] }),
          selectSpace: async (choices) => await select({ message: "Select space", choices: [...choices] }),
          selectApp: async (choices) => await select({ message: "Select app", choices: [...choices] }),
          confirmCreate: async (path) => await confirm({ message: `Create ${path}?`, default: true }),
          selectEnvironments: async ({ common, existing }) => {
            const seen = new Set<string>();
            const all = [...common, ...existing].filter((name) => {
              if (seen.has(name)) {
                return false;
              }
              seen.add(name);
              return true;
            });
            return await checkbox({
              message: "Environments to create (space to toggle, enter to confirm)",
              choices: all.map((name) => ({
                name,
                value: name,
                checked: existing.includes(name),
              })),
            });
          },
          inputCustomEnvName: async () => {
            const raw = await input({
              message: "Custom environment name (leave empty to skip)",
              default: "",
              validate: (v) => {
                const t = v.trim();
                if (t.length === 0) {
                  return true;
                }
                return /^[A-Za-z0-9._-]+$/.test(t)
                  ? true
                  : "Only letters, digits, dot, underscore, and dash are allowed.";
              },
            });
            const trimmed = raw.trim();
            return trimmed.length > 0 ? trimmed : null;
          },
        },
        log: (msg) => {
          process.stdout.write(`${msg}\n`);
        },
      });
      if (!result.created) {
        process.stdout.write("Aborted.\n");
        return;
      }
      process.stdout.write(`✔ App folder ready at ${result.appPath}\n`);
    });

  program
    .command("run")
    .description("Run a bruno request or folder, auto-injecting an XSUAA token")
    .argument("[target]", "Shorthand path (region/org/space/app[/folder/file.bru]) or real path")
    .option("-e, --env <name>", "Environment name (default: context or first)")
    .action(
      async (
        target: string | undefined,
        opts: { env?: string },
      ): Promise<void> => {
        const root = resolveRoot(program.opts<{ root?: string }>().root);
        let effectiveTarget = target;

        if (!effectiveTarget) {
          const ctx = await readContext();
          if (!ctx) {
            throw new Error(
              "No target specified and no default context is set. Run `saptools-bruno use <region/org/space/app>` first.",
            );
          }
          effectiveTarget = `${ctx.region}/${ctx.org}/${ctx.space}/${ctx.app}`;
        }

        const result = await runBruno({
          root,
          target: effectiveTarget,
          ...(opts.env ? { environment: opts.env } : {}),
          log: (msg) => {
            process.stdout.write(`${msg}\n`);
          },
        });
        process.exit(result.code);
      },
    );

  program
    .command("use")
    .description("Set the default CF context (region/org/space/app) for future `run` calls")
    .argument("<shorthand>", "region/org/space/app")
    .option("--no-verify", "Skip verifying the context against the cached CF structure")
    .action(async (shorthand: string, opts: { verify?: boolean }): Promise<void> => {
      const ctx = await useContext({
        shorthand,
        verify: opts.verify !== false,
      });
      process.stdout.write(`✔ Default context set to ${ctx.region}/${ctx.org}/${ctx.space}/${ctx.app}\n`);
    });

  await program.parseAsync([...argv]);
}

try {
  await main(process.argv);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}
