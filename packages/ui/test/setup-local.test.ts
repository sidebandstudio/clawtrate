// "This computer" with local connect (docs/design/setup-effortless.md §3): the first screen offers
// a gateway the host found and matched to this account's OpenClaw profile by itself, with Connect and the full-control line and
// nothing else to read; no address, token or command is shown; and what the look couldn't prove
// is said plainly, with the way on (Advanced).
import {
  initialState,
  initialSetupState,
  LOCAL_ROUTE_ONLY,
  PROOF_REFUSAL_LINES,
  type ClawtrateBridge,
  type ConnectionError,
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
import { LOCAL_FOUND_HEADING, LOCAL_FOUND_LINE, SetupFlow } from "../src/setup/Setup.tsx";

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

function render(info: HostInfo, setup: SetupState, mismatch?: ConnectionError): string {
  return renderToStaticMarkup(
    createElement(BridgeProvider, {
      bridge: { info } as ClawtrateBridge,
      children: createElement(ConnectScreen, {
        info,
        setup,
        connection: initialState.connection,
        ...(mismatch ? { mismatch } : {}),
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

describe("the first screen on a Mac whose OpenClaw profile the host found and matched", () => {
  it("F-602: offers this computer first: its heading, the full-control line and Connect", () => {
    const html = render(local(), found({}, true));
    expect(html).toContain(LOCAL_FOUND_HEADING);
    // One plain line under it: what the check found, and no more.
    expect(html).toContain(`<p class="s-lede">${LOCAL_FOUND_LINE}</p>`);
    expect(html).not.toMatch(/is running|is OpenClaw|proved/);
    expect(html).toContain(CONSENT_LINE);
    expect(html).toMatch(/<button[^>]*data-variant="primary"[^>]*>Connect<\/button>/);
    expect(html).toContain("Another computer");
    expect(html).toContain("Advanced");
    expect(html).not.toContain("Where does OpenClaw run?");
    // The heading is the screen's title: focused when it appears, and announced.
    expect(html).toMatch(
      /<h2[^>]*id="setup-title"[^>]*data-s-title[^>]*>Found your OpenClaw settings on this Mac</,
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

  it("F-491 F-602: the startup look that finds no settings opens the same local setup card as This computer", () => {
    for (const unasked of [true, false]) {
      const html = render(local(), found({ outcome: "not-found", access: null }, unasked));
      expect(html).toContain('data-testid="setup-found"');
      expect(html).toContain(escape("Clawtrate didn't find OpenClaw here"));
      expect(html).toContain(">It runs on another computer</button>");
      expect(html).not.toContain("Where does OpenClaw run?");
      if (unasked) {
        expect(html).toContain(">Advanced</button>");
        expect(html).not.toContain(">Back</button>");
      }
    }
  });

  it("F-491 F-602: a named profile discovered at startup offers Advanced without an install card", () => {
    const html = render(
      local(),
      found({ outcome: "named-profile", profile: "Work_Lab", access: null }, true),
    );
    expect(html).toContain("OpenClaw settings found for Work_Lab");
    expect(html).toContain(escape("Clawtrate needs this profile's gateway address to connect."));
    expect(html).toContain(">Use Advanced</button>");
    expect(html).not.toContain("Set up OpenClaw here");
    expect(html).not.toContain("Clawtrate didn&#x27;t find OpenClaw here");
  });

  it("F-602: the Connect offer names its profile when two profiles exist", () => {
    const html = render(
      local(),
      found({ profile: "default", others: ["profile clawtrate"] }, true),
    );
    expect(html).toContain("Using the default profile.");
    expect(html).toContain(">Connect</button>");
  });

  it("F-491 F-602: where the startup look can't offer a local route, it asks where OpenClaw runs", () => {
    for (const setup of [
      found({ outcome: "unverified", access: null }, true),
      found({ outcome: "cant-tell", reason: "settings-unfinished", access: null }, true),
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
    expect(html).toContain(LOCAL_FOUND_HEADING);
    expect(html).toContain(LOCAL_FOUND_LINE);
    expect(html).not.toMatch(/is running|is OpenClaw|proved/);
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
      "replaced",
      "other-settings",
      "unchecked",
    ] as const) {
      const html = render(local(), found({ outcome: "unverified", reason, access: null }));
      expect(html, reason).toContain("OpenClaw settings found");
      expect(html, reason).toContain(escape(PROOF_REFUSAL_LINES[reason](PORT)));
      expect(html).toContain("Use Advanced");
      expect(html).toContain("Look again");
      // No button that connects, whatever its words after "Connect" ("Connect read-only").
      expect(html, reason).not.toMatch(/>\s*Connect[^<]*<\/button>/);
    }
  });

  it("F-602: a profile with TLS on gets the Advanced path, with why, and no Connect", () => {
    const html = render(local(), found({ outcome: "cant-tell", reason: "tls", access: null }));
    expect(html).toContain("OpenClaw settings found");
    expect(html).toContain(
      escape(
        "These settings may require a secure address. Use Advanced to connect with the gateway's address.",
      ),
    );
    expect(html).toContain(">Use Advanced</button>");
    expect(html).not.toMatch(/>Connect<\/button>/);
    expect(html).not.toContain(LOCAL_FOUND_HEADING);
    nothingToType(html);
  });

  it("says when OpenClaw's settings can't be used, and when nothing answers", () => {
    const settings = render(
      local(),
      found({ outcome: "cant-tell", reason: "settings", access: null }),
    );
    expect(settings).toContain(
      escape("Clawtrate couldn't read usable OpenClaw settings for this Mac."),
    );
    const stopped = render(local(), found({ outcome: "stopped", access: null }));
    expect(stopped).toContain(`No gateway answered on port ${PORT}`);
    expect(stopped).not.toContain("Installed program");
  });

  it("a Connect whose socket didn't pass the check says what failed, and that no credential was sent", () => {
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
    expect(html).toContain(escape(`The gateway at port ${PORT} didn't finish connecting.`));
    expect(html).toContain(escape("It may have stopped or started with different settings."));
    expect(html).toMatch(/>Use Advanced<\/button>/);
    expect(html).toMatch(/>Look again<\/button>/);
    expect(html).not.toContain("Nothing answered");
  });

  it("F-602: Start OpenClaw appears only when the Mac host found a service it can start", () => {
    const stopped = found({
      outcome: "stopped",
      access: null,
      canStart: true,
      profile: "clawtrate",
      others: ["profile default"],
    });
    const html = render(local(), stopped);
    expect(html).toContain(escape("OpenClaw's gateway isn't running"));
    expect(html).toContain(">Start OpenClaw</button>");
    expect(html).toContain("<dt>Profile</dt><dd>clawtrate</dd>");
    expect(html).toContain("OpenClaw will keep running after Clawtrate closes.");
    expect(html).not.toContain("Connect</button>");
    const unavailable = render(
      local(),
      found({ outcome: "stopped", access: null, canStart: false }),
    );
    expect(unavailable).toContain(
      escape("Clawtrate couldn't find a service it can start for this gateway."),
    );
    expect(unavailable).not.toContain(">Start OpenClaw</button>");
  });

  it.each([
    [null, "macOS couldn't start the OpenClaw service."],
    ["no-answer", "The gateway didn't answer in time."],
  ] as const)("F-602: a failed start says why and offers another try (%s)", (reason, line) => {
    const html = render(local(), {
      ...found({ outcome: "stopped", access: null, canStart: true }),
      phase: "failed",
      failure: { kind: "not-started", exitCode: null, port: PORT, reason },
    });
    expect(html).toContain(escape(line));
    expect(html).toContain(">Try again</button>");
    expect(html).toContain(">Look again</button>");
  });

  it("F-602: a refused token offers Advanced and Look again", () => {
    const html = render(local(), {
      ...found(),
      phase: "failed",
      failure: { kind: "token-refused", exitCode: null, port: PORT, reason: null },
    });
    expect(html).toContain(escape("OpenClaw refused the token from its settings."));
    expect(html).toContain(">Use Advanced</button>");
    expect(html).toContain(">Look again</button>");
  });

  it.each([
    ["gateway-older", "This gateway speaks an older protocol than Clawtrate supports."],
    ["client-older", "This gateway needs a newer version of Clawtrate."],
  ] as const)("F-515: the setup card explains which side is older (%s)", (reason, line) => {
    const html = render(
      local(),
      {
        ...found(),
        phase: "failed",
        failure: { kind: "protocol", exitCode: null, port: PORT, reason },
      },
      {
        code: "PROTOCOL_MISMATCH",
        message: "The gateway refused the protocol.",
        hint: null,
        protocol: { gateway: reason === "gateway-older" ? 3 : 5, client: 4 },
      },
    );
    expect(html).toContain(line);
    expect(html).toContain(">Look again</button>");
    expect(html).toContain(">Use Advanced</button>");
  });

  it("F-602: the look says when it couldn't finish reading settings", () => {
    const html = render(
      local(),
      found({ outcome: "cant-tell", reason: "settings-unfinished", access: null }),
    );
    expect(html).toContain(escape("Clawtrate couldn't finish reading OpenClaw's settings."));
    expect(html).toContain(">Use Advanced</button>");
    expect(html).toContain(">Look again</button>");
  });

  it("without local connect, the card is as it was", () => {
    const info: HostInfo = { ...local(), setup: { look: true, pair: true, platform: "darwin" } };
    const html = render(
      info,
      found({ version: "2026.10.6", listens: "loopback", service: "none" }),
    );
    expect(html).toContain("Connect read-only");
    expect(html).not.toContain(LOCAL_FOUND_HEADING);
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
    expect(PROOF_REFUSAL_LINES["other-settings"](PORT)).toBe(
      `What is listening at port ${PORT} was started with another OpenClaw settings file than the one Clawtrate read, so Clawtrate can't tell how to connect to it.`,
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

  it("F-602: Use This computer stages its look over the saved gateway, whose form comes back once it is let go", () => {
    const screen = (staged: boolean, setup: SetupState) =>
      renderToStaticMarkup(
        createElement(BridgeProvider, {
          bridge: { info: local() } as ClawtrateBridge,
          children: createElement(ConnectScreen, {
            info: local(),
            setup,
            connection,
            discovery: initialState.discovery,
            staged,
            onStage: () => {},
          }),
        }),
      );
    // Staged: the look, then what it found, each with Back, over the saved gateway.
    const looking = screen(true, { ...initialSetupState, phase: "looking" });
    expect(looking).toContain("Looking on this computer");
    expect(looking).not.toContain(">Try again</button>");
    const unmatched = screen(
      true,
      found({ outcome: "unverified", reason: "holder", access: null }),
    );
    expect(unmatched).toContain("OpenClaw settings found");
    expect(unmatched).toContain("Back</button>");
    const offered = screen(true, found());
    expect(offered).toContain(LOCAL_FOUND_HEADING);
    // Let go (Back): the saved gateway's form, with both of its ways on.
    const back = screen(false, initialSetupState);
    expect(back).toContain(escape(refusal));
    expect(back).toContain(">Try again</button>");
    expect(back).toContain(">Use This computer</button>");
  });
});

describe("removing an unfinished OpenClaw setup", () => {
  function recovery(install: NonNullable<SetupState["install"]>): string {
    const info: HostInfo = { ...local(), setup: { ...local().setup!, install: true } };
    return renderToStaticMarkup(
      createElement(BridgeProvider, {
        bridge: { info } as ClawtrateBridge,
        children: createElement(SetupFlow, {
          view: "here",
          onView: () => {},
          info,
          connection: initialState.connection,
          setup: {
            ...initialSetupState,
            phase: install.failure ? "install-failed" : "installing",
            install,
          },
        }),
      }),
    );
  }

  it("F-505: says the unfinished setup folder went to the Trash", () => {
    const html = recovery({ step: 0, nodeChecked: false, failure: null, profileTrashed: true });
    expect(html).toContain("The unfinished setup folder is in the Trash.");
  });

  it("F-505: when Trash refuses the profile, explains the refusal and still offers Continue", () => {
    const html = recovery({
      step: 2,
      nodeChecked: true,
      recovery: "replace",
      failure: {
        kind: "trash",
        step: -1,
        exitCode: null,
        classification: null,
        retry: false,
        cleanup: "none",
      },
    });
    expect(html).toContain("Clawtrate couldn’t move the unfinished setup folder to the Trash.");
    expect(html).toMatch(/<button[^>]*>Continue<\/button>/);
    expect(html).not.toContain("The unfinished setup folder is in the Trash.");
  });
});
