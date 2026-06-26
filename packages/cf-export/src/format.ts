

export function formatExportCompletionMessage(
  appName: string,
  writtenFiles: readonly string[],
  skipped: readonly string[],
): string {
  const names = writtenFiles.map((p) => {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] ?? p;
  });

  const base = `Export completed for "${appName}".`;
  if (names.length === 0) {
    return `${base} No files written.`;
  }

  const filesPart = `${String(names.length)} file${names.length === 1 ? "" : "s"}: ${names.join(", ")}`;
  if (skipped.length === 0) {
    return `${base} ${filesPart}.`;
  }
  const skipPart = `Skipped: ${skipped.join(", ")}`;
  return `${base} ${filesPart}. ${skipPart}.`;
}
