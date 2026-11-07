// Lint rules: catch real bugs (unused code, unsafe patterns), not style. Formatting is Prettier's job.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

const BIN_RULE = { selector: "Literal[value='.bin']", message: "Do not build a node_modules/.bin path by hand: use binCommand() from shared/bin.cjs." };

export default tseslint.config(
  { ignores: ["node_modules/**", ".app/**", ".stage/**", "dist/**", "data/**", "qa/out/**", "**/*.min.js"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      // Best-effort I/O (a missing file, a closed socket, a kill on an already dead process) is deliberately swallowed in `catch {}`
      // all over the codebase. Empty `if`/`while` blocks are still flagged.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Short-circuit and ternary statements (`ok && log(...)`, `cond ? a() : b()`) are the house style for one-line side effects.
      "@typescript-eslint/no-unused-expressions": ["error", { allowShortCircuit: true, allowTernary: true }],
      // The sanitising regexes (strip control characters from model output, file names and terminal text) are meant to match them.
      "no-control-regex": "off",
      // The sanitising regexes list invisible characters (zero-width, bidi marks) literally on purpose.
      "no-irregular-whitespace": ["error", { skipRegExps: true }],
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
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": ["error", { vars: "local", args: "none", caughtErrors: "none" }],
      // Shared modules are UMD: they use `require` under Node and a global in the browser.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // Security rules that used to be source-text tests (invariants.test.ts). A lint rule sees the syntax, not comments, and covers new files too.
  // Renderer pages: text goes in with textContent / createElement; no HTML strings, no string evaluation (the CSP forbids it as well).
  {
    files: ["dashboard/**/*.js", "overlay/**/*.js"],
    rules: {
      "no-restricted-properties": [
        "error",
        { property: "innerHTML", message: "Use textContent or createElement: renderer pages never build HTML from strings." },
        { property: "outerHTML", message: "Use textContent or createElement: renderer pages never build HTML from strings." },
        { property: "insertAdjacentHTML", message: "Use textContent or createElement: renderer pages never build HTML from strings." },
        { object: "document", property: "write", message: "document.write is not allowed." },
        { object: "document", property: "writeln", message: "document.write is not allowed." },
      ],
      "no-eval": "error",
      "no-new-func": "error",
      "no-implied-eval": "error",
    },
  },
  // Engine and app code: child processes are started through shared/bin.cjs (binCommand), never by building a .bin path.
  {
    files: ["src/**/*.ts", "tray/**/*.cjs", "dashboard/**/*.{js,cjs}", "overlay/**/*.{js,cjs}"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": ["error", BIN_RULE],
    },
  },
  // Dashboard wording: visible text uses the glossary (no "consent", "briefing", "bank", "stall", "doctor" in strings the user reads).
  {
    files: ["dashboard/{home,live,app,settings,boot}.js", "tray/settings-catalog.cjs"],
    rules: {
      "no-restricted-syntax": [
        "error",
        BIN_RULE, // a later block replaces the earlier no-restricted-syntax list, so repeat the .bin rule here
        {
          selector:
            "Literal[value=/Waiting for consent|Consent given|consent line|Check everything|Stop and delete|^Bank$|^Stall$|Briefing\\b|^Calc$|(?<!run)Doctor\\b/]",
          message: "This word is not in the glossary (docs/GLOSSARY or ROADMAP wording rules).",
        },
        {
          selector:
            "TemplateElement[value.raw=/Waiting for consent|Consent given|consent line|Check everything|Stop and delete|Briefing\\b|(?<!run)Doctor\\b/]",
          message: "This word is not in the glossary.",
        },
      ],
    },
  },
  // The menu-bar app must not register Ctrl+Opt+1-3: they are the answer window's keys, and a collision is silent.
  {
    files: ["tray/main.cjs"],
    rules: {
      "no-restricted-syntax": [
        "error",
        BIN_RULE,
        { selector: "Literal[value=/Control\\+Alt\\+[123]\\b/]", message: "Ctrl+Opt+1-3 belong to the answer window." },
      ],
    },
  },
  // Plain browser scripts (the UMD modules in shared/ test for `window`, tray/prompt.js is a page script).
  {
    files: ["shared/**/*.js", "tray/prompt.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser, module: "readonly", require: "readonly" } },
  },
  // Hand-written type declarations for untyped CommonJS helpers: their values are opaque on purpose.
  { files: ["**/*.d.cts"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
  // The QA grader reads loosely shaped JSON rows (model output, stored calls), typed as `any` on purpose.
  { files: ["qa/**/*.ts"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
  { files: ["**/*.test.ts", "src/test-*.ts"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
);
