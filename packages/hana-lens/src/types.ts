export const CACHE_FILE_NAME = ".hana-lens-cache.json";
export const PACKAGE_ANNOTATION = "@hanaLens.packageName";

export interface HanaLensElement {
  readonly type?: string;
  readonly length?: number;
  readonly key?: boolean;
  readonly target?: string;
  readonly "@Core.Computed"?: boolean;
  readonly on?: readonly unknown[];
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

export interface SearchResult {
  readonly name: string;
  readonly packageName: string;
  readonly score: number;
}

export interface CompileResult {
  readonly packageName: string;
  readonly definitions: Readonly<Record<string, HanaLensDefinition>>;
}
