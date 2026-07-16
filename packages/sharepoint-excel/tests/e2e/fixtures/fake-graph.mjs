#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

function readScenario() {
  const raw = process.env.SHAREPOINT_EXCEL_FAKE_SCENARIO;
  if (!raw) {
    throw new Error("SHAREPOINT_EXCEL_FAKE_SCENARIO is required");
  }
  return JSON.parse(raw);
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text, "utf8"),
  });
  res.end(text);
}

function sendError(res, status, code, message) {
  writeJson(res, status, { error: { code, message } });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function textBody(buffer) {
  return buffer.toString("utf8");
}

function normalizePath(value) {
  return decodeURIComponent(value).replace(/^\/+|(?<!\/)\/+$/g, "");
}

const INTERNAL_ERROR_MESSAGE = "An internal fake Graph error occurred";

function itemPayload(file) {
  return {
    id: file.id,
    name: file.name,
    size: file.content.length,
    eTag: file.eTag,
    cTag: file.cTag,
    webUrl: `https://fake.sharepoint/${encodeURIComponent(file.path)}`,
    file: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  };
}

function createState(scenario) {
  return {
    scenario,
    files: new Map(),
    uploadSessions: new Map(),
  };
}

async function handleToken(req, res, state) {
  const params = new URLSearchParams(textBody(await parseBody(req)));
  const expected = state.scenario.credentials ?? {};
  if (params.get("client_id") !== expected.clientId || params.get("client_secret") !== expected.clientSecret) {
    writeJson(res, 401, { error: "invalid_client", error_description: "credential mismatch" });
    return;
  }
  writeJson(res, 200, {
    access_token: "fake-token",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "https://graph.microsoft.com/.default",
  });
}

function handleSite(pathname, res, state) {
  const match = /^\/v1\.0\/sites\/([^:]+):\/(.+)$/.exec(pathname);
  if (!match) {
    return false;
  }
  const host = decodeURIComponent(match[1]);
  const sitePath = match[2].split("/").map(decodeURIComponent).join("/");
  const site = state.scenario.site;
  if (site.hostname !== host || site.path !== sitePath) {
    sendError(res, 404, "itemNotFound", "site missing");
    return true;
  }
  writeJson(res, 200, {
    id: site.id,
    name: site.name,
    displayName: site.displayName,
    webUrl: site.webUrl,
  });
  return true;
}

function handleDrives(pathname, res, state) {
  const match = /^\/v1\.0\/sites\/([^/]+)\/drives$/.exec(pathname);
  if (!match) {
    return false;
  }
  const siteId = decodeURIComponent(match[1]);
  if (siteId !== state.scenario.site.id) {
    sendError(res, 404, "itemNotFound", "site missing");
    return true;
  }
  writeJson(res, 200, { value: state.scenario.drives });
  return true;
}

function handleGetItem(pathname, res, state) {
  const match = /^\/v1\.0\/drives\/([^/]+)\/root:\/([^:]+)$/.exec(pathname);
  if (!match) {
    return false;
  }
  const driveId = decodeURIComponent(match[1]);
  const path = normalizePath(match[2]);
  const file = state.files.get(`${driveId}:${path}`);
  if (!file) {
    sendError(res, 404, "itemNotFound", `${path} missing`);
    return true;
  }
  writeJson(res, 200, itemPayload(file));
  return true;
}

function handleDownload(pathname, res, state) {
  const match = /^\/v1\.0\/drives\/([^/]+)\/root:\/([^:]+):\/content$/.exec(pathname);
  if (!match) {
    return false;
  }
  const driveId = decodeURIComponent(match[1]);
  const path = normalizePath(match[2]);
  const file = state.files.get(`${driveId}:${path}`);
  if (!file) {
    sendError(res, 404, "itemNotFound", `${path} missing`);
    return true;
  }
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Length": file.content.length,
  });
  res.end(file.content);
  return true;
}

async function handleCreateUploadSession(req, pathname, res, state) {
  const match = /^\/v1\.0\/drives\/([^/]+)\/root:\/([^:]+):\/createUploadSession$/.exec(pathname);
  if (!match) {
    return false;
  }
  await parseBody(req);
  const driveId = decodeURIComponent(match[1]);
  const path = normalizePath(match[2]);
  if (state.files.has(`${driveId}:${path}`)) {
    sendError(res, 409, "nameAlreadyExists", `${path} exists`);
    return true;
  }
  const sessionId = randomUUID();
  state.uploadSessions.set(sessionId, { driveId, path });
  writeJson(res, 200, { uploadUrl: `http://127.0.0.1:${state.port}/upload/${sessionId}` });
  return true;
}

async function handleUpload(req, pathname, res, state) {
  const match = /^\/upload\/([^/]+)$/.exec(pathname);
  if (!match) {
    return false;
  }
  const session = state.uploadSessions.get(match[1]);
  if (!session) {
    sendError(res, 404, "itemNotFound", "upload session missing");
    return true;
  }
  const content = await parseBody(req);
  const file = {
    id: `item-${randomUUID()}`,
    name: session.path.split("/").at(-1) ?? "book.xlsx",
    path: session.path,
    content,
    eTag: `"${randomUUID()}"`,
    cTag: `"${randomUUID()}"`,
  };
  state.files.set(`${session.driveId}:${session.path}`, file);
  state.uploadSessions.delete(match[1]);
  writeJson(res, 201, itemPayload(file));
  return true;
}

async function handleReplace(req, pathname, res, state) {
  const match = /^\/v1\.0\/drives\/([^/]+)\/root:\/([^:]+):\/content$/.exec(pathname);
  if (!match || req.method !== "PUT") {
    return false;
  }
  const driveId = decodeURIComponent(match[1]);
  const path = normalizePath(match[2]);
  const key = `${driveId}:${path}`;
  const existing = state.files.get(key);
  if (!existing) {
    sendError(res, 404, "itemNotFound", `${path} missing`);
    return true;
  }
  if (req.headers["if-match"] !== existing.eTag) {
    sendError(res, 412, "preconditionFailed", "etag mismatch");
    return true;
  }
  const content = await parseBody(req);
  const updated = { ...existing, content, eTag: `"${randomUUID()}"`, cTag: `"${randomUUID()}"` };
  state.files.set(key, updated);
  writeJson(res, 200, itemPayload(updated));
  return true;
}

async function dispatch(req, res, state) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;
  if (req.method === "POST" && /\/oauth2\/v2\.0\/token$/.test(pathname)) {
    await handleToken(req, res, state);
    return;
  }
  if (req.method === "GET" && (handleSite(pathname, res, state) || handleDrives(pathname, res, state))) {
    return;
  }
  if (req.method === "GET" && (handleGetItem(pathname, res, state) || handleDownload(pathname, res, state))) {
    return;
  }
  if (req.method === "POST" && await handleCreateUploadSession(req, pathname, res, state)) {
    return;
  }
  if (req.method === "PUT" && (await handleUpload(req, pathname, res, state) || await handleReplace(req, pathname, res, state))) {
    return;
  }
  sendError(res, 404, "itemNotFound", `No handler for ${req.method} ${pathname}`);
}

const state = createState(readScenario());
const server = createServer((req, res) => {
  dispatch(req, res, state).catch(() => {
    sendError(res, 500, "internalError", INTERNAL_ERROR_MESSAGE);
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address === "object") {
    state.port = address.port;
    process.stdout.write(`LISTENING ${address.port}\n`);
  }
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
