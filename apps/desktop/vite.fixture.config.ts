// The fixture mode: the shared interface on fixed state, for development and the
// visual tests. A separate entry and output folder, so neither the Electron app
// nor the web preview can include it.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export const FIXTURE_PORT = 5341;

export default defineConfig({
  root: "src/fixture",
  base: "./",
  plugins: [react()],
  build: { outDir: "../../out/fixture", emptyOutDir: true },
  preview: { host: "127.0.0.1", port: FIXTURE_PORT, strictPort: true },
});
