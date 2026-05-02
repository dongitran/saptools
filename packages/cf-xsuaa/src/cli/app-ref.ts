import process from "node:process";

import type { Command } from "commander";

import type { AppRef } from "../types.js";

export interface AppRefOptions {
  region?: string;
  org?: string;
  space?: string;
  app?: string;
}

export function toAppRef(opts: AppRefOptions): AppRef {
  const { region, org, space, app } = opts;
  if (!region || !org || !space || !app) {
    process.stderr.write("Error: --region, --org, --space, --app are all required\n");
    process.exit(1);
  }
  return { region, org, space, app };
}

export function addAppRefOptions(cmd: Command): Command {
  return cmd
    .requiredOption("-r, --region <key>", "CF region key (e.g. ap10)")
    .requiredOption("-o, --org <name>", "CF org name")
    .requiredOption("-s, --space <name>", "CF space name")
    .requiredOption("-a, --app <name>", "CF app name");
}
