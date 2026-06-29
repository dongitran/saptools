import { Buffer } from 'node:buffer';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const SYSTEM_PROVIDED_MARKER = 'System-Provided:';
const VCAP_SERVICES_MARKER = 'VCAP_SERVICES:';

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
  const command = [
    'find / -maxdepth 7',
    "\\( -path '*/node_modules' -o -path /proc -o -path /sys -o -path /dev \\) -prune",
    "-o -type f -name '*.cds' -exec cat {} + 2>/dev/null",
  ].join(' ');

  try {
    const stdout = await runCfCommand(['ssh', params.appName, '--disable-pseudo-tty', '-c', command], {
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
  const services = extractVcapServices(output);
  if (services === undefined || !Array.isArray(services['xsuaa'])) { return undefined; }
  for (const binding of services['xsuaa']) {
    const credentials = parseXsuaaBindingCredentials(binding);
    if (credentials !== undefined) { return credentials; }
  }
  return undefined;
}

function parseXsuaaBindingCredentials(binding: unknown): XsuaaCredentials | undefined {
  if (!isRecord(binding) || !isRecord(binding['credentials'])) { return undefined; }
  const credentials = binding['credentials'];
  const clientId = credentials['clientid'];
  const clientSecret = credentials['clientsecret'];
  const url = credentials['url'];
  const normalizedClientId = readNonEmptyString(clientId);
  const normalizedClientSecret = readNonEmptyString(clientSecret);
  const normalizedUrl = readNonEmptyString(url);
  if (
    normalizedClientId === undefined
    || normalizedClientSecret === undefined
    || normalizedUrl === undefined
  ) {
    return undefined;
  }
  return {
    clientId: normalizedClientId,
    clientSecret: normalizedClientSecret,
    url: normalizedUrl,
  };
}

function extractVcapServices(output: string): Record<string, unknown> | undefined {
  const systemProvided = extractSystemProvidedJson(output);
  const structuredServices = systemProvided?.['VCAP_SERVICES'];
  if (isRecord(structuredServices)) { return structuredServices; }
  return extractNamedJsonObject(output, VCAP_SERVICES_MARKER);
}

function extractSystemProvidedJson(output: string): Record<string, unknown> | undefined {
  const markerIdx = output.indexOf(SYSTEM_PROVIDED_MARKER);
  if (markerIdx === -1) { return undefined; }
  const afterMarker = output.slice(markerIdx + SYSTEM_PROVIDED_MARKER.length).trimStart();
  if (!afterMarker.startsWith('{')) { return undefined; }
  const closeIdx = findJsonObjectEnd(afterMarker, 0);
  if (closeIdx === -1) { return undefined; }
  return parseJsonObject(afterMarker.slice(0, closeIdx + 1));
}

function extractNamedJsonObject(output: string, marker: string): Record<string, unknown> | undefined {
  const markerIdx = output.indexOf(marker);
  if (markerIdx === -1) { return undefined; }
  const afterMarker = output.slice(markerIdx + marker.length);
  const openIdx = afterMarker.indexOf('{');
  if (openIdx === -1) { return undefined; }
  const closeIdx = findJsonObjectEnd(afterMarker, openIdx);
  if (closeIdx === -1) { return undefined; }
  return parseJsonObject(afterMarker.slice(openIdx, closeIdx + 1));
}

function findJsonObjectEnd(source: string, startIdx: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let idx = startIdx;
  while (idx < source.length) {
    const char = source[idx];
    idx++;
    if (char === undefined) { continue; }
    if (escaped) { escaped = false; continue; }
    if (inString && char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) { continue; }
    if (char === '{') { depth++; continue; }
    if (char === '}') {
      depth--;
      if (depth === 0) { return idx - 1; }
    }
  }
  return -1;
}

function parseJsonObject(rawJson: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') { return undefined; }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
