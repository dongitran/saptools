import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const SAPTOOLS_DIR_NAME = ".saptools";
export const GITPORT_DIR_NAME = "gitport";
export const RUNS_DIR_NAME = "runs";
export const LATEST_RUN_FILENAME = "latest-run.json";
export const METADATA_FILENAME = "metadata.json";
export const REPORT_JSON_FILENAME = "report.json";
export const REPORT_MD_FILENAME = "report.md";

export interface RunPaths {
  readonly workRoot: string;
  readonly runsDir: string;
  readonly runDir: string;
  readonly destDir: string;
  readonly metadataPath: string;
  readonly reportJsonPath: string;
  readonly reportMarkdownPath: string;
  readonly latestRunPath: string;
}

export function createRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

export function gitportWorkRoot(explicitWorkRoot?: string): string {
  return explicitWorkRoot ?? join(homedir(), SAPTOOLS_DIR_NAME, GITPORT_DIR_NAME);
}

export function latestRunPath(workRoot?: string): string {
  return join(gitportWorkRoot(workRoot), LATEST_RUN_FILENAME);
}

export function runPaths(runId: string, workRoot?: string): RunPaths {
  const root = gitportWorkRoot(workRoot);
  const runsDir = join(root, RUNS_DIR_NAME);
  const runDir = join(runsDir, runId);
  return {
    workRoot: root,
    runsDir,
    runDir,
    destDir: join(runDir, "dest"),
    metadataPath: join(runDir, METADATA_FILENAME),
    reportJsonPath: join(runDir, REPORT_JSON_FILENAME),
    reportMarkdownPath: join(runDir, REPORT_MD_FILENAME),
    latestRunPath: latestRunPath(root),
  };
}
