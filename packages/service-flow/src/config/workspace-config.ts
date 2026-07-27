import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_DB_FILE,
  DEFAULT_IGNORES,
} from './defaults.js';
import {
  DEFAULT_EVENT_ENVIRONMENT_KEYS,
  EVENT_ENVIRONMENT_KEY_CAP,
  normalizeEventEnvironmentKeys,
  validEventEnvironmentKey,
} from '../parsers/environment-declarations.js';
const environmentKeys = z.array(
  z.string().refine(validEventEnvironmentKey),
).min(1).max(EVENT_ENVIRONMENT_KEY_CAP).transform(
  normalizeEventEnvironmentKeys,
);
const schema = z.object({
  rootPath: z.string(),
  dbPath: z.string(),
  ignore: z.array(z.string()),
  eventEnvironmentKeys: environmentKeys.default(
    [...DEFAULT_EVENT_ENVIRONMENT_KEYS],
  ),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkspaceConfig = z.infer<typeof schema>;
export function configPath(rootPath: string): string {
  return path.join(rootPath, CONFIG_DIR, CONFIG_FILE);
}
export function defaultDbPath(rootPath: string): string {
  return path.join(rootPath, CONFIG_DIR, DEFAULT_DB_FILE);
}
export async function saveWorkspaceConfig(
  config: WorkspaceConfig,
): Promise<void> {
  await fs.mkdir(path.dirname(configPath(config.rootPath)), {
    recursive: true,
  });
  await fs.writeFile(
    configPath(config.rootPath),
    `${JSON.stringify(config, null, 2)}\n`,
  );
  if (path.dirname(config.dbPath) === path.dirname(configPath(config.rootPath)))
    await fs.writeFile(
      path.join(path.dirname(config.dbPath), '.service-flow-state'),
      'service-flow\n',
    );
}
export async function loadWorkspaceConfig(
  workspace?: string,
): Promise<WorkspaceConfig> {
  const root = path.resolve(workspace ?? process.cwd());
  const data = await fs.readFile(configPath(root), 'utf8');
  return schema.parse(JSON.parse(data) as unknown);
}
export function createWorkspaceConfig(
  rootPath: string,
  dbPath?: string,
  ignore: string[] = [...DEFAULT_IGNORES],
): WorkspaceConfig {
  const now = new Date().toISOString();
  const root = path.resolve(rootPath);
  return {
    rootPath: root,
    dbPath: path.resolve(dbPath ?? defaultDbPath(root)),
    ignore,
    eventEnvironmentKeys: [...DEFAULT_EVENT_ENVIRONMENT_KEYS],
    createdAt: now,
    updatedAt: now,
  };
}
