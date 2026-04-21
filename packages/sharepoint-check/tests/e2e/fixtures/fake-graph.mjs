#!/usr/bin/env node
import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

function base64Url(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replaceAll("=", "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

function encodeToken(claims) {
  const header = base64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64Url(JSON.stringify(claims));
  return `${header}.${payload}.sig`;
}

function readScenario() {
  const raw = process.env.SHAREPOINT_FAKE_SCENARIO;
  if (!raw) {
    throw new Error("SHAREPOINT_FAKE_SCENARIO env var is required");
  }
  return JSON.parse(raw);
}

function normalizePath(input) {
  return input.replace(/^\/+|\/+$/g, "");
}

function findFolder(root, segments) {
  let node = root;
  for (const seg of segments) {
    if (!node || !node.children) {
      return null;
    }
    const next = node.children.find((c) => c.name === seg);
    if (!next) {
      return null;
    }
    node = next;
  }
  return node;
}

function toDriveItemPayload(node) {
  const payload = {
    id: node.id,
    name: node.name,
    size: node.size ?? 0,
    webUrl: node.webUrl ?? `https://fake.sharepoint/${encodeURIComponent(node.name)}`,
  };
  if (node.isFolder) {
    payload.folder = { childCount: (node.children ?? []).length };
  } else {
    payload.file = { mimeType: "application/octet-stream" };
  }
  return payload;
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body, "utf8"),
  });
  res.end(body);
}

function sendOk(res, body) {
  writeJson(res, 200, JSON.stringify(body));
}

