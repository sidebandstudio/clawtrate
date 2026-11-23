// The launch check's reading of the packaged app's network log (e2e-packaged/net-log.ts).
import { describe, expect, it } from "vitest";
import { dictionaryRequests, requestsSoFar } from "../e2e-packaged/net-log.ts";

const log = (events: unknown[]) => JSON.stringify({ constants: {}, events, polledData: {} });
const REMOTE = "https://redirector.gvt1.com/edgedl/chrome/dict/fo-fo-3-0.bdic";
const OWN = "file:///C:/Clawtrate/resources/app.asar/out/renderer/dictionaries/fo-fo-3-0.bdic";
const PICTURE = "https://pictures.example/otto.png";

describe("the dictionaries a network log shows requests for", () => {
  it("lists each dictionary address once, in the order first asked", () => {
    const events = [
      { type: 2, params: { url: REMOTE, priority: "IDLE" } },
      { type: 3, params: { url: REMOTE, method: "GET" } },
      { type: 2, params: { url: PICTURE } },
      { type: 2, params: { url: OWN } },
      { type: 4 },
    ];
    expect(dictionaryRequests(log(events))).toEqual([REMOTE, OWN]);
  });

  it("judges an address by its path, so a query neither hides a dictionary nor makes one", () => {
    const events = [
      { type: 2, params: { url: OWN } },
      { type: 2, params: { url: "https://example.test/fo-fo-3-0.bdic?v=2" } },
      { type: 2, params: { url: "https://pictures.example/otto.png?name=fo-fo-3-0.bdic" } },
    ];
    expect(dictionaryRequests(log(events))).toEqual([
      OWN,
      "https://example.test/fo-fo-3-0.bdic?v=2",
    ]);
  });

  it("finds none in a log without one", () => {
    expect(dictionaryRequests(log([{ type: 2, params: { url: PICTURE } }]))).toEqual([]);
  });

  it("refuses a log cut short, as one is before the app quits", () => {
    expect(() =>
      dictionaryRequests(`{"constants":{},"events":[{"type":2,"params":{"url":"${REMOTE}"`),
    ).toThrow();
  });
});

describe("the addresses a running app's log holds so far", () => {
  it("reads each whole event line and skips the header and a line cut short", () => {
    const partial =
      `{"constants":{"logFormatVersion":1},\n"events": [\n` +
      `{"type":2,"params":{"url":"${OWN}","priority":"IDLE"}},\n` +
      `{"type":2,"params":{"url":"${PICTURE}"}},\n` +
      `{"type":3,"params":{"url":"${REMOTE}"`;
    expect(requestsSoFar(partial)).toEqual([OWN, PICTURE]);
  });

  it("finds none before Chromium has written an event", () => {
    expect(requestsSoFar(`{"constants":{"logFormatVersion":1},\n"events": [\n`)).toEqual([]);
    expect(requestsSoFar("")).toEqual([]);
  });
});
