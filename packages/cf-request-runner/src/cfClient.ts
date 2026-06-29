import { Buffer } from 'node:buffer';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

export interface CfCommandOptions {
  readonly cfHomeDir?: string | undefined;
  readonly failureMessage?: string | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

export async function runCfCommand(
  args: readonly string[],
  options: CfCommandOptions = {}
): Promise<string> {
  const env = options.cfHomeDir
    ? { ...process.env, CF_HOME: options.cfHomeDir }
    : process.env;
  const child = spawn('cf', [...args], { env, shell: false });
  return await collectCommandOutput(child, options);
}

function collectCommandOutput(
  child: ChildProcessWithoutNullStreams,
  options: CfCommandOptions,
): Promise<string> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;

    const finish = (error?: Error, output?: string): void => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      if (error === undefined) { resolve(output ?? ''); }
      else { reject(error); }
    };

    const append = (target: 'stdout' | 'stderr', data: Buffer): void => {
      outputBytes += data.byteLength;
      if (outputBytes > maxOutputBytes) {
        child.kill('SIGTERM');
        finish(new Error(`CF command output exceeded ${String(maxOutputBytes)} bytes`));
      } else if (target === 'stdout') { stdout += data.toString(); }
      else { stderr += data.toString(); }
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`CF command timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    timer.unref();

    child.stdout.on('data', (data: Buffer) => { append('stdout', data); });
    child.stderr.on('data', (data: Buffer) => { append('stderr', data); });

    child.on('error', (err) => {
      finish(new Error(`Failed to execute CF command: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) { finish(undefined, stdout); }
      else {
        finish(new Error(`${options.failureMessage ?? `CF command failed with code ${String(code)}`}\nStderr: ${stderr}`));
      }
    });
  });
}

export async function fetchRemoteCdsServicesFromTarget(params: {
  readonly appName: string;
  readonly cfHomeDir?: string | undefined;
}): Promise<string | null> {
  const command = `find / -maxdepth 7 \\( -path '*/node_modules' -o -path /proc -o -path /sys -o -path /dev \\) -prune -o -type f -name '*.cds' -print 2>/dev/null | xargs cat`;

  try {
    const stdout = await runCfCommand(['ssh', params.appName, '-c', `"${command}"`], {
      cfHomeDir: params.cfHomeDir,
      failureMessage: `Failed to fetch remote .cds files for app "${params.appName}".`,
    });
    if (stdout.trim().length > 0) {
      return stdout;
    }
  } catch {
    // Ignore if not found or SSH fails
  }

  return null;
}

export async function fetchXsuaaTokenFromTarget(params: {
  readonly appName: string;
  readonly cfHomeDir?: string | undefined;
}): Promise<string | null> {
  try {
    const envStdout = await runCfCommand(['env', params.appName], {
      cfHomeDir: params.cfHomeDir,
      failureMessage: `Failed to fetch env for app ${params.appName}`,
    });
    const credentials = parseXsuaaCredentials(envStdout);
    if (credentials === undefined) { return null; }
    const basicAuth = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64');
    const tokenUrl = `${credentials.url.replace(/\/+$/, '')}/oauth/token?grant_type=client_credentials`;
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) { return null; }
    const data: unknown = await res.json();
    if (!isRecord(data) || typeof data['access_token'] !== 'string') { return null; }
    return data['access_token'];
  } catch {
    return null;
  }
}

interface XsuaaCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly url: string;
}

function parseXsuaaCredentials(output: string): XsuaaCredentials | undefined {
  const systemProvided = /System-Provided:\n([\s\S]*?)\n\n/.exec(output)?.[1];
  if (systemProvided === undefined || systemProvided === '') { return undefined; }
  const start = systemProvided.indexOf('VCAP_SERVICES:');
  const objectStart = systemProvided.indexOf('{', start);
  if (start === -1 || objectStart === -1) { return undefined; }
  const nextKey = /\n[A-Z_]+:\s*\{/.exec(systemProvided.slice(objectStart));
  const objectEnd = nextKey === null ? systemProvided.length : objectStart + nextKey.index;
  const parsed: unknown = JSON.parse(systemProvided.slice(objectStart, objectEnd).trim());
  if (!isRecord(parsed) || !Array.isArray(parsed['xsuaa'])) { return undefined; }
  const firstBinding: unknown = parsed['xsuaa'][0];
  if (!isRecord(firstBinding) || !isRecord(firstBinding['credentials'])) { return undefined; }
  const credentials = firstBinding['credentials'];
  const clientId = credentials['clientid'];
  const clientSecret = credentials['clientsecret'];
  const url = credentials['url'];
  if (!isNonEmptyString(clientId) || !isNonEmptyString(clientSecret) || !isNonEmptyString(url)) {
    return undefined;
  }
  return { clientId, clientSecret, url };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}
