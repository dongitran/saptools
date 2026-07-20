import rootConfig from "../../eslint.config.js";

export default [
  ...rootConfig,
  {
    files: ["src/**/*.ts"],
    rules: {
      complexity: ["error", 10],
      "max-lines": ["error", { max: 700, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 50, skipBlankLines: true, skipComments: true }],
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
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSEnumDeclaration",
          message: "Use as const objects and derived union types.",
        },
      ],
    },
  },
];
