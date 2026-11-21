import { describe, expect, it } from "vitest";
import { setHooks, withScheduler } from "../src/routine-gateway.ts";
import { addScriptedRoutines, SCRIPTED_ROUTINES } from "../src/routines.ts";
import { SCENARIOS } from "../src/scenarios.ts";
import { SEED_BOTS } from "../src/seed-data.ts";

describe("the scripted routines", () => {
  it("run seeded bots, keep results with the run, and ask for scenarios the scripted model plays", () => {
    const directives = new Set(SCENARIOS.map((scenario) => scenario.name));
    for (const routine of SCRIPTED_ROUTINES) {
      expect(SEED_BOTS.some((bot) => bot.id === routine.agentId)).toBe(true);
      expect(routine.delivery).toEqual({ mode: "none" });
      const named = [...routine.payload.message.matchAll(/#([a-z-]+)/gu)].map((match) => match[1]!);
      expect(named.length).toBeGreaterThan(0);
      for (const directive of named) expect(directives.has(directive)).toBe(true);
    }
  });

  it("are added once: a routine the gateway lists by name is kept", async () => {
    const calls: string[] = [];
    const ids = await addScriptedRoutines(async (method, params) => {
      calls.push(method);
      if (method === "cron.list") return { jobs: [{ id: "kept", name: "Morning digest" }] };
      return { id: `new:${(params as { name: string }).name}` };
    });
    expect(ids).toEqual(["kept", "new:Weekly backup check"]);
    expect(calls).toEqual(["cron.list", "cron.add"]);
  });
});

describe("the routine-editing settings", () => {
  it("turn the scheduler on for a check and off again even when the check fails", async () => {
    const patches: string[] = [];
    let on = false;
    const call = async (method: string, params: unknown) => {
      if (method === "config.get") return { hash: "h1", config: {} };
      if (method === "cron.status") return { enabled: on };
      if (method === "config.patch") {
        const { raw, baseHash } = params as { raw: string; baseHash: string };
        patches.push(`${raw} ${baseHash}`);
        on = (JSON.parse(raw) as { cron: { enabled: boolean } }).cron.enabled;
      }
      return {};
    };
    await expect(
      withScheduler(call, () => {
        expect(on).toBe(true);
        return Promise.reject(new Error("check failed"));
      }),
    ).rejects.toThrow("check failed");
    expect(on).toBe(false);
    expect(patches).toEqual(['{"cron":{"enabled":true}} h1', '{"cron":{"enabled":false}} h1']);
  });

  it("give hooks a fresh token when turned on, and none when turned off", async () => {
    const raws: Array<{ hooks: Record<string, unknown> }> = [];
    const call = async (method: string, params: unknown) => {
      if (method === "config.patch") raws.push(JSON.parse((params as { raw: string }).raw));
      if (method === "config.get") return { config: { hooks: raws.at(-1)?.hooks } };
      return {};
    };
    const token = await setHooks(call, true);
    expect(token).toMatch(/^[\w-]{32}$/u);
    expect(raws[0]).toEqual({ hooks: { enabled: true, token, path: "/hooks" } });
    expect(await setHooks(call, false)).toBeNull();
    expect(raws[1]).toEqual({ hooks: { enabled: false } });
  });
});
