import ts from 'typescript';

export interface PlaceholderSpan {
  readonly start: number;
  readonly end: number;
  readonly key: string;
}

export type PlaceholderScanReason =
  | 'placeholder_expression_empty'
  | 'placeholder_delimiter_mismatch'
  | 'placeholder_token_unterminated'
  | 'placeholder_unterminated';

export interface PlaceholderScanResult {
  readonly status: 'balanced' | 'malformed';
  readonly spans: readonly PlaceholderSpan[];
  readonly reason?: PlaceholderScanReason;
  readonly failureOffset?: number;
}

type Delimiter = 'brace' | 'bracket' | 'paren' | 'template';

interface PlaceholderMatch {
  readonly span?: PlaceholderSpan;
  readonly reason?: PlaceholderScanReason;
  readonly failureOffset?: number;
}

const expressionEndTokens = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PrivateIdentifier,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.SuperKeyword,
  ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.PlusPlusToken,
  ts.SyntaxKind.MinusMinusToken,
]);

export function scanPlaceholderStructure(
  value: string | undefined,
): PlaceholderScanResult {
  const input = value ?? '';
  const spans: PlaceholderSpan[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const start = input.indexOf('${', cursor);
    if (start < 0) break;
    const match = scanPlaceholderAt(input, start);
    if (!match.span) {
      return {
        status: 'malformed', spans: [], reason: match.reason,
        failureOffset: match.failureOffset,
      };
    }
    spans.push(match.span);
    cursor = match.span.end;
  }
  return { status: 'balanced', spans };
}

export function scanPlaceholders(
  value: string | undefined,
): readonly PlaceholderSpan[] {
  const result = scanPlaceholderStructure(value);
  return result.status === 'balanced' ? result.spans : [];
}

export function extractPlaceholderKeys(value: string | undefined): string[] {
  return scanPlaceholders(value)
    .map((span) => span.key.trim())
    .filter(Boolean);
}

function scanPlaceholderAt(input: string, start: number): PlaceholderMatch {
  const bodyOffset = start + 2;
  if (input.indexOf('}', bodyOffset) < 0)
    return { reason: 'placeholder_unterminated', failureOffset: start };
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    input.slice(bodyOffset),
  );
  const delimiters: Delimiter[] = [];
  let previousEndsExpression = false;
  while (true) {
    const scanned = scanToken(scanner, previousEndsExpression);
    if (scanner.isUnterminated())
      return failedMatch('placeholder_token_unterminated', bodyOffset, scanner);
    if (scanned === ts.SyntaxKind.EndOfFileToken)
      return failedMatch('placeholder_unterminated', bodyOffset, scanner);
    if (isTrivia(scanned)) continue;
    const result = consumeDelimiter(scanner, scanned, delimiters);
    if (result.reason)
      return failedMatch(result.reason, bodyOffset, scanner);
    if (result.closed) {
      const end = bodyOffset + scanner.getTextPos();
      const key = input.slice(bodyOffset, end - 1);
      return key.trim()
        ? { span: { start, end, key } }
        : { reason: 'placeholder_expression_empty', failureOffset: start };
    }
    previousEndsExpression = tokenEndsExpression(
      result.token, previousEndsExpression,
    );
  }
}

function scanToken(
  scanner: ts.Scanner,
  previousEndsExpression: boolean,
): ts.SyntaxKind {
  const token = scanner.scan();
  if ((token === ts.SyntaxKind.SlashToken
      || token === ts.SyntaxKind.SlashEqualsToken)
    && !previousEndsExpression)
    return scanner.reScanSlashToken();
  return token;
}

function consumeDelimiter(
  scanner: ts.Scanner,
  token: ts.SyntaxKind,
  stack: Delimiter[],
): { token: ts.SyntaxKind; closed?: boolean; reason?: PlaceholderScanReason } {
  if (token === ts.SyntaxKind.TemplateHead) stack.push('template');
  else if (token === ts.SyntaxKind.OpenBraceToken) stack.push('brace');
  else if (token === ts.SyntaxKind.OpenBracketToken) stack.push('bracket');
  else if (token === ts.SyntaxKind.OpenParenToken) stack.push('paren');
  else if (token === ts.SyntaxKind.CloseBracketToken)
    return closeDelimiter(token, stack, 'bracket');
  else if (token === ts.SyntaxKind.CloseParenToken)
    return closeDelimiter(token, stack, 'paren');
  else if (token === ts.SyntaxKind.CloseBraceToken)
    return closeBrace(scanner, stack);
  return { token };
}

function closeDelimiter(
  token: ts.SyntaxKind,
  stack: Delimiter[],
  expected: Delimiter,
): { token: ts.SyntaxKind; reason?: PlaceholderScanReason } {
  if (stack.at(-1) !== expected)
    return { token, reason: 'placeholder_delimiter_mismatch' };
  stack.pop();
  return { token };
}

function closeBrace(
  scanner: ts.Scanner,
  stack: Delimiter[],
): { token: ts.SyntaxKind; closed?: boolean; reason?: PlaceholderScanReason } {
  const current = stack.at(-1);
  if (!current) return { token: ts.SyntaxKind.CloseBraceToken, closed: true };
  if (current === 'brace') {
    stack.pop();
    return { token: ts.SyntaxKind.CloseBraceToken };
  }
  if (current !== 'template')
    return {
      token: ts.SyntaxKind.CloseBraceToken,
      reason: 'placeholder_delimiter_mismatch',
    };
  const token = scanner.reScanTemplateToken(false);
  if (token === ts.SyntaxKind.TemplateTail) stack.pop();
  if (token !== ts.SyntaxKind.TemplateTail
    && token !== ts.SyntaxKind.TemplateMiddle)
    return { token, reason: 'placeholder_token_unterminated' };
  return { token };
}

function failedMatch(
  reason: PlaceholderScanReason,
  bodyOffset: number,
  scanner: ts.Scanner,
): PlaceholderMatch {
  return {
    reason,
    failureOffset: bodyOffset + scanner.getTokenPos(),
  };
}

function tokenEndsExpression(
  token: ts.SyntaxKind,
  previousEndsExpression: boolean,
): boolean {
  if (token === ts.SyntaxKind.ExclamationToken)
    return previousEndsExpression;
  return expressionEndTokens.has(token);
}

function isTrivia(token: ts.SyntaxKind): boolean {
  return token >= ts.SyntaxKind.FirstTriviaToken
    && token <= ts.SyntaxKind.LastTriviaToken;
}
