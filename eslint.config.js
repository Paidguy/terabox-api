// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** Globals available in the Cloudflare Workers runtime (src/). */
const workerGlobals = {
  fetch: "readonly",
  Request: "readonly",
  Response: "readonly",
  Headers: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  crypto: "readonly",
  console: "readonly",
  btoa: "readonly",
  atob: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  AbortSignal: "readonly",
  KVNamespace: "readonly",
  ExportedHandler: "readonly",
  setTimeout: "readonly",
};

/** Globals available in a plain Node.js script (scripts/, examples/*.mjs). */
const nodeGlobals = {
  ...workerGlobals,
  process: "readonly",
  Buffer: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  module: "readonly",
  require: "readonly",
};

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["node_modules/**", "dist/**", ".wrangler/**", "examples/python-requests.py"],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: { globals: workerGlobals },
  },
  {
    files: ["scripts/**/*.mjs", "examples/**/*.mjs"],
    languageOptions: { globals: nodeGlobals },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
