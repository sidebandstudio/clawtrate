// F-589, F-591: updating OpenClaw from Clawtrate (#565, #590): the button, the
// confirmation, the steps as a bar and each outcome in Settings › Updates; the
// one line elsewhere; and what the connection strip and the footer say while
// it runs, as the screens render them from the state the engine publishes
// (`openclawUpdating`).
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
import {
  OpenOpenClawUpdates,
  UpdateConfirm,
  UpdateOpenClawLink,
  UpdatesWithOpenClawView,
  workingTasks,
} from "../src/bots/UpdateOpenClaw.tsx";
import { updateLinkLine, updatingHere } from "../src/bots/update-words.ts";
import { presenceWords } from "../src/Rail.tsx";
import { stripFor } from "../src/StatusStrip.tsx";

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
/** Settings › Updates' OpenClaw section, for this state. */
const part = (state: Partial<ClawtrateState>, host: HostInfo = info) =>
  render(
    createElement(UpdatesWithOpenClawView, {
      state: { ...initialState, connection, ...state },
    }),
    host,
  );
const updating = (patch: Partial<OpenClawUpdateState>): OpenClawUpdateState => ({
  run: null,
  starting: false,
  blocked: null,
  error: null,
  looking: false,
  lookFailed: false,
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
    const html = part({});
    expect(html).toContain(">Update OpenClaw to 2026.11.6</button>");
    expect(part({})).toContain("OpenClaw 2026.11.6 is out.");
  });

  it("F-589: is not offered without a newer OpenClaw, on a host that only reads, or while not connected", () => {
    const none = { connection: { ...connection, openclawUpdate: null } };
    expect(part(none)).toBe("");
    // A host that only reads says it is out, and where it is updated instead.
    const reads = part({}, { ...info, readOnly: true });
    expect(reads).not.toContain("<button");
    expect(text(reads)).toContain("OpenClaw 2026.11.6 is out.");
    expect(reads).toContain('href="https://docs.openclaw.ai/install/updating"');
    const away = { connection: { ...connection, status: "reconnecting" as const } };
    expect(part(away)).not.toContain("<button");
  });

  it("F-589: is not offered until what this device keeps for the gateway has been read", () => {
    const held = part({ openclawUpdating: updating({ checkingKept: true }) });
    expect(held).not.toContain("<button");
    expect(held).not.toContain("Update OpenClaw to");
    expect(part({ openclawUpdating: updating({}) })).toContain("Update OpenClaw to 2026.11.6");
  });

  it("F-589: is not offered where the gateway can't update itself: the notice says why, in its words, and what to do", () => {
    const html = part({
      openclawUpdating: updating({
        blocked: { reason: "container-image-install", note: null },
      }),
    });
    expect(html).not.toContain("<button");
    expect(text(html)).toContain(
      "This gateway can't update OpenClaw itself. OpenClaw runs in a container, which is updated by replacing its image. The gateway says: “container-image-install”.",
    );
    expect(html).toContain('href="https://docs.openclaw.ai/install/updating"');
    const refused = part({
      openclawUpdating: updating({
        blocked: { reason: "host-owned-install", note: "Managed by <b>Example Host</b>." },
      }),
    });
    // The gateway's words are text, never markup.
    expect(refused).toContain("Managed by &lt;b&gt;Example Host&lt;/b&gt;.");
  });

  it("F-589: is not offered while a run is under way, here or started elsewhere: its line is shown instead", () => {
    for (const mine of [true, false]) {
      const html = part({
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
      "An update usually takes 5 to 15 minutes, and some installs take longer. The gateway restarts during it, so your bots can't be reached for part of that time. Clawtrate reconnects by itself.",
    );
    expect(text(html)).toContain(
      "2 tasks are working now, and will be stopped when the gateway restarts. Stopped work may not be picked up again.",
    );
    expect(html).toMatch(
      /<div class="b-actions"><button type="button" class="button" data-variant="quiet" data-b-focus="">Not now<\/button><button type="button" class="button" data-variant="primary">Update<\/button><\/div>/,
    );
    expect(text(confirm(connection, 0))).toContain(
      "No task is working now. Work that is running when the gateway restarts is stopped, and may not be picked up again.",
    );
    // Nothing promises that work is resumed, or that nothing runs after the restart.
    expect(text(confirm(connection, 2))).not.toMatch(/resume|quiet|nothing runs/i);
    expect(text(confirm(connection, 1))).toContain("1 task is working now, and will be stopped");
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
    part({
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
        `${words} The gateway says: “Restored the previous package. (runtime-verification-failed)”.`,
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

  it("F-589: while an update manager handles a run, its own words are shown with the step", () => {
    const html = line({
      phase: "requested",
      note: "OCM owns this update. Use the Update status view to follow its progress and result.",
    });
    expect(text(html)).toContain(
      "Updating OpenClaw to 2026.11.6. The gateway says: “OCM owns this update.",
    );
    expect(text(html)).toContain("Step 1 of 8, requested");
  });

  it("F-589: a press whose answer was lost holds the button, and once asking fails offers Check again and Stop waiting with what that means", () => {
    const held = part({
      openclawUpdating: updating({
        looking: true,
        error:
          "Clawtrate didn't get the gateway's answer to the last Update press. It's checking whether the update started.",
      }),
    });
    expect(held).not.toContain("Update OpenClaw to");
    expect(text(held)).toContain("It's checking whether the update started.");
    expect(held).not.toContain("Stop waiting");
    const failed = part({
      openclawUpdating: updating({
        looking: true,
        lookFailed: true,
        error:
          "Clawtrate didn't get the gateway's answer to the last Update press, and couldn't ask it whether the update started.",
      }),
    });
    expect(failed).not.toContain("Update OpenClaw to");
    expect(failed).toContain(">Check again</button>");
    expect(failed).toContain(">Stop waiting</button>");
    expect(text(failed)).toContain(
      "Stop waiting offers Update again. Clawtrate can't tell whether that press started an update; if one is running, the gateway says so instead of starting another.",
    );
  });

  it("F-589: away longer than an update usually takes says so, and that a gateway started by hand may need starting again", () => {
    const html = line({ phase: "restarting", outcome: "late" });
    // First that it is taking longer than usual; nothing says the gateway stopped.
    expect(text(html)).toContain(
      "Updating OpenClaw to 2026.11.6. This is taking longer than usual.",
    );
    expect(text(html)).toContain(
      "If the gateway was started by hand, the update may have left it stopped: start it again the way you normally start it.",
    );
    expect(html).not.toContain("Dismiss");
    expect(html).not.toContain("Updated");
  });

  it("F-589: an updater that gave up reads as such, with the gateway's reason", () => {
    const html = line({
      phase: "finished",
      outcome: "failed",
      reason: "managed-service-handoff-helper-failed",
    });
    expect(text(html)).toContain(
      "The update failed. The updater gave up before it finished, and may have left the gateway stopped. The gateway says: “managed-service-handoff-helper-failed”.",
    );
  });

  it("F-589: a run nothing ties to the press is not called the person's or someone else's", () => {
    const html = line({ mine: null, phase: "requested" });
    expect(text(html)).toContain(
      "An update of OpenClaw to 2026.11.6 is under way: step 1 of 8, requested. Clawtrate can't tell whether it's the one you started.",
    );
    expect(text(html)).not.toContain("started elsewhere");
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

describe("F-591: while OpenClaw updates, the strip and the footer say so", () => {
  const down = { ...connection, status: "reconnecting" as const, retryAt: Date.now() + 1_000 };
  const state = (patch: Partial<OpenClawUpdateState> | null, conn: ConnectionState = down) =>
    ({
      ...initialState,
      connection: conn,
      ...(patch ? { openclawUpdating: updating(patch) } : {}),
    }) as ClawtrateState;
  const strip = (s: ClawtrateState) => stripFor(s, "dropped", null);
  const footer = (s: ClawtrateState) => presenceWords(s.connection, false, updatingHere(s));

  it("F-591: a run this device follows, running on the gateway on screen: the version and saved messages, no countdown and no Retry", () => {
    const s = state({ run: run({ phase: "restarting" }) });
    expect(strip(s)).toEqual({
      tone: "warn",
      text: "Updating OpenClaw to 2026.11.6",
      short: "Updating OpenClaw",
      more: "showing saved messages",
      action: null,
      countdown: false,
    });
    expect(footer(s)).toBe("Updating OpenClaw…");
    // A run started elsewhere that this device follows is the same update.
    expect(strip(state({ run: run({ mine: false }) }))?.text).toBe(
      "Updating OpenClaw to 2026.11.6",
    );
  });

  it("F-591: away longer than an update usually takes, both say that, and Retry is back", () => {
    const late = state({ run: run({ phase: "restarting", outcome: "late" }) });
    expect(strip(late)).toMatchObject({
      text: "OpenClaw's update is taking longer than usual",
      action: "retry",
      countdown: false,
    });
    expect(footer(late)).toBe("Update taking longer than usual");
    const away = state({ run: run({ phase: "restarting", outcome: "away" }) });
    expect(strip(away)).toMatchObject({
      tone: "danger",
      text: "The gateway hasn't come back from the update",
      action: "retry",
    });
    expect(footer(away)).toBe("Not back from the update");
  });

  it("F-591: a press the engine waits to hear about on this gateway says OpenClaw may be updating, with Retry", () => {
    const held = state({ looking: true, held: { gatewayId: "gw-a", to: "2026.11.6" } });
    expect(strip(held)).toMatchObject({
      text: "OpenClaw may be updating to 2026.11.6",
      action: "retry",
      countdown: false,
    });
    expect(footer(held)).toBe("OpenClaw may be updating…");
    // Held for another gateway, or with nothing naming one: nothing is said.
    expect(
      updatingHere(state({ looking: true, held: { gatewayId: "gw-b", to: null } })),
    ).toBeNull();
    expect(updatingHere(state({ looking: true }))).toBeNull();
  });

  it("F-591: settled, or connected again: the ordinary state at once", () => {
    for (const outcome of ["updated", "failed", "rolled-back", "skipped", "unconfirmed"] as const) {
      const s = state({ run: run({ phase: "finished", outcome }) });
      expect(updatingHere(s)).toBeNull();
      expect(strip(s)).toMatchObject({ text: "Reconnecting", action: "retry", countdown: true });
      expect(footer(s)).toBe("Reconnecting…");
    }
    const back = state({ run: run({ phase: "verifying" }) }, connection);
    expect(updatingHere(back)).toBeNull();
    expect(footer(back)).toBe("Connected");
    // A hold that has ended says nothing, even if what it named were still there.
    const ended = state({ looking: false, held: { gatewayId: "gw-a", to: "2026.11.6" } });
    expect(updatingHere(ended)).toBeNull();
    expect(strip(ended)).toMatchObject({ text: "Reconnecting", action: "retry", countdown: true });
    expect(footer(ended)).toBe("Reconnecting…");
    expect(updateLinkLine(ended, null)).not.toBe(
      "An update may be under way from the last Update press.",
    );
  });

  it("F-591: any other lost connection reads as today, and another gateway is unaffected", () => {
    // Nothing the engine knows: not a version that changed, not a gateway that is away.
    const plain = state(null, { ...down, serverVersion: "2026.11.6", openclawUpdate: null });
    expect(strip(plain)).toEqual({
      tone: "warn",
      text: "Reconnecting",
      more: "showing saved messages",
      action: "retry",
      countdown: true,
    });
    expect(footer(plain)).toBe("Reconnecting…");
    // The gateway on screen is another than the one updating.
    const other = state({ run: run() }, { ...down, gatewayId: "gw-b" });
    expect(updatingHere(other)).toBeNull();
    expect(strip(other)?.text).toBe("Reconnecting");
    // Can't reach it, or disconnected by the person: as today.
    const error = state({ run: run() }, { ...down, status: "error", error: null });
    expect(strip(error)?.text).toBe("Can't reach gateway.example");
    expect(updatingHere(state({ run: run() }, { ...down, status: "disconnected" }))).toBeNull();
  });
});

describe("F-591: the update card shows the steps as a bar", () => {
  const card = (patch: Partial<UpdateRunView>, conn: ConnectionState = connection) =>
    part({ connection: conn, openclawUpdating: updating({ run: run(patch) }) });

  it("F-591: a progress bar with the step's value, maximum and words, and the same words beside it", () => {
    const html = card({ phase: "activating" });
    expect(html).toContain(
      'role="progressbar" aria-label="OpenClaw update" aria-valuemin="0" aria-valuemax="8" aria-valuenow="5" aria-valuetext="Step 5 of 8, activating"',
    );
    expect(html).toContain('<span class="b-update-step">Step 5 of 8, activating</span>');
    expect(html.match(/data-step="done"/g)).toHaveLength(4);
    expect(html.match(/data-step="now"/g)).toHaveLength(1);
    expect(text(html)).toContain("Updating OpenClaw to 2026.11.6.");
    // The bar announces nothing itself: the one polite region says each step once.
    expect(html.match(/aria-live/g)).toHaveLength(1);
  });

  it("F-591: while the gateway is away during its restart, the bar waits at the gateway's step and says so", () => {
    const away = { ...connection, status: "reconnecting" as const };
    const html = card({ phase: "restarting" }, away);
    expect(html).toContain('data-waiting="true"');
    expect(html).toContain(
      'aria-valuenow="6" aria-valuetext="Step 6 of 8, restarting: waiting for the gateway to come back"',
    );
    expect(html.match(/data-step="done"/g)).toHaveLength(5);
    // Past the usual time, the same step, still waiting.
    expect(card({ phase: "restarting", outcome: "late" }, away)).toContain('aria-valuenow="6"');
  });

  it("F-591: no bar once the update has settled; Updated says only that, never the gateway's note", () => {
    for (const outcome of ["updated", "failed", "unconfirmed", "elsewhere"] as const)
      expect(card({ phase: "finished", outcome })).not.toContain("progressbar");
    const html = card({
      phase: "finished",
      outcome: "updated",
      note: "Stop the gateway, then run openclaw doctor --cleanup.",
    });
    expect(text(html)).toContain("Updated to OpenClaw 2026.11.6.");
    expect(text(html)).not.toContain("doctor");
    expect(text(html)).not.toContain("The gateway says");
  });
});

describe("F-591: the updater lives in Settings › Updates; elsewhere one line links there", () => {
  const withState = (patch: Partial<OpenClawUpdateState> | null, conn = connection) =>
    ({
      ...initialState,
      connection: conn,
      ...(patch ? { openclawUpdating: updating(patch) } : {}),
    }) as ClawtrateState;
  const linkLine = (s: ClawtrateState) =>
    updateLinkLine(
      s,
      s.openclawUpdating?.run?.gatewayId === "gw-a" ? s.openclawUpdating.run : null,
    );

  it("F-591: the line says a newer OpenClaw is out, or that it is updating, and nothing when neither", () => {
    expect(linkLine(withState(null))).toBe(
      "Your gateway runs OpenClaw 2026.10.6, and 2026.11.6 is out. Updating the gateway is how newer models get listed.",
    );
    expect(linkLine(withState({ run: run() }))).toBe("OpenClaw is updating to 2026.11.6.");
    expect(linkLine(withState({ run: run({ outcome: "late", phase: "restarting" }) }))).toBe(
      "OpenClaw is updating to 2026.11.6. This is taking longer than usual.",
    );
    expect(linkLine(withState({ looking: true }))).toBe(
      "An update may be under way from the last Update press.",
    );
    expect(linkLine(withState(null, { ...connection, openclawUpdate: null }))).toBeNull();
  });

  it("F-591: its link is named for where it goes and opens Settings › Updates; it offers no Update itself", () => {
    const open = vi.fn();
    const html = render(
      createElement(OpenOpenClawUpdates.Provider, {
        value: open,
        children: createElement(UpdateOpenClawLink, {
          line: "OpenClaw is updating.",
          where: "notice",
        }),
      }),
    );
    expect(html).toContain('<button type="button" class="link-button">Settings › Updates</button>');
    expect(html).not.toContain("Update OpenClaw to");
  });

  it("F-591: Settings › Updates keeps the app and OpenClaw apart, each under a heading that says which and where", () => {
    const app = createElement("p", null, "The app's updates");
    const html = render(createElement(UpdatesWithOpenClawView, { state: withState(null), app }));
    expect(text(html)).toMatch(
      /Clawtrate on this device.*The app's updates.*OpenClaw on gateway\.example.*Applies to the gateway, for every device connected to it\..*Update OpenClaw to 2026\.11\.6/,
    );
    expect(html).toContain('id="settings-openclaw-updates" tabindex="-1"');
    // Nothing to say of OpenClaw: the app's updates alone, as before.
    const alone = render(
      createElement(UpdatesWithOpenClawView, {
        state: withState(null, { ...connection, openclawUpdate: null }),
        app,
      }),
    );
    expect(alone).toBe("<p>The app&#x27;s updates</p>");
  });
});