function sendError(res, status, code, message) {
  writeJson(res, status, JSON.stringify({ error: { code, message } }));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function handleTokenRequest(req, res, scenario) {
  const body = await parseBody(req);
  const params = new URLSearchParams(body);

  const grantType = params.get("grant_type");
  const clientId = params.get("client_id");
  const clientSecret = params.get("client_secret");

  function sendOAuthError(status, code, description) {
    writeJson(res, status, JSON.stringify({ error: code, error_description: description }));
  }

  if (grantType !== "client_credentials") {
    sendOAuthError(400, "unsupported_grant_type", `Unsupported grant_type: ${grantType ?? "(none)"}`);
    return;
  }

  const expected = scenario.credentials ?? {};
  if (expected.clientId && clientId !== expected.clientId) {
    sendOAuthError(401, "invalid_client", "client_id mismatch");
    return;
  }
  if (expected.clientSecret && clientSecret !== expected.clientSecret) {
    sendOAuthError(401, "invalid_client", "client_secret mismatch");
    return;
  }

  const claims = {
    appid: expected.clientId ?? "00000000-0000-0000-0000-000000000001",
    app_displayname: scenario.appDisplayName ?? "Demo Connector",
    tid: expected.tenantId ?? "00000000-0000-0000-0000-000000000000",
    roles: scenario.roles ?? ["Sites.Selected"],
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  sendOk(res, {
    access_token: encodeToken(claims),
    token_type: "Bearer",
    expires_in: 3600,
    scope: "https://graph.microsoft.com/.default",
  });
}

function handleSiteLookup(pathname, res, scenario) {
  const match = /^\/v1\.0\/sites\/([^:]+):\/(.+)$/.exec(pathname);
  if (!match) {
    sendError(res, 404, "itemNotFound", "Site not found");
    return;
  }
  const host = decodeURIComponent(match[1]);
  const sitePath = match[2].split("/").map(decodeURIComponent).join("/");

  const site = scenario.site;
  if (!site || site.hostname !== host || site.path !== sitePath) {
    sendError(res, 404, "itemNotFound", `Site ${host}/${sitePath} not found`);
    return;
  }

  sendOk(res, {
    id: site.id,
    name: site.name,
    displayName: site.displayName ?? site.name,
    webUrl: site.webUrl ?? `https://${host}/${sitePath}`,
  });
}

function handleListDrives(pathname, res, scenario) {
  const match = /^\/v1\.0\/sites\/([^/]+)\/drives$/.exec(pathname);
  if (!match) {
    sendError(res, 404, "itemNotFound", "Not found");
    return;
  }
  const siteId = decodeURIComponent(match[1]);
  if (scenario.site?.id !== siteId) {
    sendError(res, 404, "itemNotFound", "Site not found");
    return;
  }
  sendOk(res, { value: scenario.drives ?? [] });
}

function handleChildrenByPath(pathname, res, scenario) {
  const match = /^\/v1\.0\/drives\/([^/]+)\/root(?::\/([^:]+))?:?\/children$/.exec(pathname);
  if (!match) {
    return false;
  }
  const driveId = decodeURIComponent(match[1]);
  const relativePath = match[2] ? decodeURIComponent(match[2]) : "";
  const drive = (scenario.driveItems ?? {})[driveId];
  if (!drive) {
    sendError(res, 404, "itemNotFound", `Drive ${driveId} not found`);
    return true;
  }
  const segments = normalizePath(relativePath).split("/").filter(Boolean);
  const folder = segments.length === 0 ? drive : findFolder(drive, segments);
  if (!folder || !folder.isFolder) {
    sendError(res, 404, "itemNotFound", `Folder ${relativePath} not found`);
    return true;
  }
  sendOk(res, {
    value: (folder.children ?? []).map(toDriveItemPayload),
  });
  return true;
}

function handleRootChildren(pathname, res, scenario) {
  const match = /^\/v1\.0\/drives\/([^/]+)\/root\/children$/.exec(pathname);
  if (!match) {
    return false;
  }
  const driveId = decodeURIComponent(match[1]);
  const drive = (scenario.driveItems ?? {})[driveId];
  if (!drive) {
    sendError(res, 404, "itemNotFound", `Drive ${driveId} not found`);
    return true;
  }
  sendOk(res, { value: (drive.children ?? []).map(toDriveItemPayload) });
  return true;
}

function handleGetItemByPath(pathname, res, scenario) {
  const match = /^\/v1\.0\/drives\/([^/]+)\/root:\/([^:]+)$/.exec(pathname);
  if (!match) {
    return false;
  }
  const driveId = decodeURIComponent(match[1]);
  const relativePath = decodeURIComponent(match[2]);
  const drive = (scenario.driveItems ?? {})[driveId];
  if (!drive) {
    sendError(res, 404, "itemNotFound", `Drive ${driveId} not found`);
    return true;
  }
  const segments = normalizePath(relativePath).split("/").filter(Boolean);
  const node = findFolder(drive, segments);
  if (!node) {
    sendError(res, 404, "itemNotFound", `Item ${relativePath} not found`);
    return true;
  }
  sendOk(res, toDriveItemPayload(node));
  return true;
}

function handleGetRoot(pathname, res, scenario) {
  const match = /^\/v1\.0\/drives\/([^/]+)\/root$/.exec(pathname);
  if (!match) {
    return false;
  }
  const driveId = decodeURIComponent(match[1]);
  const drive = (scenario.driveItems ?? {})[driveId];
  if (!drive) {
    sendError(res, 404, "itemNotFound", `Drive ${driveId} not found`);
    return true;
  }
  sendOk(res, toDriveItemPayload(drive));
  return true;
}

async function handleCreateFolder(req, pathname, res, scenario) {
  const withPath = /^\/v1\.0\/drives\/([^/]+)\/root:\/([^:]+):\/children$/.exec(pathname);
  const rootMatch = /^\/v1\.0\/drives\/([^/]+)\/root\/children$/.exec(pathname);
  const match = withPath ?? rootMatch;
  if (!match) {
    return false;
  }

  const driveId = decodeURIComponent(match[1]);
  const relativePath = withPath ? decodeURIComponent(withPath[2]) : "";
  const drive = (scenario.driveItems ?? {})[driveId];
  if (!drive) {
    sendError(res, 404, "itemNotFound", `Drive ${driveId} not found`);
    return true;
  }

  const segments = normalizePath(relativePath).split("/").filter(Boolean);
  const parent = segments.length === 0 ? drive : findFolder(drive, segments);
  if (!parent || !parent.isFolder) {
    sendError(res, 404, "itemNotFound", `Parent ${relativePath} not found`);
    return true;
  }

  const raw = await parseBody(req);
  const payload = raw.length > 0 ? JSON.parse(raw) : {};
  const name = typeof payload.name === "string" ? payload.name : "untitled";

  if ((parent.children ?? []).some((c) => c.name === name)) {
    sendError(res, 409, "nameAlreadyExists", `Folder ${name} already exists`);
    return true;
  }

  if (scenario.writable === false) {
    sendError(res, 403, "accessDenied", "Write access not granted");
    return true;
  }

  const id = `probe-${randomUUID()}`;
  const newNode = { id, name, isFolder: true, children: [], size: 0 };
  parent.children = parent.children ?? [];
  parent.children.push(newNode);
  sendOk(res, toDriveItemPayload(newNode));
  return true;
}

function removeNodeById(root, targetId) {
  if (!root.children) {
    return false;
  }
  const idx = root.children.findIndex((c) => c.id === targetId);
  if (idx >= 0) {
    root.children.splice(idx, 1);
    return true;
  }
  for (const child of root.children) {
    if (removeNodeById(child, targetId)) {
      return true;
    }
  }
  return false;
}

function handleDeleteItem(pathname, res, scenario) {
  const match = /^\/v1\.0\/drives\/([^/]+)\/items\/([^/]+)$/.exec(pathname);
  if (!match) {
    return false;
  }
  const driveId = decodeURIComponent(match[1]);
  const itemId = decodeURIComponent(match[2]);
  const drive = (scenario.driveItems ?? {})[driveId];
  if (!drive) {
    sendError(res, 404, "itemNotFound", `Drive ${driveId} not found`);
    return true;
  }
  const removed = removeNodeById(drive, itemId);
  if (!removed) {
    sendError(res, 404, "itemNotFound", `Item ${itemId} not found`);
    return true;
  }
  res.writeHead(204).end();
  return true;
}

async function dispatchGraph(req, pathname, res, scenario) {
  if (req.method === "GET") {
    const siteLookup = /^\/v1\.0\/sites\/([^:]+):\/(.+)$/.exec(pathname);
    if (siteLookup) {
      handleSiteLookup(pathname, res, scenario);
      return;
    }
    if (/^\/v1\.0\/sites\/([^/]+)\/drives$/.test(pathname)) {
      handleListDrives(pathname, res, scenario);
      return;
    }
    if (handleChildrenByPath(pathname, res, scenario)) {
      return;
    }
    if (handleRootChildren(pathname, res, scenario)) {
      return;
    }
    if (handleGetRoot(pathname, res, scenario)) {
      return;
    }
    if (handleGetItemByPath(pathname, res, scenario)) {
      return;
    }
  }

  if (req.method === "POST") {
    if (await handleCreateFolder(req, pathname, res, scenario)) {
      return;
    }
  }

  if (req.method === "DELETE") {
    if (handleDeleteItem(pathname, res, scenario)) {
      return;
    }
  }

  sendError(res, 404, "itemNotFound", `No handler for ${req.method} ${pathname}`);
}

const scenario = readScenario();

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;

  (async () => {
    try {
      if (req.method === "POST" && /\/oauth2\/v2\.0\/token$/.test(pathname)) {
        await handleTokenRequest(req, res, scenario);
        return;
      }
      await dispatchGraph(req, pathname, res, scenario);
    } catch (err) {
      sendError(res, 500, "internalError", err instanceof Error ? err.message : String(err));
    }
  })().catch((err) => {
    try {
      sendError(res, 500, "internalError", err instanceof Error ? err.message : String(err));
    } catch {}
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address === "object") {
    process.stdout.write(`LISTENING ${address.port}\n`);
  }
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
