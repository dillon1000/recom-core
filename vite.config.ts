/**
 * Builds the open-source browser viewer from web/. Inputs are the repository's
 * generated wasm-bindgen package and public state artifacts; output is a static
 * site under dist/. Set VITE_DATA_ORIGIN to use another compatible data host.
 */
import path from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vite"

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: path.join(root, "web"),
  build: {
    emptyOutDir: true,
    outDir: path.join(root, "dist"),
    sourcemap: true,
    target: "es2023",
  },
})
