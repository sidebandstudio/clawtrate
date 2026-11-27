// F-550: the sheet that approves a waiting device, its words for each outcome, the quiet line,
// the notice without admin, the Settings list and the waiting device's code
// (docs/design/setup-effortless.md §5).
import {
  FULL_SCOPES,
  initialDeviceRequests,
  initialState,
  type ClawtrateBridge,
  type ClawtrateState,
  type DeviceDecision,
  type DeviceRequest,
  type DeviceRequestsState,
  type HostInfo,
} from "@clawtrate/core";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../src/bridge.tsx";
import {
  ALLOWED_WORDS,
  DECIDING_WORDS,
  decisionWords,
  DeviceRequestBody,
  DeviceRequestView,
  DeviceRequestsList,
  DevicesAsking,
  NOTICE_WITHOUT_ADMIN,
  CHECKING_WORDS,
  REREAD_WORDS,
  REREADING_WORDS,
  rereadFailedWords,
  type SheetOutcome,
} from "../src/DeviceApproval.tsx";

const info: HostInfo = { kind: "desktop", version: "test", devGateway: null };
const CODES = ["4C7R-MZ2D", "9H3K-TQ8B", "K7QF-2MXA", "WX5N-0PJ6"];
const request = (extra: Partial<DeviceRequest> = {}): DeviceRequest => ({
  requestId: "req-1",
  deviceId: "d".repeat(64),
  publicKey: "k".repeat(43),
  name: "Clawtrate Desktop",
  platform: "darwin",
  app: "gateway-client · ui",
  remoteIp: "203.0.113.7",
  origin: null,
  roles: ["operator"],
  scopes: [...FULL_SCOPES],
  at: 1,
  blocked: null,
  choices: CODES,
  spent: false,
  deciding: false,
  ...extra,
});

function render(element: ReactElement, deviceRequests: Partial<DeviceRequestsState>): string {
  const state: ClawtrateState = {
    ...initialState,
    connection: { ...initialState.connection, gatewayUrl: "wss://gateway.example" },
    deviceRequests: { ...initialDeviceRequests, access: "admin", ...deviceRequests },
  };
  const bridge = {
    info,
    getState: () => state,
    subscribe: () => () => {},
  } as unknown as ClawtrateBridge;
  return renderToStaticMarkup(createElement(BridgeProvider, { bridge, children: element })).replace(
    /&#x27;/g,
    "'",
  );
}
const sheet = (shown: DeviceRequest) =>
  render(createElement(DeviceRequestView, { requestId: shown.requestId, onClose: () => {} }), {
    requests: [shown],
  });
/** The buttons in document order, by their accessible name. */
const buttons = (html: string) =>
  [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map(
    ([, attributes, text]) => /aria-label="([^"]*)"/.exec(attributes!)?.[1] ?? text!,
  );

