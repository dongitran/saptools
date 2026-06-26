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
