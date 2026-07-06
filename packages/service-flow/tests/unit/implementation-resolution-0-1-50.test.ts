import { cp, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { doctorDiagnostics } from '../../src/cli/doctor.js';
import { schemaVersion } from '../../src/db/migrations.js';
import { linkWorkspace, parseDecorators, trace } from '../../src/index.js';
import type { HandlerMethodFact } from '../../src/types.js';
import { prepareWorkspace, writeFixtureFile } from './test-workspace.js';

type Row = Record<string, unknown>;

const fixture = path.resolve(
  'tests/fixtures/implementation-resolution-workspace',
);

function objectValue(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Row
    : {};
}

function arrayValue(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((item): item is Row =>
        Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
}

async function prepareFixtureWorkspace(): ReturnType<typeof prepareWorkspace> {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), 'service-flow-implementation-resolution-'),
  );
  const workspace = path.join(tempRoot, 'workspace');
  await cp(fixture, workspace, { recursive: true });
  return prepareWorkspace(workspace);
}

async function parseDecoratorMethods(): Promise<Map<string, HandlerMethodFact>> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'service-flow-decorator-members-'),
  );
  await writeFixtureFile(root, 'handler.ts', `
    import { Action, Func, Handler } from 'cds-routing-handlers';
    const directName = 'directCheck';
    enum OperationName {
      run = 'enumCheck',
      name = 'renamedEnumCheck',
    }
    const OperationObject = { plain: 'objectCheck' };
    const ConstantObject = { frozen: 'constantObjectCheck' } as const;
    const DynamicObject = loadOperationNames();
    @Handler()
    export class QualityHandler {
      @Func('literalCheck') async literalCheck(): Promise<void> {}
      @Func(\`templateCheck\`) async templateCheck(): Promise<void> {}
      @Func(directName) async directCheck(): Promise<void> {}
      @Func(OperationName.run) async enumCheck(): Promise<void> {}
      @Func(OperationName.name) async renamedEnumCheck(): Promise<void> {}
      @Func(OperationObject.plain) async objectCheck(): Promise<void> {}
      @Func(ConstantObject.frozen) async constantObjectCheck(): Promise<void> {}
      @Func(FuncGeneratedCheck.name) async generatedCheck(): Promise<void> {}
      @Action(api.ActionDeepCheck.name) async deepCheck(): Promise<void> {}
      @Func(DynamicObject.current) async dynamicCheck(): Promise<void> {}
    }
  `);
  const methods = (await parseDecorators(root, 'handler.ts'))[0]?.methods ?? [];
  return new Map(methods.map((method) => [method.methodName, method]));
}

describe('decorator literal operation resolution', () => {
  it('resolves string and no-substitution template literals', async () => {
    const byMethod = await parseDecoratorMethods();
    expect(byMethod.get('literalCheck')).toMatchObject({
      decoratorValue: 'literalCheck',
      decoratorResolution: {
        resolutionKind: 'literal',
        resolvedValue: 'literalCheck',
      },
    });
    expect(byMethod.get('templateCheck')).toMatchObject({
      decoratorValue: 'templateCheck',
      decoratorResolution: {
        resolutionKind: 'literal',
        resolvedValue: 'templateCheck',
      },
    });
  });
});

