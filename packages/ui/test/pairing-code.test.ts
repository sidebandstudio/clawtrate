// The waiting device's pairing screen shows its own code, read as a code, and where to pick it
// (docs/design/setup-effortless.md §5).
import { FULL_SCOPES, initialState, type ClawtrateBridge, type HostInfo } from "@clawtrate/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../src/bridge.tsx";
import { ConnectScreen } from "../src/ConnectScreen.tsx";

const info: HostInfo = { kind: "desktop", version: "test", devGateway: null };

describe("the waiting device's code", () => {
  it("F-550: the waiting device shows its own code, read as a code, and where to pick it", () => {
    const html = renderToStaticMarkup(
      createElement(BridgeProvider, {
        bridge: {
          info,
          getState: () => initialState,
          subscribe: () => () => {},
        } as unknown as ClawtrateBridge,
        children: createElement(ConnectScreen, {
          info,
          connection: {
            ...initialState.connection,
            status: "pairing",
            gatewayUrl: "wss://gateway.example",
            pairing: {
              requestId: "r",
              deviceId: "d",
              message: "",
              approveCommand: "openclaw devices approve r",
              approveNote: null,
              requestedScopes: [...FULL_SCOPES],
              code: "K7QF-2MXA",
            },
          },
          discovery: initialState.discovery,
        }),
      }),
    );
    expect(html).toContain(
      `<span class="visually-hidden">This device&#x27;s code: K 7 Q F, 2 M X A</span><span aria-hidden="true">K7QF-2MXA</span>`,
    );
    expect(html).toContain("pick this code there.");
  });
});
