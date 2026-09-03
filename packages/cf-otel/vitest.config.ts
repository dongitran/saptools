import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vitest/config";

/**
 * The CLI tests exercise `--save`, which goes through the real result store —
 * only the OpenSearch client is faked. Without this override those saves land
 * in whoever ran the suite's own `~/.saptools/cf-otel/results`: 69 of the 70
 * sessions found in one developer's store had been written by this file's
 * `mapping --save` test, one per run. The path is fixed rather than
 * per-invocation, and cleared as the config loads, so runs neither accumulate
 * sessions nor strand a new temp directory each time.
 */
const resultsRoot = join(tmpdir(), "cf-otel-test-results");
rmSync(resultsRoot, { recursive: true, force: true });

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    env: { SAPTOOLS_AUTO_UPDATE: "off", CF_OTEL_RESULTS_ROOT: resultsRoot },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts", "src/index.ts", "src/types.ts", "src/cli/commandTypes.ts", "src/**/*.d.ts"],
      reporter: ["text", "html"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
