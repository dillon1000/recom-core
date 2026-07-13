/**
 * Lints the standalone TypeScript viewer and Vite configuration. Browser, worker, and Node globals
 * are declared together because the checked source includes UI modules, Web Workers, and build/test
 * entrypoints; generated WASM bindings and build outputs remain excluded.
 */
import eslint from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "target/**", "web/src/wasm/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.worker,
      },
    },
  },
)
