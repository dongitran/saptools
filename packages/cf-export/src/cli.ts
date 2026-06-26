import process from "node:process";

import { Command } from "commander";

import { ARTIFACT_NAMES, exportArtifacts, formatExportCompletionMessage, type ArtifactName, type CfTarget } from "./index.js";

interface TargetFlags {
  readonly region?: string;
  readonly org?: string;
  readonly space?: string;
  readonly app?: string;
}

interface ExportFlags extends TargetFlags {
  readonly out?: string;
  readonly remoteRoot?: string;
  readonly file?: string[];
  readonly all?: boolean;
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

function parseArtifactList(files: string[] | undefined): readonly ArtifactName[] | undefined {
  if (!files || files.length === 0) {
    return undefined;
  }
  const result: ArtifactName[] = [];
  for (const chunk of files) {
    const parts = chunk.split(/[,\s]+/).filter((p) => p.length > 0);
    for (const p of parts) {
      if ((ARTIFACT_NAMES as readonly string[]).includes(p)) {
        result.push(p as ArtifactName);
      } else {
        process.stderr.write(`Error: unknown artifact "${p}". Valid: ${ARTIFACT_NAMES.join(", ")}\n`);
        process.exit(1);
      }
    }
  }
  return result.length > 0 ? result : undefined;
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();

  program
    .name("saptools-cf-export")
    .description(
      "Export project artifacts (package.json, lockfiles, .cdsrc.json, default-env.json, .npmrc) from a running CF app",
    );

  addTargetOptions(
    program
      .command("export", { isDefault: true })
      .description("Export artifacts from the target CF app (default command)"),
  )
    .option("--out <dir>", "Output directory (default: current working directory)")
    .option("--remote-root <path>", "Hint for the base directory inside the container containing the files")
    .option(
      "--file <name>",
      "Artifact to export (repeatable). Omit to export all. Example: --file package.json --file pnpm-lock.yaml",
      (val: string, prev: string[] | undefined) => [...(prev ?? []), val],
      [] as string[],
    )
    .option("--all", "Export all supported artifacts (default behavior)", false)
    .action(async (opts: ExportFlags): Promise<void> => {
      const target = buildTarget(opts);
      const outDir = opts.out && opts.out.length > 0 ? opts.out : process.cwd();
      const remoteRoot = opts.remoteRoot && opts.remoteRoot.trim().length > 0 ? opts.remoteRoot.trim() : undefined;

      const explicitFiles = parseArtifactList(opts.file);
      const artifacts = opts.all || !explicitFiles ? undefined : explicitFiles;

      const result = await exportArtifacts({
        target,
        outDir,
        ...(remoteRoot ? { remoteRoot } : {}),
        ...(artifacts ? { artifacts } : {}),
      });

      const msg = formatExportCompletionMessage(target.app, result.writtenFiles, result.skipped);
      process.stdout.write(`${msg}\n`);
      if (result.skipped.length > 0) {
        process.stdout.write(`Skipped (not found): ${result.skipped.join(", ")}\n`);
      }
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
