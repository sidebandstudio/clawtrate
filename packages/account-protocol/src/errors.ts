// The package's one error type. Every refusal has its own code. Messages name what failed,
// never a key, secret, nonce or any other value from the input.

export type AccountProtocolErrorCode =
  /** An argument from the caller is the wrong length or kind: a programming error, not input. */
  | "bad_argument"
  /** Bytes are shorter, longer or shaped differently than their type allows. */
  | "malformed"
  /** The bytes carry this kind's label with a version this package does not speak. */
  | "unsupported_version"
  /** A field, a list or a count is over its bound. */
  | "too_large"
  /** Bytes are not a valid public key of the expected kind. */
  | "bad_key"
  /** A signature does not verify under the key and label it must verify under. */
  | "bad_signature"
  /** The object is for another gateway. */
  | "wrong_gateway"
  /** The object is for another account. */
  | "wrong_account"
  /** An entry's position or previous hash does not follow the list: reordered, repeated or forked. */
  | "bad_chain"
  /** The signer has never been a member of the list. */
  | "not_member"
  /** The signer was a member and has been removed. */
  | "removed_member"
  /** The signer's role may not sign this. */
  | "not_permitted"
  /** The target may not be removed this way. */
  | "protected_member"
  /** The target is not in the state the entry needs (a current member, or one put back). */
  | "bad_target"
  /** A key in a new device's record is already on the list, or was. */
  | "duplicate_key"
  /** The list already holds its most entries or members. */
  | "list_full"
  /** The reveal does not open the commitment. */
  | "commitment_mismatch"
  /** A join message belongs to another join, or to another step of this one. */
  | "transcript_mismatch"
  /** The gateway's card is not the one the words covered, or not the list's connector's. */
  | "card_mismatch"
  /** Sealed bytes did not open: changed, for another context, or under another key. */
  | "decrypt_failed"
  /** A time is not a whole number of milliseconds, or is outside the window allowed. */
  | "bad_time"
  /** A session request answers another challenge, audience or request. */
  | "bad_challenge"
  /** A new list secret is not newer than the one held. */
  | "stale_secret";

export class AccountProtocolError extends Error {
  readonly code: AccountProtocolErrorCode;

  constructor(code: AccountProtocolErrorCode, message: string) {
    super(message);
    this.name = "AccountProtocolError";
    this.code = code;
  }
}

export function fail(code: AccountProtocolErrorCode, message: string): never {
  throw new AccountProtocolError(code, message);
}
