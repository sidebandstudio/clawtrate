// Which signing a build plans, decided from the names of the variables in its
// environment, before electron-builder runs, and what the files' signatures are
// after it. Nothing here prints a value; electron-builder's own output, which
// the build passes through, can. docs/development/packaging.md lists the variables.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export type Env = Record<string, string | undefined>;

export type NotarizeWith = "api-key" | "apple-id" | "keychain-profile";

export interface SigningPlan {
  readonly mac: "developer-id" | "ad-hoc";
  readonly notarize: NotarizeWith | null;
  readonly windows: "certificate" | "unsigned";
}

const set = (env: Env, name: string) => Boolean(env[name]?.trim());

/** The variables of each way to notarize, as electron-builder 26.18.1 reads them. */
const NOTARIZE_SETS: ReadonlyArray<[NotarizeWith, readonly string[]]> = [
  ["apple-id", ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]],
  ["api-key", ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]],
  ["keychain-profile", ["APPLE_KEYCHAIN_PROFILE"]],
];

/** The macOS variables electron-builder reads as set whenever they are not empty. */
const MAC_VARIABLES_TAKEN_AS_GIVEN = [
  "CSC_NAME",
  ...NOTARIZE_SETS.flatMap(([, names]) => names),
  "APPLE_KEYCHAIN",
];

/**
 * The certificate variables a build reads, in electron-builder 26.18.1's own
 * order: the first one set at all, even to an empty string, is the one used
 * (`getCscLink` and `doGetCscPassword` in platformPackager.js, and
 * winPackager.js's `doGetCscPassword` for Windows).
 */
const CERTIFICATE_VARIABLES = {
  mac: { link: ["CSC_LINK"], password: ["CSC_KEY_PASSWORD"] },
  win: {
    link: ["WIN_CSC_LINK", "CSC_LINK"],
    password: ["WIN_CSC_KEY_PASSWORD", "CSC_KEY_PASSWORD"],
  },
} as const;

/** The variable electron-builder takes the value from, or null when none of them is set. */
function chosen(env: Env, names: readonly string[]): string | null {
  return names.find((name) => env[name] !== undefined) ?? null;
}

/** The certificate's variable when it names one: set and not blank. */
function certificate(env: Env, target: "mac" | "win"): string | null {
  const link = chosen(env, CERTIFICATE_VARIABLES[target].link);
  return link && set(env, link) ? link : null;
}

/**
 * macOS signing is on when a Developer ID certificate is named: CSC_LINK (a
 * .p12 file or its base64) or CSC_NAME (an identity already in the keychain).
 */
export function macSigningRequested(env: Env): boolean {
  return certificate(env, "mac") !== null || set(env, "CSC_NAME");
}

/** Windows signing is on when a certificate is given: WIN_CSC_LINK, or else CSC_LINK. */
export function windowsSigningRequested(env: Env): boolean {
  return certificate(env, "win") !== null;
}

/**
 * The certificate and its password go together, as electron-builder would read
 * them: a certificate without a password, a password without a certificate, or
 * a blank variable that electron-builder would take instead of the one after
 * it, is a problem. An empty password is a certificate without one, and must
 * be set empty on purpose.
 */
function certificateProblems(env: Env, target: "mac" | "win"): string[] {
  const names = CERTIFICATE_VARIABLES[target];
  const problems: string[] = [];
  const link = chosen(env, names.link);
  const password = chosen(env, names.password);
  const hidden = (list: readonly string[], name: string) =>
    list.slice(list.indexOf(name) + 1).filter((other) => set(env, other));
  if (link && !set(env, link)) {
    const hides = hidden(names.link, link);
    problems.push(
      hides.length > 0
        ? `${link} is set but blank, and hides ${hides.join(", ")}`
        : `${link} is set but blank`,
    );
  }
  if (password && !set(env, password)) {
    const hides = hidden(names.password, password);
    if (hides.length > 0)
      problems.push(`${password} is set but blank, and hides ${hides.join(", ")}`);
    else if (env[password] !== "")
      problems.push(
        `${password} contains only whitespace (set it empty for a certificate without a password)`,
      );
  }
  const given = certificate(env, target);
  if (given && password === null) {
    problems.push(
      `${given} set without ${names.password.join(" or ")} (set it empty for a certificate without a password)`,
    );
  }
  if (password !== null && link === null) {
    problems.push(`${password} set without ${names.link.join(" or ")}`);
  }
  return problems;
}

