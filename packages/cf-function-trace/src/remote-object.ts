import type {
  CapturedGraph,
  Completeness,
  TaggedGraphValue,
} from "./contracts.js";
import { TraceDataError } from "./errors.js";
import { defineOwnValue } from "./safe-record.js";

const MIN_CAPTURED_GRAPH_BYTES = Buffer.byteLength('{"roots":{},"nodes":{},"completeness":"truncated"}');
const MIN_REMOTE_GRAPH_BYTES = Buffer.byteLength('{"root":{"kind":"unavailable"},"nodes":{},"completeness":"truncated"}');
const HIDDEN_SLOT_SUBTYPES = new Set(["date", "map", "promise", "set", "weakmap", "weakset"]);
// A function's `description` is V8's full `Function.prototype.toString()`
// output. Left uncapped, one recurring framework closure (e.g. a logger
// method) can be ~3.4 KB of byte-identical source repeated in every step's
// capture. This cap applies regardless of the remaining byte budget, so it
// never depends on capture order to keep descriptions small.
const MAX_DESCRIPTION_LENGTH = 256;
// Every root gets at most this fraction of whatever budget remains when it is
// about to be captured, shared evenly across however many roots are still
// left to process. This stops one oversized root (framework `this`, a bulky
// request object) from consuming the whole per-frame budget and starving
// roots that sort or are prioritized after it.
const MIN_ROOT_BUDGET_BYTES = 256;
const MIN_ROOT_NODE_BUDGET = 4;

export interface RemoteObject {
  readonly type: string;
  readonly subtype?: string;
  readonly className?: string;
  readonly completeness?: "truncated" | "unavailable";
  readonly value?: unknown;
  readonly unserializableValue?: string;
  readonly description?: string;
  readonly objectId?: string;
}

export interface RemotePropertyDescriptor {
  readonly name: string;
  readonly value?: RemoteObject;
  readonly get?: RemoteObject;
  readonly set?: RemoteObject;
}

export interface RemoteObjectClient {
  getProperties(objectId: string): Promise<readonly RemotePropertyDescriptor[]>;
  releaseObject(objectId: string): Promise<void>;
}

export interface GraphCaptureLimits {
  readonly maxDepth: number;
  readonly maxProperties: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
  // How many levels to descend into "machinery" (framework/behavioral) objects
  // -- the CAP service instance (`this`), a cds.Request (`req`), loggers,
  // services -- versus plain data, which uses maxDepth. Defaults to 1 so a step
  // never pulls the whole service graph; raise it (and maxDepth) to inspect
  // framework internals. Optional so non-CLI callers keep the safe default.
  readonly machineryDepth?: number;
}

interface MutableGraphNode {
  nodeId: string;
  type: string;
  subtype?: string;
  className?: string;
  description?: string;
  descriptionLength?: number;
  completeness: Completeness;
  omittedCount?: number;
  properties: Record<string, TaggedGraphValue>;
}

interface CaptureContext {
  readonly client: RemoteObjectClient;
  readonly limits: GraphCaptureLimits;
  readonly aliases: Map<string, string>;
  readonly nodes: Record<string, MutableGraphNode>;
  readonly releaseIds: Set<string>;
  estimatedBytes: number;
  truncated: boolean;
  // Tightened before capturing each root to this root's fair share of the
  // remaining budget (see nextByteCeiling/nextNodeCeiling). Value/node
  // capture helpers check these ceilings instead of `limits.maxBytes`/
  // `limits.maxNodes` directly, so they can never exceed the global limits
  // either (a root's ceiling is always <= the global limit).
  rootByteCeiling: number;
  rootNodeCeiling: number;
}

interface RemoteGraphResult {
  readonly root: TaggedGraphValue;
  readonly nodes: CapturedGraph["nodes"];
  readonly completeness: Completeness;
}

function taggedPrimitiveValue(remote: RemoteObject): TaggedGraphValue | undefined {
  if (remote.type === "undefined") {
    return { kind: "undefined" };
  }
  if (remote.type === "bigint") {
    return { kind: "bigint", value: (remote.unserializableValue ?? remote.description ?? "").replace(/n$/u, "") };
  }
  if (remote.type === "symbol") {
    return { kind: "symbol", value: remote.description ?? "Symbol()" };
  }
  if (remote.type === "number" && remote.unserializableValue !== undefined) {
    return { kind: "special-number", value: remote.unserializableValue };
  }
  return undefined;
}

