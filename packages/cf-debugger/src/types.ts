export interface SessionKey {
  readonly region: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
}

export type SessionStatus =
  | "starting"
  | "logging-in"
  | "targeting"
  | "ssh-enabling"
  | "ssh-restarting"
  | "signaling"
  | "tunneling"
  | "ready"
  | "stopping"
  | "stopped"
  | "error";

export interface ActiveSession extends SessionKey {
  readonly sessionId: string;
  readonly pid: number;
  readonly hostname: string;
  readonly localPort: number;
  readonly remotePort: number;
  readonly apiEndpoint: string;
  readonly cfHomeDir: string;
  readonly startedAt: string;
  readonly status: SessionStatus;
  readonly message?: string;
}

export interface StartDebuggerOptions extends SessionKey {
  readonly email?: string;
  readonly password?: string;
  readonly apiEndpoint?: string;
  readonly preferredPort?: number;
  readonly tunnelReadyTimeoutMs?: number;
  readonly verbose?: boolean;
  readonly onStatus?: (status: SessionStatus, message?: string) => void;
  readonly signal?: AbortSignal;
}

export interface DebuggerHandle {
  readonly session: ActiveSession;
  dispose(): Promise<void>;
  waitForExit(): Promise<number | null>;
}

export interface StateFile {
  readonly version: "1";
  readonly sessions: readonly ActiveSession[];
}

export class CfDebuggerError extends Error {
  public readonly code: string;
  public readonly stderr?: string;

  public constructor(code: string, message: string, stderr?: string) {
    super(message);
    this.name = "CfDebuggerError";
    this.code = code;
    if (stderr !== undefined) {
      this.stderr = stderr;
    }
  }
}
