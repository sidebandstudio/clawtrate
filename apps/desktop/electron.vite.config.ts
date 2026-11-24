import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { updateDefines, withCommit } from "./packaging/update-defines.ts";

const buildEnv = withCommit(process.env, process.cwd());

export default defineConfig({
  main: {
    // The update feed's address and the build's own release date, fixed here
    // for the update engine; docs/decisions.md, "Updates and release signing".
    // The commit, for support, is this checkout's unless the build names one.
    define: updateDefines(buildEnv, new Date()),
    // Workspace packages ship TypeScript source, so they are bundled rather than required;
    // so are `ws`, which setup's synthetic gateway uses, `undici`, whose connector local
    // connect dials through, and `json5`, which the settings reader's parse worker runs:
    // the packaged app carries no node_modules, and a build outside the checkout reaches none.
    // The parse worker is an entry of its own, beside the app's (settings-reader.ts).
    build: {
      externalizeDeps: {
        exclude: ["@clawtrate/core", "@clawtrate/ui", "ws", "undici", "json5"],
      },
      rolldownOptions: {
        input: { index: "src/main/index.ts", "settings-parse": "src/setup/settings-parse.ts" },
      },
    },
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
