import type { Db } from '../db/connection.js';
import {
  applyEventEnvironmentTransforms,
  type EventEnvironmentReference,
} from '../parsers/event-environment-reference.js';
import {
  parseEnvironmentDeclarationsFact,
  type EnvironmentDeclarationsFact,
} from '../parsers/environment-declarations.js';
import {
  eventTemplateVariables,
  parseEventSkeletonFact,
} from '../utils/event-skeleton.js';

export interface EventEnvironmentResolution {
  status: 'resolved' | 'ambiguous' | 'unresolved' | 'not_applicable';
  variables: Record<string, string>;
  reason?: string;
  provenance: Array<Record<string, unknown>>;
}

export interface SubscriptionEnvironmentTarget {
  consumerRepoId?: number;
  consumerRepoName?: string;
  resolution: EventEnvironmentResolution;
  collisionCount: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function bindingEnvironmentValues(
  binding: EventEnvironmentReference,
  fact: EnvironmentDeclarationsFact,
): string[] {
  if (!binding.environmentKey) return [];
  return [...new Set(fact.declarations
    .filter((item) => item.key === binding.environmentKey)
    .map((item) => item.value))];
}

function bindingResolution(
  binding: EventEnvironmentReference,
  fact: EnvironmentDeclarationsFact,
): { value?: string; reason?: string; ambiguous?: boolean } {
  if (binding.status === 'refused')
    return { reason: binding.reason ?? 'event_environment_reference_refused' };
  if (fact.status === 'incomplete') return {
    reason: 'event_environment_declarations_incomplete',
  };
  const values = bindingEnvironmentValues(binding, fact);
  if (fact.status === 'ambiguous' || values.length > 1) return {
    reason: 'event_environment_declaration_ambiguous', ambiguous: true,
  };
  const value = values[0];
  if (value === undefined)
    return { reason: 'event_environment_declaration_missing' };
  return {
    value: applyEventEnvironmentTransforms(value, binding.transforms),
  };
}

function provenance(
  binding: EventEnvironmentReference,
  fact: EnvironmentDeclarationsFact,
): Record<string, unknown> {
  const rank = new Map([
    ['env_declaration_mta', 0],
    ['env_declaration_manifest', 1],
    ['env_declaration_dotenv', 2],
    ['env_declaration_dev', 3],
  ]);
  const declaration = fact.declarations.filter((item) =>
    item.key === binding.environmentKey).sort((left, right) =>
    (rank.get(left.provenance) ?? 99) - (rank.get(right.provenance) ?? 99)
    || (left.sourceFile < right.sourceFile
      ? -1 : left.sourceFile > right.sourceFile ? 1 : 0)
    || left.startOffset - right.startOffset)[0];
  return {
    sourceKey: binding.sourceKey,
    environmentKey: binding.environmentKey,
    transforms: binding.transforms,
    declarationProvenance: declaration?.provenance,
    declarationSourceFile: declaration?.sourceFile,
    declarationStartOffset: declaration?.startOffset,
    declarationEndOffset: declaration?.endOffset,
  };
}

export function resolveEventEnvironment(
  skeletonValue: unknown,
  environmentValue: unknown,
  variables: Record<string, string>,
): EventEnvironmentResolution {
  const skeleton = parseEventSkeletonFact(skeletonValue);
  if (!skeleton || skeleton.environmentBindings.length === 0) return {
    status: 'not_applicable',
    variables: eventTemplateVariables(skeleton, variables),
    provenance: [],
  };
  const fact = parseEnvironmentDeclarationsFact(environmentValue);
  if (!fact) return {
    status: 'unresolved', variables,
    reason: 'event_environment_declarations_invalid', provenance: [],
  };
  const expanded = eventTemplateVariables(skeleton, variables);
  const outcomes = skeleton.environmentBindings.map((binding) =>
    Object.hasOwn(expanded, binding.sourceKey)
      ? {} : bindingResolution(binding, fact));
  for (let index = 0; index < outcomes.length; index += 1) {
    const binding = skeleton.environmentBindings[index];
    const outcome = outcomes[index];
    if (binding?.sourceKey && outcome?.value !== undefined
      && !Object.hasOwn(expanded, binding.sourceKey))
      expanded[binding.sourceKey] = outcome.value;
  }
  const ambiguous = outcomes.find((outcome) => outcome.ambiguous);
  const unresolved = outcomes.find((outcome) => outcome.reason);
  return {
    status: ambiguous ? 'ambiguous'
      : unresolved ? 'unresolved' : 'resolved',
    variables: expanded,
    reason: ambiguous?.reason ?? unresolved?.reason,
    provenance: skeleton.environmentBindings.map((binding) =>
      provenance(binding, fact)),
  };
}

function dependencies(value: unknown): Record<string, string> {
  const parsed = record(parsedJson(value));
  if (!parsed) return {};
  return Object.fromEntries(Object.entries(parsed).flatMap(([key, item]) =>
    typeof item === 'string' ? [[key, item]] : []));
}

function consumerRows(
  db: Db,
  workspaceId: number,
  packageName: string,
): Array<Record<string, unknown>> {
  return db.prepare(`SELECT id,name,dependencies_json dependenciesJson,
    environment_declarations_json environmentJson
    FROM repositories WHERE workspace_id=?
    ORDER BY name COLLATE BINARY,id`).all(workspaceId)
    .filter((row) => Object.hasOwn(
      dependencies(row.dependenciesJson), packageName,
    ));
}

function collisionCounts(
  targets: readonly SubscriptionEnvironmentTarget[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const target of targets) {
    const values = Object.entries(target.resolution.variables)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const key = JSON.stringify(values);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function subscriptionEnvironmentTargets(
  db: Db,
  workspaceId: number,
  packageName: string | undefined,
  skeletonValue: unknown,
  ownEnvironmentValue: unknown,
  variables: Record<string, string>,
): SubscriptionEnvironmentTarget[] {
  const skeleton = parseEventSkeletonFact(skeletonValue);
  if (!skeleton || skeleton.environmentBindings.length === 0
    || !packageName) return [{
    resolution: resolveEventEnvironment(
      skeletonValue, ownEnvironmentValue, variables,
    ),
    collisionCount: 1,
  }];
  const rows = consumerRows(db, workspaceId, packageName);
  const provisional = rows.map((row): SubscriptionEnvironmentTarget => ({
    consumerRepoId: Number(row.id),
    consumerRepoName: String(row.name),
    resolution: resolveEventEnvironment(
      skeletonValue, row.environmentJson, variables,
    ),
    collisionCount: 1,
  }));
  if (provisional.length === 0) return [{
    resolution: resolveEventEnvironment(
      skeletonValue, ownEnvironmentValue, variables,
    ),
    collisionCount: 1,
  }];
  const counts = collisionCounts(provisional);
  return provisional.map((target) => {
    const key = JSON.stringify(Object.entries(target.resolution.variables)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    return { ...target, collisionCount: counts.get(key) ?? 1 };
  });
}
