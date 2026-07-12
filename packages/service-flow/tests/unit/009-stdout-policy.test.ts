import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createStdoutWriter } from '../../src/output/000-stdout-policy.js';

function errorWithCode(code: string): Error {
  const error = new Error(`stream failure: ${code}`);
  Object.defineProperty(error, 'code', { value: code });
  return error;
}

describe('stdout error policy', () => {
  it('treats EPIPE as consumer completion and suppresses later output', () => {
    const stream = new PassThrough();
    const unexpected: Error[] = [];
    const writer = createStdoutWriter(stream, (error) => unexpected.push(error));

    expect(writer.write('first output')).toBe(true);
    expect(stream.read()?.toString()).toBe('first output');
    stream.emit('error', errorWithCode('EPIPE'));
    expect(writer.write('later output')).toBe(false);
    expect(unexpected).toEqual([]);
  });

  it('reports an unrelated stdout failure once and blocks later output', () => {
    const stream = new PassThrough();
    const unexpected: Error[] = [];
    const writer = createStdoutWriter(stream, (error) => unexpected.push(error));
    const failure = errorWithCode('EIO');

    stream.emit('error', failure);
    stream.emit('error', failure);
    expect(unexpected).toEqual([failure]);
    expect(writer.write('later output')).toBe(false);
  });

  it('reuses one error listener when a stream receives multiple writers', () => {
    const stream = new PassThrough();
    const first = createStdoutWriter(stream, () => undefined);
    const second = createStdoutWriter(stream, () => undefined);

    expect(first.write('first')).toBe(true);
    expect(second.write('second')).toBe(true);
    expect(stream.listenerCount('error')).toBe(1);
  });
});
