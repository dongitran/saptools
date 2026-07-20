import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { writeJsonOutput } from "../../src/cli/output.js";

function collectingStream(chunks: string[]): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback): void {
      chunks.push(chunk.toString());
      callback();
    },
  });
}

describe("bounded CLI output", () => {
  it("redacts values before writing JSON", async () => {
    const chunks: string[] = [];
    await expect(writeJsonOutput(collectingStream(chunks), {
      authorization: "Bearer raw-secret-sentinel",
      safe: "visible",
    }, 4096)).resolves.toBe(true);
    const output = chunks.join("");
    expect(output).not.toContain("raw-secret-sentinel");
    expect(output).toContain("visible");
  });

  it("emits a bounded summary when the payload exceeds the output budget", async () => {
    const chunks: string[] = [];
    await writeJsonOutput(collectingStream(chunks), { value: "x".repeat(10_000) }, 256);
    const output = chunks.join("");
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(256);
    const parsed: unknown = JSON.parse(output);
    expect(parsed).toMatchObject({ truncated: true });
  });

  it("treats EPIPE as downstream completion", async () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback): void {
        const error = Object.assign(new Error("closed"), { code: "EPIPE" });
        callback(error);
      },
    });
    await expect(writeJsonOutput(stream, { ok: true }, 1024)).resolves.toBe(false);
  });
});
