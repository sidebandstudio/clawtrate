// The one-time offer of full control to a device paired with less (docs/design/
// setup-effortless.md §6): its dialog, and its place in Settings, Gateway, Access.
import {
  FULL_SCOPES,
  initialState,
  type ClawtrateBridge,
  type ConnectionState,
  type HostInfo,
} from "@clawtrate/core";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { BridgeProvider } from "../src/bridge.tsx";
import {
  CONSENT_LINE,
  FullControlAsk,
  FullControlOffer,
  isFullRequest,
} from "../src/FullControl.tsx";

const info: HostInfo = { kind: "desktop", version: "test", devGateway: null, fullControl: true };
const offered: ConnectionState = {
  ...initialState.connection,
  status: "connected",
  gatewayUrl: "wss://gateway.example",
  deviceId: "device-1",
  scopes: ["operator.read"],
  fullOffer: "offer",
};
const waiting = (scopes: readonly string[]): ConnectionState => ({
  ...offered,
  fullOffer: "settings",
  upgrade: { ...offered.upgrade, status: "pending", scopes: [...scopes] },
});

const render = (element: ReactElement) =>
  renderToStaticMarkup(
    createElement(BridgeProvider, { bridge: { info } as ClawtrateBridge, children: element }),
  );

// The dialog notes the control that opened it as it first renders.
beforeAll(() => vi.stubGlobal("document", { activeElement: null }));

describe("the offer of full control", () => {
  it("F-NEW1: names both choices under the consent line, Keep current access first and focused", () => {
    const html = render(
      createElement(FullControlOffer, { connection: offered, onClose: () => {} }),
    );
    expect(html).toContain('aria-labelledby="full-offer-title"');
    expect(html).toContain('<h2 id="full-offer-title">Give this device full control</h2>');
    expect(html).toContain("This device is paired with gateway.example with less than full");
    expect(html).toContain(CONSENT_LINE);
    // The consent line, then directly the two buttons; nothing is chosen for the person.
    expect(html).toMatch(
      /<\/ul><\/div><div class="b-actions"><button type="button" class="button" data-variant="quiet" data-b-focus="">Keep current access<\/button><button type="button" class="button" data-variant="primary">Give this device full control<\/button><\/div>/,
    );
    expect(html).not.toContain("checked");
  });

  it("F-NEW1: the request is the offer's only when it asks for the six, in their order", () => {
    expect(isFullRequest(waiting(FULL_SCOPES))).toBe(true);
    expect(isFullRequest(waiting([...FULL_SCOPES].reverse()))).toBe(false);
    expect(isFullRequest(waiting(["operator.write", "operator.approvals"]))).toBe(false);
  });
});

describe("the offer in Settings, Gateway, Access", () => {
  it("F-NEW1: puts the consent line directly above Give this device full control", () => {
    const html = render(
      createElement(FullControlAsk, { connection: { ...offered, fullOffer: "settings" } }),
    );
    expect(html).toContain(CONSENT_LINE);
    expect(html).toMatch(
      /<\/ul><\/div><div class="settings-repair-actions"><button type="button" class="button" data-size="sm">Give this device full control<\/button><\/div>/,
    );
  });

  it("F-NEW1: offers nothing more while its request waits, and offers it again beside a smaller one", () => {
    expect(
      render(createElement(FullControlAsk, { connection: waiting(FULL_SCOPES) })),
    ).not.toContain("<button");
    expect(
      render(createElement(FullControlAsk, { connection: waiting(["operator.write"]) })),
    ).toContain("Give this device full control");
  });
});
