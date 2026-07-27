import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  configPath,
  createWorkspaceConfig,
  loadWorkspaceConfig,
} from '../../src/config/workspace-config.js';

async function writeConfig(
  root: string,
  value: Record<string, unknown>,
): Promise<void> {
  const target = configPath(root);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value));
}

describe('workspace event environment configuration', () => {
  it('defaults legacy configs and accepts sorted configured keys', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-env-config-'));
    const base = createWorkspaceConfig(root);
    const legacy = {
      rootPath: base.rootPath,
      dbPath: base.dbPath,
      ignore: base.ignore,
      createdAt: base.createdAt,
      updatedAt: base.updatedAt,
    };
    await writeConfig(root, legacy);
    expect((await loadWorkspaceConfig(root)).eventEnvironmentKeys)
      .toEqual(['SHARD_CODE']);

    await writeConfig(root, {
      ...base,
      eventEnvironmentKeys: ['TENANT_CODE', 'REGION_CODE', 'TENANT_CODE'],
    });
    expect((await loadWorkspaceConfig(root)).eventEnvironmentKeys)
      .toEqual(['REGION_CODE', 'TENANT_CODE']);
  });

  it('rejects unsafe or empty configured key lists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-env-config-'));
    const base = createWorkspaceConfig(root);
    await writeConfig(root, {
      ...base,
      eventEnvironmentKeys: ['SAFE_KEY', 'unsafe-key'],
    });
    await expect(loadWorkspaceConfig(root)).rejects.toThrow();

    await writeConfig(root, { ...base, eventEnvironmentKeys: [] });
    await expect(loadWorkspaceConfig(root)).rejects.toThrow();
  });
});
