import process from "node:process";

import { Command } from "commander";

import { downloadFolder } from "./download-folder.js";
import { downloadFile } from "./download.js";
import { genEnv } from "./gen-env.js";
import { listFiles, resolveRemotePath } from "./list.js";
import { DEFAULT_APP_PATH, type CfTarget } from "./types.js";

interface TargetFlags {
  readonly region?: string;
  readonly org?: string;
  readonly space?: string;
  readonly app?: string;
}

function requireFlag(value: string | undefined, name: string): string {
  if (value === undefined || value === "") {
    process.stderr.write(`Error: --${name} is required\n`);
    process.exit(1);
  }
  return value;
}

function buildTarget(flags: TargetFlags): CfTarget {
  return {
    region: requireFlag(flags.region, "region"),
    org: requireFlag(flags.org, "org"),
    space: requireFlag(flags.space, "space"),
    app: requireFlag(flags.app, "app"),
  };
}

function addTargetOptions(cmd: Command): Command {
  return cmd
    .requiredOption("-r, --region <key>", "CF region key (e.g. ap10)")
    .requiredOption("-o, --org <name>", "CF org name")
    .requiredOption("-s, --space <name>", "CF space name")
    .requiredOption("-a, --app <name>", "CF app name");
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();

  program
    .name("saptools-cf-files")
    .description(
      "Export VCAP_SERVICES to default-env.json and pull files from running CF containers",
    );

  addTargetOptions(
    program
      .command("gen-env")
      .description("Write VCAP_SERVICES from a running CF app to a default-env.json file"),
  )
    .option("--out <path>", "Output path for default-env.json", "default-env.json")
    .action(
      async (opts: TargetFlags & { readonly out: string }): Promise<void> => {
        const target = buildTarget(opts);
        const result = await genEnv({ target, outPath: opts.out });
        process.stdout.write(`✔ Wrote ${result.outPath}\n`);
      },
    );

  addTargetOptions(
    program
      .command("list")
      .description("List files inside the running CF container"),
  )
    .option("--path <path>", "Remote path inside the container (default: --app-path)")
    .option("--app-path <path>", "Container base path for relative --path", DEFAULT_APP_PATH)
    .option("--json", "Emit JSON instead of human-readable output", false)
    .action(
      async (
        opts: TargetFlags & {
          readonly path?: string;
          readonly appPath: string;
          readonly json: boolean;
        },
      ): Promise<void> => {
        const target = buildTarget(opts);
        const remotePath =
          opts.path === undefined || opts.path === ""
            ? opts.appPath
            : resolveRemotePath(opts.path, opts.appPath);
        const entries = await listFiles({ target, remotePath });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
          return;
        }
        if (entries.length === 0) {
          process.stdout.write(`(empty: ${remotePath})\n`);
          return;
        }
        for (const entry of entries) {
          const suffix = entry.isDirectory ? "/" : "";
          process.stdout.write(`${entry.permissions}  ${entry.name}${suffix}\n`);
        }
      },
    );

  addTargetOptions(
    program
      .command("download")
      .description("Download a file from the running CF container"),
  )
    .requiredOption("--remote <path>", "Remote file path (absolute or relative to --app-path)")
    .requiredOption("--out <path>", "Local output path")
    .option("--app-path <path>", "Container base path for relative --remote", DEFAULT_APP_PATH)
    .action(
      async (
        opts: TargetFlags & {
          readonly remote: string;
          readonly out: string;
          readonly appPath: string;
        },
      ): Promise<void> => {
        const target = buildTarget(opts);
        const remotePath = resolveRemotePath(opts.remote, opts.appPath);
        const result = await downloadFile({ target, remotePath, outPath: opts.out });
        process.stdout.write(`✔ Wrote ${result.outPath} (${result.bytes.toString()} bytes)\n`);
      },
    );

  addTargetOptions(
    program
      .command("download-folder")
      .description("Download a folder from the running CF container in one tar transfer"),
  )
    .requiredOption("--remote <path>", "Remote folder path (absolute or relative to --app-path)")
    .requiredOption("--out <dir>", "Local output directory")
    .option("--app-path <path>", "Container base path for relative --remote", DEFAULT_APP_PATH)
    .option(
      "--exclude <path>",
      "Relative path to exclude (repeat for multiple: --exclude deps --exclude dist)",
      (v: string, acc: string[]) => [...acc, v],
      [] as string[],
    )
    .option(
      "--include <path>",
      "Relative path to include below an excluded parent (repeat for multiple)",
      (v: string, acc: string[]) => [...acc, v],
      [] as string[],
    )
    .action(
      async (
        opts: TargetFlags & {
          readonly remote: string;
          readonly out: string;
          readonly appPath: string;
          readonly exclude: string[];
          readonly include: string[];
        },
      ): Promise<void> => {
        const target = buildTarget(opts);
        const result = await downloadFolder({
          target,
          remotePath: opts.remote,
          outDir: opts.out,
          appPath: opts.appPath,
          exclude: opts.exclude,
          include: opts.include,
        });
        process.stdout.write(
          `✔ Downloaded ${result.files.toString()} file(s) (${result.bytes.toString()} bytes) to ${result.outDir}\n`,
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
