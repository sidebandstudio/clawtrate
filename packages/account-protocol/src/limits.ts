// Every bound the package enforces. The README gives the reason for each.

/** Device members on one list at once, not counting the connector. */
export const MAX_MEMBERS = 32;
/** Adds and restores are refused once a list holds this many entries; removals never are. */
export const GROWTH_LIMIT = 1024;
/**
 * Entries in one list, the first included: the growth limit, then at most a removal of every
 * device and a re-link before each removal of the gateway's own device, and one more re-link.
 */
export const MAX_ENTRIES = GROWTH_LIMIT + 2 * MAX_MEMBERS + 1;
/** A device's or the gateway's name, in UTF-8 bytes. */
export const MAX_NAME_BYTES = 64;
/** Addresses on the gateway's card. */
export const MAX_ADDRESSES = 8;
/** One address's host, in bytes: the longest DNS name. */
export const MAX_HOST_BYTES = 253;
/** The account service's origin in a session request, in bytes. */
export const MAX_AUDIENCE_BYTES = 255;
/** A session request's path, in bytes. */
export const MAX_PATH_BYTES = 512;
/** A session request's body, in bytes, hashed into the request. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** How far a session request's time may be from the service's clock, either way. */
export const SESSION_SKEW_MS = 60_000;
/** How long joins pause after a refusal: on the connector, on the refusing member, on N. */
export const JOIN_PAUSE_MS = 60 * 60 * 1000;
/** How long a member shows the confirmation word after a right pick, at most. */
export const WORD_BACK_MS = 2 * 60 * 1000;
/** How long an entry may go without pairing before the connector withdraws it. Kept by the connector. */
export const WITHDRAW_AFTER_MS = 10 * 60 * 1000;
/** The connector starts a list afresh once it holds more entries than this. */
export const FRESH_START_AFTER = 900;
