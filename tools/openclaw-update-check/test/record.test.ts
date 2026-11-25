import { describe, expect, it } from "vitest";
import { judge, refusalToRun, summary, timeline, type Entry, type Plan } from "../src/record.ts";

const RUN = "5b3e3f4e-8c1a-4a57-9d2f-0c1f1d6f7a10";
const T0 = 1_000_000;
const UPDATED: Plan = { expect: "updated" };

/** A run that went as report section 7 expects, with overrides for the record and the hello. */
function record(
  options: {
    status?: string;
    after?: string | null;
    target?: string;
    helloAfter?: string;
    identityAfter?: string;
    latest?: string | null;
    answerOk?: boolean;
  } = {},
): Entry[] {
  const after = options.after === undefined ? "2026.11.10" : options.after;
  const run = {
    runId: RUN,
    phase: "finished",
    status: options.status ?? "succeeded",
    trigger: "api",
    before: { version: "2026.10.6" },
    target: { version: options.target ?? "2026.11.10" },
    ...(after === null ? {} : { after: { version: after } }),
  };
  const latest = options.latest === undefined ? "2026.11.10" : options.latest;
  return [
    {
      at: T0 - 9_000,
      kind: "hello",
      serverVersion: "2026.10.6",
      updateAvailable: null,
      uptimeMs: 100,
    },
    { at: T0 - 8_000, kind: "answer", method: "gateway.identity.get", result: { deviceId: "gw" } },
    {
      at: T0 - 7_000,
      kind: "answer",
      method: "update.status",
      result:
        latest === null
          ? { updateAvailable: null }
          : { updateAvailable: { latestVersion: latest } },
    },
    { at: T0, kind: "sent", method: "update.run", params: {} },
    {
      at: T0 + 500,
      kind: "answer",
      method: "update.run",
      result: {
        runId: RUN,
        ok: options.answerOk ?? true,
        result: { reason: "managed-service-handoff-started" },
        handoff: { status: "started" },
      },
    },
    {
      at: T0 + 2_000,
      kind: "event",
      event: "update.run.changed",
      payload: { runId: RUN, phase: "staging", status: "running" },
    },
    {
      at: T0 + 2_100,
      kind: "event",
      event: "update.run.changed",
      payload: { runId: "another", phase: "verifying", status: "running" },
    },
    {
      at: T0 + 30_000,
      kind: "event",
      event: "update.run.changed",
      payload: { runId: RUN, phase: "activating", status: "running" },
    },
    { at: T0 + 31_000, kind: "close", code: 1012, reason: "service restart" },
    {
      at: T0 + 45_000,
      kind: "hello",
      serverVersion: options.helloAfter ?? "2026.11.10",
      updateAvailable: null,
      uptimeMs: 800,
    },
    {
      at: T0 + 45_500,
      kind: "answer",
      method: "gateway.identity.get",
      result: { deviceId: options.identityAfter ?? "gw" },
    },
    {
      at: T0 + 46_000,
      kind: "answer",
      method: "update.status",
      result: { activeRun: { ...run, phase: "verifying", status: "running" } },
    },
    {
      at: T0 + 47_000,
      kind: "refused",
      method: "update.runs.get",
      code: "UNAVAILABLE",
      message: "update.runs.get unavailable during gateway restart or suspension",
    },
    {
      at: T0 + 49_000,
      kind: "refused",
      method: "update.runs.get",
      code: "UNAVAILABLE",
      message: "update.runs.get unavailable during gateway restart or suspension",
    },
    { at: T0 + 51_000, kind: "answer", method: "update.runs.get", result: { run } },
    // The watcher rebroadcasts the terminal state while the restart sentinel is pending.
    ...[52_000, 54_000].map((ms): Entry => ({
      at: T0 + ms,
      kind: "event",
      event: "update.run.changed",
      payload: { runId: RUN, phase: "finished", status: run.status },
    })),
    {
      at: T0 + 56_000,
      kind: "answer",
      method: "gateway.identity.get",
      result: { deviceId: options.identityAfter ?? "gw" },
    },
  ];
}

