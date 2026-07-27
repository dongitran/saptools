import { describe, expect, it } from 'vitest';
import type { RepoRow } from '../../src/db/repositories.js';
import {
  projectRepositoryInspection,
} from '../../src/output/repository-inspection.js';

describe('repository inspection privacy', () => {
  it('omits persisted environment declaration values', () => {
    const repository: RepoRow & {
      environment_declarations_json: string;
    } = {
      id: 1,
      name: 'consumer',
      absolute_path: '/workspace/consumer',
      relative_path: 'consumer',
      package_name: '@neutral/consumer',
      package_version: '1.0.0',
      dependencies_json: '{}',
      kind: 'cap-service',
      environment_declarations_json: JSON.stringify({
        declarations: [{ key: 'REGION_CODE', value: 'private-sentinel' }],
      }),
    };
    const projected = projectRepositoryInspection(repository);

    expect(projected).not.toHaveProperty('environment_declarations_json');
    expect(JSON.stringify(projected)).not.toContain('private-sentinel');
  });
});
