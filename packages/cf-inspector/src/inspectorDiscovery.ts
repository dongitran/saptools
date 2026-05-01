import { request } from "node:http";

import { CfInspectorError } from "./types.js";

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

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const req = request(url, { method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve(JSON.parse(text) as T);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          reject(
            new CfInspectorError(
              "INSPECTOR_DISCOVERY_FAILED",
              `Failed to parse inspector discovery response from ${url}: ${message}`,
            ),
          );
        }
      });
      res.on("error", (err) => {
        reject(
          new CfInspectorError(
            "INSPECTOR_DISCOVERY_FAILED",
            `Inspector discovery response error: ${err.message}`,
          ),
        );
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new CfInspectorError(
          "INSPECTOR_DISCOVERY_FAILED",
          `Inspector discovery at ${url} timed out after ${timeoutMs.toString()}ms`,
        ),
      );
    });
    req.on("error", (err) => {
      reject(
        err instanceof CfInspectorError
          ? err
          : new CfInspectorError(
              "INSPECTOR_DISCOVERY_FAILED",
              `Inspector discovery at ${url} failed: ${err.message}`,
            ),
      );
    });
    req.end();
  });
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
