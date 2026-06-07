import js from "@eslint/js";
import globals from "globals";

// Flat config (ESLint 9+). Prettier owns formatting; ESLint owns correctness, so
// there are no stylistic rules here to conflict with the formatter.
export default [
  { ignores: ["node_modules/**", ".praxis/**"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
];
