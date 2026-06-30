export const CF_LIVE_TRACE_GLOBAL_NAME = "__SAPTOOLS_CF_LIVE_TRACE__";
export const CF_LIVE_TRACE_RUNTIME_VERSION = 3;

export interface RuntimeInstallOptions {
  readonly appId: string;
  readonly instance: string;
  readonly captureHeaders: boolean;
  readonly captureRequestBody: boolean;
  readonly captureResponseBody: boolean;
  readonly maxBodyBytes: number;
  readonly maxEvents: number;
}

export interface StopExpressionOptions {
  readonly uninstallRuntimeHook: boolean;
}

export const CF_LIVE_TRACE_RUNTIME_SOURCE = `
(() => {
  const name = '${CF_LIVE_TRACE_GLOBAL_NAME}';
  const runtimeVersion = ${String(CF_LIVE_TRACE_RUNTIME_VERSION)};
  const existing = globalThis[name];
  if (existing && typeof existing.version === 'number' && existing.version >= runtimeVersion) return existing;
  let staleCleanup = null;
  if (existing && typeof existing.uninstall === 'function') {
    try {
      const cleanup = existing.uninstall();
      if (cleanup && typeof cleanup.then === 'function') {
        staleCleanup = Promise.resolve(cleanup).catch(() => undefined);
      }
    } catch {}
  }
  let BufferCtor = globalThis.Buffer;
  const state = {
    version: runtimeVersion,
    installed: false,
    enabled: false,
    options: { appId: '', instance: '0', captureHeaders: true, captureRequestBody: true, captureResponseBody: true, maxBodyBytes: 4096, maxEvents: 1000 },
    queue: [],
    droppedCount: 0,
    originals: {},
    seen: new WeakSet(),
    nextId: 1,
    nextDrainId: 1,
    pendingDrain: null
  };
  const loadRequire = () => {
    if (typeof require === 'function') return require;
    if (globalThis.process && globalThis.process.mainModule && typeof globalThis.process.mainModule.require === 'function') {
      return globalThis.process.mainModule.require.bind(globalThis.process.mainModule);
    }
    return null;
  };
  const loadModule = async (moduleName) => {
    const requireFn = loadRequire();
    if (requireFn) return requireFn(moduleName);
    if (globalThis.process && typeof globalThis.process.getBuiltinModule === 'function') {
      return globalThis.process.getBuiltinModule(moduleName);
    }
    return await import('node:' + moduleName);
  };
  const toHeaderRecord = (headers) => {
    const output = {};
    if (!headers || !state.options.captureHeaders) return output;
    for (const key of Object.keys(headers)) {
      const value = headers[key];
      output[key] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return output;
  };
  const chunkText = (chunk) => {
    if (chunk === undefined || chunk === null) return '';
    if (BufferCtor && BufferCtor.isBuffer(chunk)) return chunk.toString('utf8');
    if (typeof chunk === 'string') return chunk;
    if (chunk instanceof Uint8Array && BufferCtor) return BufferCtor.from(chunk).toString('utf8');
    return '';
  };
  const chunkBuffer = (chunk) => {
    if (!BufferCtor || chunk === undefined || chunk === null) return null;
    if (BufferCtor.isBuffer(chunk)) return chunk;
    if (typeof chunk === 'string' || chunk instanceof Uint8Array) return BufferCtor.from(chunk);
    return null;
  };
  const textByteLength = (text) => BufferCtor ? BufferCtor.byteLength(text) : text.length;
  const chunkByteLength = (chunk) => {
    if (chunk === undefined || chunk === null) return 0;
    if (BufferCtor && BufferCtor.isBuffer(chunk)) return chunk.length;
    if (chunk instanceof Uint8Array) return chunk.byteLength;
    return textByteLength(typeof chunk === 'string' ? chunk : '');
  };
  const truncateTextToBytes = (text, maxBytes) => {
    if (!BufferCtor) return text.slice(0, maxBytes);
    const encoded = BufferCtor.from(text);
    if (encoded.length <= maxBytes) return text;
    let boundary = Math.min(maxBytes, encoded.length);
    while (boundary > 0 && encoded[boundary] !== undefined && (encoded[boundary] & 0xc0) === 0x80) {
      boundary -= 1;
    }
    return encoded.subarray(0, boundary).toString('utf8');
  };
  const appendPreview = (chunks, currentBytes, chunk, enabled) => {
    if (!enabled) return currentBytes;
    const maxBytes = Math.floor(Number(state.options.maxBodyBytes) || 0);
    if (maxBytes <= 0) return currentBytes;
    const remaining = maxBytes - currentBytes;
    if (remaining <= 0) return currentBytes;
    const buffer = chunkBuffer(chunk);
    if (buffer) {
      const addition = buffer.subarray(0, remaining);
      chunks.push(addition);
      return currentBytes + addition.length;
    }
    const text = chunkText(chunk);
    const addition = truncateTextToBytes(text, remaining);
    chunks.push(addition);
    return currentBytes + textByteLength(addition);
  };
  const completeUtf8Length = (buffer) => {
    if (!buffer || buffer.length === 0) return 0;
    let start = buffer.length - 1;
    while (start > 0 && (buffer[start] & 0xc0) === 0x80) start -= 1;
    const lead = buffer[start];
    const expected = lead <= 0x7f ? 1 : lead <= 0xdf ? 2 : lead <= 0xef ? 3 : lead <= 0xf7 ? 4 : 1;
    return buffer.length - start < expected ? start : buffer.length;
  };
  const previewText = (chunks, retainedBytes) => {
    if (!BufferCtor) {
      const text = chunks.join('');
      return { text, bytes: textByteLength(text) };
    }
    const buffer = BufferCtor.concat(chunks, retainedBytes);
    const completeBytes = completeUtf8Length(buffer);
    return { text: buffer.subarray(0, completeBytes).toString('utf8'), bytes: completeBytes };
  };
  const enqueue = (event) => {
    if (state.queue.length >= state.options.maxEvents) {
      state.queue.shift();
      state.droppedCount += 1;
    }
    state.queue.push(event);
  };
  const observe = (req, res) => {
    if (!state.enabled || !req || !res || state.seen.has(req)) return;
    state.seen.add(req);
    const started = Date.now();
    const initialUrl = String(req.url || '');
    const traceId = String(state.nextId++);
    let requestBytes = 0;
    let responseBytes = 0;
    const requestPreviewChunks = [];
    const responsePreviewChunks = [];
    let requestPreviewBytes = 0;
    let responsePreviewBytes = 0;
    let finished = false;
    const originalReqEmit = req.emit;
    const originalWrite = res.write;
    const originalEnd = res.end;
    req.emit = function patchedReqEmit(eventName, ...args) {
      if (eventName === 'data' && args[0] !== undefined) {
        requestBytes += chunkByteLength(args[0]);
        requestPreviewBytes = appendPreview(requestPreviewChunks, requestPreviewBytes, args[0], state.options.captureRequestBody);
      }
      return originalReqEmit.apply(this, [eventName, ...args]);
    };
    res.write = function patchedWrite(chunk, ...args) {
      responseBytes += chunkByteLength(chunk);
      responsePreviewBytes = appendPreview(responsePreviewChunks, responsePreviewBytes, chunk, state.options.captureResponseBody);
      return originalWrite.apply(this, [chunk, ...args]);
    };
    res.end = function patchedEnd(chunk, ...args) {
      if (chunk !== undefined) {
        responseBytes += chunkByteLength(chunk);
        responsePreviewBytes = appendPreview(responsePreviewChunks, responsePreviewBytes, chunk, state.options.captureResponseBody);
      }
      return originalEnd.apply(this, [chunk, ...args]);
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      req.emit = originalReqEmit;
      res.write = originalWrite;
      res.end = originalEnd;
      const rawUrl = initialUrl || String(req.url || '');
      const requestPreview = previewText(requestPreviewChunks, requestPreviewBytes);
      const responsePreview = previewText(responsePreviewChunks, responsePreviewBytes);
      enqueue({
        id: traceId,
        timestamp: new Date().toISOString(),
        instance: state.options.instance,
        method: String(req.method || 'GET').toUpperCase(),
        path: rawUrl.split('?')[0] || rawUrl,
        url: rawUrl,
        normalizedUrl: rawUrl,
        status: typeof res.statusCode === 'number' ? res.statusCode : null,
        durationMs: Date.now() - started,
        requestBytes,
        responseBytes,
        requestHeaders: toHeaderRecord(req.headers),
        responseHeaders: toHeaderRecord(typeof res.getHeaders === 'function' ? res.getHeaders() : {}),
        requestBodyPreview: requestPreview.text,
        responseBodyPreview: responsePreview.text,
        requestBodyTruncated: state.options.captureRequestBody && state.options.maxBodyBytes > 0 && requestBytes > requestPreview.bytes,
        responseBodyTruncated: state.options.captureResponseBody && state.options.maxBodyBytes > 0 && responseBytes > responsePreview.bytes,
        droppedBeforeEvent: state.droppedCount,
        traceId,
        correlationId: req.headers && typeof req.headers['x-saptools-trace-id'] === 'string' ? req.headers['x-saptools-trace-id'] : null
      });
    };
    res.once('finish', finish);
    res.once('close', finish);
  };
  const patchEmit = (serverPrototype) => {
    if (!serverPrototype || serverPrototype.emit.__saptoolsCfLiveTracePatched) return undefined;
    const original = serverPrototype.emit;
    const patched = function patchedServerEmit(eventName, ...args) {
      if (eventName === 'request') observe(args[0], args[1]);
      return original.apply(this, [eventName, ...args]);
    };
    patched.__saptoolsCfLiveTracePatched = true;
    serverPrototype.emit = patched;
    return original;
  };
  const toTransportLimit = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
  };
  const limitPreview = (event, previewKey, truncatedKey, maxBytes) => {
    const preview = event[previewKey];
    if (maxBytes <= 0 || typeof preview !== 'string' || textByteLength(preview) <= maxBytes) return event;
    return { ...event, [previewKey]: truncateTextToBytes(preview, maxBytes), [truncatedKey]: true };
  };
  const eventForDrain = (event, maxChars) => {
    if (!event || typeof event !== 'object') return event;
    let output = { ...event };
    output = limitPreview(output, 'requestBodyPreview', 'requestBodyTruncated', maxChars);
    output = limitPreview(output, 'responseBodyPreview', 'responseBodyTruncated', maxChars);
    return output;
  };
  const acknowledgeDrain = (drainId) => {
    const pending = state.pendingDrain;
    if (!pending || drainId !== pending.id) return;
    const drainedEvents = new Set(pending.sourceEvents);
    state.queue = state.queue.filter((event) => !drainedEvents.has(event));
    state.pendingDrain = null;
  };
  const drainResult = () => {
    const pending = state.pendingDrain;
    if (!pending) {
      return { drainId: null, events: [], droppedCount: state.droppedCount, queueSize: state.queue.length };
    }
    return {
      drainId: pending.id,
      events: pending.events,
      droppedCount: state.droppedCount,
      queueSize: state.queue.length
    };
  };
  const api = {
    version: runtimeVersion,
    async install(options) {
      if (staleCleanup) {
        await staleCleanup;
        staleCleanup = null;
      }
      state.options = {
        ...state.options,
        ...options,
        maxBodyBytes: toTransportLimit(options && options.maxBodyBytes),
        maxEvents: Math.max(1, Math.floor(Number(options && options.maxEvents) || 1))
      };
      state.queue = [];
      state.pendingDrain = null;
      state.droppedCount = 0;
      state.seen = new WeakSet();
      state.nextId = 1;
      state.nextDrainId = 1;
      if (!state.installed) {
        if (!BufferCtor) {
          const bufferModule = await loadModule('buffer');
          BufferCtor = bufferModule && bufferModule.Buffer ? bufferModule.Buffer : BufferCtor;
        }
        const http = await loadModule('http');
        const https = await loadModule('https');
        state.originals.httpServerEmit = patchEmit(http && http.Server && http.Server.prototype);
        state.originals.httpsServerEmit = patchEmit(https && https.Server && https.Server.prototype);
        state.installed = true;
      }
      state.enabled = true;
      return api.status();
    },
    disable() {
      state.enabled = false;
      return api.status();
    },
    drainEvents(maxCount, maxTransportBodyBytes, acknowledgedDrainId) {
      acknowledgeDrain(acknowledgedDrainId);
      if (state.pendingDrain) return drainResult();
      const count = Math.max(0, Math.min(Number(maxCount) || 0, state.queue.length));
      const transportLimit = toTransportLimit(maxTransportBodyBytes);
      if (count === 0) return drainResult();
      const sourceEvents = state.queue.slice(0, count);
      state.pendingDrain = {
        id: 'd' + String(state.nextDrainId++),
        sourceEvents,
        events: sourceEvents.map((event) => eventForDrain(event, transportLimit))
      };
      return drainResult();
    },
    status() {
      return { installed: state.installed, enabled: state.enabled, queueSize: state.queue.length, droppedCount: state.droppedCount, maxEvents: state.options.maxEvents };
    },
    async uninstall() {
      state.enabled = false;
      const http = await loadModule('http');
      const https = await loadModule('https');
      if (state.originals.httpServerEmit && http && http.Server) http.Server.prototype.emit = state.originals.httpServerEmit;
      if (state.originals.httpsServerEmit && https && https.Server) https.Server.prototype.emit = state.originals.httpsServerEmit;
      state.installed = false;
      state.queue = [];
      state.pendingDrain = null;
      return api.status();
    }
  };
  globalThis[name] = api;
  return api;
})()
`;

export function buildInstallExpression(options: RuntimeInstallOptions): string {
  return `${CF_LIVE_TRACE_RUNTIME_SOURCE}.install(${JSON.stringify(options)})`;
}

export function buildDrainExpression(
  maxCount: number,
  maxTransportBodyBytes: number,
  acknowledgedDrainId: string | null = null,
): string {
  const acknowledgement = JSON.stringify(acknowledgedDrainId);
  return `globalThis.${CF_LIVE_TRACE_GLOBAL_NAME}?.drainEvents(${String(maxCount)}, ${String(maxTransportBodyBytes)}, ${acknowledgement}) ?? { drainId: null, events: [], droppedCount: 0, queueSize: 0 }`;
}

export function buildStopExpression(options: StopExpressionOptions): string {
  return options.uninstallRuntimeHook
    ? `globalThis.${CF_LIVE_TRACE_GLOBAL_NAME}?.uninstall() ?? { installed: false, enabled: false }`
    : `globalThis.${CF_LIVE_TRACE_GLOBAL_NAME}?.disable() ?? { installed: false, enabled: false }`;
}
