import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_DB_FILE,
  DEFAULT_IGNORES
} from './defaults.js';
const schema = z.object({
  rootPath: z.string(),
  dbPath: z.string(),
  ignore: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type WorkspaceConfig = z.infer<typeof schema>;
export function configPath(rootPath: string): string {
  return path.join(rootPath, CONFIG_DIR, CONFIG_FILE);
}
export function defaultDbPath(rootPath: string): string {
  return path.join(rootPath, CONFIG_DIR, DEFAULT_DB_FILE);
}
export async function saveWorkspaceConfig(
  config: WorkspaceConfig
): Promise<void> {
  await fs.mkdir(path.dirname(configPath(config.rootPath)), {
    recursive: true
  });
  await fs.writeFile(
    configPath(config.rootPath),
    `${JSON.stringify(config, null, 2)}\n`
  );
}
export async function loadWorkspaceConfig(
  workspace?: string
): Promise<WorkspaceConfig> {
  const root = path.resolve(workspace ?? process.cwd());
  const data = await fs.readFile(configPath(root), 'utf8');
  return schema.parse(JSON.parse(data) as unknown);
}
export function createWorkspaceConfig(
  rootPath: string,
  dbPath?: string,
  ignore: string[] = [...DEFAULT_IGNORES]
): WorkspaceConfig {
  const now = new Date().toISOString();
  const root = path.resolve(rootPath);
  return {
    rootPath: root,
    dbPath: path.resolve(dbPath ?? defaultDbPath(root)),
    ignore,
    createdAt: now,
    updatedAt: now
  };
}
