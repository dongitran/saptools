import chalk, { type ChalkInstance } from "chalk";

import type { BranchStatus, CommandResult, RepoStatus } from "../types.js";

const branchStatusColor: Record<BranchStatus, ChalkInstance> = {
  in_sync: chalk.green,
  ahead: chalk.magenta,
  behind: chalk.yellow,
  diverged: chalk.red,
  no_remote: chalk.white,
};

const branchStatusSymbol: Record<BranchStatus, string> = {
  in_sync: "✓",
  ahead: "↑",
  behind: "↓",
  diverged: "⇕",
  no_remote: "∅",
};

function formatSyncInfo(branchStatus: BranchStatus, ahead: number, behind: number): string {
  const symbol = branchStatusSymbol[branchStatus];
  if (branchStatus === "ahead") {
    return `${symbol}${String(ahead)}`;
  }
  if (branchStatus === "behind") {
    return `${symbol}${String(behind)}`;
  }
  if (branchStatus === "diverged") {
    return `${symbol}${String(ahead)}/${String(behind)}`;
  }
  return symbol;
}

export function formatRepoTable(statuses: readonly RepoStatus[]): string {
  if (statuses.length === 0) {
    return chalk.dim("No repositories tracked.");
  }

  const nameWidth = Math.max(4, ...statuses.map((s) => s.name.length));
  const branchWidth = Math.max(6, ...statuses.map((s) => s.status?.branch.length ?? 0));
  const syncWidth = Math.max(
    6,
    ...statuses.map((s) =>
      s.status ? formatSyncInfo(s.status.branchStatus, s.status.ahead, s.status.behind).length : 0,
    ),
  );

  const header = [
    chalk.bold.cyan("name".padEnd(nameWidth)),
    chalk.bold.cyan("branch".padEnd(branchWidth)),
    chalk.bold.cyan("sync".padEnd(syncWidth)),
    chalk.bold.cyan("flags"),
  ].join("  ");

  const separatorLen = nameWidth + 2 + branchWidth + 2 + syncWidth + 2 + 5;
  const separator = chalk.dim("─".repeat(separatorLen));

  const rows = statuses.map((s) => formatRepoRow(s, nameWidth, branchWidth, syncWidth));

  return [header, separator, ...rows].join("\n");
}

function formatRepoRow(
  s: RepoStatus,
  nameWidth: number,
  branchWidth: number,
  syncWidth: number,
): string {
  if (s.error !== null) {
    const name = chalk.red(s.name.padEnd(nameWidth));
    const err = chalk.red.dim(`error: ${s.error}`);
    return `${name}  ${err}`;
  }

  if (s.status === null) {
    return chalk.dim(s.name.padEnd(nameWidth));
  }

  const { branch, branchStatus, staged, unstaged, untracked, stashed, ahead, behind } = s.status;
  const colorFn = branchStatusColor[branchStatus];
  const syncInfo = formatSyncInfo(branchStatus, ahead, behind);

  const flags = [staged ? "+" : "", unstaged ? "*" : "", untracked ? "?" : "", stashed ? "$" : ""]
    .filter(Boolean)
    .join("");

  return [
    chalk.bold(s.name.padEnd(nameWidth)),
    chalk.dim(branch.padEnd(branchWidth)),
    colorFn(syncInfo.padEnd(syncWidth)),
    chalk.yellow(flags),
  ].join("  ");
}

export function printCommandResults(results: readonly CommandResult[]): void {
  for (const r of results) {
    process.stdout.write(`${chalk.bold.blue(`=== ${r.name} ===`)}\n`);
    if (r.error !== null) {
      process.stdout.write(`${chalk.red(r.error)}\n`);
    } else if (r.output.length > 0) {
      process.stdout.write(`${r.output}\n`);
    } else {
      process.stdout.write(chalk.dim("(no output)\n"));
    }
    process.stdout.write("\n");
  }
}
