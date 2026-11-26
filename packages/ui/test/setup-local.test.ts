// "This computer" with local connect (docs/design/setup-effortless.md §3): the first screen offers
// a gateway the host found and proved by itself, with Connect and the full-control line and
// nothing else to read; no address, token or command is shown; and what the look couldn't prove
// is said plainly, with the way on (Advanced).
import {
  initialState,
  initialSetupState,
  LOCAL_ROUTE_ONLY,
  PROOF_REFUSAL_LINES,
  type ClawtrateBridge,
  type HostInfo,
  type SetupLook,
  type SetupState,
} from "@clawtrate/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../src/bridge.tsx";

/** As React escapes text. */
const escape = (text: string) => text.replaceAll("'", "&#x27;");
import { ConnectScreen } from "../src/ConnectScreen.tsx";
import { gatewayProblem, thisComputerWayOn } from "../src/Settings.tsx";
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

  it("while the host looks, waits with nothing to press, so nothing appears under the pointer", () => {
    const html = render(local(), { ...initialSetupState, phase: "looking", unasked: true });
    expect(html).toMatch(/<h2[^>]*data-s-title[^>]*>Looking for OpenClaw on this Mac<\/h2>/);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Where does OpenClaw run?");
  });

  it("when the host found nothing it proved, is the first question", () => {
    for (const setup of [
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

  it("F-602: says what couldn't be verified, in the words of what failed, and the way on", () => {
    for (const reason of [
      "holder",
      "not-gateway",
      "not-published",
      "folder",
      "unchecked",
    ] as const) {
      const html = render(local(), found({ outcome: "unverified", reason, access: null }));
      expect(html, reason).toContain("OpenClaw settings found");
      expect(html, reason).toContain(
        escape(
          `${PROOF_REFUSAL_LINES[reason](PORT)} Clawtrate doesn't connect to it by itself. Use Advanced, or look again.`,
        ),
      );
      expect(html).toContain("Use Advanced");
      expect(html).toContain("Look again");
      expect(html).not.toMatch(/>Connect<\/button>/);
    }
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

  it("a Connect whose socket wasn't proved says what failed, and that no credential was sent", () => {
    const html = render(local(), {
      ...found(),
      phase: "failed",
      failure: { kind: "unverified", exitCode: null, port: PORT, reason: "holder" },
    });
    expect(html).toContain(escape(PROOF_REFUSAL_LINES.holder(PORT)));
    expect(html).toContain("No credential was sent to it. Use Advanced, or look again.");
    expect(html).toContain("Checking it matches OpenClaw&#x27;s settings");
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

describe("an address whose pairing belongs to This computer", () => {
  const refused = (code: string, local: boolean) =>
    renderToStaticMarkup(
      createElement(BridgeProvider, {
        bridge: { info: info(local) } as ClawtrateBridge,
        children: createElement(ConnectScreen, {
          info: info(local),
          setup: initialSetupState,
          connection: {
            ...initialState.connection,
            status: "error",
            gatewayUrl: `ws://127.0.0.1:${PORT}`,
            error: { code, message: "fixture", hint: null },
          },
          discovery: initialState.discovery,
        }),
      }),
    );
  const info = (on: boolean): HostInfo => ({
    ...local(),
    setup: { look: true, pair: true, platform: "darwin", ...(on ? { local: true } : {}) },
  });

  it("F-602: offers This computer as the way on, where the host has it", () => {
    for (const code of [LOCAL_ROUTE_ONLY, "LOCAL_UNVERIFIED"]) {
      expect(refused(code, true), code).toContain(">Use This computer</button>");
      expect(refused(code, false), code).not.toContain("Use This computer");
    }
    expect(refused("UNREACHABLE", true)).not.toContain("Use This computer");
  });
});

describe("the words of a refusal", () => {
  it("say which check failed, and never what program holds the port", () => {
    expect(PROOF_REFUSAL_LINES.holder(PORT)).toBe(
      `Clawtrate couldn't confirm who holds the connection at port ${PORT}.`,
    );
    expect(PROOF_REFUSAL_LINES["not-gateway"](PORT)).toBe(
      `Clawtrate couldn't match what is listening at port ${PORT} to this account's OpenClaw profile.`,
    );
    expect(PROOF_REFUSAL_LINES["not-published"](PORT)).toBe(
      `Clawtrate couldn't check this version's module for what is listening at port ${PORT}.`,
    );
    for (const line of Object.values(PROOF_REFUSAL_LINES).map((words) => words(PORT)))
      expect(line).not.toMatch(/isn't the OpenClaw|isn't the copy|is OpenClaw|another gateway/);
  });
});

describe("a reconnect refused after setup finished", () => {
  const refusal = PROOF_REFUSAL_LINES["not-gateway"](PORT);
  const connection = {
    ...initialState.connection,
    status: "error" as const,
    gatewayUrl: `ws://127.0.0.1:${PORT}`,
    error: {
      code: "LOCAL_UNVERIFIED",
      message: refusal,
      hint: "Choose This computer to connect to it again, or use Advanced.",
    },
  };

  it("F-602: with no bots kept, the first screen says why, with its ways on, not setup's old steps", () => {
    const html = renderToStaticMarkup(
      createElement(BridgeProvider, {
        bridge: { info: local() } as ClawtrateBridge,
        children: createElement(ConnectScreen, {
          info: local(),
          setup: { ...found(), phase: "done", step: 2 },
          connection,
          discovery: initialState.discovery,
        }),
      }),
    );
    expect(html).toContain(escape(refusal));
    expect(html).toContain(">Try again</button>");
    expect(html).toContain(">Use This computer</button>");
    expect(html).not.toContain("Loading your bots");
  });

  it("F-602: with bots kept, Settings says the same, and offers This computer", () => {
    expect(gatewayProblem(connection)).toEqual({
      title: "Not connected",
      message: `${refusal} Choose This computer to connect to it again, or use Advanced.`,
    });
    expect(thisComputerWayOn(connection, local())).toBe(true);
    expect(
      thisComputerWayOn(connection, {
        ...local(),
        setup: { look: true, pair: true, platform: "darwin" },
      }),
    ).toBe(false);
  });
});