describe('decorator local operation resolution', () => {
  it('resolves const identifiers and string enum members', async () => {
    const byMethod = await parseDecoratorMethods();
    expect(byMethod.get('directCheck')?.decoratorResolution).toMatchObject({
      resolutionKind: 'const_identifier',
      resolvedValue: 'directCheck',
    });
    expect(byMethod.get('enumCheck')?.decoratorResolution).toMatchObject({
      resolutionKind: 'enum_member',
      resolvedValue: 'enumCheck',
    });
    expect(byMethod.get('renamedEnumCheck')).toMatchObject({
      decoratorValue: 'renamedEnumCheck',
      decoratorRawExpression: 'OperationName.name',
      decoratorResolution: {
        resolutionKind: 'enum_member',
        resolvedValue: 'renamedEnumCheck',
      },
    });
  });

  it('resolves const object properties and preserves unsupported members', async () => {
    const byMethod = await parseDecoratorMethods();
    expect(byMethod.get('objectCheck')?.decoratorResolution).toMatchObject({
      resolutionKind: 'const_object_property',
      resolvedValue: 'objectCheck',
    });
    expect(byMethod.get('constantObjectCheck')?.decoratorResolution).toMatchObject({
      resolutionKind: 'const_object_property',
      resolvedValue: 'constantObjectCheck',
    });
    expect(byMethod.get('dynamicCheck')).toMatchObject({
      decoratorValue: undefined,
      decoratorRawExpression: 'DynamicObject.current',
      decoratorResolution: {
        resolutionKind: 'unresolved',
        unresolvedReason: 'property_access_not_resolved_to_local_string',
      },
    });
  });
});

describe('decorator generated operation constants', () => {
  it('records generated action and function constants as resolved evidence', async () => {
    const byMethod = await parseDecoratorMethods();
    expect(byMethod.get('generatedCheck')).toMatchObject({
      decoratorValue: 'generatedCheck',
      decoratorRawExpression: 'FuncGeneratedCheck.name',
      decoratorResolution: {
        resolutionKind: 'generated_constant_name',
        resolvedValue: 'generatedCheck',
      },
    });
    expect(byMethod.get('deepCheck')?.decoratorResolution).toMatchObject({
      resolutionKind: 'generated_constant_name',
      resolvedValue: 'deepCheck',
    });
  });
});

describe('enum decorator implementation linking', () => {
  it('persists enum decorator values and links their implementation', async () => {
    const { db, workspaceId } = await prepareFixtureWorkspace();
    linkWorkspace(db, workspaceId);
    expect(schemaVersion(db)).toBe(10);
    const decorator = db.prepare(`
      SELECT hm.decorator_value decoratorValue,
        hm.decorator_raw_expression decoratorRawExpression,
        hm.decorator_resolution_json decoratorResolutionJson
      FROM handler_methods hm
      WHERE hm.method_name='runQualityCheck'
    `).get() as {
      decoratorValue?: string;
      decoratorRawExpression?: string;
      decoratorResolutionJson?: string;
    };
    expect(decorator).toMatchObject({
      decoratorValue: 'runQualityCheck',
      decoratorRawExpression: 'OperationName.name',
    });
    expect(JSON.parse(decorator.decoratorResolutionJson ?? '{}')).toMatchObject({
      resolutionKind: 'enum_member',
      resolvedValue: 'runQualityCheck',
    });

    const qualityEdge = implementationEdge(db, 'runQualityCheck');
    expect(qualityEdge.status).toBe('resolved');
    expect(JSON.stringify(qualityEdge.evidence)).not.toContain(
      'method_name_matches_but_decorator_targets_different_operation',
    );
    db.close();
  });
});

describe('implementation registration ownership', () => {
  it('excludes synthetic registration pairs but keeps genuine ambiguity', async () => {
    const { db, workspaceId } = await prepareFixtureWorkspace();
    linkWorkspace(db, workspaceId);
    const exactEdge = implementationEdge(db, 'runExactCheck');
    expect(exactEdge.status).toBe('resolved');
    const exactCandidates = arrayValue(exactEdge.evidence.candidates);
    expect(exactCandidates).toHaveLength(1);
    expect(objectValue(exactCandidates[0]?.handlerPackage).name).toBe('helper-a');
    expect(arrayValue(exactCandidates[0]?.registrations)).toHaveLength(1);
    expect(exactCandidates[0]?.registrationPairing).toMatchObject({
      strategy: 'exact_handler_class_id',
      invariantStatus: 'valid',
    });

    const sharedEdge = implementationEdge(db, 'runSharedCheck');
    expect(sharedEdge.status).toBe('ambiguous');
    const sharedCandidates = arrayValue(sharedEdge.evidence.candidates);
    expect(sharedCandidates).toHaveLength(2);
    expect(sharedCandidates.every((candidate) =>
      arrayValue(candidate.registrations).length === 1)).toBe(true);
    for (const candidate of sharedCandidates) {
      const application = objectValue(candidate.applicationPackage);
      const handler = objectValue(candidate.handlerPackage);
      expect(application.id).toBe(handler.id);
      expect(candidate.registrationPairing).toMatchObject({
        strategy: 'exact_handler_class_id',
        invariantStatus: 'valid',
      });
    }
    expect(arrayValue(sharedEdge.evidence.implementationHintSuggestions)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ implementationRepo: 'helper-a' }),
        expect.objectContaining({ implementationRepo: 'helper-b' }),
      ]),
    );
    db.close();
  });
});

