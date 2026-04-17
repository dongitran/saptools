import { defineConfig } from "vitest/config";

// Separate config for E2E: longer timeout, no mocks, no coverage
// Requires real CF environment (SAP_EMAIL, SAP_PASSWORD env vars)
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    reporters: ["verbose"],
    sequence: {
      // Run E2E tests serially — CF state is shared across tests
      concurrent: false,
    },
  },
});
