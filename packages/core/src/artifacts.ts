// What a bot hands over (docs/design/work-pane.md, Part 2): the task's
// artifacts as the gateway lists them, one item's content for the card, the
// pane and the viewer, a page of the gateway's canvas, an item's record for
// Raw, and a link's preview. Like the Files tab's readers (`files.ts`),
// nothing here is kept in the state: each answer goes to the viewer that
// asked, and content crosses in the bounded chunks of `FileTransfers`.
//
// What the gateway does (OpenClaw 2026.10.6, exercised on a development
// gateway; docs/decisions.md, "Artifacts and media"):
//
// - A bot hands a file over by naming it in its reply. The gateway copies it
//   into its media store and puts a block on the reply with a managed id
//   (`artifact_managed_image_…`, `artifact_managed_media_…`); `artifacts.list`
//   lists each with download mode `url`.
// - `artifacts.download` answers such an item with a path on the gateway,
//   `/api/chat/media/outgoing/<session>/<id>/full?mediaTicket=…`, signed for
//   five minutes, with or without `transport: "http"`. The ticket alone opens
//   it: anyone holding the address can fetch it until it expires, so it never
//   leaves this process. The same ticket opens `…/thumbnail`, a PNG the
//   gateway makes of a picture, which can be larger than the picture itself.
// - An item with its bytes in the transcript (mode `bytes`) comes inline as
//   base64, or, when too large for the socket, through
//   `/api/artifacts/download/<connection>/<ticket>`, bound to this
//   connection, where `?variant=thumbnail` asks for a smaller PNG.
// - Mode `url` with any other address is somewhere else: never fetched here.
// - A stored copy the gateway no longer has is still listed, and its
//   download fails with `artifact_not_found`.

import { fromBase64, sha256Hex, utf8Bytes } from "./bytes.ts";
import { refusalOf, type FileTransferStart, type FileTransfers } from "./files.ts";
import type { HttpFetch, HttpResponseLike, LinkPreview, LinkPreviewer } from "./host.ts";
import { asRecord } from "./mapping.ts";

// Bounds ----------------------------------------------------------------------

/**
 * Clawtrate's limit for an item it opens, saves or copies: the most a viewer
 * is sent (`MAX_TRANSFER_BYTES`). The gateway attaches documents up to the
 * same 5 MiB, pictures after it has fitted them, and recordings and videos of
 * any size; the pane says "Clawtrate's limit" when an item is over it.
 */
export const MAX_ARTIFACT_BYTES = 5_242_880;
/** A card draws a picture from its own bytes up to this; a larger one asks for a thumbnail (section 11). */
export const INLINE_PREVIEW_BYTES = 262_144;
/** The most of a thumbnail the device accepts (section 11): anything larger is "No preview". */
export const MAX_PREVIEW_BYTES = 2_097_152;
/** Items one list answer carries; the rest are counted in `omitted`. */
export const MAX_LISTED_ARTIFACTS = 64;
/** An item's record for Raw is cut to this many characters. */
export const MAX_RECORD_TEXT_CHARS = 8_192;
/** Titles, types and ids longer than this are cut (titles) or the item is dropped (ids). */
export const MAX_ARTIFACT_FIELD_CHARS = 1_024;
/** The longest address an item at another place, or a link to preview, may have. */
export const MAX_ADDRESS_CHARS = 2_048;
/** How long a fetch from the gateway may take before it is given up. */
export const ARTIFACT_FETCH_TIMEOUT_MS = 30_000;

// Types -----------------------------------------------------------------------

export type ArtifactKind = "file" | "image" | "audio" | "video";

/** Where an item's content is, from its download mode and, for an address, the address. */
export type ArtifactPlace =
  /**
   * Its bytes come from the gateway: in the transcript, or through a download
   * the gateway issued (a managed ticket or a connection grant). Open and Download.
   */
  | { kind: "gateway" }
  /**
   * At an address the transcript names, on the gateway's origin or anywhere
   * else, that the gateway did not issue as a download: never fetched by
   * Clawtrate, only opened in the browser on the person's choice, with the
   * whole address shown first.
   */
  | { kind: "elsewhere"; host: string; url: string }
  /** Not established when the list was read: it is read, and classified, only when opened. */
  | { kind: "unknown" }
  /** The gateway lists it with no content it can send (`unsupported`). */
  | { kind: "none" };

