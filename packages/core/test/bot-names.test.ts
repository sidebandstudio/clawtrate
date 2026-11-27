// A bot that takes a name in the chat (F-552): the name it writes on its IDENTITY.md's
// `- Name:` line is applied at once by one device, kept in the record of changes on the gateway
// (`users.prefs`), and shown with Undo. The answers are as a development gateway gave them on
// OpenClaw 2026.10.6 and 2026.11.10: `agents.files.get` needs read, `agents.update` admin and
// stores a name with its runs of space collapsed, and `users.prefs.set` is a compare-and-set of
// one value of at most 4,096 bytes that any of the person's paired devices can replace.

import { describe, expect, it } from "vitest";
import { identityFile } from "../src/accounts-engine.ts";
import {
  BotNames,
  type BotNamesContext,
  canUndoName,
  CLAIM_EXPIRY_MS,
  dayOf,
  fitNameRecord,
  identityName,
  judgeRename,
  MAX_BOT_NAME_CHARS,
  MAX_RECORD_BYTES,
  MAX_RECORD_CHANGES,
  NAME_RECORD_KEY,
  namesInText,
  parseNameRecord,
  plainName,
  runTag,
  settled,
  shownChanges,
  UNDO_WINDOW_MS,
  type RunFacts,
  type RunStepFacts,
} from "../src/bot-names.ts";
import { utf8Length } from "../src/encoding.ts";
import { ADMIN_SCOPES } from "../src/scopes.ts";
import type { Bot, GatewayStamp, NameLine, NameRecordChange } from "../src/types.ts";
import { agentEvent, grantingGateway, openTask, URL_A } from "./client-harness.ts";
import { deferred, guidesOff, memoryStorage, tokenKey, until } from "./fake-gateway.ts";

const NOW = 1_795_000_000_000;
const KEY = "agent:pip:main";
const STAMP: GatewayStamp = { gatewayId: "gw-a", target: 1 };
/** A direction override, which a name may not carry. */
const RLO = String.fromCharCode(0x202e);
const FILE_TAG = runTag("- **Name:** Juniper\n");
const bot = (id: string, name: string): Bot => ({
  id,
  name,
  emoji: null,
  avatarUrl: null,
  theme: null,
  model: null,
  isDefault: false,
});
const READ_OWN: RunStepFacts = { toolName: "read", args: '{"path":"IDENTITY.md"}', ok: true };
const EDIT_OWN: RunStepFacts = {
  toolName: "edit",
  args: '{"path":"IDENTITY.md","edits":[]}',
  ok: true,
};
const step = (toolName: string, args = "{}"): RunStepFacts => ({ toolName, args, ok: true });
const change = (patch: Partial<NameRecordChange> = {}): NameRecordChange => ({
  bot: "pip",
  field: "name",
  from: "Pip",
  to: "Juniper",
  at: NOW - 1_000,
  run: runTag("run-1"),
  whose: "person",
  source: null,
  file: FILE_TAG,
  ...patch,
});
const record = (patch: Record<string, unknown> = {}) => ({
  rev: 1,
  changes: [],
  declined: [],
  counts: [],
  claims: [],
  ...patch,
});

describe("F-552: whose ask a rename was", () => {
  const facts: RunFacts = {
    sentHere: true,
    text: "call yourself Juniper",
    attachments: false,
    steered: false,
    steps: [EDIT_OWN],
  };
  const judge = (patch: Partial<RunFacts>, name = "Juniper") =>
    judgeRename({ ...facts, ...patch }, name);

  it("F-552: the person's own ask only when every condition holds, each failing in turn", () => {
    expect(judge({})).toEqual({ whose: "person", source: null });
    expect(judge({ sentHere: false })).toEqual({ whose: "bot", source: null });
    expect(judge({ attachments: true })).toEqual({ whose: "bot", source: "attachment" });
    expect(judge({ steered: true })).toEqual({ whose: "bot", source: null });
    expect(judge({ text: "you choose a name" }).whose).toBe("bot");
    expect(judge({ steps: [step("web_fetch"), EDIT_OWN] })).toEqual({
      whose: "bot",
      source: "web",
    });
  });

  it("F-552: the name must be in the person's message as whole words, compared as names are", () => {
    expect(judge({ text: "call yourself   JUNIPER!" }).whose).toBe("person");
    expect(judge({ text: "call yourself Junipers" }).whose).toBe("bot");
    expect(judge({ text: "the junipersaurus" }).whose).toBe("bot");
    expect(namesInText("is Pippa there", "Pip")).toBe(false);
    expect(namesInText("Pip, then Pippa", "Pip")).toBe(true);
    expect(namesInText("name it Café Noir.", "café   noir")).toBe(true);
    // A hyphen joins words; a name with one is matched whole.
    expect(namesInText("my juniper-berry", "Juniper")).toBe(false);
    expect(namesInText("call yourself Juniper-Rose", "Juniper-Rose")).toBe(true);
    expect(namesInText("call yourself Juniper!", "Juniper")).toBe(true);
    // A message cut where the device stopped keeping it: its end is no word's end.
    expect(namesInText("call yourself Juniper", "Juniper", true)).toBe(false);
    expect(namesInText("call yourself Juniper! and", "Juniper", true)).toBe(true);
    expect(judge({ text: "call yourself Juniper", cut: true }).whose).toBe("bot");
  });

  it("F-552: reading the bot's own IDENTITY.md counts as reading a file, before the edit too", () => {
    expect(judge({ steps: [READ_OWN, EDIT_OWN] })).toEqual({ whose: "bot", source: "file" });
  });

  it("F-552: with no successful write of the bot's own file seen, the name is the file's, never the bot renaming itself", () => {
    for (const steps of [
      null,
      [],
      [READ_OWN],
      [{ ...EDIT_OWN, ok: false }],
      [step("edit", '{"path":"notes/IDENTITY.md"}')],
      [step("edit", '{"path":"notes.md","edits":[{"newText":"IDENTITY.md"}]}')],
    ])
      expect(judge({ steps }), JSON.stringify(steps)).toEqual({ whose: "file", source: null });
  });

  it("F-552: what counts as outside content before the last write, and what doesn't", () => {
    const before = (first: RunStepFacts) => judge({ steps: [first, EDIT_OWN] });
    expect(before(step("browser_navigate")).source).toBe("web");
    expect(before(step("read", '{"path":"notes/page.md"}')).source).toBe("file");
    expect(before(step("edit", '{"path":"notes.md"}')).source).toBe("file");
    expect(before(step("sessions_history")).source).toBe("conversation");
    expect(before(step("sessions_send")).source).toBe("conversation");
    expect(before(step("subagents")).source).toBe("conversation");
    expect(before(step("exec")).source).toBe("tool");
    expect(before(step("some_new_tool")).source).toBe("tool");
    for (const quiet of ["ask_user", "progress_card", "sessions_spawn", "clawtrate_bots"])
      expect(before(step(quiet)).whose, quiet).toBe("person");
    // A reasoning step has no tool.
    expect(before({ toolName: null, args: null, ok: true }).whose).toBe("person");
    // The last write is the one judged: an earlier edit of the file, then a web read, then the edit.
    expect(judge({ steps: [EDIT_OWN, step("web_fetch"), EDIT_OWN] }).whose).toBe("bot");
    // A step after the last write isn't before it.
    expect(judge({ steps: [EDIT_OWN, step("web_search")] }).whose).toBe("person");
    const patch = step(
      "apply_patch",
      JSON.stringify({ input: "*** Begin Patch\n*** Update File: IDENTITY.md\n" }),
    );
    expect(judge({ steps: [patch] }).whose).toBe("person");
  });
});