describe('scoped implementation hints', () => {
  it('continues through a genuinely ambiguous implementation with a scoped hint', async () => {
    const { db, workspaceId } = await prepareFixtureWorkspace();
    linkWorkspace(db, workspaceId);
    const guided = trace(db, {
      repo: 'process-model',
      servicePath: '/EntityAProcessService',
      operation: 'runSharedCheck',
    }, {
      depth: 6,
      includeDb: true,
      implementationHints: [{
        servicePath: '/EntityAProcessService',
        operationPath: '/runSharedCheck',
        implementationRepo: 'helper-a',
      }],
    });
    expect(guided.edges.some((edge) =>
      edge.type === 'local_db_query'
      && edge.to === 'Entity: SharedResultsA')).toBe(true);
    expect(guided.edges.filter((edge) => edge.unresolvedReason)).toEqual([]);
    db.close();
  });
});

describe('implementation trace behavior', () => {
  it('traces enum implementations and runtime-selected services end to end', async () => {
    const { db, workspaceId } = await prepareFixtureWorkspace();
    linkWorkspace(db, workspaceId);

    const runtime = trace(db, {
      repo: 'gateway-app',
      servicePath: '/GatewayService',
      operation: 'runGatewayCheck',
    }, {
      depth: 12,
      includeDb: true,
      includeExternal: true,
      includeAsync: true,
      vars: { entityType: 'EntityA', entityShortName: 'ea' },
    });
    expect(runtime.edges.some((edge) =>
      edge.to === '/QualityService/runQualityCheck')).toBe(true);
    expect(runtime.edges.some((edge) =>
      edge.to === '/EntityAProcessService/runExactCheck')).toBe(true);
    expect(runtime.edges.some((edge) =>
      edge.to.includes('RunQualityCheckHandler.runQualityCheck'))).toBe(true);
    expect(runtime.edges.some((edge) =>
      edge.type === 'local_db_query'
      && edge.to === 'Entity: QualityRecords')).toBe(true);
    expect(runtime.edges.filter((edge) => edge.unresolvedReason)).toEqual([]);

    const missing = trace(db, {
      repo: 'gateway-app',
      servicePath: '/GatewayService',
      operation: 'runGatewayCheck',
    }, { depth: 12, includeDb: true });
    expect(missing.diagnostics).toContainEqual(expect.objectContaining({
      code: 'trace_runtime_variables_missing',
      missingVariables: ['entityShortName', 'entityType'],
      suggestions: [
        '--var entityShortName=<value>',
        '--var entityType=<value>',
      ],
    }));
    db.close();
  });
});

describe('handler trace behavior', () => {
  it('starts from the enum-decorated handler and includes local database reads', async () => {
    const { db, workspaceId } = await prepareFixtureWorkspace();
    linkWorkspace(db, workspaceId);
    const handlerTrace = trace(db, {
      repo: 'quality-service',
      handler: 'RunQualityCheckHandler',
    }, { depth: 8, includeDb: true });
    expect(handlerTrace.edges.some((edge) =>
      edge.type === 'local_db_query'
      && edge.to === 'Entity: QualityRecords')).toBe(true);
    db.close();
  });
});