/** The first complete set of notarizing credentials, or null. Never throws. */
export function notarizeWith(env: Env): NotarizeWith | null {
  return NOTARIZE_SETS.find(([, names]) => names.every((name) => set(env, name)))?.[0] ?? null;
}

/** What a partial or inconsistent set of variables lacks, by name; empty when it is consistent. */
export function signingProblems(env: Env, target: "mac" | "win"): string[] {
  const problems = certificateProblems(env, target);
  if (target === "win") return problems;
  // electron-builder takes any non-empty value, spaces included (macCodeSign.js
  // for CSC_NAME, MacTargetHelper.getNotarizeOptions for the APPLE_* variables),
  // where this file would not: a blank one is refused here, so both choose alike.
  for (const name of MAC_VARIABLES_TAKEN_AS_GIVEN) {
    if (env[name] !== undefined && !set(env, name)) problems.push(`${name} is set but blank`);
  }
  for (const [, names] of NOTARIZE_SETS) {
    const given = names.filter((name) => set(env, name));
    if (given.length > 0 && given.length < names.length) {
      const missing = names.filter((name) => !set(env, name));
      problems.push(`${given.join(", ")} set without ${missing.join(", ")}`);
    }
  }
  if (set(env, "APPLE_KEYCHAIN") && !set(env, "APPLE_KEYCHAIN_PROFILE")) {
    problems.push("APPLE_KEYCHAIN set without APPLE_KEYCHAIN_PROFILE");
  }
  if (notarizeWith(env) && !macSigningRequested(env)) {
    problems.push("notarizing credentials set without CSC_LINK or CSC_NAME to sign with");
  }
  return problems;
}

export function signingPlan(env: Env): SigningPlan {
  const mac = macSigningRequested(env);
  return {
    mac: mac ? "developer-id" : "ad-hoc",
    notarize: mac ? notarizeWith(env) : null,
    windows: windowsSigningRequested(env) ? "certificate" : "unsigned",
  };
}

/** The one line a build prints, before building, about the signing it plans. */
export function signingSummary(plan: SigningPlan, target: "mac" | "win"): string {
  if (target === "win") {
    return plan.windows === "certificate"
      ? "Signing plan: the Windows installer will be signed with the certificate WIN_CSC_LINK or CSC_LINK names."
      : "Signing plan: none. The Windows installer will be unsigned.";
  }
  if (plan.mac === "ad-hoc")
    return "Signing plan: none. The macOS app will be signed ad hoc and not notarized.";
  return plan.notarize
    ? `Signing plan: the macOS app will be signed with a Developer ID and notarized (${plan.notarize}).`
    : "Signing plan: the macOS app will be signed with a Developer ID and not notarized.";
}

/** What `codesign --display --verbose=2` (its error output) says of an app's signature. */
export function macSignatureKind(codesignOutput: string): "ad hoc" | "certificate" | "none" {
  if (/^Signature=adhoc$/m.test(codesignOutput)) return "ad hoc";
  if (/^Authority=/m.test(codesignOutput)) return "certificate";
  return "none";
}

export function checkMacSignature(
  plan: SigningPlan["mac"],
  result: { status: number | null; stderr: string | null },
) {
  const kind = result.status === 0 ? macSignatureKind(result.stderr ?? "") : "none";
  return { kind, matches: kind === (plan === "developer-id" ? "certificate" : "ad hoc") };
}

