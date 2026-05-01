import { randomUUID } from "node:crypto";

import { CfExplorerError } from "../core/errors.js";

const MARKER_PREFIX = "__CF_EXPLORER";

export interface WrappedRemoteCommand {
  readonly commandId: string;
  readonly script: string;
  readonly startMarker: string;
  readonly endMarkerPrefix: string;
}

export interface ParsedProtocolFrame {
  readonly commandId: string;
  readonly stdout: string;
  readonly exitCode: number;
}

export function createCommandId(factory: () => string = randomUUID): string {
  return factory().replaceAll("-", "");
}

export function wrapRemoteScript(script: string, commandId: string = createCommandId()): WrappedRemoteCommand {
  const startMarker = `${MARKER_PREFIX}_START_${commandId}__`;
  const endMarkerPrefix = `${MARKER_PREFIX}_END_${commandId}__`;
  return {
    commandId,
    startMarker,
    endMarkerPrefix,
    script: [
      `printf '%s\\n' '${startMarker}'`,
      "(",
      script,
      ")",
      "cfx_exit=$?",
      `printf '%s:%s\\n' '${endMarkerPrefix}' "$cfx_exit"`,
    ].join("\n"),
  };
}

export function parseProtocolFrame(buffer: string, wrapped: WrappedRemoteCommand): ParsedProtocolFrame | undefined {
  const startIndex = buffer.indexOf(`${wrapped.startMarker}\n`);
  if (startIndex < 0) {
    return undefined;
  }
  const contentStart = startIndex + wrapped.startMarker.length + 1;
  const endMatch = findEndMarker(buffer, wrapped.endMarkerPrefix, contentStart);
  if (endMatch === undefined) {
    return undefined;
  }
  const stdout = buffer.slice(contentStart, endMatch.markerIndex);
  return {
    commandId: wrapped.commandId,
    stdout,
    exitCode: endMatch.exitCode,
  };
}

export function requireSuccessfulFrame(frame: ParsedProtocolFrame): string {
  if (frame.exitCode === 0) {
    return frame.stdout;
  }
  throw new CfExplorerError(
    "SESSION_PROTOCOL_ERROR",
    `Remote command failed inside persistent session with exit code ${frame.exitCode.toString()}.`,
  );
}

function findEndMarker(
  buffer: string,
  endMarkerPrefix: string,
  fromIndex: number,
): { readonly markerIndex: number; readonly exitCode: number } | undefined {
  const markerIndex = buffer.indexOf(endMarkerPrefix, fromIndex);
  if (markerIndex < 0) {
    return undefined;
  }
  const lineEnd = buffer.indexOf("\n", markerIndex);
  const markerLine = buffer.slice(markerIndex, lineEnd < 0 ? buffer.length : lineEnd);
  const markerValue = markerLine.slice(endMarkerPrefix.length);
  if (!markerValue.startsWith(":") || !/^\d+$/.test(markerValue.slice(1))) {
    throw new CfExplorerError("SESSION_PROTOCOL_ERROR", "Malformed remote session end marker.");
  }
  const exitCode = Number(markerValue.slice(1));
  if (!Number.isSafeInteger(exitCode)) {
    throw new CfExplorerError("SESSION_PROTOCOL_ERROR", "Malformed remote session end marker.");
  }
  return { markerIndex, exitCode };
}
