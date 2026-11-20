// The check-ins engine against a fake gateway that enrolls bots by OpenClaw
// 2026.10.6's rules (docs/decisions.md, "Check-ins"): bots with a heartbeat of
// their own, else the default's `agentId`, else every bot when a default block
// exists, else `systemAgent.agentId`; a bot's cadence is its own `every`, else
// the default's, else 30m; `every: "0m"` keeps the job, disabled. Its jobs
// come one per page with a snapshot revision, what it derives can be held back
// to see what the engine says meanwhile, and its answers can be held or left
// unanswered until the request's own timeout.

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { describe, expect, it } from "vitest";
import { enforce } from "../src/bounds.ts";
import { ClawtrateClient } from "../src/client.ts";
import { ADMIN_SCOPES, INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { FAST, grantingGateway, URL_A } from "./client-harness.ts";
import { memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";
import {
  cannotKeep,
  CHECK_INS,
  durationMs,
  everyText,
  keptByDefault,
  loadCheckIns,
  planCheckIn,
  readDefaults,
  readJobs,
  readSettings,
  saveCheckIn,
  type CheckInDraft,
  type CheckInsContext,
  type CheckInsState,
} from "../src/index.ts";

/** The bots Clawtrate lists; the gateway also has "quill", which it does not. */
const BOTS = ["main", "marlow", "otto"];
type Heartbeat = { every?: string; prompt?: string; agentId?: string };
type Config = {
  agents: {
    defaults: { heartbeat?: Heartbeat; systemAgent?: { agentId: string } };
    entries: Record<string, { heartbeat?: Heartbeat }>;
  };
};

function fakeGateway(
  options: {
    patch?: () => never;
    defaults?: Heartbeat;
    entries?: Config["agents"]["entries"];
  } = {},
) {
  const config: Config = {
    agents: {
      defaults: { heartbeat: options.defaults ?? { agentId: "main" } },
      entries: options.entries ?? { main: {}, marlow: {}, otto: {}, quill: {} },
    },
  };
  const gateway = {
    config,
    patches: [] as Array<{ raw: unknown; baseHash: unknown }>,
    /** Every `config.patch` asked, applied or not. */
    attempts: [] as Array<{ baseHash: unknown }>,
    hash: 0,
    /** What `config.get` gives as its hash instead of the real one. */
    hashText: null as string | null,
    /** The gateway's identity (`gateway.identity.get`). */
    identity: "gw-1",
    /** Requests then wait for their own timeout, unanswered. */
    stall: false,
    /** Awaited before a request is answered. */
    gate: (_method: string): Promise<void> | void => {},
    /** The jobs `cron.list` pages through, in its order; the revision names that order. */
    arrange: (jobs: unknown[]) => jobs,
    revision: 0,
    /** The jobs the gateway lists, when they are not what it would derive now. */
    jobs: null as unknown[] | null,
    /** Off: config and jobs answer as they were before the last patch until `release`. */
    hold: false,
    held: null as { config: Config; jobs: unknown[] } | null,
    linkAlive: true,
    /** Called before each request is answered, to change the world under the engine. */
    before: (_method: string) => {},
  };
  const view = () =>
    gateway.held ?? {
      config: JSON.parse(JSON.stringify(gateway.config)) as Config,
      jobs: gateway.jobs ?? fakeJobs(gateway.config),
    };
  const request = async (
    method: string,
    params: unknown,
    asked?: { timeoutMs?: number },
  ): Promise<unknown> => {
    gateway.before(method);
    if (gateway.stall) {
      // Nothing answers: the request gives up at its own timeout (60 s when none is asked).
      const started = now;
      await Promise.resolve();
      now = Math.max(now, started + (asked?.timeoutMs ?? 60_000));
      throw new Error("request timeout");
    }
    await gateway.gate(method);
    const p = params as { raw?: string; baseHash?: string; offset?: number };
    switch (method) {
      case "cron.list": {
        const all = gateway.arrange([
          { agentId: "otto", payload: { kind: "agentTurn" }, enabled: true },
          ...view().jobs,
        ]);
        const offset = p.offset ?? 0;
        const more = offset + 1 < all.length;
        return {
          jobs: all.slice(offset, offset + 1),
          total: all.length,
          offset,
          snapshotRevision: `r${gateway.revision}`,
          hasMore: more,
          nextOffset: more ? offset + 1 : null,
        };
      }
      case "cron.status":
        return { enabled: false };
      case "config.get":
        return { hash: gateway.hashText ?? `h${gateway.hash}`, config: view().config };
      case "config.patch": {
        gateway.attempts.push({ baseHash: p.baseHash });
        if (options.patch) options.patch();
        if (p.baseHash !== `h${gateway.hash}`)
          throw new GatewayProtocolRequestError({
            code: "INVALID_REQUEST",
            message: "config changed since last load; re-run config.get and retry",
          });
        if (gateway.hold) gateway.held = view();
        const patch = JSON.parse(p.raw!) as {
          agents: { entries: Record<string, { heartbeat: Heartbeat }> };
        };
        gateway.patches.push({ raw: patch, baseHash: p.baseHash });
        for (const [bot, entry] of Object.entries(patch.agents.entries)) {
          const heartbeat = {
            ...gateway.config.agents.entries[bot]?.heartbeat,
            ...entry.heartbeat,
          };
          if ((heartbeat as { prompt?: unknown }).prompt === null) delete heartbeat.prompt;
          gateway.config.agents.entries[bot] = { ...gateway.config.agents.entries[bot], heartbeat };
        }
        gateway.hash += 1;
        return { ok: true };
      }
    }
    throw new Error(`unexpected ${method}`);
  };
  /** Another client's change, as the gateway applies it. */
  const elsewhere = (change: (config: Config) => void) => {
    change(gateway.config);
    gateway.hash += 1;
  };
  let state: CheckInsState | undefined;
  let now = 0;
  let admin = true;
  let reads = 0;
  const ctx: CheckInsContext = {
    link: () => {
      gateway.linkAlive = true;
      const alive = () => gateway.linkAlive;
      return {
        alive,
        request: (method, params, asked) =>
          alive()
            ? request(method, params, asked)
            : Promise.reject(Object.assign(new Error("not sent"), { name: "NotSentError" })),
      };
    },
    gateway: async () => gateway.identity,
    begin: () => {
      const mine = (reads += 1);
      return () => mine === reads;
    },
    get: () => state,
    set: (next) => (state = next),
    botIds: () => BOTS,
    admin: () => admin,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      onSleep?.();
    },
  };
  let onSleep: (() => void) | undefined;
  return {
    gateway,
    ctx,
    elsewhere,
    state: () => state!,
    setAdmin: (value: boolean) => (admin = value),
    onSleep: (run: () => void) => (onSleep = run),
    release: () => (gateway.held = null),
    now: () => now,
  };
}

/** The draft a dialog sends, from what it was shown. */
function draft(
  state: CheckInsState,
  botId: string,
  change: { every?: string; prompt?: string },
): CheckInDraft {
  const setting = state.settings?.find((each) => each.botId === botId);
  return {
    gatewayId: "gw-1",
    every: change.every ?? null,
    prompt: change.prompt ?? null,
    was: { every: setting?.every ?? null, prompt: setting?.prompt ?? null },
    kept: keptByDefault(botId, state.settings, state.defaults),
  };
}

const jobsOf = (state: CheckInsState) =>
  state.jobs.map((job) => [job.botId, job.enabled, job.everyMs]).sort();

describe("reading check-ins", () => {
  it("keeps one heartbeat job per bot and nothing else", () => {
    const jobs = readJobs({
      jobs: [
        {
          agentId: "main",
          payload: { kind: "heartbeat" },
          enabled: true,
          schedule: { kind: "every", everyMs: 1_800_000 },
          state: { nextRunAtMs: 5 },
        },
        { agentId: "main", payload: { kind: "heartbeat" }, enabled: false },
        { agentId: "otto", payload: { kind: "agentTurn" }, enabled: true },
      ],
    });
    expect(jobs).toEqual([{ botId: "main", enabled: true, everyMs: 1_800_000, nextRunAtMs: 5 }]);
  });

  it("reads a bot's own setting and marks a prompt too long to keep", () => {
    const settings = readSettings(
      {
        config: {
          agents: {
            entries: {
              marlow: { heartbeat: { every: "24h", prompt: "x".repeat(5_000) } },
              otto: {},
            },
          },
        },
      },
      BOTS,
    );
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({ botId: "marlow", every: "24h", promptCut: true });
    expect(settings[0]!.prompt).toHaveLength(4_000);
  });

  it("finds who checks in through the default by the gateway's rules, from the config alone", () => {
    const config = (defaults: unknown, entries: unknown, more: Record<string, unknown> = {}) => ({
      config: { agents: { defaults: { heartbeat: defaults, ...more }, entries } },
    });
    const entries = { main: {}, marlow: {}, quill: {} };
    expect(readDefaults(config({ agentId: "Main" }, entries)).inherited).toEqual(["main"]);
    expect(readDefaults(config({ every: "90s" }, entries))).toMatchObject({
      inherited: ["main", "marlow", "quill"],
      every: "90s",
    });
    expect(readDefaults(config({}, { ...entries, marlow: { heartbeat: {} } })).inherited).toEqual(
      [],
    );
    // No default block: the ambient owner, which the gateway takes from `systemAgent`.
    expect(
      readDefaults(config(undefined, entries, { systemAgent: { agentId: "Marlow" } })),
    ).toMatchObject({ inherited: ["marlow"], every: "30m", prompt: null });
    // A sole bot owns it; with several and nothing naming one, nobody does.
    expect(readDefaults(config(undefined, { quill: {} })).inherited).toEqual(["quill"]);
    expect(readDefaults(config(undefined, entries)).inherited).toEqual([]);
  });

  it("reads cadences exactly as the gateway does, and writes them back without rounding", () => {
    expect(durationMs("90s")).toBe(90_000);
    expect(durationMs("1h30m")).toBe(5_400_000);
    expect(durationMs("15")).toBe(900_000);
    expect(durationMs("0m")).toBe(0);
    expect(durationMs("soon")).toBeNull();
    expect(everyText(90_000)).toBe("90s");
    expect(everyText(5_400_000)).toBe("90m");
    expect(everyText(86_400_000)).toBe("24h");
  });

  it("reads every page of jobs, the scheduler, the settings and the default", async () => {
    const { ctx, state } = fakeGateway({ defaults: { every: "90s" } });
    await loadCheckIns(ctx);
    expect(state()).toMatchObject({ status: "ready", scheduler: false, settings: [] });
    expect(jobsOf(state())).toEqual([
      ["main", true, 90_000],
      ["marlow", true, 90_000],
      ["otto", true, 90_000],
    ]);
    expect(state().defaults).toMatchObject({
      inherited: ["main", "marlow", "otto", "quill"],
      every: "90s",
    });
  });
});

describe("F-201 the patch a save writes", () => {
  it("F-201: keeps every bot that inherits the default, listed or not, at its exact cadence, in the same patch", async () => {
    const { gateway, ctx, state } = fakeGateway({ defaults: { every: "90s" } });
    await loadCheckIns(ctx);
    const asked = draft(state(), "marlow", { every: "24h" });
    expect(asked.kept.map((each) => each.botId)).toEqual(["main", "otto", "quill"]);
    await saveCheckIn(ctx, "s1", "marlow", asked);
    expect(gateway.patches).toEqual([
      {
        baseHash: "h0",
        raw: {
          agents: {
            entries: {
              marlow: { heartbeat: { every: "24h" } },
              main: { heartbeat: { every: "90s" } },
              otto: { heartbeat: { every: "90s" } },
              quill: { heartbeat: { every: "90s" } },
            },
          },
        },
      },
    ]);
    expect(state().save?.status).toBe("saved");
    expect(jobsOf(state())).toEqual([
      ["main", true, 90_000],
      ["marlow", true, 86_400_000],
      ["otto", true, 90_000],
    ]);
  });

  it("F-201: writes only the fields the person changed, so another client's cadence stays", async () => {
    const { gateway, ctx, state, elsewhere } = fakeGateway({
      entries: { main: { heartbeat: { every: "30m" } }, marlow: {}, otto: {}, quill: {} },
    });
    await loadCheckIns(ctx);
    const asked = draft(state(), "main", { prompt: "Look at the calendar. Else NO_REPLY." });
    elsewhere((config) => (config.agents.entries.main!.heartbeat!.every = "24h"));
    await saveCheckIn(ctx, "s1", "main", asked);
    expect(gateway.patches).toHaveLength(1);
    expect(gateway.patches[0]!.raw).toEqual({
      agents: {
        entries: { main: { heartbeat: { prompt: "Look at the calendar. Else NO_REPLY." } } },
      },
    });
    expect(gateway.config.agents.entries.main!.heartbeat).toEqual({
      every: "24h",
      prompt: "Look at the calendar. Else NO_REPLY.",
    });
    expect(state().save?.status).toBe("saved");
  });

  it("F-201: a change to the same field elsewhere is a conflict: nothing is written and the draft stays the caller's", async () => {
    const { gateway, ctx, state, elsewhere } = fakeGateway({
      entries: {
        main: { heartbeat: { every: "30m", prompt: "A. NO_REPLY" } },
        marlow: {},
        otto: {},
        quill: {},
      },
    });
    await loadCheckIns(ctx);
    const cadence = draft(state(), "main", { every: "2h" });
    const prompt = draft(state(), "main", { prompt: "B. NO_REPLY" });
    elsewhere(
      (config) =>
        (config.agents.entries.main!.heartbeat = { every: "24h", prompt: "x".repeat(5_000) }),
    );
    await saveCheckIn(ctx, "s1", "main", cadence);
    expect(state().save).toMatchObject({
      status: "conflict",
      error: expect.stringMatching(/cadence was changed/),
    });
    await saveCheckIn(ctx, "s2", "main", prompt);
    expect(state().save).toMatchObject({
      status: "conflict",
      error: expect.stringMatching(/longer than Clawtrate edits/),
    });
    expect(gateway.patches).toEqual([]);
    // The list now shows what the gateway has, for the next try.
    expect(state().settings?.find((each) => each.botId === "main")?.every).toBe("24h");
  });

  it.each([
    ["marlow", /this bot was deleted/i],
    ["main", /which bots check in through the default changed/i],
  ] as const)(
    "F-201: deleting %s while editing Marlow's check-ins is a conflict with no patch",
    async (deleted, error) => {
      const { gateway, ctx, state, elsewhere } = fakeGateway();
      await loadCheckIns(ctx);
      const asked = draft(state(), "marlow", { every: "24h" });
      elsewhere((config) => delete config.agents.entries[deleted]);

      await saveCheckIn(ctx, "s1", "marlow", asked);

      expect(state().save).toMatchObject({
        status: "conflict",
        error: expect.stringMatching(error),
      });
      expect(gateway.attempts).toEqual([]);
    },
  );

  it("F-201: bots that would stop, and were not named before saving, are a conflict, not a silent write", async () => {
    const { gateway, ctx, state, elsewhere } = fakeGateway();
    await loadCheckIns(ctx);
    const asked = draft(state(), "marlow", { every: "24h" });
    expect(asked.kept).toEqual([{ botId: "main", every: "30m" }]);
    elsewhere((config) => delete config.agents.defaults.heartbeat!.agentId);
    await saveCheckIn(ctx, "s1", "marlow", asked);
    expect(state().save).toMatchObject({
      status: "conflict",
      error: expect.stringMatching(/through the default changed/),
    });
    expect(gateway.patches).toEqual([]);
  });

  it("F-201: with no default block the bot kept is the owner the config names now, not the one a stale job still shows", async () => {
    const { gateway, ctx, state, elsewhere } = fakeGateway({ defaults: {} });
    delete gateway.config.agents.defaults.heartbeat;
    gateway.config.agents.defaults.systemAgent = { agentId: "main" };
    await loadCheckIns(ctx);
    expect(state().defaults?.inherited).toEqual(["main"]);
    // The owner moves to Pip; the gateway still lists Juniper's job until a heartbeat changes.
    elsewhere((config) => {
      config.agents.defaults.systemAgent = { agentId: "pip" };
      config.agents.entries.pip = {};
    });
    gateway.jobs = fakeJobs({
      agents: { ...gateway.config.agents, defaults: { systemAgent: { agentId: "main" } } },
    });
    await loadCheckIns(ctx);
    expect(state().defaults?.inherited).toEqual(["pip"]);
    gateway.jobs = null;
    const asked = draft(state(), "marlow", { every: "24h" });
    expect(asked.kept).toEqual([{ botId: "pip", every: "30m" }]);
    await saveCheckIn(ctx, "s1", "marlow", asked);
    expect(gateway.patches.map((each) => each.raw)).toEqual([
      {
        agents: {
          entries: {
            marlow: { heartbeat: { every: "24h" } },
            pip: { heartbeat: { every: "30m" } },
          },
        },
      },
    ]);
    expect(state().save?.status).toBe("saved");
  });

  it("F-201: a default cadence too long to write back whole is refused before anything is written, never cut", async () => {
    const every = "0s".repeat(32) + "90s";
    expect(durationMs(every)).toBe(90_000);
    const { gateway, ctx, state } = fakeGateway({ defaults: { every } });
    await loadCheckIns(ctx);
    expect(state().defaults).toMatchObject({ everyCut: true });
    expect(cannotKeep("marlow", state().settings, state().defaults)).toMatch(/longer than/);
    await saveCheckIn(ctx, "s1", "marlow", draft(state(), "marlow", { every: "24h" }));
    expect(gateway.attempts).toEqual([]);
    expect(state().save).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/longer/),
    });
  });

  it("F-201: the 32-bot limit counts the bots kept, not the bot being saved", async () => {
    const entries = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`b${i}`, {}]));
    const many = fakeGateway({ defaults: {}, entries: entries(33) });
    await loadCheckIns(many.ctx);
    // Each listed here: b0 is saved, the 32 others are kept.
    const asked = draft(many.state(), "b0", { every: "24h" });
    expect(asked.kept).toHaveLength(32);
    expect(cannotKeep("b0", many.state().settings, many.state().defaults)).toBeNull();
    expect(planCheckIn("b0", asked, { config: many.gateway.config })).toMatchObject({
      expect: expect.arrayContaining([{ botId: "b32", every: "30m" }]),
    });
    const more = fakeGateway({ defaults: {}, entries: entries(34) });
    await loadCheckIns(more.ctx);
    expect(cannotKeep("b0", more.state().settings, more.state().defaults)).toMatch(/at most 32/);
    await saveCheckIn(more.ctx, "s1", "b0", {
      ...draft(more.state(), "b0", { every: "24h" }),
      kept: [],
    });
    expect(more.gateway.attempts).toEqual([]);
    expect(more.state().save).toMatchObject({ status: "failed" });
  });

  it("F-201: a save is refused before anything is read or written when the gateway is not the one its draft was made on", async () => {
    const { gateway, ctx, state } = fakeGateway();
    await loadCheckIns(ctx);
    expect(state().gatewayId).toBe("gw-1");
    const asked = draft(state(), "marlow", { every: "24h" });
    gateway.identity = "gw-2";
    const before = gateway.attempts.length;
    await expect(saveCheckIn(ctx, "s1", "marlow", asked)).rejects.toThrow(/another gateway/);
    expect(gateway.attempts.length).toBe(before);
    expect(state().save).toBeNull();
  });

  it("F-201: a prompt for a bot that does not check in keeps it off, and clearing a prompt removes it", () => {
    const config = {
      config: { agents: { entries: { otto: {}, main: { heartbeat: { prompt: "P" } } } } },
    };
    const was = { every: null, prompt: null };
    const gatewayId = "gw-1";
    expect(
      planCheckIn("otto", { gatewayId, every: null, prompt: "Q", was, kept: [] }, config),
    ).toMatchObject({
      patch: { agents: { entries: { otto: { heartbeat: { every: "0m", prompt: "Q" } } } } },
    });
    expect(
      planCheckIn(
        "main",
        { gatewayId, every: null, prompt: "", was: { every: null, prompt: "P" }, kept: [] },
        config,
      ),
    ).toMatchObject({ patch: { agents: { entries: { main: { heartbeat: { prompt: null } } } } } });
    expect(
      planCheckIn("otto", { gatewayId, every: null, prompt: null, was, kept: [] }, config),
    ).toEqual({ patch: null, own: {}, expect: [] });
  });
});

