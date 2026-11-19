// Which signing a build does, decided from the names of the variables in its
// environment, before electron-builder runs. Values are never printed.
// docs/development/packaging.md lists the variables.

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

/**
 * macOS signing is on when a Developer ID certificate is named: CSC_LINK (a
 * .p12 file or its base64) or CSC_NAME (an identity already in the keychain).
 */
export function macSigningRequested(env: Env): boolean {
  return set(env, "CSC_LINK") || set(env, "CSC_NAME");
}

/** Windows signing is on when a certificate is given: WIN_CSC_LINK, or CSC_LINK. */
export function windowsSigningRequested(env: Env): boolean {
  return set(env, "WIN_CSC_LINK") || set(env, "CSC_LINK");
}

/** The first complete set of notarizing credentials, or null. Never throws. */
export function notarizeWith(env: Env): NotarizeWith | null {
  return NOTARIZE_SETS.find(([, names]) => names.every((name) => set(env, name)))?.[0] ?? null;
}

/** What a partial or inconsistent set of variables lacks, by name; empty when it is consistent. */
export function signingProblems(env: Env, target: "mac" | "win"): string[] {
  if (target === "win") return [];
  const problems: string[] = [];
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

/** The one line a build prints about its signing. */
export function signingSummary(plan: SigningPlan, target: "mac" | "win"): string {
  if (target === "win") {
    return plan.windows === "certificate"
      ? "Signing: the Windows installer is signed with the certificate WIN_CSC_LINK or CSC_LINK names."
      : "Signing: none. The Windows installer is unsigned.";
  }
  if (plan.mac === "ad-hoc")
    return "Signing: none. The macOS app is signed ad hoc and not notarized.";
  return plan.notarize
    ? `Signing: the macOS app is signed with a Developer ID and notarized (${plan.notarize}).`
    : "Signing: the macOS app is signed with a Developer ID and not notarized.";
}

/** What `codesign --display --verbose=2` (its error output) says of an app's signature. */
export function macSignatureKind(codesignOutput: string): "ad hoc" | "certificate" | "none" {
  if (/^Signature=adhoc$/m.test(codesignOutput)) return "ad hoc";
  if (/^Authority=/m.test(codesignOutput)) return "certificate";
  return "none";
}
