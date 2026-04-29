export interface CfTarget {
  readonly region: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
}

export interface GenEnvOptions {
  readonly target: CfTarget;
  readonly outPath: string;
}

export interface ListOptions {
  readonly target: CfTarget;
  readonly remotePath: string;
}

export interface DownloadOptions {
  readonly target: CfTarget;
  readonly remotePath: string;
  readonly outPath: string;
}

export interface ListEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly permissions: string;
  readonly size: number;
}

export type DefaultEnv = Readonly<Record<string, unknown>>;

export const DEFAULT_APP_PATH = "/home/vcap/app";
