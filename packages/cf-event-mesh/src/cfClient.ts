import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { EventMeshBinding } from './eventMeshBindings.js';
import { extractEventMeshBindings } from './eventMeshBindings.js';

const execFileAsync = promisify(execFile);

export async function getAppGuid(appName: string): Promise<string> {
  try {
    const execResult = await execFileAsync('cf', ['app', appName, '--guid']);
    // Handle both promisified {stdout} object and raw string fallback for vitest mocks
    const stdout = typeof execResult === 'string' ? execResult : (execResult as { stdout: string }).stdout;
    const guid = stdout.trim();
    if (!guid) {
      throw new Error(`Could not find GUID for app ${appName}`);
    }
    return guid;
  } catch (error) {
    throw new Error(`Failed to get app GUID: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export async function getAppEnv(guid: string): Promise<unknown> {
  try {
    const execResult = await execFileAsync('cf', ['curl', `/v3/apps/${guid}/env`]);
    const stdout = typeof execResult === 'string' ? execResult : (execResult as { stdout: string }).stdout;
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(`Failed to fetch app env: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export async function getEventMeshBindingsForApp(appName: string): Promise<EventMeshBinding[]> {
  const guid = await getAppGuid(appName);
  const env = await getAppEnv(guid);
  
  if (typeof env !== 'object' || env === null) {
    throw new Error('Invalid env response');
  }
  
  const systemEnv = (env as Record<string, unknown>)['system_env_json'];
  if (typeof systemEnv !== 'object' || systemEnv === null) {
    return [];
  }
  
  return extractEventMeshBindings(systemEnv);
}
