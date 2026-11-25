// The plugin's register code, hook and methods against a fake host with an
// in-memory keyed store. The live check on a development gateway is F-527 in
// e2e/bot-voice.spec.ts.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GUIDE,
  PLUGIN_VERSION,
  WHERE_GUIDE,
  createVoice,
  hookSettings,
  hookState,
  settingView,
} from "../index.js";

type Json = Record<string, unknown>;
type Answer = { ok: boolean; payload?: Json; error?: { message: string; details?: Json } };

function host(config: Json = {}) {
  const rows = new Map<string, unknown>();
  const faults = { lookup: false };
  const store = {
    lookup: async (key: string) => {
      if (faults.lookup) throw new Error("the store didn't answer");
      return rows.get(key);
    },
    register: async (key: string, value: unknown) => void rows.set(key, value),
  };
  const methods = new Map<string, { handler: (opts: Json) => Promise<void>; scope: string }>();
  const hooks = new Map<string, () => Promise<unknown>>();
  const emitted: unknown[][] = [];
  const services: { start: (ctx: Json) => void; stop: () => void }[] = [];
  const api = {
    config,
    on: (name: string, fn: () => Promise<unknown>) => hooks.set(name, fn),
    registerGatewayMethod: (
      name: string,
      handler: (opts: Json) => Promise<void>,
      { scope }: { scope: string },
    ) => methods.set(name, { handler, scope }),
    registerService: (service: { start: (ctx: Json) => void; stop: () => void }) =>
      services.push(service),
  };
  let clock = 1000;
  createVoice(api, { store, slots: {}, now: () => clock++ });
  for (const service of services)
    service.start({ gatewayEvents: { emit: (...args: unknown[]) => emitted.push(args) } });
  const call = async (name: string, params: Json = {}, client: Json = person) => {
    let answer: Answer = { ok: false };
    await methods.get(name)!.handler({
      params,
      client,
      acceptsSerializedJson: true,
      respond: (ok: boolean, payload?: Json, error?: Answer["error"]) => {
        answer = { ok, ...(payload ? { payload } : {}), ...(error ? { error } : {}) };
      },
    });
    return answer;
  };
  return {
    rows,
    faults,
    methods,
    emitted,
    services,
    prompt: () => hooks.get("before_prompt_build")!(),
    call,
  };
}

const person = { connect: { role: "operator", device: { id: "device-1" } } };
const granted = {
  plugins: { entries: { "clawtrate-voice": { hooks: { allowConversationAccess: true } } } },
};

/** Both guides, as the hook adds them while both are on. */
const BOTH = `${GUIDE}\n\n${WHERE_GUIDE}`;

