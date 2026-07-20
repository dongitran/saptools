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
}

interface MutableGraphNode {
  nodeId: string;
  type: string;
  subtype?: string;
  className?: string;
  description?: string;
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

function boundedValue(context: CaptureContext, value: TaggedGraphValue): TaggedGraphValue {
  const serialized = JSON.stringify(value);
  const size = Buffer.byteLength(serialized);
  if (context.estimatedBytes + size <= context.limits.maxBytes) {
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

function createNode(context: CaptureContext, remote: RemoteObject): MutableGraphNode | undefined {
  if (Object.keys(context.nodes).length >= context.limits.maxNodes) {
    context.truncated = true;
    return undefined;
  }
  const nodeId = `n${String(Object.keys(context.nodes).length)}`;
  const metadata = [remote.subtype, remote.className, remote.description].filter(
    (value): value is string => value !== undefined,
  );
  const metadataBytes = metadata.reduce((total, value) => total + Buffer.byteLength(value), 0);
  const includeMetadata = context.estimatedBytes + metadataBytes <= context.limits.maxBytes;
  if (includeMetadata) {
    context.estimatedBytes += metadataBytes;
  } else {
    context.truncated = true;
  }
  const node: MutableGraphNode = {
    nodeId,
    type: remote.type,
    ...(includeMetadata && remote.subtype !== undefined ? { subtype: remote.subtype } : {}),
    ...(includeMetadata && remote.className !== undefined ? { className: remote.className } : {}),
    ...(includeMetadata && remote.description !== undefined ? { description: remote.description } : {}),
    completeness: includeMetadata ? "complete" : "truncated",
    properties: {},
  };
  context.nodes[nodeId] = node;
  return node;
}

function accessorValue(descriptor: RemotePropertyDescriptor): TaggedGraphValue {
  return {
    kind: "accessor",
    hasGetter: descriptor.get?.objectId !== undefined,
    hasSetter: descriptor.set?.objectId !== undefined,
  };
}

async function populateNode(
  context: CaptureContext,
  node: MutableGraphNode,
  objectId: string,
  depth: number,
): Promise<void> {
  if (depth >= context.limits.maxDepth || context.estimatedBytes >= context.limits.maxBytes) {
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
    if (context.estimatedBytes >= context.limits.maxBytes) {
      node.completeness = "truncated";
      context.truncated = true;
      break;
    }
    const value = descriptor.get !== undefined || descriptor.set !== undefined
      ? boundedValue(context, accessorValue(descriptor))
      : await captureValue(context, descriptor.value, depth + 1);
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
): Promise<TaggedGraphValue> {
  const alias = context.aliases.get(objectId);
  if (alias !== undefined) {
    return { kind: "ref", nodeId: alias };
  }
  context.releaseIds.add(objectId);
  const node = createNode(context, remote);
  if (node === undefined) {
    return { kind: "unavailable", description: "node-limit" };
  }
  context.aliases.set(objectId, node.nodeId);
  if (remote.subtype === "proxy" || remote.completeness === "unavailable") {
    node.completeness = "unavailable";
    context.truncated = true;
    return { kind: "ref", nodeId: node.nodeId };
  }
  await populateNode(context, node, objectId, depth);
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
    : await captureObject(context, remote, remote.objectId, depth);
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
  };
  const capturedRoots: Record<string, TaggedGraphValue> = {};
  try {
    for (const name of Object.keys(roots).sort()) {
      defineOwnValue(capturedRoots, name, await captureValue(context, roots[name], 0));
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
