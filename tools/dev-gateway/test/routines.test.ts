import { describe, expect, it } from "vitest";
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
