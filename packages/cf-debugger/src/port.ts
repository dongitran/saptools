import { execFile } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

export async function probeTunnelReady(port: number, timeoutMs: number): Promise<boolean> {
  const pollIntervalMs = 250;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port, host: "127.0.0.1" });
      socket.setTimeout(200);
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

    if (connected) {
      return true;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollIntervalMs);
    });
  }

  return false;
}

export async function killProcessOnPort(port: number): Promise<void> {
  const portStr = port.toString();
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("netstat", ["-ano"]);
      const pids = new Set<number>();
      for (const line of stdout.split("\n")) {
        if (line.includes(`:${portStr}`) && line.includes("LISTENING")) {
          const parts = line.trim().split(/\s+/);
          const last = parts[parts.length - 1];
          if (last !== undefined) {
            const pid = Number.parseInt(last, 10);
            if (!Number.isNaN(pid)) {
              pids.add(pid);
            }
          }
        }
      }
      for (const pid of pids) {
        try {
          // cspell:ignore taskkill
          await execFileAsync("taskkill", ["/F", "/PID", pid.toString()]);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    return;
  }

  try {
    const { stdout } = await execFileAsync("lsof", ["-t", "-i", `tcp:${portStr}`]);
    const lines = stdout
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);
    for (const pidStr of lines) {
      const pid = Number.parseInt(pidStr, 10);
      if (!Number.isNaN(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already dead
        }
      }
    }
  } catch {
    // lsof missing or no match — ignore
  }
}
