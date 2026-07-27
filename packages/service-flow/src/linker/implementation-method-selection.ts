import {
  normalizeDecoratorOperationSignal,
  normalizedOperationName,
} from './operation-decorator-normalizer.js';

export type ImplementationSelectionBasis =
  | 'decorator_literal'
  | 'decorator_constant'
  | 'decorator_expression_fallback'
  | 'method_name_fallback';

export interface ImplementationMethodSignal {
  matches: boolean;
  contradicted: boolean;
  selectionBasis?: ImplementationSelectionBasis;
  acceptedReasons: string[];
  rejectedReasons: string[];
}

function serviceOperationNames(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function rawMentionsSiblingOperation(
  row: Record<string, unknown>,
  operation: Record<string, unknown>,
  requested: string,
): boolean {
  const raw = stringValue(row.decoratorRawExpression)?.toLowerCase();
  if (!raw) return false;
  const identifiers = new Set(
    raw.match(/[a-z_$][a-z0-9_$]*/g) ?? [],
  );
  return serviceOperationNames(operation.serviceOperationNames)
    .filter((name) => normalizedOperationName(name) !== requested)
    .some((name) =>
      identifiers.has(normalizedOperationName(name).toLowerCase()));
}

function decoratorSelectionBasis(
  resolution: Record<string, unknown>,
): ImplementationSelectionBasis | undefined {
  if (resolution.resolutionKind === 'literal') return 'decorator_literal';
  return [
    'const_identifier',
    'enum_member',
    'const_object_property',
    'generated_constant_name',
  ].includes(String(resolution.resolutionKind ?? ''))
    ? 'decorator_constant'
    : undefined;
}

function decoratorMethodSignal(
  row: Record<string, unknown>,
  operationName: string,
): ImplementationMethodSignal | undefined {
  const resolution = objectJson(row.decoratorResolutionJson) ?? {};
  const decorator = normalizeDecoratorOperationSignal(
    stringValue(row.decoratorValue),
    stringValue(row.decoratorRawExpression),
    operationName,
  );
  if (decorator.status !== 'resolved') return undefined;
  const selectionBasis = decoratorSelectionBasis(resolution)
    ?? 'decorator_expression_fallback';
  return decorator.operationName === operationName
    ? {
        matches: true, contradicted: false, selectionBasis,
        acceptedReasons: ['decorator targets operation'], rejectedReasons: [],
      }
    : {
        matches: false, contradicted: true, selectionBasis,
        acceptedReasons: [],
        rejectedReasons: [
          'method_name_matches_but_decorator_targets_different_operation',
        ],
      };
}

export function implementationMethodSignal(
  row: Record<string, unknown>,
  operation: Record<string, unknown>,
): ImplementationMethodSignal {
  const resolution = objectJson(row.decoratorResolutionJson) ?? {};
  if (resolution.handlerKind && resolution.handlerKind !== 'operation')
    return rejected('non_operation_handler_kind');
  if (resolution.executable === false)
    return rejected('handler_method_not_executable');
  const operationName = normalizedOperationName(String(
    operation.operationPath ?? operation.operationName ?? '',
  ));
  const decorator = decoratorMethodSignal(row, operationName);
  if (decorator) return decorator;
  if (String(row.methodName ?? '') !== operationName)
    return rejected('method name does not match operation', false);
  if (rawMentionsSiblingOperation(row, operation, operationName))
    return {
      ...rejected('method_name_fallback_conflicts_with_sibling_operation'),
      selectionBasis: 'method_name_fallback',
    };
  return {
    matches: true,
    contradicted: false,
    selectionBasis: 'method_name_fallback',
    acceptedReasons: ['method name fallback matched operation'],
    rejectedReasons: [],
  };
}

function rejected(
  reason: string,
  contradicted = true,
): ImplementationMethodSignal {
  return {
    matches: false, contradicted, acceptedReasons: [],
    rejectedReasons: [reason],
  };
}

function objectJson(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