describe("the update check's verdict", () => {
  it("passes a run that succeeded on the same gateway at the offered version", () => {
    const verdict = judge(record(), RUN, UPDATED);
    expect(verdict.failures).toEqual([]);
    expect(verdict.passed).toBe(true);
    expect(verdict.facts).toMatchObject({
      presses: { count: 1, params: [{}] },
      handoff: {
        ok: true,
        reason: "managed-service-handoff-started",
        handoff: "started",
        runId: RUN,
        answerMs: 500,
      },
      dropMs: 31_000,
      reconnectMs: 45_000,
      restartedMs: 44_200,
      closes: 1,
      changedBeforeDrop: true,
      unavailable: { count: 2, firstMs: 47_000, lastMs: 49_000 },
      terminalMs: 51_000,
      terminalRepeats: { count: 2, firstMs: 52_000, lastMs: 54_000 },
      activeRunAfterDrop: { phase: "verifying" },
      reopen: null,
      busy: null,
      latestBefore: "2026.11.10",
      serverVersionBefore: "2026.10.6",
      serverVersionAfter: "2026.11.10",
    });
    // Another run's event is not this run's phase.
    expect(verdict.facts.phases.map((p) => `${p.phase}/${p.status}`)).toEqual([
      "staging/running",
      "activating/running",
      "finished/succeeded",
    ]);
  });

  it("times each method's answers", () => {
    const timed: Entry[] = [
      { at: 0, kind: "sent", method: "update.status", params: {} },
      { at: 40, kind: "answer", method: "update.status", result: {} },
      { at: 100, kind: "sent", method: "update.status", params: {} },
      { at: 1_100, kind: "refused", method: "update.status", code: "UNAVAILABLE", message: "" },
      { at: 2_000, kind: "sent", method: "update.status", params: {} },
      { at: 2_300, kind: "answer", method: "update.status", result: {} },
    ];
    expect(judge(timed, null, UPDATED).facts.latency).toEqual({
      "update.status": { count: 3, medianMs: 300, maxMs: 1_000 },
    });
  });

  it("reads an update.status answered in the same millisecond as the update.run send as before it", () => {
    const entries = record().map((e) =>
      e.kind === "answer" && e.method === "update.status" && e.at < T0 ? { ...e, at: T0 } : e,
    );
    expect(judge(entries, RUN, UPDATED).failures).toEqual([]);
  });

  it.each(["failed", "rolled-back", "skipped"])("fails a run that ended %s", (status) => {
    const verdict = judge(record({ status }), RUN, UPDATED);
    expect(verdict.passed).toBe(false);
    expect(verdict.failures).toContain(`the run ended ${status} (no reason)`);
  });

  it("fails when the restarted gateway reports another version than the record", () => {
    const verdict = judge(record({ helloAfter: "2026.11.9" }), RUN, UPDATED);
    expect(verdict.failures).toEqual([
      "hello-ok server.version is 2026.11.9, the run record says 2026.11.10",
    ]);
  });

  it("fails when the gateway's identity changed", () => {
    const verdict = judge(record({ identityAfter: "other" }), RUN, UPDATED);
    expect(verdict.failures).toEqual(["the gateway's identity changed: gw before, other after"]);
  });

  it("compares the hello with target.version when after.version is absent, and says it is absent", () => {
    const verdict = judge(record({ after: null }), RUN, UPDATED);
    expect(verdict.failures).toEqual(["the run record has no after.version"]);
    const mismatch = judge(record({ after: null, helloAfter: "2026.11.9" }), RUN, UPDATED);
    expect(mismatch.failures).toContain(
      "hello-ok server.version is 2026.11.9, the run record says 2026.11.10",
    );
  });

  it("fails when after.version is not the version offered, or not the target", () => {
    const verdict = judge(
      record({ after: "2026.11.9", target: "2026.11.9", helloAfter: "2026.11.9" }),
      RUN,
      UPDATED,
    );
    expect(verdict.failures).toEqual([
      "after.version is 2026.11.9, but the gateway offered 2026.11.10",
    ]);
    const target = judge(record({ target: "2026.11.11" }), RUN, UPDATED);
    expect(target.failures).toEqual([
      "after.version is 2026.11.10, but target.version is 2026.11.11",
    ]);
  });

  it("fails when no newer version was offered or update.run did not hand off", () => {
    expect(judge(record({ latest: null }), RUN, UPDATED).failures).toContain(
      "update.status reported no newer OpenClaw before the run",
    );
    expect(judge(record({ answerOk: false }), RUN, UPDATED).failures).toContain(
      "update.run answered ok: false, handoff started (managed-service-handoff-started)",
    );
  });

  it("fails a run id that is not a UUID, and a press sent twice or with parameters", () => {
    const ocm = record().map((e) =>
      e.kind === "answer" && e.method === "update.run"
        ? { ...e, result: { ...(e.result as object), runId: "ocm:1" } }
        : e,
    );
    expect(judge(ocm, RUN, UPDATED).failures).toContain(
      "update.run answered run id ocm:1, not a UUID",
    );
    const twice = [
      ...record(),
      { at: T0 + 60_000, kind: "sent", method: "update.run", params: { note: "x" } } as Entry,
    ];
    expect(judge(twice, RUN, UPDATED).failures).toEqual([
      "update.run was sent 2 times, not 1",
      "update.run was sent with parameters",
    ]);
  });

  it("fails a run that never finished", () => {
    const unfinished = record().filter(
      (e) =>
        !(e.kind === "answer" && e.method === "update.runs.get") &&
        !(e.kind === "event" && asStatus(e) === "succeeded"),
    );
    const verdict = judge(unfinished, RUN, UPDATED);
    expect(verdict.failures).toEqual(["update.runs.get never reported the run finished"]);
    expect(verdict.facts.terminalMs).toBeNull();
  });

  it("checks a second press is refused as already running, and the first run still followed", () => {
    const plan: Plan = { expect: "updated", secondPress: true };
    const second = (reason: string): Entry[] => {
      const entries = record();
      entries.splice(
        5,
        0,
        { at: T0 + 600, kind: "sent", method: "update.run", params: {} },
        {
          at: T0 + 900,
          kind: "answer",
          method: "update.run",
          result: { runId: "6b3e3f4e-8c1a-4a57-9d2f-0c1f1d6f7a11", ok: false, result: { reason } },
        },
      );
      return entries;
    };
    const verdict = judge(second("managed-service-handoff-already-running"), RUN, plan);
    expect(verdict.failures).toEqual([]);
    expect(verdict.facts.secondPress).toMatchObject({ ok: false });
    expect(judge(second("managed-service-handoff-started"), RUN, plan).failures).toEqual([
      "the second update.run answered managed-service-handoff-started, not managed-service-handoff-already-running",
    ]);
    expect(judge(record(), RUN, plan).failures).toContain("update.run was sent 1 times, not 2");
  });

  it("checks a client reopened mid-run finds the same run active", () => {
    const plan: Plan = { expect: "updated", reopen: true };
    const reopened = (runId: string): Entry[] => {
      const entries = record();
      entries.splice(
        6,
        0,
        { at: T0 + 3_000, kind: "close", code: 1005, reason: "", own: true },
        {
          at: T0 + 3_500,
          kind: "hello",
          serverVersion: "2026.10.6",
          updateAvailable: null,
          uptimeMs: 1,
        },
        {
          at: T0 + 3_600,
          kind: "answer",
          method: "update.status",
          result: { activeRun: { runId, phase: "validating", status: "running" } },
        },
      );
      return entries;
    };
    const verdict = judge(reopened(RUN), RUN, plan);
    expect(verdict.failures).toEqual([]);
    // The check's own close is not the gateway's drop.
    expect(verdict.facts).toMatchObject({
      reopen: { sameRun: true, phase: "validating" },
      dropMs: 31_000,
      closes: 1,
    });
    expect(judge(reopened("other"), RUN, plan).failures).toEqual([
      "after reopening mid-run, update.status did not list the same run as active",
    ]);
  });

  it("records how the turn in flight ended", () => {
    const plan: Plan = { expect: "updated", busySession: "agent:main:main" };
    const entries = record();
    entries.splice(8, 0, {
      at: T0 + 30_500,
      kind: "event",
      event: "chat",
      payload: { sessionKey: "agent:main:main", state: "final" },
    });
    expect(judge(entries, RUN, plan).facts.busy).toEqual({
      state: "final",
      endedMs: 30_500,
      endedBeforeDrop: true,
    });
  });

  it("passes a package installed in a folder only when update.run refuses it without a restart", () => {
    const plan: Plan = { expect: "unmanaged" };
    const refused = (reason: string, close = false): Entry[] => [
      {
        at: T0 - 2_000,
        kind: "hello",
        serverVersion: "2026.10.6",
        updateAvailable: null,
        uptimeMs: 1,
      },
      {
        at: T0 - 1_000,
        kind: "answer",
        method: "gateway.identity.get",
        result: { deviceId: "gw" },
      },
      { at: T0, kind: "sent", method: "update.run", params: {} },
      {
        at: T0 + 100,
        kind: "answer",
        method: "update.run",
        result: { runId: RUN, ok: false, result: { status: "skipped", reason } },
      },
      ...(close ? [{ at: T0 + 200, kind: "close", code: 1012, reason: "" } as Entry] : []),
      {
        at: T0 + 2_000,
        kind: "answer",
        method: "update.runs.get",
        result: {
          run: { runId: RUN, phase: "finished", status: "skipped", reason, trigger: "api" },
        },
      },
    ];
    expect(judge(refused("unmanaged-package-install"), RUN, plan).failures).toEqual([]);
    expect(judge(refused("restart-unavailable"), RUN, plan).failures).toEqual([
      "the run ended skipped (restart-unavailable), not skipped (unmanaged-package-install)",
    ]);
    expect(judge(refused("unmanaged-package-install", true), RUN, plan).failures).toEqual([
      "the gateway closed the connection after a refused update",
    ]);
  });

  it("times the timeline from the update.run send and summarises the facts", () => {
    const lines = timeline(record());
    expect(lines[0]).toMatch(/^ {3}-9\.00s {2}hello {6}server\.version=2026\.10\.6/);
    expect(lines[3]).toBe("   +0.00s  sent       update.run {}");
    const text = summary(judge(record(), RUN, UPDATED), "foreground");
    expect(text).toContain("(foreground): passed");
    expect(text).toContain("| +51.00s | finished | succeeded | runs.get |");
    expect(text).toContain(
      "Terminal update.run.changed after the reconnect: 2, from +52.00s to +54.00s",
    );
  });
});

