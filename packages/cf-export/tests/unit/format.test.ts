import { describe, expect, it } from "vitest";

import { formatExportCompletionMessage } from "../../src/format.js";

describe("formatExportCompletionMessage", () => {
  it("reports written files with basenames only", () => {
    const msg = formatExportCompletionMessage("my-app", [
      "/tmp/out/package.json",
      "/tmp/out/pnpm-lock.yaml",
    ], []);
    expect(msg).toBe('Export completed for "my-app". 2 files: package.json, pnpm-lock.yaml.');
  });

  it("mentions skipped files", () => {
    const msg = formatExportCompletionMessage("svc", ["/a/b/default-env.json"], ["package.json"]);
    expect(msg).toContain("Skipped: package.json");
  });

  it("handles empty written list", () => {
    const msg = formatExportCompletionMessage("x", [], ["a", "b"]);
    expect(msg).toContain("No files written");
  });
});
