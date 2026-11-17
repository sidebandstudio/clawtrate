// Operator scopes and how they imply each other, from the capability map
// (`operatorScopeSatisfied` in OpenClaw 2026.10.6).

export const READ_SCOPE = "operator.read";
export const WRITE_SCOPE = "operator.write";
export const APPROVALS_SCOPE = "operator.approvals";
export const QUESTIONS_SCOPE = "operator.questions";
export const ADMIN_SCOPE = "operator.admin";

/** Tier one: a read-only connection. Every connect asks for this until the user acts. */
export const READ_SCOPES: readonly string[] = [READ_SCOPE];
/**
 * Tier two, asked for in one request the first time the user sends, stops or
 * answers something: sending and stopping need write, approval cards need
 * approvals, and question cards need questions (write does not imply either).
 * Clawtrate never asks for `operator.admin` here, nor for the narrower
 * `operator.sessions.*` scopes.
 */
export const INTERACTIVE_SCOPES: readonly string[] = [
  READ_SCOPE,
  WRITE_SCOPE,
  APPROVALS_SCOPE,
  QUESTIONS_SCOPE,
];

const IMPLIED_BY_WRITE = new Set([
  READ_SCOPE,
  "operator.talk",
  "operator.sessions.read",
  "operator.sessions.write",
]);

/** Whether a set of granted scopes satisfies one required scope. */
export function scopeSatisfied(granted: readonly string[], required: string): boolean {
  if (granted.includes(required) || granted.includes(ADMIN_SCOPE)) return true;
  if (granted.includes(WRITE_SCOPE) && IMPLIED_BY_WRITE.has(required)) return true;
  if (required === "operator.sessions.read") {
    return granted.includes(READ_SCOPE) || granted.includes("operator.sessions.write");
  }
  return false;
}

/**
 * The scopes to request on connect, from what this client recorded it means
 * to hold: always read, plus whichever interactive scopes were granted, in a
 * fixed order. Anything else in storage, including admin, is never asked for.
 */
export function normalizeHeldScopes(held: readonly string[] | undefined): string[] {
  const wanted = new Set(held ?? []);
  return INTERACTIVE_SCOPES.filter((scope) => scope === READ_SCOPE || wanted.has(scope));
}

/** The interactive scopes a grant covers, as the client will hold them. */
export function heldFromGrant(granted: readonly string[]): string[] {
  return INTERACTIVE_SCOPES.filter((scope) => scopeSatisfied(granted, scope));
}
