import type {
  IndexWorkspaceSummary,
} from '../indexer/workspace-indexer.js';

export interface IndexCommandOutcome {
  stdout: string;
  exitCode: 0 | 1;
}

export function indexCommandOutcome(
  summary: IndexWorkspaceSummary,
): IndexCommandOutcome {
  const failed = summary.failedCount > 0
    ? `, failed ${summary.failedCount} (${
      summary.failedRepos.map(({ name, code }) => `${name}: ${code}`).join(', ')
    })`
    : '';
  return {
    stdout: `Indexed ${summary.indexedCount} repositories, skipped ${summary.skippedCount}${failed}, ${summary.fileCount} files, ${summary.diagnosticCount} diagnostics\n`,
    exitCode: summary.failedCount > 0 ? 1 : 0,
  };
}