describe("the sheet", () => {
  it("F-550: puts both refusals before the codes, reads the codes as codes, and starts on the title", () => {
    const html = sheet(request());
    expect(buttons(html)).toEqual([
      "I didn't start this",
      "None of these match",
      "Code 4 C 7 R, M Z 2 D",
      "Code 9 H 3 K, T Q 8 B",
      "Code K 7 Q F, 2 M X A",
      "Code W X 5 N, 0 P J 6",
      "Not now",
    ]);
    // Focus starts on the title, outside the decisions: no control asks for it.
    expect(html).toContain('<h2 id="device-ask-title" tabindex="-1">');
    expect(html).not.toContain("data-b-focus");
    expect(html).toContain("<legend>Which code does the waiting device show?</legend>");
  });

  it("F-550: marks what the device reports, and the gateway's address apart", () => {
    const html = sheet(request());
    expect(html).toContain("Clawtrate Desktop (reported)");
    expect(html).toContain("darwin · gateway-client · ui (reported)");
    expect(html).toContain("From 203.0.113.7");
    for (const scope of FULL_SCOPES) expect(html).toContain(ALLOWED_WORDS[scope]!);
    const bare = sheet(request({ name: null, platform: null, app: null, remoteIp: null }));
    expect(bare).toContain("No name given");
    expect(bare).toContain("Address not reported");
  });

  it("F-550: shows a scope named like an object's own property as its own text, and stays usable", () => {
    // A waiting device names its own scopes: none may reach into the words' object.
    const odd = ["__proto__", "constructor", "toString", "hasOwnProperty"];
    const html = sheet(request({ scopes: odd, blocked: "unknown-scope", choices: [] }));
    for (const scope of odd) expect(html).toContain(`<li>${scope}</li>`);
    expect(buttons(html)).toEqual(["I didn't start this", "Not now"]);
    expect(html).toContain("It asks for access Clawtrate can't describe");
  });

  it("F-550: offers no code for a request it doesn't approve, and still lets it be denied", () => {
    for (const blocked of [
      "not-operator",
      "repair",
      "unknown-scope",
      "bad-key",
      "same-code",
      "too-many",
    ] as const) {
      const html = sheet(request({ blocked, choices: [] }));
      expect(buttons(html)).toEqual(["I didn't start this", "Not now"]);
      expect(html).toMatch(/doesn't approve|is approved here/);
    }
    expect(sheet(request({ blocked: "same-code", choices: [] }))).toContain(
      "Deny both, then ask again from the new device.",
    );
  });

  it("F-550: takes no second pick after one approved nothing, and offers Deny", () => {
    const html = sheet(request({ spent: true }));
    expect(buttons(html)).toEqual(["Deny it", "Not now"]);
    expect(html).toContain("A pick on this device already approved nothing for this request.");
  });

  it("F-550: says a request that is gone is no longer pending", () => {
    const html = render(
      createElement(DeviceRequestView, { requestId: "gone", onClose: () => {} }),
      {},
    );
    expect(html).toContain("This request is no longer pending.");
    expect(buttons(html)).toEqual(["Close"]);
  });

  it("F-550: says a request past the newest sixteen isn't among those shown, not that it is gone", () => {
    const html = render(
      createElement(DeviceRequestView, { requestId: "hidden", onClose: () => {} }),
      { requests: [request()], omitted: 1 },
    );
    expect(html).toContain(
      "This request isn't among the newest 16 Clawtrate shows, so it can't be decided here.",
    );
    expect(html).not.toContain("no longer pending");
    expect(buttons(html)).toEqual(["Close"]);
  });

  it("F-550: says what each outcome did, and only an approval says approved", () => {
    const words: Array<[DeviceDecision, string]> = [
      [{ kind: "approved", deviceId: "d" }, "Approved. The device connects in a moment."],
      [
        { kind: "wrong-code" },
        "That isn't this request's code, so nothing was approved. This request can't be picked again here.",
      ],
      [
        { kind: "none-match" },
        "Nothing was approved. The waiting request isn't from the device you're looking at.",
      ],
      [{ kind: "denied" }, "Denied. The device can ask again."],
      [{ kind: "gone" }, "This request is no longer pending."],
      [
        { kind: "changed", what: ["key", "access"] },
        "The request changed after it was shown (its key and access). Nothing was approved.",
      ],
      [
        { kind: "undone", what: ["access"] },
        "The gateway paired the device with another access than shown, so Clawtrate removed that pairing at once. Nothing stays approved.",
      ],
      [
        { kind: "undo-failed", what: ["role"], message: "busy." },
        "The gateway paired the device with another role than shown, and Clawtrate couldn't remove it: busy. Remove it in Settings, Machines.",
      ],
      [
        { kind: "refused", message: "missing scope: operator.admin." },
        "The gateway refused: missing scope: operator.admin. Nothing was approved.",
      ],
      [
        { kind: "unknown" },
        "Clawtrate didn't get the gateway's answer, so it can't say whether the device was approved. Look in Settings, Machines.",
      ],
      [
        { kind: "interrupted" },
        "The connection changed before Clawtrate could approve it. Nothing was approved.",
      ],
      [{ kind: "not-allowed" }, "This request can't be approved here."],
    ];
    for (const [decision, sentence] of words) expect(decisionWords(decision)).toBe(sentence);
    expect(words.filter(([, s]) => s.startsWith("Approved"))).toHaveLength(1);
  });
});

describe("a decision under way", () => {
  const body = (props: Partial<Parameters<typeof DeviceRequestBody>[0]>) =>
    render(
      createElement(DeviceRequestBody, {
        gateway: "gateway.example",
        request: request(),
        result: null,
        pending: null,
        onDecide: () => {},
        onClose: () => {},
        ...props,
      }),
      {},
    );
  /** The decision buttons that can't be pressed now, by their accessible name. */
  const held = (html: string) =>
    [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)]
      .filter(([, attributes]) => attributes!.includes('aria-disabled="true"'))
      .map(([, attributes, text]) => /aria-label="([^"]*)"/.exec(attributes!)?.[1] ?? text!);

  it("F-550: holds every decision on the request while one is under way, and says so", () => {
    const html = body({ pending: { type: "approveDevice", code: "K7QF-2MXA" } });
    expect(html).toContain(DECIDING_WORDS);
    expect(held(html)).toEqual([
      "I didn't start this",
      "None of these match",
      "Code 4 C 7 R, M Z 2 D",
      "Code 9 H 3 K, T Q 8 B",
      "Code K 7 Q F, 2 M X A",
      "Code W X 5 N, 0 P J 6",
    ]);
    // The pick under way is marked as the one pressed; Not now stays.
    expect(html).toMatch(/aria-pressed="true"[^>]*data-code="K7QF-2MXA"/);
    expect(html).toContain('aria-busy="true"');
    // Deny after a pick that approved nothing waits too.
    const deny = body({
      request: request({ spent: true }),
      pending: { type: "refuseDevice", why: "not-mine" },
    });
    expect(held(deny)).toEqual(["Deny it"]);
    expect(deny).toContain(DECIDING_WORDS);
    // Nothing under way: nothing is held and nothing says it is being decided.
    const idle = body({});
    expect(held(idle)).toEqual([]);
    expect(idle).not.toContain(DECIDING_WORDS);
  });

  it("F-550: a sheet opened again while this host's decision on the request is under way holds every decision, and says so", () => {
    const html = sheet(request({ deciding: true }));
    expect(html).toContain(DECIDING_WORDS);
    expect(held(html)).toEqual([
      "I didn't start this",
      "None of these match",
      "Code 4 C 7 R, M Z 2 D",
      "Code 9 H 3 K, T Q 8 B",
      "Code K 7 Q F, 2 M X A",
      "Code W X 5 N, 0 P J 6",
    ]);
  });

  it("F-550: after a decision that wasn't allowed, holds every decision until the list is read again", () => {
    // Reading: it says so, says nothing of a read done, and takes no decision.
    const reading = body({ held: true, note: REREADING_WORDS });
    expect(reading).toContain(REREADING_WORDS);
    expect(reading).not.toContain(REREAD_WORDS);
    expect(held(reading)).toEqual([
      "I didn't start this",
      "None of these match",
      "Code 4 C 7 R, M Z 2 D",
      "Code 9 H 3 K, T Q 8 B",
      "Code K 7 Q F, 2 M X A",
      "Code W X 5 N, 0 P J 6",
    ]);
    expect(reading).not.toContain(DECIDING_WORDS);
    // Read: the request as it is now takes a pick again.
    const read = body({ note: REREAD_WORDS });
    expect(read).toContain(REREAD_WORDS);
    expect(held(read)).toEqual([]);
    // Failed: it says so, and that the list is the last that worked.
    const failed = body({ note: rereadFailedWords("The gateway didn't answer.") });
    expect(failed).toContain(
      "Nothing was approved or denied. Clawtrate couldn't read the waiting devices again: The gateway didn't answer. What is listed here is from the last read that worked.",
    );
    expect(failed).not.toContain(REREAD_WORDS);
    // An outcome takes the note's place above the pick, and says it under itself instead.
    const checking = body({ result: { kind: "unknown" }, note: CHECKING_WORDS });
    expect(checking).toContain(CHECKING_WORDS);
  });

  it("F-550: says each way an approval can end without a plain approval", () => {
    for (const [result, words] of [
      [
        { kind: "unknown" },
        "Clawtrate didn't get the gateway's answer, so it can't say whether the device was approved.",
      ],
      [
        { kind: "undone", what: ["access"] },
        "Clawtrate removed that pairing at once. Nothing stays approved.",
      ],
      [
        { kind: "undo-failed", what: ["access"], message: "busy." },
        "Clawtrate couldn't remove it: busy. Remove it in Settings, Machines.",
      ],
      [
        { kind: "undo-unknown", what: ["access"] },
        "Clawtrate asked to remove that pairing but couldn't confirm it is gone. Look in Settings, Machines.",
      ],
      [
        { kind: "unread", message: "timed out." },
        "Clawtrate couldn't read the request again before approving it: timed out. Nothing was approved.",
      ],
      [
        { kind: "not-sent", message: "Clawtrate is connected to another gateway now." },
        "Clawtrate couldn't send this: Clawtrate is connected to another gateway now. Nothing was approved.",
      ],
    ] as Array<[SheetOutcome, string]>) {
      const html = body({ result });
      expect(html).toContain(words);
      expect(html).not.toContain("Approved.");
      expect(buttons(html)).toEqual(["Close"]);
    }
  });

  it("F-550: says only what is known of a denial or a pick whose answer didn't come", () => {
    expect(decisionWords({ kind: "unknown" }, "deny")).toBe(
      "Clawtrate didn't get the gateway's answer, so it can't say whether the request was denied.",
    );
    expect(decisionWords({ kind: "unknown" }, "none-match")).toBe(
      "Clawtrate didn't get an answer, so it can't say whether this pick was kept. Nothing was approved.",
    );
    expect(decisionWords({ kind: "refused", message: "busy." }, "deny")).toBe(
      "The gateway refused: busy. Nothing was denied.",
    );
    expect(decisionWords({ kind: "not-sent", message: "Too many requests." }, "deny")).toBe(
      "Clawtrate couldn't send this: Too many requests. Nothing was denied.",
    );
    // Only the gateway's refusal is called one.
    for (const kind of ["unknown", "unread", "not-sent", "undo-unknown"] as const)
      expect(
        decisionWords({ kind, message: "x", what: ["access"] } as SheetOutcome, "approve"),
      ).not.toMatch(/refused|failed/);
  });
});

