import { describe, expect, it } from 'vitest';
import { substituteVariables } from '../../src/linker/dynamic-edge-resolver.js';
import { resolveOperation } from '../../src/linker/service-resolver.js';
import { openDatabase } from '../../src/db/connection.js';
import { schemaSql } from '../../src/db/schema.js';

describe('runtime substitution and resolution correctness', () => {
  it('keeps partial substitutions dynamic with missing placeholder names', () => {
    const result = substituteVariables('/svc/${tenant}/${operation}', {
      tenant: 'alpha',
    });
    expect(result.effective).toBe('/svc/alpha/${operation}');
    expect(result.supplied).toEqual(['tenant']);
    expect(result.missing).toEqual(['operation']);
  });

  it('clamps explicit runtime confidence to one', () => {
    const db = openDatabase(':memory:');
    db.exec(schemaSql);
    db.prepare("INSERT INTO workspaces(id,root_path,db_path,created_at,updated_at) VALUES(1,'/w',':memory:','n','n')").run();
    db.prepare("INSERT INTO repositories(id,workspace_id,name,absolute_path,relative_path,kind,is_git_repo) VALUES(1,1,'model','/w/model','model','cap-service',0)").run();
    db.prepare("INSERT INTO cds_services(id,repo_id,service_name,qualified_name,service_path,is_extend,source_file,source_line) VALUES(1,1,'SyntheticService','SyntheticService','/synthetic',0,'srv/synthetic.cds',1)").run();
    db.prepare("INSERT INTO cds_operations(service_id,operation_type,operation_name,operation_path,params_json,source_file,source_line) VALUES(1,'action','run','/run','[]','srv/synthetic.cds',2)").run();
    const resolution = resolveOperation(db, {
      servicePath: '/synthetic',
      operationPath: '/run',
      hasExplicitOverride: true,
      isDynamic: true,
    }, 1);
    expect(resolution.target?.score).toBe(1);
    db.close();
  });
});

import ts from 'typescript';
import { classifyOutboundCallsInSource } from '../../src/parsers/outbound-call-parser.js';

describe('expression placeholder substitution', () => {
  it('supports simple and expression placeholder keys without evaluating expressions', () => {
    const result = substituteVariables('/${domain}/${domainInfo.serviceName}/${domainInfo.shortName?.toLowerCase()}/${items[0].service}/${makeKey()}/${domainInfo.serviceName}', {
      domain: 'main',
      'domainInfo.serviceName': 'Catalog',
      'domainInfo.shortName?.toLowerCase()': 'cat',
      'items[0].service': 'Item',
      'makeKey()': 'made',
    });
    expect(result.placeholders).toEqual(['domain', 'domainInfo.serviceName', 'domainInfo.shortName?.toLowerCase()', 'items[0].service', 'makeKey()']);
    expect(result.missing).toEqual([]);
    expect(result.effective).toBe('/main/Catalog/cat/Item/made/Catalog');
  });

  it('reports missing expression placeholder keys', () => {
    const result = substituteVariables('/${domainInfo.serviceName}Service', {});
    expect(result.missing).toEqual(['domainInfo.serviceName']);
    expect(result.effective).toBe('/${domainInfo.serviceName}Service');
  });
});

describe('remote action dynamic path parser evidence', () => {
  it('records shorthand path as a dynamic operation path identifier', () => {
    const source = ts.createSourceFile('handler.ts', `async function run(client, path) { await client.send({ method: 'GET', path }); }`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const [call] = classifyOutboundCallsInSource(source, 'handler.ts');
    expect(call?.fact.operationPathExpr).toBeUndefined();
    expect(call?.fact.unresolvedReason).toBe('dynamic_operation_path_identifier');
    expect(call?.fact.evidence).toMatchObject({ operationPathExpression: 'path', parserWarning: 'dynamic_operation_path_identifier' });
  });
});
