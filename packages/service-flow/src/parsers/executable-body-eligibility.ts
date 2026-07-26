import ts from 'typescript';

export type ExecutableBodyEligibilityReason =
  | 'body_present'
  | 'declaration_only'
  | 'ambient_declaration'
  | 'abstract_bodyless'
  | 'overload_signature';

export interface ExecutableBodyEligibilityEvidence {
  eligible: boolean;
  reason: ExecutableBodyEligibilityReason;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    && Boolean(ts.getModifiers(node)?.some((item) => item.kind === kind));
}

export function executableBodyEligibility(
  node: ts.FunctionLikeDeclaration,
  source: ts.SourceFile,
): ExecutableBodyEligibilityEvidence {
  if (node.body) return { eligible: true, reason: 'body_present' };
  if (hasModifier(node, ts.SyntaxKind.AbstractKeyword))
    return { eligible: false, reason: 'abstract_bodyless' };
  if (hasModifier(node, ts.SyntaxKind.DeclareKeyword))
    return { eligible: false, reason: 'ambient_declaration' };
  return {
    eligible: false,
    reason: source.isDeclarationFile
      ? 'declaration_only'
      : 'overload_signature',
  };
}
