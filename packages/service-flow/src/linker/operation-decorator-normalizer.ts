export type DecoratorOperationSignal =
  | { status: 'resolved'; operationName: string; raw?: string }
  | { status: 'none'; raw?: string }
  | { status: 'unsupported'; raw: string; reason: string }
  | { status: 'malformed'; raw: string; reason: string };
export function normalizedOperationName(value: string): string {
  return value.replace(/^\//, '');
}
function clean(value: string): string {
  return value.replace(/^[`'"]|[`'"]$/g, '');
}

function resolved(value: string, raw?: string): DecoratorOperationSignal {
  const literal = clean(value);
  return {
    status: 'resolved',
    operationName: normalizedOperationName(literal),
    raw,
  };
}
export function normalizeDecoratorOperationSignal(value: string | undefined, raw: string | undefined, candidateOperation?: string): DecoratorOperationSignal {
  if (value) return resolved(value, raw);
  if (!raw || raw.trim().length === 0) return { status: 'none', raw };
  const expression = raw.trim();
  const stringMatch = /^String\(([A-Za-z_$][\w$]*)\)$/.exec(expression);
  if (stringMatch?.[1]) {
    const identifier = stringMatch[1];
    const normalizedCandidate = candidateOperation
      ? normalizedOperationName(candidateOperation) : undefined;
    if (normalizedCandidate && identifier === normalizedCandidate)
      return {
        status: 'resolved', operationName: identifier, raw: expression,
      };
    return { status: 'unsupported', raw: expression, reason: 'string_wrapper_identifier_not_resolved' };
  }
  if (/^[`'"]/.test(expression) && !/[`'"]$/.test(expression)) return { status: 'malformed', raw: expression, reason: 'unterminated_literal' };
  return { status: 'unsupported', raw: expression, reason: 'unsupported_decorator_expression' };
}
export function normalizeDecoratorOperation(value: string | undefined, raw: string | undefined): string | undefined {
  const signal = normalizeDecoratorOperationSignal(value, raw);
  return signal.status === 'resolved' ? signal.operationName : undefined;
}
