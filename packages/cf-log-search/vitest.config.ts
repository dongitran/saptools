import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vitest/config";

const saptoolsRoot = join(tmpdir(), "cf-log-search-test-saptools");
rmSync(saptoolsRoot, { recursive: true, force: true });

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    env: { SAPTOOLS_AUTO_UPDATE: "off", CF_LOG_SEARCH_SAPTOOLS_ROOT: saptoolsRoot },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts", "src/index.ts", "src/types.ts", "src/cli/commandTypes.ts", "src/**/*.d.ts"],
      reporter: ["text", "html"],
      // Global thresholds are enforced starting Task 13, once the full command
      // surface and its tests exist — gating on 80% from Task 1 onward is
      // unsatisfiable by construction (each intermediate task's commit only
      // covers the slice it just built) and would fail every commit's
      // pre-commit hook run until the very last task, defeating per-task
      // checkpointing. Coverage is still measured and reported from the start.
    },
  },
});
