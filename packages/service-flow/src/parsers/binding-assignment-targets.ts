import ts from 'typescript';

export interface BindingAssignmentEntry {
  variableName: string;
  arrayIndex?: number;
  unsupported?: boolean;
}

function unsupported(
  entries: readonly BindingAssignmentEntry[],
): BindingAssignmentEntry[] {
  return entries.map((entry) => ({
    ...entry,
    arrayIndex: undefined,
    unsupported: true,
  }));
}

function objectEntries(
  property: ts.ObjectLiteralElementLike,
): BindingAssignmentEntry[] {
  if (ts.isShorthandPropertyAssignment(property))
    return [{ variableName: property.name.text }];
  if (ts.isSpreadAssignment(property))
    return unsupported(bindingAssignmentEntries(property.expression));
  if (!ts.isPropertyAssignment(property)) return [];
  if (ts.isIdentifier(property.initializer))
    return [{ variableName: property.initializer.text }];
  return unsupported(bindingAssignmentEntries(property.initializer));
}

function arrayEntries(
  element: ts.Expression | ts.OmittedExpression,
  arrayIndex: number,
): BindingAssignmentEntry[] {
  if (ts.isOmittedExpression(element)) return [];
  if (ts.isIdentifier(element))
    return [{ variableName: element.text, arrayIndex }];
  return unsupported(bindingAssignmentEntries(element));
}

function assignmentTarget(
  expression: ts.Expression,
): { expression: ts.Expression; unsupported: boolean } {
  if (ts.isParenthesizedExpression(expression))
    return assignmentTarget(expression.expression);
  if (ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression)) {
    const target = assignmentTarget(expression.expression);
    return { expression: target.expression, unsupported: true };
  }
  if (ts.isBinaryExpression(expression)
    && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const target = assignmentTarget(expression.left);
    return { expression: target.expression, unsupported: true };
  }
  return { expression, unsupported: false };
}

export function bindingAssignmentEntries(
  expression: ts.Expression,
): BindingAssignmentEntry[] {
  const target = assignmentTarget(expression);
  let entries: BindingAssignmentEntry[] = [];
  if (ts.isIdentifier(target.expression))
    entries = [{ variableName: target.expression.text }];
  if (ts.isObjectLiteralExpression(target.expression))
    entries = target.expression.properties.flatMap(objectEntries);
  if (ts.isArrayLiteralExpression(target.expression))
    entries = target.expression.elements.flatMap(arrayEntries);
  if (ts.isSpreadElement(target.expression))
    entries = unsupported(bindingAssignmentEntries(target.expression.expression));
  return target.unsupported ? unsupported(entries) : entries;
}
