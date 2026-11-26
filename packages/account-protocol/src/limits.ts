// Every bound the package enforces. The README gives the reason for each.

/** Device members on one list at once, not counting the connector. */
export const MAX_MEMBERS = 32;
/** Entries in one list, the first included. */
export const MAX_ENTRIES = 1024;
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
/** How long the connector accepts no new device after a refusal. Enforced by the connector. */
export const JOIN_PAUSE_MS = 60 * 60 * 1000;
