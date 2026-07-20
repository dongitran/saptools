export type Completeness = "complete" | "truncated" | "unavailable" | "error";

export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

export type TaggedGraphValue =
  | JsonValue
  | { readonly kind: "undefined" }
  | { readonly kind: "bigint"; readonly value: string }
  | { readonly kind: "special-number"; readonly value: string }
  | { readonly kind: "symbol"; readonly value: string }
  | { readonly kind: "accessor"; readonly hasGetter: boolean; readonly hasSetter: boolean }
  | { readonly kind: "unavailable"; readonly description?: string }
  | { readonly kind: "ref"; readonly nodeId: string };

export interface CapturedGraphNode {
  readonly nodeId: string;
  readonly type: string;
  readonly subtype?: string;
  readonly className?: string;
  readonly description?: string;
  // Only present when `description` was cut down from a longer original
  // (e.g. a function's full source text) by the hard length cap in
  // remote-object.ts, mirroring how `omittedCount` records what a property
  // fan-out cap left out.
  readonly descriptionLength?: number;
  readonly completeness: Completeness;
  readonly omittedCount?: number;
  readonly properties: Readonly<Record<string, TaggedGraphValue>>;
}

export interface CapturedGraph {
  readonly roots: Readonly<Record<string, TaggedGraphValue>>;
  readonly nodes: Readonly<Record<string, CapturedGraphNode>>;
  readonly completeness: Completeness;
}

export interface CapturedFrameState extends CapturedGraph {
  readonly functionName: string;
  readonly scriptId: string;
  readonly url: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
}

export interface CapturedState {
  readonly version: 1;
  readonly frames: readonly CapturedFrameState[];
  readonly completeness: Completeness;
}

export interface CanonicalState {
  readonly value: JsonValue;
  readonly text: string;
  readonly hash: string;
}

export type StatePatchOperation =
  | { readonly op: "add" | "replace"; readonly path: string; readonly value: JsonValue }
  | { readonly op: "remove"; readonly path: string };

export interface StatePatch {
  readonly before: CanonicalState;
  readonly after: CanonicalState;
  readonly operations: readonly StatePatchOperation[];
  readonly changedPaths: readonly string[];
}

export interface TraceRunManifest {
  readonly version: 1;
  readonly runId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly sourceUrl: string;
  readonly sourceHash?: string;
  readonly functionSelector: string;
  readonly status: "recording" | "completed" | "partial" | "failed" | "cancelled";
}

export interface TraceEventInput {
  readonly seq: number;
  readonly kind: "baseline" | "pause" | "completed" | "exception" | "truncated";
  readonly stateHash: string;
  readonly artifactKind: "full" | "patch" | "unchanged";
  readonly changedPaths: readonly string[];
  readonly functionName?: string;
  readonly depth?: number;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
}
