import { exec, execFile, spawn } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";

const execAsync = async (cmd: string): Promise<{ stdout: string; stderr: string }> => {
  return await new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) reject(error instanceof Error ? error : new Error("Command execution failed"));
      else resolve({ stdout, stderr });
    });
  });
};

const execFileAsync = async (file: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
  return await new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => {
      if (error) reject(error instanceof Error ? error : new Error("Command execution failed"));
      else resolve({ stdout, stderr });
    });
  });
};

const LABEL = "com.saptools.sync";
const CRON_TAG = "# saptools-sync";

function getPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function getRunnerPath(): string {
  const thisFile = fileURLToPath(import.meta.url);

  return join(dirname(thisFile), "runner.js");
}

function generatePlist(email: string, password: string): string {
  const logPath = join(homedir(), ".config", "saptools", "sync.log");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0"><dict>`,
    `  <key>Label</key><string>${LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array><string>${process.execPath}</string><string>${getRunnerPath()}</string></array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>SAP_EMAIL</key><string>${email}</string>`,
    `    <key>SAP_PASSWORD</key><string>${password}</string>`,
    `  </dict>`,
    `  <key>StartInterval</key><integer>900</integer>`,
    `  <key>RunAtLoad</key><true/>`,
    `  <key>StandardOutPath</key><string>${logPath}</string>`,
    `  <key>StandardErrorPath</key><string>${logPath}</string>`,
    `</dict></plist>`,
  ].join("\n");
}

/**
 * Securely update crontab by piping content to `crontab -` stdin.
 * Prevents Shell Injection by avoiding `echo` and `|` in raw shell commands.
 */
async function updateCrontab(content: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("crontab", ["-"]);

    child.stdin.write(content);
    child.stdin.end();

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`crontab - failed with code ${String(code ?? "null")}`));
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

// macOS Implementation (launchd)
async function cronjobEnableMacOS(email: string, password: string): Promise<void> {
  const plistPath = getPlistPath();

  if (existsSync(plistPath)) {
    await execFileAsync("launchctl", ["unload", plistPath]).catch(() => undefined);
  }

  await writeFile(plistPath, generatePlist(email, password), "utf-8");
  await execFileAsync("launchctl", ["load", plistPath]);

  process.stdout.write(`✔ Cronjob enabled — syncing every 15 min via launchd\n`);
  process.stdout.write(`  Plist: ${plistPath}\n`);
}

// Linux/WSL Implementation (crontab)
async function cronjobEnableLinux(email: string, password: string): Promise<void> {
  const runnerPath = getRunnerPath();
  const logPath = join(homedir(), ".config", "saptools", "sync.log");
  
  // Escape single quotes correctly for shell single-quoted string: ' becomes '\''
  const escapedEmail = email.replace(/'/g, "'\\''");
  const escapedPassword = password.replace(/'/g, "'\\''");
  
  const cronEntry = `*/15 * * * * SAP_EMAIL='${escapedEmail}' SAP_PASSWORD='${escapedPassword}' ${process.execPath} ${runnerPath} >> ${logPath} 2>&1 ${CRON_TAG}`;

  let currentCrontab = "";

  try {
    const { stdout } = await execAsync("crontab -l");

    currentCrontab = stdout;
  } catch {
    // Crontab might be empty
  }

  const lines = currentCrontab.split("\n").filter((line) => !line.includes(CRON_TAG) && line.trim() !== "");

  lines.push(cronEntry);

  const newCrontab = `${lines.join("\n")}\n`;

  await updateCrontab(newCrontab);

  process.stdout.write(`✔ Cronjob enabled — syncing every 15 min via crontab\n`);
  process.stdout.write(`  Log: ${logPath}\n`);
}

export async function cronjobEnable(): Promise<void> {
  const email = process.env["SAP_EMAIL"];
  const password = process.env["SAP_PASSWORD"];

  if (!email || !password) {
    throw new Error("SAP_EMAIL and SAP_PASSWORD must be set before enabling the cronjob.");
  }

  if (platform() === "darwin") {
    await cronjobEnableMacOS(email, password);
  } else if (platform() === "linux") {
    await cronjobEnableLinux(email, password);
  } else {
    throw new Error(`Background sync is not supported on platform: ${platform()}`);
  }

  process.stdout.write(`  Log: ${join(homedir(), ".config", "saptools", "sync.log")}\n`);
}

export async function cronjobDisable(): Promise<void> {
  if (platform() === "darwin") {
    const plistPath = getPlistPath();

    if (existsSync(plistPath)) {
      await execFileAsync("launchctl", ["unload", plistPath]).catch(() => undefined);
      await rm(plistPath, { force: true });
    }
  } else if (platform() === "linux") {
    let currentCrontab: string;

    try {
      const { stdout } = await execAsync("crontab -l");

      currentCrontab = stdout;
    } catch {
      return;
    }

    const lines = currentCrontab.split("\n").filter((line) => !line.includes(CRON_TAG));

    if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
      await execAsync("crontab -r").catch(() => undefined);
    } else {
      const newCrontab = `${lines.join("\n").trim()}\n`;

      await updateCrontab(newCrontab);
    }
  }

  process.stdout.write("✔ Cronjob disabled.\n");
}

export async function cronjobStatus(): Promise<void> {
  if (platform() === "darwin") {
    const plistPath = getPlistPath();

    if (!existsSync(plistPath)) {
      process.stdout.write("Status: disabled (run: saptools cronjob enable)\n");

      return;
    }

    try {
      const { stdout } = await execFileAsync("launchctl", ["list", LABEL]);

      process.stdout.write(`Status: active\n${stdout}`);
    } catch {
      process.stdout.write("Status: plist loaded but job not currently running\n");
    }
  } else if (platform() === "linux") {
    try {
      const { stdout } = await execAsync("crontab -l");

      if (stdout.includes(CRON_TAG)) {
        const scheduleLine = stdout.split("\n").find((line) => line.includes(CRON_TAG)) ?? "";

        process.stdout.write("Status: active (via crontab)\n");
        process.stdout.write(`Schedule: ${scheduleLine}\n`);
      } else {
        process.stdout.write("Status: disabled\n");
      }
    } catch {
      process.stdout.write("Status: disabled (no crontab found)\n");
    }
  } else {
    process.stdout.write(`Status: not supported on platform: ${platform()}\n`);
  }
}

export async function runCronjob(subcommand: string | undefined): Promise<void> {
  switch (subcommand) {
    case "enable":
      await cronjobEnable();
      return;
    case "disable":
      await cronjobDisable();
      return;
    case "status":
      await cronjobStatus();
      return;
    case undefined:
    default:
      process.stderr.write("Usage: saptools cronjob <enable|disable|status>\n");
      process.exit(1);
  }
}

