import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@hatch/ui": resolve(__dirname, "src/ui/index.ts"),
    },
  },
  server: {
    port: 5273,
    strictPort: true,
    fs: {
      allow: [resolve(__dirname)],
    },
  },
  build: {
    outDir: resolve(__dirname, "out/renderer"),
    emptyOutDir: true,
    modulePreload: false,
  },
});
