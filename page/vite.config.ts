import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
// import devtools from 'solid-devtools/vite';
import tailwindcss from "@tailwindcss/vite";
import importMetaUrlPlugin from "@codingame/esbuild-import-meta-url-plugin";

const crossOriginIsolationHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export default defineConfig({
  resolve: {
    alias: {
      "monaco-editor": "@codingame/monaco-vscode-editor-api",
    },
  },
  plugins: [
    /*
    Uncomment the following line to enable solid-devtools.
    For more info see https://github.com/thetarnav/solid-devtools/tree/main/packages/extension#readme
    */
    // devtools(),
    solidPlugin(),
    tailwindcss(),
  ],
  optimizeDeps: {
    exclude: ["brotli-dec-wasm"],
    esbuildOptions: {
      plugins: [importMetaUrlPlugin],
    },
  },
  server: {
    port: 3000,
    headers: crossOriginIsolationHeaders,
  },
  preview: { headers: crossOriginIsolationHeaders },
  build: {
    target: "esnext",
    // If use debug mode, not minify.
    minify: process.env.NODE_ENV === "production" ? true : false,
    // produce sourcemaps for debug builds
  },
  worker: {
    format: "es",
  },
  base: "./",
});