describe("reading check-ins while they change", () => {
  it("reads the jobs again from the start when their order changes between pages, so none is missed", async () => {
    const { gateway, ctx, state } = fakeGateway({ defaults: { every: "90s" } });
    let reordered = false;
    gateway.before = (method) => {
      if (method !== "cron.list" || reordered || gateway.revision > 0) return;
      // After the first two pages, another job's change moves main to the end.
      if (++pages === 3) {
        reordered = true;
        gateway.revision += 1;
        gateway.arrange = (jobs) => [jobs[0], ...jobs.slice(2), jobs[1]];
      }
    };
    let pages = 0;
    await loadCheckIns(ctx);
    expect(reordered).toBe(true);
    expect(jobsOf(state())).toEqual([
      ["main", true, 90_000],
      ["marlow", true, 90_000],
      ["otto", true, 90_000],
    ]);
  });

  it("a read that a later one overtook does not replace what the later one showed", async () => {
    const { gateway, ctx, state } = fakeGateway();
    await loadCheckIns(ctx);
    let slow: (() => void) | null = null;
    gateway.gate = (method) => {
      if (method === "config.get" && !slow) return new Promise<void>((go) => (slow = go));
    };
    const stale = loadCheckIns(ctx);
    await until(() => slow !== null);
    gateway.gate = () => {};
    await saveCheckIn(ctx, "s1", "marlow", draft(state(), "marlow", { every: "24h" }));
    expect(state().save?.status).toBe("saved");
    // The slow read began before the save and answers with what it read then.
    gateway.config.agents.entries = { main: {}, marlow: {}, otto: {}, quill: {} };
    slow!();
    await stale;
    expect(jobsOf(state())).toContainEqual(["marlow", true, 86_400_000]);
  });
});

