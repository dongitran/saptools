import type { Command } from "commander";

import { DEFAULT_INDEX_PATTERN } from "../../config.js";
import { CfOtelError } from "../../errors.js";
import { findFieldInMapping } from "../../mapping.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { MappingOpts } from "../commandTypes.js";
import { emitRows, parseFormat } from "../output.js";
import { withCredentialOptions, withFormatOption, withSaveOption, withTargetOptions } from "../shared-options.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listAllFieldNames(mappingResponse: unknown): readonly string[] {
  const names = new Set<string>();
  if (!isRecord(mappingResponse)) {
    return [];
  }
  for (const indexEntry of Object.values(mappingResponse)) {
    if (!isRecord(indexEntry)) {
      continue;
    }
    const mappings = indexEntry["mappings"];
    const properties = isRecord(mappings) ? mappings["properties"] : undefined;
    if (!isRecord(properties)) {
      continue;
    }
    for (const name of Object.keys(properties)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

function fieldRow(name: string, mappingResponse: unknown): Record<string, string | number> {
  const found = findFieldInMapping(mappingResponse, name);
  return { FIELD: name, TYPE: found?.type ?? "unknown", IGNORE_ABOVE: found?.ignoreAbove ?? "" };
}

async function runMapping(opts: MappingOpts): Promise<void> {
  const format = parseFormat(opts.format);
  await withOpenSearchClient(opts, async (client) => {
    const mappingResponse = await client.getMapping(opts.index);
    if (opts.field !== undefined) {
      if (findFieldInMapping(mappingResponse, opts.field) === undefined) {
        throw new CfOtelError(
          "MAPPING_LOOKUP_FAILED",
          `Field "${opts.field}" was not found in the mapping for ${opts.index}`,
        );
      }
      await emitRows({ command: "mapping", format, save: opts.save, rows: [fieldRow(opts.field, mappingResponse)] });
      return;
    }
    await emitRows({
      command: "mapping",
      format,
      save: opts.save,
      rows: listAllFieldNames(mappingResponse).map((name) => fieldRow(name, mappingResponse)),
    });
  });
}

export function registerMappingCommand(program: Command): void {
  const command = program
    .command("mapping")
    .description("field-type discovery — check keyword vs. text before aggregating on any field")
    .option("--index <pattern>", "index pattern to inspect", DEFAULT_INDEX_PATTERN)
    .option("--field <name>", "show just one field's mapped type (omit to list all)");
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async () => {
    await runMapping(command.opts<MappingOpts>());
  });
}
