import { readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";

import { confirm, input, search, select } from "@inquirer/prompts";
import { Command, Option } from "commander";

import { runBruno } from "../commands/run.js";
import { setupApp } from "../commands/setup-app.js";
import { useContext } from "../commands/use.js";
import { promptForAppSelection } from "../prompts/app-search.js";
import { promptForEnvironments } from "../prompts/environment.js";
import { readBrunoCliState, readContext, writeBrunoCliState } from "../state/context.js";

function resolveCollectionDir(explicitCollection: string | undefined, explicitRoot: string | undefined): Promise<string> {
  if (explicitCollection) {
    return Promise.resolve(explicitCollection);
  }
  if (explicitRoot) {
    return Promise.resolve(explicitRoot);
  }
  if (process.env["SAPTOOLS_BRUNO_COLLECTION"]) {
    return Promise.resolve(process.env["SAPTOOLS_BRUNO_COLLECTION"]);
  }
  if (process.env["SAPTOOLS_BRUNO_ROOT"]) {
    return Promise.resolve(process.env["SAPTOOLS_BRUNO_ROOT"]);
  }
  return readBrunoCliState().then((state) => state?.rootDir ?? process.cwd());
}

function resolveProgramCollectionDir(program: Command): Promise<string> {
  const opts = program.opts<{ collection?: string; root?: string }>();
  return resolveCollectionDir(opts.collection, opts.root);
}

function writeLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function listDir(path: string): Promise<{ dirs: readonly string[]; bruFiles: readonly string[] }> {
  const entries = await readdir(path, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const bruFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".bru")).map((entry) => entry.name).sort();
  return { dirs, bruFiles };
}


async function collectBruFiles(root: string, current: string): Promise<readonly string[]> {
  const { dirs, bruFiles } = await listDir(current);
  const nested = await Promise.all(dirs.map(async (dir) => await collectBruFiles(root, join(current, dir))));
  const currentFiles = bruFiles.map((name) => join(current, name));
  return [...currentFiles, ...nested.flat()].sort();
}

function formatTreePath(root: string, fullPath: string): string {
  const rel = fullPath.startsWith(root) ? fullPath.slice(root.length).replace(/^[/\\]/, "") : fullPath;
  return rel.replace(/\\/g, "/");
}


function formatTreeResultLabel(relativePath: string): string {
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return "📄";
  }

  const lines: string[] = [];
  for (const [index, segment] of segments.entries()) {
    const isFile = index === segments.length - 1;
    const icon = isFile ? "📄" : "📁";
    if (index === 0) {
      lines.push(`${icon} ${segment}`);
      continue;
    }
    const indent = "  ".repeat(index);
    lines.push(`${indent}└─${icon} ${segment}`);
  }

  return lines.join("\n");
}

type NavChoice =
  | { readonly kind: "dir"; readonly name: string }
  | { readonly kind: "file"; readonly name: string }
  | { readonly kind: "back"; readonly name: "" }
  | { readonly kind: "exit"; readonly name: "" }
  | { readonly kind: "search"; readonly name: string };

function formatEntryTreePath(root: string, current: string, entryName: string): string {
  const fullPath = join(current, entryName);
  return formatTreePath(root, fullPath);
}

async function browseBruFile(root: string): Promise<string | undefined> {
  let current = root;
  for (;;) {
    const currentLevel = await listDir(current);
    const allFiles = await collectBruFiles(root, root);

    const selected = await search<NavChoice>({
      message: "",
      source: (inputValue) => {
        const query = (inputValue ?? "").trim().toLowerCase();

        if (query.length === 0) {
          const localChoices: { name: string; value: NavChoice }[] = [
            { name: "🔎", value: { kind: "search", name: "" } as const },
            ...currentLevel.dirs.map((dir) => ({
              name: `📁 ${dir}/`,
              value: { kind: "dir", name: dir } as const,
            })),
            ...currentLevel.bruFiles.map((file) => ({
              name: `📄 ${file}`,
              value: { kind: "file", name: file } as const,
            })),
            ...(current === root ? [] : [{ name: "⬅ ../", value: { kind: "back", name: "" } as const }]),
            { name: "✖ Exit", value: { kind: "exit", name: "" } as const },
          ];
          return localChoices;
        }

        const matchedFiles = allFiles
          .filter((file) => formatTreePath(root, file).toLowerCase().includes(query))
          .slice(0, 200)
          .map((file) => ({
            name: formatTreeResultLabel(formatTreePath(root, file)),
            value: { kind: "file", name: formatEntryTreePath(root, root, formatTreePath(root, file)) } as const,
          }));

        const matchedDirs = Array.from(
          new Set(
            allFiles
              .map((file) => formatTreePath(root, file))
              .flatMap((path) => {
                const parts = path.split("/");
                if (parts.length <= 1) {
                  return [];
                }
                const folders = parts.slice(0, -1);
                return folders.map((_, index) => folders.slice(0, index + 1).join("/"));
              })
              .filter((dirPath) => dirPath.toLowerCase().includes(query)),
          ),
        )
          .slice(0, 100)
          .map((dirPath) => ({
            name: formatTreeResultLabel(dirPath),
            value: { kind: "dir", name: dirPath } as const,
          }));

        return [
          { name: `🔎 ${query}`, value: { kind: "search", name: query } as const },
          ...matchedDirs,
          ...matchedFiles,
          ...(current === root ? [] : [{ name: "⬅ ../", value: { kind: "back", name: "" } as const }]),
          { name: "✖ Exit", value: { kind: "exit", name: "" } as const },
        ];
      },
    });

    if (selected.kind === "dir") {
      current = selected.name.includes("/") ? join(root, selected.name) : join(current, selected.name);
      continue;
    }
    if (selected.kind === "back") {
      current = resolve(current, "..");
      continue;
    }
    if (selected.kind === "search") {
      continue;
    }
    if (selected.kind === "file") {
      if (selected.name.endsWith(".bru") && selected.name.includes("/")) {
        return join(root, selected.name);
      }
      return join(current, selected.name);
    }
    return undefined;
  }
}

