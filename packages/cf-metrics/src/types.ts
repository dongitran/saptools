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

export interface DashboardsCredential {
  readonly dashboardsEndpoint: string;
  readonly username: string;
  readonly password: string;
  /** Non-secret provenance, e.g. "service-key:mykey" or "minted:cf-metrics-ab12cd34". Safe to log. */
  readonly source: string;
}
