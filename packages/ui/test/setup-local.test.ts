// "This computer" with local connect (docs/design/setup-effortless.md §3): what the look couldn't
// prove, settings it can't use, a gateway that isn't running and a Connect whose socket wasn't
// proved are each said plainly, with the way on (Advanced).
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

const found = (more: Partial<SetupLook> = {}): SetupState => ({
  ...initialSetupState,
  phase: "found",
  look: look(more),
});

describe("the card for this computer, after This computer", () => {
  it("says what couldn't be verified, and the way on", () => {
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