describe("F-552: the record of changes", () => {
  it("F-552: a forged or malformed entry offers nothing: a name before a rename couldn't set, another field, a bad tag, too old, in the future", () => {
    const forged: Array<[string, Partial<NameRecordChange> | string]> = [
      ["another field", { field: "instructions" as "name" }],
      ["a direction override", { from: `Pip${RLO}` }],
      ["over 40 characters", { from: "x".repeat(MAX_BOT_NAME_CHARS + 1) }],
      // Both gateway versions collapse the spaces, so Undo couldn't put it back as it is.
      ["doubled spaces", { from: "Pip  the  First" }],
      ["a new name over 40", { to: "x".repeat(MAX_BOT_NAME_CHARS + 1) }],
      ["no change", { from: "Juniper" }],
      ["a bad run tag", { run: "zz" }],
      ["a bad file tag", { file: "nope" }],
      ["an unknown classification", { whose: "admin" as "person" }],
      ["too old", { at: NOW - UNDO_WINDOW_MS - 1 }],
      ["in the future", { at: NOW + 60 * 60 * 1000 }],
      ["a done time no date can hold", { done: 1e300 }],
      ["an undone time no date can hold", { undone: -1e300 }],
      ["not an entry", "not an entry"],
    ];
    for (const [what, patch] of forged)
      expect(
        parseNameRecord(
          record({ changes: [typeof patch === "string" ? patch : change(patch)] }),
          NOW,
        ).changes,
        what,
      ).toEqual([]);
    const parsed = parseNameRecord(
      record({
        rev: 3,
        changes: [change()],
        declined: [
          { bot: "pip", name: "Maple", file: FILE_TAG, at: NOW },
          { bot: "pip", name: "Maple", file: FILE_TAG, at: NOW - UNDO_WINDOW_MS - 1 },
          { bot: "pip", name: "Maple", at: NOW },
        ],
        claims: [
          { bot: "pip", op: "b".repeat(16), run: runTag("run-1"), at: NOW },
          { bot: "pip", op: "short", run: runTag("run-1"), at: NOW },
        ],
      }),
      NOW,
    );
    expect(parsed.rev).toBe(3);
    expect(parsed.changes).toEqual([change()]);
    expect(parsed.declined).toEqual([{ bot: "pip", name: "Maple", file: FILE_TAG, at: NOW }]);
    expect(parsed.claims).toEqual([
      { bot: "pip", op: "b".repeat(16), run: runTag("run-1"), at: NOW },
    ]);
    expect(parseNameRecord("junk", NOW)).toEqual({
      rev: 0,
      changes: [],
      declined: [],
      counts: [],
      claims: [],
    });
  });

  it("F-552: the record keeps the newest entries that fit the gateway's 4,096 bytes, and every claim", () => {
    const crab = String.fromCodePoint(0x1f980);
    const long = crab.repeat(MAX_BOT_NAME_CHARS);
    const changes = Array.from({ length: 12 }, (_, n) =>
      change({
        bot: "b".repeat(128),
        from: long,
        to: `${crab.repeat(MAX_BOT_NAME_CHARS - 2)}${n}`,
        run: runTag(`r${n}`),
      }),
    );
    const claims = [{ bot: "pip", op: "c".repeat(16), run: runTag("r11"), at: NOW }];
    const fitted = fitNameRecord({ rev: 1, changes, declined: [], counts: [], claims });
    expect(utf8Length(JSON.stringify(fitted))).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    expect(fitted.changes.length).toBeLessThan(MAX_RECORD_CHANGES);
    expect(fitted.changes.at(-1)).toEqual(changes.at(-1));
    expect(fitted.claims).toEqual(claims);
  });

  it("F-552: Undo is offered only for the latest change of a bot still called what it made it, not undone, within seven days, putting back no other bot's name", () => {
    const bots = [bot("pip", "Juniper"), bot("otto", "Otto")];
    expect(canUndoName(change(), [change()], bots, NOW)).toBe(true);
    expect(canUndoName(change(), [change()], [bot("pip", "Maple")], NOW)).toBe(false);
    expect(canUndoName(change({ undone: NOW }), [change()], bots, NOW)).toBe(false);
    const later = change({ run: runTag("run-2"), from: "Juniper", to: "Juniper" });
    expect(canUndoName(change(), [change(), later], bots, NOW)).toBe(false);
    expect(canUndoName(change(), [change()], bots, NOW + UNDO_WINDOW_MS + 1)).toBe(false);
    // A forged name before that another bot has, compared as names are.
    const otto = change({ from: "OTTO" });
    expect(canUndoName(otto, [otto], bots, NOW)).toBe(false);
  });
});

/** A gateway's answers for the engine: one bot file, the bot list and the shared record. */
function gateway(options: { prefs?: "ok" | "none"; file?: string } = {}) {
  const state = {
    /** The time every device reads. */
    now: NOW,
    bots: [bot("pip", "Pip"), bot("otto", "Otto")],
    file: options.file ?? "- **Name:** Juniper\n",
    record: undefined as unknown,
    updates: [] as string[],
    /** Runs before the next `users.prefs.set` compares: another device's write, say. */
    meddle: null as null | (() => void),
    /** Runs after the next `users.prefs.set` is stored, before its answer arrives. */
    afterSet: null as null | (() => void),
    /**
     * How the next `agents.update` ends: refused (nothing written), written with its answer lost,
     * or lost before it was written.
     */
    update: "ok" as "ok" | "refused" | "lost" | "dropped",
    /** The next `agents.update` arrives, says so, and waits for this before it lands. */
    hold: null as null | Promise<void>,
    onUpdate: null as null | (() => void),
    /** How the gateway stores a name: runs of space collapsed and trimmed, as both versions do. */
    store: (name: string) => name.replace(/\s+/g, " ").trim(),
    /** `users.prefs.set` answers with an error from now on. */
    prefsDown: false,
    /** Every `users.prefs.set` the gateway was sent. */
    sets: 0,
    /** From this `users.prefs.set` on, the store refuses writes. */
    downAt: null as number | null,
    /** Every `agents.files.get` the gateway was sent. */
    reads: 0,
  };
  const request = async (method: string, raw: unknown): Promise<unknown> => {
    const params = raw as Record<string, unknown>;
    if (method === "agents.files.get") {
      state.reads += 1;
      return { file: { content: state.file, hash: "a".repeat(64) } };
    }
    if (method === "config.get") return { config: {} };
    if (method === "agents.update") {
      state.onUpdate?.();
      state.onUpdate = null;
      const hold = state.hold;
      state.hold = null;
      if (hold) await hold;
      if (state.update === "refused") throw new Error("refused");
      if (state.update === "dropped") throw new Error("no answer");
      const name = state.store(String(params.name));
      state.updates.push(name);
      state.bots = state.bots.map((b) => (b.id === params.agentId ? { ...b, name } : b));
      if (state.update === "lost") throw new Error("no answer");
      return { ok: true };
    }
    if (options.prefs === "none") return { status: "no_durable_identity" };
    if (method === "users.prefs.get")
      return {
        status: "ok",
        entries: state.record === undefined ? {} : { [NAME_RECORD_KEY]: state.record },
      };
    if (method === "users.prefs.set") {
      state.sets += 1;
      if (state.downAt !== null && state.sets >= state.downAt) state.prefsDown = true;
      if (state.prefsDown) return { status: "error" };
      state.meddle?.();
      state.meddle = null;
      const expected = (params.expectedEntries as Record<string, unknown>)[NAME_RECORD_KEY];
      if (JSON.stringify(expected ?? null) !== JSON.stringify(state.record ?? null))
        return { status: "conflict" };
      state.record = (params.entries as Record<string, unknown>)[NAME_RECORD_KEY];
      state.afterSet?.();
      state.afterSet = null;
      return { status: "ok" };
    }
    throw new Error(`unexpected ${method}`);
  };
  /** The record as stored, read as a device reads it. */
  const kept = () => parseNameRecord(state.record, state.now);
  return { state, request, kept };
}

