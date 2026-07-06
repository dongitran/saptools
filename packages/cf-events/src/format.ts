import type { AppHealth, AuditEvent, CrashReportSummary, CrashSummary, ProcessInstanceStat, SpaceCrashSummary, SshStatus } from "./types.js";

const EVENT_LABELS: Readonly<Record<string, string>> = {
  "audit.app.create": "App created",
  "audit.app.update": "App updated",
  "audit.app.delete-request": "App delete requested",
  "audit.app.start": "App started",
  "audit.app.stop": "App stopped",
  "audit.app.restage": "App restaged",
  "audit.app.ssh-authorized": "SSH session authorized",
  "audit.app.ssh-unauthorized": "SSH attempt denied",
  "audit.app.crash": "App crashed",
  "audit.app.process.create": "Process created",
  "audit.app.process.scale": "Process scaled",
  "audit.app.process.update": "Process updated",
  "audit.app.process.crash": "Process crashed",
  "audit.app.process.terminate_instance": "Instance terminated",
  "audit.app.map-route": "Route mapped",
  "audit.app.unmap-route": "Route unmapped",
  "audit.app.environment_variables.show": "Env variables viewed",
};

export function describeEventType(type: string): string {
  return EVENT_LABELS[type] ?? type;
}

export function formatUptime(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) {
    return "-";
  }
  const totalMinutes = Math.floor(seconds / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days.toString()}d`);
  }
  if (hours > 0) {
    parts.push(`${hours.toString()}h`);
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes.toString()}m`);
  }
  return parts.join(" ");
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes < 0) {
    return "-";
  }
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex] ?? "B"}`;
}

export function formatCpu(cpu: number | undefined): string {
  if (cpu === undefined) {
    return "-";
  }
  return `${(cpu * 100).toFixed(1)}%`;
}

export function formatRelativeTime(timestamp: string, now: Date): string {
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) {
    return "unknown";
  }
  const deltaMs = now.getTime() - at;
  if (deltaMs < 60_000) {
    return "just now";
  }
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) {
    return `${minutes.toString()}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours.toString()}h ago`;
  }
  return `${Math.floor(hours / 24).toString()}d ago`;
}

export function formatEventLine(event: AuditEvent, now: Date): string {
  const actor = event.actor.name.length > 0 ? event.actor.name : event.actor.type;
  return [
    `  ${event.createdAt.padEnd(26)}`,
    formatRelativeTime(event.createdAt, now).padEnd(11),
    describeEventType(event.type).padEnd(24),
    actor.length > 0 ? actor : "(unknown actor)",
  ].join("  ");
}

export function formatEventsReport(
  appName: string,
  events: readonly AuditEvent[],
  now: Date,
): string {
  if (events.length === 0) {
    return `No audit events found for ${appName}.`;
  }
  return [
    `Audit events for ${appName} (${events.length.toString()}):`,
    ...events.map((event) => formatEventLine(event, now)),
  ].join("\n");
}


function eventTargetLabel(event: AuditEvent): string {
  if (event.target.name.length > 0) {
    return event.target.name;
  }
  if (event.target.type.length > 0) {
    return event.target.type;
  }
  return event.target.guid.length > 0 ? event.target.guid : "(unknown target)";
}

export function formatSpaceEventLine(event: AuditEvent, now: Date): string {
  const actor = event.actor.name.length > 0 ? event.actor.name : event.actor.type;
  return [
    `  ${event.createdAt.padEnd(26)}`,
    formatRelativeTime(event.createdAt, now).padEnd(11),
    describeEventType(event.type).padEnd(24),
    eventTargetLabel(event).padEnd(18),
    actor.length > 0 ? actor : "(unknown actor)",
  ].join("  ");
}

export function formatSpaceEventsReport(
  selector: string,
  events: readonly AuditEvent[],
  now: Date,
): string {
  if (events.length === 0) {
    return `No audit events found for space ${selector}.`;
  }
  return [
    `Audit events for space ${selector} (${events.length.toString()}):`,
    ...events.map((event) => formatSpaceEventLine(event, now)),
  ].join("\n");
}

export function formatSshStatusReport(status: SshStatus, now: Date): string {
  const sessionLines = status.sessions.map((session) => {
    const tag = session.likelyActive ? "[active]" : "[past]  ";
    const when = formatRelativeTime(session.authorizedAt, now);
    return `    ${tag}  ${session.actor.padEnd(30)}  authorized ${session.authorizedAt} (${when})`;
  });
  const deniedLines = status.deniedAttempts.map((attempt) => {
    const actor = attempt.actor.name.length > 0 ? attempt.actor.name : attempt.actor.type;
    return `    ${actor.padEnd(30)}  ${attempt.createdAt}`;
  });

  return [
    `SSH status for ${status.appName}`,
    "",
    `  SSH enabled:            ${status.sshEnabled ? "yes" : "no"}`,
    ...(!status.sshEnabled && status.sshReason.length > 0
      ? [`  Disabled reason:        ${status.sshReason}`]
      : []),
    `  Recent SSH sessions:    ${status.sessions.length.toString()}`,
    `  Likely active sessions: ${status.activeSessionCount.toString()}`,
    ...(sessionLines.length > 0 ? ["", "  Sessions:", ...sessionLines] : []),
    ...(deniedLines.length > 0
      ? ["", `  Denied SSH attempts: ${status.deniedAttempts.length.toString()}`, ...deniedLines]
      : []),
    "",
    '  Note: Cloud Foundry exposes no live-session API; "likely active" sessions',
    "  are inferred from recent ssh-authorized audit events.",
  ].join("\n");
}

function formatAppCrashReport(summary: CrashSummary, now: Date): string {
  if (summary.crashCount === 0) {
    return `No crashes found for ${summary.appName}.`;
  }
  const crashLines = summary.crashes.map((crash) => {
    const index = crash.index === undefined ? "-" : `#${crash.index.toString()}`;
    const reason = crash.reason ?? "unknown";
    const exit = crash.exitStatus === undefined ? "" : `  exit ${crash.exitStatus.toString()}`;
    return `    ${crash.at}  instance ${index}  ${reason}${exit}`;
  });

  return [
    `Crash report for ${summary.appName}`,
    "",
    `  Crashes: ${summary.crashCount.toString()}`,
    ...(summary.lastCrashAt === undefined
      ? []
      : [`  Last crash: ${summary.lastCrashAt} (${formatRelativeTime(summary.lastCrashAt, now)})`]),
    ...(summary.lastCrashReason === undefined ? [] : [`  Last reason: ${summary.lastCrashReason}`]),
    "",
    "  Recent crashes:",
    ...crashLines,
  ].join("\n");
}

