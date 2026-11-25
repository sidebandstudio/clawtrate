// F-589: updating OpenClaw from Clawtrate (#565): the button, the confirmation,
// the progress line and each outcome, as the screens render them from the
// state the engine publishes (`openclawUpdating`).
import {
  initialState,
  type ClawtrateBridge,
  type ClawtrateState,
  type ConnectionState,
  type HostInfo,
  type OpenClawUpdateState,
  type UpdateRunView,
} from "@clawtrate/core";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { BridgeProvider } from "../src/bridge.tsx";
import { UpdateConfirm, UpdateOpenClawView, workingTasks } from "../src/bots/UpdateOpenClaw.tsx";

const info: HostInfo = { kind: "desktop", version: "test", devGateway: null };
const connection: ConnectionState = {
  ...initialState.connection,
  status: "connected",
  gatewayUrl: "wss://gateway.example",
  gatewayId: "gw-a",
  target: 1,
  serverVersion: "2026.10.6",
  openclawUpdate: { current: "2026.10.6", latest: "2026.11.6", channel: "latest" },
  scopes: ["operator.read", "operator.admin"],
  canAdmin: true,
};
const run = (patch: Partial<UpdateRunView> = {}): UpdateRunView => ({
  runId: "3f2b8c1d-4e5a-4b6c-8d7e-9f0a1b2c3d4e",
  gatewayId: "gw-a",
  mine: true,
  from: "2026.10.6",
  to: "2026.11.6",
  phase: "staging",
  outcome: "running",
  reason: null,
  note: null,
  reported: null,
  ...patch,
});

function render(element: ReactElement, host: HostInfo = info) {
  const bridge = { info: host, send: () => Promise.resolve() } as unknown as ClawtrateBridge;
  return renderToStaticMarkup(createElement(BridgeProvider, { bridge, children: element }));
}
/** The update's part of a screen, for this state. */
const part = (
  where: "notice" | "settings",
  state: Partial<ClawtrateState>,
  host: HostInfo = info,
) =>
  render(
    createElement(UpdateOpenClawView, {
      state: { ...initialState, connection, ...state },
      where,
    }),
    host,
  );
const updating = (patch: Partial<OpenClawUpdateState>): OpenClawUpdateState => ({
  run: null,
  starting: false,
  blocked: null,
  error: null,
  looking: false,
  ...patch,
});
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

// The dialog notes the control that opened it as it first renders.
beforeAll(() => vi.stubGlobal("document", { activeElement: null }));

describe("F-589: the Update OpenClaw button", () => {
  it("F-589: is offered where the gateway reports a newer OpenClaw, with the version it goes to", () => {
    const html = part("notice", {});
    expect(html).toContain(">Update OpenClaw to 2026.11.6</button>");
    expect(part("settings", {})).toContain("OpenClaw 2026.11.6 is out.");
  });

  it("F-589: is not offered without a newer OpenClaw, on a host that only reads, or while not connected", () => {
    const none = { connection: { ...connection, openclawUpdate: null } };
    expect(part("notice", none)).toBe("");
    expect(part("notice", {}, { ...info, readOnly: true })).toBe("");
    const away = { connection: { ...connection, status: "reconnecting" as const } };
    expect(part("notice", away)).toBe("");
  });

  it("F-589: is not offered where the gateway can't update itself: the notice says why, in its words, and what to do", () => {
    const html = part("notice", {
      openclawUpdating: updating({
        blocked: { reason: "container-image-install", note: null },
      }),
    });
    expect(html).not.toContain("<button");
    expect(text(html)).toContain(
      "This gateway can't update OpenClaw itself. OpenClaw runs in a container, which is updated by replacing its image. The gateway says: “container-image-install”.",
    );
    expect(html).toContain('href="https://docs.openclaw.ai/install/updating"');
    const refused = part("notice", {
      openclawUpdating: updating({
        blocked: { reason: "host-owned-install", note: "Managed by <b>Example Host</b>." },
      }),
    });
    // The gateway's words are text, never markup.
    expect(refused).toContain("Managed by &lt;b&gt;Example Host&lt;/b&gt;.");
  });

  it("F-589: is not offered while a run is under way, here or started elsewhere: its line is shown instead", () => {
    for (const mine of [true, false]) {
      const html = part("notice", {
        openclawUpdating: updating({ run: run({ mine }) }),
      });
      expect(html).not.toContain("Update OpenClaw to");
      expect(text(html)).toContain(
        mine
          ? "Updating OpenClaw to 2026.11.6: step 2 of 8, staging."
          : "An update of OpenClaw to 2026.11.6, started elsewhere, is under way: step 2 of 8, staging.",
      );
    }
  });
});