describe("F-201 F-366 saving", () => {
  it("F-201: As needed writes every 30m, and is saved once the job runs every 30 minutes", async () => {
    const { gateway, ctx, state } = fakeGateway({
      entries: { main: { heartbeat: { every: "0m" } }, marlow: {}, otto: {}, quill: {} },
    });
    await loadCheckIns(ctx);
    await saveCheckIn(ctx, "s1", "main", draft(state(), "main", { every: "30m" }));
    expect(gateway.patches.map((each) => each.raw)).toEqual([
      { agents: { entries: { main: { heartbeat: { every: "30m" } } } } },
    ]);
    expect(state().save?.status).toBe("saved");
    expect(jobsOf(state())).toEqual([["main", true, 1_800_000]]);
  });

  it("F-201: a prompt-only save waits for the job to match the cadence in read-back config", async () => {
    const fake = fakeGateway({
      entries: { main: { heartbeat: { every: "30m" } }, marlow: {}, otto: {}, quill: {} },
    });
    await loadCheckIns(fake.ctx);
    fake.gateway.jobs = fakeJobs(fake.gateway.config);
    fake.gateway.before = (method) => {
      if (method === "config.get" && fake.gateway.patches.length === 1) {
        fake.gateway.before = () => {};
        fake.elsewhere((config) => {
          config.agents.entries.main!.heartbeat!.every = "1h";
        });
      }
    };
    fake.onSleep(() => {
      expect(fake.state().save?.status).toBe("saving");
      fake.gateway.jobs = null;
    });
    await saveCheckIn(
      fake.ctx,
      "s1",
      "main",
      draft(fake.state(), "main", { prompt: "New prompt" }),
    );
    expect(fake.state().save?.status).toBe("saved");
    expect(jobsOf(fake.state())).toEqual([["main", true, 3_600_000]]);
  });

  it("F-366: Off writes every 0m and is saved only once the bot's job is disabled", async () => {
    const fake = fakeGateway();
    await loadCheckIns(fake.ctx);
    fake.gateway.hold = true;
    let reads = 0;
    fake.onSleep(() => {
      reads += 1;
      // The config already holds Off, and the job still runs.
      expect(fake.state().save?.status).toBe("saving");
      if (reads === 1) fake.gateway.held!.config = JSON.parse(JSON.stringify(fake.gateway.config));
      if (reads === 3) fake.release();
    });
    await saveCheckIn(fake.ctx, "s1", "main", draft(fake.state(), "main", { every: "0m" }));
    expect(reads).toBe(3);
    expect(fake.gateway.patches).toHaveLength(1);
    expect(fake.gateway.config.agents.entries.main?.heartbeat?.every).toBe("0m");
    expect(fake.state().save?.status).toBe("saved");
    expect(fake.state().jobs).toEqual([
      { botId: "main", enabled: false, everyMs: 1_800_000, nextRunAtMs: null },
    ]);
  });

  for (const what of ["the bot's own job", "a kept bot's job", "the prompt"]) {
    it(`F-201: nothing says saved while ${what} does not yet show the change`, async () => {
      const fake = fakeGateway();
      await loadCheckIns(fake.ctx);
      fake.gateway.hold = true;
      const asked = draft(fake.state(), "marlow", { every: "24h", prompt: "Q. NO_REPLY" });
      let reads = 0;
      fake.onSleep(() => {
        reads += 1;
        expect(fake.state().save?.status).toBe("saving");
        if (reads < 3) return;
        // The gateway catches up one part at a time; each part alone is not enough.
        const held = fake.gateway.held!;
        const live = { config: JSON.parse(JSON.stringify(fake.gateway.config)) as Config };
        if (what === "the prompt") {
          held.jobs = fakeJobs(live.config);
          held.config.agents.entries.main = live.config.agents.entries.main!;
          held.config.agents.entries.marlow = {
            heartbeat: { every: "24h" },
          };
        } else if (what === "a kept bot's job") {
          held.config = live.config;
          held.jobs = fakeJobs(live.config).filter((job) => job.agentId !== "main");
        } else {
          held.config = live.config;
          held.jobs = fakeJobs(live.config).filter((job) => job.agentId !== "marlow");
        }
        if (reads >= 6) fake.release();
      });
      await saveCheckIn(fake.ctx, "s1", "marlow", asked);
      expect(reads).toBeGreaterThanOrEqual(6);
      expect(fake.gateway.patches).toHaveLength(1);
      expect(fake.state().save?.status).toBe("saved");
    });
  }

  it("is unknown, not saved, when the gateway never shows the change", async () => {
    const fake = fakeGateway();
    await loadCheckIns(fake.ctx);
    fake.gateway.hold = true;
    await saveCheckIn(fake.ctx, "s1", "marlow", draft(fake.state(), "marlow", { every: "24h" }));
    expect(fake.state().save).toMatchObject({ id: "s1", status: "unknown" });
  });

  it("is failed on a certain refusal and unknown when the answer may have been lost", async () => {
    const refused = fakeGateway({
      patch: () => {
        throw new GatewayProtocolRequestError({
          code: "INVALID_REQUEST",
          message: "invalid config",
        });
      },
    });
    await loadCheckIns(refused.ctx);
    await saveCheckIn(
      refused.ctx,
      "s1",
      "marlow",
      draft(refused.state(), "marlow", { every: "24h" }),
    );
    expect(refused.state().save).toMatchObject({ status: "failed", error: "invalid config" });
    const lost = fakeGateway({
      patch: () => {
        throw new Error("request timeout");
      },
    });
    await loadCheckIns(lost.ctx);
    await saveCheckIn(lost.ctx, "s2", "marlow", draft(lost.state(), "marlow", { every: "24h" }));
    expect(lost.state().save).toMatchObject({ status: "unknown" });
  });

  it("a config changed between the read and the patch is a conflict: the patch carried the hash read, and the save settles before the list is read again", async () => {
    const { gateway, ctx, state, elsewhere } = fakeGateway();
    await loadCheckIns(ctx);
    gateway.before = (method) => {
      if (method === "config.patch") elsewhere((config) => (config.agents.entries.pip = {}));
    };
    let reread: (() => void) | null = null;
    let during: string | undefined;
    gateway.gate = (method) => {
      if (method !== "config.get" || gateway.attempts.length === 0 || reread) return;
      during = state().save?.status;
      return new Promise<void>((resolve) => (reread = resolve));
    };
    const saving = saveCheckIn(ctx, "s1", "marlow", draft(state(), "marlow", { every: "24h" }));
    await until(() => reread !== null);
    expect(during).toBe("conflict");
    reread!();
    await saving;
    expect(gateway.attempts).toEqual([{ baseHash: "h0" }]);
    expect(state().save?.status).toBe("conflict");
    expect(state().status).toBe("ready");
    expect(gateway.patches).toEqual([]);
  });

  it("F-201: a config whose hash is blank is never patched", async () => {
    const { gateway, ctx, state } = fakeGateway();
    await loadCheckIns(ctx);
    gateway.hashText = "  ";
    await saveCheckIn(ctx, "s1", "marlow", draft(state(), "marlow", { every: "24h" }));
    expect(gateway.attempts).toEqual([]);
    expect(state().save).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/version/),
    });
  });

  it("F-201: a prompt-only save for a bot whose own setting is {} is saved only once its job shows the default's cadence", async () => {
    const { gateway, ctx, state } = fakeGateway({
      defaults: { every: "90s" },
      entries: { main: { heartbeat: {} }, marlow: {}, otto: {}, quill: {} },
    });
    await loadCheckIns(ctx);
    expect(
      planCheckIn("main", draft(state(), "main", { prompt: "P. NO_REPLY" }), {
        config: gateway.config,
      }),
    ).toMatchObject({ expect: [{ botId: "main", every: "90s" }] });
    // The gateway never lists main's job.
    gateway.jobs = [];
    await saveCheckIn(ctx, "s1", "main", draft(state(), "main", { prompt: "P. NO_REPLY" }));
    expect(gateway.patches).toHaveLength(1);
    expect(state().save?.status).toBe("unknown");
  });

  it("F-201: confirming a save ends at 20 seconds even while the gateway answers nothing", async () => {
    const fake = fakeGateway();
    await loadCheckIns(fake.ctx);
    let patchedAt = 0;
    let settledAt: number | null = null;
    fake.gateway.before = (method) => {
      if (method === "config.patch") patchedAt = fake.now();
      else if (fake.gateway.patches.length === 1) fake.gateway.stall = true;
      if (settledAt === null && fake.state().save?.status === "unknown") settledAt = fake.now();
    };
    await saveCheckIn(fake.ctx, "s1", "marlow", draft(fake.state(), "marlow", { every: "24h" }));
    expect(fake.state().save?.status).toBe("unknown");
    expect(settledAt! - patchedAt).toBeLessThanOrEqual(20_000);
  });

  it("refuses without admin and while another save is under way", async () => {
    const { ctx, state, setAdmin } = fakeGateway();
    await loadCheckIns(ctx);
    const asked = draft(state(), "main", { every: "1h" });
    setAdmin(false);
    await expect(saveCheckIn(ctx, "s1", "main", asked)).rejects.toThrow(/admin/);
    setAdmin(true);
    ctx.set({ ...state(), save: { id: "s0", botId: "main", status: "saving", error: null } });
    await expect(saveCheckIn(ctx, "s1", "main", asked)).rejects.toThrow(/under way/);
  });
});

