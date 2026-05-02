import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/cli.ts",
        "src/index.ts",
        "src/cf.ts",
        "src/cloud-foundry/commands.ts",
        "src/cloud-foundry/execute.ts",
        "src/cloud-foundry/ssh.ts",
        "src/debugger.ts",
        "src/port.ts",
        "src/state.ts",
        "src/types.ts",
      ],
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
