import { describe, expect, it } from 'vitest';
import { buildRemoteQueryTarget } from '../../src/linker/remote-query-target.js';

describe('buildRemoteQueryTarget', () => {
  it('builds a static remote entity target', () => {
    expect(buildRemoteQueryTarget({ queryEntity: 'RemoteEntity' })).toMatchObject({ toKind: 'remote_entity', toId: 'RemoteEntity', label: 'Remote entity: RemoteEntity' });
  });

  it('builds an unknown target for dynamic entities', () => {
    const target = buildRemoteQueryTarget({ isDynamic: true });
    expect(target).toMatchObject({ toKind: 'remote_query', toId: 'unknown', label: 'Remote query: unknown' });
    expect(target.evidence.parserWarning).toMatchObject({ code: 'query_entity_unknown' });
  });

  it('includes a known service path in the target', () => {
    expect(buildRemoteQueryTarget({ servicePath: '/ConfigService', queryEntity: 'RemoteEntity' }).label).toBe('Remote entity: /ConfigService:RemoteEntity');
  });

  it('retains alias-only service evidence', () => {
    expect(buildRemoteQueryTarget({ serviceAlias: 'remoteClient', queryEntity: 'RemoteEntity' }).evidence.serviceAlias).toBe('remoteClient');
  });

  it('retains dynamic service expression evidence', () => {
    expect(buildRemoteQueryTarget({ serviceAliasExpr: '${serviceAlias}', isDynamic: true }).evidence.serviceAliasExpr).toBe('${serviceAlias}');
  });
});
