import type { HanaClient } from "./client.js";
import { CLI_NAME } from "./config.js";
import { QueryError, databaseCode, errorMessage } from "./errors.js";
import { loadCatalogObjectsWithCache, toMetadataCacheScope } from "./metadata-cache.js";
import {
  extractInvalidColumnNameFromError,
  extractMissingObjectName,
  extractMissingObjectNameFromError,
  formatColumnSuggestions,
  formatSuggestions,
  isInvalidCatalogObjectError,
  rankCatalogSuggestions,
  rankNameSuggestions,
} from "./suggestions.js";

async function loadSuggestionCatalogObjects(
  client: HanaClient,
  refresh: boolean,
): Promise<Awaited<ReturnType<HanaClient["listCatalogObjects"]>>> {
  try {
    return await loadCatalogObjectsWithCache(
      toMetadataCacheScope(client.info),
      refresh,
      async () => await client.listCatalogObjects(client.info.schema),
    );
  } catch {
    // A direct retry keeps transient cache I/O from hiding useful suggestions.
    return await client.listCatalogObjects(client.info.schema);
  }
}

function isLobSortOrGroupError(error: unknown): boolean {
  const code = databaseCode(error);
  if (code !== 266 && code !== 274) {
    return false;
  }
  return (
    error instanceof QueryError &&
    /LOB type is not allowed in (?:ORDER BY|GROUP BY) clause/i.test(error.message)
  );
}

function printLobSortOrGroupHint(): void {
  const lines = [
    `${CLI_NAME}: HANA cannot ORDER BY or GROUP BY NCLOB/CLOB/BLOB columns directly.`,
    `${CLI_NAME}: Remove the LOB column from ORDER BY/GROUP BY or wrap it as TO_VARCHAR(<column>).`,
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
}

function isInsufficientPrivilegeError(error: unknown): boolean {
  return databaseCode(error) === 258 || /\binsufficient privilege\b/i.test(errorMessage(error));
}

function printInsufficientPrivilegeHint(client: HanaClient, schema: string): void {
  const binding = client.info.bindingName ??
    (client.info.bindingIndex === undefined ? "unknown" : `#${String(client.info.bindingIndex)}`);
  const otherBindings = (client.info.availableBindingNames ?? []).filter(
    (name) => name !== client.info.bindingName,
  );
  const retryBinding = otherBindings[0];
  const lines = [
    `${CLI_NAME}: insufficient privilege for schema ${schema} as database user ` +
      `${client.databaseUser || "unknown"} (current binding: ${binding}).`,
  ];
  if (retryBinding !== undefined) {
    lines.push(
      `${CLI_NAME}: other HANA bindings on this app: ${otherBindings.join(", ")}; ` +
        `retry with --binding ${retryBinding}.`,
    );
  }
  lines.push(
    `${CLI_NAME}: try another app or full selector whose binding has the grant; ` +
      "no automatic retry was attempted.",
  );
  process.stderr.write(`${lines.join("\n")}\n`);
}

export function rethrowWithPrivilegeHint(
  error: unknown,
  client: HanaClient,
  schema: string,
): never {
  if (isInsufficientPrivilegeError(error)) {
    printInsufficientPrivilegeHint(client, schema);
  }
  throw error;
}

async function printColumnSuggestions(
  error: unknown,
  client: HanaClient,
  sql: string,
): Promise<void> {
  if (databaseCode(error) !== 260) {
    return;
  }
  const columnName = extractInvalidColumnNameFromError(error);
  const tableName = extractMissingObjectName(sql);
  if (columnName === undefined || tableName === undefined) {
    return;
  }

  try {
    const columns = await client.listColumns(
      tableName.schema ?? client.info.schema,
      tableName.name,
    );
    const text = formatColumnSuggestions(rankNameSuggestions(columnName, columns));
    if (text !== undefined) {
      process.stderr.write(`${text}\n`);
    }
  } catch {
    // Keep stderr focused on the original query failure without reliable metadata.
  }
}

async function printCatalogObjectSuggestions(
  error: unknown,
  client: HanaClient,
  sql: string,
  refresh: boolean,
): Promise<void> {
  if (!isInvalidCatalogObjectError(error)) {
    return;
  }
  const requested = extractMissingObjectNameFromError(error) ?? extractMissingObjectName(sql);
  if (requested === undefined) {
    return;
  }
  try {
    const objects = await loadSuggestionCatalogObjects(client, refresh);
    const text = formatSuggestions(rankCatalogSuggestions(requested, objects));
    if (text !== undefined) {
      process.stderr.write(`${text}\n`);
    }
  } catch {
    // Keep stderr focused on the original query failure without reliable metadata.
  }
}

export async function enrichAndRethrowQueryError(
  error: unknown,
  client: HanaClient,
  sql: string,
  refresh: boolean,
): Promise<never> {
  if (isInsufficientPrivilegeError(error)) {
    const schema = extractMissingObjectName(sql)?.schema ?? client.info.schema;
    printInsufficientPrivilegeHint(client, schema);
    throw error;
  }
  if (isLobSortOrGroupError(error)) {
    printLobSortOrGroupHint();
    throw error;
  }

  await printColumnSuggestions(error, client, sql);
  await printCatalogObjectSuggestions(error, client, sql, refresh);
  throw error;
}
