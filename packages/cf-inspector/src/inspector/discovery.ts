import { request } from "node:http";
import { performance } from "node:perf_hooks";

import { CfInspectorError } from "../types.js";

export interface InspectorTarget {
  readonly description: string;
  readonly devtoolsFrontendUrl?: string;
  readonly faviconUrl?: string;
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

export interface InspectorVersion {
  readonly browser: string;
  readonly protocolVersion: string;
}

export interface InspectorKeepaliveOptions {
  readonly intervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly failureThreshold?: number;
  readonly probe?: () => Promise<unknown>;
}

export interface InspectorKeepalive {
  readonly failure: Promise<never>;
  cancel(): void;
}

interface NodeSystemError extends Error {
  readonly code?: string;
  readonly syscall?: string;
  readonly address?: string;
  readonly port?: number;
}

class InvalidDiscoveryPayloadError extends CfInspectorError {}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let lastError: unknown;

  while (performance.now() < deadline) {
    try {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) {
        break;
      }
      return await new Promise<T>((resolve, reject) => {
        const req = request(url, { method: "GET" }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });
          res.on("end", () => {
            try {
              resolve(parseJsonResponse(chunks) as T);
            } catch (err: unknown) {
              reject(parseDiscoveryError(url, err));
            }
          });
          res.on("error", (err) => {
            reject(newDiscoveryError(`Inspector discovery response error: ${err.message}`));
          });
        });
        const attemptTimeoutMs = Math.min(2000, remainingMs);
        req.setTimeout(attemptTimeoutMs, () => {
          req.destroy(
            new CfInspectorError(
              "INSPECTOR_DISCOVERY_FAILED",
              `Inspector discovery at ${url} timed out after ${timeoutMs.toString()}ms`,
            ),
          );
        });
        req.on("error", (err) => {
          reject(err instanceof CfInspectorError ? err : formatDiscoveryRequestError(url, err));
        });
        req.end();
      });
    } catch (err: unknown) {
      if (err instanceof InvalidDiscoveryPayloadError) {
        throw err;
      }
      lastError = err;
      const now = performance.now();
      if (now < deadline) {
        const sleepMs = Math.min(1000, deadline - now);
        await new Promise((r) => setTimeout(r, sleepMs));
      }
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new CfInspectorError("INSPECTOR_DISCOVERY_FAILED", `Inspector discovery at ${url} timed out after ${timeoutMs.toString()}ms`);
}

function isNodeSystemError(err: unknown): err is NodeSystemError {
  return err instanceof Error;
}

function isConnectionRefusedOrUnreachable(code: string | undefined): boolean {
  return code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH";
}

function formatEndpoint(url: string, err: NodeSystemError): string {
  if (typeof err.address === "string" && typeof err.port === "number") {
    return `${err.address}:${err.port.toString()}`;
  }
  const parsed = new URL(url);
  return parsed.host;
}

function formatDiscoveryRequestError(url: string, err: unknown): CfInspectorError {
  const detail = err instanceof Error ? err.message : String(err);
  if (!isNodeSystemError(err) || !isConnectionRefusedOrUnreachable(err.code)) {
    return new CfInspectorError(
      "INSPECTOR_DISCOVERY_FAILED",
      `Inspector discovery at ${url} failed: ${detail}`,
    );
  }
  const endpoint = formatEndpoint(url, err);
  return new CfInspectorError(
    "INSPECTOR_DISCOVERY_FAILED",
    `Cannot reach Node inspector discovery at ${url}. Nothing is listening on ${endpoint}, or the inspector tunnel is stale/closed. Restart the local inspector or tunnel and retry. If this port came from cf-debugger, stop the stale session and start a fresh tunnel, or run cf-inspector with --app/--region/--org/--space so it can open a tunnel.`,
    detail,
  );
}

function parseJsonResponse(chunks: readonly Buffer[]): unknown {
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text) as unknown;
}

function parseDiscoveryError(url: string, err: unknown): CfInspectorError {
  const message = err instanceof Error ? err.message : String(err);
  return new InvalidDiscoveryPayloadError(
    "INSPECTOR_DISCOVERY_FAILED",
    `Failed to parse inspector discovery response from ${url}: ${message}`,
  );
}

function newDiscoveryError(message: string): CfInspectorError {
  return new CfInspectorError("INSPECTOR_DISCOVERY_FAILED", message);
}