/** One device's engine on that gateway. */
function device(
  gw: ReturnType<typeof gateway>,
  options: {
    admin?: boolean;
    steps?: RunStepFacts[] | null;
    steered?: boolean;
    claim?: () => Promise<void>;
    stamp?: () => GatewayStamp;
    generation?: () => string;
    /** The bot list as last read: it changes only when the engine reads it again. */
    cached?: boolean;
  } = {},
) {
  let lines: NameLine[] = [];
  let listed = gw.state.bots;
  /** File reads held now. */
  let slots = 0;
  const published: NameLine[][] = [];
  let shown: { changes: NameRecordChange[] } | null = null;
  const ctx: BotNamesContext = {
    request: gw.request,
    bots: () => (options.cached ? listed : gw.state.bots),
    canRename: () => options.admin ?? true,
    stamp: options.stamp ?? (() => STAMP),
    generation: options.generation ?? (() => "1:1"),
    sameGateway: async () => {},
    storage: memoryStorage(),
    takeRead: () => {
      slots += 1;
      let held = true;
      return () => {
        if (held) slots -= 1;
        held = false;
      };
    },
    refreshBots: async () => {
      listed = gw.state.bots;
    },
    readHistory: async () => {},
    runFacts: () => ({
      steps: options.steps === undefined ? [EDIT_OWN] : options.steps,
      steered: options.steered ?? false,
    }),
    missingScope: () => false,
    certainRefusal: (error) => error instanceof Error && error.message === "refused",
    now: () => gw.state.now,
    waitToClaim: options.claim ?? (async () => {}),
    publishLines: (each) => {
      lines = each;
      published.push(each);
    },
    publishRecord: (each) => (shown = each),
    log: () => {},
  };
  const engine = new BotNames(ctx);
  const line = () => lines.find((each) => each.botId === "pip");
  return {
    engine,
    ctx,
    lines: () => lines,
    line,
    published,
    record: () => shown,
    slots: () => slots,
  };
}

/** Whether a device shows a line for the bot's current name with an Undo that can work. */
const undoable = (d: ReturnType<typeof device>, gw: ReturnType<typeof gateway>) => {
  const line = d.line();
  const changes = d.record()?.changes ?? [];
  const entry = changes.find((each) => each.run === line?.run);
  return (
    line?.status === "renamed" &&
    line.to === gw.state.bots[0]!.name &&
    !!entry &&
    entry.from === line.from &&
    canUndoName(entry, changes, gw.state.bots, gw.state.now)
  );
};

