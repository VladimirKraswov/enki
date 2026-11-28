import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],
  // Keep React's shared runtime stable when adding lazy settings/result panels.
  // Rolldown otherwise moves the same already-required bytes between entry chunks.
  build: { rolldownOptions: { output: { codeSplitting: { groups: [
    {name: "react-vendor", test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/, priority: 30},
    {name: "pdfjs", test: /node_modules[\\/]pdfjs-dist[\\/]/, priority: 25},
    {name: "markdown-vendor", test: /node_modules[\\/](?:react-markdown|remark-gfm|remark-parse|remark-rehype|rehype-raw|micromark|mdast-util-[^\\/]+|hast-util-[^\\/]+|unist-util-[^\\/]+|vfile|trough|devlop|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities|ccount|escape-string-regexp|longest-streak|zwitch|bail|is-plain-obj|html-url-attributes)[\\/]/, priority: 20},
    {name: "syntax-highlight", test: /node_modules[\\/]highlight\.js[\\/]/, priority: 20},
  ] } } } },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1425,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1426,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
