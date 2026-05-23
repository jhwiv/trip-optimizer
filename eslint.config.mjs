import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
export default [
  js.configs.recommended,
  {
    files: ["src/**/*.jsx"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { window: "readonly", document: "readonly", navigator: "readonly",
                 fetch: "readonly", setTimeout: "readonly", clearTimeout: "readonly",
                 setInterval: "readonly", clearInterval: "readonly", localStorage: "readonly",
                 console: "readonly", AbortController: "readonly", TextDecoder: "readonly",
                 Promise: "readonly", JSON: "readonly", __BUILD_ID__: "readonly",
                 __API_BASE__: "readonly", encodeURIComponent: "readonly" },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
];
