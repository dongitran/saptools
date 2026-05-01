import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/cf/**",
        "src/cli.ts",
        "src/cli/commandTypes.ts",
        "src/cli/commands/**",
        "src/cli/program.ts",
        "src/cli/target.ts",
        "src/cli/warnings.ts",
        "src/index.ts",
        "src/inspector/session.ts",
        "src/inspector/types.ts",
        "src/types.ts",
        "src/cdp/wsTransport.ts",
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
