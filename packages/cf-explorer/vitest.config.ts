import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // broker entry and explorer-broker: only exercised end-to-end through
      // Playwright tests because they own the live cf ssh child process and
      // the IPC server.
      // session client: startExplorerSession spawns the broker entry; the
      // remaining client-side helpers (attach/list/status/stop) are covered
      // by tests/unit/session.test.ts.
      // cli entry and program: thin executable wrapper and Commander wiring.
      // index.ts: public re-export barrel.
      // core/types.ts and types.ts: type declarations and as-const literals.
      exclude: [
        "src/broker/explorer-broker.ts",
        "src/broker.ts",
        "src/cli/program.ts",
        "src/cli.ts",
        "src/core/types.ts",
        "src/index.ts",
        "src/session/client.ts",
        "src/types.ts",
      ],
      reporter: ["text", "html"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90
      }
    }
  }
});
