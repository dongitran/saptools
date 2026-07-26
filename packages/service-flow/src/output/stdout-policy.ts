import type { Writable } from 'node:stream';

export interface StdoutWriter {
  write(value: string): boolean;
}

interface OutputState {
  blocked: boolean;
  unexpectedReported: boolean;
}

interface WriterEntry {
  state: OutputState;
  writer: StdoutWriter;
}

const writers = new WeakMap<Writable, WriterEntry>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isBrokenPipe(error: Error): boolean {
  return isRecord(error) && error.code === 'EPIPE';
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function handleStreamError(
  state: OutputState,
  error: Error,
  onUnexpectedError: (error: Error) => void,
): void {
  state.blocked = true;
  if (isBrokenPipe(error) || state.unexpectedReported) return;
  state.unexpectedReported = true;
  onUnexpectedError(error);
}

export function createStdoutWriter(
  stream: Writable,
  onUnexpectedError: (error: Error) => void,
): StdoutWriter {
  const existing = writers.get(stream);
  if (existing) return existing.writer;
  const state: OutputState = { blocked: false, unexpectedReported: false };
  const writer: StdoutWriter = {
    write(value: string): boolean {
      if (state.blocked) return false;
      try {
        stream.write(value);
        return true;
      } catch (error) {
        handleStreamError(state, asError(error), onUnexpectedError);
        return false;
      }
    },
  };
  stream.on('error', (error: Error) =>
    handleStreamError(state, error, onUnexpectedError));
  writers.set(stream, { state, writer });
  return writer;
}
