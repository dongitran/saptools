import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

import { REGIONS } from "@saptools/cf-sync";
import { Command } from "commander";


import { ARTIFACT_NAMES, exportArtifacts, formatExportCompletionMessage, type ArtifactName, type CfTarget } from "./index.js";

const execFileAsync = promisify(execFile);

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

async function readCurrentCfTarget(): Promise<{ region?: string; org?: string; space?: string } | undefined> {
  const cfBin = process.env["CF_EXPORT_CF_BIN"] ?? "cf";
  const isScript = cfBin.endsWith(".mjs") || cfBin.endsWith(".js");
  const file = isScript ? "node" : cfBin;
  const args = isScript ? [cfBin, "target"] : ["target"];
  try {
    const { stdout } = await execFileAsync(file, args, {
      maxBuffer: 1024 * 1024,
      timeout: 10000,
    });
    return parseCfTargetOutput(stdout);
  } catch {
    return undefined;
  }
}

function parseCfTargetOutput(stdout: string): { region?: string; org?: string; space?: string } | undefined {
  const fields = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const sep = line.indexOf(":");
    if (sep < 0) {
      continue;
    }
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (key && value) {
      fields.set(key, value);
    }
  }

  const apiEndpoint = fields.get("api endpoint");
  const orgName = fields.get("org");
  const spaceName = fields.get("space");

  if (!orgName || !spaceName) {
    return undefined;
  }

  let region: string | undefined;
  if (apiEndpoint) {
    const normalized = apiEndpoint.trim().replace(/(?<!\/)\/+$/, "").toLowerCase();
    for (const [key, reg] of Object.entries(REGIONS)) {
      const regionObj = reg as { apiEndpoint?: string };
      const regApi = regionObj.apiEndpoint?.trim().replace(/(?<!\/)\/+$/, "").toLowerCase();
      if (regApi === normalized) {
        region = key;
        break;
      }
    }
  }

  const result: { region?: string; org?: string; space?: string } = {
    org: orgName,
    space: spaceName,
  };
  if (region !== undefined) {
    result.region = region;
  }
  return result;
}

async function buildTarget(flags: TargetFlags): Promise<CfTarget> {
  let region = flags.region;
  let org = flags.org;
  let space = flags.space;

  if (!region || !org || !space) {
    const current = await readCurrentCfTarget();
    if (current) {
      region ??= current.region;
      org ??= current.org;
      space ??= current.space;
    }
  }

  return {
    region: requireFlag(region, "region"),
    org: requireFlag(org, "org"),
    space: requireFlag(space, "space"),
    app: requireFlag(flags.app, "app"),
  };
}

function addTargetOptions(cmd: Command): Command {
  return cmd
    .option("-r, --region <key>", "CF region key (e.g. ap10). Auto-detected from current `cf target` if omitted")
    .option("-o, --org <name>", "CF org name. Auto-detected from current `cf target` if omitted")
    .option("-s, --space <name>", "CF space name. Auto-detected from current `cf target` if omitted")
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
    .name("cf-export")
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
      const target = await buildTarget(opts);
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