export type Artifact = {
  /** One occurrence in the transcript: message, position among its items, and the gateway's id. */
  key: string;
  /** The gateway's id, for Raw and Download; not unique per occurrence. */
  id: string;
  kind: ArtifactKind;
  /** The bot's title, file name or alt text, or a label the gateway made up. Not proof of a file name. */
  title: string;
  mimeType: string | null;
  size: number | null;
  runId: string | null;
  messageSeq: number | null;
  /** Its position among the items of its message, in the gateway's order. */
  position: number;
  mode: "bytes" | "url" | "unsupported";
  place: ArtifactPlace;
};

export type ArtifactList = {
  key: string;
  /** In the transcript's order, as the gateway lists them. */
  artifacts: Artifact[];
  /** Items listed but not carried: past `MAX_LISTED_ARTIFACTS`, or past the viewer's channel. */
  omitted: number;
  checkedAt: number;
};

/** What a viewer does with the bytes: shows them as text, draws them, plays them, or only saves them. */
export type ArtifactContentKind = "text" | "image" | "audio" | "video" | "other";

export type ArtifactRead =
  | {
      status: "content";
      kind: ArtifactContentKind;
      mimeType: string;
      bytes: number;
      hash: string;
      /** A thumbnail, not the item's own bytes: never saved as the item. */
      thumbnail: boolean;
      transfer: FileTransferStart;
    }
  | { status: "elsewhere"; host: string; url: string }
  /** The gateway lists the item with no content (`unsupported`). */
  | { status: "unsupported" }
  /** Over Clawtrate's limit (`MAX_ARTIFACT_BYTES`), from the size the gateway gave or the bytes it sent. */
  | { status: "too-large"; size: number | null; limit: number }
  /** A preview was asked for, and nothing the device accepts came back: "No preview". */
  | { status: "no-preview"; reason: string }
  /** The gateway no longer has the item (`artifact_not_found`). */
  | { status: "gone"; message: string }
  | { status: "failed"; message: string };

export type ArtifactRecord =
  { status: "ok"; text: string; cut: boolean } | { status: "failed"; message: string };

export type PageRead =
  | { status: "content"; bytes: number; hash: string; transfer: FileTransferStart }
  | { status: "too-large"; limit: number }
  | { status: "failed"; message: string };

export type ArtifactPart = "full" | "preview";

export type ArtifactContext = {
  request: (method: string, params: unknown) => Promise<unknown>;
  /** The host's HTTP fetch; absent where the host has none, and then no address is fetched. */
  fetch: HttpFetch | null;
  /** The gateway's WebSocket address, whose origin is the only one ever fetched. */
  gatewayUrl: string;
  transfers: FileTransfers;
  owner: object;
  maxChars?: number | undefined;
  now: () => number;
};

// Mapping ---------------------------------------------------------------------

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;
const int = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
const cut = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);

const KINDS: readonly ArtifactKind[] = ["file", "image", "audio", "video"];

/** Managed ids say by themselves that the item is in the gateway's own media store. */
export const isManagedArtifactId = (id: string) =>
  /^artifact_managed_(image|media)_[0-9a-f-]+$/i.test(id);

/** The gateway's HTTP origin, from its WebSocket address: `ws:` to `http:`, `wss:` to `https:`. */
export function gatewayOrigin(gatewayUrl: string): string | null {
  try {
    const url = new URL(gatewayUrl);
    if (url.protocol === "ws:") return `http://${url.host}`;
    if (url.protocol === "wss:") return `https://${url.host}`;
    return null;
  } catch {
    return null;
  }
}

