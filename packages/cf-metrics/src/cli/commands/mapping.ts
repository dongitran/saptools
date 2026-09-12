import type { Command } from "commander";

import { DEFAULT_INDEX_PATTERN } from "../../config.js";
import { CfMetricsError } from "../../errors.js";
import { listAllFieldNames, lookUpField } from "../../mapping.js";
import type { FieldLookup, FieldMapping } from "../../mapping.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { MappingOpts } from "../commandTypes.js";
import { emitRows, parseFormat } from "../output.js";
import { withCredentialOptions, withFormatOption, withSaveOption, withTargetOptions } from "../shared-options.js";

/** `(varies)` rather than a blank: an empty cell reads as "none", the safe reading, while divergence is the hazardous one. */
const VARIES = "(varies)";

function ignoreAboveCell(mapping: FieldMapping): string | number {
  return mapping.ignoreAboveVaries === true ? VARIES : (mapping.ignoreAbove ?? "");
}

function aliasCell(mapping: FieldMapping): string {
  return mapping.aliasVaries === true ? VARIES : (mapping.aliasOf ?? "");
}

/** Where a field sits inside a `nested` parent — blank means a plain filter reaches it directly. */
function nestedCell(mapping: FieldMapping): string {
  return mapping.nestedVaries === true ? VARIES : (mapping.nestedUnder ?? "");
}

function fieldRow(name: string, mappingResponse: unknown): Record<string, string | number> {
  const lookup = lookUpField(mappingResponse, name);
  // "ambiguous" rather than "unknown": in a listing the two look alike but mean
  // opposite things — one is a field this version could not read, the other is
  // a field whose backing indices disagree about.
  const type = lookup.status === "found" ? lookup.mapping.type : lookup.status === "disagrees" ? "ambiguous" : "unknown";
  return {
    FIELD: name,
    TYPE: type,
    IGNORE_ABOVE: lookup.status === "found" ? ignoreAboveCell(lookup.mapping) : "",
    // A field alias reports the type of what it points at, since that is what a
    // query against it compares — naming the target keeps that honest, and
    // hands the reader the concrete path to use everywhere else.
    ALIAS_OF: lookup.status === "found" ? aliasCell(lookup.mapping) : "",
    // A field inside a `nested` parent is stored as a separate hidden document:
    // a plain filter or aggregation on it matches nothing and reports no error
    // (measured live). Listing it without saying so would advertise a dead end.
    NESTED_IN: lookup.status === "found" ? nestedCell(lookup.mapping) : "",
  };
}

/** The error for a field with no single answer, saying which of the two reasons it is. */
function lookupFailure(field: string, index: string, lookup: FieldLookup): CfMetricsError {
  if (lookup.status === "disagrees") {
    return new CfMetricsError(
      "MAPPING_LOOKUP_FAILED",
      `Field "${field}" is mapped inconsistently across the backing indices of ${index} ` +
        `(${lookup.types.join(", ")}), so no single type is safe to assume for a query spanning them. ` +
        "Narrow the query to one index, or use a field the indices agree on.",
    );
  }
  return new CfMetricsError("MAPPING_LOOKUP_FAILED", `Field "${field}" was not found in the mapping for ${index}`);
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
