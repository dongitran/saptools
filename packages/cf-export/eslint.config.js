import rootConfig from "../../eslint.config.js";

export default [
  ...rootConfig,
  {
    ignores: ["tests/e2e/fixtures/fake-cf.mjs"],
  },
  {
    // import/order rule from eslint-plugin-import has compatibility crashes with the current
    // eslint + typescript-eslint stack on certain files (even with correct grouping).
    // We relax ONLY for the problematic file and for tests.
    // All other strict rules remain active on all src.
    files: ["src/cli.ts", "src/session.ts", "tests/**/*.ts", "**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "import/order": "off",
    },
  },
];
