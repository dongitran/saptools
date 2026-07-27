import type { Db } from '../db/connection.js';
import { linkHelperPackages } from './helper-package-linker.js';
import { linkImplementations as linkCanonicalImplementations } from './implementation-candidates.js';
import { linkPackageImportSymbolCalls } from './package-import-symbol-resolver.js';
import { linkEventSubscriptionHandlers } from './event-subscription-handler-linker.js';
import { insertCallEdge } from './call-edge-insertion.js';
import { linkEventShapeCandidates } from './event-shape-candidate-linker.js';
import { assertWorkspaceLinkable } from '../db/fact-lifecycle.js';
import { linkPackageEventConstants } from
  './package-event-constant-resolver.js';
export interface LinkWorkspaceResult {
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
  subscriptionHandlerResolvedCount: number;
  subscriptionHandlerAmbiguousCount: number;
  subscriptionHandlerUnresolvedCount: number;
  subscriptionHandlerMissingAssociationCount: number;
  eventShapeCandidateCount: number;
  eventShapeCandidateOmittedCount: number;
}
export function linkWorkspace(db: Db, workspaceId: number, vars: Record<string, string> = {}): LinkWorkspaceResult {
  return db.transaction(() => {
    assertWorkspaceLinkable(db, workspaceId);
    linkPackageImportSymbolCalls(db, workspaceId);
    linkPackageEventConstants(db, workspaceId);
    assertWorkspaceLinkable(db, workspaceId, 'terminal');
    const generation = nextGraphGeneration(db, workspaceId);
    db.prepare('DELETE FROM graph_edges WHERE workspace_id=?').run(workspaceId);
    const deps = linkHelperPackages(db, workspaceId, generation);
    const subscriptions = linkEventSubscriptionHandlers(
      db, workspaceId, generation, vars,
    );
    const eventShapes = linkEventShapeCandidates(
      db, workspaceId, generation,
    );
    const impl = linkCanonicalImplementations(db, workspaceId, generation);
    const callSummary = linkCalls(db, workspaceId, vars, generation);
    db.prepare("UPDATE repositories SET graph_generation=?, graph_stale_reason=NULL, graph_stale_at=NULL WHERE workspace_id=?").run(generation, workspaceId);
    return { ...callSummary, edgeCount: deps.edgeCount + callSummary.edgeCount + impl.edgeCount + subscriptions.edgeCount + eventShapes.edgeCount, dependencyResolvedCount: deps.resolvedCount, dependencyAmbiguousCount: deps.ambiguousCount, implementationResolvedCount: impl.resolvedCount, implementationAmbiguousCount: impl.ambiguousCount, implementationUnresolvedCount: impl.unresolvedCount, subscriptionHandlerResolvedCount: subscriptions.resolvedCount, subscriptionHandlerAmbiguousCount: subscriptions.ambiguousCount, subscriptionHandlerUnresolvedCount: subscriptions.unresolvedCount, subscriptionHandlerMissingAssociationCount: subscriptions.missingAssociationCount, eventShapeCandidateCount: eventShapes.edgeCount, eventShapeCandidateOmittedCount: eventShapes.omittedCount };
  });
}
function nextGraphGeneration(db: Db, workspaceId: number): number {
  const row = db.prepare('SELECT COALESCE(MAX(graph_generation),0) generation FROM repositories WHERE workspace_id=?').get(workspaceId) as { generation?: number } | undefined;
  return Number(row?.generation ?? 0) + 1;
}
type CallLinkSummary = Omit<LinkWorkspaceResult,
  | 'dependencyResolvedCount'
  | 'dependencyAmbiguousCount'
  | 'implementationResolvedCount'
  | 'implementationAmbiguousCount'
  | 'implementationUnresolvedCount'
  | 'subscriptionHandlerResolvedCount'
  | 'subscriptionHandlerAmbiguousCount'
  | 'subscriptionHandlerUnresolvedCount'
  | 'subscriptionHandlerMissingAssociationCount'
  | 'eventShapeCandidateCount'
  | 'eventShapeCandidateOmittedCount'>;

function linkCalls(db: Db, workspaceId: number, vars: Record<string, string>, generation: number): CallLinkSummary {
  let edgeCount = 0;
  let unresolvedCount = 0;
  let resolvedCount = 0;
  let remoteResolvedCount = 0;
  let localResolvedCount = 0;
  let ambiguousCount = 0;
  let dynamicCount = 0;
  let terminalCount = 0;
  const calls = db.prepare(`SELECT c.*,r.name repoName,
    r.environment_declarations_json environmentDeclarationsJson,
    b.id selectedBindingId,b.alias,b.alias_expr aliasExpr,
    b.destination_expr destinationExpr,b.service_path_expr servicePathExpr,
    b.is_dynamic isDynamic,b.placeholders_json placeholdersJson,
    b.source_file bindingSourceFile,b.source_line bindingSourceLine,
    b.helper_chain_json helperChainJson,req.service_path requireServicePath,
    req.destination requireDestination
    FROM outbound_calls c JOIN repositories r ON r.id=c.repo_id
    LEFT JOIN service_bindings b ON b.id=c.service_binding_id
    LEFT JOIN cds_requires req ON req.repo_id=c.repo_id AND req.alias=b.alias
    WHERE r.workspace_id=?`).all(
    workspaceId,
  ) as Array<Record<string, unknown>>;
  for (const call of calls) {
    const result = insertCallEdge(db, workspaceId, call, vars, generation);
    edgeCount += 1;
    resolvedCount += result.status === 'resolved' ? 1 : 0;
    remoteResolvedCount += result.status === 'resolved' && result.callType !== 'local_service_call' ? 1 : 0;
    localResolvedCount += result.status === 'resolved' && result.callType === 'local_service_call' ? 1 : 0;
    unresolvedCount += result.status === 'unresolved' ? 1 : 0;
    ambiguousCount += result.status === 'ambiguous' ? 1 : 0;
    dynamicCount += result.status === 'dynamic' ? 1 : 0;
    terminalCount += result.status === 'terminal' ? 1 : 0;
  }
  return { edgeCount, unresolvedCount, resolvedCount, remoteResolvedCount, localResolvedCount, ambiguousCount, dynamicCount, terminalCount };
}
