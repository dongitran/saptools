function lowerFirst(value: string): string {
  return value ? `${value[0]?.toLowerCase() ?? ''}${value.slice(1)}` : value;
}
export function normalizedOperationName(value: string): string {
  return value.replace(/^\//, '');
}
function clean(value: string): string {
  return value.replace(/^[`'"]|[`'"]$/g, '');
}
function generatedFromConstantName(value: string): string | undefined {
  for (const prefix of ['Action', 'Func']) {
    if (value.startsWith(prefix) && value.length > prefix.length && /^[A-Z]/.test(value.slice(prefix.length))) return lowerFirst(value.slice(prefix.length));
  }
  return undefined;
}
export function normalizeDecoratorOperation(value: string | undefined, raw: string | undefined): string | undefined {
  if (value) {
    const literal = clean(value);
    const generated = generatedFromConstantName(literal);
    return generated ?? normalizedOperationName(literal);
  }
  if (!raw) return undefined;
  const expression = raw.trim();
  const nameMatch = /(?:^|\.)(Action[A-Z][\w$]*|Func[A-Z][\w$]*)\.name$/.exec(expression);
  if (nameMatch?.[1]) return generatedFromConstantName(nameMatch[1]);
  const tail = expression.split('.').filter(Boolean).at(-1);
  return tail ? normalizedOperationName(clean(tail)) : undefined;
}
