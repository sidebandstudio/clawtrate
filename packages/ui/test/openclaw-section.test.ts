// Settings › OpenClaw (docs/design/gateway-settings.md section 3): one row in Settings' list for
// all of OpenClaw's own settings, its heading, what search finds, and its parts, whose tabs show
// only once there are two.
import {
  initialAccountsState,
  initialState,
  type ClawtrateBridge,
  type ConnectionState,
  type HostInfo,
} from "@clawtrate/core";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../src/bridge.tsx";
import { findIn } from "../src/search/match.ts";
import { SETTINGS_SECTIONS } from "../src/Settings.tsx";
import {
  OPENCLAW_SECTION_NAME,
  PartTabs,
  partsBody,
  useOpenClawSection,
} from "../src/bots/OpenClawSection.tsx";

const info: HostInfo = { kind: "desktop", version: "test", devGateway: null, fullControl: true };
const connection: ConnectionState = {
  ...initialState.connection,
  status: "connected",
  canWrite: true,
  canAdmin: true,
};

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    createElement(BridgeProvider, {
      bridge: { info, getState: () => ({ connection }) } as unknown as ClawtrateBridge,
      children: node,
    }),
  );

describe("Settings › OpenClaw", () => {
  it("is one row of Settings' list, after Accounts, named OpenClaw", () => {
    const ids = SETTINGS_SECTIONS.map(([id]) => id);
    expect(ids.indexOf("openclaw")).toBe(ids.indexOf("accounts") + 1);
    expect(SETTINGS_SECTIONS.find(([id]) => id === "openclaw")).toEqual([
      "openclaw",
      "OpenClaw",
      "The default model, and OpenClaw's own settings",
    ]);
    // Its parts are inside it, never rows of the list.
    for (const part of ["models", "chat", "plugins", "all"])
      expect(ids.some((id) => id.startsWith(part))).toBe(false);
  });

  it("search finds it by its name and by what it holds", () => {
    const row = SETTINGS_SECTIONS.find(([id]) => id === "openclaw")!;
    for (const query of ["openclaw", "model"])
      expect(findIn(row[1], query) ?? findIn(row[2], query)).not.toBeNull();
  });

  it("opens straight on Models, with its heading and no tabs while Models is the only part", () => {
    function Section(): ReactNode {
      const view = useOpenClawSection({
        accounts: { ...initialAccountsState, status: "ready" },
        bots: [],
        connection,
        info,
        announce: () => {},
        toNav: null,
      });
      return createElement("div", null, createElement("h3", null, view.title), view.body);
    }
    const html = render(createElement(Section));
    expect(OPENCLAW_SECTION_NAME).toBe("OpenClaw");
    expect(html).toContain("<h3>OpenClaw</h3>");
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain("coming soon");
  });

  it("with a second part, a tab list names each and the chosen one's panel is labelled by its tab", () => {
    const parts = [
      { id: "models", label: "Models", view: { body: "models body", foot: null } },
      { id: "chat-apps", label: "Chat apps", view: { body: "chat body", foot: null } },
    ];
    const html = render(
      partsBody(
        parts,
        "chat-apps",
        createElement(PartTabs, { parts, current: "chat-apps", onChoose: () => {} }),
      ),
    );
    expect(html).toContain('role="tablist" aria-label="OpenClaw settings"');
    expect(html).toContain(
      '<button type="button" role="tab" id="openclaw-tab-models" aria-selected="false" aria-controls="openclaw-part-models" tabindex="-1" class="b-part">Models</button>',
    );
    expect(html).toContain(
      '<button type="button" role="tab" id="openclaw-tab-chat-apps" aria-selected="true" aria-controls="openclaw-part-chat-apps" tabindex="0" class="b-part">Chat apps</button>',
    );
    expect(html).toContain(
      '<div role="tabpanel" id="openclaw-part-chat-apps" aria-labelledby="openclaw-tab-chat-apps">chat body</div>',
    );
    expect(html).not.toContain("models body");
  });
});