describe("F-552: a bot that takes a name is renamed, with Undo", () => {
  it("F-552: the person's ask is renamed at once, recorded with the name before, counted once confirmed, and the line says so", async () => {
    const gw = gateway();
    const me = device(gw);
    me.engine.sent(KEY, "run-1", "call yourself Juniper");
    await me.engine.afterRun("pip", KEY, "run-1");
    expect(gw.state.updates).toEqual(["Juniper"]);
    expect(me.line()).toMatchObject({ from: "Pip", to: "Juniper", whose: "person" });
    expect(me.line()!.status).toBe("renamed");
    const kept = gw.kept();
    expect(kept.changes).toEqual([change({ at: NOW, done: NOW })]);
    expect(kept.counts).toEqual([{ bot: "pip", day: dayOf(NOW), n: 1 }]);
    expect(kept.claims).toEqual([]);
  });

  it("F-552: a run this device didn't send waits before it applies, and is the bot's own doing", async () => {
    const gw = gateway();
    let waited = false;
    const other = device(gw, {
      claim: async () => {
        waited = true;
      },
    });
    await other.engine.afterRun("pip", KEY, "run-1");
    expect(waited).toBe(true);
    expect(other.line()).toMatchObject({ whose: "bot", status: "renamed" });
  });

  it("F-552: with two devices open, the one that sent the run applies it, and the other shows the sender's line from the record", async () => {
    const gw = gateway();
    const sender = device(gw);
    const other = device(gw);
    sender.engine.sent(KEY, "run-1", "call yourself Juniper");
    await Promise.all([
      other.engine.afterRun("pip", KEY, "run-1"),
      sender.engine.afterRun("pip", KEY, "run-1"),
    ]);
    await other.engine.onPrefsChanged([NAME_RECORD_KEY]);
    expect(gw.state.updates).toEqual(["Juniper"]);
    expect(other.line()).toMatchObject({ status: "renamed", whose: "person" });
    expect(undoable(other, gw)).toBe(true);
  });

  it("F-552: two devices that didn't send the run both try to claim it from the same record: one renames, both show it as the bot's own", async () => {
    const gw = gateway();
    const a = device(gw);
    const b = device(gw);
    await Promise.all([
      a.engine.afterRun("pip", KEY, "run-1"),
      b.engine.afterRun("pip", KEY, "run-1"),
    ]);
    for (const each of [a, b]) await each.engine.onPrefsChanged([NAME_RECORD_KEY]);
    expect(gw.state.updates).toEqual(["Juniper"]);
    for (const each of [a, b]) {
      expect(each.line()).toMatchObject({ to: "Juniper", status: "renamed", whose: "bot" });
      expect(undoable(each, gw)).toBe(true);
    }
  });

  it("F-552: while another writer's claim on the bot stands, nothing is renamed and nothing is shown", async () => {
    const gw = gateway();
    gw.state.record = record({
      changes: [change({ at: NOW, whose: "bot" })],
      claims: [{ bot: "pip", op: "e".repeat(16), run: runTag("run-1"), at: NOW - 1_000 }],
    });
    const a = device(gw);
    await a.engine.afterRun("pip", KEY, "run-1");
    expect(gw.state.updates).toEqual([]);
    expect(a.lines()).toEqual([]);
  });

  it("F-552: a rename the gateway refused takes its entry and claim back and counts nothing; one whose answer was lost keeps both until the claim expires, then the bot's name settles it", async () => {
    const refused = gateway();
    refused.state.update = "refused";
    const r = device(refused);
    await r.engine.afterRun("pip", KEY, "run-1");
    expect(r.line()).toMatchObject({ status: "failed" });
    expect(refused.kept()).toMatchObject({ changes: [], counts: [], claims: [] });

    // Its answer lost, but the bot list shows the name: confirmed, counted, the claim let go.
    const lost = gateway();
    lost.state.update = "lost";
    const l = device(lost);
    await l.engine.afterRun("pip", KEY, "run-1");
    expect(l.line()).toMatchObject({ status: "renamed" });
    expect(lost.kept()).toMatchObject({
      counts: [{ bot: "pip", day: dayOf(NOW), n: 1 }],
      claims: [],
    });
    expect(lost.kept().changes[0]!.done).toBe(NOW);

    // Lost before it landed: the entry and the claim stay, nothing is counted, and once the claim
    // expires the bot's name settles it: taken back.
    const dropped = gateway();
    dropped.state.update = "dropped";
    const d = device(dropped);
    await d.engine.afterRun("pip", KEY, "run-1");
    expect(d.line()).toMatchObject({ status: "failed" });
    expect(dropped.kept()).toMatchObject({ counts: [] });
    expect(dropped.kept().changes).toHaveLength(1);
    expect(dropped.kept().claims).toHaveLength(1);
    expect(settled(dropped.kept(), dropped.state.bots, NOW + 1_000).claims).toHaveLength(1);
    expect(settled(dropped.kept(), dropped.state.bots, NOW + CLAIM_EXPIRY_MS)).toMatchObject({
      changes: [],
      claims: [],
      counts: [],
    });
  });

  it("F-552: an abandoned claim whose rename never landed expires, is taken back, and doesn't keep the run from being applied", async () => {
    const gw = gateway();
    gw.state.record = record({
      changes: [change({ at: NOW - CLAIM_EXPIRY_MS - 1, whose: "bot" })],
      counts: [],
      claims: [
        {
          bot: "pip",
          op: "e".repeat(16),
          run: runTag("run-1"),
          at: NOW - CLAIM_EXPIRY_MS - 1,
        },
      ],
    });
    const me = device(gw);
    await me.engine.afterRun("pip", KEY, "run-1");
    expect(gw.state.updates).toEqual(["Juniper"]);
    const kept = gw.kept();
    expect(kept.changes).toHaveLength(1);
    expect(kept.changes[0]!.done).toBe(NOW);
    expect(kept.counts).toEqual([{ bot: "pip", day: dayOf(NOW), n: 1 }]);
    expect(kept.claims).toEqual([]);
  });

  it("F-552: a rename whose confirmation couldn't be saved counts nothing, stays listed with Undo while the bot has its name", async () => {
    const gw = gateway();
    const me = device(gw);
    // The claim is written; the next write, its confirmation, isn't.
    gw.state.downAt = 2;
    await me.engine.afterRun("pip", KEY, "run-1");
    expect(gw.state.bots[0]!.name).toBe("Juniper");
    const kept = gw.kept();
    expect(kept.changes[0]!.done).toBeUndefined();
    expect(kept.counts).toEqual([]);
    expect(shownChanges(kept.changes, gw.state.bots)).toHaveLength(1);
    expect(canUndoName(kept.changes[0]!, kept.changes, gw.state.bots, NOW)).toBe(true);
    gw.state.downAt = null;
    gw.state.prefsDown = false;
    await me.engine.undo("pip", runTag("run-1"), "Pip", STAMP);
    expect(gw.state.bots[0]!.name).toBe("Pip");
  });

  it("F-552: a record request is made only on the gateway and the connection the operation began on", async () => {
    for (const move of ["gateway", "reconnect"] as const) {
      const gw = gateway();
      let stamp = STAMP;
      let generation = 1;
      const me = device(gw, { stamp: () => stamp, generation: () => `1:${generation}` });
      gw.state.meddle = () => {
        // Another device wrote first, and this one has moved on before it retries.
        gw.state.record = record({ rev: 9 });
        if (move === "gateway") stamp = { gatewayId: "gw-b", target: 2 };
        // A reconnect to the same gateway: a new socket, the stamp unchanged.
        else generation += 1;
      };
      await me.engine.afterRun("pip", KEY, "run-1");
      expect(gw.state.sets, move).toBe(1);
      expect(gw.state.updates, move).toEqual([]);
    }
  });

  it("F-552: the connection changing as the claim's answer arrives: the claim is taken again on the new one before the rename leaves, and it is confirmed", async () => {
    const gw = gateway();
    let generation = 1;
    const setsOn: number[] = [];
    const me = device(gw, { generation: () => `1:${generation}` });
    const request = gw.request;
    me.engine["ctx"].request = (method, params) => {
      if (method === "users.prefs.set") setsOn.push(generation);
      return request(method, params);
    };
    gw.state.afterSet = () => (generation += 1);
    let sentOn: number | null = null;
    gw.state.onUpdate = () => (sentOn = generation);
    me.engine.sent(KEY, "run-1", "call yourself Juniper");
    await me.engine.afterRun("pip", KEY, "run-1");
    expect(gw.state.updates).toEqual(["Juniper"]);
    // The first claim on the old connection, the claim again and the confirmation on the new one.
    expect(setsOn).toEqual([1, 2, 2]);
    expect(sentOn).toBe(2);
    expect(gw.kept().changes[0]!.done).toBe(NOW);
    expect(gw.kept().claims).toEqual([]);
    expect(undoable(me, gw)).toBe(true);
  });

  it("F-552: two runs, one paused after its claim: the other renames nothing, and the last name has a true line with Undo on both devices", async () => {
    const gw = gateway();
    const a = device(gw);
    const b = device(gw);
    a.engine.sent(KEY, "run-1", "call yourself Juniper");
    b.engine.sent(KEY, "run-2", "call yourself Maple");
    const hold = deferred<void>();
    let arrived = false;
    gw.state.hold = hold.promise;
    gw.state.onUpdate = () => (arrived = true);
    const first = a.engine.afterRun("pip", KEY, "run-1");
    await until(() => arrived);
    gw.state.file = "- **Name:** Maple\n";
    await b.engine.afterRun("pip", KEY, "run-2");
    hold.resolve();
    await first;
    for (const each of [a, b]) await each.engine.onPrefsChanged([NAME_RECORD_KEY]);
    expect(gw.state.updates).toEqual(["Juniper"]);
    for (const each of [a, b]) {
      expect(each.line()).toMatchObject({ to: "Juniper", whose: "person", status: "renamed" });
      expect(undoable(each, gw)).toBe(true);
    }
    await b.engine.undo("pip", runTag("run-1"), "Pip", STAMP);
    expect(gw.state.bots[0]!.name).toBe("Pip");
  });

  it("F-552: an Undo paused at its outgoing update while another device renames: the rename waits out the claim, and every device says what the name is", async () => {
    const gw = gateway();
    const a = device(gw);
    const b = device(gw);
    a.engine.sent(KEY, "run-1", "call yourself Juniper");
    await a.engine.afterRun("pip", KEY, "run-1");
    const hold = deferred<void>();
    let arrived = false;
    gw.state.hold = hold.promise;
    gw.state.onUpdate = () => (arrived = true);
    const undo = a.engine.undo("pip", runTag("run-1"), "Pip", STAMP);
    await until(() => arrived);
    gw.state.file = "- **Name:** Maple\n";
    b.engine.sent(KEY, "run-2", "call yourself Maple");
    await b.engine.afterRun("pip", KEY, "run-2");
    hold.resolve();
    await undo;
    for (const each of [a, b]) await each.engine.onPrefsChanged([NAME_RECORD_KEY]);
    expect(gw.state.updates).toEqual(["Juniper", "Pip"]);
    for (const each of [a, b])
      expect(each.line()).toMatchObject({ run: runTag("run-1"), status: "undone", after: "Pip" });
    expect(gw.kept().changes[0]!.undone).toBe(NOW);
  });

  it("F-552: holding the claim, the bot is read again: renamed meanwhile by a writer outside Clawtrate, nothing is sent and the claim goes", async () => {
    const gw = gateway();
    const me = device(gw, { cached: true });
    // Renamed elsewhere as the claim is written: seen only by reading the bot list again.
    gw.state.afterSet = () => (gw.state.bots = [bot("pip", "Maple"), bot("otto", "Otto")]);
    await me.engine.afterRun("pip", KEY, "run-1");
    expect(gw.state.updates).toEqual([]);
    expect(gw.kept()).toMatchObject({ changes: [], claims: [], counts: [] });
    expect(me.lines()).toEqual([]);
  });

  it("F-552: holding the claim, Undo reads the bot again: renamed meanwhile, nothing is sent", async () => {
    const gw = gateway();
    const me = device(gw, { cached: true });
    await me.engine.afterRun("pip", KEY, "run-1");
    gw.state.afterSet = () => (gw.state.bots = [bot("pip", "Maple"), bot("otto", "Otto")]);
    await expect(me.engine.undo("pip", runTag("run-1"), "Pip", STAMP)).rejects.toThrow(
      "can no longer be undone",
    );
    expect(gw.state.updates).toEqual(["Juniper"]);
    expect(gw.kept().claims).toEqual([]);
  });

  it("F-552: a write that would drop a count for today isn't made: long ids, or more bots renamed today than the record keeps", async () => {
    for (const [what, counts] of [
      [
        "long ids",
        Array.from({ length: 24 }, (_, n) => ({
          bot: `${n}`.padEnd(128, "x"),
          day: dayOf(NOW),
          n: 1,
        })),
      ],
      [
        "many bots",
        Array.from({ length: 32 }, (_, n) => ({ bot: `other-${n}`, day: dayOf(NOW), n: 1 })),
      ],
    ] as const) {
      const gw = gateway();
      gw.state.record = record({ counts: [...counts] });
      const me = device(gw);
      await me.engine.afterRun("pip", KEY, "run-1");
      expect(me.line(), what).toMatchObject({ status: "not-done", reason: "full" });
      expect(gw.state.updates, what).toEqual([]);
      expect(gw.kept().counts, what).toEqual(counts);
    }
  });

  it("F-552: a confirmed rename keeps a later day's counts that a device past midnight wrote", async () => {
    const gw = gateway();
    const tomorrow = dayOf(NOW + 24 * 60 * 60 * 1000);
    gw.state.record = record({ counts: [{ bot: "otto", day: tomorrow, n: 3 }] });
    await device(gw).engine.afterRun("pip", KEY, "run-1");
    expect(gw.kept().counts).toEqual([
      { bot: "otto", day: tomorrow, n: 3 },
      { bot: "pip", day: dayOf(NOW), n: 1 },
    ]);
  });

  it("F-552: a confirmed rename keeps every bot's count for today and drops other days'", async () => {
    const gw = gateway();
    const others = Array.from({ length: 8 }, (_, n) => ({
      bot: `other-${n}`,
      day: dayOf(NOW),
      n: 1,
    }));
    gw.state.record = record({ counts: [{ bot: "old", day: "2026-01-01", n: 2 }, ...others] });
    await device(gw).engine.afterRun("pip", KEY, "run-1");
    expect(gw.kept().counts).toEqual([...others, { bot: "pip", day: dayOf(NOW), n: 1 }]);
  });

  it("F-552: not done, and said: no admin, a name another bot has, three confirmed renames today, no record, or a name before a rename couldn't set again", async () => {
    const noAdmin = device(gateway(), { admin: false });
    await noAdmin.engine.afterRun("pip", KEY, "run-1");
    expect(noAdmin.line()).toMatchObject({ status: "not-done", reason: "no-admin" });

    const taken = gateway({ file: "- Name: otto\n" });
    const t = device(taken);
    await t.engine.afterRun("pip", KEY, "run-1");
    expect(t.line()).toMatchObject({ status: "not-done", reason: "taken" });

    const busy = gateway();
    busy.state.record = record({
      changes: [1, 2, 3].map((n) =>
        change({ run: runTag(`old-${n}`), at: NOW - n * 1000, done: NOW - n * 1000 }),
      ),
    });
    const limited = device(busy);
    await limited.engine.afterRun("pip", KEY, "run-1");
    expect(limited.line()).toMatchObject({ status: "not-done", reason: "limit" });
    // Claims that never landed count for nothing.
    const unconfirmed = gateway();
    unconfirmed.state.record = record({
      changes: [1, 2, 3].map((n) => change({ run: runTag(`old-${n}`), at: NOW - n * 1000 })),
    });
    await device(unconfirmed).engine.afterRun("pip", KEY, "run-1");
    expect(unconfirmed.state.updates).toEqual(["Juniper"]);
    // The day's count outlasts the changes other bots' renames push out of the record.
    const evicted = gateway();
    evicted.state.record = record({ counts: [{ bot: "pip", day: dayOf(NOW), n: 3 }] });
    const e = device(evicted);
    await e.engine.afterRun("pip", KEY, "run-1");
    expect(e.line()).toMatchObject({ status: "not-done", reason: "limit" });

    const none = gateway({ prefs: "none" });
    const n = device(none);
    await n.engine.afterRun("pip", KEY, "run-1");
    expect(n.line()).toMatchObject({ status: "not-done", reason: "no-record" });

    const spaced = gateway();
    spaced.state.bots = [bot("pip", "Pip  the  First "), bot("otto", "Otto")];
    const s = device(spaced);
    await s.engine.afterRun("pip", KEY, "run-1");
    expect(s.line()).toMatchObject({ status: "not-done", reason: "no-record" });
    expect([taken, busy, evicted, none, spaced].flatMap((g) => g.state.updates)).toEqual([]);
  });

  it("F-552: Undo puts back the name it named, reads it back, marks the change undone and declines that edit", async () => {
    const gw = gateway();
    const me = device(gw);
    await me.engine.afterRun("pip", KEY, "run-1");
    await me.engine.undo("pip", runTag("run-1"), "Pip", STAMP);
    expect(gw.state.updates).toEqual(["Juniper", "Pip"]);
    expect(me.line()).toMatchObject({ status: "undone", after: "Pip", error: null });
    const kept = gw.kept();
    expect(kept.changes[0]!.undone).toBe(NOW);
    expect(kept.declined).toEqual([{ bot: "pip", name: "Juniper", file: FILE_TAG, at: NOW }]);
    expect(kept.claims).toEqual([]);
    // Undo counts as no rename.
    expect(kept.counts).toEqual([{ bot: "pip", day: dayOf(NOW), n: 1 }]);
  });

  it("F-552: the line says the name is back only when the name read back is the one Undo put back", async () => {
    const gw = gateway();
    const me = device(gw);
    await me.engine.afterRun("pip", KEY, "run-1");
    gw.state.store = () => "Pip the Second";
    await me.engine.undo("pip", runTag("run-1"), "Pip", STAMP);
    expect(me.line()).toMatchObject({ status: "undone", after: "Pip the Second" });
    // Not marked undone, nothing declined: the change didn't come back as promised.
    expect(gw.kept().changes[0]!.undone).toBeUndefined();
    expect(gw.kept().declined).toEqual([]);
    expect(gw.kept().claims).toEqual([]);
  });

  it("F-552: Undo refuses a name changed again, another name than its button showed, a forged name before, one too old, and one another device undid", async () => {
    const renamedAgain = gateway();
    const a = device(renamedAgain);
    await a.engine.afterRun("pip", KEY, "run-1");
    renamedAgain.state.bots = [bot("pip", "Maple"), bot("otto", "Otto")];
    await expect(a.engine.undo("pip", runTag("run-1"), "Pip", STAMP)).rejects.toThrow(
      "can no longer be undone",
    );

    const otherName = gateway();
    const o = device(otherName);
    await o.engine.afterRun("pip", KEY, "run-1");
    await expect(o.engine.undo("pip", runTag("run-1"), "Mallory", STAMP)).rejects.toThrow(
      "now puts back Pip, not Mallory",
    );

    for (const from of [
      "Otto",
      "x".repeat(MAX_BOT_NAME_CHARS + 1),
      "Pip  the  First",
      "<b>x</b>\n",
    ]) {
      const forged = gateway();
      forged.state.bots = [bot("pip", "Juniper"), bot("otto", "Otto")];
      forged.state.record = record({ changes: [change({ from })] });
      await expect(
        device(forged).engine.undo("pip", runTag("run-1"), from, STAMP),
        from,
      ).rejects.toThrow("can no longer be undone");
      expect(forged.state.updates, from).toEqual([]);
    }

    const old = gateway();
    old.state.bots = [bot("pip", "Juniper")];
    old.state.record = record({ changes: [change({ at: NOW - UNDO_WINDOW_MS - 1 })] });
    await expect(device(old).engine.undo("pip", runTag("run-1"), "Pip", STAMP)).rejects.toThrow();

    const shared = gateway();
    const mine = device(shared);
    await mine.engine.afterRun("pip", KEY, "run-1");
    await device(shared).engine.undo("pip", runTag("run-1"), "Pip", STAMP);
    await mine.engine.onPrefsChanged([NAME_RECORD_KEY]);
    expect(mine.line()).toMatchObject({ status: "undone", after: "Pip" });
    await expect(mine.engine.undo("pip", runTag("run-1"), "Pip", STAMP)).rejects.toThrow();
    // The name the button didn't show is never sent.
    expect(otherName.state.updates).toEqual(["Juniper"]);
    for (const each of [renamedAgain, otherName, old])
      expect(each.state.updates.filter((name) => name === "Pip")).toEqual([]);
    expect(shared.state.updates).toEqual(["Juniper", "Pip"]);
  });

  it("F-552: the device that applied a rename keeps its own copy, and its Undo prefers it to a record another device replaced", async () => {
    const gw = gateway();
    const me = device(gw);
    await me.engine.afterRun("pip", KEY, "run-1");
    // Another of the person's devices rewrites the entry with another name before, a valid one.
    gw.state.record = record({ rev: 5, changes: [change({ from: "Mallory", done: NOW })] });
    const observer = device(gw);
    await Promise.all([me, observer].map((each) => each.engine.onPrefsChanged([NAME_RECORD_KEY])));
    // Each says truthfully what its Undo would set.
    expect(me.record()!.changes[0]!.from).toBe("Pip");
    expect(observer.record()!.changes[0]!.from).toBe("Mallory");
    await me.engine.undo("pip", runTag("run-1"), "Pip", STAMP);
    expect(gw.state.updates).toEqual(["Juniper", "Pip"]);
  });

  it("F-552: a read-only sender while a follower applies: the sender's refusal is replaced by the follower's line, as the bot's own, without Undo there", async () => {
    const gw = gateway();
    const sender = device(gw, { admin: false });
    const followers = [device(gw), device(gw)];
    sender.engine.sent(KEY, "run-1", "call yourself Juniper");
    await sender.engine.afterRun("pip", KEY, "run-1");
    expect(sender.line()).toMatchObject({ status: "not-done", reason: "no-admin" });
    await Promise.all(followers.map((each) => each.engine.afterRun("pip", KEY, "run-1")));
    for (const each of [sender, ...followers]) await each.engine.onPrefsChanged([NAME_RECORD_KEY]);
    expect(gw.state.updates).toEqual(["Juniper"]);
    for (const each of [sender, ...followers])
      expect(each.line()).toMatchObject({ to: "Juniper", status: "renamed", whose: "bot" });
    // Undo works only where the connection may change bots.
    await expect(sender.engine.undo("pip", runTag("run-1"), "Pip", STAMP)).rejects.toThrow(
      "needs admin",
    );
    expect(undoable(followers[0]!, gw)).toBe(true);
  });

  it("F-552: a slow sender and a late observer still get the line once the bot has its new name", async () => {
    const gw = gateway();
    const sender = device(gw);
    const follower = device(gw);
    const late = device(gw);
    sender.engine.sent(KEY, "run-1", "call yourself Juniper");
    // The follower's wait ran out before the sender read the file.
    await follower.engine.afterRun("pip", KEY, "run-1");
    await sender.engine.loadRecord();
    await sender.engine.afterRun("pip", KEY, "run-1");
    await late.engine.loadRecord();
    await late.engine.afterRun("pip", KEY, "run-1");
    expect(gw.state.updates).toEqual(["Juniper"]);
    for (const each of [sender, follower, late]) {
      expect(each.line()).toMatchObject({ to: "Juniper", status: "renamed", whose: "bot" });
      expect(undoable(each, gw)).toBe(true);
    }
  });

  it("F-552: a line this device set after the record's latest change stays: a later refusal isn't replaced by an older rename", async () => {
    const gw = gateway();
    const a = device(gw);
    await a.engine.afterRun("pip", KEY, "run-1");
    // Later, Pip writes Otto's name: refused here.
    gw.state.now += 60_000;
    gw.state.file = "- **Name:** Otto\n";
    await a.engine.afterRun("pip", KEY, "run-2");
    expect(a.line()).toMatchObject({ run: runTag("run-2"), reason: "taken" });
    await a.engine.onPrefsChanged([NAME_RECORD_KEY]);
    a.engine.onBots(gw.state.bots);
    expect(a.line()).toMatchObject({ run: runTag("run-2"), reason: "taken" });
  });

  it("F-552: a refusal for a change another device later undid is replaced by the undone line", async () => {
    const gw = gateway();
    const sender = device(gw, { admin: false });
    sender.engine.sent(KEY, "run-1", "call yourself Juniper");
    await sender.engine.afterRun("pip", KEY, "run-1");
    const follower = device(gw);
    await follower.engine.afterRun("pip", KEY, "run-1");
    await follower.engine.undo("pip", runTag("run-1"), "Pip", STAMP);
    await sender.engine.onPrefsChanged([NAME_RECORD_KEY]);
    expect(sender.line()).toMatchObject({ status: "undone", after: "Pip" });
  });

  it("F-552: after a restart the line comes back with the record, as well as the settings; one closed here stays closed", async () => {
    const gw = gateway();
    const before = device(gw);
    before.engine.sent(KEY, "run-1", "call yourself Juniper");
    await before.engine.afterRun("pip", KEY, "run-1");
    const restarted = device(gw);
    await restarted.engine.loadRecord();
    expect(restarted.line()).toMatchObject({ to: "Juniper", whose: "person", status: "renamed" });
    expect(restarted.record()!.changes).toHaveLength(1);
    expect(undoable(restarted, gw)).toBe(true);
    restarted.engine.dismiss("pip", runTag("run-1"));
    await restarted.engine.onPrefsChanged([NAME_RECORD_KEY]);
    restarted.engine.onBots(gw.state.bots);
    expect(restarted.lines()).toEqual([]);
  });

  it("F-552: a decline belongs to one edit: the same edit isn't applied again, a fresh request for the same name is, with its line", async () => {
    const gw = gateway();
    const me = device(gw);
    me.engine.sent(KEY, "run-1", "call yourself Juniper");
    await me.engine.afterRun("pip", KEY, "run-1");
    await me.engine.undo("pip", runTag("run-1"), "Pip", STAMP);
    // The file as it was, picked up again with no write of the run's: declined, and nothing said.
    const quiet = device(gw, { steps: [] });
    await quiet.engine.afterRun("pip", KEY, "run-2");
    expect(gw.state.updates).toEqual(["Juniper", "Pip"]);
    // It shows only the record's line for the change that was undone.
    expect(quiet.lines()).toEqual([
      expect.objectContaining({ run: runTag("run-1"), status: "undone", after: "Pip" }),
    ]);
    // The person asks again: a fresh edit, applied, with its line.
    me.engine.sent(KEY, "run-3", "Juniper after all, please");
    await me.engine.afterRun("pip", KEY, "run-3");
    expect(gw.state.updates).toEqual(["Juniper", "Pip", "Juniper"]);
    expect(me.line()).toMatchObject({ run: runTag("run-3"), whose: "person", status: "renamed" });
  });

  it("F-552: a decline expires with Undo's window, and covers only the file as it was", async () => {
    for (const declined of [
      { bot: "pip", name: "Juniper", file: FILE_TAG, at: NOW - UNDO_WINDOW_MS - 1 },
      { bot: "pip", name: "Juniper", file: runTag("another file"), at: NOW },
    ]) {
      const gw = gateway();
      gw.state.record = record({ declined: [declined] });
      const me = device(gw, { steps: [] });
      await me.engine.afterRun("pip", KEY, "run-1");
      expect(gw.state.updates).toEqual(["Juniper"]);
      expect(me.line()).toMatchObject({ whose: "file", status: "renamed" });
    }
  });

  it("F-552: an Undo whose record couldn't be kept says so, and this device still won't apply that edit again", async () => {
    const gw = gateway();
    const me = device(gw, { steps: [] });
    await me.engine.afterRun("pip", KEY, "run-1");
    // Undo's claim is written; the write that marks it undone and declines the edit isn't.
    gw.state.downAt = gw.state.sets + 2;
    await me.engine.undo("pip", runTag("run-1"), "Pip", STAMP);
    expect(me.line()).toMatchObject({ status: "undone", after: "Pip" });
    expect(me.line()!.error).toMatch(/couldn't keep this on the gateway/);
    // While the gateway still won't take it, the same edit changes nothing here.
    await me.engine.afterRun("pip", KEY, "run-2");
    expect(me.line()).toMatchObject({ status: "undone" });
    gw.state.prefsDown = false;
    gw.state.downAt = null;
    await me.engine.afterRun("pip", KEY, "run-3");
    expect(gw.state.updates).toEqual(["Juniper", "Pip"]);
    // Written once the gateway takes it again.
    expect(gw.kept().declined).toEqual([{ bot: "pip", name: "Juniper", file: FILE_TAG, at: NOW }]);
  });

  it("F-552: the line's three forms through the engine: a read of the bot's own file first, and no write at all", async () => {
    const read = gateway();
    const r = device(read, { steps: [READ_OWN, EDIT_OWN] });
    r.engine.sent(KEY, "run-1", "call yourself Juniper");
    await r.engine.afterRun("pip", KEY, "run-1");
    expect(r.line()).toMatchObject({ whose: "bot", source: "file" });

    const none = gateway();
    const n = device(none, { steps: [] });
    n.engine.sent(KEY, "run-1", "call yourself Juniper");
    await n.engine.afterRun("pip", KEY, "run-1");
    expect(n.line()).toMatchObject({ whose: "file", source: null });

    const steered = gateway();
    const s = device(steered, { steered: true });
    s.engine.sent(KEY, "run-1", "call yourself Juniper");
    await s.engine.afterRun("pip", KEY, "run-1");
    expect(s.line()).toMatchObject({ whose: "bot" });

    const files = gateway();
    const f = device(files);
    f.engine.sent(KEY, "run-1", "call yourself Juniper", true);
    await f.engine.afterRun("pip", KEY, "run-1");
    expect(f.line()).toMatchObject({ whose: "bot", source: "attachment" });
  });

  it("F-552: the file read's slot goes once the read settles, not after the wait and the rename", async () => {
    const gw = gateway();
    let during = -1;
    const other = device(gw, { claim: async () => void (during = other.slots()) });
    await other.engine.afterRun("pip", KEY, "run-1");
    expect(during).toBe(0);
    expect(gw.state.updates).toEqual(["Juniper"]);
  });

  it("F-552: a bot renamed during the wait before the claim keeps that name: nothing is sent", async () => {
    const gw = gateway();
    const other = device(gw, {
      claim: async () => void (gw.state.bots = [bot("pip", "Maple"), bot("otto", "Otto")]),
    });
    await other.engine.afterRun("pip", KEY, "run-1");
    expect(gw.state.updates).toEqual([]);
    expect(gw.kept()).toMatchObject({ changes: [], claims: [] });
  });

  it("F-552: an Undo whose answer was lost reads the name back: back if the gateway lists it, said as it is if not", async () => {
    const landed = gateway();
    const a = device(landed);
    await a.engine.afterRun("pip", KEY, "run-1");
    landed.state.update = "lost";
    await a.engine.undo("pip", runTag("run-1"), "Pip", STAMP);
    expect(a.line()).toMatchObject({ status: "undone", after: "Pip", error: null });
    expect(landed.kept().declined).toEqual([
      { bot: "pip", name: "Juniper", file: FILE_TAG, at: NOW },
    ]);

    const lost = gateway();
    const b = device(lost);
    await b.engine.afterRun("pip", KEY, "run-1");
    lost.state.update = "dropped";
    await b.engine.undo("pip", runTag("run-1"), "Pip", STAMP);
    expect(b.line()).toMatchObject({ status: "undone", after: "Juniper" });
    expect(lost.kept().changes[0]!.undone).toBeUndefined();
    expect(lost.kept().claims).toEqual([]);
  });

  it("F-552: an Undo's unsaved decline is kept and written again after a reconnect to the same gateway", async () => {
    const gw = gateway();
    let stamp = STAMP;
    const me = device(gw, { steps: [], stamp: () => stamp });
    await me.engine.afterRun("pip", KEY, "run-1");
    // Undo's claim is written; the write that declines the edit isn't.
    gw.state.downAt = gw.state.sets + 2;
    await me.engine.undo("pip", runTag("run-1"), "Pip", stamp);
    // Connected again to the same gateway: the host's target is new.
    stamp = { gatewayId: "gw-a", target: 2 };
    me.engine.reset();
    await me.engine.afterRun("pip", KEY, "run-2");
    expect(gw.state.updates).toEqual(["Juniper", "Pip"]);
    gw.state.prefsDown = false;
    gw.state.downAt = null;
    await me.engine.afterRun("pip", KEY, "run-3");
    expect(gw.state.updates).toEqual(["Juniper", "Pip"]);
    expect(gw.kept().declined).toEqual([{ bot: "pip", name: "Juniper", file: FILE_TAG, at: NOW }]);
  });

  it("F-552: unsaved declines the record has no room for stay pending; only those it kept are cleared", async () => {
    const gw = gateway();
    const me = device(gw);
    const pending = me.engine["unrecorded"];
    for (let n = 0; n < 9; n += 1)
      pending.set(`gw-a\nbot-${n}`, {
        stamp: STAMP,
        botId: `bot-${n}`,
        name: `Name ${n}`,
        run: runTag(`r${n}`),
        file: FILE_TAG,
        op: runTag(`o${n}`),
      });
    await me.engine.afterRun("pip", KEY, "run-1");
    expect(gw.kept().declined).toHaveLength(8);
    expect([...pending.values()].map((each) => each.botId)).toEqual(["bot-0"]);
  });

  it("F-552: a claim's entry is never the one the record's room drops", () => {
    const changes = Array.from({ length: 9 }, (_, n) =>
      change({ bot: `bot-${n}`, run: runTag(`r${n}`), done: NOW }),
    );
    // The paused rename's entry: claimed, not yet confirmed.
    const held = change({ bot: "bot-0", run: runTag("r0") });
    const fitted = fitNameRecord({
      rev: 1,
      changes: [held, ...changes.slice(1)],
      declined: [],
      counts: [],
      claims: [{ bot: "bot-0", op: "c".repeat(16), run: runTag("r0"), at: NOW }],
    });
    expect(fitted.changes).toHaveLength(MAX_RECORD_CHANGES);
    expect(fitted.changes[0]).toEqual(held);
    expect(fitted.changes.map((each) => each.bot)).not.toContain("bot-1");
  });

  it("F-552: Close puts away only the line it was pressed on", async () => {
    const gw = gateway();
    const me = device(gw);
    await me.engine.afterRun("pip", KEY, "run-1");
    me.engine.dismiss("pip", runTag("another run"));
    expect(me.line()).toMatchObject({ run: runTag("run-1") });
    me.engine.dismiss("pip", runTag("run-1"));
    expect(me.lines()).toEqual([]);
  });

  it("F-552: the default bot is never read", async () => {
    const gw = gateway();
    gw.state.bots = [{ ...bot("pip", "Pip"), isDefault: true }];
    const me = device(gw);
    await me.engine.afterRun("pip", KEY, "run-1");
    expect(me.lines()).toEqual([]);
    expect(gw.state.updates).toEqual([]);
    expect(gw.state.reads).toBe(0);
  });

  it("F-552: names are read as the gateway reads them, and made plain and bounded as a rename saves them", () => {
    expect(identityName("- **Name:** Johnny\n- Name: (pick something you like)\n")).toBe("Johnny");
    expect(identityName(identityFile("New bot", false))).toBe("New bot");
    expect(plainName(`  <b>Jo</b>${String.fromCharCode(0)}\n${RLO}X  `)).toBe("<b>Jo</b> X");
    expect(Array.from(plainName("y".repeat(10_000))!)).toHaveLength(MAX_BOT_NAME_CHARS);
  });
});

describe("F-552: through the client", () => {
  /** A client with one New bot whose IDENTITY.md the test writes, and the gateway's record. */
  async function namingClient(options: { identityFails?: number } = {}) {
    const files = { content: "- **Name:** New bot\n" };
    const held = ADMIN_SCOPES;
    const storage = guidesOff(
      memoryStorage({
        connection: JSON.stringify({ url: URL_A, token: null }),
        [tokenKey(URL_A)]: JSON.stringify({
          token: "device-token",
          grantedScopes: held,
          heldScopes: held.filter((scope) => scope !== "operator.admin"),
          adminHeld: true,
        }),
      }),
    );
    const gw = grantingGateway();
    let fails = options.identityFails ?? 0;
    gw.handlers["gateway.identity.get"] = () => {
      if (fails > 0) {
        fails -= 1;
        throw new Error("the gateway was busy");
      }
      return { deviceId: "gw-a" };
    };
    // The gateway runs a message under its idempotency key (`chat-send-handler`, both versions).
    gw.handlers["chat.send"] = (params) => ({
      runId: (params as { idempotencyKey: string }).idempotencyKey,
      status: "started",
    });
    const bots = { name: "New bot" };
    // With a failing identity read, a record kept from before: what Recent changes would list.
    let stored: unknown = options.identityFails
      ? record({
          changes: [
            change({
              bot: "new-bot",
              from: "Old bot",
              to: "New bot",
              at: Date.now(),
              done: Date.now(),
            }),
          ],
        })
      : undefined;
    gw.handlers["agents.list"] = () => ({
      defaultId: "main",
      agents: [{ id: "main" }, { id: "new-bot", name: bots.name, identity: { name: bots.name } }],
    });
    gw.handlers["agents.files.get"] = () => ({
      file: { content: files.content, hash: "b".repeat(64) },
    });
    // The bot's picture is in its config; `agents.update` copies it into the file with the name.
    const picture = `data:image/png;base64,${"A".repeat(3_000)}`;
    gw.handlers["config.get"] = () => ({
      config: {
        agents: { entries: { "new-bot": { identity: { name: bots.name, avatar: picture } } } },
      },
    });
    gw.handlers["agents.update"] = (params) => {
      bots.name = String((params as { name: string }).name);
      files.content = `- Name: ${bots.name}\n- Avatar: ${picture}\n`;
      return { ok: true };
    };
    gw.handlers["agents.files.set"] = (params) => {
      files.content = String((params as { content: string }).content);
      return { ok: true };
    };
    gw.handlers["users.prefs.get"] = () => ({
      status: "ok",
      entries: stored === undefined ? {} : { [NAME_RECORD_KEY]: stored },
    });
    gw.handlers["users.prefs.set"] = (params) => {
      stored = (params as { entries: Record<string, unknown> }).entries[NAME_RECORD_KEY];
      return { status: "ok" };
    };
    const { client } = await openTask({
      gateway: gw,
      storage,
      held,
      key: "agent:new-bot:main",
      client: { nameClaimDelayMs: 0 },
    });
    /** The bot edits its file's name line in the run `id`, as the scripted model does. */
    const edit = (id: string, name: string, seq = 1) => {
      const args = { path: "IDENTITY.md", edits: [{ oldText: "x", newText: name }] };
      gw.emit(
        "agent",
        agentEvent(
          id,
          seq,
          "tool",
          { phase: "start", name: "edit", toolCallId: `e-${id}`, args },
          "agent:new-bot:main",
        ),
      );
      files.content = `- **Name:** ${name}\n`;
      gw.emit(
        "agent",
        agentEvent(
          id,
          seq + 1,
          "tool",
          {
            phase: "result",
            name: "edit",
            toolCallId: `e-${id}`,
            isError: false,
            result: { content: [{ type: "text", text: "Successfully replaced 1 block(s)." }] },
          },
          "agent:new-bot:main",
        ),
      );
    };
    return { client, gw, files, bots, edit };
  }

  it("F-552: a name the bot writes in a run this device sent is the person's ask, applied with the picture kept out of its file, and Undo puts back the name it names", async () => {
    const { client, gw, files, bots, edit } = await namingClient();
    try {
      const id = client.sendMessage("agent:new-bot:main", "call yourself Johnny");
      await until(() => gw.calls("chat.send").length === 1);
      edit(id, "Johnny");
      gw.emit("agent", agentEvent(id, 3, "lifecycle", { phase: "end" }, "agent:new-bot:main"));
      await until(() => client.state.botNames?.[0]?.status === "renamed");
      expect(client.state.botNames![0]).toMatchObject({
        from: "New bot",
        to: "Johnny",
        whose: "person",
      });
      expect(client.state.botNameRecord?.changes).toHaveLength(1);
      expect(files.content).toBe("- Name: Johnny\n");
      const line = client.state.botNames![0]!;
      await client.undoBotName("new-bot", line.run, "New bot", line.stamp);
      expect(bots.name).toBe("New bot");
      expect(client.state.botNames![0]).toMatchObject({ status: "undone", after: "New bot" });
    } finally {
      client.stop();
    }
  });

  it("F-552: the record is read once the gateway is named, when its first identity read failed", async () => {
    const { client, gw } = await namingClient({ identityFails: 1 });
    try {
      await until(() => client.state.connection.gatewayId === "gw-a", 5_000);
      await until(() => client.state.botNameRecord?.stamp.gatewayId === "gw-a", 5_000);
      expect(client.state.botNameRecord!.changes).toHaveLength(1);
      expect(gw.calls("users.prefs.get").length).toBeGreaterThan(0);
    } finally {
      client.stop();
    }
  });

  it("F-552: a person's message another device sent within the run makes the rename the bot's own", async () => {
    const { client, gw, edit } = await namingClient();
    try {
      const id = client.sendMessage("agent:new-bot:main", "call yourself Johnny");
      await until(() => gw.calls("chat.send").length === 1);
      gw.emit("agent", agentEvent(id, 1, "lifecycle", { phase: "start" }, "agent:new-bot:main"));
      // History, read again as the gateway says a message arrived: this device's message, then
      // one from another device while the run was running.
      const row = (n: number, content: string, extra: Record<string, unknown> = {}) => ({
        role: "user",
        content,
        timestamp: 1_000 + n,
        __openclaw: { id: `u-${n}`, seq: n, ...extra },
      });
      gw.handlers["chat.history"] = () => ({
        messages: [
          row(1, "call yourself Johnny", { idempotencyKey: id }),
          row(2, "or anything you like"),
        ],
        inFlightRun: { runId: id },
      });
      // The gateway has the other device's message, but no history read has brought it here yet:
      // the run's end reads it before its rename is judged.
      edit(id, "Johnny", 2);
      gw.emit("agent", agentEvent(id, 4, "lifecycle", { phase: "end" }, "agent:new-bot:main"));
      await until(() => client.state.botNames?.[0]?.status === "renamed");
      expect(client.state.botNames![0]).toMatchObject({ to: "Johnny", whose: "bot" });
    } finally {
      client.stop();
    }
  });

  it("F-552: a steer this device sent into the run makes the rename the bot's own", async () => {
    const { client, gw, edit } = await namingClient();
    try {
      const id = client.sendMessage("agent:new-bot:main", "call yourself Johnny");
      await until(() => gw.calls("chat.send").length === 1);
      gw.emit("agent", agentEvent(id, 1, "lifecycle", { phase: "start" }, "agent:new-bot:main"));
      await until(
        () => client.state.transcripts["agent:new-bot:main"]?.runs[0]?.state === "running",
      );
      client.sendMessage("agent:new-bot:main", "actually, any name you like");
      await until(() => gw.calls("chat.send").length === 2);
      edit(id, "Johnny", 2);
      gw.emit("agent", agentEvent(id, 4, "lifecycle", { phase: "end" }, "agent:new-bot:main"));
      await until(() => client.state.botNames?.[0]?.status === "renamed");
      expect(client.state.botNames![0]).toMatchObject({ to: "Johnny", whose: "bot" });
    } finally {
      client.stop();
    }
  });
});
