import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  CF_LIVE_TRACE_GLOBAL_NAME,
  CF_LIVE_TRACE_RUNTIME_SOURCE,
  CF_LIVE_TRACE_RUNTIME_VERSION,
  buildDrainExpression,
  buildStopExpression,
} from "../../src/runtime-source.js";

interface RuntimeApi {
  readonly version: number;
  install(options: unknown): Promise<unknown>;
  drainEvents(maxCount: number, maxTransportBodyBytes?: number): { readonly events: readonly RuntimeTraceEvent[] };
  uninstall(): Promise<unknown>;
}

interface RuntimeTraceEvent {
  readonly url: string;
  readonly normalizedUrl: string;
  readonly path: string;
  readonly requestBodyPreview: string;
  readonly responseBodyPreview: string;
  readonly requestBodyTruncated: boolean;
  readonly responseBodyTruncated: boolean;
}

describe("runtime source", () => {
  it("builds versioned Runtime.evaluate expressions without console output", () => {
    expect(CF_LIVE_TRACE_GLOBAL_NAME).toBe("__SAPTOOLS_CF_LIVE_TRACE__");
    expect(CF_LIVE_TRACE_RUNTIME_VERSION).toBeGreaterThan(0);
    expect(CF_LIVE_TRACE_RUNTIME_SOURCE).toContain(CF_LIVE_TRACE_GLOBAL_NAME);
    expect(CF_LIVE_TRACE_RUNTIME_SOURCE).toContain("drainEvents");
    expect(CF_LIVE_TRACE_RUNTIME_SOURCE).toContain("uninstall");
    expect(CF_LIVE_TRACE_RUNTIME_SOURCE).not.toContain("console.log");
    expect(buildDrainExpression(50, 20_000)).toContain(".drainEvents(50, 20000)");
    expect(buildStopExpression({ uninstallRuntimeHook: true })).toContain(".uninstall()");
    expect(buildStopExpression({ uninstallRuntimeHook: false })).toContain(".disable()");
  });

  it("captures request and response previews from patched http server emits", async () => {
    const { runtimeApi, httpModule } = await installRuntimeSource();
    const req = createRuntimeRequest("/odata/v4/orders?$top=5");
    const res = createRuntimeResponse();

    httpModule.Server.prototype.emit("request", req, res);
    req.emit("data", "{\"amount\":1200}");
    res.write("{\"ok\":");
    res.end("true}");
    res.emit("finish");

    const drained = runtimeApi.drainEvents(10);

    expect(drained.events).toHaveLength(1);
    expect(drained.events[0]).toEqual(
      expect.objectContaining({
        url: "/odata/v4/orders?$top=5",
        normalizedUrl: "/odata/v4/orders?$top=5",
        path: "/odata/v4/orders",
        requestBodyPreview: "{\"amount\":1200}",
        responseBodyPreview: "{\"ok\":true}",
      }),
    );
  });

  it("uninstalls stale lower-version hooks before replacing them", async () => {
    const staleUninstall = vi.fn();
    const context = createRuntimeContext();
    context[CF_LIVE_TRACE_GLOBAL_NAME] = {
      version: CF_LIVE_TRACE_RUNTIME_VERSION - 1,
      uninstall: staleUninstall,
    };

    const runtimeApi = await runRuntimeSource(context);

    expect(staleUninstall).toHaveBeenCalledTimes(1);
    expect(runtimeApi.version).toBe(CF_LIVE_TRACE_RUNTIME_VERSION);
    expect(context[CF_LIVE_TRACE_GLOBAL_NAME]).toBe(runtimeApi);
  });

  it("truncates unlimited body previews for inspector transport drains", async () => {
    const { runtimeApi, httpModule } = await installRuntimeSource({ maxBodyBytes: 0 });
    const req = createRuntimeRequest("/large");
    const res = createRuntimeResponse();

    httpModule.Server.prototype.emit("request", req, res);
    req.emit("data", "request-body-preview");
    res.end("response-body-preview");
    res.emit("finish");

    const drained = runtimeApi.drainEvents(10, 8);

    expect(drained.events[0]).toEqual(
      expect.objectContaining({
        requestBodyPreview: "request-",
        responseBodyPreview: "response",
        requestBodyTruncated: true,
        responseBodyTruncated: true,
      }),
    );
  });

  it("restores patched server emits when uninstalling without require", async () => {
    const httpModule = createRuntimeHttpModule();
    const httpsModule = createRuntimeHttpModule();
    const originalHttpEmit = httpModule.Server.prototype.emit;
    const originalHttpsEmit = httpsModule.Server.prototype.emit;
    const runtimeApi = await runRuntimeSource(createRuntimeContextWithBuiltinModules({ httpModule, httpsModule }));

    await runtimeApi.install({
      appId: "orders-api",
      instance: "0",
      captureHeaders: true,
      captureRequestBody: true,
      captureResponseBody: true,
      maxBodyBytes: 4096,
      maxEvents: 1000,
    });

    expect(httpModule.Server.prototype.emit).not.toBe(originalHttpEmit);
    expect(httpsModule.Server.prototype.emit).not.toBe(originalHttpsEmit);

    await runtimeApi.uninstall();

    expect(httpModule.Server.prototype.emit).toBe(originalHttpEmit);
    expect(httpsModule.Server.prototype.emit).toBe(originalHttpsEmit);
  });
});