function primitiveValue(remote: RemoteObject): TaggedGraphValue | undefined {
  const tagged = taggedPrimitiveValue(remote);
  if (tagged !== undefined) {
    return tagged;
  }
  if (remote.subtype === "null") {
    return null;
  }
  if (!["string", "boolean", "number"].includes(remote.type)) {
    return undefined;
  }
  const value = remote.value;
  return typeof value === "string" || typeof value === "boolean" || typeof value === "number"
    ? value
    : unavailableValue(remote.description);
}

function unavailableValue(description: string | undefined): TaggedGraphValue {
  return description === undefined
    ? { kind: "unavailable" }
    : { kind: "unavailable", description };
}

// A node's id is derived from the stable PATH used to reach it (its root
// key, then each property name walked to get here), not from when it was
// discovered. CDP releases every object at the end of a capture (see
// releaseCapturedObjects), so a live heap object gets a brand-new objectId
// on every pause -- objectId can never be the stable identity. The path a
// declared variable takes to reach a given value, however, is the same on
// every step that the value is still reachable the same way, so deriving
// the id from that path (instead of a per-call discovery-order counter)
// makes the SAME logical value keep the SAME id across steps. Segments are
// escaped JSON-Pointer style so no property name (however it is spelled)
// can introduce a false path collision.
function encodePathSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function nodeIdForPath(path: readonly string[]): string {
  return path.map(encodePathSegment).join("/");
}

function boundedValue(context: CaptureContext, value: TaggedGraphValue): TaggedGraphValue {
  const serialized = JSON.stringify(value);
  const size = Buffer.byteLength(serialized);
  if (context.estimatedBytes + size <= context.rootByteCeiling) {
    context.estimatedBytes += size;
    return value;
  }
  context.truncated = true;
  return { kind: "unavailable", description: "byte-limit" };
}

function isByteLimitValue(value: TaggedGraphValue): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return value.kind === "unavailable" && value.description === "byte-limit";
}

interface BoundedDescription {
  readonly text?: string;
  readonly originalLength?: number;
}

// Hard-caps `description` regardless of the remaining byte budget. Without
// this, a single function value's full V8 source text (`description`) can be
// thousands of bytes, repeated byte-for-byte across every step that captures
// the same recurring closure (e.g. a logger method).
function boundedDescription(description: string | undefined): BoundedDescription {
  if (description === undefined) {
    return {};
  }
  if (description.length <= MAX_DESCRIPTION_LENGTH) {
    return { text: description };
  }
  return { text: description.slice(0, MAX_DESCRIPTION_LENGTH), originalLength: description.length };
}

function metadataByteLength(remote: RemoteObject, description: BoundedDescription): number {
  const metadata = [remote.subtype, remote.className, description.text].filter(
    (value): value is string => value !== undefined,
  );
  return metadata.reduce((total, value) => total + Buffer.byteLength(value), 0);
}

interface NodeMetadata {
  readonly subtype?: string;
  readonly className?: string;
  readonly description?: string;
  readonly descriptionLength?: number;
}

function nodeMetadata(remote: RemoteObject, description: BoundedDescription, includeMetadata: boolean): NodeMetadata {
  if (!includeMetadata) {
    return {};
  }
  return {
    ...(remote.subtype === undefined ? {} : { subtype: remote.subtype }),
    ...(remote.className === undefined ? {} : { className: remote.className }),
    ...(description.text === undefined ? {} : { description: description.text }),
    ...(description.originalLength === undefined ? {} : { descriptionLength: description.originalLength }),
  };
}

function createNode(context: CaptureContext, remote: RemoteObject, path: readonly string[]): MutableGraphNode | undefined {
  if (Object.keys(context.nodes).length >= context.rootNodeCeiling) {
    context.truncated = true;
    return undefined;
  }
  const nodeId = nodeIdForPath(path);
  const description = boundedDescription(remote.description);
  const metadataBytes = metadataByteLength(remote, description);
  const includeMetadata = context.estimatedBytes + metadataBytes <= context.rootByteCeiling;
  if (includeMetadata) {
    context.estimatedBytes += metadataBytes;
  }
  const complete = includeMetadata && description.originalLength === undefined;
  if (!complete) {
    context.truncated = true;
  }
  const node: MutableGraphNode = {
    nodeId,
    type: remote.type,
    ...nodeMetadata(remote, description, includeMetadata),
    completeness: complete ? "complete" : "truncated",
    properties: {},
  };
  // Path-derived ids are built from live property names, so -- unlike the
  // old purely-numeric counter -- they could coincidentally collide with
  // "__proto__" (e.g. a lone root literally named that). defineOwnValue
  // uses Object.defineProperty, so even that never touches context.nodes'
  // own prototype the way `context.nodes[nodeId] = node` could.
  defineOwnValue(context.nodes, nodeId, node);
  return node;
}

