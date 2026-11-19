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
