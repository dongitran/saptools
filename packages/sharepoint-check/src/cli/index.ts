import process from "node:process";

import { Command } from "commander";

import type { ConfigOverrides } from "../config/index.js";
import { resolveConfig } from "../config/index.js";
import { walkFolderTree } from "../diagnostics/tree.js";
import { validateLayout } from "../diagnostics/validate.js";
import { runWriteTest } from "../diagnostics/write-test.js";
import { listDrives } from "../graph/drives.js";
import { renderFolderTree, renderValidateResult, summarizeToken } from "../output/format.js";
import { openSession } from "../session/index.js";
import type { SharePointDrive, SharePointTarget } from "../types.js";

interface CommonFlags extends ConfigOverrides {
  readonly json?: boolean;
}

interface TreeFlags extends CommonFlags {
  readonly drive?: string;
  readonly depth?: string;
}

interface ValidateFlags extends CommonFlags {
  readonly drive?: string;
}

interface WriteTestFlags extends CommonFlags {
  readonly drive?: string;
}

function addCommonOptions(cmd: Command): Command {
  return cmd
    .option("--tenant <id>", "Azure AD tenant ID (overrides SHAREPOINT_TENANT_ID)")
    .option("--client-id <id>", "App registration client ID (overrides SHAREPOINT_CLIENT_ID)")
    .option(
      "--client-secret <secret>",
      "App registration client secret (overrides SHAREPOINT_CLIENT_SECRET)",
    )
    .option(
      "--site <ref>",
      "SharePoint site (e.g. contoso.sharepoint.com/sites/demo or full URL)",
    )
    .option("--json", "Emit JSON instead of human-readable output", false);
}

function toOverrides(flags: CommonFlags): ConfigOverrides {
  return {
    tenant: flags.tenant,
    clientId: flags.clientId,
    clientSecret: flags.clientSecret,
    site: flags.site,
    root: flags.root,
    subdirs: flags.subdirs,
  };
}

async function selectDrive(
  target: SharePointTarget,
  driveHint: string | undefined,
): Promise<{
  readonly drive: SharePointDrive;
  readonly session: Awaited<ReturnType<typeof openSession>>;
  readonly allDrives: readonly SharePointDrive[];
}> {
  const session = await openSession(target);
  const drives = await listDrives(session.client, session.site.id);
  if (drives.length === 0) {
    throw new Error(`Site "${session.site.displayName}" has no drives (document libraries)`);
  }

  if (driveHint === undefined || driveHint.length === 0) {
    const first = drives[0];
    if (first === undefined) {
      throw new Error("No drives available to pick from");
    }
    return { drive: first, session, allDrives: drives };
  }

  const match = drives.find((d) => d.id === driveHint || d.name === driveHint);
  if (!match) {
    throw new Error(
      `Drive "${driveHint}" not found on site "${session.site.displayName}". ` +
        `Available: ${drives.map((d) => d.name).join(", ")}`,
    );
  }
  return { drive: match, session, allDrives: drives };
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();

  program
    .name("saptools-sharepoint-check")
    .description(
      "Diagnose SharePoint access via Microsoft Graph: auth, drives, folder tree, layout, write probe",
    );

  addCommonOptions(
    program.command("test").description("Acquire a token and resolve the target site"),
  ).action(async (flags: CommonFlags): Promise<void> => {
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
  });

  addCommonOptions(
    program.command("drives").description("List document libraries on the site"),
  ).action(async (flags: CommonFlags): Promise<void> => {
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
  });

  addCommonOptions(program.command("tree").description("Walk the folder tree under the root"))
    .option("--drive <nameOrId>", "Drive name or ID (defaults to the first drive)")
    .option("--root <path>", "Root folder path to walk (overrides SHAREPOINT_ROOT_DIR)")
    .option("--depth <n>", "Maximum depth (default: 3)")
    .action(async (flags: TreeFlags): Promise<void> => {
      const config = resolveConfig({ overrides: toOverrides(flags) });
      const { drive, session } = await selectDrive(config.target, flags.drive);
      const rawDepth = flags.depth;
      let depthValue: number | undefined;
      if (rawDepth !== undefined && rawDepth.length > 0) {
        const parsed = Number.parseInt(rawDepth, 10);
        if (!Number.isFinite(parsed)) {
          throw new Error(`Invalid --depth "${rawDepth}"`);
        }
        depthValue = parsed;
      }
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
    });

  addCommonOptions(
    program.command("validate").description("Check expected root + subdirectories exist"),
  )
    .option("--drive <nameOrId>", "Drive name or ID")
    .option("--root <path>", "Root folder path (overrides SHAREPOINT_ROOT_DIR)")
    .option(
      "--subdirs <list>",
      "Comma-separated subdirectory names (overrides SHAREPOINT_SUBDIRS)",
    )
    .action(async (flags: ValidateFlags): Promise<void> => {
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
    });

  addCommonOptions(
    program
      .command("write-test")
      .description("Create and delete a temporary folder to verify write access"),
  )
    .option("--drive <nameOrId>", "Drive name or ID")
    .option("--root <path>", "Root folder path under which to probe")
    .action(async (flags: WriteTestFlags): Promise<void> => {
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
    });

  addCommonOptions(
    program.command("check").description("Run test + drives + validate + write-test in one pass"),
  )
    .option("--drive <nameOrId>", "Drive name or ID")
    .option("--root <path>", "Root folder path")
    .option("--subdirs <list>", "Comma-separated subdirectory names")
    .action(async (flags: ValidateFlags & { readonly subdirs?: string }): Promise<void> => {
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
      } else {
        process.stdout.write(
          `✘ Write probe failed at ${write.probePath}: ${write.error ?? "unknown error"}\n`,
        );
        process.exitCode = 2;
      }
    });

  await program.parseAsync([...argv]);
}

try {
  await main(process.argv);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}
