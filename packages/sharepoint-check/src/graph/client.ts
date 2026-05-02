import process from "node:process";

import { DEFAULT_GRAPH_BASE, ENV_GRAPH_BASE } from "../types.js";

export type FetchLike = typeof fetch;

export interface GraphRequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly expectJson?: boolean;
}

export interface GraphRetryOptions {
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly sleepFn?: (ms: number) => Promise<void>;
}

export interface GraphClientOptions {
  readonly accessToken: string;
  readonly baseUrl?: string;
  readonly fetchFn?: FetchLike;
  readonly retry?: GraphRetryOptions;
}

const RETRYABLE_STATUSES = new Set<number>([429, 503]);
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null || header.length === 0) {
    return undefined;
  }
  const seconds = Number.parseFloat(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

export class GraphHttpError extends Error {
  public readonly status: number;
  public readonly code: string | undefined;
  public readonly detail: string;

  public constructor(status: number, code: string | undefined, detail: string) {
    super(
      `Microsoft Graph request failed (${status.toString()}${
        code === undefined ? "" : ` ${code}`
      }): ${detail}`,
    );
    this.name = "GraphHttpError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export interface GraphClient {
  request: <T>(path: string, options?: GraphRequestOptions) => Promise<T>;
  readonly baseUrl: string;
}

interface GraphErrorBody {
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
  };
}

function resolveBaseUrl(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) {
    return explicit.replace(/\/+$/, "");
  }

  const fromEnv = process.env[ENV_GRAPH_BASE];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv.replace(/\/+$/, "");
  }

  return DEFAULT_GRAPH_BASE;
}

function resolveUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

async function extractErrorDetail(response: Response): Promise<{ code: string | undefined; detail: string }> {
  const text = await response.text().catch(() => "");
  if (text.length === 0) {
    return { code: undefined, detail: response.statusText };
  }

  try {
    const body = JSON.parse(text) as GraphErrorBody;
    const code = typeof body.error?.code === "string" ? body.error.code : undefined;
    const message =
      typeof body.error?.message === "string" && body.error.message.length > 0
        ? body.error.message
        : response.statusText;
    return { code, detail: message };
  } catch {
    return { code: undefined, detail: text };
  }
}

export function createGraphClient(options: GraphClientOptions): GraphClient {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const fetchFn = options.fetchFn ?? fetch;
  const maxRetries = options.retry?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleepFn = options.retry?.sleepFn ?? defaultSleep;

  async function request<T>(path: string, requestOptions: GraphRequestOptions = {}): Promise<T> {
    const url = resolveUrl(baseUrl, path);
    const method = requestOptions.method ?? "GET";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.accessToken}`,
      Accept: "application/json",
      ...requestOptions.headers,
    };

    const init: RequestInit = { method, headers };
    if (requestOptions.body !== undefined) {
      headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
      init.body =
        typeof requestOptions.body === "string"
          ? requestOptions.body
          : JSON.stringify(requestOptions.body);
    }

    let attempt = 0;
    let response = await fetchFn(url, init);
    while (
      !response.ok &&
      RETRYABLE_STATUSES.has(response.status) &&
      attempt < maxRetries
    ) {
      const retryAfterMs =
        parseRetryAfter(response.headers.get("retry-after")) ?? baseDelayMs * 2 ** attempt;
      if (response.body !== null) {
        await response.body.cancel().catch(() => {
          /* ignore */
        });
      }
      await sleepFn(retryAfterMs);
      attempt += 1;
      response = await fetchFn(url, init);
    }

    if (!response.ok) {
      const { code, detail } = await extractErrorDetail(response);
      throw new GraphHttpError(response.status, code, detail);
    }

    if (requestOptions.expectJson === false || response.status === 204) {
      return undefined as T;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  return { request, baseUrl };
}