const MANAGED_DOWNLOAD =
  /^\/api\/chat\/media\/outgoing\/([^/?#]+)\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/full$/i;
const GRANT_DOWNLOAD = /^\/api\/artifacts\/download\/[^/?#]+\/[A-Za-z0-9_-]{43}$/;
const MEDIA_TICKET = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** A download the gateway issued itself, as the host fetches it. */
export type IssuedDownload = { kind: "ticket" | "grant"; url: string };

/**
 * A download address the gateway issued, from an `artifacts.download`
 * answer, or null. Only two forms are: a managed media ticket for this task's
 * own session (`/api/chat/media/outgoing/<session>/<attachment>/full?mediaTicket=v1.…`)
 * and a connection-bound grant (`/api/artifacts/download/<connection>/<ticket>`),
 * each a path on the gateway's own origin, exactly as written, with no user
 * information, and answered with its `expiresAt`. An item with no managed
 * replacement is answered with the address its transcript block names and no
 * `expiresAt` (OpenClaw 2026.10.6, `artifacts.download`), whatever that
 * address looks like: it is never one of these.
 */
export function issuedDownload(
  answer: unknown,
  gatewayUrl: string,
  sessionKey: string,
): IssuedDownload | null {
  const record = asRecord(answer);
  const address = str(record?.url);
  const origin = gatewayOrigin(gatewayUrl);
  if (!address || !origin || !str(record?.expiresAt) || address.length > MAX_ADDRESS_CHARS)
    return null;
  if (!address.startsWith("/") || address.startsWith("//")) return null;
  let url: URL;
  try {
    url = new URL(address, origin);
  } catch {
    return null;
  }
  // Written exactly as the gateway's own routes are: nothing the parser had to normalize.
  if (`${url.pathname}${url.search}` !== address || `${url.protocol}//${url.host}` !== origin)
    return null;
  if (url.username || url.password || url.hash) return null;
  const managed = MANAGED_DOWNLOAD.exec(url.pathname);
  if (managed) {
    let session: string;
    try {
      session = decodeURIComponent(managed[1]!);
    } catch {
      return null;
    }
    const keys = [...url.searchParams.keys()];
    if (session !== sessionKey || keys.length !== 1 || keys[0] !== "mediaTicket") return null;
    if (!MEDIA_TICKET.test(url.searchParams.get("mediaTicket") ?? "")) return null;
    return { kind: "ticket", url: url.toString() };
  }
  if (GRANT_DOWNLOAD.test(url.pathname) && url.search === "")
    return { kind: "grant", url: url.toString() };
  return null;
}

/**
 * An address a transcript names, whole, for the person to open on their
 * choice: an `http:` or `https:` address, or a path, which is on the
 * gateway's origin. Null for anything else. Never fetched by Clawtrate.
 */
export function transcriptAddress(
  address: string,
  gatewayUrl: string,
): { kind: "elsewhere"; host: string; url: string } | null {
  if (address.length > MAX_ADDRESS_CHARS) return null;
  const origin = gatewayOrigin(gatewayUrl);
  let url: URL;
  try {
    url =
      address.startsWith("/") && !address.startsWith("//") && origin
        ? new URL(address, origin)
        : new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return { kind: "elsewhere", host: url.hostname, url: url.toString() };
}

/** One record of `artifacts.list` as a card's facts; null for a record without an id or kind. */
export function mapArtifact(raw: unknown, position: number): Artifact | null {
  const record = asRecord(raw);
  const id = str(record?.id);
  const kind = str(record?.type);
  if (!record || !id || id.length > MAX_ARTIFACT_FIELD_CHARS) return null;
  if (!kind || !(KINDS as readonly string[]).includes(kind)) return null;
  const mode = str(asRecord(record.download)?.mode);
  const messageSeq = int(record.messageSeq);
  return {
    key: `${messageSeq ?? "?"}:${position}:${id}`,
    id,
    kind: kind as ArtifactKind,
    title: cut(str(record.title) ?? `${kind} ${position + 1}`, MAX_ARTIFACT_FIELD_CHARS),
    mimeType: str(record.mimeType) ? cut(String(record.mimeType), 255) : null,
    size: int(record.sizeBytes),
    runId: str(record.runId) ? cut(String(record.runId), MAX_ARTIFACT_FIELD_CHARS) : null,
    messageSeq,
    position,
    mode: mode === "bytes" || mode === "url" ? mode : "unsupported",
    // Until its address is known: on the gateway for bytes and managed ids, none for unsupported.
    place: mode === "bytes" || mode === "url" ? { kind: "gateway" } : { kind: "none" },
  };
}

/** Positions count within each message, in the gateway's order. */
function positioned(records: unknown[]): Artifact[] {
  const seen = new Map<string, number>();
  const out: Artifact[] = [];
  for (const raw of records) {
    const seq = String(int(asRecord(raw)?.messageSeq) ?? "?");
    const position = seen.get(seq) ?? 0;
    seen.set(seq, position + 1);
    const artifact = mapArtifact(raw, position);
    if (artifact) out.push(artifact);
  }
  return out;
}

/** Keep what fits an answer of `maxChars`, in order; the rest are counted. */
function fitting<T>(items: T[], maxChars: number | undefined): { kept: T[]; omitted: number } {
  if (maxChars === undefined) return { kept: items, omitted: 0 };
  let used = 2_048;
  const kept: T[] = [];
  for (const item of items) {
    const size = JSON.stringify(item).length + 1;
    if (used + size > maxChars) break;
    used += size;
    kept.push(item);
  }
  return { kept, omitted: items.length - kept.length };
}

// Listing ---------------------------------------------------------------------

/**
 * The task's items, from the one query the design uses: `artifacts.list` with
 * `messageRole: "assistant"` and no type, so the person's own uploads and
 * tools' outputs are not listed. An item at an address whose id does not say
 * it is the gateway's own is asked for its address (`artifacts.download`,
 * which fetches nothing), so a card can say where it is before anyone opens
 * it; the address is kept only when it is somewhere else.
 */
export async function listArtifacts(ctx: ArtifactContext, key: string): Promise<ArtifactList> {
  const answer = asRecord(
    await ctx.request("artifacts.list", { sessionKey: key, messageRole: "assistant" }),
  );
  const records = Array.isArray(answer?.artifacts) ? answer.artifacts : [];
  const all = positioned(records);
  const listed = all.slice(0, MAX_LISTED_ARTIFACTS);
  for (const artifact of listed) {
    if (artifact.mode !== "url" || isManagedArtifactId(artifact.id)) continue;
    try {
      const download = asRecord(
        await ctx.request("artifacts.download", { sessionKey: key, artifactId: artifact.id }),
      );
      if (issuedDownload(download, ctx.gatewayUrl, key)) continue;
      const address = str(download?.url);
      artifact.place = (address && transcriptAddress(address, ctx.gatewayUrl)) || { kind: "none" };
    } catch {
      // Not established: nothing is fetched for it by itself; opening it asks again.
      artifact.place = { kind: "unknown" };
    }
  }
  const { kept, omitted } = fitting(listed, ctx.maxChars);
  return {
    key,
    artifacts: kept,
    omitted: omitted + (all.length - listed.length) + (records.length - all.length),
    checkedAt: ctx.now(),
  };
}

// Reading ---------------------------------------------------------------------

const TEXT_TYPES = [
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
];

/** What the device does with bytes of this type. */
export function contentKind(mimeType: string): ArtifactContentKind {
  const type = mimeType.split(";")[0]!.trim().toLowerCase();
  if (type === "image/svg+xml") return "other";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("text/") || TEXT_TYPES.includes(type)) return "text";
  return "other";
}

class TooLarge extends Error {}

/**
 * Fetch an address on the gateway, with no cookies, no redirects and no
 * credentials but what the address itself carries, reading at most `limit`
 * bytes. Only the gateway's own origin is ever passed here.
 */
async function fetchFromGateway(
  ctx: ArtifactContext,
  url: string,
  limit: number,
): Promise<{ status: number; mimeType: string | null; data: Uint8Array }> {
  if (!ctx.fetch) throw new Error("This app can't fetch from the gateway here.");
  const origin = gatewayOrigin(ctx.gatewayUrl);
  if (!origin || !url.startsWith(`${origin}/`))
    throw new Error("Only the gateway's own addresses are fetched.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARTIFACT_FETCH_TIMEOUT_MS);
  let response: HttpResponseLike;
  try {
    response = await ctx.fetch(url, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    // The download address is a capability: no error says it, or anything that might.
    throw new Error(
      controller.signal.aborted
        ? "The gateway did not send it in time."
        : "Couldn't reach the gateway.",
      { cause: error },
    );
  }
  try {
    const mimeType = response.headers.get("content-type");
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => {});
      return { status: response.status, mimeType, data: new Uint8Array(0) };
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) {
      await response.body?.cancel().catch(() => {});
      throw new TooLarge();
    }
    const parts: Uint8Array[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.length;
        if (total > limit) {
          await reader.cancel().catch(() => {});
          throw new TooLarge();
        }
        parts.push(value);
      }
    }
    const data = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      data.set(part, at);
      at += part.length;
    }
    return { status: response.status, mimeType, data };
  } finally {
    clearTimeout(timer);
  }
}

/** The thumbnail address the gateway serves beside a full one, or null where it serves none. */
export function thumbnailAddress(url: string): string | null {
  const [path, query] = url.split("?", 2) as [string, string | undefined];
  if (/\/api\/chat\/media\/outgoing\/[^/]+\/[^/]+\/full$/.test(path))
    return `${path.replace(/\/full$/, "/thumbnail")}${query ? `?${query}` : ""}`;
  if (/\/api\/artifacts\/download\//.test(path))
    return `${path}?${query ? `${query}&` : ""}variant=thumbnail`;
  return null;
}

const failure = (error: unknown): ArtifactRead => {
  const refusal = refusalOf(error);
  if (refusal.type === "artifact_not_found")
    return { status: "gone", message: "The gateway no longer has this item." };
  if (refusal.type === "artifact_download_unsupported" && !/transport/i.test(refusal.message))
    return { status: "unsupported" };
  return { status: "failed", message: refusal.message };
};

function content(
  ctx: ArtifactContext,
  data: Uint8Array,
  mimeType: string,
  thumbnail: boolean,
): ArtifactRead {
  return {
    status: "content",
    kind: contentKind(mimeType),
    mimeType,
    bytes: data.length,
    hash: sha256Hex(data),
    thumbnail,
    transfer: ctx.transfers.start(ctx.owner, data, ctx.maxChars),
  };
}

/** The type the gateway's answer names, else the item's own, else bytes of no known type. */
const typeOf = (header: string | null, fallback: string | null) =>
  str(header?.split(";")[0]) ?? fallback ?? "application/octet-stream";

/**
 * One item's content. `full` is the item's bytes, for the pane, the viewer,
 * Download and Copy, within Clawtrate's limit. `preview` is what a card draws:
 * a picture's own bytes up to 256 KB, else the gateway's thumbnail, accepted
 * only when it is a picture of at most 2 MB. An address elsewhere is never
 * fetched: it is answered as `elsewhere`, for the person to open in their
 * browser. Only `artifacts.download` names what is fetched, and only an
 * address on the gateway is.
 */
export async function readArtifact(
  ctx: ArtifactContext,
  key: string,
  artifactId: string,
  part: ArtifactPart,
): Promise<ArtifactRead> {
  let record: Artifact | null;
  try {
    const got = asRecord(await ctx.request("artifacts.get", { sessionKey: key, artifactId }));
    record = mapArtifact(got?.artifact, 0);
  } catch (error) {
    return failure(error);
  }
  if (!record) return { status: "gone", message: "The gateway no longer lists this item." };
  if (record.mode === "unsupported") return { status: "unsupported" };
  const preview = part === "preview";
  if (preview && record.kind !== "image")
    return { status: "no-preview", reason: "Only pictures have previews." };
  const ownBytes = !preview || (record.size !== null && record.size <= INLINE_PREVIEW_BYTES);
  if (!preview && record.size !== null && record.size > MAX_ARTIFACT_BYTES)
    return { status: "too-large", size: record.size, limit: MAX_ARTIFACT_BYTES };

  // Bytes in the transcript: inline when they fit the socket, else over HTTP.
  if (record.mode === "bytes" && ownBytes) {
    try {
      const answer = asRecord(
        await ctx.request("artifacts.download", { sessionKey: key, artifactId }),
      );
      const data = str(answer?.data);
      if (data !== null) {
        const bytes = decodeBase64(data, preview ? MAX_PREVIEW_BYTES : MAX_ARTIFACT_BYTES);
        if (bytes === "too-large")
          return preview
            ? { status: "no-preview", reason: "The picture is larger than a preview." }
            : { status: "too-large", size: record.size, limit: MAX_ARTIFACT_BYTES };
        if (!bytes)
          return { status: "failed", message: "The gateway sent content that isn't base64." };
        return content(ctx, bytes, typeOf(null, record.mimeType), false);
      }
    } catch (error) {
      const refusal = refusalOf(error);
      // "artifact is too large for inline transfer; request transport: "http"": go on below.
      if (!(refusal.type === "artifact_download_unsupported" && /transport/i.test(refusal.message)))
        return failure(error);
    }
  }

  let answer: Record<string, unknown> | null;
  try {
    answer = asRecord(
      await ctx.request("artifacts.download", { sessionKey: key, artifactId, transport: "http" }),
    );
  } catch (error) {
    return failure(error);
  }
  // Only what the gateway issued as a download is fetched; any other address
  // is the transcript's, and the person may open it, never this host.
  const issued = issuedDownload(answer, ctx.gatewayUrl, key);
  if (!issued) {
    const address = str(answer?.url);
    const named = address ? transcriptAddress(address, ctx.gatewayUrl) : null;
    if (named) return { status: "elsewhere", host: named.host, url: named.url };
    return { status: "failed", message: "The gateway gave no download for this item." };
  }

  const url = ownBytes ? issued.url : thumbnailAddress(issued.url);
  if (!url)
    return { status: "no-preview", reason: "The gateway serves no thumbnail for this item." };
  const limit = preview ? MAX_PREVIEW_BYTES : MAX_ARTIFACT_BYTES;
  let got: Awaited<ReturnType<typeof fetchFromGateway>>;
  try {
    got = await fetchFromGateway(ctx, url, limit);
  } catch (error) {
    if (error instanceof TooLarge)
      return preview
        ? { status: "no-preview", reason: "The gateway's preview is over 2 MB." }
        : { status: "too-large", size: record.size, limit: MAX_ARTIFACT_BYTES };
    return preview
      ? { status: "no-preview", reason: error instanceof Error ? error.message : String(error) }
      : { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
  if (got.status === 404)
    return preview
      ? { status: "no-preview", reason: "The gateway has no preview of this item." }
      : { status: "gone", message: "The gateway no longer has this item." };
  if (got.status < 200 || got.status >= 300)
    return preview
      ? { status: "no-preview", reason: `The gateway answered ${got.status}.` }
      : { status: "failed", message: `The gateway answered ${got.status}.` };
  const mimeType = typeOf(got.mimeType, record.mimeType);
  if (preview && contentKind(mimeType) !== "image")
    return { status: "no-preview", reason: "The gateway's preview isn't a picture." };
  return content(ctx, got.data, mimeType, preview && !ownBytes);
}

/** Decoded base64 within `limit` bytes; null when it is not base64. */
function decodeBase64(data: string, limit: number): Uint8Array | "too-large" | null {
  if (Math.floor((data.length * 3) / 4) > limit + 3) return "too-large";
  const bytes = fromBase64(data);
  if (!bytes) return null;
  return bytes.length > limit ? "too-large" : bytes;
}

/** The record `artifacts.get` returns, for Raw: no data and no address, as the gateway leaves them out. */
export async function readArtifactRecord(
  ctx: Pick<ArtifactContext, "request">,
  key: string,
  artifactId: string,
): Promise<ArtifactRecord> {
  try {
    const got = await ctx.request("artifacts.get", { sessionKey: key, artifactId });
    const text = JSON.stringify(got ?? null, null, 2);
    return text.length > MAX_RECORD_TEXT_CHARS
      ? { status: "ok", text: text.slice(0, MAX_RECORD_TEXT_CHARS), cut: true }
      : { status: "ok", text, cut: false };
  } catch (error) {
    return { status: "failed", message: refusalOf(error).message };
  }
}

/**
 * A page of the gateway's canvas (`canvas.document.view {docId}`): its HTML,
 * for the viewer to show in a frame of its own with no scripts and nothing
 * fetched from anywhere.
 */
export async function readPage(ctx: ArtifactContext, docId: string): Promise<PageRead> {
  try {
    const got = asRecord(await ctx.request("canvas.document.view", { docId }));
    const html = typeof got?.html === "string" ? got.html : null;
    if (html === null) return { status: "failed", message: "The gateway sent no page." };
    const bytes = utf8Bytes(html);
    if (bytes.length > MAX_ARTIFACT_BYTES)
      return { status: "too-large", limit: MAX_ARTIFACT_BYTES };
    return {
      status: "content",
      bytes: bytes.length,
      hash: sha256Hex(bytes),
      transfer: ctx.transfers.start(ctx.owner, bytes, ctx.maxChars),
    };
  } catch (error) {
    return { status: "failed", message: refusalOf(error).message };
  }
}

// Link previews ---------------------------------------------------------------

/**
 * Whether a link may be previewed: `http:` or `https:`, with no user name or
 * password in it, and not too long. Previews are asked for only on the
 * person's gesture (hover or touch and hold), never when a card is drawn.
 */
export function previewableLink(url: string): boolean {
  if (url.length > MAX_ADDRESS_CHARS) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return !/^[a-z]+:\/\/[^/]*@/i.test(url);
  } catch {
    return false;
  }
}

/** A link's preview through the host's previewer, bounded; "none" when there is nothing to show. */
export async function previewLink(
  previewer: LinkPreviewer | null,
  url: string,
): Promise<LinkPreview> {
  if (!previewer || !previewableLink(url)) return { status: "none", url };
  try {
    const got = await previewer(url);
    if (got.status !== "ok") return { status: "none", url };
    return {
      status: "ok",
      url,
      title: got.title ? cut(got.title, 300) : null,
      description: got.description ? cut(got.description, 600) : null,
      image:
        got.image && got.image.data.length <= Math.ceil(MAX_LINK_IMAGE_BYTES / 3) * 4
          ? got.image
          : null,
    };
  } catch {
    return { status: "none", url };
  }
}

/** A preview's picture, as the host sends it (base64). */
export const MAX_LINK_IMAGE_BYTES = 524_288;
