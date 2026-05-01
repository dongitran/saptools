import type { InspectorSession } from "../inspector.js";
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

export function selectScopes(scopeChain: CallFrameInfo["scopeChain"]): CallFrameInfo["scopeChain"] {
  const eligible = scopeChain.filter((scope) => scope.objectId !== undefined && scope.type !== "global");
  return [...eligible]
    .sort((a, b) => priorityOf(a.type) - priorityOf(b.type))
    .slice(0, MAX_SCOPES);
}

function priorityOf(type: string): number {
  return PRIORITY_BY_TYPE[type] ?? Number.MAX_SAFE_INTEGER;
}

export async function captureScopes(
  session: InspectorSession,
  frame: CallFrameInfo,
  maxValueLength: number,
): Promise<readonly ScopeSnapshot[]> {
  const scopes = selectScopes(frame.scopeChain);
  return await Promise.all(
    scopes.map(async (scope): Promise<ScopeSnapshot> => {
      const objectId = scope.objectId;
      if (objectId === undefined) {
        return { type: scope.type, variables: [] };
      }
      try {
        const variables = await captureProperties(
          session,
          objectId,
          MAX_SCOPE_VARIABLES,
          MAX_VARIABLE_DEPTH,
          maxValueLength,
        );
        return { type: scope.type, variables };
      } catch {
        return { type: scope.type, variables: [] };
      }
    }),
  );
}
