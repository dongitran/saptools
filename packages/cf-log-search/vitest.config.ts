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
      // cf.ts is ported verbatim from cf-metrics (Task 2) to avoid transcription
      // risk on its 55-entry region table, so it carries cf-metrics's SAML
      // credential-minting mutation functions (cfServiceKey, cfServiceParams,
      // cfServiceShow, cfUpdateService, cfCreateServiceKey, cfDeleteServiceKey,
      // parseServiceStatus) — real, tested functionality there, but genuinely
      // unreachable dead weight here: this package deliberately never exposes
      // --allow-mint-credential (Global Constraints) or calls any of them.
      // Testing them here would only be for the coverage number, not because
      // any command can reach them. Excluded so the 80% bar stays meaningful
      // for code this package's own command surface actually depends on.
      exclude: ["src/cli.ts", "src/index.ts", "src/types.ts", "src/cli/commandTypes.ts", "src/cf.ts", "src/**/*.d.ts"],
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
