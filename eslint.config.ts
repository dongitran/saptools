import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // ── No runtime console output — use process.stdout/stderr explicitly ──
      "no-console": "error",

      // ── Type safety ──
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",

      // ── Enforce explicit types on all public-facing function signatures ──
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",

      // ── Prevent unhandled promise rejections ──
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/promise-function-async": "error",

      // ── Unused code — tsconfig catches locals/params; ESLint catches vars ──
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // ── Enforce import type for type-only imports (reduces bundle size) ──
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],

      // ── Prefer readonly where possible (immutability by default) ──
      "@typescript-eslint/prefer-readonly": "error",

      // ── Disallow non-null assertions — always use safe access instead ──
      "@typescript-eslint/no-non-null-assertion": "error",

      // ── Require exhaustive switch/if on union types ──
      "@typescript-eslint/switch-exhaustiveness-check": "error",

      // ── Async/await cleanliness ──
      "@typescript-eslint/return-await": ["error", "always"],
      "@typescript-eslint/await-thenable": "error",

      // ── General JS quality ──
      "eqeqeq": ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
      "no-throw-literal": "error",
      "no-shadow": "off",
      "@typescript-eslint/no-shadow": "error",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
);
