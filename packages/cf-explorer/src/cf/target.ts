import { getAllRegions } from "@saptools/cf-sync";

import { CfExplorerError } from "../core/errors.js";
import type {
  ExplorerCredentials,
  ExplorerRuntimeOptions,
  ExplorerTarget,
  InstanceSelector,
} from "../core/types.js";

export const DEFAULT_PROCESS = "web";
const DEFAULT_INSTANCE = 0;

export function requireNonEmptyText(value: string | undefined, label: string): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    throw new CfExplorerError("UNSAFE_INPUT", `${label} is required.`);
  }
  if (trimmed.includes("\0") || trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new CfExplorerError("UNSAFE_INPUT", `${label} must not contain control line breaks.`);
  }
  return trimmed;
}

function requireSecretValue(value: string | undefined, label: string): string {
  const raw = value ?? "";
  if (raw.trim().length === 0) {
    throw new CfExplorerError("UNSAFE_INPUT", `${label} is required.`);
  }
  if (raw.includes("\0") || raw.includes("\n") || raw.includes("\r")) {
    throw new CfExplorerError("UNSAFE_INPUT", `${label} must not contain control line breaks.`);
  }
  return raw;
}

function normalizeOptionalText(value: string | undefined, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new CfExplorerError("UNSAFE_INPUT", `${label} must not contain control line breaks.`);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function resolveApiEndpoint(target: ExplorerTarget): string {
  if (target.apiEndpoint !== undefined && target.apiEndpoint.trim().length > 0) {
    return target.apiEndpoint.trim();
  }

  const region = getAllRegions().find((item) => item.key === target.region);
  if (region === undefined) {
    throw new CfExplorerError("UNKNOWN_REGION", `Unknown CF region: ${target.region}`);
  }
  return region.apiEndpoint;
}

export function normalizeTarget(target: ExplorerTarget): ExplorerTarget {
  const apiEndpoint = normalizeOptionalText(target.apiEndpoint, "apiEndpoint");
  return {
    region: requireNonEmptyText(target.region, "region"),
    org: requireNonEmptyText(target.org, "org"),
    space: requireNonEmptyText(target.space, "space"),
    app: requireNonEmptyText(target.app, "app"),
    ...(apiEndpoint === undefined ? {} : { apiEndpoint }),
  };
}

export function resolveCredentials(options: ExplorerRuntimeOptions = {}): ExplorerCredentials {
  if (options.credentials !== undefined) {
    const email = requireNonEmptyText(options.credentials.email, "email");
    const password = requireSecretValue(options.credentials.password, "password");
    return { email, password };
  }

  const source = options.env ?? process.env;
  const email = source["SAP_EMAIL"];
  const password = source["SAP_PASSWORD"];
  if (email === undefined || email.trim().length === 0) {
    throw new CfExplorerError(
      "MISSING_CREDENTIALS",
      "SAP email is required. Pass credentials or set SAP_EMAIL.",
    );
  }
  if (password === undefined || password.trim().length === 0) {
    throw new CfExplorerError(
      "MISSING_CREDENTIALS",
      "SAP password is required. Pass credentials or set SAP_PASSWORD.",
    );
  }
  return { email: email.trim(), password: requireSecretValue(password, "password") };
}

export function resolveProcessName(value: string | undefined): string {
  return requireNonEmptyText(value ?? DEFAULT_PROCESS, "process");
}

export function resolveInstanceSelector(selector: InstanceSelector = {}): InstanceSelector {
  if (selector.allInstances === true && selector.instance !== undefined) {
    throw new CfExplorerError("UNSAFE_INPUT", "Use either --instance or --all-instances, not both.");
  }
  const base = {
    process: resolveProcessName(selector.process),
    allInstances: selector.allInstances === true,
  };
  return selector.allInstances === true
    ? base
    : { ...base, instance: resolveInstance(selector.instance) };
}

export function resolveInstance(value: number | undefined): number {
  const instance = value ?? DEFAULT_INSTANCE;
  if (!Number.isInteger(instance) || instance < 0) {
    throw new CfExplorerError("UNSAFE_INPUT", "Instance must be a non-negative integer.");
  }
  return instance;
}

export function parsePositiveInteger(value: string | undefined, label: string): number | undefined {
  const parsed = parseDecimalInteger(value, label);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed <= 0) {
    throw new CfExplorerError("UNSAFE_INPUT", `${label} must be a positive integer.`);
  }
  return parsed;
}

export function parseNonNegativeInteger(value: string | undefined, label: string): number | undefined {
  const parsed = parseDecimalInteger(value, label);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed < 0) {
    throw new CfExplorerError("UNSAFE_INPUT", `${label} must be a non-negative integer.`);
  }
  return parsed;
}

function parseDecimalInteger(value: string | undefined, label: string): number | undefined {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    return undefined;
  }
  if (!/^-?\d+$/.test(trimmed)) {
    throw new CfExplorerError("UNSAFE_INPUT", `${label} must be an integer.`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new CfExplorerError("UNSAFE_INPUT", `${label} must be a safe integer.`);
  }
  return parsed;
}
