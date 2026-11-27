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
  MAX_RECORD_COUNTS,
  CLAIM_SEND_MS,
  NAME_DECLINES_KEY,
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
import { LIVE_UPDATES_NOT_STARTED } from "../src/client.ts";
import { utf8Length } from "../src/encoding.ts";
import { ADMIN_SCOPES } from "../src/scopes.ts";
import type { Bot, GatewayStamp, NameLine, NameRecordChange } from "../src/types.ts";
import { agentEvent, grantingGateway, openTask, URL_A } from "./client-harness.ts";
import { deferred, guidesOff, memoryStorage, sleep, tokenKey, until } from "./fake-gateway.ts";

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
    /** Runs as each `users.prefs.get` arrives, with how many came before it. */
    onGet: null as null | ((before: number) => void),
    gets: 0,
    /** The picture in the bot's config, which `config.get` answers with each time it is asked. */
    picture: [] as Array<string | null>,
    /** Every `agents.files.set` the gateway was sent. */
    fileSets: [] as string[],
  };
  const request = async (method: string, raw: unknown): Promise<unknown> => {
    const params = raw as Record<string, unknown>;
    if (method === "agents.files.get") {
      state.reads += 1;
      return { file: { content: state.file, hash: "a".repeat(64) } };
    }
    if (method === "config.get") {
      const picture =
        state.picture.length > 1 ? state.picture.shift()! : (state.picture[0] ?? null);
      return picture === null
        ? { config: {} }
        : { config: { agents: { entries: { pip: { identity: { avatar: picture } } } } } };
    }
    if (method === "agents.files.set") {
      state.fileSets.push(String(params.content));
      return { ok: true };
    }
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
    if (method === "users.prefs.get") {
      state.onGet?.(state.gets);
      state.gets += 1;
      return {
        status: "ok",
        entries: state.record === undefined ? {} : { [NAME_RECORD_KEY]: state.record },
      };
    }
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
    /** Whether the task's history could be read at the run's end. */
    history?: boolean;
    /** Whether the run's message was stored as the owner's (default: it was). */
    owner?: boolean;
    /**
     * The name the run found in IDENTITY.md: by default the bot's name when its end is checked, as
     * a read when the run started would have found it; null for no start read at all.
     */
    start?: string | null;
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
    readHistory: async () => options.history ?? true,
    runFacts: () => ({
      steps: options.steps === undefined ? [EDIT_OWN] : options.steps,
      steered: options.steered ?? false,
      owner: options.owner ?? true,
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
  // Each run's start as a read when it started found it, unless the test reads it itself.
  const afterRun = engine.afterRun.bind(engine);
  engine.afterRun = async (botId: string, sessionKey: string, runId?: string) => {
    const starts = engine["starts"] as Map<string, { botId: string; name: string | null }>;
    if (runId !== undefined && options.start !== null && !starts.has(runId))
      starts.set(runId, {
        botId,
        name: options.start ?? gw.state.bots.find((each) => each.id === botId)?.name ?? null,
      });
    return afterRun(botId, sessionKey, runId);
  };
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
    restarted.engine.dismiss("pip", runTag("run-1"), STAMP);
    await restarted.engine.onPrefsChanged([NAME_RECORD_KEY]);
    restarted.engine.onBots(gw.state.bots);
    expect(restarted.lines()).toEqual([]);
  });

  it("F-552: after Undo, the file picked up again with no write of a run's changes nothing; a fresh request for the same name is applied, with its line", async () => {
    const gw = gateway();
    const me = device(gw);
    me.engine.sent(KEY, "run-1", "call yourself Juniper");
    await me.engine.afterRun("pip", KEY, "run-1");
    await me.engine.undo("pip", runTag("run-1"), "Pip", STAMP);
    // The file as it was, picked up again by a run that wrote nothing: nothing done or said.
    const quiet = device(gw, { steps: [] });
    await quiet.engine.afterRun("pip", KEY, "run-2");
    expect(gw.state.updates).toEqual(["Juniper", "Pip"]);
    expect(quiet.lines()).toEqual([]);
    // The person asks again: a fresh edit, applied, with its line.
    me.engine.sent(KEY, "run-3", "Juniper after all, please");
    await me.engine.afterRun("pip", KEY, "run-3");
    expect(gw.state.updates).toEqual(["Juniper", "Pip", "Juniper"]);
    expect(me.line()).toMatchObject({ run: runTag("run-3"), whose: "person", status: "renamed" });
  });

  it("F-552: an Undo whose record couldn't be kept says so, and its decline is written before this device's next rename", async () => {
    const gw = gateway();
    const me = device(gw);
    await me.engine.afterRun("pip", KEY, "run-1");
    // Undo's claim is written; the write that marks it undone and declines the edit isn't.
    gw.state.downAt = gw.state.sets + 2;
    await me.engine.undo("pip", runTag("run-1"), "Pip", STAMP);
    expect(me.line()).toMatchObject({ status: "undone", after: "Pip" });
    expect(me.line()!.error).toMatch(/couldn't keep this on the gateway/);
    gw.state.prefsDown = false;
    gw.state.downAt = null;
    // The next rename here writes the decline first.
    gw.state.file = "- **Name:** Maple\n";
    await me.engine.afterRun("pip", KEY, "run-3");
    expect(gw.state.updates).toEqual(["Juniper", "Pip", "Maple"]);
    expect(gw.kept().declined).toEqual([{ bot: "pip", name: "Juniper", file: FILE_TAG, at: NOW }]);
  });

  it("F-552: the line's forms through the engine: a read of the bot's own file first; and no write of the run's, or history unread, changes nothing", async () => {
    const read = gateway();
    const r = device(read, { steps: [READ_OWN, EDIT_OWN] });
    r.engine.sent(KEY, "run-1", "call yourself Juniper");
    await r.engine.afterRun("pip", KEY, "run-1");
    expect(r.line()).toMatchObject({ whose: "bot", source: "file" });

    // No write of the name among the run's steps: not shown to be this run's change, so nothing.
    const none = gateway();
    const n = device(none, { steps: [] });
    n.engine.sent(KEY, "run-1", "call yourself Juniper");
    await n.engine.afterRun("pip", KEY, "run-1");
    expect(n.lines()).toEqual([]);
    expect(none.state.updates).toEqual([]);

    const steered = gateway();
    const s = device(steered, { steered: true });
    s.engine.sent(KEY, "run-1", "call yourself Juniper");
    await s.engine.afterRun("pip", KEY, "run-1");
    expect(s.line()).toMatchObject({ whose: "bot" });

    // No read of the file as the run started (no read free, the task opened mid-run): nothing.
    const unstarted = gateway();
    const v = device(unstarted, { start: null });
    v.engine.sent(KEY, "run-1", "call yourself Juniper");
    await v.engine.afterRun("pip", KEY, "run-1");
    expect(v.lines()).toEqual([]);
    expect(unstarted.state.updates).toEqual([]);

    // History unread at the run's end: who sent the run isn't known, so nothing is done.
    const unread = gateway();
    const u = device(unread, { history: false });
    u.engine.sent(KEY, "run-1", "call yourself Juniper");
    await u.engine.afterRun("pip", KEY, "run-1");
    expect(u.lines()).toEqual([]);
    expect(unread.state.updates).toEqual([]);

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
    // Still the name the change gave: Undo stays offered, and says it didn't land.
    expect(b.line()).toMatchObject({ status: "renamed", to: "Juniper" });
    expect(b.line()!.error).toContain("still lists");
    expect(undoable(b, lost)).toBe(true);
    expect(lost.kept().changes[0]!.undone).toBeUndefined();
    expect(lost.kept().claims).toEqual([]);

    // The bot list can't be read again, or not on the connection Undo was sent on (it changed
    // before the read, or during it): nothing is confirmed, nothing declined, and the claim stays
    // for the record to settle by the name listed.
    for (const how of ["refused", "reconnected before", "reconnected during"] as const) {
      const unread = gateway();
      let generation = "1:1";
      const c = device(unread, { generation: () => generation });
      await c.engine.afterRun("pip", KEY, "run-1");
      unread.state.update = "lost";
      const listed = c.ctx.refreshBots;
      unread.state.onUpdate = () => {
        if (how === "reconnected before") generation = "2:1";
        // The client's read returns, applying nothing, when its connection changed meanwhile.
        else
          c.ctx.refreshBots = async () => {
            if (how === "refused") throw new Error("no answer");
            generation = "2:1";
          };
      };
      await c.engine.undo("pip", runTag("run-1"), "Pip", STAMP);
      // Not known to have landed: the line keeps its Undo, and says so.
      expect(c.line()).toMatchObject({ status: "renamed", to: "Juniper" });
      expect(c.line()!.error).toContain("isn't confirmed");
      expect(unread.kept().declined).toEqual([]);
      expect(unread.kept().claims).toHaveLength(1);
      // The record confirms the Undo later: its line replaces the one this device couldn't confirm.
      c.ctx.refreshBots = listed;
      const kept = unread.kept();
      unread.state.record = {
        ...kept,
        changes: kept.changes.map((each) => ({ ...each, undone: NOW })),
        claims: [],
      };
      await c.engine.onPrefsChanged([NAME_RECORD_KEY]);
      expect(c.line()).toMatchObject({ status: "undone", after: "Pip", error: null });
    }
  });

  it("F-552: an Undo's unsaved decline is kept and written again after a reconnect to the same gateway", async () => {
    const gw = gateway();
    let stamp = STAMP;
    const me = device(gw, { stamp: () => stamp });
    await me.engine.afterRun("pip", KEY, "run-1");
    // Undo's claim is written; the write that declines the edit isn't.
    gw.state.downAt = gw.state.sets + 2;
    await me.engine.undo("pip", runTag("run-1"), "Pip", stamp);
    // Connected again to the same gateway: the host's target is new.
    stamp = { gatewayId: "gw-a", target: 2 };
    me.engine.reset();
    // Another device cleared the record meanwhile: only this device's copy holds the decline.
    gw.state.record = undefined;
    gw.state.prefsDown = false;
    gw.state.downAt = null;
    // The next rename on that gateway writes it first.
    gw.state.file = "- **Name:** Maple\n";
    await me.engine.afterRun("pip", KEY, "run-3");
    expect(gw.state.updates).toEqual(["Juniper", "Pip", "Maple"]);
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

  it("F-552: a decline saved by one Undo doesn't clear a later Undo's pending decline of the same bot", async () => {
    const gw = gateway();
    const me = device(gw);
    const pending = me.engine["unrecorded"];
    const entry = (name: string, op: string) => ({
      stamp: STAMP,
      botId: "otto",
      name,
      run: runTag(name),
      file: FILE_TAG,
      op: runTag(op),
    });
    pending.set("gw-a\notto", entry("Maple", "a"));
    // A later Undo of Otto takes the key while the first decline's write is answered.
    gw.state.afterSet = () => pending.set("gw-a\notto", entry("Thistle", "b"));
    await me.engine.afterRun("pip", KEY, "run-1");
    expect(gw.kept().declined.map((each) => each.name)).toContain("Maple");
    expect([...pending.values()].map((each) => each.name)).toEqual(["Thistle"]);
  });

  it("F-552: a rename that would push out a count of the day before or a later day, which a device on the other side of midnight counts on, isn't made", async () => {
    for (const offset of [24, -24]) {
      const gw = gateway();
      const day = dayOf(NOW + offset * 60 * 60 * 1000);
      const counts = Array.from({ length: MAX_RECORD_COUNTS }, (_, n) => ({
        bot: `bot-${n}`,
        day,
        n: 3,
      }));
      gw.state.record = record({ counts });
      const me = device(gw);
      await me.engine.afterRun("pip", KEY, "run-1");
      expect(gw.state.updates).toEqual([]);
      expect(me.line()).toMatchObject({ status: "not-done", reason: "full" });
      expect(gw.kept().counts).toEqual(counts);
    }
  });

  it("F-552: a claim too old to outlast the rename's request sends nothing; it is taken again first", async () => {
    for (const what of ["rename", "undo"] as const) {
      const gw = gateway();
      const me = device(gw);
      if (what === "undo") await me.engine.afterRun("pip", KEY, "run-1");
      let claimAt: number | undefined;
      gw.state.onUpdate = () => (claimAt = gw.kept().claims[0]?.at);
      // Time passes between the claim and the send.
      gw.state.afterSet = () => (gw.state.now += CLAIM_SEND_MS);
      if (what === "rename") await me.engine.afterRun("pip", KEY, "run-1");
      else await me.engine.undo("pip", runTag("run-1"), "Pip", STAMP);
      expect(claimAt).toBe(NOW + CLAIM_SEND_MS);
      expect(gw.state.updates).toEqual(what === "rename" ? ["Juniper"] : ["Juniper", "Pip"]);
    }
  });

  it("F-552: a rename whose entry another device settled away while it was sent is recorded again once it lands", async () => {
    const gw = gateway();
    const me = device(gw);
    // Another device took the claim for abandoned and took its entry back.
    gw.state.onUpdate = () =>
      (gw.state.record = { ...gw.kept(), changes: [], claims: [] } as unknown);
    await me.engine.afterRun("pip", KEY, "run-1");
    expect(gw.state.updates).toEqual(["Juniper"]);
    expect(gw.kept().changes).toEqual([change({ at: NOW, done: NOW, whose: "bot" })]);
    expect(gw.kept().counts).toEqual([{ bot: "pip", day: dayOf(NOW), n: 1 }]);
    expect(gw.kept().claims).toEqual([]);
  });

  it("F-552: a device past midnight keeps the counts of a device still before it", async () => {
    const gw = gateway();
    // The device before midnight has renamed Pip three times today.
    gw.state.record = record({ counts: [{ bot: "pip", day: dayOf(NOW), n: 3 }] });
    // The device past midnight renames Otto.
    gw.state.now = NOW + 24 * 60 * 60 * 1000;
    await device(gw).engine.afterRun("otto", KEY, "run-1");
    expect(gw.state.updates).toEqual(["Juniper"]);
    expect(gw.kept().counts).toContainEqual({ bot: "pip", day: dayOf(NOW), n: 3 });
    // Back on the earlier day, Pip's fourth rename is refused.
    gw.state.now = NOW;
    gw.state.file = "- **Name:** Maple\n";
    const before = device(gw);
    await before.engine.afterRun("pip", KEY, "run-2");
    expect(gw.state.updates).toEqual(["Juniper"]);
    expect(before.line()).toMatchObject({ status: "not-done", reason: "limit" });
  });

  it("F-552: room for a rename counts the renames still under way: with one place left, a second claim isn't made", async () => {
    const gw = gateway();
    const yesterday = dayOf(NOW - 24 * 60 * 60 * 1000);
    const counts = Array.from({ length: MAX_RECORD_COUNTS - 1 }, (_, n) => ({
      bot: `bot-${n}`,
      day: yesterday,
      n: 1,
    }));
    gw.state.record = record({ counts });
    // Pip's rename holds its claim, paused at its update.
    const held = deferred<void>();
    gw.state.hold = held.promise;
    const first = device(gw);
    const pip = first.engine.afterRun("pip", KEY, "run-1");
    await until(() => gw.kept().claims.length === 1);
    // Another device's rename of Otto meanwhile: no place is left once Pip's is counted.
    gw.state.file = "- **Name:** Maple\n";
    const second = device(gw);
    await second.engine.afterRun("otto", KEY, "run-2");
    expect(second.line()).toBeUndefined();
    expect(second.lines()).toEqual([
      expect.objectContaining({ botId: "otto", status: "not-done", reason: "full" }),
    ]);
    held.resolve();
    await pip;
    expect(gw.state.updates).toEqual(["Juniper"]);
    expect(gw.kept().counts).toHaveLength(MAX_RECORD_COUNTS);
    expect(gw.kept().counts).toContainEqual({ bot: "pip", day: dayOf(NOW), n: 1 });
  });

  it("F-552: a rename whose connection changed after its update is neither read back nor confirmed on the new one", async () => {
    const gw = gateway();
    let generation = "1:1";
    const me = device(gw, { generation: () => generation });
    // Connected again just after the update was sent; the bot list isn't read on the new socket.
    let reads = 0;
    gw.state.onUpdate = () => {
      generation = "2:1";
      const refresh = me.ctx.refreshBots;
      me.ctx.refreshBots = async () => {
        reads += 1;
        return refresh();
      };
    };
    const sets = () => gw.state.sets;
    await me.engine.afterRun("pip", KEY, "run-1");
    expect(gw.state.updates).toEqual(["Juniper"]);
    // The claim and its entry stay, unconfirmed, for the record to settle by the name listed.
    expect(gw.kept().claims).toHaveLength(1);
    expect(gw.kept().changes[0]!.done).toBeUndefined();
    expect(gw.kept().counts).toEqual([]);
    expect(sets()).toBe(1);
    expect(me.line()).toMatchObject({ status: "failed" });
    expect(reads).toBe(0);
  });

  it("F-552: room for a rename counts a rename under way on the day its own device took it: claims on either side of midnight", async () => {
    const gw = gateway();
    // Two devices seconds apart, on either side of midnight.
    const beforeMidnight = Date.parse(`${dayOf(NOW)}T23:59:58Z`);
    const afterMidnight = beforeMidnight + 4000;
    const dayA = dayOf(beforeMidnight);
    expect(dayOf(afterMidnight)).not.toBe(dayA);
    // 31 counts on day A, Pip's among them.
    const counts = Array.from({ length: MAX_RECORD_COUNTS - 1 }, (_, n) => ({
      bot: n === 0 ? "pip" : `bot-${n}`,
      day: dayA,
      n: 1,
    }));
    gw.state.record = record({ counts });
    // A device already on day B claims Pip's rename and pauses at its update.
    gw.state.now = afterMidnight;
    const held = deferred<void>();
    gw.state.hold = held.promise;
    const later = device(gw);
    const pip = later.engine.afterRun("pip", KEY, "run-1");
    await until(() => gw.kept().claims.length === 1);
    // A device still on day A claims Otto's: Pip's count would need a place on day B.
    gw.state.now = beforeMidnight;
    gw.state.file = "- **Name:** Maple\n";
    const earlier = device(gw);
    await earlier.engine.afterRun("otto", KEY, "run-2");
    expect(earlier.lines()).toEqual([
      expect.objectContaining({ botId: "otto", status: "not-done", reason: "full" }),
    ]);
    held.resolve();
    await pip;
    expect(gw.state.updates).toEqual(["Juniper"]);
  });

  it("F-552: a rename claimed before midnight and confirmed after it, its claim expired, is counted on its claim's day", async () => {
    const gw = gateway();
    const beforeMidnight = Date.parse(`${dayOf(NOW)}T23:59:50Z`);
    const dayA = dayOf(beforeMidnight);
    // Day A is full, Pip's count among it.
    const counts = Array.from({ length: MAX_RECORD_COUNTS }, (_, n) => ({
      bot: n === 0 ? "pip" : `bot-${n}`,
      day: dayA,
      n: 1,
    }));
    gw.state.record = record({ counts });
    gw.state.now = beforeMidnight;
    // The rename lands, but its answer and the clean-up after it take past midnight and the
    // claim's expiry.
    const held = deferred<void>();
    gw.state.hold = held.promise;
    const me = device(gw);
    const pip = me.engine.afterRun("pip", KEY, "run-1");
    await until(() => gw.kept().claims.length === 1);
    gw.state.now = beforeMidnight + CLAIM_EXPIRY_MS + 60_000;
    expect(dayOf(gw.state.now)).not.toBe(dayA);
    held.resolve();
    await pip;
    expect(gw.state.updates).toEqual(["Juniper"]);
    expect(me.line()).toMatchObject({ status: "renamed", error: null });
    // Counted on day A, where its claim was: nothing dropped, no place taken on day B.
    expect(gw.kept().counts).toHaveLength(MAX_RECORD_COUNTS);
    expect(gw.kept().counts).toContainEqual({ bot: "pip", day: dayA, n: 2 });
  });

  it("F-552: a rename recorded again after its entry was settled away is counted on its claim's day, past midnight too", async () => {
    const gw = gateway();
    const beforeMidnight = Date.parse(`${dayOf(NOW)}T23:59:50Z`);
    gw.state.now = beforeMidnight;
    // Another device settled the claim and its entry away while the update was on its way, and
    // it is past midnight when the rename is confirmed.
    gw.state.onUpdate = () => {
      gw.state.record = { ...gw.kept(), changes: [], claims: [] } as unknown;
      gw.state.now = beforeMidnight + 30_000;
    };
    await device(gw).engine.afterRun("pip", KEY, "run-1");
    expect(gw.kept().counts).toEqual([{ bot: "pip", day: dayOf(beforeMidnight), n: 1 }]);
  });

  it("F-552: a rename whose claim is written past midnight is listed and counted on that day, not the day it was read", async () => {
    const gw = gateway();
    const beforeMidnight = Date.parse(`${dayOf(NOW)}T23:59:59Z`);
    const dayA = dayOf(beforeMidnight);
    // Pip was renamed twice on day A.
    gw.state.bots = [bot("pip", "Birch"), bot("otto", "Otto")];
    gw.state.record = record({
      changes: [
        change({
          from: "Pip",
          to: "Ash",
          run: runTag("a1"),
          at: beforeMidnight - 60_000,
          done: beforeMidnight - 59_000,
        }),
        change({
          from: "Ash",
          to: "Birch",
          run: runTag("a2"),
          at: beforeMidnight - 30_000,
          done: beforeMidnight - 29_000,
        }),
      ],
      counts: [{ bot: "pip", day: dayA, n: 2 }],
    });
    gw.state.now = beforeMidnight;
    // The claim's write reads the record just after midnight.
    gw.state.onGet = (before) => {
      if (before === 1) gw.state.now = beforeMidnight + 2_000;
    };
    await device(gw).engine.afterRun("pip", KEY, "run-1");
    gw.state.onGet = null;
    expect(gw.state.updates).toEqual(["Juniper"]);
    const kept = gw.kept().changes.find((each) => each.run === runTag("run-1"))!;
    expect(dayOf(kept.at)).not.toBe(dayA);
    // A device still on day A sees two renames of Pip that day, and may make a third.
    gw.state.now = beforeMidnight;
    gw.state.file = "- **Name:** Maple\n";
    const earlier = device(gw);
    await earlier.engine.afterRun("pip", KEY, "run-2");
    expect(gw.state.updates).toEqual(["Juniper", "Maple"]);
  });

  it("F-552: an entry recorded again after it was settled away carries its claim's time", async () => {
    const gw = gateway();
    const beforeMidnight = Date.parse(`${dayOf(NOW)}T23:59:59Z`);
    gw.state.now = beforeMidnight;
    // The claim is written just past midnight; another device then settles its entry away.
    gw.state.onGet = (before) => {
      if (before === 1) gw.state.now = beforeMidnight + 2_000;
    };
    gw.state.onUpdate = () =>
      (gw.state.record = { ...gw.kept(), changes: [], claims: [] } as unknown);
    await device(gw).engine.afterRun("pip", KEY, "run-1");
    const dayB = dayOf(beforeMidnight + 2_000);
    expect(dayOf(gw.kept().changes[0]!.at)).toBe(dayB);
    expect(gw.kept().counts).toEqual([{ bot: "pip", day: dayB, n: 1 }]);
  });

  it("F-552: the day's limit counts a rename on its claim's day, not the day it was confirmed", async () => {
    const gw = gateway();
    const beforeMidnight = Date.parse(`${dayOf(NOW)}T23:59:00Z`);
    const dayA = dayOf(beforeMidnight);
    // Three renames of Pip claimed on day A, confirmed just after midnight, counted on day A.
    const names = ["Pip", "Ash", "Birch", "Cedar"];
    gw.state.bots = [bot("pip", "Cedar"), bot("otto", "Otto")];
    gw.state.record = record({
      changes: [0, 1, 2].map((n) =>
        change({
          from: names[n]!,
          to: names[n + 1]!,
          run: runTag(`r${n}`),
          at: beforeMidnight + n * 10_000,
          done: beforeMidnight + 70_000 + n * 1_000,
        }),
      ),
      counts: [{ bot: "pip", day: dayA, n: 3 }],
    });
    // A rename on day B is its first that day.
    gw.state.now = beforeMidnight + 5 * 60_000;
    const me = device(gw);
    await me.engine.afterRun("pip", KEY, "run-4");
    expect(gw.state.updates).toEqual(["Juniper"]);
  });

  it("F-552: room for a rename counts each rename under way on its own claim's day, across midnight", async () => {
    const beforeMidnight = Date.parse(`${dayOf(NOW)}T23:59:30Z`);
    const dayA = dayOf(beforeMidnight);
    const gw = gateway();
    // 31 places on day A, none of them Pip's or Otto's.
    gw.state.record = record({
      counts: Array.from({ length: MAX_RECORD_COUNTS - 1 }, (_, n) => ({
        bot: `bot-${n}`,
        day: dayA,
        n: 1,
      })),
    });
    // Pip's claim before midnight takes the last place, on day A.
    gw.state.now = beforeMidnight;
    const held = deferred<void>();
    gw.state.hold = held.promise;
    const pip = device(gw).engine.afterRun("pip", KEY, "run-1");
    await until(() => gw.kept().claims.length === 1);
    // Past midnight, Otto's needs a place on day B, and Pip's still needs its own on day A.
    gw.state.now = beforeMidnight + 40_000;
    gw.state.file = "- **Name:** Maple\n";
    const second = device(gw);
    await second.engine.afterRun("otto", KEY, "run-2");
    expect(second.lines()).toEqual([
      expect.objectContaining({ botId: "otto", status: "not-done", reason: "full" }),
    ]);
    held.resolve();
    await pip;
    expect(gw.kept().counts).toContainEqual({ bot: "pip", day: dayA, n: 1 });
  });

  it("F-552: the picture's clean-up writes only on the connection the rename went on, with the config read again just before", async () => {
    const PICTURE = "data:image/png;base64,AAAA";
    const withPicture = (gw: ReturnType<typeof gateway>) => {
      gw.state.picture = [PICTURE];
      // The gateway writes the picture into the file with the name.
      gw.state.onUpdate = () => (gw.state.file = `- Name: Juniper\n- Avatar: ${PICTURE}\n`);
    };
    const ok = gateway();
    withPicture(ok);
    await device(ok).engine.afterRun("pip", KEY, "run-1");
    expect(ok.state.fileSets).toEqual(["- Name: Juniper\n"]);

    // Connected again just after the update: nothing is written on the new socket.
    const moved = gateway();
    withPicture(moved);
    let generation = "1:1";
    const update = moved.state.onUpdate!;
    moved.state.onUpdate = () => {
      update();
      generation = "2:1";
    };
    await device(moved, { generation: () => generation }).engine.afterRun("pip", KEY, "run-1");
    expect(moved.state.updates).toEqual(["Juniper"]);
    expect(moved.state.fileSets).toEqual([]);

    // The picture leaves the config before the write: it lives only in the file now, and stays.
    const gone = gateway();
    withPicture(gone);
    gone.state.picture = [PICTURE, null];
    await device(gone).engine.afterRun("pip", KEY, "run-1");
    expect(gone.state.updates).toEqual(["Juniper"]);
    expect(gone.state.fileSets).toEqual([]);
  });

  it("F-552: a connection that may not change bots writes nothing to the record, an unsaved decline included", async () => {
    const gw = gateway();
    const me = device(gw, { admin: false });
    me.engine["unrecorded"].set("gw-a\npip", {
      stamp: STAMP,
      botId: "pip",
      name: "Juniper",
      run: runTag("r0"),
      file: FILE_TAG,
      op: runTag("o0"),
    });
    await me.engine.afterRun("pip", KEY, "run-1");
    expect(gw.state.sets).toBe(0);
    expect(me.line()).toMatchObject({ status: "not-done", reason: "no-admin" });
  });

  it("F-552: a rename whose confirmation couldn't be saved says so in its line", async () => {
    const gw = gateway();
    const me = device(gw);
    // The claim is saved; the write that confirms the rename isn't.
    gw.state.downAt = 2;
    await me.engine.afterRun("pip", KEY, "run-1");
    expect(gw.state.updates).toEqual(["Juniper"]);
    expect(me.line()).toMatchObject({ status: "renamed", to: "Juniper" });
    expect(me.line()!.error).toContain("couldn't save this rename");
  });

  it("F-552: an earlier build's Not now carries over: the bot doesn't take that name again by itself; the person can ask for it", async () => {
    // As an earlier build kept it on this device: gateway and bot, the name declined.
    const legacy = JSON.stringify({ "gw-a\npip": "Juniper" });

    // The file still names Juniper; an unrelated run writes the file and leaves the name.
    const kept = gateway();
    const a = device(kept, { start: "Juniper" });
    await a.ctx.storage.set(NAME_DECLINES_KEY, legacy);
    await a.engine.afterRun("pip", KEY, "run-1");
    expect(kept.state.updates).toEqual([]);
    expect(await a.ctx.storage.get(NAME_DECLINES_KEY)).toBe(legacy);

    // The bot writes the declined name in a run of its own: not applied, nothing said.
    const itself = gateway();
    const b = device(itself);
    await b.ctx.storage.set(NAME_DECLINES_KEY, legacy);
    await b.engine.afterRun("pip", KEY, "run-1");
    expect(itself.state.updates).toEqual([]);
    expect(b.lines()).toEqual([]);

    // The person asks for it in their own words: applied, with its line.
    const asked = gateway();
    const c = device(asked);
    await c.ctx.storage.set(NAME_DECLINES_KEY, legacy);
    c.engine.sent(KEY, "run-1", "call yourself Juniper");
    await c.engine.afterRun("pip", KEY, "run-1");
    expect(asked.state.updates).toEqual(["Juniper"]);
    expect(c.line()).toMatchObject({ whose: "person", status: "renamed" });
  });

  it("F-552: nothing is sent into a name clash the final read shows: the new name, or the one before, now another bot's", async () => {
    // Another bot takes the new name as the claim is written.
    const taken = gateway();
    taken.state.afterSet = () => (taken.state.bots = [bot("pip", "Pip"), bot("otto", "Juniper")]);
    const a = device(taken);
    await a.engine.afterRun("pip", KEY, "run-1");
    expect(taken.state.updates).toEqual([]);
    expect(a.line()).toMatchObject({ status: "not-done", reason: "taken" });
    expect(taken.kept()).toMatchObject({ changes: [], claims: [] });

    // Another bot takes the name before as the claim is written: Undo couldn't put it back.
    const shared = gateway();
    shared.state.afterSet = () => (shared.state.bots = [bot("pip", "Pip"), bot("otto", "Pip")]);
    const b = device(shared);
    await b.engine.afterRun("pip", KEY, "run-1");
    expect(shared.state.updates).toEqual([]);
    expect(b.line()).toMatchObject({ status: "not-done", reason: "shared" });
    expect(shared.kept()).toMatchObject({ changes: [], claims: [] });
  });

  it("F-552: a bot whose name another bot has too isn't renamed: its Undo couldn't give the name back", async () => {
    const gw = gateway();
    gw.state.bots = [bot("pip", "Pip"), bot("otto", "pip")];
    const me = device(gw);
    await me.engine.afterRun("pip", KEY, "run-1");
    expect(gw.state.updates).toEqual([]);
    expect(me.line()).toMatchObject({ status: "not-done", reason: "shared" });
    // Said before any claim is taken: the record isn't written.
    expect(gw.state.sets).toBe(0);
  });

  it("F-552: Undo sends nothing when the final read shows another bot with the name it puts back", async () => {
    const gw = gateway();
    const me = device(gw);
    await me.engine.afterRun("pip", KEY, "run-1");
    // Otto is renamed Pip as Undo's claim is written.
    gw.state.afterSet = () => (gw.state.bots = [bot("pip", "Juniper"), bot("otto", "Pip")]);
    await expect(me.engine.undo("pip", runTag("run-1"), "Pip", STAMP)).rejects.toThrow(
      "Another bot is called Pip now",
    );
    expect(gw.state.updates).toEqual(["Juniper"]);
    expect(gw.kept().claims).toEqual([]);
  });

  it("F-552: another device's Undo is confirmed only from a bot list fetched after its claim", async () => {
    const gw = gateway();
    // B's and C's bot lists are from before the rename: they still show Pip.
    const b = device(gw, { cached: true });
    const c = device(gw, { cached: true });
    const a = device(gw);
    await a.engine.afterRun("pip", KEY, "run-1");
    // A has claimed its Undo, which hasn't landed: the gateway lists Juniper.
    const kept = gw.kept();
    gw.state.record = {
      ...kept,
      claims: [{ bot: "pip", op: runTag("undo-a"), run: runTag("run-1"), at: NOW, undo: true }],
    } as unknown;
    // B writes the record for a rename of its own.
    gw.state.file = "- **Name:** Maple\n";
    await b.engine.afterRun("otto", KEY, "run-2");
    expect(gw.state.updates).toEqual(["Juniper", "Maple"]);
    const after = gw.kept();
    expect(after.changes.find((each) => each.bot === "pip")!.undone).toBeUndefined();
    expect(after.declined).toEqual([]);
    expect(after.claims.some((each) => each.undo)).toBe(true);

    // The list can't be fetched as the record is written: C's own, from before, confirms nothing.
    const refresh = c.ctx.refreshBots;
    let fails = 1;
    c.ctx.refreshBots = async () => {
      if (fails-- > 0) throw new Error("no answer");
      return refresh();
    };
    gw.state.file = "- **Name:** Thistle\n";
    await c.engine.afterRun("otto", KEY, "run-3");
    expect(gw.kept().changes.find((each) => each.bot === "pip")!.undone).toBeUndefined();

    // A's Undo lands: a list fetched now shows it, and the next write here confirms it.
    gw.state.bots = gw.state.bots.map((each) =>
      each.id === "pip" ? { ...each, name: "Pip" } : each,
    );
    gw.state.file = "- **Name:** Birch\n";
    await c.engine.afterRun("otto", KEY, "run-4");
    expect(gw.kept().changes.find((each) => each.bot === "pip")!.undone).toBe(NOW);
  });

  it("F-552: Undo can be pressed again: after a refusal its claim is let go, and after an unread outcome it takes its own claim again", async () => {
    // Refused: nothing written, the claim goes, and a second press works.
    const refused = gateway();
    const a = device(refused);
    await a.engine.afterRun("pip", KEY, "run-1");
    refused.state.update = "refused";
    await expect(a.engine.undo("pip", runTag("run-1"), "Pip", STAMP)).rejects.toThrow();
    expect(refused.kept().claims).toEqual([]);
    refused.state.update = "ok";
    await a.engine.undo("pip", runTag("run-1"), "Pip", STAMP);
    expect(refused.state.updates).toEqual(["Juniper", "Pip"]);

    // No answer and no list: the claim stays, and pressing again takes it, not "busy".
    const unread = gateway();
    const b = device(unread);
    await b.engine.afterRun("pip", KEY, "run-1");
    unread.state.update = "dropped";
    const listed = b.ctx.refreshBots;
    unread.state.onUpdate = () =>
      (b.ctx.refreshBots = async () => {
        throw new Error("no answer");
      });
    await b.engine.undo("pip", runTag("run-1"), "Pip", STAMP);
    expect(unread.kept().claims).toHaveLength(1);
    b.ctx.refreshBots = listed;
    unread.state.update = "ok";
    await b.engine.undo("pip", runTag("run-1"), "Pip", STAMP);
    expect(unread.state.updates).toEqual(["Juniper", "Pip"]);
    expect(b.line()).toMatchObject({ status: "undone", after: "Pip" });
    expect(unread.kept().claims).toEqual([]);
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
    me.engine.dismiss("pip", runTag("another run"), STAMP);
    expect(me.line()).toMatchObject({ run: runTag("run-1") });
    me.engine.dismiss("pip", runTag("run-1"), STAMP);
    expect(me.lines()).toEqual([]);
  });

  it("F-552: a Close pressed before the target changed doesn't put away the same change's line read again after it", async () => {
    const gw = gateway();
    let stamp = STAMP;
    const me = device(gw, { stamp: () => stamp });
    await me.engine.afterRun("pip", KEY, "run-1");
    // Connected again: the record brings back the same change's line under the new target.
    stamp = { gatewayId: "gw-a", target: 2 };
    me.engine.reset();
    await me.engine.onPrefsChanged([NAME_RECORD_KEY]);
    me.engine.onBots(gw.state.bots);
    expect(me.line()).toMatchObject({ run: runTag("run-1"), stamp });
    const sent = gw.state.sets;
    me.engine.dismiss("pip", runTag("run-1"), STAMP);
    expect(me.line()).toMatchObject({ run: runTag("run-1") });
    me.engine.dismiss("pip", runTag("run-1"), stamp);
    expect(me.lines()).toEqual([]);
    expect(gw.state.sets).toBe(sent);
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
  async function namingClient(options: { identityFails?: number; owner?: boolean } = {}) {
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
    // The gateway runs a message under its idempotency key (`chat-send-handler`, both versions),
    // and stores it with `senderIsOwner` when the sender holds admin; history returns those rows.
    const sent: Array<{ message: string; key: string; at: number }> = [];
    gw.handlers["chat.send"] = (params) => {
      const { message, idempotencyKey } = params as { message: string; idempotencyKey: string };
      sent.push({ message, key: idempotencyKey, at: Date.now() });
      return { runId: idempotencyKey, status: "started" };
    };
    gw.handlers["chat.history"] = () => ({
      messages: sent.map((each, n) => ({
        role: "user",
        content: each.message,
        timestamp: each.at,
        __openclaw: {
          id: `u-${n}`,
          seq: n + 1,
          idempotencyKey: each.key,
          ...((options.owner ?? true) ? { senderIsOwner: true } : {}),
        },
      })),
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
      // Reads asked again at once: a failing one settles within the test.
      client: { nameClaimDelayMs: 0, readAgainMs: 1 },
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
    /** The run `id` starts, and its IDENTITY.md is read as the run finds it. */
    const begin = async (id: string) => {
      const reads = gw.calls("agents.files.get").length;
      gw.emit("agent", agentEvent(id, 1, "lifecycle", { phase: "start" }, "agent:new-bot:main"));
      await until(() => gw.calls("agents.files.get").length > reads);
      await sleep(20);
    };
    return { client, gw, files, bots, edit, begin, sent };
  }

  it("F-552: a name the bot writes in a run this device sent is the person's ask, applied with the picture kept out of its file, and Undo puts back the name it names", async () => {
    const { client, gw, files, bots, edit, begin } = await namingClient();
    try {
      const id = client.sendMessage("agent:new-bot:main", "call yourself Johnny");
      await until(() => gw.calls("chat.send").length === 1);
      await begin(id);
      edit(id, "Johnny", 2);
      gw.emit("agent", agentEvent(id, 4, "lifecycle", { phase: "end" }, "agent:new-bot:main"));
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

  /** The run's end was checked: its file and history read, and whatever it led to done. */
  async function settledEnd(gw: { calls: (method: string) => unknown[] }, reads: number) {
    await until(() => gw.calls("agents.files.get").length > reads, 10_000);
    await sleep(200);
  }

  it("F-552: a run whose message the gateway didn't store as the owner's renames nothing", async () => {
    const { client, gw, edit, begin } = await namingClient({ owner: false });
    try {
      const id = client.sendMessage("agent:new-bot:main", "call yourself Johnny");
      await until(() => gw.calls("chat.send").length === 1);
      await begin(id);
      edit(id, "Johnny", 2);
      const reads = gw.calls("agents.files.get").length;
      gw.emit("agent", agentEvent(id, 4, "lifecycle", { phase: "end" }, "agent:new-bot:main"));
      await settledEnd(gw, reads);
      expect(gw.calls("agents.update")).toEqual([]);
      expect(client.state.botNames ?? []).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("F-552: a start read served after the run wrote the file finds the run's own name: nothing is renamed", async () => {
    const { client, gw, edit } = await namingClient();
    try {
      const id = client.sendMessage("agent:new-bot:main", "call yourself Johnny");
      await until(() => gw.calls("chat.send").length === 1);
      // The start read is answered only after the run's edit of the file began.
      const read = gw.handlers["agents.files.get"]!;
      const held = deferred<void>();
      gw.handlers["agents.files.get"] = async (params) => {
        await held.promise;
        return read(params);
      };
      gw.emit("agent", agentEvent(id, 1, "lifecycle", { phase: "start" }, "agent:new-bot:main"));
      await until(() => gw.calls("agents.files.get").length === 1);
      edit(id, "Johnny", 2);
      await sleep(20);
      gw.handlers["agents.files.get"] = read;
      held.resolve();
      await sleep(20);
      gw.emit("agent", agentEvent(id, 4, "lifecycle", { phase: "end" }, "agent:new-bot:main"));
      await settledEnd(gw, 1);
      expect(gw.calls("agents.update")).toEqual([]);
      expect(client.state.botNames ?? []).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("F-552: a name another writer put in the file before the run started isn't this run's change", async () => {
    const { client, gw, files, edit, begin } = await namingClient();
    try {
      // Someone else wrote Johnny into the file; the bot's own name is still New bot.
      files.content = "- **Name:** Johnny\n";
      const id = client.sendMessage("agent:new-bot:main", "call yourself Johnny");
      await until(() => gw.calls("chat.send").length === 1);
      await begin(id);
      // The run writes the file, leaving the name as it found it.
      edit(id, "Johnny", 2);
      const reads = gw.calls("agents.files.get").length;
      gw.emit("agent", agentEvent(id, 4, "lifecycle", { phase: "end" }, "agent:new-bot:main"));
      await settledEnd(gw, reads);
      expect(gw.calls("agents.update")).toEqual([]);
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
    const { client, gw, edit, begin } = await namingClient();
    try {
      const id = client.sendMessage("agent:new-bot:main", "call yourself Johnny");
      await until(() => gw.calls("chat.send").length === 1);
      await begin(id);
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
          row(1, "call yourself Johnny", { idempotencyKey: id, senderIsOwner: true }),
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

  it("F-552: a run whose history can't be read at its end renames nothing: who sent it isn't known", async () => {
    const { client, gw, edit, begin } = await namingClient();
    try {
      const id = client.sendMessage("agent:new-bot:main", "call yourself Johnny");
      await until(() => gw.calls("chat.send").length === 1);
      await begin(id);
      edit(id, "Johnny", 2);
      gw.handlers["chat.history"] = () => {
        throw new Error("the gateway was busy");
      };
      const reads = gw.calls("agents.files.get").length;
      gw.emit("agent", agentEvent(id, 4, "lifecycle", { phase: "end" }, "agent:new-bot:main"));
      await settledEnd(gw, reads);
      await sleep(300);
      expect(gw.calls("agents.update")).toEqual([]);
      expect(client.state.botNames ?? []).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("F-552: a task without live updates has no history read shown to cover the run's end: it renames nothing", async () => {
    const { client, gw, edit, begin } = await namingClient();
    const key = "agent:new-bot:main";
    try {
      // A read fails, and Try again can't start the task's live updates: a read at the run's end
      // then can't be told from a failed one.
      gw.handlers["sessions.messages.subscribe"] = () => {
        throw new Error("the gateway was busy");
      };
      const history = gw.handlers["chat.history"];
      gw.handlers["chat.history"] = () => {
        throw new Error("the gateway was busy");
      };
      client.reloadSession(key);
      await until(() => client.state.transcripts[key]?.status === "error");
      if (history) gw.handlers["chat.history"] = history;
      else delete gw.handlers["chat.history"];
      client.reloadSession(key);
      await until(() => client.state.transcripts[key]?.error === LIVE_UPDATES_NOT_STARTED);
      const id = client.sendMessage(key, "call yourself Johnny");
      await until(() => gw.calls("chat.send").length === 1);
      await begin(id);
      edit(id, "Johnny", 2);
      const reads = gw.calls("agents.files.get").length;
      gw.emit("agent", agentEvent(id, 4, "lifecycle", { phase: "end" }, key));
      await settledEnd(gw, reads);
      expect(gw.calls("agents.update")).toEqual([]);
      expect(client.state.botNames ?? []).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("F-552: a history read that failed and was tried again at once isn't read: it renames nothing", async () => {
    const { client, gw, edit, begin } = await namingClient();
    const key = "agent:new-bot:main";
    let stop = () => {};
    try {
      const id = client.sendMessage(key, "call yourself Johnny");
      await until(() => gw.calls("chat.send").length === 1);
      await begin(id);
      edit(id, "Johnny", 2);
      // A read already on its way when the run ends, answered only after the history read began.
      const history = gw.handlers["chat.history"]!;
      const held = deferred<void>();
      let reads = 0;
      gw.handlers["chat.history"] = async (params) => {
        reads += 1;
        if (reads === 1) {
          await held.promise;
          return history(params);
        }
        // The read asked for at the run's end fails.
        throw new Error("the gateway was busy");
      };
      client.reloadSession(key);
      await until(() => reads === 1);
      const fileReads = gw.calls("agents.files.get").length;
      gw.emit("agent", agentEvent(id, 4, "lifecycle", { phase: "end" }, key));
      // The history read is queued behind the one on its way.
      await until(() => (client["loads"].get(key)?.again ?? null) !== null);
      // Try again, pressed as soon as the failure shows, sets the task loading.
      stop = client.store.subscribe((state) => {
        if (state.transcripts[key]?.status === "error") client.reloadSession(key);
      });
      held.resolve();
      await settledEnd(gw, fileReads);
      expect(gw.calls("agents.update")).toEqual([]);
      expect(client.state.botNames ?? []).toEqual([]);
    } finally {
      stop();
      client.stop();
    }
  });

  it("F-552: a steer this device sent into the run makes the rename the bot's own", async () => {
    const { client, gw, edit, begin } = await namingClient();
    try {
      const id = client.sendMessage("agent:new-bot:main", "call yourself Johnny");
      await until(() => gw.calls("chat.send").length === 1);
      await begin(id);
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
