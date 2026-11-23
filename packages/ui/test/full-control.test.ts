// The consent line on the address form (docs/design/setup-effortless.md §2, "Consent before
// Connect"), and what a full pairing granted less says it is missing (§8).
import {
  initialState,
  type ClawtrateBridge,
  type ConnectionState,
  type HostInfo,
} from "@clawtrate/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../src/bridge.tsx";
import { AdminBar } from "../src/bots/parts.tsx";
import { ConnectScreen } from "../src/ConnectScreen.tsx";
import { CONSENT_LINE, notGranted, WHAT_IT_MEANS } from "../src/FullControl.tsx";
import { DeviceBar } from "../src/machines/Machines.tsx";

const base: HostInfo = { kind: "desktop", version: "test", devGateway: null };

function form(info: HostInfo, url: string): string {
  return renderToStaticMarkup(
    createElement(BridgeProvider, {
      bridge: { info } as ClawtrateBridge,
      children: createElement(ConnectScreen, {
        info,
        connection: { ...initialState.connection, gatewayUrl: url },
        discovery: initialState.discovery,
      }),
    }),
  );
}

describe("the consent line on the address form", () => {
  it("F-522: a host that pairs with full control shows it directly above Connect for a secure address", () => {
    const html = form({ ...base, fullControl: true }, "wss://gateway.example");
    expect(CONSENT_LINE).toBe(
      "Full control lets Clawtrate change gateway settings, approve devices and, when the gateway allows it, open a terminal on the computer running OpenClaw.",
    );
    expect(html).toContain(CONSENT_LINE);
    // Directly above the button: nothing between the consent and the actions.
    expect(html).toMatch(/<\/ul><\/div><div class="actions"><button type="submit"/);
    // "What this means" is a real button, closed, naming the five points it opens.
    const more =
      /<button type="button" class="consent-more" aria-expanded="false" aria-controls="([^"]+)">What this means<\/button>/.exec(
        html,
      );
    expect(more).not.toBeNull();
    expect(html).toContain(`<ul id="${more![1]}" class="consent-points" hidden="">`);
    expect(WHAT_IT_MEANS).toHaveLength(5);
    for (const point of WHAT_IT_MEANS)
      expect(html).toContain(`<li>${point.replace(/'/g, "&#x27;")}</li>`);
    expect(html).toContain(
      "At a secure address (wss://) that isn&#x27;t localhost, it asks once for full control",
    );
  });

  for (const url of ["ws://127.0.0.1:18789", "wss://127.0.0.1:18789", "ws://gateway.example", ""]) {
    it(`asks nothing of the kind for ${url || "no address yet"}, where Clawtrate asks for read`, () => {
      const html = form({ ...base, fullControl: true }, url);
      expect(html).not.toContain(CONSENT_LINE);
      expect(html).toContain("at any other address it asks for read access only.");
    });
  }

  it("a host without full control keeps its read-only line, at any address", () => {
    const html = form(base, "wss://gateway.example");
    expect(html).not.toContain(CONSENT_LINE);
    expect(html).toContain("It asks for read access only.");
  });
});

describe("what a full pairing granted less is missing", () => {
  const connected = (scopes: string[], fullPairing: boolean): ConnectionState => ({
    ...initialState.connection,
    status: "connected",
    scopes,
    fullPairing,
  });
  const six = [
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.questions",
    "operator.admin",
    "operator.pairing",
  ];

  it("nothing, with all six", () => {
    expect(notGranted(connected(six, true))).toEqual([]);
  });

  it("F-522: each scope it lacks, in plain words and in order", () => {
    expect(notGranted(connected(["operator.read"], true))).toEqual([
      "sending and stopping",
      "deciding approvals",
      "answering questions",
      "changing gateway settings",
      "approving devices",
    ]);
    // Admin implies the others, but pairing is held only by name.
    expect(notGranted(connected(["operator.admin"], true))).toEqual(["approving devices"]);
  });

  it("nothing for a pairing that isn't a full one, or a connection that is down", () => {
    expect(notGranted(connected(["operator.read"], false))).toEqual([]);
    expect(notGranted({ ...connected(["operator.read"], true), status: "reconnecting" })).toEqual(
      [],
    );
  });
});

describe("the admin and device bars of a full pairing", () => {
  const six = [
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.questions",
    "operator.admin",
    "operator.pairing",
  ];
  const LESS = "OpenClaw granted less than full control.";
  const bars = (connection: ConnectionState) =>
    [
      createElement(AdminBar, { connection, info: base, need: "Changing a bot needs it." }),
      createElement(DeviceBar, { connection, info: base }),
    ].map((bar) =>
      renderToStaticMarkup(
        createElement(BridgeProvider, {
          bridge: { info: base } as ClawtrateBridge,
          children: bar,
        }),
      ),
    );

  it("F-522: granted less, each says so and offers no request", () => {
    const narrowed: ConnectionState = {
      ...initialState.connection,
      status: "connected",
      scopes: ["operator.read"],
      fullPairing: true,
    };
    for (const html of bars(narrowed)) {
      expect(html).toContain(LESS);
      expect(html).not.toContain("<button");
    }
  });

  it("while a pairing that holds all six reconnects, neither says it was granted less", () => {
    // A drop clears what the connection may do until the next hello; the pairing is still a full one.
    const reconnecting: ConnectionState = {
      ...initialState.connection,
      status: "reconnecting",
      scopes: six,
      canWrite: false,
      canAdmin: false,
      fullPairing: true,
    };
    for (const html of bars(reconnecting)) {
      expect(html).not.toContain(LESS);
      expect(html).not.toContain("<button");
    }
  });
});
