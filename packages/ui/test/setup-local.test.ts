// "This computer" with local connect (docs/design/setup-effortless.md §3): the first screen offers
// a gateway the host found and proved by itself, with Connect and the full-control line and
// nothing else to read; no address, token or command is shown; and what the look couldn't prove
// is said plainly, with the way on (Advanced).
import {
  initialState,
  initialSetupState,
  type ClawtrateBridge,
  type HostInfo,
  type SetupLook,
  type SetupState,
} from "@clawtrate/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../src/bridge.tsx";
import { ConnectScreen } from "../src/ConnectScreen.tsx";
import { CONSENT_LINE } from "../src/FullControl.tsx";

const PORT = 19940;
const local = (full = true): HostInfo => ({
  kind: "desktop",
  version: "test",
  devGateway: null,
  ...(full ? { fullControl: true } : {}),
  setup: { look: true, pair: true, platform: "darwin", local: true },
});

const look = (more: Partial<SetupLook> = {}): SetupLook => ({
  outcome: "running",
  reason: null,
  version: null,
  profile: "default",
  listens: null,
  service: null,
  port: PORT,
  authMode: null,
  access: "new",
  others: [],
  ...more,
});

function render(info: HostInfo, setup: SetupState): string {
  return renderToStaticMarkup(
    createElement(BridgeProvider, {
      bridge: { info } as ClawtrateBridge,
      children: createElement(ConnectScreen, {
        info,
        setup,
        connection: initialState.connection,
        discovery: initialState.discovery,
      }),
    }),
  );
}

const found = (more: Partial<SetupLook> = {}, unasked = false): SetupState => ({
  ...initialSetupState,
  phase: "found",
  unasked,
  look: look(more),
});

/** What a person must never be shown on this path: an address, a token, a command, read-only. */
function nothingToType(html: string) {
  expect(html).not.toContain("ws://");
  expect(html).not.toContain(String(PORT));
  expect(html).not.toContain("openclaw ");
  expect(html).not.toContain('placeholder="Gateway address"');
  expect(html).not.toMatch(/read-only/i);
}

describe("the first screen on a Mac whose OpenClaw the host found and proved", () => {
  it("F-602: offers this computer first: its heading, the full-control line and Connect", () => {
    const html = render(local(), found({}, true));
    expect(html).toContain("OpenClaw is running on this Mac");
    expect(html).toContain(CONSENT_LINE);
    expect(html).toMatch(/<button[^>]*data-variant="primary"[^>]*>Connect<\/button>/);
    expect(html).toContain("Another computer");
    expect(html).toContain("Advanced");
    expect(html).not.toContain("Where does OpenClaw run?");
    // The heading is the screen's title: focused when it appears, and announced.
    expect(html).toMatch(
      /<h2[^>]*id="setup-title"[^>]*data-s-title[^>]*>OpenClaw is running on this Mac/,
    );
    nothingToType(html);
  });

  it("where this device can't hold full control, says what Connect asks instead", () => {
    const html = render(local(false), found({}, true));
    expect(html).not.toContain(CONSENT_LINE);
    expect(html).toContain(
      "Clawtrate asks for read access. OpenClaw may ask its owner to approve this device.",
    );
  });

  it("a device already paired there connects with that pairing, and isn't asked again", () => {
    const html = render(local(), found({ access: "paired" }, true));
    expect(html).not.toContain(CONSENT_LINE);
    expect(html).toContain("This device is already paired with it.");
  });

  it("while the host looks, and when it found nothing it proved, is the first question", () => {
    for (const setup of [
      { ...initialSetupState, phase: "looking" as const, unasked: true },
      found({ outcome: "unverified", access: null }, true),
      found({ outcome: "not-found", access: null }, true),
    ]) {
      const html = render(local(), setup);
      expect(html, setup.look?.outcome ?? setup.phase).toContain("Where does OpenClaw run?");
      expect(html).not.toContain("Looking on this computer");
    }
  });
});

describe("the card for this computer, after This computer", () => {
  it("is the same one step", () => {
    const html = render(local(), found());
    expect(html).toContain("OpenClaw is running on this Mac");
    expect(html).toContain(CONSENT_LINE);
    expect(html).toMatch(/>Connect<\/button>/);
    nothingToType(html);
  });

  it("F-602: says what couldn't be verified, and the way on", () => {
    const html = render(local(), found({ outcome: "unverified", access: null }));
    expect(html).toContain("OpenClaw settings found");
    expect(html).toContain(
      `Clawtrate couldn&#x27;t verify what is listening at port ${PORT}, so it doesn&#x27;t connect to it by itself. Use Advanced, or look again.`,
    );
    expect(html).toContain("Use Advanced");
    expect(html).toContain("Look again");
    expect(html).not.toMatch(/>Connect<\/button>/);
    const version = render(
      local(),
      found({ outcome: "unverified", reason: "version", access: null }),
    );
    expect(version).toContain("This version of OpenClaw is one Clawtrate can&#x27;t check yet");
  });

  it("says when OpenClaw's settings can't be used, and when nothing answers", () => {
    const settings = render(
      local(),
      found({ outcome: "cant-tell", reason: "settings", access: null }),
    );
    expect(settings).toContain("Clawtrate can&#x27;t use OpenClaw&#x27;s settings on this Mac");
    const stopped = render(local(), found({ outcome: "stopped", access: null }));
    expect(stopped).toContain(`No gateway answered on port ${PORT}`);
    expect(stopped).not.toContain("Installed program");
  });

  it("a Connect whose socket wasn't proved says so, and that nothing was sent", () => {
    const html = render(local(), {
      ...found(),
      phase: "failed",
      failure: { kind: "unverified", exitCode: null, port: PORT, reason: null },
    });
    expect(html).toContain(`Clawtrate couldn&#x27;t verify what is listening at port ${PORT}.`);
    expect(html).toContain("Nothing was sent to it. Use Advanced, or look again.");
    expect(html).toContain("Checking it&#x27;s OpenClaw on this Mac");
  });

  it("without local connect, the card is as it was", () => {
    const info: HostInfo = { ...local(), setup: { look: true, pair: true, platform: "darwin" } };
    const html = render(
      info,
      found({ version: "2026.10.6", listens: "loopback", service: "none" }),
    );
    expect(html).toContain("Connect read-only");
    expect(html).not.toContain("OpenClaw is running on this Mac");
  });
});