function accessorValue(descriptor: RemotePropertyDescriptor): TaggedGraphValue {
  return {
    kind: "accessor",
    hasGetter: descriptor.get?.objectId !== undefined,
    hasSetter: descriptor.set?.objectId !== undefined,
  };
}

const DEFAULT_MACHINERY_DEPTH = 1;

// A value is "machinery" (framework/behavioral) rather than plain data when V8
// gives it a constructed className other than Object/Array -- e.g. the CAP
// service instance (`this`), a cds.Request (`req`), a logger, or a service.
// Such objects are captured shallowly by default so a step's capture stays small
// and fast instead of descending the whole service graph; plain Object/Array
// data is still walked to maxDepth. Raise --machinery-depth to inspect them.
function isMachinery(remote: RemoteObject): boolean {
  return remote.className !== undefined
    && remote.className !== "Object"
    && remote.className !== "Array";
}

// Depth to recurse a child at: plain data gets the next level; machinery is held
// to `machineryDepth` levels of its own content regardless of where it is reached
// (never going backwards past the current depth).
function childCaptureDepth(
  context: CaptureContext,
  child: RemoteObject | undefined,
  depth: number,
): number {
  if (child === undefined || !isMachinery(child)) {
    return depth + 1;
  }
  const machineryDepth = context.limits.machineryDepth ?? DEFAULT_MACHINERY_DEPTH;
  return Math.max(depth + 1, context.limits.maxDepth - machineryDepth);
}

async function populateNode(
  context: CaptureContext,
  node: MutableGraphNode,
  objectId: string,
  depth: number,
  path: readonly string[],
): Promise<void> {
  if (depth >= context.limits.maxDepth || context.estimatedBytes >= context.rootByteCeiling) {
    node.completeness = "truncated";
    context.truncated = true;
    return;
  }
  const descriptors = [...await context.client.getProperties(objectId)]
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const visible = descriptors.slice(0, context.limits.maxProperties);
  if (visible.length < descriptors.length) {
    node.completeness = "truncated";
    node.omittedCount = descriptors.length - visible.length;
    context.truncated = true;
  }
  for (const descriptor of visible) {
    context.estimatedBytes += Buffer.byteLength(descriptor.name);
    if (context.estimatedBytes >= context.rootByteCeiling) {
      node.completeness = "truncated";
      context.truncated = true;
      break;
    }
    const value = descriptor.get !== undefined || descriptor.set !== undefined
      ? boundedValue(context, accessorValue(descriptor))
      : await captureValue(context, descriptor.value, childCaptureDepth(context, descriptor.value, depth), [...path, descriptor.name]);
    if (isByteLimitValue(value)) {
      node.completeness = "truncated";
    }
    defineOwnValue(node.properties, descriptor.name, value);
  }
}

async function captureObject(
  context: CaptureContext,
  remote: RemoteObject,
  objectId: string,
  depth: number,
  path: readonly string[],
): Promise<TaggedGraphValue> {
  const alias = context.aliases.get(objectId);
  if (alias !== undefined) {
    return { kind: "ref", nodeId: alias };
  }
  context.releaseIds.add(objectId);
  const node = createNode(context, remote, path);
  if (node === undefined) {
    return { kind: "unavailable", description: "node-limit" };
  }
  context.aliases.set(objectId, node.nodeId);
  if (remote.subtype === "proxy" || remote.completeness === "unavailable") {
    node.completeness = "unavailable";
    context.truncated = true;
    return { kind: "ref", nodeId: node.nodeId };
  }
  await populateNode(context, node, objectId, depth, path);
  if (remote.completeness === "truncated"
      || (remote.subtype !== undefined && HIDDEN_SLOT_SUBTYPES.has(remote.subtype))) {
    node.completeness = "truncated";
    context.truncated = true;
  }
  return { kind: "ref", nodeId: node.nodeId };
}

async function captureValue(
  context: CaptureContext,
  remote: RemoteObject | undefined,
  depth: number,
  path: readonly string[],
): Promise<TaggedGraphValue> {
  if (remote === undefined) {
    return { kind: "unavailable" };
  }
  const primitive = primitiveValue(remote);
  if (primitive !== undefined) {
    return boundedValue(context, primitive);
  }
  const value = remote.objectId === undefined
    ? unavailableValue(remote.description)
    : await captureObject(context, remote, remote.objectId, depth, path);
  return boundedValue(context, value);
}

