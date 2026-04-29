import process from "node:process";

import { Command } from "commander";

import { maskGitportError, portGitLabMergeRequest } from "./port.js";
import { parseRepoRef } from "./repo-url.js";
import { GITPORT_GITLAB_TOKEN_ENV } from "./types.js";

interface PortFlags {
  readonly sourceMr?: string | undefined;
  readonly sourceRepo?: string | undefined;
  readonly destRepo?: string | undefined;
  readonly baseBranch?: string | undefined;
  readonly portBranch?: string | undefined;
  readonly token?: string | undefined;
  readonly gitlabApiBase?: string | undefined;
  readonly keepWorkdir?: boolean | undefined;
  readonly yes?: boolean | undefined;
  readonly json?: boolean | undefined;
}

function requireFlag(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`required option '${name}'`);
  }
  return value;
}

function parseIid(raw: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`Invalid merge request IID: ${raw}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Invalid merge request IID: ${raw}`);
  }
  return value;
}

function branchSafeName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "source";
}

function defaultPortBranch(sourceRepo: string, sourceMergeRequestIid: number): string {
  const repo = parseRepoRef(sourceRepo);
  return `gitport/${branchSafeName(repo.name)}-mr-${sourceMergeRequestIid.toString()}`;
}

async function runPort(flags: PortFlags): Promise<void> {
  const sourceRepo = requireFlag(flags.sourceRepo, "--source-repo <url>");
  const sourceMergeRequestIid = parseIid(requireFlag(flags.sourceMr, "--source-mr <iid>"));
  const portBranch = flags.portBranch ?? defaultPortBranch(sourceRepo, sourceMergeRequestIid);
  const result = await portGitLabMergeRequest({
    sourceRepo,
    destRepo: requireFlag(flags.destRepo, "--dest-repo <url>"),
    sourceMergeRequestIid,
    baseBranch: requireFlag(flags.baseBranch, "--base-branch <name>"),
    portBranch,
    token: flags.token,
    gitlabApiBase: flags.gitlabApiBase,
    keepWorkdir: flags.keepWorkdir,
    yes: flags.yes,
  });
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Draft MR created: ${result.mergeRequestUrl}\n`);
  process.stdout.write(`Run ID: ${result.runId}\n`);
  process.stdout.write(`Commits: ${result.commits.length.toString()}\n`);
  process.stdout.write(`Auto-resolved conflicts: ${result.conflicts.length.toString()}\n`);
}

function addPortOptions(program: Command): void {
  program
    .option("--source-mr <iid>", "Source GitLab merge request IID, such as 123")
    .option("--source-repo <url>", "GitLab repo URL containing the source MR")
    .option("--dest-repo <url>", "GitLab repo URL receiving the ported commits")
    .option("--base-branch <name>", "Destination branch to create the port branch from")
    .option("--port-branch <name>", "Destination branch that receives the cherry-picks")
    .option("--token <token>", `GitLab token (falls back to ${GITPORT_GITLAB_TOKEN_ENV})`)
    .option("--gitlab-api-base <url>", "GitLab API base URL, such as https://gitlab.example.com/api/v4")
    .option("--keep-workdir", "Keep the isolated run folder after success", false)
    .option("--yes", "Skip interactive confirmation", false)
    .option("--json", "Print JSON result", false)
    .action(async (flags: PortFlags): Promise<void> => {
      await runPort(flags);
    });
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();
  program.name("gitport").description("Port GitLab merge requests from repo A to repo B");
  addPortOptions(program);

  await program.parseAsync([...argv]);
}

try {
  await main(process.argv);
} catch (error: unknown) {
  process.stderr.write(`Error: ${maskGitportError(error, [process.env[GITPORT_GITLAB_TOKEN_ENV] ?? ""])}\n`);
  process.exit(1);
}
