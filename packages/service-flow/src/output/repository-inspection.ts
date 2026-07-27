import type { RepoRow } from '../db/repositories.js';

export function projectRepositoryInspection(
  repository: RepoRow,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(repository).filter(
      ([key]) => key !== 'environment_declarations_json',
    ),
  );
}