it("F-201: state retains a full edit-length prompt even when each code unit needs a JSON escape", () => {
  const prompt = "\u0001".repeat(4_000);
  const settings = [{ botId: "main", every: "30m", prompt, promptCut: false }];
  expect(enforce(CHECK_INS, { settings }).settings).toEqual(settings);
});

describe("F-201 a save across a connection change", () => {
  it("F-201: admin that ends between the read and the patch sends nothing", async () => {
    const { gateway, ctx, state, setAdmin } = fakeGateway();
    await loadCheckIns(ctx);
    gateway.before = (method) => method === "cron.status" && setAdmin(false);
    await saveCheckIn(ctx, "s1", "marlow", draft(state(), "marlow", { every: "24h" }));
    expect(gateway.patches).toEqual([]);
    expect(state().save).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/Admin access ended/),
    });
  });

  it("F-201: a link that reports itself gone between the read and the patch sends nothing on it", async () => {
    const { gateway, ctx, state } = fakeGateway();
    await loadCheckIns(ctx);
    gateway.before = (method) => {
      if (method === "cron.status") gateway.linkAlive = false;
    };
    await saveCheckIn(ctx, "s1", "marlow", draft(state(), "marlow", { every: "24h" }));
    expect(gateway.patches).toEqual([]);
    expect(state().save).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/connection changed/),
    });
  });

  it("F-201: a link that reports itself gone after the patch is not confirmed by anything read later", async () => {
    const { gateway, ctx, state } = fakeGateway();
    await loadCheckIns(ctx);
    gateway.before = (method) => {
      if (gateway.patches.length === 1 && method === "config.get") gateway.linkAlive = false;
    };
    await saveCheckIn(ctx, "s1", "marlow", draft(state(), "marlow", { every: "24h" }));
    expect(gateway.patches).toHaveLength(1);
    expect(state().save).toMatchObject({
      status: "unknown",
      error: expect.stringMatching(/connection changed/),
    });
  });

  it("a read whose link reports itself gone changes nothing on screen", async () => {
    const { gateway, ctx, state } = fakeGateway();
    gateway.before = (method) => {
      if (method === "cron.status") gateway.linkAlive = false;
    };
    ctx.set({ ...emptyLoading });
    await loadCheckIns(ctx);
    expect(state()).toEqual(emptyLoading);
  });
});

