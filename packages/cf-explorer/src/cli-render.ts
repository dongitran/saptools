import process from "node:process";

export function writeOutput(value: unknown, json = true): void {
  process.stdout.write(formatOutput(value, json));
}

export function formatOutput(value: unknown, json = true): string {
  if (json) {
    return `${JSON.stringify(value, null, 2)}\n`;
  }
  return formatHumanOutput(value);
}

function formatHumanOutput(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return `${String(value)}\n`;
  }
  const text = renderHuman(value as Record<string, unknown>);
  if (text === undefined) {
    return `${JSON.stringify(value, null, 2)}\n`;
  }
  return text.endsWith("\n") ? text : `${text}\n`;
}

function renderHuman(value: Record<string, unknown>): string | undefined {
  if (Array.isArray(value["lines"]) && typeof value["file"] === "string") {
    return renderViewResult(value);
  }
  if (Array.isArray(value["roots"]) && Array.isArray(value["suggestedBreakpoints"])) {
    return renderInspectResult(value);
  }
  if (Array.isArray(value["entries"]) && typeof value["path"] === "string") {
    return renderLsResult(value);
  }
  if (Array.isArray(value["roots"])) {
    return renderRootsResult(value);
  }
  if (Array.isArray(value["instances"]) && (value["instances"] as readonly unknown[]).every(isInstanceInfoLike)) {
    return renderInstancesResult(value);
  }
  if (Array.isArray(value["matches"])) {
    return renderMatchesResult(value);
  }
  if (Array.isArray(value["sessions"])) {
    return renderSessionList(value);
  }
  if (typeof value["sessionId"] === "string" && typeof value["status"] === "string" && "brokerAlive" in value) {
    return renderSessionStatus(value);
  }
  if (typeof value["status"] === "string" && typeof value["message"] === "string" && "changed" in value) {
    return renderLifecycleResult(value);
  }
  if (typeof value["sessionId"] === "string" && typeof value["status"] === "string") {
    return renderSessionRecord(value);
  }
  return undefined;
}

function isInstanceInfoLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate["index"] === "number" && typeof candidate["state"] === "string";
}

function renderRootsResult(value: Record<string, unknown>): string {
  const roots = value["roots"] as readonly string[];
  if (roots.length === 0) {
    return "No roots discovered.";
  }
  return roots.join("\n");
}

function renderInstancesResult(value: Record<string, unknown>): string {
  const instances = value["instances"] as readonly { index: number; state: string; since?: string }[];
  if (instances.length === 0) {
    return "No instances reported.";
  }
  return instances
    .map((item) => `#${item.index.toString()}\t${item.state}${item.since === undefined ? "" : `\t${item.since}`}`)
    .join("\n");
}

function renderLsResult(value: Record<string, unknown>): string {
  const entries = value["entries"] as readonly Record<string, unknown>[];
  if (entries.length === 0) {
    return "No entries.";
  }
  return entries
    .map((entry) => {
      const kind = typeof entry["kind"] === "string" ? entry["kind"] : "unknown";
      const name = typeof entry["name"] === "string" ? entry["name"] : "";
      const path = typeof entry["path"] === "string" ? entry["path"] : "";
      const instance = entry["instance"];
      const instancePrefix = typeof instance === "number" ? `#${instance.toString()}\t` : "";
      return `${instancePrefix}[${kind}]\t${name}\t${path}`;
    })
    .join("\n");
}

function renderMatchesResult(value: Record<string, unknown>): string {
  const matches = value["matches"] as readonly Record<string, unknown>[];
  if (matches.length === 0) {
    return "No matches.";
  }
  return matches
    .map((match) => {
      const path = typeof match["path"] === "string" ? match["path"] : "";
      const line = match["line"];
      const kind = match["kind"];
      const preview = match["preview"];
      const tag = typeof kind === "string" ? `[${kind}]` : typeof line === "number" ? `:${line.toString()}` : "";
      const previewText = typeof preview === "string" && preview.length > 0 ? `\t${preview}` : "";
      const instance = match["instance"];
      const instancePrefix = typeof instance === "number" ? `#${instance.toString()}\t` : "";
      return `${instancePrefix}${path}${tag}${previewText}`;
    })
    .join("\n");
}

function renderViewResult(value: Record<string, unknown>): string {
  const file = String(value["file"]);
  const lines = value["lines"] as readonly { line: number; text: string }[];
  const header = `# ${file}`;
  const body = lines.map((line) => `${line.line.toString().padStart(5, " ")}  ${line.text}`);
  return [header, ...body].join("\n");
}

function renderInspectResult(value: Record<string, unknown>): string {
  const sections: string[] = [];
  const roots = value["roots"] as readonly string[];
  if (roots.length > 0) {
    sections.push(`Roots:\n${roots.map((root) => `  ${root}`).join("\n")}`);
  }
  const matches = value["contentMatches"] as readonly { path: string; line: number }[];
  if (matches.length > 0) {
    sections.push(`Matches:\n${matches.map((match) => `  ${match.path}:${match.line.toString()}`).join("\n")}`);
  }
  const breakpoints = value["suggestedBreakpoints"] as readonly { bp: string; line: number; confidence: string }[];
  if (breakpoints.length > 0) {
    sections.push(`Suggested breakpoints:\n${breakpoints.map((bp) => `  [${bp.confidence}] ${bp.bp}:${bp.line.toString()}`).join("\n")}`);
  }
  return sections.length === 0 ? "No candidates discovered." : sections.join("\n\n");
}

function renderLifecycleResult(value: Record<string, unknown>): string {
  return `${String(value["status"])}: ${String(value["message"])}`;
}

function renderSessionList(value: Record<string, unknown>): string {
  const sessions = value["sessions"] as readonly Record<string, unknown>[];
  if (sessions.length === 0) {
    return "No persistent sessions.";
  }
  return sessions
    .map((session) => {
      const target = session["target"] as { app?: string } | undefined;
      const appName = typeof target?.app === "string" ? target.app : "?";
      return `${String(session["sessionId"])}\t${String(session["status"])}\t${appName}`;
    })
    .join("\n");
}

function renderSessionStatus(value: Record<string, unknown>): string {
  return [
    `sessionId: ${String(value["sessionId"])}`,
    `status: ${String(value["status"])}`,
    `brokerAlive: ${String(value["brokerAlive"])}`,
    `sshAlive: ${String(value["sshAlive"])}`,
    `socketAlive: ${String(value["socketAlive"])}`,
  ].join("\n");
}

function renderSessionRecord(value: Record<string, unknown>): string {
  return [
    `sessionId: ${String(value["sessionId"])}`,
    `status: ${String(value["status"])}`,
    `brokerPid: ${String(value["brokerPid"])}`,
    `socketPath: ${String(value["socketPath"])}`,
  ].join("\n");
}
