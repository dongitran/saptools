export type OutputFormat = "table" | "json" | "json-compact" | "csv";

/** The subset of a raw `logs-cfsyslog-*` `_source` document this package reads. Untyped beyond what is used — the real documents carry ~200 distinct fields across all generations (verified live), most app-specific and not modeled here. */
export type RawLogSource = Readonly<Record<string, unknown>>;

export interface LogRow {
  readonly id: string;
  readonly timestamp: string;
  readonly sourceType: string;
  readonly appName: string;
  readonly appId: string;
  readonly spaceName: string;
  readonly orgName: string;
  /** "" on RTR documents — they carry no `level` field. */
  readonly level: string;
  readonly logger: string;
  /** `msg` on APP-log documents; a synthesized "METHOD PATH -> STATUS (latency)" summary on RTR documents (which carry no `msg` field at all — verified live). */
  readonly message: string;
  readonly correlationId: string;
  readonly vcapRequestId: string;
  /** Only ever set via {@link resolveTraceId} — empty string, never a misattributed value, on any non-RTR document. */
  readonly traceId: string;
  readonly spanId: string;
  /** RTR-only fields below; empty string / undefined on every other source_type. */
  readonly method: string;
  readonly path: string;
  readonly responseStatus: number | undefined;
  readonly responseTimeMs: number | undefined;
}
