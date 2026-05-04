#!/usr/bin/env node

import { appendFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function readJson(path, fallback) {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function getScenarioPath() {
  const path = process.env["CF_FILES_FAKE_SCENARIO"];
  if (!path) {
    fail("Missing CF_FILES_FAKE_SCENARIO");
  }
  return path;
}

function getStatePath() {
  const cfHome = process.env["CF_HOME"];
  if (!cfHome) {
    fail("Missing CF_HOME");
  }
  return join(cfHome, "fake-cf-state.json");
}

async function logInvocation(command, args, state) {
  const path = process.env["CF_FILES_FAKE_LOG_PATH"];
  if (!path) {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await appendFile(
    path,
    `${JSON.stringify({
      at: new Date().toISOString(),
      command,
      args,
      apiEndpoint: state.apiEndpoint ?? null,
      org: state.org ?? null,
      space: state.space ?? null,
    })}\n`,
    "utf8",
  );
}

function indexScenario(scenario) {
  const byEndpoint = new Map();
  for (const region of scenario.regions ?? []) {
    byEndpoint.set(region.apiEndpoint, region);
  }
  return byEndpoint;
}

function requireRegion(state, regionsByEndpoint) {
  const region = regionsByEndpoint.get(state.apiEndpoint ?? "");
  if (!region) {
    fail("No targeted API endpoint");
  }
  return region;
}

function requireOrg(region, state) {
  const org = (region.orgs ?? []).find((o) => o.name === state.org);
  if (!org) {
    fail("No targeted org");
  }
  return org;
}

function requireSpace(org, state) {
  const space = (org.spaces ?? []).find((s) => s.name === state.space);
  if (!space) {
    fail("No targeted space");
  }
  return space;
}

function requireApp(space, appName) {
  const app = (space.apps ?? []).find((a) => a.name === appName);
  if (!app) {
    fail(`Unknown app: ${appName}`);
  }
  return app;
}

function formatUserProvided(app) {
  const userProvided = app.userProvidedEnv ?? {};
  const entries = Object.entries(userProvided);
  if (entries.length === 0) {
    return ["(empty)"];
  }

  const lines = [];
  for (const [key, value] of entries) {
    const rendered =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
    const valueLines = rendered.split("\n");
    const [firstLine = ""] = valueLines;
    lines.push(`${key}: ${firstLine}`);
    for (const line of valueLines.slice(1)) {
      lines.push(line);
    }
  }
  return lines;
}

function formatCfEnv(app, org, space) {
  const vcapServices = app.vcapServices ?? {};
  const vcapApplication = app.vcapApplication ?? {};
  const userProvided = formatUserProvided(app);
  return [
    `Getting env variables for app ${app.name} in org ${org.name} / space ${space.name} as fake@example.com...`,
    "OK",
    "",
    "System-Provided:",
    `VCAP_SERVICES: ${JSON.stringify(vcapServices, null, 2)}`,
    "",
    `VCAP_APPLICATION: ${JSON.stringify(vcapApplication, null, 2)}`,
    "",
    "User-Provided:",
    ...userProvided,
    "",
  ].join("\n");
}

function pad(value, width) {
  const str = String(value);
  if (str.length >= width) return str;
  return " ".repeat(width - str.length) + str;
}

function formatLsEntry(name, isDirectory, size) {
  const perms = isDirectory ? "drwxr-xr-x" : "-rw-r--r--";
  const links = isDirectory ? "2" : "1";
  return [
    perms,
    pad(links, 2),
    "vcap",
    "vcap",
    pad(size, 5),
    "Apr",
    "20",
    "10:00",
    name,
  ].join(" ");
}

function isBase64File(value) {
  return value && typeof value === "object" && typeof value.base64 === "string";
}

function fileBuffer(value) {
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }
  if (isBase64File(value)) {
    return Buffer.from(value.base64, "base64");
  }
  return Buffer.alloc(0);
}

function splitShellWords(command) {
  const words = [];
  let current = "";
  let quote = null;
  let hasWord = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      hasWord = true;
      continue;
    }
    if (ch === "\\") {
      const next = command[i + 1];
      current += next ?? ch;
      i += next ? 1 : 0;
      hasWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasWord) {
        words.push(current);
        current = "";
        hasWord = false;
      }
      continue;
    }
    current += ch;
    hasWord = true;
  }

  if (quote) {
    fail(`Unterminated quote in ssh command: ${command}`);
  }
  if (hasWord) {
    words.push(current);
  }
  return words;
}

