import { defineConfig } from "vite";

export default defineConfig({
  assetsInclude: ["**/*.wasm"],
  optimizeDeps: {
    include: ["@babylonjs/core", "@babylonjs/loaders", "@babylonjs/havok"],
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
