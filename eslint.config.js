import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/",
      "dist/",
      "coverage/",
      "scripts/add-*",
      "scripts/remove-*",
      "scripts/fix-*",
      "scripts/verify-*",
      "src/domains/dashboard/fix.js",
      "src/domains/dashboard/fix_owner.js",
      "src/domains/dashboard/refactor_dashboard.js"
    ]
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2021
      }
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "off",
      "no-undef": "error"
    }
  }
];