function parseRemotePathCommand(command, executable, requiredArgs) {
  const words = splitShellWords(command);
  if (words[0] !== executable) {
    return null;
  }

  let index = 1;
  for (const expected of requiredArgs) {
    if (words[index] !== expected) {
      return null;
    }
    index++;
  }

  if (words[index] === "--") {
    index++;
  }
  const path = words[index];
  if (!path || words.length !== index + 1) {
    fail(`fake-cf: invalid ssh command: ${command}`);
  }
  return path;
}

function listDirectory(files, dirPath) {
  const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
  const children = new Map();
  for (const filePath of Object.keys(files)) {
    if (!filePath.startsWith(prefix)) continue;
    const relative = filePath.slice(prefix.length);
    if (relative.length === 0) continue;
    const segments = relative.split("/");
    const childName = segments[0];
    const isDir = segments.length > 1;
    const content = files[filePath];
    const size = fileBuffer(content).byteLength;
    const existing = children.get(childName);
    if (!existing) {
      children.set(childName, { isDir, size: isDir ? 4096 : size });
    } else if (isDir && !existing.isDir) {
      children.set(childName, { isDir: true, size: 4096 });
    }
  }
  return children;
}

function renderLsOutput(children) {
  if (children.size === 0) {
    return "total 0\n";
  }
  const lines = [`total ${String(children.size * 4)}`];
  lines.push(formatLsEntry(".", true, 4096));
  lines.push(formatLsEntry("..", true, 4096));
  for (const [name, meta] of children) {
    lines.push(formatLsEntry(name, meta.isDir, meta.size));
  }
  return `${lines.join("\n")}\n`;
}

