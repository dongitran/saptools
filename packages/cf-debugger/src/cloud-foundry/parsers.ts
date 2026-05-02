export function parseAppNames(stdout: string): readonly string[] {
  const apps: string[] = [];
  let pastHeader = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!pastHeader) {
      if (trimmed.startsWith("name")) {
        pastHeader = true;
      }
      continue;
    }
    if (trimmed.length === 0) {
      continue;
    }
    const first = trimmed.split(/\s+/)[0];
    if (first !== undefined && first.length > 0) {
      apps.push(first);
    }
  }
  return apps;
}

export function parseNameTable(stdout: string): readonly string[] {
  const lines = stdout.split("\n");
  const headerIdx = lines.findIndex((l) => l.trim() === "name");
  if (headerIdx === -1) {
    return [];
  }
  return lines
    .slice(headerIdx + 1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}
