import type { Command } from "commander";

import { toRequestOptions, writeOutputWithOptionalHint } from "./cli-shared.js";
import { fetchJiraCurrentUserProfile } from "./current-user.js";
import { formatJiraCurrentUserProfile } from "./format.js";

interface WhoamiFlags {
  readonly json?: boolean;
}

export function addWhoamiCommand(program: Command): void {
  program
    .command("whoami")
    .description("Show the connected Jira account profile")
    .option("--json", "Print JSON output", false)
    .action(async (flags: WhoamiFlags): Promise<void> => {
      const requestOptions = await toRequestOptions(program);
      const profile = await fetchJiraCurrentUserProfile(requestOptions);
      await writeOutputWithOptionalHint(
        program,
        requestOptions.cloudId,
        flags.json === true ? profile : formatJiraCurrentUserProfile(profile),
        flags.json === true,
      );
    });
}