function quoteShellArg(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isTarCommand(command) {
  const trimmed = command.trim();
  return (
    trimmed.startsWith("tar ") ||
    (trimmed.startsWith("cd ") && trimmed.includes(" tar "))
  );
}

function extractBasePathFromTarCommand(command) {
  const words = splitShellWords(command);
  if (words[0] === "cd" && words[1]) {
    return words[1];
  }

  const cFlag = words.indexOf("-C");
  return cFlag === -1 ? null : words[cFlag + 1] ?? null;
}

async function materializeAppFiles(app, baseDir) {
  const files = app.files ?? {};
  const appSymlinks = app.symlinks ?? {};

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(baseDir, filePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, fileBuffer(content));
  }

  for (const [linkPath, target] of Object.entries(appSymlinks)) {
    const fullLinkPath = join(baseDir, linkPath);
    await mkdir(dirname(fullLinkPath), { recursive: true });
    const resolvedTarget = target.startsWith("/") ? join(baseDir, target) : target;
    try {
      await symlink(resolvedTarget, fullLinkPath);
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
  }
}

async function handleTarSshCommand(app, command) {
  const basePath = extractBasePathFromTarCommand(command);
  if (!basePath) {
    fail(`fake-cf: cannot extract base path from tar command: ${command}`);
  }

  const tmpDir = join(tmpdir(), `fake-cf-tar-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });

  try {
    await materializeAppFiles(app, tmpDir);

    const actualBasePath = join(tmpDir, basePath);
    const adjustedCommand = command
      .split(quoteShellArg(basePath))
      .join(quoteShellArg(actualBasePath));

    const result = spawnSync("bash", ["-c", adjustedCommand], {
      encoding: "buffer",
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 256 * 1024 * 1024,
    });

    if (result.status !== 0) {
      const errMsg = result.stderr?.toString() ?? "tar failed";
      process.stderr.write(errMsg);
      process.exit(1);
    }

    return result.stdout ?? Buffer.alloc(0);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function handleSshCommand(app, command) {
  const lsPath = parseRemotePathCommand(command, "ls", ["-la"]);
  if (lsPath) {
    const path = lsPath;
    const files = app.files ?? {};
    if (Object.prototype.hasOwnProperty.call(files, path)) {
      const content = files[path];
      const size = fileBuffer(content).byteLength;
      return `${formatLsEntry(path.split("/").pop() ?? "", false, size)}\n`;
    }
    const children = listDirectory(files, path);
    if (children.size === 0) {
      const hasPrefix = Object.keys(files).some((f) => f.startsWith(`${path}/`));
      if (!hasPrefix) {
        process.stderr.write(`ls: cannot access '${path}': No such file or directory\n`);
        process.exit(1);
      }
    }
    return renderLsOutput(children);
  }

  const catPath = parseRemotePathCommand(command, "cat", []);
  if (catPath) {
    const path = catPath;
    const files = app.files ?? {};
    if (!Object.prototype.hasOwnProperty.call(files, path)) {
      process.stderr.write(`cat: ${path}: No such file or directory\n`);
      process.exit(1);
    }
    return fileBuffer(files[path]);
  }

  if (isTarCommand(command)) {
    return await handleTarSshCommand(app, command);
  }

  process.stderr.write(`fake-cf: unsupported ssh command: ${command}\n`);
  process.exit(1);
  return "";
}

async function main() {
  const scenario = await readJson(getScenarioPath(), { regions: [] });
  const statePath = getStatePath();
  const state = await readJson(statePath, {});
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    fail("Missing command");
  }

  await logInvocation(command, args.slice(1), state);

  const regionsByEndpoint = indexScenario(scenario);

  if (command === "api") {
    const endpoint = args[1];
    if (!endpoint || !regionsByEndpoint.has(endpoint)) {
      fail(`Unknown API endpoint: ${endpoint ?? "<missing>"}`);
    }
    state.apiEndpoint = endpoint;
    delete state.org;
    delete state.space;
    await writeJson(statePath, state);
    process.stdout.write(`Setting API endpoint to ${endpoint}\nOK\n`);
    return;
  }

  const region = requireRegion(state, regionsByEndpoint);

  if (command === "auth") {
    if (!process.env["CF_USERNAME"] || !process.env["CF_PASSWORD"]) {
      fail("Missing CF_USERNAME or CF_PASSWORD");
    }
    if (region.accessible === false) {
      fail(region.authError ?? "Authentication failed");
    }
    process.stdout.write("OK\n");
    return;
  }

  if (command === "target") {
    const orgFlag = args.indexOf("-o");
    const spaceFlag = args.indexOf("-s");
    if (orgFlag === -1 || !args[orgFlag + 1]) {
      fail("Missing -o");
    }
    const orgName = args[orgFlag + 1];
    const org = (region.orgs ?? []).find((o) => o.name === orgName);
    if (!org) {
      fail(`Unknown org: ${orgName}`);
    }
    state.org = orgName;
    if (spaceFlag !== -1 && args[spaceFlag + 1]) {
      const spaceName = args[spaceFlag + 1];
      const space = (org.spaces ?? []).find((s) => s.name === spaceName);
      if (!space) {
        fail(`Unknown space: ${spaceName}`);
      }
      state.space = spaceName;
    } else {
      delete state.space;
    }
    await writeJson(statePath, state);
    process.stdout.write("OK\n");
    return;
  }

  if (command === "env") {
    const appName = args[1];
    if (!appName) {
      fail("Missing app name");
    }
    const org = requireOrg(region, state);
    const space = requireSpace(org, state);
    const app = requireApp(space, appName);
    process.stdout.write(formatCfEnv(app, org, space));
    return;
  }

  if (command === "ssh") {
    const appName = args[1];
    const cFlag = args.indexOf("-c");
    if (!appName || cFlag === -1 || !args[cFlag + 1]) {
      fail("cf ssh requires <app> -c <command>");
    }
    const shellCommand = args[cFlag + 1];
    const org = requireOrg(region, state);
    const space = requireSpace(org, state);
    const app = requireApp(space, appName);
    const output = await handleSshCommand(app, shellCommand);
    process.stdout.write(output);
    return;
  }

  fail(`Unsupported command: ${command}`);
}

await main();
