import { isSshEvent } from "./events.js";
import type { AuditEvent, SshSession, SshStatus } from "./types.js";

const SSH_AUTHORIZED_TYPE = "audit.app.ssh-authorized";
const SSH_DENIED_TYPE = "audit.app.ssh-unauthorized";

/**
 * Window after an `ssh-authorized` event during which the session is treated
 * as "likely active". Cloud Foundry emits no session-close event, so this is
 * a heuristic rather than a live-session check.
 */
const LIKELY_ACTIVE_WINDOW_MS = 60 * 60 * 1000;

function isWithinActiveWindow(timestamp: string, now: Date): boolean {
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) {
    return false;
  }
  const delta = now.getTime() - at;
  return delta >= 0 && delta <= LIKELY_ACTIVE_WINDOW_MS;
}

/** Infers SSH/debug sessions from `ssh-authorized` audit events. */
export function inferSshSessions(events: readonly AuditEvent[], now: Date): readonly SshSession[] {
  return events
    .filter((event) => event.type === SSH_AUTHORIZED_TYPE)
    .map((event) => ({
      actor: event.actor.name.length > 0 ? event.actor.name : event.actor.guid,
      authorizedAt: event.createdAt,
      likelyActive: isWithinActiveWindow(event.createdAt, now),
    }))
    .sort((left, right) => right.authorizedAt.localeCompare(left.authorizedAt));
}

export interface SshStatusInput {
  readonly appName: string;
  readonly sshEnabled: boolean;
  readonly sshReason: string;
  readonly events: readonly AuditEvent[];
  readonly now: Date;
}

export function buildSshStatus(input: SshStatusInput): SshStatus {
  const sshEvents = input.events.filter(isSshEvent);
  const sessions = inferSshSessions(sshEvents, input.now);
  const deniedAttempts = sshEvents
    .filter((event) => event.type === SSH_DENIED_TYPE)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return {
    appName: input.appName,
    sshEnabled: input.sshEnabled,
    sshReason: input.sshReason,
    sessions,
    deniedAttempts,
    activeSessionCount: sessions.filter((session) => session.likelyActive).length,
  };
}
