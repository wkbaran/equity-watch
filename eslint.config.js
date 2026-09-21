/**
 * Lints web/, and deliberately nothing else.
 *
 * src/, tests/ and playwright/ are TypeScript: `tsc --strict` plus
 * noUnusedLocals/noUnusedParameters (tsconfig.json) and the test suites already
 * cover them, and a general style linter over that code would be mostly noise —
 * worse, CLAUDE.md documents a dozen patterns there that look wrong and are
 * load-bearing, and a default rule set invites "fixing" them.
 *
 * web/app.js is the opposite case: ~2,600 lines of plain JS served with no
 * bundler, so nothing checked it at all. Two bugs in one sitting (2026-09-21)
 * made the case — a `const lot` shadowing the `lot` parameter it was declared
 * inside, so every "did this change?" comparison compared the new values with
 * themselves, and a helper referenced before it had actually been written to
 * the file. Both were caught, but only by a full browser-test run; no-shadow
 * and no-undef catch them in milliseconds.
 *
 * Correctness rules only. No stylistic rules: the file is already internally
 * consistent and formatting arguments are not what this is for.
 */

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  {
    files: ["web/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: globals.browser,
    },
    rules: {
      ...js.configs.recommended.rules,
      // The two that would have caught today's bugs.
      "no-shadow": "error",
      "no-undef": "error",
      // Cheap, and each one is a real defect rather than a preference.
      "no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_" }],
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "smart"],
      "no-implicit-globals": "error",
      "no-return-assign": "off", // `return (error.textContent = "...")` is the form every form handler uses.
    },
  },

  /**
   * src/ gets the type-aware rules, which is the only thing eslint offers here
   * that `tsc --strict` does not. Four rule groups are turned down, each
   * because it fires on a deliberate idiom rather than a defect — measured, not
   * guessed. Don't re-enable one without reading the note.
   */
  ...tseslint.configs.recommendedTypeChecked.map((c) => ({ ...c, files: ["src/**/*.ts"] })),
  {
    files: ["src/**/*.ts"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // Destructuring to *omit* keys is how several rows are built
      // ("everything but kind and side"), and the discards are _-prefixed.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true, destructuredArrayIgnorePattern: "^_" },
      ],
      // An async method implementing an async interface (Notifier.notify,
      // MarketData.getQuotes, BaselineResolver) needs no await of its own.
      "@typescript-eslint/require-await": "off",
      // `${price}` and `${count}` are most of the strings in this codebase.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
];