/**
 * Windows PowerShell's arguments for a script beside this file: authenticode.ps1,
 * which reads a file's embedded signatures with WinVerifyTrust, or certificate.ps1,
 * which reads a .pfx. The script goes in encoded, so no quoting rule and no script
 * execution policy applies to it.
 */
export function powerShellArgs(script: "authenticode.ps1" | "certificate.ps1"): string[] {
  const text = readFileSync(join(import.meta.dirname, script), "utf8");
  return [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(text, "utf16le").toString("base64"),
  ];
}

/**
 * The environment the scripts run in. Windows PowerShell started from
 * PowerShell 7, as CI's steps are, inherits a module path that finds PowerShell
 * 7's own modules first, and cannot load them. Without the variable it uses its own.
 */
export function powerShellEnv(env: Env): Env {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"),
  );
}

/** authenticode.ps1's output for `file`, for `checkWindowsSignature`. Windows only. */
export function readWindowsSignature(file: string, env: Env) {
  return spawnSync("powershell.exe", powerShellArgs("authenticode.ps1"), {
    encoding: "utf8",
    env: { ...powerShellEnv(env), SIGNED_FILE: file },
  });
}

/** builder-util's readers of a certificate variable's value. */
interface CscLinkReaders {
  decodeCscLinkBase64(link: string): Buffer | null;
  resolveCscLinkPath(link: string, dir: string): string;
}

/**
 * The .pfx and password a Windows build signs with, read as electron-builder
 * 26.18.1 reads them. Its `importCertificate` (app-builder-lib's codeSign/codesign.js),
 * which it does not export, downloads an https address and otherwise reads base64
 * data or a file with builder-util's `decodeCscLinkBase64` and `resolveCscLinkPath`.
 * Those two are called here through electron-builder's own dependency, so both read
 * the value alike. A relative path starts at the app's folder, electron-builder's
 * project folder. An https address is refused, since this reads no network.
 */
export function windowsCertificate(
  env: Env,
  appDir: string,
): { pfx: Buffer; password: string } | { problem: string } {
  const link = certificate(env, "win");
  if (link === null) return { problem: "no Windows certificate is named" };
  const value = (env[link] ?? "").trim();
  if (value.startsWith("https://"))
    return {
      problem: `${link} is an https address, which the build does not download (give a .pfx file's path or its base64 data)`,
    };
  const builder = createRequire(import.meta.url).resolve("electron-builder");
  const { decodeCscLinkBase64, resolveCscLinkPath } = createRequire(builder)(
    "builder-util",
  ) as CscLinkReaders;
  let pfx = decodeCscLinkBase64(value);
  if (pfx === null) {
    try {
      pfx = readFileSync(resolveCscLinkPath(value, appDir));
    } catch {
      return { problem: `${link} names a file that cannot be read` };
    }
  }
  const password = chosen(env, CERTIFICATE_VARIABLES.win.password);
  return { pfx, password: password === null ? "" : (env[password] ?? "").trim() };
}

/**
 * What certificate.ps1 printed: the thumbprint of the one certificate in the .pfx
 * that comes with its private key, which is the one signtool signs with.
 */
export function certificateThumbprint(result: {
  status: number | null;
  stdout: string | null;
}): { thumbprint: string } | { problem: string } {
  const lines = result.stdout?.match(/^.+$/gm) ?? [];
  if (result.status !== 0 || lines.some((line) => !/^[0-9A-F]{40}$/.test(line)))
    return {
      problem: "the certificate WIN_CSC_LINK or CSC_LINK names cannot be opened with its password",
    };
  const [thumbprint] = lines;
  if (lines.length !== 1 || thumbprint === undefined)
    return {
      problem: `the certificate WIN_CSC_LINK or CSC_LINK names holds ${lines.length} certificates with a private key, not one`,
    };
  return { thumbprint };
}

