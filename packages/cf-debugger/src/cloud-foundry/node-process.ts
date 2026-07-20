import { CfDebuggerError } from "../types.js";

export const DEFAULT_CF_PROCESS = "web";
export const DEFAULT_CF_INSTANCE = 0;

const MAX_MARKER_BYTES = 65_536;
const PID_LIST_PATTERN = /^\d+(?:,\d+)*$/;
const PID_PATTERN = /^\d+$/;

export interface NodeTargetSelectors {
  readonly process?: string;
  readonly instance?: number;
  readonly nodePid?: number;
}

export interface ResolvedNodeTarget {
  readonly process: string;
  readonly instance: number;
  readonly nodePid?: number;
}

export interface NodeProcessSelection {
  readonly remoteNodePid: number;
}

function validateProcessName(processName: string): void {
  if (processName.length === 0 || processName.startsWith("-") || hasControlCharacter(processName)) {
    throw new CfDebuggerError(
      "UNSAFE_INPUT",
      "process must be non-empty, must not start with a hyphen, and must contain no control characters.",
    );
  }
}

function validateInstance(instance: number): void {
  if (!Number.isSafeInteger(instance) || instance < 0) {
    throw new CfDebuggerError("UNSAFE_INPUT", "instance must be a non-negative safe integer.");
  }
}

function validateNodePid(nodePid: number | undefined): void {
  if (nodePid !== undefined && (!Number.isSafeInteger(nodePid) || nodePid <= 0)) {
    throw new CfDebuggerError("UNSAFE_INPUT", "nodePid must be a positive safe integer.");
  }
}

export function resolveNodeTarget(input: NodeTargetSelectors): ResolvedNodeTarget {
  const processName = (input.process ?? DEFAULT_CF_PROCESS).trim();
  const instance = input.instance ?? DEFAULT_CF_INSTANCE;
  validateProcessName(processName);
  validateInstance(instance);
  validateNodePid(input.nodePid);
  return input.nodePid === undefined
    ? { process: processName, instance }
    : { process: processName, instance, nodePid: input.nodePid };
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

export function buildNodeInspectorCommand(nodePid?: number): string {
  if (nodePid !== undefined && (!Number.isSafeInteger(nodePid) || nodePid <= 0)) {
    throw new CfDebuggerError("UNSAFE_INPUT", "nodePid must be a positive safe integer.");
  }
  return NODE_INSPECTOR_SCRIPT.replace("__REQUESTED_NODE_PID__", nodePid?.toString() ?? "");
}

export function parseNodeInspectorMarkers(stdout: string): NodeProcessSelection {
  if (Buffer.byteLength(stdout, "utf8") > MAX_MARKER_BYTES) {
    throw new CfDebuggerError("INSPECTOR_OUTPUT_TOO_LARGE", "Inspector startup output exceeded 65536 bytes.");
  }
  const markers = parseMarkers(stdout);
  throwForFailureMarker(markers);
  const remoteNodePid = readMarkerPid(markers, "saptools-inspector-node-pid");
  const ownerPid = readMarkerPid(markers, "saptools-inspector-owner-pid");
  if (!markers.has("saptools-inspector-ready") || remoteNodePid === undefined || ownerPid !== remoteNodePid) {
    throw new CfDebuggerError("INSPECTOR_NOT_READY", "Remote Node inspector did not report a verified owner.");
  }
  return { remoteNodePid };
}

function parseMarkers(stdout: string): ReadonlyMap<string, string> {
  const markers = new Map<string, string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("saptools-inspector-")) {
      continue;
    }
    const separator = line.indexOf("=");
    markers.set(separator < 0 ? line : line.slice(0, separator), separator < 0 ? "" : line.slice(separator + 1));
  }
  return markers;
}

function throwForFailureMarker(markers: ReadonlyMap<string, string>): void {
  if (markers.has("saptools-inspector-node-not-found")) {
    throw new CfDebuggerError("NODE_PROCESS_NOT_FOUND", "No Node.js process was found in the selected CF instance.");
  }
  const ambiguous = markers.get("saptools-inspector-node-ambiguous");
  if (ambiguous !== undefined) {
    const candidates = PID_LIST_PATTERN.test(ambiguous) ? ambiguous.split(",").join(", ") : "unknown";
    throw new CfDebuggerError("NODE_PROCESS_AMBIGUOUS", `Multiple Node.js processes were found: ${candidates}. Pass nodePid explicitly.`);
  }
  const invalid = markers.get("saptools-inspector-node-invalid");
  if (invalid !== undefined) {
    throw new CfDebuggerError("NODE_PID_INVALID", `Remote PID ${safePidText(invalid)} is not a Node.js process.`);
  }
  throwForRuntimeFailure(markers);
}

function throwForRuntimeFailure(markers: ReadonlyMap<string, string>): void {
  const mismatch = markers.get("saptools-inspector-owner-mismatch");
  if (mismatch !== undefined) {
    const [selected = "unknown", owner = "unknown"] = mismatch.split(":", 2).map(safePidText);
    throw new CfDebuggerError("INSPECTOR_OWNER_MISMATCH", `Selected Node PID ${selected}, but inspector port 9229 is owned by PID ${owner}.`);
  }
  const signalFailed = markers.get("saptools-inspector-signal-failed");
  if (signalFailed !== undefined) {
    throw new CfDebuggerError("USR1_SIGNAL_FAILED", `Failed to signal remote Node PID ${safePidText(signalFailed)}.`);
  }
  if (markers.has("saptools-inspector-not-ready")) {
    throw new CfDebuggerError("INSPECTOR_NOT_READY", "Remote Node inspector did not become ready on port 9229.");
  }
}

