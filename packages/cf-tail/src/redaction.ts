import type {
  ParsedLogRow,
  PersistSnapshotInput,
  RuntimeAppState,
  RuntimeStreamState,
} from "@saptools/cf-logs";

export interface RedactionRule {
  readonly value: string;
  readonly replacement: string;
}

export interface RedactionRuleInput {
  readonly email?: string;
  readonly password?: string;
  readonly secrets?: readonly string[];
}

const DEFAULT_REPLACEMENT = "***";

function uniqueNonEmpty(values: readonly (string | undefined)[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (value === undefined || value.length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result.sort((left, right) => right.length - left.length);
}

export function buildRedactionRules(input: RedactionRuleInput): readonly RedactionRule[] {
  return uniqueNonEmpty([input.email, input.password, ...(input.secrets ?? [])]).map((value) => ({
    value,
    replacement: DEFAULT_REPLACEMENT,
  }));
}

export function redactText(text: string, rules: readonly RedactionRule[]): string {
  let output = text;
  for (const rule of rules) {
    if (rule.value === rule.replacement) {
      continue;
    }
    output = output.split(rule.value).join(rule.replacement);
  }
  return output;
}

export function redactLines(
  lines: readonly string[],
  rules: readonly RedactionRule[],
): readonly string[] {
  return rules.length === 0 ? lines : lines.map((line) => redactText(line, rules));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactUnknown(value: unknown, rules: readonly RedactionRule[]): unknown {
  if (typeof value === "string") {
    return redactText(value, rules);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry, rules));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactUnknown(entry, rules)]),
  );
}

export function redactLogRow(row: ParsedLogRow, rules: readonly RedactionRule[]): ParsedLogRow {
  if (rules.length === 0) {
    return row;
  }
  const jsonPayload = row.jsonPayload === null
    ? null
    : (redactUnknown(row.jsonPayload, rules) as Record<string, unknown>);
  return {
    ...row,
    source: redactText(row.source, rules),
    logger: redactText(row.logger, rules),
    component: redactText(row.component, rules),
    org: redactText(row.org, rules),
    space: redactText(row.space, rules),
    host: redactText(row.host, rules),
    method: redactText(row.method, rules),
    request: redactText(row.request, rules),
    status: redactText(row.status, rules),
    latency: redactText(row.latency, rules),
    tenant: redactText(row.tenant, rules),
    clientIp: redactText(row.clientIp, rules),
    requestId: redactText(row.requestId, rules),
    message: redactText(row.message, rules),
    rawBody: redactText(row.rawBody, rules),
    jsonPayload,
    searchableText: redactText(row.searchableText, rules),
  };
}

export function redactRuntimeState(
  state: RuntimeAppState,
  rules: readonly RedactionRule[],
): RuntimeAppState {
  if (rules.length === 0) {
    return state;
  }
  return {
    ...state,
    rawText: redactText(state.rawText, rules),
    rows: state.rows.map((row) => redactLogRow(row, rules)),
  };
}

export function redactStreamState(
  state: RuntimeStreamState,
  rules: readonly RedactionRule[],
): RuntimeStreamState {
  if (rules.length === 0 || state.message === undefined) {
    return state;
  }
  return { ...state, message: redactText(state.message, rules) };
}

export function redactPersistInput(
  input: PersistSnapshotInput,
  rules: readonly RedactionRule[],
): PersistSnapshotInput {
  if (rules.length === 0) {
    return input;
  }
  return {
    ...input,
    rawText: redactText(input.rawText, rules),
    rows: input.rows.map((row) => redactLogRow(row, rules)),
  };
}
