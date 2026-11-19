// Which addresses the engine reads from. The feed's address is fixed when the
// app is built; this only decides whether an address may be read at all.

/**
 * Plain HTTP to the test's own server: `http://127.0.0.1:<port>` and nothing
 * else. Only a test passes it; the production constructor never does, and no
 * variable, file or message can.
 */
export interface LoopbackHttpForTests {
  readonly port: number;
}

/** The placeholder the repository uses; a build that still names it has no feed. */
export const PLACEHOLDER_HOST_SUFFIX = ".example";

export type AddressCheck =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly cause: "not-configured" | "address-refused" };

export function checkFeedAddress(
  text: string | null | undefined,
  loopback?: LoopbackHttpForTests,
): AddressCheck {
  if (!text) return { ok: false, cause: "not-configured" };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, cause: "address-refused" };
  }
  if (url.hostname.endsWith(PLACEHOLDER_HOST_SUFFIX)) {
    return { ok: false, cause: "not-configured" };
  }
  return readable(url, loopback) ? { ok: true, url } : { ok: false, cause: "address-refused" };
}

/** HTTPS without credentials, or the test's own loopback server over HTTP. */
export function readable(url: URL, loopback?: LoopbackHttpForTests): boolean {
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    loopback !== undefined &&
    Number.isInteger(loopback.port) &&
    loopback.port > 0 &&
    url.hostname === "127.0.0.1" &&
    url.port === String(loopback.port)
  );
}

/**
 * The build's own check of `CLAWTRATE_UPDATE_FEED_URL`: HTTPS, no
 * credentials, and not a loopback host, which only a test may read.
 * Returns why it is refused, or null.
 */
export function buildAddressProblem(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "is not an address";
  }
  if (url.protocol !== "https:") return "must use https";
  if (url.username || url.password) return "must not carry a user name or password";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\./.test(host)
  ) {
    return "must not name a loopback host";
  }
  return null;
}