function formatSpaceCrashReport(summary: SpaceCrashSummary, now: Date): string {
  if (summary.crashCount === 0) {
    return `No crashes found for space ${summary.selector}.`;
  }
  const appLines = summary.apps.flatMap((app) => [
    `  ${app.appName} (${app.crashCount.toString()})`,
    ...app.crashes.map((crash) => {
      const index = crash.index === undefined ? "-" : `#${crash.index.toString()}`;
      const reason = crash.reason ?? "unknown";
      const exit = crash.exitStatus === undefined ? "" : `  exit ${crash.exitStatus.toString()}`;
      return `    ${crash.at}  instance ${index}  ${reason}${exit}`;
    }),
  ]);
  return [
    `Crash report for space ${summary.selector}`,
    "",
    `  Crashes: ${summary.crashCount.toString()}`,
    `  Apps affected: ${summary.apps.length.toString()}`,
    ...(summary.lastCrashAt === undefined
      ? []
      : [`  Last crash: ${summary.lastCrashAt} (${formatRelativeTime(summary.lastCrashAt, now)})`]),
    "",
    ...appLines,
  ].join("\n");
}

export function formatCrashReport(summary: CrashReportSummary, now: Date): string {
  if ("scope" in summary) {
    return formatSpaceCrashReport(summary, now);
  }
  return formatAppCrashReport(summary, now);
}

function formatInstanceLine(instance: ProcessInstanceStat): string {
  return [
    `  #${instance.index.toString()}`.padEnd(6),
    instance.state.padEnd(10),
    `up ${formatUptime(instance.uptimeSeconds)}`.padEnd(16),
    `cpu ${formatCpu(instance.cpu)}`.padEnd(13),
    `mem ${formatBytes(instance.memBytes)} / ${formatBytes(instance.memQuotaBytes)}`,
  ].join("  ");
}

export function formatStatusReport(health: AppHealth, now: Date): string {
  const lastEventLine =
    health.lastEvent === undefined
      ? "  Last event: (none)"
      : `  Last event: ${describeEventType(health.lastEvent.type)} - ${health.lastEvent.createdAt} ` +
        `(${formatRelativeTime(health.lastEvent.createdAt, now)})`;

  return [
    `App status: ${health.appName}`,
    "",
    `  GUID:            ${health.appGuid}`,
    `  Requested state: ${health.requestedState.length > 0 ? health.requestedState : "unknown"}`,
    `  SSH enabled:     ${health.sshEnabled ? "yes" : "no"}`,
    `  Instances:       ${health.instances.length.toString()}`,
    ...(health.instances.length > 0
      ? ["", ...health.instances.map((instance) => formatInstanceLine(instance))]
      : []),
    "",
    lastEventLine,
  ].join("\n");
}