async function releaseCapturedObjects(context: CaptureContext): Promise<void> {
  await Promise.all([...context.releaseIds].map(async (objectId) => {
    try {
      await context.client.releaseObject(objectId);
    } catch {
      return;
    }
  }));
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function boundCapturedGraph(graph: CapturedGraph, maxBytes: number): CapturedGraph {
  if (serializedBytes(graph) <= maxBytes) {
    return graph;
  }
  return { roots: {}, nodes: {}, completeness: "truncated" };
}

function boundRemoteGraphResult(result: RemoteGraphResult, maxBytes: number): RemoteGraphResult {
  if (serializedBytes(result) <= maxBytes) {
    return result;
  }
  return {
    root: { kind: "unavailable" },
    nodes: {},
    completeness: "truncated",
  };
}

function validInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validateGraphLimits(limits: GraphCaptureLimits, minimumBytes: number): void {
  const valid = validInteger(limits.maxDepth, 0, 20)
    && validInteger(limits.maxProperties, 1, 10_000)
    && validInteger(limits.maxNodes, 1, 100_000)
    && validInteger(limits.maxBytes, minimumBytes, 100_000_000);
  if (!valid) {
    throw new TraceDataError("INVALID_ARGUMENT", "Graph capture limits are outside their supported ranges.");
  }
}

// Splits whatever budget remains evenly across however many roots are still
// left to process (including the one about to start), recomputed fresh
// before each root. A root that uses less than its share leaves the rest for
// later roots; a lone or final root always gets 100% of what remains, so a
// single-root caller (captureRemoteGraph) is never artificially restricted.
function fairShare(used: number, limit: number, minimumFloor: number, rootsLeft: number): number {
  const remaining = Math.max(0, limit - used);
  const share = Math.floor(remaining / Math.max(1, rootsLeft));
  return used + Math.max(Math.min(minimumFloor, remaining), share);
}

function nextByteCeiling(context: CaptureContext, rootsLeft: number): number {
  return fairShare(context.estimatedBytes, context.limits.maxBytes, MIN_ROOT_BUDGET_BYTES, rootsLeft);
}

function nextNodeCeiling(context: CaptureContext, rootsLeft: number): number {
  return fairShare(Object.keys(context.nodes).length, context.limits.maxNodes, MIN_ROOT_NODE_BUDGET, rootsLeft);
}

export async function captureRemoteValues(
  client: RemoteObjectClient,
  roots: Readonly<Record<string, RemoteObject>>,
  limits: GraphCaptureLimits,
): Promise<CapturedGraph> {
  validateGraphLimits(limits, MIN_CAPTURED_GRAPH_BYTES);
  const context: CaptureContext = {
    client,
    limits,
    aliases: new Map(),
    nodes: {},
    releaseIds: new Set(),
    estimatedBytes: 0,
    truncated: false,
    rootByteCeiling: limits.maxBytes,
    rootNodeCeiling: limits.maxNodes,
  };
  const capturedRoots: Record<string, TaggedGraphValue> = {};
  // Root iteration order is the caller's own insertion order (declaration/
  // priority tiering happens in state-capture.ts's collectFrameRoots), not an
  // alphabetical re-sort: sorting by name/scope-index string previously put
  // volatile framework locals ahead of a function's own parameters.
  const rootNames = Object.keys(roots);
  try {
    for (const [index, name] of rootNames.entries()) {
      const rootsLeft = rootNames.length - index;
      context.rootByteCeiling = nextByteCeiling(context, rootsLeft);
      context.rootNodeCeiling = nextNodeCeiling(context, rootsLeft);
      // depth -1 so childCaptureDepth yields 0 for plain-data roots and the
      // machinery ceiling for machinery roots (this, req) -- so a framework root
      // is held to machineryDepth levels just like a machinery child.
      const rootDepth = childCaptureDepth(context, roots[name], -1);
      defineOwnValue(capturedRoots, name, await captureValue(context, roots[name], rootDepth, [name]));
    }
  } finally {
    await releaseCapturedObjects(context);
  }
  return boundCapturedGraph({
    roots: capturedRoots,
    nodes: context.nodes,
    completeness: context.truncated ? "truncated" : "complete",
  }, limits.maxBytes);
}

export async function captureRemoteGraph(
  client: RemoteObjectClient,
  remote: RemoteObject,
  limits: GraphCaptureLimits,
): Promise<RemoteGraphResult> {
  validateGraphLimits(limits, MIN_REMOTE_GRAPH_BYTES);
  const graph = await captureRemoteValues(client, { root: remote }, limits);
  return boundRemoteGraphResult({
    root: graph.roots["root"] ?? { kind: "unavailable" },
    nodes: graph.nodes,
    completeness: graph.completeness,
  }, limits.maxBytes);
}
