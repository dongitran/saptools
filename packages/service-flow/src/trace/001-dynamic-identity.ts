import type { Db } from '../db/connection.js';
import type {
  DynamicTargetCandidate,
  DynamicTemplates,
  DynamicVariableProvenance,
} from './000-dynamic-target-types.js';

interface ImplementationOwner {
  repoId?: number;
}

interface IdentityProposal {
  operationId: number;
  key: string;
  value: string;
  normalizedIdentity: string;
  provenance: DynamicVariableProvenance;
}

interface RepositoryIdentity {
  repoId: number;
  repoName: string;
  packageName?: string;
}

interface WorkspaceIdentityMatch {
  ownerKey: string;
  key: string;
  value: string;
  normalizedIdentity: string;
}

export interface IdentityDerivation {
  operationId: number;
  key: string;
  value: string;
  provenance: DynamicVariableProvenance;
}

export function uniqueIdentityDerivations(
  db: Db,
  candidates: DynamicTargetCandidate[],
  templates: DynamicTemplates,
): IdentityDerivation[] {
  const identities = workspaceIdentities(db, candidates);
  const proposals = candidates.flatMap((candidate) => {
    const owner = implementationOwner(db, candidate.candidateOperationId);
    const identity = identities.find((item) => item.repoId === candidate.repoId);
    return ownerAgrees(candidate, owner) && identity
      ? identityProposals(candidate, identity, templates)
      : [];
  });
  const matches = workspaceIdentityMatches(identities, templates);
  const competing = competingIdentityKeys(matches);
  const duplicates = duplicateNormalizedIdentities(identities);
  return proposals
    .filter((proposal) => !competing.has(`${proposal.key}:${proposal.value}`))
    .filter((proposal) => !duplicates.has(proposal.normalizedIdentity))
    .map((proposal) => ({
      operationId: proposal.operationId,
      key: proposal.key,
      value: proposal.value,
      provenance: proposal.provenance,
    }));
}

function identityProposals(
  candidate: DynamicTargetCandidate,
  identity: RepositoryIdentity,
  templates: DynamicTemplates,
): IdentityProposal[] {
  const routeTemplates = [templates.alias, templates.destination]
    .filter((value): value is string => Boolean(value));
  const identities = [
    { name: identity.packageName, sourceKind: 'package_identity', npmPackage: true },
    { name: identity.repoName, sourceKind: 'repository_identity', npmPackage: false },
  ].filter((item): item is {
    name: string; sourceKind: string; npmPackage: boolean;
  } => Boolean(item.name));
  const proposals = routeTemplates.flatMap((template) =>
    identities.flatMap((identity) =>
      proposalForIdentity(
        candidate, template, identity.name, identity.sourceKind,
        identity.npmPackage,
      )));
  return deduplicateProposals(proposals);
}

function proposalForIdentity(
  candidate: DynamicTargetCandidate,
  template: string,
  identity: string,
  sourceKind: string,
  npmPackage: boolean,
): IdentityProposal[] {
  const match = matchIdentityTemplate(template, identity, npmPackage);
  if (!match) return [];
  return [{
    operationId: candidate.candidateOperationId,
    key: match.key,
    value: match.value,
    normalizedIdentity: match.normalizedIdentity,
    provenance: {
      sourceKind,
      value: match.value,
      rule: 'exact_normalized_identity_template_match',
      template,
      matchedName: identity,
      normalizedForm: match.normalizedIdentity,
      sourceRepo: candidate.repoName,
    },
  }];
}

function matchIdentityTemplate(
  template: string,
  identity: string,
  npmPackage: boolean,
): { key: string; value: string; normalizedIdentity: string } | undefined {
  const matches = [...template.matchAll(/\$\{([^}]*)\}/g)];
  if (matches.length !== 1 || !matches[0]?.[1]) return undefined;
  const placeholder = matches[0][0];
  const sentinel = 'dynamicplaceholdertoken';
  const normalizedTemplate = normalizeIdentity(template.replace(placeholder, sentinel));
  const [prefix, suffix, extra] = normalizedTemplate.split(sentinel);
  if (!prefix || !suffix || extra !== undefined) return undefined;
  const normalizedIdentity = normalizeIdentity(identity, npmPackage);
  const match = new RegExp(`^${escapeRegex(prefix)}([a-z0-9]+)${escapeRegex(suffix)}$`)
    .exec(normalizedIdentity);
  if (!match?.[1]) return undefined;
  return { key: matches[0][1].trim(), value: match[1], normalizedIdentity };
}

