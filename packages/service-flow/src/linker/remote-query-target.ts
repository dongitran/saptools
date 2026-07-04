export interface RemoteQueryTargetInput {
  queryEntity?: unknown;
  servicePath?: string;
  serviceAlias?: unknown;
  serviceAliasExpr?: unknown;
  destination?: string;
  isDynamic?: boolean;
  parserWarning?: unknown;
}

export interface RemoteQueryTarget {
  toKind: 'remote_entity' | 'remote_query';
  toId: string;
  label: string;
  evidence: Record<string, unknown>;
}

export function buildRemoteQueryTarget(input: RemoteQueryTargetInput): RemoteQueryTarget {
  const entity = typeof input.queryEntity === 'string' && input.queryEntity.trim() ? input.queryEntity.trim() : undefined;
  const servicePath = input.servicePath?.trim();
  const prefix = servicePath ? `${servicePath}:` : '';
  const label = entity ? `Remote entity: ${prefix}${entity}` : 'Remote query: unknown';
  return {
    toKind: entity ? 'remote_entity' : 'remote_query',
    toId: entity ? `${prefix}${entity}` : 'unknown',
    label,
    evidence: {
      remoteQueryTarget: label,
      queryEntity: entity,
      queryTargetKind: entity ? 'remote_entity' : 'remote_query_unknown',
      queryEntityDynamic: entity ? undefined : Boolean(input.isDynamic) || undefined,
      serviceAlias: input.serviceAlias,
      serviceAliasExpr: input.serviceAliasExpr,
      destination: input.destination,
      servicePath,
      parserWarning: entity ? input.parserWarning : input.parserWarning ?? { code: 'query_entity_unknown', message: 'Remote query entity is dynamic or unavailable' },
    },
  };
}
