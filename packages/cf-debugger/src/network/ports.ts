import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { promisify } from "node:util";

import { CfDebuggerError } from "../types.js";

const execFileAsync = promisify(execFile);

async function findListeningPidsWithNetstat(port: number): Promise<readonly number[]> {
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano"]);
    const pids = new Set<number>();
    for (const line of stdout.split("\n")) {
      if (!line.includes(`:${port.toString()}`) || !line.includes("LISTENING")) {
        continue;
      }
      const parts = line.trim().split(/\s+/);
      const last = parts[parts.length - 1];
      if (last === undefined) {
        continue;
      }
      const pid = Number.parseInt(last, 10);
      if (!Number.isNaN(pid)) {
        pids.add(pid);
      }
    }
    return [...pids];
  } catch {
    return [];
  }
}

async function findListeningPidsWithLsof(port: number): Promise<readonly number[]> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", "-t", "-i", `tcp:${port.toString()}`, "-sTCP:LISTEN"]);
    return stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => Number.parseInt(line, 10))
      .filter((pid) => !Number.isNaN(pid));
  } catch {
    return [];
  }
}

async function findListeningPidsWithProc(port: number): Promise<readonly number[]> {
  const inodes = await findListeningSocketInodesWithProc(port);
  if (inodes.size === 0) {
    return [];
  }

  try {
    const entries = await readdir("/proc", { withFileTypes: true });
    const pids = new Set<number>();
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
        continue;
      }
      if (await processHasSocketInode(entry.name, inodes)) {
        pids.add(Number.parseInt(entry.name, 10));
      }
    }
    return [...pids];
  } catch {
    return [];
  }
}

async function findListeningSocketInodesWithProc(port: number): Promise<ReadonlySet<string>> {
  const inodes = new Set<string>();
  await collectListeningSocketInodes("/proc/net/tcp", port, inodes);
  await collectListeningSocketInodes("/proc/net/tcp6", port, inodes);
  return inodes;
}

async function collectListeningSocketInodes(
  path: string,
  port: number,
  inodes: Set<string>,
): Promise<void> {
  try {
    const content = await readFile(path, "utf8");
    for (const line of content.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      const localAddress = fields[1];
      const state = fields[3];
      const inode = fields[9];
      if (localAddress === undefined || state === undefined || inode === undefined) {
        continue;
      }
      const localPort = Number.parseInt(localAddress.split(":")[1] ?? "", 16);
      if (localPort === port && state === "0A") {
        inodes.add(inode);
      }
    }
  } catch {
    // /proc/net/tcp* is Linux-specific; callers fall back to other strategies.
  }
}

async function processHasSocketInode(pid: string, inodes: ReadonlySet<string>): Promise<boolean> {
  try {
    const descriptors = await readdir(`/proc/${pid}/fd`);
    for (const descriptor of descriptors) {
      try {
        const link = await readlink(`/proc/${pid}/fd/${descriptor}`);
        const match = /^socket:\[(\d+)\]$/.exec(link);
        if (match?.[1] !== undefined && inodes.has(match[1])) {
          return true;
        }
      } catch {
        // The process may close descriptors while we scan them.
      }
    }
  } catch {
    // The process may exit, or permissions may prevent fd inspection.
  }
  return false;
}

async function findListeningPids(port: number): Promise<readonly number[]> {
  if (process.platform === "win32") {
    return await findListeningPidsWithNetstat(port);
  }
  const lsofPids = await findListeningPidsWithLsof(port);
  return lsofPids.length > 0 ? lsofPids : await findListeningPidsWithProc(port);
}

export async function isPortFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen(port, "127.0.0.1");
  });
}

export async function isPortListening(port: number, timeoutMs = 200): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CfDebuggerError("ABORTED", "Operation aborted by caller");
  }
}

function waitForNextProbe(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CfDebuggerError("ABORTED", "Operation aborted by caller"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function probeTunnelReady(
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const pollIntervalMs = 250;
  const started = Date.now();
  throwIfAborted(signal);

  while (Date.now() - started < timeoutMs) {
    const connected = await isPortListening(port);
    if (connected) {
      return true;
    }
    const remainingMs = timeoutMs - (Date.now() - started);
    await waitForNextProbe(Math.min(pollIntervalMs, Math.max(0, remainingMs)), signal);
  }

  throwIfAborted(signal);
  return false;
}

export async function findListeningProcessId(port: number): Promise<number | undefined> {
  const pids = await findListeningPids(port);
  return pids[0];
}