function competingIdentityKeys(
  proposals: Array<{ key: string; value: string; ownerKey: string }>,
): Set<string> {
  const owners = new Map<string, Set<string>>();
  for (const proposal of proposals) {
    const key = `${proposal.key}:${proposal.value}`;
    owners.set(key, new Set([...(owners.get(key) ?? []), proposal.ownerKey]));
  }
  return new Set([...owners.entries()]
    .filter(([, repos]) => repos.size > 1)
    .map(([key]) => key));
}

function duplicateNormalizedIdentities(
  identities: RepositoryIdentity[],
): Set<string> {
  const owners = new Map<string, Set<string>>();
  for (const identity of identities) {
    for (const [name, npmPackage] of [
      [identity.packageName, true],
      [identity.repoName, false],
    ] as const) {
      if (!name) continue;
      const normalized = normalizeIdentity(name, npmPackage);
      owners.set(normalized, new Set([
        ...(owners.get(normalized) ?? []),
        `repository:${identity.repoId}`,
      ]));
    }
  }
  return new Set([...owners.entries()]
    .filter(([, repos]) => repos.size > 1)
    .map(([identity]) => identity));
}

function workspaceIdentityMatches(
  identities: RepositoryIdentity[],
  templates: DynamicTemplates,
): WorkspaceIdentityMatch[] {
  const routeTemplates = [templates.alias, templates.destination]
    .filter((value): value is string => Boolean(value));
  return identities.flatMap((identity) => {
    const names: Array<{ name?: string; npmPackage: boolean }> = [
      { name: identity.packageName, npmPackage: true },
      { name: identity.repoName, npmPackage: false },
    ];
    return routeTemplates.flatMap((template) =>
      names.flatMap(({ name, npmPackage }) => {
        if (!name) return [];
        const match = matchIdentityTemplate(template, name, npmPackage);
        return match ? [{
          ownerKey: `repository:${identity.repoId}`,
          key: match.key,
          value: match.value,
          normalizedIdentity: match.normalizedIdentity,
        }] : [];
      }));
  });
}

function workspaceIdentities(
  db: Db,
  candidates: DynamicTargetCandidate[],
): RepositoryIdentity[] {
  const repoIds = [...new Set(candidates.flatMap((candidate) =>
    candidate.repoId === undefined ? [] : [candidate.repoId]))].sort((a, b) => a - b);
  if (repoIds.length === 0) return [];
  const placeholders = repoIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id repoId,name repoName,package_name packageName
    FROM repositories WHERE workspace_id IN (
      SELECT DISTINCT workspace_id FROM repositories WHERE id IN (${placeholders})
    ) ORDER BY workspace_id,name,absolute_path,id`).all(...repoIds);
  return rows.flatMap((row): RepositoryIdentity[] => {
    const repoId = numberValue(row.repoId);
    const repoName = stringValue(row.repoName);
    return repoId === undefined || !repoName ? [] : [{
      repoId,
      repoName,
      packageName: stringValue(row.packageName),
    }];
  });
}

function deduplicateProposals(rows: IdentityProposal[]): IdentityProposal[] {
  const sorted = [...rows].sort((left, right) =>
    left.operationId - right.operationId
    || left.key.localeCompare(right.key)
    || left.value.localeCompare(right.value)
    || left.provenance.sourceKind.localeCompare(right.provenance.sourceKind));
  const seen = new Set<string>();
  return sorted.filter((row) => {
    const key = [row.operationId, row.key, row.value, row.normalizedIdentity].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ownerAgrees(
  candidate: DynamicTargetCandidate,
  owner: ImplementationOwner | undefined,
): boolean {
  return candidate.repoId !== undefined
    && owner?.repoId !== undefined
    && owner.repoId === candidate.repoId;
}

function implementationOwner(db: Db, operationId: number): ImplementationOwner | undefined {
  const rows = db.prepare(
    `SELECT r.id repoId
     FROM graph_edges e JOIN handler_methods hm ON hm.id=CAST(e.to_id AS INTEGER)
     JOIN handler_classes hc ON hc.id=hm.handler_class_id
     JOIN repositories r ON r.id=hc.repo_id
     WHERE e.edge_type='OPERATION_IMPLEMENTED_BY_HANDLER' AND e.status='resolved'
       AND e.from_kind='operation' AND e.from_id=?
     ORDER BY r.id,hm.id,e.id`,
  ).all(String(operationId));
  if (rows.length !== 1) return undefined;
  const row = rows[0];
  if (!row) return undefined;
  return {
    repoId: numberValue(row.repoId),
  };
}

function normalizeIdentity(value: string, npmPackage = false): string {
  const unscoped = npmPackage && /^@[^/]+\/[^/]+$/.test(value)
    ? value.slice(value.indexOf('/') + 1)
    : value;
  return unscoped
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
