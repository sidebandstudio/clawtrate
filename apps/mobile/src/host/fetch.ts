// Core's fetch on iOS (`HttpFetch`, packages/core/src/host.ts), for the pictures it reads from
// the gateway. React Native's fetch follows every redirect and gives no body to read in parts,
// and Expo's uses the app's shared cache, cookies and stored credentials, so the app's own
// native module makes the request (modules/clawtrate-fetch; docs/decisions.md, The iOS app).
// Here only what core asks for reaches it: a GET to an https address with, at most, core's one
// `Authorization` header. Core's abort, or a body it cancels past its limit, stops the transfer.
// As in a WHATWG fetch, a read after an abort rejects, even for a part already on its way, and a
// refused redirect fails as undici's does: core reads both as such.

import type { HttpFetch, HttpResponseLike } from "@clawtrate/core";

/** What modules/clawtrate-fetch gives JavaScript, each request named by an id. */
export type NativeFetch = {
  start(
    id: string,
    url: string,
    authorization: string | null,
  ): Promise<{ status: number; headers: Record<string, string> }>;
  /** The next part of the body, or null at its end. */
  read(id: string): Promise<Uint8Array | ArrayBuffer | null>;
  cancel(id: string): Promise<void>;
};

const codeOf = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

/** What a WHATWG fetch rejects with once its signal has aborted. */
const aborted = () =>
  Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

/** A failed request as a WHATWG fetch reports it: a redirect as undici names one. */
const fetchFailed = (error: unknown) =>
  new TypeError("fetch failed", {
    cause: codeOf(error) === "ERR_REDIRECT" ? new Error("unexpected redirect") : error,
  });

export function createHostFetch(native: NativeFetch): HttpFetch {
  let last = 0;
  return async (url, init) => {
    if (init.method !== "GET" || init.redirect !== "error" || init.credentials !== "omit")
      throw new TypeError(
        "This host fetches only a GET that follows no redirect and sends no cookies.",
      );
    if (!/^https:\/\//i.test(url)) throw new TypeError("This host fetches only https addresses.");
    const { signal } = init;
    if (signal.aborted) throw aborted();
    last += 1;
    const id = String(last);
    let open = true;
    const close = () => {
      open = false;
      signal.removeEventListener("abort", stop);
    };
    // Stops the transfer: core's time limit ran out, or it wants no more of the body.
    function stop() {
      if (!open) return;
      close();
      void native.cancel(id).catch(() => {});
    }
    signal.addEventListener("abort", stop);
    let head: Awaited<ReturnType<NativeFetch["start"]>>;
    try {
      head = await native.start(id, url, init.headers?.authorization ?? null);
    } catch (error) {
      stop();
      throw signal.aborted ? aborted() : fetchFailed(error);
    }
    // An answer that arrives after the abort is not given: the abort stopped the request.
    if (signal.aborted) throw aborted();
    const headers = new Map(Object.entries(head.headers));
    const reader = {
      async read(): Promise<{ done: boolean; value?: Uint8Array }> {
        if (signal.aborted) throw aborted();
        // Ended, or cancelled by core once it had what it needed.
        if (!open) return { done: true };
        let part: Uint8Array | ArrayBuffer | null;
        try {
          part = await native.read(id);
        } catch (error) {
          stop();
          throw signal.aborted ? aborted() : fetchFailed(error);
        }
        // A part already on its way when the abort came is not the body: a cut picture would pass.
        if (signal.aborted) throw aborted();
        if (part === null) {
          close();
          return { done: true };
        }
        return { done: false, value: part instanceof Uint8Array ? part : new Uint8Array(part) };
      },
      cancel: async () => stop(),
    };
    const response: HttpResponseLike = {
      status: head.status,
      headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
      body: { getReader: () => reader, cancel: async () => stop() },
    };
    return response;
  };
}