describe("the requester and what the run delivers", () => {
  const TAG = "clawtrate-update:1";
  const REQUESTER = { channel: "webchat", senderId: TAG };
  const plan: Plan = { expect: "updated", requesterPrefix: "clawtrate-update:" };

  /** The usual run, pressed with a requester, the record keeping `kept`, sessions listed around it. */
  function tagged(
    options: {
      kept?: unknown;
      listed?: string[];
      sessionsAfter?: { key: string; updatedAt: number }[];
      extra?: Entry[];
    } = {},
  ): Entry[] {
    const entries = record().map((e): Entry => {
      if (e.kind === "sent" && e.method === "update.run")
        return { ...e, params: { requester: REQUESTER } };
      if (e.kind === "answer" && e.method === "update.runs.get") {
        const run = (e.result as { run: object }).run;
        return {
          ...e,
          result: {
            run: {
              ...run,
              trigger: "api",
              origin: { requester: options.kept === undefined ? REQUESTER : options.kept },
              steps: [
                { step: "notice:verifying", status: "skipped", detail: "no delivery target" },
              ],
              verification: { noticeDelivered: false },
            },
          },
        };
      }
      return e;
    });
    const before = { sessions: [{ key: "agent:main:main", updatedAt: 1 }] };
    entries.splice(3, 0, { at: T0 - 100, kind: "answer", method: "sessions.list", result: before });
    entries.push(
      ...(options.extra ?? []),
      {
        at: T0 + 60_000,
        kind: "answer",
        method: "update.runs.list",
        result: {
          runs: (options.listed ?? [RUN]).map((runId) => ({
            runId,
            origin: { requester: REQUESTER },
          })),
        },
      },
      {
        at: T0 + 61_000,
        kind: "answer",
        method: "sessions.list",
        result: { sessions: options.sessionsAfter ?? before.sessions },
      },
    );
    return entries;
  }

  it("passes when the record keeps the requester, the tag finds the run and nothing is delivered", () => {
    const verdict = judge(tagged(), RUN, plan);
    expect(verdict.failures).toEqual([]);
    expect(verdict.facts).toMatchObject({
      requester: { sent: REQUESTER, kept: REQUESTER, trigger: "api" },
      foundByTag: [RUN],
      delivery: {
        notices: [{ step: "notice:verifying", status: "skipped", detail: "no delivery target" }],
        noticeDelivered: false,
        newSessions: [],
        changedSessions: [],
        chatEventsElsewhere: 0,
      },
      // From staging at +2 s to activating at +30 s; the gap across the restart is not counted.
      longestQuietMs: 28_000,
    });
  });

  it("fails a press without the requester, or a record that dropped it, or a tag that finds nothing", () => {
    const bare = tagged().map((e) =>
      e.kind === "sent" && e.method === "update.run" ? { ...e, params: {} } : e,
    );
    expect(judge(bare, RUN, plan).failures).toContain(
      "update.run was sent with parameters other than a webchat requester and its tag",
    );
    expect(judge(tagged({ kept: null }), RUN, plan).failures).toEqual([
      `the run record kept requester null, not ${JSON.stringify(REQUESTER)}`,
    ]);
    expect(judge(tagged({ listed: [] }), RUN, plan).failures).toEqual([
      "update.runs.list found [] by the tag, not the run",
    ]);
  });

  it("fails when anything lands in a session or a notice is delivered", () => {
    const added = tagged({
      sessionsAfter: [
        { key: "agent:main:main", updatedAt: 2 },
        { key: "agent:main:update", updatedAt: 3 },
      ],
    });
    expect(judge(added, RUN, plan).failures).toEqual([
      "a session appeared: agent:main:update",
      "a session changed: agent:main:main",
    ]);
    // The turn in flight changes its own session; that is not a delivery.
    const busy: Plan = { ...plan, busySession: "agent:main:main" };
    const turned = tagged({ sessionsAfter: [{ key: "agent:main:main", updatedAt: 2 }] });
    expect(judge(turned, RUN, busy).failures).toEqual([]);
    const chat: Entry = {
      at: T0 + 50_000,
      kind: "event",
      event: "chat",
      payload: { sessionKey: "agent:main:main", state: "final" },
    };
    expect(judge(tagged({ extra: [chat] }), RUN, plan).failures).toEqual([
      "1 chat events arrived for a session other than the turn",
    ]);
    const delivered = tagged().map((e) =>
      e.kind === "answer" && e.method === "update.runs.get"
        ? {
            ...e,
            result: {
              run: {
                ...(e.result as { run: object }).run,
                verification: { noticeDelivered: true },
              },
            },
          }
        : e,
    );
    // The record's own flag is not trusted; a completed notice step is.
    expect(judge(delivered, RUN, plan).failures).toEqual([]);
    const completed = tagged().map((e) =>
      e.kind === "answer" && e.method === "update.runs.get"
        ? {
            ...e,
            result: {
              run: {
                ...(e.result as { run: object }).run,
                steps: [{ step: "notice:verifying", status: "completed" }],
              },
            },
          }
        : e,
    );
    expect(judge(completed, RUN, plan).failures).toEqual([
      "the gateway delivered an update notice",
    ]);
  });

  it("measures quiet gaps while connected, not across the restart", () => {
    const changed = (at: number, status = "running"): Entry => ({
      at,
      kind: "event",
      event: "update.run.changed",
      payload: { runId: RUN, phase: "validating", status },
    });
    const entries: Entry[] = [
      { at: 0, kind: "sent", method: "update.run", params: {} },
      changed(1_000),
      changed(3_000),
      { at: 4_000, kind: "close", code: 1012, reason: "" },
      {
        at: 100_000,
        kind: "hello",
        serverVersion: "2026.11.10",
        updateAvailable: null,
        uptimeMs: 1,
      },
      changed(100_500),
      changed(101_000, "succeeded"),
      changed(140_000, "succeeded"),
    ];
    // Not 96.5 s across the restart, nor 39 s between two terminal events.
    expect(judge(entries, RUN, plan).facts.longestQuietMs).toBe(2_000);
  });

  it("fails another trigger, and the tag in any event", () => {
    const campaign = tagged().map((e) =>
      e.kind === "answer" && e.method === "update.runs.get"
        ? {
            ...e,
            result: { run: { ...(e.result as { run: object }).run, trigger: "campaign" } },
          }
        : e,
    );
    expect(judge(campaign, RUN, plan).failures).toEqual(["the run's trigger is campaign, not api"]);
    // A press that adopts the gateway's own campaign expects that trigger, and its record is the
    // campaign's, so the tag is only recorded.
    expect(judge(campaign, RUN, { ...plan, campaign: true }).failures).toEqual([]);
    const leaked: Entry = {
      at: T0 + 20_000,
      kind: "event",
      event: "update.run.changed",
      payload: { runId: RUN, phase: "validating", status: "running", requester: REQUESTER },
    };
    expect(judge(tagged({ extra: [leaked] }), RUN, plan).failures).toEqual([
      "the tag appeared in events: update.run.changed",
    ]);
  });

  it("accepts a lost answer when the run is found by its tag", () => {
    const dropped = tagged().filter((e) => !(e.kind === "answer" && e.method === "update.run"));
    const lost: Plan = { ...plan, dropAnswer: true };
    expect(judge(dropped, RUN, lost).failures).toEqual([]);
    expect(judge(dropped, RUN, plan).failures).toEqual(["update.run was not answered"]);
    expect(
      judge(
        tagged({ listed: [] }).filter((e) => !(e.kind === "answer" && e.method === "update.run")),
        RUN,
        lost,
      ).failures,
    ).toEqual(["update.runs.list found [] by the tag, not the run"]);
  });

  it("fails a transcript message about the update", () => {
    const history = (content: unknown): Entry => ({
      at: T0 + 62_000,
      kind: "answer",
      method: "chat.history",
      result: {
        messages: [
          { role: "user", content: "#slow 300 Please take your time." },
          { role: "assistant", content },
        ],
      },
    });
    expect(
      judge(tagged({ extra: [history("Here is a long answer.")] }), RUN, plan).failures,
    ).toEqual([]);
    const notice = history([{ type: "text", text: "OpenClaw was updated to 2026.11.10." }]);
    expect(judge(tagged({ extra: [notice] }), RUN, plan).failures).toEqual([
      "a transcript mentions the update: assistant: OpenClaw was updated to 2026.11.10.",
    ]);
  });

  it("counts answers that said the database is locked", () => {
    const locked: Entry = {
      at: T0 + 46_500,
      kind: "refused",
      method: "update.status",
      code: "UNAVAILABLE",
      message: "SqliteError: database is locked",
    };
    const verdict = judge(tagged({ extra: [locked] }), RUN, plan);
    expect(verdict.facts.databaseLocked).toBe(1);
    expect(verdict.failures).toEqual(['1 answers said "database is locked"']);
  });
});

const asStatus = (e: Entry) =>
  e.kind === "event" ? (e.payload as { status?: string } | null)?.status : undefined;

describe("where the update check runs", () => {
  const hosted = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" };

  it("runs only on a GitHub-hosted runner", () => {
    expect(refusalToRun(hosted, "clawtrate-dev-update")).toBeNull();
    expect(refusalToRun({}, "clawtrate-dev-update")).toMatch(/GitHub-hosted runner/);
    expect(
      refusalToRun(
        { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" },
        "clawtrate-dev-update",
      ),
    ).toMatch(/GitHub-hosted runner/);
  });

  it("uses only a clawtrate-dev profile", () => {
    for (const profile of ["", "default", "dev", "clawtrate-dev-", "clawtrate-dev-../x"]) {
      expect(refusalToRun(hosted, profile)).toMatch(/refusing profile/);
    }
  });
});
