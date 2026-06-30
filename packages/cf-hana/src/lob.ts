/** HANA column types whose Buffer values represent text rather than binary bytes. */
const TEXT_LOB_TYPES = new Set(["CLOB", "NCLOB"]);

function normalizeTypeName(typeName: string | undefined): string {
  return typeName?.trim().toUpperCase() ?? "";
}

export function isTextLobType(typeName: string | undefined): boolean {
  return TEXT_LOB_TYPES.has(normalizeTypeName(typeName));
}
