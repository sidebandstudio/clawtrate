// OpenClaw's own native module, pinned (docs/design/setup-effortless.md §3,
// check (f)). OpenClaw 2026.10.6 depends on exactly `@openclaw/fs-safe@0.25.0`
// and its per-platform packages. Each module is ad-hoc signed with no team,
// so its code signature proves nothing; the SHA-256 of
// `node_modules/@openclaw/fs-safe-<platform>-<arch>/fs-safe-native.node` is
// what binds it. The hashes are of the files in the packages published to
// npm, fetched with `npm pack` (which checks each tarball against the
// registry's integrity) and extracted without running anything.

export const PINNED_OPENCLAW_VERSION = "2026.10.6";
export const PINNED_FS_SAFE_VERSION = "0.25.0";

/** By the package's suffix, `@openclaw/fs-safe-<suffix>`. */
export const FS_SAFE_NATIVE_SHA256: Readonly<Record<string, string>> = {
  "darwin-arm64": "1290155ebce0960c005ed3abda4fbb7a98639b0ffb25ad69bdc96fddc9ce7180",
  "darwin-x64": "db76df06c549c97f84ebb242eb6b5bc3a0124b5d120c4df6c0965a6f11091302",
  "linux-arm64-gnu": "45069d533da412be9b5073ff7ac13a0449cbd66cdb451b2661a2f794d271b29d",
  "linux-arm64-musl": "0b898908bf020dfd284a65093bfe17b96591e732dbdab7bc9b67587abf347791",
  "linux-x64-gnu": "46eae38fbca2c67fb712cc198cbb42645527f6c1236df49a253b721d337b56b1",
  "linux-x64-musl": "c0f507b9c22778decbdda17298098526e484669e9c13150e0633c0920726a93c",
};
