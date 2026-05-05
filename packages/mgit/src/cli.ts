import process from "node:process";

import { Command } from "commander";

import { addRepo, addRepoRecursive } from "./commands/add.js";
import { showBranch } from "./commands/branch.js";
import { cloneFromConfig } from "./commands/clone.js";
import { setContext, showContext } from "./commands/context.js";
import { fetchRepos } from "./commands/fetch.js";
import { freeze } from "./commands/freeze.js";
import { groupAdd, groupList, groupRemove } from "./commands/group.js";
import { listLong } from "./commands/ll.js";
import { listRepos } from "./commands/ls.js";
import { pullRepos } from "./commands/pull.js";
import { pushRepos } from "./commands/push.js";
import { removeRepo } from "./commands/remove.js";
import { renameRepo } from "./commands/rename.js";
import { shellCommand } from "./commands/shell.js";
import { superCommand } from "./commands/super.js";

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();

  program
    .name("mgit")
    .description("Manage multiple Git repositories — run commands, view status, organize into groups")
    .version("0.1.0");

  // ── add ─────────────────────────────────────────────────────────────────
  program
    .command("add <path>")
    .description("Register a git repository")
    .option("-n, --name <name>", "Custom name for the repository (defaults to directory name)")
    .option("-r, --recursive", "Recursively discover all git repos under <path>")
    .action(async (inputPath: string, opts: { name?: string; recursive?: boolean }) => {
      await (opts.recursive === true ? addRepoRecursive(inputPath) : addRepo(inputPath, opts.name));
    });

  // ── rm ──────────────────────────────────────────────────────────────────
  program
    .command("rm <name>")
    .description("Remove a repository from tracking")
    .action(async (name: string) => {
      await removeRepo(name);
    });

  // ── rename ──────────────────────────────────────────────────────────────
  program
    .command("rename <old-name> <new-name>")
    .description("Rename a tracked repository")
    .action(async (oldName: string, newName: string) => {
      await renameRepo(oldName, newName);
    });

  // ── ls ──────────────────────────────────────────────────────────────────
  program
    .command("ls [group]")
    .description("List tracked repository names (optionally filter by group)")
    .action(async (group?: string) => {
      await listRepos(group);
    });

  // ── ll ──────────────────────────────────────────────────────────────────
  program
    .command("ll [repos-or-groups...]")
    .description("Show status overview for all (or specified) repositories")
    .action(async (args: string[]) => {
      await listLong(args);
    });

  // ── fetch ────────────────────────────────────────────────────────────────
  program
    .command("fetch [repos-or-groups...]")
    .description("Run git fetch --all --prune across repositories")
    .action(async (args: string[]) => {
      await fetchRepos(args);
    });

  // ── pull ─────────────────────────────────────────────────────────────────
  program
    .command("pull [repos-or-groups...]")
    .description("Run git pull --ff-only across repositories")
    .action(async (args: string[]) => {
      await pullRepos(args);
    });

  // ── push ─────────────────────────────────────────────────────────────────
  program
    .command("push [repos-or-groups...]")
    .description("Run git push for specified repositories")
    .allowUnknownOption()
    .action(async (args: string[], opts: Record<string, unknown>, cmd: Command) => {
      const extra = cmd.args.slice(args.length);
      await pushRepos(args, extra);
    });

  // ── branch ───────────────────────────────────────────────────────────────
  program
    .command("branch [repos-or-groups...]")
    .alias("br")
    .description("Show branch information for repositories")
    .option("-a, --all", "Show all branches including remotes")
    .action(async (args: string[], opts: { all?: boolean }) => {
      await showBranch(args, opts.all ?? false);
    });

  // ── super ─────────────────────────────────────────────────────────────────
  program
    .command("super [repos-or-groups...]")
    .description(
      'Run an arbitrary git command across repositories. Separate repos from git args with "--"',
    )
    .allowUnknownOption()
    .passThroughOptions()
    .action(async (args: string[], _opts: Record<string, unknown>, cmd: Command) => {
      const rawArgs = cmd.args;
      const sepIdx = rawArgs.indexOf("--");
      const repos = sepIdx === -1 ? [] : rawArgs.slice(0, sepIdx);
      const gitArgs = sepIdx === -1 ? rawArgs : rawArgs.slice(sepIdx + 1);
      await superCommand(repos, gitArgs);
    });

  // ── shell ─────────────────────────────────────────────────────────────────
  program
    .command("shell [repos-or-groups...]")
    .description(
      'Run an arbitrary shell command inside each repository. Separate repos from command with "--"',
    )
    .allowUnknownOption()
    .passThroughOptions()
    .action(async (args: string[], _opts: Record<string, unknown>, cmd: Command) => {
      const rawArgs = cmd.args;
      const sepIdx = rawArgs.indexOf("--");
      const repos = sepIdx === -1 ? [] : rawArgs.slice(0, sepIdx);
      const shellArgs = sepIdx === -1 ? rawArgs : rawArgs.slice(sepIdx + 1);
      await shellCommand(repos, shellArgs.join(" "));
    });

  // ── group ─────────────────────────────────────────────────────────────────
  const groupCmd = program.command("group").description("Manage repository groups");

  groupCmd
    .command("add <repos...>")
    .description("Add repositories to a group")
    .requiredOption("-n, --name <name>", "Group name")
    .action(async (repos: string[], opts: { name: string }) => {
      await groupAdd(opts.name, repos);
    });

  groupCmd
    .command("rm <name>")
    .description("Remove a group")
    .action(async (name: string) => {
      await groupRemove(name);
    });

  groupCmd
    .command("ls")
    .description("List all groups and their members")
    .action(async () => {
      await groupList();
    });

  // ── context ────────────────────────────────────────────────────────────────
  program
    .command("context [group]")
    .description(
      'Get or set the active group context. Use "auto" to detect from cwd, "" to clear.',
    )
    .action(async (group?: string) => {
      await (group === undefined ? showContext() : setContext(group === "" ? null : group));
    });

  // ── clone ──────────────────────────────────────────────────────────────────
  program
    .command("clone")
    .description("Clone repositories from a JSON config file and register them")
    .requiredOption("-f, --file <path>", "Path to JSON config file")
    .action(async (opts: { file: string }) => {
      await cloneFromConfig(opts.file);
    });

  // ── freeze ─────────────────────────────────────────────────────────────────
  program
    .command("freeze")
    .description("Print current repository config as a JSON clone manifest")
    .action(async () => {
      await freeze();
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
