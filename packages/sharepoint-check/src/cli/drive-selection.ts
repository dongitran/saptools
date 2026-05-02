import { listDrives } from "../graph/drives.js";
import type { SharePointSession } from "../session/index.js";
import { openSession } from "../session/index.js";
import type { SharePointDrive, SharePointTarget } from "../types.js";

export interface SelectedDrive {
  readonly drive: SharePointDrive;
  readonly session: SharePointSession;
  readonly allDrives: readonly SharePointDrive[];
}

export async function selectDrive(
  target: SharePointTarget,
  driveHint: string | undefined,
): Promise<SelectedDrive> {
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
