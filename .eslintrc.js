/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended-type-checked",
    "prettier",
  ],
  parserOptions: {
    project: true,
    tsconfigRootDir: __dirname,
  },
  rules: {
    // Disallow `any` without explicit justification comment
    "@typescript-eslint/no-explicit-any": "error",
    // Prevent accidentally ignoring promise rejections
    "@typescript-eslint/no-floating-promises": "error",
    // Ensure exhaustive switch / conditional branches
    "@typescript-eslint/switch-exhaustiveness-check": "error",
  },
  ignorePatterns: [
    "node_modules/",
    "dist/",
    ".next/",
    "*.js",
    "*.mjs",
    "*.cjs",
    "!.eslintrc.js",
  ],
};
