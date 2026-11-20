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
  if (url.hostname.length > 253) return { ok: false, cause: "address-refused" };
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
 * credentials, and a check of the parsed hostname without resolving it.
 * Returns why it is refused, or null.
 */
export function buildAddressProblem(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "is not an address";
  }
  if (url.hostname.length > 253) return "host name exceeds 253 characters";
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

/**
 * The project's own release downloads. A feed may name a file there, on
 * another origin than its own, and GitHub answers each such address with one
 * redirect to its release-asset host. Only that one redirect is followed.
 * docs/decisions.md, "Updates and release signing", has the reasons.
 */
export interface ReleaseAssets {
  /** `https://github.com/<owner>/<repository>/releases/download/`, ending in a slash. */
  readonly downloadPrefix: string;
  /** The origins a release download may redirect to. */
  readonly assetOrigins: readonly string[];
}

export const GITHUB_RELEASE_ASSETS: ReleaseAssets = {
  downloadPrefix: "https://github.com/sidebandstudio/clawtrate/releases/download/",
  assetOrigins: ["https://release-assets.githubusercontent.com"],
};

/** One path segment of a tag or file name, as GitHub writes them, with no dot segment. */
const RELEASE_SEGMENT = /^(?!\.\.?$)[A-Za-z0-9._~+-]+$/;

/** `<prefix><tag>/<file>` exactly: no query, fragment or credentials. */
export function isReleaseDownload(url: URL, rule: ReleaseAssets): boolean {
  if (url.username || url.password || url.search || url.hash) return false;
  if (!url.href.startsWith(rule.downloadPrefix)) return false;
  const rest = url.href.slice(rule.downloadPrefix.length).split("/");
  return rest.length === 2 && rest.every((segment) => RELEASE_SEGMENT.test(segment));
}

/**
 * The one redirect a file download may follow: from a release download to an
 * asset origin, readable by the same rule as the feed. Null refuses it.
 */
export function releaseAssetRedirect(
  from: URL,
  location: string | undefined,
  rule: ReleaseAssets,
  loopback?: LoopbackHttpForTests,
): URL | null {
  if (!location || !isReleaseDownload(from, rule)) return null;
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    return null;
  }
  if (next.hash || !rule.assetOrigins.includes(next.origin)) return null;
  return readable(next, loopback) ? next : null;
}
