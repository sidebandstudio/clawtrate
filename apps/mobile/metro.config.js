// Metro for this app in the pnpm workspace. Expo's defaults find the workspace
// root and follow pnpm's links, so `@clawtrate/core` and the pure modules of
// `@clawtrate/ui` are bundled from their sources, as Vite bundles them for the
// desktop.
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
