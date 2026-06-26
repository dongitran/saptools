import rootConfig from "../../eslint.config.js";

export default [
  ...rootConfig,
  {
    ignores: ["tests/e2e/fixtures/fake-cf.mjs"],
  },
];
