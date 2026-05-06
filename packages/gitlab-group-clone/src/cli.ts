import process from "node:process";

import { Command } from "commander";
import ora from "ora";

import { cloneGroupTree } from "./clone/cloner.js";
import { fetchGroupTree, flattenGroupTree } from "./gitlab/groups.js";
import type { CloneOptions, CloneProtocol } from "./types.js";

function requireToken(tokenOption: string | undefined): string {
  const token = tokenOption ?? process.env["GITLAB_TOKEN"];
  if (!token) {
    process.stderr.write(
      "Error: GitLab token is required. Set the GITLAB_TOKEN environment variable or use --token.\n",
    );
    process.exit(1);
  }
  return token;
}

function resolveGitlabUrl(urlOption: string | undefined): string {
  return urlOption ?? process.env["GITLAB_URL"] ?? "https://gitlab.com";
}

function resolveProtocol(raw: string): CloneProtocol {
  return raw === "ssh" ? "ssh" : "https";
}

function parseConcurrency(raw: string): number {
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 1) {
    process.stderr.write("Error: --concurrency must be a positive integer.\n");
    process.exit(1);
  }
  return n;
}

function isInteractiveEnv(): boolean {
  return process.stdout.isTTY && process.env["CI"] !== "true";
}

interface CloneCommandOptions {
  url?: string;
  token?: string;
  concurrency: string;
  protocol: string;
  includeArchived: boolean;
  update: boolean;
  dryRun: boolean;
  verbose: boolean;
}

interface ListCommandOptions {
  url?: string;
  token?: string;
  includeArchived: boolean;
  format: string;
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();

  program
    .name("gitlab-group-clone")
    .description(
      "Clone an entire GitLab group while preserving the subgroup folder structure.\n" +
        "Requires the GITLAB_TOKEN environment variable (or --token).",
    )
    .version("0.1.0");

  program
    .command("clone <group-path> [destination]")
    .description(
      "Clone all repositories in a GitLab group into a local folder tree that mirrors the group structure.",
    )
    .option("--url <url>", "GitLab instance URL (env: GITLAB_URL, default: https://gitlab.com)")
    .option(
      "--token <token>",
      "GitLab personal access token with read_api + read_repository scopes (env: GITLAB_TOKEN)",
    )
    .option("--concurrency <n>", "Number of parallel clone operations", "5")
    .option("--protocol <https|ssh>", "Clone protocol: https (uses token) or ssh (uses SSH key)", "https")
    .option("--include-archived", "Include archived repositories", false)
    .option("--update", "Pull latest changes when a repository already exists locally", false)
    .option("--dry-run", "Print what would be cloned without performing any git operations", false)
    .option("--verbose", "Print one status line per repository", false)
    .action(
      async (
        groupPath: string,
        destination: string | undefined,
        opts: CloneCommandOptions,
      ): Promise<void> => {
        const token = requireToken(opts.token);
        const gitlabUrl = resolveGitlabUrl(opts.url);
        const dest = destination ?? (groupPath.split("/").at(-1) ?? groupPath);
        const concurrency = parseConcurrency(opts.concurrency);
        const protocol = resolveProtocol(opts.protocol);
        const interactive = isInteractiveEnv();

        const spinner = ora({ isEnabled: interactive && !opts.verbose });

        try {
          spinner.start(`Fetching group structure for "${groupPath}"…`);
          const tree = await fetchGroupTree({ gitlabUrl, token }, groupPath);
          const total = flattenGroupTree(tree, opts.includeArchived).length;
          spinner.succeed(
            `Found ${total.toString()} repositor${total === 1 ? "y" : "ies"} in "${groupPath}"`,
          );

          if (opts.dryRun) {
            process.stdout.write("\nDry run — would clone:\n");
            for (const project of flattenGroupTree(tree, opts.includeArchived)) {
              const rel = project.pathWithNamespace.slice(tree.group.fullPath.length + 1);
              process.stdout.write(`  ${dest}/${rel}\n`);
            }
            return;
          }

          const options: CloneOptions = {
            destination: dest,
            gitlabUrl,
            token,
            concurrency,
            protocol,
            includeArchived: opts.includeArchived,
            update: opts.update,
            dryRun: opts.dryRun,
          };

          spinner.start(`Cloning ${total.toString()} repositor${total === 1 ? "y" : "ies"}…`);

          const summary = await cloneGroupTree(tree, options, (result, done, count) => {
            const icon =
              result.status === "cloned"
                ? "✓"
                : result.status === "updated"
                  ? "↑"
                  : result.status === "failed"
                    ? "✗"
                    : "–";

            if (opts.verbose) {
              process.stdout.write(
                `[${done.toString()}/${count.toString()}] ${icon} ${result.project.pathWithNamespace}\n`,
              );
              if (result.error) {
                process.stderr.write(`    ${result.error}\n`);
              }
            } else {
              spinner.text = `[${done.toString()}/${count.toString()}] ${result.project.name}…`;
            }
          });

          spinner.stop();

          process.stdout.write("\nSummary:\n");
          process.stdout.write(`  Cloned:  ${summary.cloned.toString()}\n`);
          if (summary.updated > 0) {
            process.stdout.write(`  Updated: ${summary.updated.toString()}\n`);
          }
          if (summary.skipped > 0) {
            process.stdout.write(`  Skipped: ${summary.skipped.toString()}\n`);
          }
          if (summary.failed > 0) {
            process.stdout.write(`  Failed:  ${summary.failed.toString()}\n`);
            for (const r of summary.results.filter((x) => x.status === "failed")) {
              process.stderr.write(`    ✗ ${r.project.pathWithNamespace}: ${r.error ?? "unknown error"}\n`);
            }
            process.exit(1);
          }
        } catch (error) {
          spinner.fail(error instanceof Error ? error.message : String(error));
          process.exit(1);
        }
      },
    );

  program
    .command("list <group-path>")
    .description("List all repositories in a GitLab group without cloning.")
    .option("--url <url>", "GitLab instance URL (env: GITLAB_URL, default: https://gitlab.com)")
    .option(
      "--token <token>",
      "GitLab personal access token (env: GITLAB_TOKEN)",
    )
    .option("--include-archived", "Include archived repositories", false)
    .option("--format <json|text>", "Output format", "text")
    .action(
      async (groupPath: string, opts: ListCommandOptions): Promise<void> => {
        const token = requireToken(opts.token);
        const gitlabUrl = resolveGitlabUrl(opts.url);
        const interactive = isInteractiveEnv();

        const spinner = ora({ isEnabled: interactive });

        try {
          spinner.start(`Fetching group structure for "${groupPath}"…`);
          const tree = await fetchGroupTree({ gitlabUrl, token }, groupPath);
          spinner.stop();

          const projects = flattenGroupTree(tree, opts.includeArchived);

          if (opts.format === "json") {
            process.stdout.write(`${JSON.stringify(projects, null, 2)}\n`);
          } else {
            for (const project of projects) {
              process.stdout.write(`${project.pathWithNamespace}\n`);
            }
          }
        } catch (error) {
          spinner.fail(error instanceof Error ? error.message : String(error));
          process.exit(1);
        }
      },
    );

  await program.parseAsync([...argv]);
}

await main(process.argv);