interface RuntimeModule {
  readonly Server: {
    readonly prototype: {
      readonly emit: (eventName: string, ...args: unknown[]) => boolean;
    };
  };
}

async function installRuntimeSource(options: { readonly maxBodyBytes?: number } = {}): Promise<{
  readonly runtimeApi: RuntimeApi;
  readonly httpModule: RuntimeModule;
}> {
  const httpModule = createRuntimeHttpModule();
  const httpsModule = createRuntimeHttpModule();
  const runtimeApi = await runRuntimeSource(createRuntimeContext({ httpModule, httpsModule }));
  await runtimeApi.install({
    appId: "orders-api",
    instance: "0",
    captureHeaders: true,
    captureRequestBody: true,
    captureResponseBody: true,
    maxBodyBytes: options.maxBodyBytes ?? 4096,
    maxEvents: 1000,
  });
  return { runtimeApi, httpModule };
}

async function runRuntimeSource(context: Record<string, unknown>): Promise<RuntimeApi> {
  const runtimeApi = await runInNewContext(CF_LIVE_TRACE_RUNTIME_SOURCE, context);
  if (!isRuntimeApi(runtimeApi)) {
    throw new Error("Runtime source did not return a trace API.");
  }
  return runtimeApi;
}

function createRuntimeContext(modules?: {
  readonly httpModule: RuntimeModule;
  readonly httpsModule: RuntimeModule;
}): Record<string, unknown> {
  return {
    Buffer,
    WeakSet,
    require: (moduleName: string): unknown => {
      if (moduleName === "http") {
        return modules?.httpModule ?? createRuntimeHttpModule();
      }
      if (moduleName === "https") {
        return modules?.httpsModule ?? createRuntimeHttpModule();
      }
      throw new Error(`Unexpected module: ${moduleName}`);
    },
  };
}

function createRuntimeContextWithBuiltinModules(modules: {
  readonly httpModule: RuntimeModule;
  readonly httpsModule: RuntimeModule;
}): Record<string, unknown> {
  return {
    Buffer,
    WeakSet,
    process: {
      getBuiltinModule(moduleName: string): unknown {
        if (moduleName === "http") {
          return modules.httpModule;
        }
        if (moduleName === "https") {
          return modules.httpsModule;
        }
        throw new Error(`Unexpected module: ${moduleName}`);
      },
    },
  };
}

function createRuntimeHttpModule(): RuntimeModule {
  return {
    Server: {
      prototype: {
        emit: () => true,
      },
    },
  };
}

function createRuntimeRequest(url: string): EventEmitter & {
  url: string;
  method: string;
  headers: Record<string, string>;
} {
  return Object.assign(new EventEmitter(), {
    url,
    method: "POST",
    headers: {
      host: "app.example.com",
      authorization: "Bearer raw-token",
    },
  });
}

function createRuntimeResponse(): EventEmitter & {
  statusCode: number;
  write(chunk: string): boolean;
  end(chunk?: string): boolean;
  getHeaders(): Record<string, string>;
} {
  return Object.assign(new EventEmitter(), {
    statusCode: 201,
    write() {
      return true;
    },
    end() {
      return true;
    },
    getHeaders() {
      return {
        "content-type": "application/json",
      };
    },
  });
}

function isRuntimeApi(value: unknown): value is RuntimeApi {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<RuntimeApi>;
  return typeof candidate.version === "number" && typeof candidate.install === "function";
}
