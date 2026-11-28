// OpenClaw's own native module, pinned (docs/design/setup-effortless.md §3,
// check (f)): a consistency check where the app has a pin, which authenticates
// nothing (docs/decisions.md, "Local connect's proof"). OpenClaw 2026.10.6 depends on exactly `@openclaw/fs-safe@0.25.0`
// and its per-platform packages, 2026.11.10 and 2026.11.11 on exactly `@openclaw/fs-safe@0.27.1`
// (each `package.json`'s `dependencies` and `optionalDependencies`), so those two share one table. Each macOS module is ad-hoc signed with no team,
// so its code signature proves nothing; the SHA-256 of
// `node_modules/@openclaw/fs-safe-<suffix>/fs-safe-native.node` is
// what binds it. The macOS and Linux hashes are of the files in the packages
// published to npm, fetched with `npm pack` (which checks each tarball against
// the registry's integrity) and extracted without running anything. Windows
// x64's is of that file in the package published to npm, read without running
// anything from a tarball that matched the registry's `dist.integrity`. There
// is no pin for Windows on Arm. On Windows only a test checks a pin, against
// an installed package's bytes on disk and never a running gateway, because
// the proof refuses there (local-prove.ts).

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
  "win32-x64-msvc": "5d90ece5908fe7e0326c6f50aca43e1e5712958cfdfc2f249858ab519eec31f9",
};

/**
 * OpenClaw 2026.11.10's and 2026.11.11's modules, `@openclaw/fs-safe-<suffix>@0.27.1`: macOS only,
 * where the proof runs.
 */
export const FS_SAFE_1110_SHA256: Readonly<Record<string, string>> = {
  "darwin-arm64": "3ddcdbba4f82b40b42fe8fd870d4bc699cb118031cfcd5973016c6afac292436",
  "darwin-x64": "2117f146a90ac10e7531ddfc4ce74690369e07090c8a7a9b82a50525a3f9986b",
};

/**
 * Every pinned OpenClaw version, by the version its own `package.json` gives,
 * with that version's module pins. A holder mapping a module in a package that
 * names one of these must map that version's own (`pin`); any other holder
 * stands on the proof's other checks (local-prove.ts).
 */
export const OPENCLAW_PINS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [PINNED_OPENCLAW_VERSION]: FS_SAFE_NATIVE_SHA256,
  "2026.11.10": FS_SAFE_1110_SHA256,
  "2026.11.11": FS_SAFE_1110_SHA256,
};

/** The `@openclaw/fs-safe` each pinned version depends on exactly, whose modules those are. */
export const PINNED_FS_SAFE: Readonly<Record<string, string>> = {
  [PINNED_OPENCLAW_VERSION]: PINNED_FS_SAFE_VERSION,
  "2026.11.10": "0.27.1",
  "2026.11.11": "0.27.1",
};