function registerSetupAppCommand(program: Command): void { /* unchanged */
  program.command("setup-app").description("Interactively scaffold a bruno app folder and seed __cf_* variables").action(async (): Promise<void> => {
    const result = await setupApp({
      root: await resolveProgramCollectionDir(program),
      prompts: {
        selectRegion: async (choices) => await select({ message: "Select region", choices: [...choices] }),
        selectOrg: async (choices) => await select({ message: "Select org", choices: [...choices] }),
        selectSpace: async (choices) => await select({ message: "Select space", choices: [...choices] }),
        selectApp: async (choices) => await promptForAppSelection(choices),
        confirmCreate: async (path) => await confirm({ message: `Create ${path}?`, default: true }),
        selectEnvironments: async (opts) => await promptForEnvironments(opts),
      },
      log: writeLine,
    });
    if (!result.created) {
      writeLine("Aborted.");
      return;
    }
    writeLine(`✔ App folder ready at ${result.appPath}`);
  });
}

async function resolveRunTarget(target: string | undefined): Promise<string> {
  if (target) {
    return target;
  }

  const ctx = await readContext();
  if (!ctx) {
    throw new Error("No target specified and no default context is set. Run `bruno use <region/org/space/app>` first.");
  }
  return `${ctx.region}/${ctx.org}/${ctx.space}/${ctx.app}`;
}

function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("Run a bruno request or folder, auto-injecting an XSUAA token")
    .argument("[target]", "Shorthand path (region/org/space/app[/folder/file.bru]) or real path")
    .option("-e, --env <name>", "Environment name (default: context or first)")
    .action(async (target: string | undefined, opts: { env?: string }): Promise<void> => {
      const result = await runBruno({
        root: await resolveProgramCollectionDir(program),
        target: await resolveRunTarget(target),
        ...(opts.env ? { environment: opts.env } : {}),
        log: writeLine,
      });
      process.exit(result.code);
    });
}

function registerUseCommand(program: Command): void {
  program
    .command("use")
    .description("Set the default CF context (region/org/space/app) for future `run` calls")
    .argument("<shorthand>", "region/org/space/app")
    .option("--no-verify", "Skip verifying the context against the cached CF structure")
    .action(async (shorthand: string, opts: { verify?: boolean }): Promise<void> => {
      const ctx = await useContext({ shorthand, verify: opts.verify !== false });
      process.stdout.write(`✔ Default context set to ${ctx.region}/${ctx.org}/${ctx.space}/${ctx.app}\n`);
    });
}

function registerSetRootCommand(program: Command): void {
  program
    .command("set-root")
    .description("Persist default Bruno root folder under ~/.saptools/bruno/")
    .argument("[dir]", "Root folder path")
    .action(async (dir: string | undefined): Promise<void> => {
      const raw = dir ?? (await input({ message: "Enter Bruno root folder path", default: process.cwd() }));
      const rootDir = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
      const saved = await writeBrunoCliState({ rootDir });
      writeLine(`✔ Bruno root saved: ${saved.rootDir}`);
    });
}

async function launchInteractiveMenu(program: Command): Promise<void> {
  const root = await resolveProgramCollectionDir(program);
  const action = await select({
    message: `Bruno menu (${root}) — choose an action`,
    choices: [
      { name: "Run .bru file", value: "run-file" },
      { name: "Set default context (use)", value: "use" },
      { name: "Setup app folder", value: "setup-app" },
      { name: "Set Bruno root folder", value: "set-root" },
      { name: "Exit", value: "exit" },
    ],
  });

  if (action === "run-file") {
    const filePath = await browseBruFile(root);
    if (!filePath) {
      writeLine("Aborted.");
      return;
    }
    const result = await runBruno({ root, target: filePath, log: writeLine });
    process.exit(result.code);
  }
  if (action === "use") {
    const shorthand = await input({ message: "Enter context shorthand (region/org/space/app)" });
    const ctx = await useContext({ shorthand, verify: true });
    writeLine(`✔ Default context set to ${ctx.region}/${ctx.org}/${ctx.space}/${ctx.app}`);
    return;
  }
  if (action === "setup-app") {
    await program.parseAsync(["node", "bruno", "setup-app"]);
    return;
  }
  if (action === "set-root") {
    await program.parseAsync(["node", "bruno", "set-root"]);
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();

  program
    .name("bruno")
    .description("Smart runner for Bruno with CF-aware env metadata and automatic token injection")
    .addOption(new Option("--collection <dir>", "Bruno collection directory (default: configured root, SAPTOOLS_BRUNO_COLLECTION or cwd)"))
    .addOption(new Option("--root <dir>", "Legacy alias for --collection").hideHelp());

  registerSetupAppCommand(program);
  registerRunCommand(program);
  registerUseCommand(program);
  registerSetRootCommand(program);

  if (argv.length <= 2) {
    await launchInteractiveMenu(program);
    return;
  }

  await program.parseAsync([...argv]);
}

try {
  await main(process.argv);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}