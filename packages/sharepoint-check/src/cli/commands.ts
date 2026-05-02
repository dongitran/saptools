import process from "node:process";

import type { Command } from "commander";

import { resolveConfig } from "../config/index.js";
import { walkFolderTree } from "../diagnostics/tree.js";
import { validateLayout } from "../diagnostics/validate.js";
import { runWriteTest } from "../diagnostics/write-test.js";
import { listDrives } from "../graph/drives.js";
import { renderFolderTree, renderValidateResult, summarizeToken } from "../output/format.js";
import { openSession } from "../session/index.js";

import { selectDrive } from "./drive-selection.js";
import {
  addCommonOptions,
  parseDepth,
  toOverrides,
} from "./options.js";
import type { CheckFlags, CommonFlags, TreeFlags, ValidateFlags, WriteTestFlags } from "./options.js";

export function registerCommands(program: Command): void {
  registerTestCommand(program);
  registerDrivesCommand(program);
  registerTreeCommand(program);
  registerValidateCommand(program);
  registerWriteTestCommand(program);
  registerCheckCommand(program);
}

function registerTestCommand(program: Command): void {
  addCommonOptions(
    program.command("test").description("Acquire a token and resolve the target site"),
  ).action(handleTestCommand);
}

async function handleTestCommand(flags: CommonFlags): Promise<void> {
  const config = resolveConfig({ overrides: toOverrides(flags) });
  const session = await openSession(config.target);
  if (flags.json === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          token: {
            tokenType: session.token.tokenType,
            expiresOn: session.token.expiresOn,
            ...(session.token.scope === undefined ? {} : { scope: session.token.scope }),
          },
          claims: session.claims,
          site: session.site,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  process.stdout.write(`✔ Authenticated\n  ${summarizeToken(session.claims)}\n`);
  process.stdout.write(`✔ Site resolved: ${session.site.displayName} (${session.site.id})\n`);
  if (session.site.webUrl.length > 0) {
    process.stdout.write(`  ${session.site.webUrl}\n`);
  }
}

function registerDrivesCommand(program: Command): void {
  addCommonOptions(
    program.command("drives").description("List document libraries on the site"),
  ).action(handleDrivesCommand);
}

async function handleDrivesCommand(flags: CommonFlags): Promise<void> {
  const config = resolveConfig({ overrides: toOverrides(flags) });
  const session = await openSession(config.target);
  const drives = await listDrives(session.client, session.site.id);
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(drives, null, 2)}\n`);
    return;
  }
  if (drives.length === 0) {
    process.stdout.write("(no drives found)\n");
    return;
  }
  for (const drive of drives) {
    process.stdout.write(`- ${drive.name} [${drive.driveType}] (${drive.id})\n`);
  }
}

function registerTreeCommand(program: Command): void {
  addCommonOptions(program.command("tree").description("Walk the folder tree under the root"))
    .option("--drive <nameOrId>", "Drive name or ID (defaults to the first drive)")
    .option("--root <path>", "Root folder path to walk (overrides SHAREPOINT_ROOT_DIR)")
    .option("--depth <n>", "Maximum depth (default: 3)")
    .action(handleTreeCommand);
}

async function handleTreeCommand(flags: TreeFlags): Promise<void> {
  const config = resolveConfig({ overrides: toOverrides(flags) });
  const { drive, session } = await selectDrive(config.target, flags.drive);
  const depthValue = parseDepth(flags.depth);
  const tree = await walkFolderTree(session.client, {
    driveId: drive.id,
    rootPath: config.rootPath,
    ...(depthValue === undefined ? {} : { limits: { maxDepth: depthValue } }),
  });
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(tree, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Drive: ${drive.name}\n`);
  process.stdout.write(`${renderFolderTree(tree)}\n`);
}

function registerValidateCommand(program: Command): void {
  addCommonOptions(
    program.command("validate").description("Check expected root + subdirectories exist"),
  )
    .option("--drive <nameOrId>", "Drive name or ID")
    .option("--root <path>", "Root folder path (overrides SHAREPOINT_ROOT_DIR)")
    .option(
      "--subdirs <list>",
      "Comma-separated subdirectory names (overrides SHAREPOINT_SUBDIRS)",
    )
    .action(handleValidateCommand);
}

async function handleValidateCommand(flags: ValidateFlags): Promise<void> {
  const config = resolveConfig({ overrides: toOverrides(flags), requireRoot: true });
  const { drive, session } = await selectDrive(config.target, flags.drive);
  const result = await validateLayout(session.client, drive.id, {
    rootPath: config.rootPath,
    subdirectories: config.subdirectories,
  });
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`Drive: ${drive.name}\n`);
    process.stdout.write(`${renderValidateResult(result)}\n`);
  }
  if (!result.allPresent) {
    process.exitCode = 2;
  }
}

function registerWriteTestCommand(program: Command): void {
  addCommonOptions(
    program
      .command("write-test")
      .description("Create and delete a temporary folder to verify write access"),
  )
    .option("--drive <nameOrId>", "Drive name or ID")
    .option("--root <path>", "Root folder path under which to probe")
    .action(handleWriteTestCommand);
}

async function handleWriteTestCommand(flags: WriteTestFlags): Promise<void> {
  const config = resolveConfig({ overrides: toOverrides(flags), requireRoot: true });
  const { drive, session } = await selectDrive(config.target, flags.drive);
  const result = await runWriteTest(session.client, {
    driveId: drive.id,
    rootPath: config.rootPath,
  });
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.created && result.deleted) {
    process.stdout.write(`✔ Write + delete succeeded at ${result.probePath}\n`);
  } else if (result.created && !result.deleted) {
    process.stdout.write(
      `⚠ Created ${result.probePath} but failed to delete (item id: ${result.itemId ?? "?"})\n` +
        `  ${result.error ?? ""}\n`,
    );
  } else {
    process.stdout.write(`✘ Failed to create ${result.probePath}\n  ${result.error ?? ""}\n`);
  }
  if (!result.created || !result.deleted) {
    process.exitCode = 2;
  }
}

function registerCheckCommand(program: Command): void {
  addCommonOptions(
    program.command("check").description("Run test + drives + validate + write-test in one pass"),
  )
    .option("--drive <nameOrId>", "Drive name or ID")
    .option("--root <path>", "Root folder path")
    .option("--subdirs <list>", "Comma-separated subdirectory names")
    .action(handleCheckCommand);
}

async function handleCheckCommand(flags: CheckFlags): Promise<void> {
  const config = resolveConfig({ overrides: toOverrides(flags), requireRoot: true });
  const { drive, session, allDrives } = await selectDrive(config.target, flags.drive);
  process.stdout.write(`✔ Authenticated: ${summarizeToken(session.claims)}\n`);
  process.stdout.write(
    `✔ Site: ${session.site.displayName} — ${allDrives.length.toString()} drive(s) available\n`,
  );
  process.stdout.write(`✔ Using drive: ${drive.name}\n`);

  const layout = await validateLayout(session.client, drive.id, {
    rootPath: config.rootPath,
    subdirectories: config.subdirectories,
  });
  process.stdout.write(`${renderValidateResult(layout)}\n`);
  if (!layout.allPresent) {
    process.exitCode = 2;
    return;
  }

  const write = await runWriteTest(session.client, {
    driveId: drive.id,
    rootPath: config.rootPath,
  });
  if (write.created && write.deleted) {
    process.stdout.write(`✔ Write probe passed at ${write.probePath}\n`);
    return;
  }
  process.stdout.write(
    `✘ Write probe failed at ${write.probePath}: ${write.error ?? "unknown error"}\n`,
  );
  process.exitCode = 2;
}
