import type { InspectorSession } from "../inspector/types.js";
import type { CallFrameInfo, ScopeSnapshot } from "../types.js";

import {
  captureProperties,
  MAX_SCOPE_VARIABLES,
  MAX_VARIABLE_DEPTH,
} from "./properties.js";

const MAX_SCOPES = 3;

const PRIORITY_BY_TYPE: Readonly<Record<string, number>> = {
  local: 0,
  arguments: 1,
  block: 2,
  closure: 3,
  catch: 4,
  with: 5,
  module: 6,
  script: 7,
};

export interface CapturedScopes {
  readonly scopes: readonly ScopeSnapshot[];
  readonly omittedCount?: number;
}

export function selectScopes(scopeChain: CallFrameInfo["scopeChain"]): CallFrameInfo["scopeChain"] {
  return rankedScopes(scopeChain).slice(0, MAX_SCOPES);
}

function rankedScopes(scopeChain: CallFrameInfo["scopeChain"]): CallFrameInfo["scopeChain"] {
  const eligible = scopeChain.filter((scope) => scope.objectId !== undefined && scope.type !== "global");
  return [...eligible]
    .sort((a, b) => priorityOf(a.type) - priorityOf(b.type));
}

function priorityOf(type: string): number {
  return PRIORITY_BY_TYPE[type] ?? Number.MAX_SAFE_INTEGER;
}

export async function captureScopes(
  session: InspectorSession,
  frame: CallFrameInfo,
  maxValueLength: number,
): Promise<CapturedScopes> {
  const ranked = rankedScopes(frame.scopeChain);
  const scopes = ranked.slice(0, MAX_SCOPES);
  const capturedScopes = await Promise.all(
    scopes.map(async (scope): Promise<ScopeSnapshot> => {
      const objectId = scope.objectId;
      if (objectId === undefined) {
        return { type: scope.type, variables: [] };
      }
      try {
        const captured = await captureProperties(
          session,
          objectId,
          MAX_SCOPE_VARIABLES,
          MAX_VARIABLE_DEPTH,
          maxValueLength,
        );
        const base: ScopeSnapshot = { type: scope.type, variables: captured.variables };
        return captured.omittedCount === undefined
          ? base
          : { ...base, truncated: true, omittedCount: captured.omittedCount };
      } catch {
        return { type: scope.type, variables: [] };
      }
    }),
  );
  const omittedCount = Math.max(ranked.length - capturedScopes.length, 0);
  return omittedCount === 0
    ? { scopes: capturedScopes }
    : { scopes: capturedScopes, omittedCount };
}
