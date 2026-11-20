import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { nativeUnsigned } from "../packaging/check-unsigned.ts";
import { requireUnsignedEnvironment } from "../packaging/unsigned-environment.ts";

it("refuses signing and notarization variables even when empty, before packaging", () => {
  for (const name of [
    "CSC_NAME",
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "WIN_CSC_LINK",
    "WIN_CSC_KEY_PASSWORD",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
    "APPLE_KEYCHAIN",
    "APPLE_KEYCHAIN_PROFILE",
    "SIGNTOOL_PATH",
    "SIGNTOOL_TIMEOUT",
    "USE_SYSTEM_SIGNCODE",
    "USE_SYSTEM_OSSLSIGNCODE",
    "ELECTRON_BUILDER_OSSL_SIGNCODE_PATH",
    "ELECTRON_BUILDER_WINDOWS_KITS_PATH",
  ])
    for (const value of ["", "unused"])
      expect(() => requireUnsignedEnvironment({ [name]: value })).toThrow(
        "The unsigned workflow refuses signing or notarization variables.",
      );
  for (const value of ["", "stable"])
    expect(() => requireUnsignedEnvironment({ TRACK: value })).not.toThrow();
});
it("refuses a Windows signing-tool setting before the build wrapper checks version or epoch", () => {
  const wrapper = fileURLToPath(new URL("../packaging/candidate-build.ts", import.meta.url));
  const result = spawnSync(process.execPath, [wrapper, "staging", "bad", "--unsigned-only"], {
    env: { ...process.env, SOURCE_DATE_EPOCH: "", SIGNTOOL_PATH: "unused" },
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "Error: The unsigned workflow refuses signing or notarization variables.",
  );
});
it("requires a successful native readback on the final staged file", () => {
  const inspect = (key: "mac-x64" | "win-x64", output: string, status = 0) => {
    const run = vi.fn((command: string, args: string[]) => ({
      status: args.includes("--display") || command === "powershell.exe" ? status : 0,
      stdout: output,
      stderr: output,
    }));
    return nativeUnsigned("candidate-file", key, run as unknown as typeof spawnSync);
  };
  expect(inspect("mac-x64", "Signature=adhoc")).toBe(true);
  for (const output of ["Authority=Signer", "Signature=adhoc\nAuthority=Signer", "", "none"])
    expect(inspect("mac-x64", output)).toBe(false);
  expect(inspect("mac-x64", "Signature=adhoc", 1)).toBe(false);
  expect(inspect("win-x64", "NotSigned")).toBe(true);
  for (const output of ["Valid", "HashMismatch", "UnknownError", ""])
    expect(inspect("win-x64", output)).toBe(false);
  expect(inspect("win-x64", "NotSigned", 1)).toBe(false);
});