describe("F-589: the confirmation", () => {
  const confirm = (conn: ConnectionState, working: number) =>
    render(
      createElement(UpdateConfirm, {
        stamp: { gatewayId: "gw-a", target: 1 },
        connection: conn,
        working,
        onClose: () => {},
      }),
    );

  it("F-589: says the versions, the restart, what happens to running work with how many tasks are working, and the reconnect; Not now first and focused", () => {
    const html = confirm(connection, 2);
    expect(html).toContain(">Update OpenClaw?</h2>");
    expect(text(html)).toContain("Your gateway goes from OpenClaw 2026.10.6 to 2026.11.6.");
    expect(text(html)).toContain(
      "The gateway restarts during the update, so your bots can't be reached for a moment. Clawtrate reconnects by itself.",
    );
    expect(text(html)).toContain(
      "2 tasks are working now. Before it restarts, OpenClaw stops taking new work and waits up to 5 minutes for running work to finish. Work still running then is interrupted. When it's back, OpenClaw resumes a bot's interrupted main conversation; other interrupted work may need to be started again.",
    );
    expect(html).toMatch(
      /<div class="b-actions"><button type="button" class="button" data-variant="quiet" data-b-focus="">Not now<\/button><button type="button" class="button" data-variant="primary">Update<\/button><\/div>/,
    );
    expect(text(confirm(connection, 0))).toContain("No task is working now.");
    expect(text(confirm(connection, 1))).toContain("1 task is working now.");
  });

  it("F-589: without admin access it asks for it the way the other admin steps do, and Update waits", () => {
    const html = confirm({ ...connection, canAdmin: false, scopes: ["operator.read"] }, 0);
    expect(text(html)).toContain("Updating OpenClaw needs admin access.");
    expect(html).toContain('data-variant="primary" disabled="">Update</button>');
  });

  it("F-589: counts the tasks the person sees working", () => {
    const task = (key: string, status: "running" | "done") => ({
      key,
      botId: "a",
      sessionId: null,
      title: key,
      preview: null,
      updatedAt: 1,
      status,
      unread: false,
    });
    expect(
      workingTasks({
        ...initialState,
        tasksByBot: {
          a: [task("1", "running"), task("2", "done")],
          b: [task("3", "running")],
        },
      } as unknown as ClawtrateState),
    ).toBe(2);
  });
});

describe("F-589: the progress and how it ends", () => {
  const line = (patch: Partial<UpdateRunView>, conn: ConnectionState = connection) =>
    part("settings", {
      connection: conn,
      openclawUpdating: updating({ run: run(patch) }),
    });

  it("F-589: each step is the gateway's word, announced politely by one live region", () => {
    for (const [phase, n] of [
      ["requested", 1],
      ["validating", 3],
      ["restarting", 6],
      ["verifying", 7],
    ] as const) {
      const html = line({ phase });
      expect(html).toContain(
        `role="status" aria-live="polite">Updating OpenClaw to 2026.11.6: step ${n} of 8, ${phase}.</p>`,
      );
      expect(html.match(/aria-live/g)).toHaveLength(1);
      expect(html).not.toContain("Dismiss");
    }
  });

  it("F-589: says updated only for an updated run, with the version", () => {
    const html = line({ phase: "finished", outcome: "updated" });
    expect(text(html)).toContain("Updated to OpenClaw 2026.11.6.");
    expect(html).toContain(">Dismiss</button>");
    for (const outcome of [
      "unconfirmed",
      "failed",
      "rolled-back",
      "skipped",
      "away",
      "elsewhere",
    ] as const)
      expect(text(line({ phase: "finished", outcome, reported: "2026.10.6" }))).not.toContain(
        "Updated to",
      );
  });

  it("F-589: a succeeded record with the old version reported says what the gateway reports", () => {
    expect(
      text(line({ phase: "finished", outcome: "unconfirmed", reported: "2026.10.6" })),
    ).toContain(
      "The gateway's record says the update finished, but the gateway still reports OpenClaw 2026.10.6.Check the gateway's version in Settings, then try again if it wasn't updated.",
    );
  });

  it("F-589: failed, rolled back and skipped say so, with the gateway's reason and what the person can do", () => {
    const cases = [
      ["failed", "The update failed."],
      [
        "rolled-back",
        "The update was rolled back: OpenClaw went back to the version it ran before.",
      ],
      ["skipped", "The update was skipped."],
    ] as const;
    for (const [outcome, words] of cases) {
      const html = line({
        phase: "finished",
        outcome,
        reason: "runtime-verification-failed",
        note: "Restored the previous package.",
      });
      expect(text(html)).toContain(
        `${words} The gateway says: “Restored the previous package. · runtime-verification-failed”.`,
      );
      expect(text(html)).toContain(
        "You can try again, or update OpenClaw on the gateway's machine",
      );
      expect(html).toContain('href="https://docs.openclaw.ai/install/updating"');
    }
  });

  it("F-589: a gateway that hasn't come back says so and what to check, with no Dismiss while it may still come", () => {
    const html = line({ phase: "restarting", outcome: "away" });
    expect(text(html)).toContain("The gateway hasn't come back since the update restarted it.");
    expect(text(html)).toContain(
      "Check that the gateway's machine is on and that OpenClaw is running there.",
    );
    expect(html).not.toContain("Dismiss");
  });

  it("F-589: on another gateway it says nothing of that gateway's version", () => {
    const other = { ...connection, gatewayId: "gw-b", serverVersion: "2026.12.1" };
    const html = line({ outcome: "elsewhere", from: null, to: null, phase: "finished" }, other);
    expect(text(html)).toContain(
      "Clawtrate is connected to another gateway now, so it can't say how the update went.",
    );
    expect(html).not.toMatch(/2026\./);
    // A run of another gateway's that is not marked so is not shown at all.
    expect(line({}, other)).not.toContain("Updating OpenClaw");
  });
});
