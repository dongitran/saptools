export function parseCaptureList(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }
  return splitCaptureExpressions(raw);
}

type QuoteChar = "'" | "\"" | "`";

interface CaptureSplitState {
  quote: QuoteChar | undefined;
  escaped: boolean;
  parenDepth: number;
  bracketDepth: number;
  braceDepth: number;
  start: number;
  readonly pieces: string[];
}

function isQuoteChar(value: string): value is QuoteChar {
  return value === "'" || value === "\"" || value === "`";
}

function consumeQuotedChar(state: CaptureSplitState, char: string): boolean {
  if (state.quote === undefined) {
    return false;
  }
  if (state.escaped) {
    state.escaped = false;
    return true;
  }
  if (char === "\\") {
    state.escaped = true;
    return true;
  }
  if (char === state.quote) {
    state.quote = undefined;
  }
  return true;
}

function updateCaptureDepth(state: CaptureSplitState, char: string): void {
  if (char === "(") {
    state.parenDepth += 1;
  } else if (char === ")") {
    state.parenDepth = Math.max(0, state.parenDepth - 1);
  } else if (char === "[") {
    state.bracketDepth += 1;
  } else if (char === "]") {
    state.bracketDepth = Math.max(0, state.bracketDepth - 1);
  } else if (char === "{") {
    state.braceDepth += 1;
  } else if (char === "}") {
    state.braceDepth = Math.max(0, state.braceDepth - 1);
  }
}

function isTopLevel(state: CaptureSplitState): boolean {
  return state.parenDepth === 0 && state.bracketDepth === 0 && state.braceDepth === 0;
}

function appendCapturePiece(raw: string, state: CaptureSplitState, end: number): void {
  const piece = raw.slice(state.start, end).trim();
  if (piece.length > 0) {
    state.pieces.push(piece);
  }
}

function splitCaptureExpressions(raw: string): readonly string[] {
  const state: CaptureSplitState = {
    escaped: false,
    parenDepth: 0,
    bracketDepth: 0,
    braceDepth: 0,
    quote: undefined,
    start: 0,
    pieces: [],
  };
  for (let idx = 0; idx < raw.length; idx += 1) {
    const char = raw.charAt(idx);
    if (consumeQuotedChar(state, char)) {
      continue;
    }
    if (isQuoteChar(char)) {
      state.quote = char;
      continue;
    }
    updateCaptureDepth(state, char);
    if (char === "," && isTopLevel(state)) {
      appendCapturePiece(raw, state, idx);
      state.start = idx + 1;
    }
  }
  appendCapturePiece(raw, state, raw.length);
  return state.pieces;
}
