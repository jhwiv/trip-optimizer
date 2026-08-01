import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
export default [
  js.configs.recommended,
  {
    // Apply our base rules to JSX components AND the plain JS helpers under
    // src/ (e.g. src/pdf/itineraryPdf.js). Both share the same conventions:
    // _-prefixed unused args are intentional, ctrl chars in regexes can be
    // legitimate (see PDF sanitization), and the React-hooks plugin is a
    // no-op on the plain JS files.
    files: ["src/**/*.{js,jsx,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { window: "readonly", document: "readonly", navigator: "readonly",
                 fetch: "readonly", setTimeout: "readonly", clearTimeout: "readonly",
                 setInterval: "readonly", clearInterval: "readonly", localStorage: "readonly",
                 console: "readonly", AbortController: "readonly", TextDecoder: "readonly",
                 Promise: "readonly", JSON: "readonly", __BUILD_ID__: "readonly",
                 __API_BASE__: "readonly", encodeURIComponent: "readonly",
                 FormData: "readonly", URLSearchParams: "readonly", URL: "readonly",
                 FileReader: "readonly", Blob: "readonly", File: "readonly" },
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
  // Local Node test files — these run with `node` for sanity checks.
  {
    files: ["functions/**/__test__.mjs", "functions/**/*.test.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        console: "readonly", process: "readonly",
        setTimeout: "readonly", clearTimeout: "readonly",
        URL: "readonly", fetch: "readonly",
      },
    },
  },
  // Cloudflare Pages Functions / Workers — server-side runtime globals.
  {
    files: ["functions/**/*.js", "worker/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        fetch: "readonly", Response: "readonly", Request: "readonly",
        URL: "readonly", URLSearchParams: "readonly", Headers: "readonly",
        AbortController: "readonly", TransformStream: "readonly",
        ReadableStream: "readonly", WritableStream: "readonly",
        TextEncoder: "readonly", TextDecoder: "readonly",
        setTimeout: "readonly", clearTimeout: "readonly",
        setInterval: "readonly", clearInterval: "readonly",
        crypto: "readonly", btoa: "readonly", atob: "readonly",
        console: "readonly", Promise: "readonly", JSON: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
];
