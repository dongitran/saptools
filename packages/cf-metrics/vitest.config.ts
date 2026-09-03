import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vitest/config";

/**
 * A second line of protection for the result store. Every store call in this suite passes
 * an explicit `saptoolsRoot`, but the CLI save path resolves its root from the
 * environment, so one future CLI-level `--save` test would otherwise write into
 * whoever ran the suite. That is exactly how cf-otel accumulated 69 stray
 * sessions in a developer's real store. Fixed path, cleared as the config
 * loads, so runs neither accumulate nor strand a new temp directory.
 */
const saptoolsRoot = join(tmpdir(), "cf-metrics-test-saptools");
rmSync(saptoolsRoot, { recursive: true, force: true });

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    env: { SAPTOOLS_AUTO_UPDATE: "off", CF_METRICS_SAPTOOLS_ROOT: saptoolsRoot },
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
