import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // broker.ts: only exercised end-to-end through Playwright tests because
      // it owns the live cf ssh child process and the IPC server.
      // session.ts: startExplorerSession spawns the broker entry; the
      // remaining client-side helpers (attach/list/status/stop) are covered
      // by tests/unit/session.test.ts.
      // cli.ts/index.ts: thin Commander wiring and a re-export barrel.
      // types.ts: type-only declarations and as-const literal unions.
      exclude: [
        "src/broker.ts",
        "src/cli.ts",
        "src/index.ts",
        "src/session.ts",
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