describe("where waiting requests show", () => {
  it("F-550: a connection without admin shows only the notice", () => {
    const html = render(createElement(DevicesAsking, { onReview: () => {} }), {
      access: "notice",
      noticed: 1,
    });
    expect(html).toContain(NOTICE_WITHOUT_ADMIN);
    expect(buttons(html)).toEqual([]);
    expect(render(createElement(DeviceRequestsList), { access: "notice", noticed: 1 })).toContain(
      NOTICE_WITHOUT_ADMIN,
    );
  });

  it("F-550: several waiting requests are one quiet line", () => {
    const html = render(createElement(DevicesAsking, { onReview: () => {} }), {
      requests: [request(), request({ requestId: "req-2" })],
      omitted: 1,
    });
    expect(html).toContain("3 devices are asking to use this gateway.");
    expect(buttons(html)).toEqual(["Review"]);
    expect(render(createElement(DevicesAsking, { onReview: () => {} }), {})).toBe("");
  });

  it("F-550: a setup connection lists and shows nothing", () => {
    // The engine publishes no list on a setup connection: access stays "none".
    // Even a list left from before shows nothing once access is "none".
    const setup = { access: "none" as const, requests: [request()] };
    expect(render(createElement(DevicesAsking, { onReview: () => {} }), setup)).toBe("");
    // Only the empty place focus can return to.
    expect(render(createElement(DeviceRequestsList), setup)).toBe(
      '<div class="device-requests-place" tabindex="-1"></div>',
    );
  });

  it("F-550: a request the quiet minutes keep from opening by itself is still listed", () => {
    // After a refusal or wrong pick the host offers no prompt; the request stays in the rail
    // and in Settings, Gateway.
    const quiet = { requests: [request()], prompt: null };
    expect(render(createElement(DevicesAsking, { onReview: () => {} }), quiet)).toContain(
      "A device is asking to use this gateway.",
    );
    expect(render(createElement(DeviceRequestsList), quiet)).toContain(
      "Clawtrate Desktop (reported)",
    );
  });

  it("F-550: after failed reads, keeps the last list and says it is from the last read that worked", () => {
    const html = render(createElement(DeviceRequestsList), {
      requests: [request()],
      error: "The gateway didn't answer.",
    });
    expect(html).toContain("Clawtrate Desktop (reported)");
    expect(html).toContain(
      "Clawtrate couldn't read the waiting devices: The gateway didn't answer. What is listed here is from the last read that worked.",
    );
    const none = render(createElement(DeviceRequestsList), { error: "The gateway didn't answer." });
    expect(none).toContain(
      "Clawtrate couldn't read the waiting devices: The gateway didn't answer.",
    );
    expect(none).not.toContain("last read that worked");
  });

  it("F-550: Settings, Gateway lists each request and counts those past the bound", () => {
    const html = render(createElement(DeviceRequestsList), {
      requests: [request(), request({ requestId: "req-2", name: "Work laptop", remoteIp: null })],
      omitted: 4,
    });
    expect(html).toContain("Devices asking");
    expect(html).toContain("Clawtrate Desktop (reported)");
    expect(html).toContain("Work laptop (reported)");
    expect(html).toContain("Address not reported");
    expect(html).toContain("4 more are waiting. Clawtrate shows the newest 2.");
  });
});