const emptyLoading: CheckInsState = {
  status: "loading",
  error: null,
  gatewayId: null,
  scheduler: null,
  jobs: [],
  settings: null,
  defaults: null,
  save: null,
};

function fakeJobs(cfg: Config) {
  const ids = Object.keys(cfg.agents.entries);
  const own = ids.filter((id) => cfg.agents.entries[id]!.heartbeat);
  const defaults = cfg.agents.defaults.heartbeat;
  const system = cfg.agents.defaults.systemAgent?.agentId;
  const enrolled =
    own.length > 0
      ? own
      : defaults?.agentId
        ? [defaults.agentId]
        : defaults
          ? ids
          : system
            ? [system]
            : [];
  return enrolled.map((id) => {
    const ms = durationMs(cfg.agents.entries[id]?.heartbeat?.every ?? defaults?.every ?? "30m")!;
    return {
      agentId: id,
      payload: { kind: "heartbeat" },
      enabled: ms > 0,
      schedule: { kind: "every", everyMs: ms > 0 ? ms : 1_800_000 },
      state: {},
    };
  });
}

describe("F-201 a save across a real connection change", () => {
  /** A client with admin on a gateway whose check-ins are Juniper's default, and whose identity can change. */
  async function adminClient(failIdentity = false) {
    const gateway = grantingGateway();
    const world = { identity: "gw-1", patches: 0 };
    gateway.handlers["agents.list"] = () => ({
      defaultId: "main",
      agents: [
        { id: "main", identity: { name: "Juniper" } },
        { id: "marlow", identity: { name: "Marlow" } },
      ],
    });
    gateway.handlers["gateway.identity.get"] = () => {
      if (failIdentity) {
        failIdentity = false;
        return {};
      }
      return { deviceId: world.identity };
    };
    const entries = (): Config["agents"]["entries"] =>
      world.patches === 0
        ? { main: {}, marlow: {} }
        : { main: { heartbeat: { every: "30m" } }, marlow: { heartbeat: { every: "24h" } } };
    gateway.handlers["config.get"] = () => ({
      hash: `h${world.patches}`,
      config: { agents: { defaults: { heartbeat: { agentId: "main" } }, entries: entries() } },
    });
    gateway.handlers["cron.list"] = () => ({
      jobs: fakeJobs({
        agents: { defaults: { heartbeat: { agentId: "main" } }, entries: entries() },
      }),
      total: world.patches + 1,
      offset: 0,
      snapshotRevision: "r0",
      hasMore: false,
      nextOffset: null,
    });
    gateway.handlers["cron.status"] = () => ({ enabled: false });
    gateway.handlers["config.patch"] = () => {
      world.patches += 1;
      return { ok: true };
    };
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: ADMIN_SCOPES,
        heldScopes: INTERACTIVE_SCOPES,
        adminHeld: true,
      }),
    });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await until(
      () => client.state.discovery.status === "ready" && client.state.connection.canAdmin,
    );
    await client.refreshCheckIns();
    return { client, gateway, world };
  }
  const daily: CheckInDraft = {
    gatewayId: "gw-1",
    every: "24h",
    prompt: null,
    was: { every: null, prompt: null },
    kept: [{ botId: "main", every: "30m" }],
  };

  it("F-201: a failed bootstrap identity read is retried on Refresh", async () => {
    const { client } = await adminClient(true);
    try {
      expect(client.state.connection.gatewayId).toBeNull();
      expect(client.state.checkIns?.gatewayId).toBe("gw-1");
    } finally {
      client.stop();
    }
  });

  it("F-201: a reconnect between the read and the patch sends nothing on the new connection", async () => {
    const { client, gateway, world } = await adminClient();
    expect(client.state.checkIns?.gatewayId).toBe("gw-1");
    gateway.handlers["cron.status"] = () => {
      gateway.handlers["cron.status"] = () => ({ enabled: false });
      gateway.dropAll();
      return { enabled: false };
    };
    await client.saveCheckIn("s1", "marlow", daily);
    expect(client.state.checkIns?.save).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/connection changed/),
    });
    await until(() => client.state.connection.status === "connected");
    expect(world.patches).toBe(0);
    client.stop();
  });

  it("F-201: a draft made on one gateway is never saved to the gateway that answers at the same address after a reconnect", async () => {
    const { client, gateway, world } = await adminClient();
    world.identity = "gw-2";
    gateway.dropAll();
    // Until the new connection says which gateway it is, what is shown belongs to none.
    await until(() => client.state.checkIns?.gatewayId === null);
    await until(
      () => client.state.connection.status === "connected" && client.state.connection.canAdmin,
    );
    await expect(client.saveCheckIn("s1", "marlow", daily)).rejects.toThrow(/another gateway/);
    await client.refreshCheckIns();
    expect(client.state.checkIns?.gatewayId).toBe("gw-2");
    await expect(client.saveCheckIn("s2", "marlow", daily)).rejects.toThrow(/another gateway/);
    expect(world.patches).toBe(0);
    await client.saveCheckIn("s3", "marlow", { ...daily, gatewayId: "gw-2" });
    expect(world.patches).toBe(1);
    client.stop();
  });
});
