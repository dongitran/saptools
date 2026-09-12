export interface CfExecContext {
  readonly command?: string;
}

export interface CurrentCfTarget {
  readonly apiEndpoint: string;
  readonly regionKey?: string;
  readonly orgName: string;
  readonly spaceName: string;
}

/**
 * Everything the cloud-logging modules need from a package's own `cf.ts`.
 * Each consumer (cf-otel, cf-metrics, cf-log-search) builds one of these as a
 * thin adapter over its existing `cf.ts` — the only seam between
 * `packages/core` and package-specific CF invocation, so core never assumes a
 * particular region table or process-spawning strategy. Unifying `cf.ts`
 * itself across every @saptools package is a separate, larger, not-yet
 * approved project (it would touch cf-sync, cf-logs, cf-tail, cf-hana,
 * cf-events, cf-explorer and more) — this interface deliberately keeps this
 * extraction scoped to Cloud-Logging access only.
 */
export interface CloudLoggingCfExecutor {
  readonly ambientContext: CfExecContext;
  cfCurl(path: string, ctx: CfExecContext): Promise<string>;
  cfServiceGuid(name: string, ctx: CfExecContext): Promise<string>;
  cfSpaceGuid(name: string, ctx: CfExecContext): Promise<string>;
  isCfAuthFailure(error: unknown): boolean;
  withCfSession<T>(work: (ctx: CfExecContext) => Promise<T>): Promise<T>;
  cfApi(apiEndpoint: string, ctx: CfExecContext): Promise<void>;
  cfAuth(email: string, password: string, ctx: CfExecContext): Promise<void>;
  cfTargetSpace(org: string, space: string, ctx: CfExecContext): Promise<void>;
  readCurrentCfTarget(): Promise<CurrentCfTarget | undefined>;
  getApiEndpointForRegion(region: string): string | undefined;
}

export type SelectorSource = "explicit" | "ambient";

export interface ResolvedTarget {
  readonly apiEndpoint: string;
  readonly region: string;
  readonly org: string;
  readonly space: string;
  readonly selectorSource: SelectorSource;
  /** False when an ambient region key could not be mapped back to a known API endpoint. */
  readonly regionConfirmed: boolean;
}

/** The credential fields a service-key or binding payload carries, before discovery attributes them to an instance. */
export interface DashboardsCredentialPayload {
  readonly dashboardsEndpoint: string;
  readonly username: string;
  readonly password: string;
  /** Non-secret provenance, e.g. "service-key:mykey" or "minted:cf-otel-ab12cd34". Safe to log. */
  readonly source: string;
}

export interface DashboardsCredential extends DashboardsCredentialPayload {
  /** Name of the Cloud Logging service instance the credential belongs to. Non-secret. */
  readonly instance: string;
}

/** One Cloud Logging service instance, with the GUID the v3 API addresses it by. */
export interface CloudLoggingInstance {
  readonly name: string;
  readonly guid: string;
}
