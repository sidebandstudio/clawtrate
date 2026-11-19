// The check-ins engine against a fake gateway that behaves as OpenClaw
// 2026.10.6 was observed to (docs/decisions.md, "Check-ins"): one heartbeat
// job for the default's owner until any bot has its own setting, then one per
// bot with a setting; `every: "0m"` keeps the job, disabled.

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { describe, expect, it } from "vitest";
import {
  checkInPatch,
  keptByDefault,
  loadCheckIns,
  readJobs,
  readSettings,
  saveCheckIn,
  type CheckInsContext,
  type CheckInsState,
} from "../src/index.ts";

const BOTS = ["main", "marlow", "otto"];
type Entries = Record<string, { heartbeat?: { every?: string; prompt?: string } }>;

/** A gateway's config and the heartbeat jobs it derives from it. */
function fakeGateway(options: { patch?: () => never; derive?: boolean } = {}) {
  const gateway = { entries: {} as Entries, patches: [] as unknown[], hash: "h0" };
  const jobs = () => {
    const own = BOTS.filter((bot) => gateway.entries[bot]?.heartbeat);
    if (own.length === 0)
      return [{ agentId: "main", enabled: true, schedule: { kind: "every", everyMs: 1_800_000 } }];
    return own.map((bot) => {
      const every = gateway.entries[bot]!.heartbeat!.every ?? "30m";
      const ms = Number(every.slice(0, -1)) * (every.endsWith("h") ? 3_600_000 : 60_000);
      return {
        agentId: bot,
        enabled: ms > 0,
        schedule: { kind: "every", everyMs: ms > 0 ? ms : 86_400_000 },
        state: ms > 0 ? { nextRunAtMs: 1_000 } : {},
      };
    });
  };
  const request = async (method: string, params: unknown): Promise<unknown> => {
    const p = params as { raw?: string };
    switch (method) {
      case "cron.list":
        return {
          jobs: [
            { agentId: "otto", payload: { kind: "agentTurn" }, enabled: true },
            ...(options.derive === false ? [] : jobs()).map((job) => ({
              ...job,
              payload: { kind: "heartbeat" },
            })),
          ],
        };
      case "cron.status":
        return { enabled: false };
      case "config.get":
        return { hash: gateway.hash, config: { agents: { entries: gateway.entries } } };
      case "config.patch": {
        if (options.patch) options.patch();
        const patch = JSON.parse(p.raw!) as { agents: { entries: Entries } };
        gateway.patches.push(patch);
        for (const [bot, entry] of Object.entries(patch.agents.entries)) {
          const heartbeat = { ...gateway.entries[bot]?.heartbeat, ...entry.heartbeat };
          if ((heartbeat as { prompt?: unknown }).prompt === null) delete heartbeat.prompt;
          gateway.entries[bot] = { ...gateway.entries[bot], heartbeat };
        }
        gateway.hash = `h${gateway.patches.length}`;
        return { ok: true };
      }
    }
    throw new Error(`unexpected ${method}`);
  };
  let state: CheckInsState | undefined;
  let now = 0;
  const ctx: CheckInsContext = {
    request,
    get: () => state,
    set: (next) => (state = next),
    botIds: () => BOTS,
    admin: () => true,
    generation: () => 1,
    now: () => now,
    sleep: async (ms) => void (now += ms),
  };
  return { gateway, ctx, state: () => state! };
}