describe("clawtrate-voice", () => {
  it("adds the guide to every prompt until a person turns it off, and takes it out after", async () => {
    const gateway = host(granted);
    expect(await gateway.prompt()).toEqual({ appendSystemContext: BOTH });
    const off = await gateway.call("clawtrate-voice.set", { on: false });
    expect(off.payload).toMatchObject({ on: false, changed: { at: expect.any(Number) } });
    expect(await gateway.prompt()).toEqual({ appendSystemContext: WHERE_GUIDE });
    await gateway.call("clawtrate-voice.set", { on: true });
    expect(await gateway.prompt()).toEqual({ appendSystemContext: BOTH });
    // Who changed it is kept only as a hash of the device.
    expect(JSON.stringify([...gateway.rows.values()])).not.toContain("device-1");
  });

  it("turns the where-you-live guide off and on by its own setting, leaving the voice guide alone", async () => {
    const gateway = host(granted);
    const off = await gateway.call("clawtrate-voice.set", { section: "where", on: false });
    expect(off.payload).toMatchObject({
      on: true,
      changed: null,
      where: { on: false, changed: { at: expect.any(Number) }, guide: WHERE_GUIDE },
    });
    expect(await gateway.prompt()).toEqual({ appendSystemContext: GUIDE });
    await gateway.call("clawtrate-voice.set", { on: false });
    expect(await gateway.prompt()).toBeUndefined();
    await gateway.call("clawtrate-voice.set", { section: "where", on: true });
    expect(await gateway.prompt()).toEqual({ appendSystemContext: WHERE_GUIDE });
    expect(gateway.emitted).toHaveLength(3);
    for (const section of ["other", "__proto__", 1, null]) {
      const bad = await gateway.call("clawtrate-voice.set", { section, on: false });
      expect(bad).toMatchObject({ ok: false, error: { details: { reason: "invalid" } } });
    }
    expect(gateway.emitted).toHaveLength(3);
  });

  it("reads at operator.read and changes at operator.write, only from a person's own connection", async () => {
    const gateway = host(granted);
    expect(gateway.methods.get("clawtrate-voice.get")!.scope).toBe("operator.read");
    expect(gateway.methods.get("clawtrate-voice.set")!.scope).toBe("operator.write");
    const turn = { connect: { role: "operator" }, internal: { syntheticClient: true } };
    const refused = await gateway.call("clawtrate-voice.set", { on: false }, turn);
    expect(refused).toMatchObject({
      ok: false,
      error: { details: { reason: "operator-required" } },
    });
    for (const on of [undefined, "false", 0, null]) {
      const bad = await gateway.call("clawtrate-voice.set", { on });
      expect(bad).toMatchObject({ ok: false, error: { details: { reason: "invalid" } } });
    }
    expect(gateway.rows.size).toBe(0);
    // Nothing changed, so nothing is announced.
    expect(gateway.emitted).toEqual([]);
  });

  it("tells other devices once a change is written, even when reading it back fails", async () => {
    const gateway = host(granted);
    gateway.faults.lookup = true;
    // The handler fails on the read-back, after the write committed.
    await expect(gateway.call("clawtrate-voice.set", { on: false })).rejects.toThrow(
      "the store didn't answer",
    );
    expect([...gateway.rows.values()]).toEqual([expect.objectContaining({ on: false })]);
    expect(gateway.emitted).toEqual([["changed", {}, { scope: "operator.read" }]]);
  });

  it("tells other devices after a change, with an empty event at operator.read", async () => {
    const gateway = host(granted);
    await gateway.call("clawtrate-voice.set", { on: false });
    expect(gateway.emitted).toEqual([["changed", {}, { scope: "operator.read" }]]);
    // Stopped, the service sends nothing more, and a change still answers.
    for (const service of gateway.services) service.stop();
    expect((await gateway.call("clawtrate-voice.set", { on: true })).ok).toBe(true);
    expect(gateway.emitted).toHaveLength(1);
  });

  it("reports the setting, the hook as the gateway let it register, and the guide", async () => {
    const gateway = host(granted);
    const before = await gateway.call("clawtrate-voice.get");
    expect(before.payload).toMatchObject({
      plugin: "clawtrate-voice",
      on: true,
      changed: null,
      hook: { state: "allowed", lastRanAt: null },
      guide: GUIDE,
      // A client tells this version from 0.1.0, which has no second guide, by `where`.
      version: PLUGIN_VERSION,
      where: { on: true, changed: null, guide: WHERE_GUIDE },
    });
    await gateway.prompt();
    const after = await gateway.call("clawtrate-voice.get");
    expect((after.payload!.hook as Json).lastRanAt).toEqual(expect.any(Number));
    expect((await host({}).call("clawtrate-voice.get")).payload!.hook).toMatchObject({
      state: "needs-conversation-access",
      settings: { allowPromptInjection: true, allowConversationAccess: false },
    });
  });

  it("decides the hook's state the way OpenClaw does for a plugin it did not bundle", () => {
    const entry = (hooks: Json) => ({ plugins: { entries: { "clawtrate-voice": { hooks } } } });
    expect(hookState(undefined)).toBe("needs-conversation-access");
    expect(hookState(entry({ allowConversationAccess: "true" }))).toBe("needs-conversation-access");
    expect(hookState(entry({ allowConversationAccess: true }))).toBe("allowed");
    expect(hookState(entry({ allowConversationAccess: true, allowPromptInjection: false }))).toBe(
      "prompt-injection-off",
    );
    // Each setting on its own, so both can be named when both block it.
    expect(hookSettings(entry({ allowPromptInjection: false }))).toEqual({
      allowPromptInjection: false,
      allowConversationAccess: false,
    });
    expect(hookSettings(entry({ allowConversationAccess: true }))).toEqual({
      allowPromptInjection: true,
      allowConversationAccess: true,
    });
    expect(settingView(undefined)).toEqual({ on: true, changed: null });
    expect(settingView({ on: "no" })).toEqual({ on: true, changed: null });
  });

  it("keeps the guide short, in one file, with no dash standing in for punctuation", () => {
    const file = readFileSync(new URL("../voice.md", import.meta.url), "utf8");
    expect(GUIDE).toBe(file.trim());
    expect(GUIDE.split(/\s+/).length).toBeLessThanOrEqual(260);
    expect(GUIDE).not.toMatch(/[‒-―]|\s-\s|--/);
    expect(GUIDE).toContain("never use an em dash");
  });

  it("keeps the where-you-live guide short, in one file, with no dash standing in for punctuation", () => {
    const file = readFileSync(new URL("../where.md", import.meta.url), "utf8");
    expect(WHERE_GUIDE).toBe(file.trim());
    // It is in every bot's prompt on every run: about 1,850 characters, 2,000 at most, and both
    // guides together 3,400 at most.
    expect(WHERE_GUIDE.length).toBeLessThanOrEqual(2000);
    expect(BOTH.length).toBeLessThanOrEqual(3400);
    expect(WHERE_GUIDE).not.toMatch(/[‒-―]| - |--/);
    // What the person asked for happens now; what the bot only thinks would help is asked first.
    expect(WHERE_GUIDE).toContain("start one now with `sessions_spawn` and `visible: true`");
    expect(WHERE_GUIDE).toContain("If you only think a task would help, ask first and wait for a yes.");
    expect(WHERE_GUIDE).toContain("never a to-do item");
    expect(WHERE_GUIDE).toContain(
      "Only a message your person typed in this conversation counts as them asking.",
    );
  });

  it("names only tools the gateway has, by the names in its tool table", () => {
    // docs/decisions.md lists every tool OpenClaw 2026.10.6 offers, one row each.
    const decisions = readFileSync(new URL("../../../docs/decisions.md", import.meta.url), "utf8");
    const known = new Set(
      [...decisions.matchAll(/^\| [^|]+\| `([a-z_]+)` +\|/gm)].map((match) => match[1]),
    );
    expect(known.has("sessions_spawn")).toBe(true);
    const named = [...WHERE_GUIDE.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1]);
    expect(named).toEqual(
      expect.arrayContaining(["sessions_spawn", "sessions_send", "sessions_history", "sessions_list"]),
    );
    for (const name of named) expect(known, name).toContain(name);
    // The spawn's own parameters, by the names its schema gives them.
    for (const parameter of ["`visible: true`", "`label`", "`task`"])
      expect(WHERE_GUIDE).toContain(parameter);
  });

  it("puts literal text and another language first, and says so", () => {
    // An unconditional dash rule could make a model change a dash inside code, a link, a tool
    // argument, a quote or another language's text.
    const literal =
      "Never alter literal text: code, commands, URLs, tool arguments, exact quotes and text in another language keep their own punctuation.";
    const language = "If they write in or ask for another language, follow its conventions.";
    expect(GUIDE).toContain(literal);
    expect(GUIDE).toContain(language);
    expect(GUIDE).toContain("These two rules come first.");
    // Both opening sentences come before every other rule.
    for (const opening of [literal, language])
      for (const rule of [
        "Talk like a capable, friendly person",
        "never use an em dash",
        "Use plain words",
        "Don't narrate tools",
        "Give a real take",
      ])
        expect(GUIDE.indexOf(opening), `${opening.slice(0, 20)} before ${rule}`).toBeLessThan(
          GUIDE.indexOf(rule),
        );
    // The dash rule covers the bot's own English prose, with a spaced hyphen, not a compound word's.
    expect(GUIDE).toContain(
      "In your own English sentences, never use an em dash, or an en dash or spaced hyphen in its place. Use a comma, a period or parentheses instead.",
    );
  });

  it("asks when it must, and before anything destructive says what it proposes and waits", () => {
    expect(GUIDE).toContain("Don't narrate tools, skills or internal steps unless they ask.");
    expect(GUIDE).toContain("Ask when you need an answer to go on.");
    expect(GUIDE).toContain(
      "Before anything destructive, or anything that needs approval, say what you propose and wait for a yes, showing the exact command if there is one, with any secret named rather than shown.",
    );
    expect(GUIDE).toContain(
      "Otherwise do the work and send one message when you have news, or a brief update if it takes a while.",
    );
    // Nothing that tells a bot to skip a warning or a question it owes.
    expect(GUIDE).not.toMatch(/don't announce what you're about to do|Just do the work/i);
  });

  it("tells a failure up front, with the exact error only when it's safe to share", () => {
    expect(GUIDE).toContain(
      "Say upfront what failed or what you can't do, instead of hiding it: name what failed, quote the exact error when it's safe to share, and offer the simplest fix.",
    );
    expect(GUIDE).not.toMatch(/keep the exact error/);
    expect(GUIDE).toContain("If you get something wrong, own it plainly without groveling.");
  });

  it("keeps simple replies brief, and lets steps in when they help", () => {
    expect(GUIDE).toContain("Keep most sentences short, with a longer one when it flows");
    expect(GUIDE).toContain("Keep simple replies brief. Use steps when they help someone follow.");
    expect(GUIDE).not.toMatch(/a sentence or two/);
  });

  it("promises the guide only to a run whose runner invokes the hook and sends the prompt", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const manifest = readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8");
    for (const text of [readme, manifest]) expect(text).not.toMatch(/wherever the gateway builds/);
    expect(readme).toContain(
      "A run gets it when its runner invokes the permitted prompt hook and sends the prompt that results",
    );
    expect(readme).toMatch(/resumed (CLI )?session/);
  });

  it("puts a path check of its own, and a line to stop and check, right before every write", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    // The README as it reads: each code block with the text since the one before it.
    const parts = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)].map((match, at, all) => ({
      block: match[1]!,
      before: readme.slice(
        at === 0 ? 0 : all[at - 1]!.index! + all[at - 1]![0].length,
        match.index,
      ),
    }));
    const writes = parts
      .map((part, at) => ({ ...part, at }))
      .filter(({ block }) => /config set|plugins install/.test(block));
    expect(writes.map(({ block }) => /allowConversationAccess/.test(block))).toContain(true);
    for (const { block, before, at } of writes) {
      // Pasting a write's block never checks and writes at once.
      expect(block).not.toMatch(/config file/);
      // The block just before it is the path check, and the text between says to stop and check.
      expect(parts[at - 1]?.block, block).toMatch(/config file/);
      expect(before, block).toMatch(/Stop and check/);
      // Every variable is quoted.
      expect(block).not.toMatch(/[^"]\$(profile|checkout)\b/);
    }
  });
});