function toInspectorTarget(value: unknown, source: string): InspectorTarget {
  if (typeof value !== "object" || value === null) {
    throw new CfInspectorError(
      "INSPECTOR_DISCOVERY_FAILED",
      `Inspector target is not an object in ${source}`,
    );
  }
  const candidate = value as Record<string, unknown>;
  const webSocketDebuggerUrl = candidate["webSocketDebuggerUrl"];
  if (typeof webSocketDebuggerUrl !== "string" || webSocketDebuggerUrl.length === 0) {
    throw new CfInspectorError(
      "INSPECTOR_DISCOVERY_FAILED",
      `Inspector target is missing webSocketDebuggerUrl in ${source}`,
    );
  }
  return {
    description: typeof candidate["description"] === "string" ? candidate["description"] : "",
    id: typeof candidate["id"] === "string" ? candidate["id"] : "",
    title: typeof candidate["title"] === "string" ? candidate["title"] : "",
    type: typeof candidate["type"] === "string" ? candidate["type"] : "",
    url: typeof candidate["url"] === "string" ? candidate["url"] : "",
    webSocketDebuggerUrl,
    ...(typeof candidate["devtoolsFrontendUrl"] === "string"
      ? { devtoolsFrontendUrl: candidate["devtoolsFrontendUrl"] }
      : {}),
    ...(typeof candidate["faviconUrl"] === "string" ? { faviconUrl: candidate["faviconUrl"] } : {}),
  };
}

export async function discoverInspectorTargets(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<readonly InspectorTarget[]> {
  const url = `http://${host}:${port.toString()}/json/list`;
  const raw = await fetchJson<unknown>(url, timeoutMs);
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CfInspectorError(
      "INSPECTOR_DISCOVERY_FAILED",
      `No inspector targets returned from ${url}`,
    );
  }
  return raw.map((entry, idx): InspectorTarget => toInspectorTarget(entry, `${url}[${idx.toString()}]`));
}

function readVersionField(value: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === "string" && entry.length > 0) {
      return entry;
    }
  }
  return undefined;
}

export async function fetchInspectorVersion(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<InspectorVersion> {
  const url = `http://${host}:${port.toString()}/json/version`;
  const raw = await fetchJson<unknown>(url, timeoutMs);
  if (typeof raw !== "object" || raw === null) {
    throw new CfInspectorError(
      "INSPECTOR_DISCOVERY_FAILED",
      `Unexpected /json/version response from ${url}`,
    );
  }
  const value = raw as Record<string, unknown>;
  const browser = readVersionField(value, "Browser", "browser");
  const protocolVersion = readVersionField(value, "Protocol-Version", "protocolVersion");
  if (browser === undefined || protocolVersion === undefined) {
    throw new CfInspectorError(
      "INSPECTOR_DISCOVERY_FAILED",
      `Unexpected /json/version response from ${url}`,
    );
  }
  return { browser, protocolVersion };
}

export function startInspectorKeepalive(
  host: string,
  port: number,
  options: InspectorKeepaliveOptions = {},
): InspectorKeepalive {
  const intervalMs = options.intervalMs ?? 10_000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 2_000;
  const failureThreshold = options.failureThreshold ?? 3;
  const probe = options.probe ?? (async (): Promise<unknown> =>
    await fetchInspectorVersion(host, port, probeTimeoutMs));
  let cancelled = false;
  let consecutiveFailures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectFailure: ((error: Error) => void) | undefined;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  const schedule = (): void => {
    if (cancelled) {
      return;
    }
    timer = setTimeout(() => {
      void runProbe();
    }, intervalMs);
  };
  const runProbe = async (): Promise<void> => {
    try {
      await probe();
      consecutiveFailures = 0;
    } catch (error: unknown) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= failureThreshold) {
        cancelled = true;
        const detail = error instanceof Error ? error.message : String(error);
        rejectFailure?.(new CfInspectorError(
          "INSPECTOR_CONNECTION_FAILED",
          `Inspector tunnel ${host}:${port.toString()} failed ${failureThreshold.toString()} consecutive keepalive probes and is no longer round-tripping. Retry the command after restarting or investigating the owning tunnel session.`,
          detail,
        ));
        return;
      }
    }
    schedule();
  };
  schedule();
  return {
    failure,
    cancel: (): void => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  };
}