describe("reading check-ins", () => {
  it("keeps one heartbeat job per listed bot and nothing else", () => {
    const jobs = readJobs(
      {
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
          { agentId: "stranger", payload: { kind: "heartbeat" }, enabled: true },
        ],
      },
      BOTS,
    );
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

  it("reads the jobs, the scheduler and the settings", () => {
    const { ctx, state } = fakeGateway();
    return loadCheckIns(ctx).then(() => {
      expect(state()).toMatchObject({ status: "ready", scheduler: false, settings: [] });
      expect(state().jobs.map((job) => job.botId)).toEqual(["main"]);
    });
  });
});

describe("F-201 the patch a save writes", () => {
  const defaultJob = { botId: "main", enabled: true, everyMs: 1_800_000, nextRunAtMs: null };

  it("keeps a bot that checks in through the default, at its cadence", () => {
    expect(checkInPatch("marlow", { every: "24h", prompt: null }, [defaultJob], [])).toEqual({
      agents: {
        entries: { marlow: { heartbeat: { every: "24h" } }, main: { heartbeat: { every: "30m" } } },
      },
    });
    expect(keptByDefault("marlow", [defaultJob], [])).toEqual(["main"]);
  });

  it("leaves a bot with a setting of its own alone, and clears an empty prompt", () => {
    const settings = [{ botId: "main", every: "30m", prompt: null, promptCut: false }];
    expect(checkInPatch("marlow", { every: "0m", prompt: "" }, [defaultJob], settings)).toEqual({
      agents: { entries: { marlow: { heartbeat: { every: "0m", prompt: null } } } },
    });
    expect(keptByDefault("marlow", [defaultJob], settings)).toEqual([]);
    expect(keptByDefault("marlow", [defaultJob], null)).toEqual([]);
  });
});

describe("F-201 F-366 saving", () => {
  it("F-201: saving one bot keeps the default bot's check-ins, and is saved once the job shows it", async () => {
    const { gateway, ctx, state } = fakeGateway();
    await loadCheckIns(ctx);
    await saveCheckIn(ctx, "s1", "marlow", { every: "24h", prompt: null });
    expect(gateway.patches).toHaveLength(1);
    expect(state().save).toMatchObject({ id: "s1", status: "saved" });
    expect(state().jobs.map((job) => [job.botId, job.enabled, job.everyMs])).toEqual([
      ["main", true, 1_800_000],
      ["marlow", true, 86_400_000],
    ]);
  });

  it("F-366: Off writes every 0m and is saved only when the bot's job is disabled", async () => {
    const { gateway, ctx, state } = fakeGateway();
    await saveCheckIn(ctx, "s1", "main", { every: "0m", prompt: null });
    expect(gateway.entries.main?.heartbeat?.every).toBe("0m");
    expect(state().save?.status).toBe("saved");
    expect(state().jobs).toEqual([
      { botId: "main", enabled: false, everyMs: 86_400_000, nextRunAtMs: null },
    ]);
  });

  it("is unknown, not saved, when the job never shows the change", async () => {
    const { ctx, state } = fakeGateway({ derive: false });
    await saveCheckIn(ctx, "s1", "marlow", { every: "24h", prompt: null });
    expect(state().save).toMatchObject({ id: "s1", status: "unknown" });
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
    await saveCheckIn(refused.ctx, "s1", "marlow", { every: "24h", prompt: null });
    expect(refused.state().save).toMatchObject({ status: "failed", error: "invalid config" });
    const lost = fakeGateway({
      patch: () => {
        throw new Error("request timeout");
      },
    });
    await saveCheckIn(lost.ctx, "s2", "marlow", { every: "24h", prompt: null });
    expect(lost.state().save).toMatchObject({ status: "unknown" });
  });

  it("does not write a prompt it could only keep cut", async () => {
    const { gateway, ctx } = fakeGateway();
    gateway.entries.marlow = { heartbeat: { every: "1h", prompt: "x".repeat(5_000) } };
    await saveCheckIn(ctx, "s1", "marlow", { every: "2h", prompt: "x".repeat(4_000) });
    expect(gateway.entries.marlow.heartbeat?.prompt).toHaveLength(5_000);
  });

  it("refuses without admin and while another save is under way", async () => {
    const { ctx } = fakeGateway();
    await expect(
      saveCheckIn({ ...ctx, admin: () => false }, "s1", "main", { every: "1h", prompt: null }),
    ).rejects.toThrow(/admin/);
    ctx.set({
      status: "ready",
      error: null,
      scheduler: null,
      jobs: [],
      settings: [],
      save: { id: "s0", botId: "main", every: "1h", status: "saving", error: null },
    });
    await expect(saveCheckIn(ctx, "s1", "main", { every: "2h", prompt: null })).rejects.toThrow(
      /under way/,
    );
  });
});
