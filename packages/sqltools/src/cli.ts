import process from "node:process";

import { Command } from "commander";

import {
  type ExportOptions,
  type ExportResult,
  buildEntryFromVcap,
  exportFromApp,
  exportFromCf,
  exportFromFile,
  exportFromVcap,
} from "./export.js";
import { toSqlToolsConnection } from "./sqltools.js";
import type { ExportContext } from "./types.js";

interface SharedExportFlags {
  readonly app: string;
  readonly region: string;
  readonly org: string;
  readonly space: string;
  readonly cwd?: string;
  readonly merge?: boolean;
  readonly credentialsOut?: string;
  readonly credentialsFile?: boolean;
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => {
      resolvePromise(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", rejectPromise);
  });
}

function buildContext(flags: SharedExportFlags): ExportContext {
  return {
    app: flags.app,
    region: flags.region,
    org: flags.org,
    space: flags.space,
  };
}

function exportOptionsFromFlags(flags: SharedExportFlags): ExportOptions {
  return {
    ...(flags.cwd === undefined ? {} : { workspaceRoot: flags.cwd }),
    ...(flags.merge === undefined ? {} : { merge: flags.merge }),
    ...(flags.credentialsOut === undefined ? {} : { credentialsOutputPath: flags.credentialsOut }),
    writeCredentialsFile: flags.credentialsFile !== false,
  };
}

function summariseExport(result: ExportResult): string {
  const lines = [
    `✔ Updated SQLTools connections (${result.connectionCount.toString()}) → ${result.settingsPath}`,
  ];
  if (result.credentialsPath !== undefined) {
    lines.push(`  Credentials JSON saved → ${result.credentialsPath}`);
  }
  for (const entry of result.entries) {
    lines.push(
      `  • ${entry.app} (${entry.region}) ${entry.hana.host}:${entry.hana.port} schema=${entry.hana.schema}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function addSharedExportOptions(cmd: Command): Command {
  return cmd
    .requiredOption("--app <name>", "App name label for the SQLTools connection")
    .requiredOption("--region <key>", "Region key label (e.g. eu10)")
    .requiredOption("--org <name>", "Cloud Foundry org label")
    .requiredOption("--space <name>", "Cloud Foundry space label")
    .option("--cwd <dir>", "Workspace root that owns .vscode/settings.json (default: cwd)")
    .option("--merge", "Merge with existing connections by name (default: overwrite)", false)
    .option(
      "--credentials-out <path>",
      "Path for the credentials JSON file (default: <cwd>/hana-credentials.json)",
    )
    .option("--no-credentials-file", "Skip writing the hana-credentials.json backup file");
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();
  program
    .name("sqltools-export")
    .description(
      "Export SAP HANA service bindings (VCAP_SERVICES) into VS Code SQLTools connections",
    );

  addSharedExportOptions(
    program
      .command("from-file")
      .description("Read VCAP_SERVICES from a JSON file")
      .requiredOption("--input <path>", "Path to JSON file containing VCAP_SERVICES"),
  ).action(
    async (opts: SharedExportFlags & { readonly input: string }): Promise<void> => {
      const result = await exportFromFile(
        { filePath: opts.input, context: buildContext(opts) },
        exportOptionsFromFlags(opts),
      );
      process.stdout.write(summariseExport(result));
    },
  );

  addSharedExportOptions(
    program
      .command("from-stdin")
      .description("Read VCAP_SERVICES JSON from stdin"),
  ).action(async (opts: SharedExportFlags): Promise<void> => {
    const raw = await readStdin();
    const result = await exportFromVcap(
      { vcapServices: raw, context: buildContext(opts) },
      exportOptionsFromFlags(opts),
    );
    process.stdout.write(summariseExport(result));
  });

  addSharedExportOptions(
    program
      .command("from-cf")
      .description("Call `cf env <app>` and pipe the VCAP_SERVICES section into the export"),
  ).action(async (opts: SharedExportFlags): Promise<void> => {
    const result = await exportFromCf(
      { context: buildContext(opts) },
      exportOptionsFromFlags(opts),
    );
    process.stdout.write(summariseExport(result));
  });

  addSharedExportOptions(
    program
      .command("from-app")
      .description(
        "Login to CF (SAP_EMAIL/SAP_PASSWORD from env), target org/space, and export",
      ),
  ).action(async (opts: SharedExportFlags): Promise<void> => {
    const email = process.env["SAP_EMAIL"];
    const password = process.env["SAP_PASSWORD"];
    if (!email || !password) {
      throw new Error(
        "SAP_EMAIL and SAP_PASSWORD environment variables are required for from-app",
      );
    }
    const result = await exportFromApp(
      { context: buildContext(opts), email, password },
      exportOptionsFromFlags(opts),
    );
    process.stdout.write(summariseExport(result));
  });

  program
    .command("convert")
    .description("Convert VCAP_SERVICES JSON (via --input or stdin) to a SQLTools connection JSON")
    .requiredOption("--app <name>", "App name label")
    .requiredOption("--region <key>", "Region key label")
    .requiredOption("--org <name>", "CF org label")
    .requiredOption("--space <name>", "CF space label")
    .option("--input <path>", "VCAP_SERVICES JSON file (default: stdin)")
    .action(
      async (opts: {
        readonly app: string;
        readonly region: string;
        readonly org: string;
        readonly space: string;
        readonly input?: string;
      }): Promise<void> => {
        const raw = opts.input
          ? await (await import("node:fs/promises")).readFile(opts.input, "utf-8")
          : await readStdin();
        const entry = buildEntryFromVcap({
          vcapServices: raw,
          context: { app: opts.app, region: opts.region, org: opts.org, space: opts.space },
        });
        if (entry === null) {
          process.stderr.write(`No HANA binding found for app "${opts.app}"\n`);
          process.exit(1);
        }
        const connection = toSqlToolsConnection(entry);
        process.stdout.write(`${JSON.stringify(connection, null, 2)}\n`);
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
