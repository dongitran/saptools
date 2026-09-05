import type { Command } from "commander";

import { DEFAULT_INDEX_PATTERN } from "../../config.js";
import { CfOtelError } from "../../errors.js";
import { lookUpField } from "../../mapping.js";
import type { FieldLookup } from "../../mapping.js";
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

/** `(varies)` rather than a blank: an empty cap reads as "no cap", the safe reading, while divergence is the hazardous one. */
const VARIES = "(varies)";

function fieldRow(name: string, mappingResponse: unknown): Record<string, string | number> {
  const lookup = lookUpField(mappingResponse, name);
  const found = lookup.status === "found" ? lookup.mapping : undefined;
  return {
    FIELD: name,
    // "ambiguous" rather than "unknown": in a listing the two look alike but
    // mean opposite things — one is unreadable, the other is a field whose
    // backing indices disagree about it.
    TYPE: found?.type ?? (lookup.status === "disagrees" ? "ambiguous" : "unknown"),
    IGNORE_ABOVE: found?.ignoreAboveVaries === true ? VARIES : (found?.ignoreAbove ?? ""),
    // A field alias reports the type of what it points at, since that is what
    // a query against it compares — naming the target keeps that honest, and
    // gives the reader the concrete path to use everywhere else.
    ALIAS_OF: found?.aliasVaries === true ? VARIES : (found?.aliasOf ?? ""),
  };
}

/** The error for a field with no single type, saying which of the two reasons it is. */
function lookupFailure(field: string, index: string, lookup: FieldLookup): CfOtelError {
  if (lookup.status === "disagrees") {
    return new CfOtelError(
      "MAPPING_LOOKUP_FAILED",
      `Field "${field}" is mapped inconsistently across the backing indices of ${index} ` +
        `(${lookup.types.join(", ")}), so no single type is safe to assume for a query spanning them. ` +
        "Narrow the query to one index, or use a field the indices agree on.",
    );
  }
  return new CfOtelError("MAPPING_LOOKUP_FAILED", `Field "${field}" was not found in the mapping for ${index}`);
}

async function runMapping(opts: MappingOpts): Promise<void> {
  const format = parseFormat(opts.format);
  await withOpenSearchClient(opts, async (client) => {
    const mappingResponse = await client.getMapping(opts.index);
    if (opts.field !== undefined) {
      const lookup = lookUpField(mappingResponse, opts.field);
      if (lookup.status !== "found") {
        throw lookupFailure(opts.field, opts.index, lookup);
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
