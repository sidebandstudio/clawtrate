import { spawnSync } from "node:child_process";
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
  ])
    expect(() => requireUnsignedEnvironment({ [name]: "" })).toThrow();
  expect(() => requireUnsignedEnvironment({ TRACK: "stable" })).not.toThrow();
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