describe('implementation doctor diagnostics', () => {
  it('separates unresolved decorators, prevented synthetic pairs, and genuine ambiguity in doctor', async () => {
    const { db, workspaceId } = await prepareFixtureWorkspace();
    linkWorkspace(db, workspaceId);
    const diagnostics = doctorDiagnostics(db, true, { detail: true });

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'strict_decorator_resolution_quality',
      unresolvedExpressions: 1,
    }));
    const decoratorQuality = diagnostics.find((item) =>
      item.code === 'strict_decorator_resolution_quality');
    expect(Number(decoratorQuality?.resolvedFromConstants)).toBeGreaterThan(0);
    expect(arrayValue(decoratorQuality?.unresolvedExamples)).toContainEqual(
      expect.objectContaining({
        methodName: 'runDynamicCheck',
        rawExpression: 'dynamicOperationName()',
      }),
    );

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'strict_handler_registration_pairing_quality',
      mismatchedExactRegistrations: 0,
    }));
    const pairingQuality = diagnostics.find((item) =>
      item.code === 'strict_handler_registration_pairing_quality');
    expect(Number(
      pairingQuality?.preventedSyntheticCrossRepositoryPairs,
    )).toBeGreaterThan(0);

    const implementationQuality = diagnostics.find((item) =>
      item.code === 'strict_implementation_candidate_quality');
    expect(arrayValue(implementationQuality?.categories)).toContainEqual(
      expect.objectContaining({
        category: 'duplicate_package_name_candidates',
        candidateFamily: '@neutral/process-helper',
      }),
    );
    expect(JSON.stringify(implementationQuality)).not.toContain(
      'UnregisteredExactResults',
    );
    db.close();
  });
});

describe('operation-only trace start remediation', () => {
  it('returns copyable service and path selectors without guessing a service', async () => {
    const { db, workspaceId } = await prepareFixtureWorkspace();
    linkWorkspace(db, workspaceId);

    const ambiguous = trace(db, {
      repo: 'quality-service',
      operation: 'getUserScope',
    }, { depth: 5 });
    expect(ambiguous.edges).toEqual([]);
    expect(ambiguous.diagnostics).toContainEqual(expect.objectContaining({
      code: 'trace_start_ambiguous',
      selectorSuggestions: [
        '--service /ProfileService --path /getUserScope',
        '--service /SystemService --path /getUserScope',
      ],
    }));
    const candidates = arrayValue(ambiguous.diagnostics[0]?.candidates);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) =>
      candidate.sourceFile === 'srv/quality.cds'
      && typeof candidate.sourceLine === 'number')).toBe(true);

    const explicit = trace(db, {
      repo: 'quality-service',
      servicePath: '/SystemService',
      operationPath: '/getUserScope',
    }, { depth: 5 });
    expect(explicit.diagnostics).toEqual([]);
    expect(explicit.edges.some((edge) =>
      edge.type === 'operation_implemented_by_handler')).toBe(true);
    expect(explicit.edges.filter((edge) => edge.unresolvedReason)).toEqual([]);
    db.close();
  });
});

function implementationEdge(
  db: Awaited<ReturnType<typeof prepareWorkspace>>['db'],
  operationName: string,
): { status?: string; evidence: Row } {
  const row = db.prepare(`
    SELECT e.status,e.evidence_json evidenceJson
    FROM graph_edges e
    JOIN cds_operations o ON o.id=CAST(e.from_id AS INTEGER)
    WHERE e.edge_type='OPERATION_IMPLEMENTED_BY_HANDLER'
      AND o.operation_name=?
    ORDER BY e.id
    LIMIT 1
  `).get(operationName) as { status?: string; evidenceJson?: string };
  return {
    status: row.status,
    evidence: JSON.parse(row.evidenceJson ?? '{}') as Row,
  };
}
