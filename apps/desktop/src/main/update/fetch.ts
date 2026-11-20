// One bounded GET: an overall deadline and an idle deadline, and a refusal
// typed by its cause. No redirect is followed unless the caller passes a
// `follow` rule, and then at most one. The caller has already checked the
// address (address.ts).

import { get as httpGet, type IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";
import { rootCertificates } from "node:tls";

export type FetchCause =
  "unreachable" | "timed-out" | "http-status" | "redirect-refused" | "too-large";

export class FetchRefused extends Error {
  readonly reason: FetchCause;
  readonly status: number | undefined;
  constructor(reason: FetchCause, status?: number) {
    super(status === undefined ? reason : `${reason} ${status}`);
    this.reason = reason;
    this.status = status;
  }
}

/**
 * The life of one transfer: its abort signal, the cause it was stopped for,
 * and the two deadlines. `touch` restarts the idle one; `done` clears both.
 */
export class Transfer {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private stoppedFor: FetchCause | undefined;
  private readonly overall: ReturnType<typeof setTimeout>;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private readonly idleMs: number;

  constructor(timeoutMs: number, idleMs: number) {
    this.signal = this.controller.signal;
    this.idleMs = idleMs;
    this.overall = setTimeout(() => this.stop("timed-out"), timeoutMs);
    this.overall.unref?.();
    this.touch();
  }

  recordCause(cause: FetchCause): void {
    this.stoppedFor ??= cause;
  }

  stop(cause: FetchCause): void {
    this.recordCause(cause);
    this.done();
    this.controller.abort();
  }

  /** Why the transfer was stopped, or `fallback` when it failed by itself. */
  cause(fallback: FetchCause = "unreachable"): FetchCause {
    return this.stoppedFor ?? fallback;
  }

  touch(): void {
    if (this.signal.aborted) return;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop("timed-out"), this.idleMs);
    this.idle.unref?.();
  }

  done(): void {
    clearTimeout(this.overall);
    clearTimeout(this.idle);
  }
}

/** Statuses that carry a `Location` to follow. 304 and 300 are not redirects to a file. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Opens `url` and resolves with a 200 response whose declared length, if any,
 * is at most `maxBytes`. Every other answer is refused, a redirect included,
 * except one redirect that `follow` turns into an address. That address gets
 * the same request and no further redirect.
 */
export function open(
  url: URL,
  transfer: Transfer,
  maxBytes: number,
  userAgent: string,
  follow?: (location: string | undefined) => URL | null,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const options = {
      signal: transfer.signal,
      agent: false,
      headers: { accept: "*/*", "accept-encoding": "identity", "user-agent": userAgent },
    };
    // Only the request now in flight can fail the open: the redirect's own
    // connection is closed when its replacement starts.
    let current = 0;
    const get = (target: URL, redirect: typeof follow) => {
      const attempt = ++current;
      const onResponse = (response: IncomingMessage) => {
        transfer.touch();
        const status = response.statusCode ?? 0;
        const refuse = (cause: FetchCause, code?: number) => {
          response.destroy();
          reject(new FetchRefused(cause, code));
        };
        if (status >= 300 && status < 400) {
          const next =
            redirect && REDIRECTS.has(status) ? redirect(response.headers.location) : null;
          if (!next) return refuse("redirect-refused", status);
          response.destroy();
          return get(next, undefined);
        }
        if (status !== 200) return refuse("http-status", status);
        const declared = Number(response.headers["content-length"] ?? NaN);
        if (Number.isFinite(declared) && declared > maxBytes) return refuse("too-large");
        resolve(response);
      };
      // The certificate is always verified, against Node's bundled certificate
      // authorities only: NODE_TLS_REJECT_UNAUTHORIZED=0 cannot turn the check
      // off, and neither NODE_EXTRA_CA_CERTS nor the system's store adds to them.
      const request =
        target.protocol === "https:"
          ? httpsGet(
              target,
              { ...options, rejectUnauthorized: true, ca: [...rootCertificates] },
              onResponse,
            )
          : httpGet(target, options, onResponse);
      request.on("error", () => {
        if (attempt === current) reject(new FetchRefused(transfer.cause()));
      });
    };
    get(url, follow);
  });
}

/** Reads a whole response of at most `maxBytes`. */
export function readAll(
  response: IncomingMessage,
  transfer: Transfer,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const body = Buffer.alloc(maxBytes);
    let length = 0;
    response.on("data", (chunk: Buffer) => {
      transfer.touch();
      if (length + chunk.length > maxBytes) {
        // Settled here: an `end` already queued must not resolve a cut body.
        transfer.stop("too-large");
        reject(new FetchRefused("too-large"));
        return;
      }
      chunk.copy(body, length);
      length += chunk.length;
    });
    response.on("end", () => resolve(body.subarray(0, length)));
    response.on("error", () => reject(new FetchRefused(transfer.cause())));
    response.on("close", () => {
      if (!response.complete) reject(new FetchRefused(transfer.cause()));
    });
  });
}
