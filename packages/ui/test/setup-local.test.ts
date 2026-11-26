// "This computer" with local connect (docs/design/setup-effortless.md §3): what the look couldn't
// prove, settings it can't use, a gateway that isn't running and a Connect whose socket wasn't
// proved are each said plainly, with the way on (Advanced).
import {
  initialState,
  initialSetupState,
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
  it("says what couldn't be verified, in the words of what failed, and the way on", () => {
    for (const reason of [
      "holder",
      "not-gateway",
      "not-published",
      "folder",
      "replaced",
      "other-settings",
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
      // No button that connects, whatever its words after "Connect" ("Connect read-only").
      expect(html, reason).not.toMatch(/>\s*Connect[^<]*<\/button>/);
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

  it("a Connect the gateway never answered on settings changed since it started ends with Advanced and a look again", () => {
    const html = render(local(), {
      ...found(),
      phase: "failed",
      failure: { kind: "unanswered", exitCode: null, port: PORT, reason: null },
    });
    expect(html).toContain(
      escape(
        `The gateway at port ${PORT} didn't answer as OpenClaw's settings on this Mac say it would.`,
      ),
    );
    expect(html).toContain(
      escape(
        "It may have just stopped, or be running on settings changed since it started, such as a secure address. Use Advanced, or look again.",
      ),
    );
    expect(html).toMatch(/>Use Advanced<\/button>/);
    expect(html).toMatch(/>Look again<\/button>/);
    expect(html).not.toContain("Nothing answered");
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
    expect(PROOF_REFUSAL_LINES["other-settings"](PORT)).toBe(
      `What is listening at port ${PORT} was started with another OpenClaw settings file than the one Clawtrate read, so Clawtrate can't tell how to connect to it.`,
    );
    for (const line of Object.values(PROOF_REFUSAL_LINES).map((words) => words(PORT)))
      expect(line).not.toMatch(/isn't the OpenClaw|isn't the copy|is OpenClaw|another gateway/);
  });
});
