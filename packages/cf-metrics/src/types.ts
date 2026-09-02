/** Output rendering for CLI results. */
export type OutputFormat = "table" | "json" | "json-compact" | "csv";

/** Whether region/org/space was pinned by the caller or inherited from `cf target`. */
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
  /** Non-secret provenance, e.g. "service-key:mykey" or "minted:cf-metrics-ab12cd34". Safe to log. */
  readonly source: string;
}

export interface DashboardsCredential extends DashboardsCredentialPayload {
  /** Name of the Cloud Logging service instance the credential belongs to. Non-secret. */
  readonly instance: string;
}
