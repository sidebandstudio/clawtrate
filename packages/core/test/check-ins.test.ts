// The check-ins engine against a fake gateway that enrolls bots by OpenClaw
// 2026.10.6's rules (docs/decisions.md, "Check-ins"): bots with a heartbeat of
// their own, else the default's `agentId`, else every bot when a default block
// exists; a bot's cadence is its own `every`, else the default's, else 30m;
// `every: "0m"` keeps the job, disabled. Its jobs come one per page, and what
// it derives can be held back to see what the engine says meanwhile.

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { describe, expect, it } from "vitest";
import {
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
    defaults: { heartbeat?: Heartbeat };
    entries: Record<string, { heartbeat?: Heartbeat }>;
  };
};

const parse = (every: string) =>
  Number(every.slice(0, -1)) *
  (every.endsWith("h") ? 3_600_000 : every.endsWith("s") ? 1_000 : 60_000);

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
    hash: 0,
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
      jobs: fakeJobs(gateway.config),
    };
  const request = async (method: string, params: unknown): Promise<unknown> => {
    gateway.before(method);
    const p = params as { raw?: string; baseHash?: string; offset?: number };
    switch (method) {
      case "cron.list": {
        const all = [
          { agentId: "otto", payload: { kind: "agentTurn" }, enabled: true },
          ...view().jobs,
        ];
        const offset = p.offset ?? 0;
        const more = offset + 1 < all.length;
        return {
          jobs: all.slice(offset, offset + 1),
          hasMore: more,
          nextOffset: more ? offset + 1 : null,
        };
      }
      case "cron.status":
        return { enabled: false };
      case "config.get":
        return { hash: `h${gateway.hash}`, config: view().config };
      case "config.patch": {
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
  const ctx: CheckInsContext = {
    link: () => {
      gateway.linkAlive = true;
      const alive = () => gateway.linkAlive;
      return {
        alive,
        request: (method, params) =>
          alive()
            ? request(method, params)
            : Promise.reject(Object.assign(new Error("not sent"), { name: "NotSentError" })),
      };
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

  it("finds who checks in through the default by the gateway's four rules", () => {
    const config = (defaults: unknown, entries: unknown) => ({
      config: { agents: { defaults: { heartbeat: defaults }, entries } },
    });
    const entries = { main: {}, marlow: {}, quill: {} };
    expect(readDefaults(config({ agentId: "Main" }, entries), []).inherited).toEqual(["main"]);
    expect(readDefaults(config({ every: "90s" }, entries), [])).toMatchObject({
      inherited: ["main", "marlow", "quill"],
      every: "90s",
    });
    expect(
      readDefaults(config({}, { ...entries, marlow: { heartbeat: {} } }), []).inherited,
    ).toEqual([]);
    const ambient = [{ botId: "main", enabled: true, everyMs: 1_800_000, nextRunAtMs: null }];
    expect(readDefaults(config(undefined, entries), ambient)).toMatchObject({
      inherited: ["main"],
      every: "30m",
      prompt: null,
    });
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

  it("F-201: a prompt for a bot that does not check in keeps it off, and clearing a prompt removes it", () => {
    const snapshot = {
      config: {
        config: { agents: { entries: { otto: {}, main: { heartbeat: { prompt: "P" } } } } },
      },
      settings: [{ botId: "main", every: null, prompt: "P", promptCut: false }],
      defaults: {
        inherited: [],
        inheritedCut: false,
        every: "30m",
        prompt: null,
        promptCut: false,
      },
    };
    const was = { every: null, prompt: null };
    expect(
      planCheckIn("otto", { every: null, prompt: "Q", was, kept: [] }, snapshot),
    ).toMatchObject({
      patch: { agents: { entries: { otto: { heartbeat: { every: "0m", prompt: "Q" } } } } },
    });
    expect(
      planCheckIn(
        "main",
        { every: null, prompt: "", was: { every: null, prompt: "P" }, kept: [] },
        snapshot,
      ),
    ).toMatchObject({ patch: { agents: { entries: { main: { heartbeat: { prompt: null } } } } } });
    expect(planCheckIn("otto", { every: null, prompt: null, was, kept: [] }, snapshot)).toEqual({
      patch: null,
      own: {},
      expect: [],
    });
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

  it("F-366: Off writes every 0m and is saved only when the bot's job is disabled", async () => {
    const { gateway, ctx, state } = fakeGateway();
    await loadCheckIns(ctx);
    await saveCheckIn(ctx, "s1", "main", draft(state(), "main", { every: "0m" }));
    expect(gateway.patches).toHaveLength(1);
    expect(gateway.config.agents.entries.main?.heartbeat?.every).toBe("0m");
    expect(state().save?.status).toBe("saved");
    expect(state().jobs).toEqual([
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

  it("a config changed between the read and the patch is a conflict, sent with the hash it read", async () => {
    const { gateway, ctx, state, elsewhere } = fakeGateway();
    await loadCheckIns(ctx);
    gateway.before = (method) => {
      if (method === "config.patch") elsewhere((config) => (config.agents.entries.pip = {}));
    };
    await saveCheckIn(ctx, "s1", "marlow", draft(state(), "marlow", { every: "24h" }));
    expect(state().save?.status).toBe("conflict");
    expect(gateway.patches).toEqual([]);
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

  it("F-201: a reconnect or another gateway between the read and the patch sends nothing on the new connection", async () => {
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

  it("F-201: a connection that ends after the patch is not confirmed by anything read later", async () => {
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

  it("a read that ends after its connection did changes nothing on screen", async () => {
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
  const enrolled =
    own.length > 0 ? own : defaults?.agentId ? [defaults.agentId] : defaults ? ids : [];
  return enrolled.map((id) => {
    const ms = parse(cfg.agents.entries[id]?.heartbeat?.every ?? defaults?.every ?? "30m");
    return {
      agentId: id,
      payload: { kind: "heartbeat" },
      enabled: ms > 0,
      schedule: { kind: "every", everyMs: ms > 0 ? ms : 1_800_000 },
      state: {},
    };
  });
}
