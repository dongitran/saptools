export interface CfTarget {
  readonly region: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
}

export const ARTIFACT_NAMES = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  ".cdsrc.json",
  "default-env.json",
  ".npmrc",
] as const;

export type ArtifactName = (typeof ARTIFACT_NAMES)[number];

export interface ExportArtifactsOptions {
  readonly target: CfTarget;
  readonly outDir: string;
  readonly remoteRoot?: string;
  /**
   * Subset of artifacts to export. When omitted or empty, all supported artifacts are attempted.
   */
  readonly artifacts?: readonly ArtifactName[];
}

export interface ExportArtifactsResult {
  readonly writtenFiles: readonly string[];
  readonly skipped: readonly string[];
}

export interface CfExecContext {
  readonly command?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sensitiveValues?: readonly string[];
}
