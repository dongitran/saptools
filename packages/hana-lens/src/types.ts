export const CACHE_FILE_NAME = ".hana-lens-cache.json";
export const PACKAGE_ANNOTATION = "@hanaLens.packageName";

export interface HanaLensElement {
  readonly type?: string;
  readonly length?: number;
  readonly key?: boolean;
  readonly target?: string;
  readonly "@Core.Computed"?: boolean;
  readonly on?: readonly unknown[];
  readonly enum?: Readonly<Record<string, unknown>>;
  readonly [key: `@${string}`]: unknown;
}

export interface HanaLensDefinition {
  readonly kind?: string;
  readonly elements?: Readonly<Record<string, HanaLensElement>>;
  readonly [PACKAGE_ANNOTATION]?: string;
}

export interface HanaLensCsn {
  readonly definitions: Readonly<Record<string, HanaLensDefinition>>;
}

export interface SapPackage {
  readonly name: string;
  readonly directory: string;
}

export interface FieldSearchResult {
  readonly entityName: string;
  readonly exact: boolean;
  readonly matchedField: string;
  readonly score: number;
}

export interface IncomingReference {
  readonly entityName: string;
  readonly fieldName: string;
}

export interface SearchResult {
  readonly name: string;
  readonly packageName: string;
  readonly score: number;
}

export type CompileVia = "cds" | "fallback";

export interface CompileResult {
  readonly packageName: string;
  readonly definitions: Readonly<Record<string, HanaLensDefinition>>;
  readonly via: CompileVia;
}

export interface PackageSkip {
  readonly package: string;
  readonly reason: string;
}

export interface CompileOutcome {
  readonly compiled: readonly CompileResult[];
  readonly skipped: readonly PackageSkip[];
}
