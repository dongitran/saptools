type CallType = 'remote_action' | 'remote_query' | 'remote_entity_read' | 'remote_entity_mutation' | 'remote_entity_delete' | 'remote_entity_media' | 'remote_entity_candidate' | 'local_db_query' | 'external_http' | 'async_emit' | 'async_subscribe' | 'local_service_call' | 'unknown';
interface DiscoveredRepository {
    name: string;
    absolutePath: string;
    relativePath: string;
    isGitRepo: boolean;
}
interface CdsRequire {
    alias: string;
    kind?: string;
    model?: string;
    destination?: string;
    servicePath?: string;
    requestTimeout?: number;
    rawJson: string;
}
interface PackageFacts {
    packageName?: string;
    packageVersion?: string;
    dependencies: Record<string, string>;
    cdsRequires: CdsRequire[];
    scripts: Record<string, string>;
}
interface CdsServiceFact {
    namespace?: string;
    serviceName: string;
    qualifiedName: string;
    servicePath: string;
    isExtend: boolean;
    sourceFile: string;
    sourceLine: number;
    operations: CdsOperationFact[];
}
interface CdsOperationFact {
    operationType: 'action' | 'function' | 'event';
    operationName: string;
    operationPath: string;
    paramsJson: string;
    returnType?: string;
    sourceFile: string;
    sourceLine: number;
}
interface HandlerClassFact {
    className: string;
    sourceFile: string;
    sourceLine: number;
    methods: HandlerMethodFact[];
}
interface HandlerMethodFact {
    methodName: string;
    decoratorKind: string;
    decoratorValue?: string;
    decoratorRawExpression: string;
    sourceFile: string;
    sourceLine: number;
}
interface HandlerRegistrationFact {
    className?: string;
    importSource?: string;
    registrationFile: string;
    registrationLine: number;
    registrationKind: string;
    confidence: number;
}
interface ServiceBindingFact {
    variableName: string;
    alias?: string;
    aliasExpr?: string;
    destinationExpr?: string;
    servicePathExpr?: string;
    isDynamic: boolean;
    placeholders: string[];
    sourceFile: string;
    sourceLine: number;
    helperChain?: Array<Record<string, unknown>>;
}
interface OutboundCallFact {
    callType: CallType;
    sourceSymbolQualifiedName?: string;
    localServiceName?: string;
    localServiceLookup?: string;
    aliasChain?: string[];
    serviceVariableName?: string;
    method?: string;
    operationPathExpr?: string;
    queryEntity?: string;
    eventNameExpr?: string;
    payloadSummary?: string;
    sourceFile: string;
    sourceLine: number;
    confidence: number;
    unresolvedReason?: string;
    evidence?: Record<string, unknown>;
    externalTarget?: {
        kind: string;
        stableId: string;
        label: string;
        dynamic: boolean;
    };
}
interface GeneratedConstantFact {
    name: string;
    value: string;
    sourceFile: string;
    sourceLine: number;
}
interface TraceStart {
    repo?: string;
    servicePath?: string;
    operation?: string;
    operationPath?: string;
    handler?: string;
}
interface TraceEdge {
    step: number;
    type: string;
    from: string;
    to: string;
    evidence: Record<string, unknown>;
    confidence: number;
    unresolvedReason?: string;
}
interface TraceResult {
    start: TraceStart;
    nodes: Array<Record<string, unknown>>;
    edges: TraceEdge[];
    diagnostics: Array<Record<string, unknown>>;
}

declare function discoverRepositories(rootPath: string, ignore: readonly string[]): Promise<DiscoveredRepository[]>;

declare function parsePackageJson(repoPath: string): Promise<PackageFacts>;

declare function parseCdsFile(repoPath: string, filePath: string): Promise<CdsServiceFact[]>;

declare function parseDecorators(repoPath: string, filePath: string): Promise<HandlerClassFact[]>;

declare function parseHandlerRegistrations(repoPath: string, filePath: string): Promise<HandlerRegistrationFact[]>;

declare function parseServiceBindings(repoPath: string, filePath: string): Promise<ServiceBindingFact[]>;

declare function parseOutboundCalls(repoPath: string, filePath: string): Promise<OutboundCallFact[]>;

declare function parseGeneratedConstants(repoPath: string, filePath: string): Promise<GeneratedConstantFact[]>;

interface Statement {
    run: (...params: unknown[]) => {
        changes: number;
    };
    get: (...params: unknown[]) => Record<string, unknown> | undefined;
    all: (...params: unknown[]) => Array<Record<string, unknown>>;
}
interface Db {
    path: string;
    readonly: boolean;
    exec: (sql: string) => void;
    prepare: (sql: string) => Statement;
    pragma: (sql: string) => Array<Record<string, unknown>>;
    transaction: <T>(fn: () => T) => T;
    close: () => void;
}

interface LinkWorkspaceResult {
    edgeCount: number;
    unresolvedCount: number;
    resolvedCount: number;
    remoteResolvedCount: number;
    localResolvedCount: number;
    ambiguousCount: number;
    dynamicCount: number;
    terminalCount: number;
    dependencyResolvedCount: number;
    dependencyAmbiguousCount: number;
    implementationResolvedCount: number;
    implementationAmbiguousCount: number;
    implementationUnresolvedCount: number;
}
declare function linkWorkspace(db: Db, workspaceId: number, vars?: Record<string, string>): LinkWorkspaceResult;

interface RuntimeSubstitution {
    original?: string;
    effective?: string;
    placeholders: string[];
    missing: string[];
    supplied: string[];
    changed: boolean;
}
declare function applyVariables(template: string | undefined, vars: Record<string, string>): string | undefined;
declare function extractPlaceholders(template: string | undefined): string[];
declare function substituteVariables(template: string | undefined, vars: Record<string, string>): RuntimeSubstitution;

declare function trace(db: Db, start: TraceStart, options: {
    depth: number;
    vars?: Record<string, string>;
    includeExternal?: boolean;
    includeDb?: boolean;
    includeAsync?: boolean;
}): TraceResult;

declare function redactText(text: string): string;
declare function redactValue(value: unknown): unknown;

export { type RuntimeSubstitution, applyVariables, discoverRepositories, extractPlaceholders, linkWorkspace, parseCdsFile, parseDecorators, parseGeneratedConstants, parseHandlerRegistrations, parseOutboundCalls, parsePackageJson, parseServiceBindings, redactText, redactValue, substituteVariables, trace };
