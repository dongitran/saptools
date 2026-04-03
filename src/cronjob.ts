import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";

const execFileAsync = promisify(execFile);

const LABEL = "com.saptools.sync";

function getPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

// runner.js lives next to this file in dist/
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
    // Run every 15 minutes (900s); launchd handles scheduling/restart
    `  <key>StartInterval</key><integer>900</integer>`,
    `  <key>RunAtLoad</key><true/>`,
    `  <key>StandardOutPath</key><string>${logPath}</string>`,
    `  <key>StandardErrorPath</key><string>${logPath}</string>`,
    `</dict></plist>`,
  ].join("\n");
}

export async function cronjobEnable(): Promise<void> {
  if (platform() !== "darwin") {
    throw new Error("cronjob is macOS-only (uses launchd). On Linux, add a crontab entry instead.");
  }

  const email = process.env["SAP_EMAIL"];
  const password = process.env["SAP_PASSWORD"];

  if (!email || !password) {
    throw new Error("SAP_EMAIL and SAP_PASSWORD must be set before enabling the cronjob.");
  }

  const plistPath = getPlistPath();

  // Idempotent: unload any existing version first
  if (existsSync(plistPath)) {
    await execFileAsync("launchctl", ["unload", plistPath]).catch(() => undefined);
  }

  await writeFile(plistPath, generatePlist(email, password), "utf-8");
  await execFileAsync("launchctl", ["load", plistPath]);

  process.stdout.write(`✔ Cronjob enabled — syncing every 15 min via launchd\n`);
  process.stdout.write(`  Plist: ${plistPath}\n`);
  process.stdout.write(`  Log:   ${join(homedir(), ".config", "saptools", "sync.log")}\n`);
}

export async function cronjobDisable(): Promise<void> {
  const plistPath = getPlistPath();

  if (!existsSync(plistPath)) {
    process.stdout.write("Cronjob is not enabled.\n");

    return;
  }

  await execFileAsync("launchctl", ["unload", plistPath]).catch(() => undefined);
  await rm(plistPath, { force: true });
  process.stdout.write("✔ Cronjob disabled.\n");
}

export async function cronjobStatus(): Promise<void> {
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
