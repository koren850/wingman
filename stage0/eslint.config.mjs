// Lint rules: catch real bugs (unused code, unsafe patterns), not style. Formatting is Prettier's job.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["node_modules/**", ".app/**", "data/**", "qa/out/**", "**/*.min.js"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  { files: ["**/*.cjs"], languageOptions: { sourceType: "commonjs" }, rules: { "@typescript-eslint/no-require-imports": "off" } },
  // TypeScript checks names itself.
  { files: ["**/*.ts"], rules: { "no-undef": "off" } },
  // Browser pages load several classic scripts that share one global scope (h, $, api, state ... are defined in one file and used in
  // the next), so cross-file names and top-level functions cannot be checked per file.
  {
    files: ["dashboard/**/*.js", "overlay/**/*.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser, module: "readonly", require: "readonly" } },
    rules: { "no-undef": "off", "@typescript-eslint/no-unused-vars": ["error", { vars: "local", args: "none", caughtErrors: "none" }] },
  },
  { files: ["**/*.test.ts", "src/test-*.ts"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
);