/**
 * The thumbprint of the certificate a Windows build signs with, read from the .pfx
 * in memory by certificate.ps1. Windows only. A problem names variables, never values.
 */
export function windowsSigner(
  env: Env,
  appDir: string,
): { thumbprint: string } | { problem: string } {
  const given = windowsCertificate(env, appDir);
  if ("problem" in given) return given;
  const input = [given.pfx, Buffer.from(given.password)].map((bytes) => bytes.toString("base64"));
  return certificateThumbprint(
    spawnSync("powershell.exe", powerShellArgs("certificate.ps1"), {
      encoding: "utf8",
      env: powerShellEnv(env),
      input: `${input.join("\n")}\n`,
    }),
  );
}

/** WinVerifyTrust's results (winerror.h) that `windowsSignature` accepts, as authenticode.ps1 prints them. */
const VERIFIED = "00000000";
/** CERT_E_UNTRUSTEDROOT: the chain ends in a root this machine does not trust, as a test certificate's does. */
const UNTRUSTED_ROOT = "800b0109";
/** TRUST_E_NOSIGNATURE: the file has no embedded signature. */
const NO_SIGNATURE = "800b0100";
const SHA256 = "2.16.840.1.101.3.4.2.1";

export interface WindowsSignature {
  readonly kind: "certificate" | "none" | "invalid";
  /** The signing certificate's thumbprint, when the kind is certificate. */
  readonly signer: string | null;
}

const INVALID: WindowsSignature = { kind: "invalid", signer: null };

/**
 * What authenticode.ps1 says of a file. A file without an embedded signature is
 * `none`. A signed file is `certificate` when each embedded signature verifies, or
 * fails only on a root this machine does not trust, names its digest algorithm,
 * all name one signer, and one is SHA-256. A file signed twice, as electron-builder
 * does by default (SHA-1, then SHA-256 nested in it), passes only when both
 * signatures do. Any other result, such as an expired or distrusted certificate
 * or a file changed after signing, is invalid, and so is output that is not
 * exactly one complete reading.
 */
export function windowsSignature(output: string): WindowsSignature {
  const [head = "", ...lines] = output.trim().split(/\r?\n/);
  const count = /^checked ([1-9]\d*)$/.exec(head)?.[1];
  if (count === undefined || lines.length !== Number(count)) return INVALID;
  const signatures = [];
  for (const [index, line] of lines.entries()) {
    const [, at, result, digest, signer] =
      /^(\d+) ([0-9a-f]{8}) ([\d.]+|-) ([0-9A-F]{40}|-)$/.exec(line) ?? [];
    if (Number(at) !== index) return INVALID;
    signatures.push({ result, digest, signer });
  }
  const [first] = signatures;
  if (!first) return INVALID;
  if (signatures.length === 1 && first.result === NO_SIGNATURE)
    return first.digest === "-" && first.signer === "-" ? { kind: "none", signer: null } : INVALID;
  const signer = first.signer;
  if (signer === undefined || signer === "-") return INVALID;
  const passes =
    signatures.every(
      (each) =>
        (each.result === VERIFIED || each.result === UNTRUSTED_ROOT) &&
        each.digest !== "-" &&
        each.signer === signer,
    ) && signatures.some(({ digest }) => digest === SHA256);
  return passes ? { kind: "certificate", signer } : INVALID;
}

/**
 * What authenticode.ps1 read of a file, and whether it matches the plan: a
 * signature from the certificate whose thumbprint is `signer`, or no signature
 * when `signer` is null.
 */
export function checkWindowsSignature(
  signer: string | null,
  result: { status: number | null; stdout: string | null },
) {
  const reading = result.status === 0 ? windowsSignature(result.stdout ?? "") : INVALID;
  return {
    ...reading,
    matches:
      signer === null
        ? reading.kind === "none"
        : reading.kind === "certificate" && reading.signer === signer,
  };
}
