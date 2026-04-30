import rootConfig from "../../eslint.config.js";

export default [
  ...rootConfig,
  {
    ignores: ["tests/e2e/fixtures/fake-cf.mjs"],
  },
  {
    rules: {
      "no-eval": "error",
      "no-new-func": "error",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:child_process",
              importNames: ["exec", "execSync"],
              message: "Use spawn or execFile with argument arrays.",
            },
            {
              name: "child_process",
              importNames: ["exec", "execSync"],
              message: "Use spawn or execFile with argument arrays.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSEnumDeclaration",
          message: "Use as const objects and derived union types instead of TypeScript enums.",
        },
      ],
    },
  },
];