function readMarkerPid(markers: ReadonlyMap<string, string>, name: string): number | undefined {
  const raw = markers.get(name);
  if (raw === undefined || !PID_PATTERN.test(raw)) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function safePidText(raw: string): string {
  return PID_PATTERN.test(raw) ? raw : "unknown";
}

const NODE_INSPECTOR_SCRIPT = [
  "requested_node_pid=__REQUESTED_NODE_PID__",
  "is_node_pid() {",
  "  candidate_pid=\"$1\"",
  "  candidate_exe=\"$(readlink \"/proc/$candidate_pid/exe\" 2>/dev/null || true)\"",
  "  [ \"${candidate_exe##*/}\" = node ] || [ \"${candidate_exe##*/}\" = nodejs ]",
  "}",
  "find_listener_pid() {",
  "  listener_hex=\"$1\"",
  "  [ -n \"$listener_hex\" ] || return 0",
  "  socket_inode=\"$(awk -v ph=\":$listener_hex\" '$4 == \"0A\" && $2 ~ (ph \"$\") { print $10; exit }' /proc/net/tcp /proc/net/tcp6 2>/dev/null)\"",
  "  [ -n \"$socket_inode\" ] || return 0",
  "  for pid_dir in /proc/[0-9]*; do",
  "    [ -d \"$pid_dir/fd\" ] || continue",
  "    for fd_path in \"$pid_dir\"/fd/*; do",
  "      fd_target=\"$(readlink \"$fd_path\" 2>/dev/null || true)\"",
  "      if [ \"$fd_target\" = \"socket:[$socket_inode]\" ]; then",
  "        printf '%s' \"${pid_dir##*/}\"",
  "        return 0",
  "      fi",
  "    done",
  "  done",
  "}",
  "find_inspector_owner() {",
  "  find_listener_pid 240D",
  "}",
  "find_app_port_listener() {",
  "  [ -n \"${PORT:-}\" ] || return 0",
  "  app_port_hex=\"$(printf '%04X' \"$PORT\" 2>/dev/null || true)\"",
  "  find_listener_pid \"$app_port_hex\"",
  "}",
  "owner_pid=\"$(find_inspector_owner)\"",
  "selected_pid=\"\"",
  "if [ -n \"$requested_node_pid\" ]; then",
  "  if ! is_node_pid \"$requested_node_pid\"; then",
  "    echo \"saptools-inspector-node-invalid=$requested_node_pid\"",
  "    exit 0",
  "  fi",
  "  selected_pid=\"$requested_node_pid\"",
  "elif [ -n \"$owner_pid\" ] && is_node_pid \"$owner_pid\"; then",
  "  selected_pid=\"$owner_pid\"",
  "else",
  "  candidate_pids=\"\"",
  "  candidate_count=0",
  "  for pid_dir in /proc/[0-9]*; do",
  "    candidate_pid=\"${pid_dir##*/}\"",
  "    is_node_pid \"$candidate_pid\" || continue",
  "    candidate_count=$((candidate_count + 1))",
  "    candidate_pids=\"${candidate_pids}${candidate_pids:+,}$candidate_pid\"",
  "    selected_pid=\"$candidate_pid\"",
  "  done",
  "  if [ \"$candidate_count\" -eq 0 ]; then echo saptools-inspector-node-not-found; exit 0; fi",
  "  if [ \"$candidate_count\" -ne 1 ]; then",
  "    app_port_pid=\"$(find_app_port_listener)\"",
  "    if [ -n \"$app_port_pid\" ] && is_node_pid \"$app_port_pid\"; then",
  "      selected_pid=\"$app_port_pid\"",
  "    else",
  "      echo \"saptools-inspector-node-ambiguous=$candidate_pids\"; exit 0",
  "    fi",
  "  fi",
  "fi",
  "if [ -n \"$owner_pid\" ]; then",
  "  if [ \"$owner_pid\" != \"$selected_pid\" ]; then echo \"saptools-inspector-owner-mismatch=$selected_pid:$owner_pid\"; exit 0; fi",
  "  echo \"saptools-inspector-node-pid=$selected_pid\"",
  "  echo \"saptools-inspector-owner-pid=$owner_pid\"",
  "  echo saptools-inspector-ready",
  "  exit 0",
  "fi",
  "if ! kill -USR1 \"$selected_pid\" 2>/dev/null; then echo \"saptools-inspector-signal-failed=$selected_pid\"; exit 0; fi",
  "attempt=0",
  "while [ \"$attempt\" -lt 20 ]; do",
  "  owner_pid=\"$(find_inspector_owner)\"",
  "  if [ -n \"$owner_pid\" ]; then",
  "    if [ \"$owner_pid\" != \"$selected_pid\" ]; then echo \"saptools-inspector-owner-mismatch=$selected_pid:$owner_pid\"; exit 0; fi",
  "    echo \"saptools-inspector-node-pid=$selected_pid\"",
  "    echo \"saptools-inspector-owner-pid=$owner_pid\"",
  "    echo saptools-inspector-ready",
  "    exit 0",
  "  fi",
  "  attempt=$((attempt + 1))",
  "  sleep 0.25",
  "done",
  "echo \"saptools-inspector-not-ready=$selected_pid\"",
].join("\n");
