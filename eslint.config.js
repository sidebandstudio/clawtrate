import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/.run/**",
      "playwright-report/**",
      "test-results/**",
      // Research prototypes, kept as reference material; not part of the build.
      "docs/research/**",
      // The design prototype: static browser pages, kept exactly as they render.
      "docs/design/prototype/**",
      // Git-ignored local working folder; never part of the repository.
      ".orchestrator/**",
      // The iOS app's native project and build output: `expo prebuild` and `pnpm mobile:build` write them.
      "apps/mobile/ios/**",
      "apps/mobile/build/**",
      "apps/mobile/.expo/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // Shared core must stay free of DOM and Node APIs so it can run in Expo.
    files: ["packages/core/src/**/*.ts"],
    ignores: ["packages/core/src/node/**"],
    languageOptions: { globals: {} },
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["node:*"], message: "core is shared; put Node code in src/node" }] },
      ],
      "no-restricted-globals": ["error", "window", "document", "process", "Buffer", "require"],
    },
  },
  {
    // The interface's pure modules, which the iOS app imports as well: no React
    // and no DOM, so React Native can run them (see packages/ui/package.json).
    files: [
      "packages/ui/src/{access,arrangement,character,connect-words,conversation-words,format,gateway-state,live,screen,strip,summary,unread}.ts",
    ],
    languageOptions: { globals: {} },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["react", "react-dom", "react/*", "react-dom/*"],
              message: "a pure module of the interface uses no React",
            },
            { group: ["*.tsx", "./*.css"], message: "a pure module imports pure modules only" },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        "window",
        "document",
        "navigator",
        "localStorage",
        "process",
        "Buffer",
        "require",
      ],
    },
  },
  {
    // Metro reads its config as CommonJS.
    files: ["apps/mobile/metro.config.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // The iOS app: React Native, which has the WHATWG WebSocket and timers as globals.
    files: ["apps/mobile/src/**/*.{ts,tsx}", "apps/mobile/index.ts"],
    languageOptions: {
      globals: {
        WebSocket: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        console: "readonly",
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Only the pure modules of the interface: its components use the DOM, and React 19.3.1.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@clawtrate/ui",
              message: "import a pure module, such as @clawtrate/ui/summary",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/ui/**/*.{ts,tsx}", "apps/desktop/src/renderer/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
);
