#!/usr/bin/env node
import process from "node:process";

import { Command } from "commander";

import { maskGitportError, portGitLabMergeRequest } from "./port.js";
import { parseSourceMergeRequestRef } from "./repo-url.js";
import { GITPORT_GITLAB_TOKEN_ENV } from "./types.js";

interface PortFlags {
  readonly sourceMrUrl?: string | undefined;
  readonly destinationRepoUrl?: string | undefined;
  readonly baseBranch?: string | undefined;
  readonly portBranch?: string | undefined;
  readonly title?: string | undefined;
  readonly token?: string | undefined;
  readonly gitlabApiBase?: string | undefined;
  readonly keepWorkdir?: boolean | undefined;
  readonly json?: boolean | undefined;
}

function requireFlag(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`required option '${name}'`);
  }
  return value;
}

async function runPort(flags: PortFlags): Promise<void> {
  const source = parseSourceMergeRequestRef(requireFlag(flags.sourceMrUrl, "--source-mr-url <url>"));
  const result = await portGitLabMergeRequest({
    sourceRepo: source.sourceRepo.original,
    sourceMergeRequestIid: source.sourceMergeRequestIid,
    destRepo: requireFlag(flags.destinationRepoUrl, "--destination-repo-url <url>"),
    baseBranch: requireFlag(flags.baseBranch, "--base-branch <name>"),
    portBranch: requireFlag(flags.portBranch, "--port-branch <name>"),
    title: requireFlag(flags.title, "--title <title>"),
    token: flags.token,
    gitlabApiBase: flags.gitlabApiBase,
    keepWorkdir: flags.keepWorkdir,
  });
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Draft MR created: ${result.mergeRequestUrl}\n`);
  process.stdout.write(`Commits: ${result.commits.length.toString()}\n`);
  process.stdout.write(`Auto-resolved conflicts: ${result.conflicts.length.toString()}\n`);
}

function addPortOptions(program: Command): void {
  program
    .requiredOption("--source-mr-url <url>", "GitLab source merge request URL")
    .requiredOption("--destination-repo-url <url>", "GitLab repo URL receiving the ported commits")
    .requiredOption("--base-branch <name>", "Destination branch to create the port branch from")
    .requiredOption("--port-branch <name>", "Destination branch that receives the cherry-picks")
    .requiredOption("--title <title>", "Destination merge request title")
    .option("--token <token>", `GitLab token (falls back to ${GITPORT_GITLAB_TOKEN_ENV})`)
    .option("--gitlab-api-base <url>", "GitLab API base URL, such as https://gitlab.example.com/api/v4")
    .option("--keep-workdir", "Keep the isolated run folder after success", false)
    .option("--json", "Print JSON result", false)
    .action(async (flags: PortFlags): Promise<void> => {
      await runPort(flags);
    });
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();
  program.name("gitport").description("Port GitLab merge requests into another repository");
  addPortOptions(program);

  await program.parseAsync([...argv]);
}

try {
  await main(process.argv);
} catch (error: unknown) {
  process.stderr.write(`Error: ${maskGitportError(error, [process.env[GITPORT_GITLAB_TOKEN_ENV] ?? ""])}\n`);
  process.exit(1);
}
