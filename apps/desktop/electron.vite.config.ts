import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    // Workspace packages ship TypeScript source, so they are bundled rather than required.
    build: { externalizeDeps: { exclude: ["@clawtrate/core", "@clawtrate/ui"] } },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: ["@clawtrate/core"] },
      // A sandboxed preload must be CommonJS.
      rolldownOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
    build: { rolldownOptions: { input: "src/renderer/index.html" } },
  },
});
