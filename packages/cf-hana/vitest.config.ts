import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vitest/config";

/**
 * A second line of protection for the result store. Every store call in this suite passes
 * an explicit `saptoolsRoot`, but unlike its siblings cf-hana has no
 * results-root environment hook at all — it resolves `homedir()` directly — so
 * `HOME` is the only lever. One future test that forgets `saptoolsRoot` would
 * otherwise write into whoever ran the suite, which is how cf-otel accumulated
 * 69 stray sessions in a developer's real store.
 */
const fakeHome = join(tmpdir(), "cf-hana-test-home");
rmSync(fakeHome, { recursive: true, force: true });
mkdirSync(fakeHome, { recursive: true });

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    env: { SAPTOOLS_AUTO_UPDATE: "off", HOME: fakeHome },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/cli.ts",
        "src/index.ts",
        "src/driver/hdb.ts",
        "src/driver/fake.ts",
        "src/**/*.d.ts",
      ],
      reporter: ["text", "html"],
      thresholds: {
        lines: 79,
        functions: 79,
        branches: 79,
        statements: 79,
      },
    },
  },
});
