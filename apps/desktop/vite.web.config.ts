// Builds the same renderer for the browser, served by the web preview host.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: { outDir: "../../out/web", emptyOutDir: true },
});
