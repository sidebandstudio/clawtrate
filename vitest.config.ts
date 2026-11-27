import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "tools/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "test/**/*.test.ts",
      "plugins/*/test/**/*.test.ts",
    ],
    // The run's own temporary folder, removed when it ends; tests that pass leave it empty.
    globalSetup: ["test/run-temp.ts"],
  },
});
