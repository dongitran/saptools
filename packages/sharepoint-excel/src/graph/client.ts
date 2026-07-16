import process from "node:process";

import { DEFAULT_GRAPH_BASE, ENV_GRAPH_BASE } from "../types.js";

export type FetchLike = typeof fetch;

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
  readonly env?: NodeJS.ProcessEnv;
}

export interface GraphRequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly rawBody?: Uint8Array | string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly includeAuthorization?: boolean;
}

export interface GraphClient {
  readonly baseUrl: string;
  requestJson: <T>(path: string, options?: GraphRequestOptions) => Promise<T>;
  requestBytes: (path: string, options?: GraphRequestOptions) => Promise<Uint8Array>;
  requestNoContent: (path: string, options?: GraphRequestOptions) => Promise<void>;
}

interface GraphErrorBody {
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
  };
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
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

function resolveBaseUrl(options: GraphClientOptions): string {
  if (options.baseUrl !== undefined && options.baseUrl.length > 0) {
    return options.baseUrl.replace(/(?<!\/)\/+$/, "");
  }
  const fromEnv = (options.env ?? process.env)[ENV_GRAPH_BASE];
  return fromEnv === undefined || fromEnv.length === 0
    ? DEFAULT_GRAPH_BASE
    : fromEnv.replace(/(?<!\/)\/+$/, "");
}

function resolveUrl(base: string, path: string, includeAuthorization: boolean): string {
  if (/^https?:\/\//i.test(path)) {
    if (includeAuthorization && new URL(path).origin !== new URL(base).origin) {
      throw new Error("Refusing to send a Graph bearer token to a different origin");
    }
    return path;
  }
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
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

async function extractErrorDetail(response: Response): Promise<{ code: string | undefined; detail: string }> {
  const text = await response.text().catch(() => "");
  if (text.length === 0) {
    return { code: undefined, detail: response.statusText };
  }
  try {
    const body = JSON.parse(text) as GraphErrorBody;
    const code = typeof body.error?.code === "string" ? body.error.code : undefined;
    const detail =
      typeof body.error?.message === "string" && body.error.message.length > 0
        ? body.error.message
        : response.statusText;
    return { code, detail };
  } catch {
    return { code: undefined, detail: text };
  }
}

function buildInit(accessToken: string, options: GraphRequestOptions): RequestInit {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(options.includeAuthorization === false ? {} : { Authorization: `Bearer ${accessToken}` }),
    ...options.headers,
  };
  const init: RequestInit = { method: options.method ?? "GET", headers };
  if (options.rawBody !== undefined) {
    init.body = rawBodyToBodyInit(options.rawBody);
    return init;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    init.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  }
  return init;
}

type RequestBody = NonNullable<RequestInit["body"]>;

function rawBodyToBodyInit(rawBody: Uint8Array | string): RequestBody {
  if (typeof rawBody === "string") {
    return rawBody;
  }
  const copy = new ArrayBuffer(rawBody.byteLength);
  new Uint8Array(copy).set(rawBody);
  return copy;
}

async function discardBody(response: Response): Promise<void> {
  if (response.body === null) {
    return;
  }
  await response.body.cancel().catch(() => {
    /* ignore */
  });
}

export function createGraphClient(options: GraphClientOptions): GraphClient {
  const baseUrl = resolveBaseUrl(options);
  const fetchFn = options.fetchFn ?? fetch;
  const maxRetries = options.retry?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleepFn = options.retry?.sleepFn ?? defaultSleep;

  async function execute(path: string, requestOptions: GraphRequestOptions): Promise<Response> {
    const includeAuthorization = requestOptions.includeAuthorization !== false;
    const url = resolveUrl(baseUrl, path, includeAuthorization);
    const init = buildInit(options.accessToken, requestOptions);
    let attempt = 0;
    let response = await fetchFn(url, init);
    while (!response.ok && RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries) {
      const retryAfterMs =
        parseRetryAfter(response.headers.get("retry-after")) ?? baseDelayMs * 2 ** attempt;
      await discardBody(response);
      await sleepFn(retryAfterMs);
      attempt += 1;
      response = await fetchFn(url, init);
    }
    if (!response.ok) {
      const { code, detail } = await extractErrorDetail(response);
      throw new GraphHttpError(response.status, code, detail);
    }
    return response;
  }

  async function requestJson<T>(path: string, requestOptions: GraphRequestOptions = {}): Promise<T> {
    const response = await execute(path, requestOptions);
    if (response.status === 204) {
      return undefined as T;
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  async function requestBytes(path: string, requestOptions: GraphRequestOptions = {}): Promise<Uint8Array> {
    const response = await execute(path, requestOptions);
    return new Uint8Array(await response.arrayBuffer());
  }

  async function requestNoContent(path: string, requestOptions: GraphRequestOptions = {}): Promise<void> {
    await execute(path, requestOptions);
  }

  return { baseUrl, requestJson, requestBytes, requestNoContent };
}
