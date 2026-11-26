// A bot that takes a name in the chat (F-552): the name it writes on its IDENTITY.md's
// `- Name:` line is applied at once by one device, kept in the record of changes on the gateway
// (`users.prefs`), and shown with Undo. The answers are as a development gateway gave them on
// OpenClaw 2026.10.6 and 2026.11.10: `agents.files.get` needs read, `agents.update` admin, and
// `users.prefs.set` is a compare-and-set of one value of at most 4,096 bytes.

import { describe, expect, it } from "vitest";
import { identityFile } from "../src/accounts-engine.ts";
import {
  BotNames,
  type BotNamesContext,
  canUndoName,
  fitNameRecord,
  identityName,
  judgeRename,
  MAX_BOT_NAME_CHARS,
  MAX_RECORD_BYTES,
  MAX_RECORD_CHANGES,
  NAME_RECORD_KEY,
  parseNameRecord,
  plainName,
  runTag,
  UNDO_WINDOW_MS,
  type RunStepFacts,
} from "../src/bot-names.ts";
import { utf8Length } from "../src/encoding.ts";
import { ADMIN_SCOPES } from "../src/scopes.ts";
import type { Bot, GatewayStamp, NameLine, NameRecordChange } from "../src/types.ts";
import { agentEvent, grantingGateway, openTask, URL_A } from "./client-harness.ts";
import { memoryStorage, tokenKey, until } from "./fake-gateway.ts";

const NOW = 1_795_000_000_000;
const STAMP: GatewayStamp = { gatewayId: "gw-a", target: 1 };
const bot = (id: string, name: string): Bot => ({
  id,
  name,
  emoji: null,
  avatarUrl: null,
  theme: null,
  model: null,
  isDefault: false,
});
const READ_OWN: RunStepFacts = { toolName: "read", args: '{"path":"IDENTITY.md"}' };
const EDIT_OWN: RunStepFacts = { toolName: "edit", args: '{"path":"IDENTITY.md","edits":[]}' };
const change = (patch: Partial<NameRecordChange> = {}): NameRecordChange => ({
  bot: "pip",
  field: "name",
  from: "Pip",
  to: "Juniper",
  at: NOW - 1_000,
  run: runTag("run-1"),
  asked: true,
  source: null,
  ...patch,
});

describe("F-552: whose ask a rename was", () => {
  const facts = { sentHere: true, text: "call yourself Juniper", steps: [READ_OWN, EDIT_OWN] };

  it("F-552: the person's ask only when this device sent the run, nothing outside was read first, and the name is in what they typed", () => {
    expect(judgeRename(facts, "Juniper")).toEqual({ asked: true, source: null });
    // Each of the three failing in turn.
    expect(judgeRename({ ...facts, sentHere: false }, "Juniper").asked).toBe(false);
    expect(
      judgeRename(
        { ...facts, steps: [{ toolName: "web_fetch", args: "{}" }, READ_OWN, EDIT_OWN] },
        "Juniper",
      ),
    ).toEqual({ asked: false, source: "web" });
    expect(judgeRename({ ...facts, text: "you choose a name" }, "Juniper").asked).toBe(false);
  });

  it("F-552: the check is necessary, not proof: a message refusing the name passes it", () => {
    expect(judgeRename({ ...facts, text: "Don't rename yourself Juniper" }, "Juniper").asked).toBe(
      true,
    );
  });

  it("F-552: reading another file or a tool's output first says where it came from; steps unknown count as read", () => {
    const after = (step: RunStepFacts) =>
      judgeRename({ ...facts, steps: [step, EDIT_OWN] }, "Juniper");
    expect(after({ toolName: "read", args: '{"path":"notes/page.md"}' }).source).toBe("file");
    expect(after({ toolName: "exec", args: '{"command":"cat x"}' }).source).toBe("tool");
    expect(after({ toolName: "sessions_send", args: "{}" }).asked).toBe(true);
    expect(judgeRename({ ...facts, steps: null }, "Juniper").asked).toBe(false);
    // A step after the edit isn't before it.
    expect(
      judgeRename(
        { ...facts, steps: [EDIT_OWN, { toolName: "web_search", args: "{}" }] },
        "Juniper",
      ).asked,
    ).toBe(true);
    // Case and spacing don't count; the name has to be there.
    expect(judgeRename({ ...facts, text: "call yourself   JUNIPER" }, "Juniper").asked).toBe(true);
  });
});

describe("F-552: the record of changes", () => {
  it("F-552: a forged or malformed entry offers nothing: wrong field, a name that isn't plain, a bad tag, too old, in the future", () => {
    const record = parseNameRecord(
      {
        rev: 3,
        changes: [
          change(),
          change({ run: "1".repeat(16), field: "instructions" as "name" }),
          change({ run: "2".repeat(16), from: "  Pip  " }),
          change({ run: "zz" }),
          change({ run: "3".repeat(16), at: NOW - UNDO_WINDOW_MS - 1 }),
          change({ run: "4".repeat(16), at: NOW + 60 * 60 * 1000 }),
          change({ run: "5".repeat(16), to: "x".repeat(MAX_BOT_NAME_CHARS + 1) }),
          "not an entry",
        ],
        declined: [
          { bot: "pip", name: "Maple" },
          { bot: "", name: "Maple" },
        ],
      },
      NOW,
    );
    expect(record.rev).toBe(3);
    expect(record.changes).toEqual([change()]);
    expect(record.declined).toEqual([{ bot: "pip", name: "Maple" }]);
    expect(parseNameRecord("junk", NOW)).toEqual({ rev: 0, changes: [], declined: [] });
  });

  it("F-552: the record keeps the newest entries that fit the gateway's 4,096 bytes, at most eight changes", () => {
    const long = "\u{1F980}".repeat(MAX_BOT_NAME_CHARS);
    const changes = Array.from({ length: 12 }, (_, n) =>
      change({
        bot: "b".repeat(128),
        from: long,
        to: `${"\u{1F980}".repeat(MAX_BOT_NAME_CHARS - 2)}${n}`,
        run: runTag(`r${n}`),
      }),
    );
    const fitted = fitNameRecord({ rev: 1, changes, declined: [] });
    expect(utf8Length(JSON.stringify(fitted))).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    // Eight such changes would pass the gateway's limit: fewer are kept, the newest.
    expect(fitted.changes.length).toBeLessThan(MAX_RECORD_CHANGES);
    expect(fitted.changes.at(-1)).toEqual(changes.at(-1));
  });

  it("F-552: Undo is offered only for the latest change of a bot still called what it made it, not undone, within seven days", () => {
    const bots = [bot("pip", "Juniper")];
    expect(canUndoName(change(), [change()], bots, NOW)).toBe(true);
    expect(canUndoName(change(), [change()], [bot("pip", "Maple")], NOW)).toBe(false);
    expect(canUndoName(change({ undone: NOW }), [change()], bots, NOW)).toBe(false);
    const later = change({ run: runTag("run-2"), from: "Juniper", to: "Juniper" });
    expect(canUndoName(change(), [change(), later], bots, NOW)).toBe(false);
    expect(canUndoName(change(), [change()], bots, NOW + UNDO_WINDOW_MS + 1)).toBe(false);
  });
});

/** A gateway's answers for the engine: one bot file, the bot list and the shared record. */
function gateway(options: { prefs?: "ok" | "none"; file?: string } = {}) {
  const state = {
    bots: [bot("pip", "Pip"), bot("otto", "Otto")],
    file: options.file ?? "- **Name:** Juniper\n",
    record: undefined as unknown,
    updates: [] as string[],
    meddle: null as null | (() => void),
  };
  const request = async (method: string, raw: unknown): Promise<unknown> => {
    const params = raw as Record<string, unknown>;
    if (method === "agents.files.get")
      return { file: { content: state.file, hash: "a".repeat(64) } };
    if (method === "config.get") return { config: {} };
    if (method === "agents.update") {
      state.updates.push(String(params.name));
      state.bots = state.bots.map((b) =>
        b.id === params.agentId ? { ...b, name: String(params.name) } : b,
      );
      return { ok: true };
    }
    if (options.prefs === "none") return { status: "no_durable_identity" };
    if (method === "users.prefs.get")
      return {
        status: "ok",
        entries: state.record === undefined ? {} : { [NAME_RECORD_KEY]: state.record },
      };
    if (method === "users.prefs.set") {
      state.meddle?.();
      state.meddle = null;
      const expected = (params.expectedEntries as Record<string, unknown>)[NAME_RECORD_KEY];
      if (JSON.stringify(expected ?? null) !== JSON.stringify(state.record ?? null))
        return { status: "conflict" };
      state.record = (params.entries as Record<string, unknown>)[NAME_RECORD_KEY];
      return { status: "ok" };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { state, request };
}

/** One device's engine on that gateway. */
function device(
  gw: ReturnType<typeof gateway>,
  options: { admin?: boolean; steps?: RunStepFacts[] | null; claim?: () => Promise<void> } = {},
) {
  let lines: NameLine[] = [];
  const published: NameLine[][] = [];
  let record: { changes: NameRecordChange[] } | null = null;
  const ctx: BotNamesContext = {
    request: gw.request,
    bots: () => gw.state.bots,
    canRename: () => options.admin ?? true,
    stamp: () => STAMP,
    sameGateway: async () => {},
    storage: memoryStorage(),
    takeRead: () => () => {},
    refreshBots: async () => {},
    runSteps: () => (options.steps === undefined ? [READ_OWN, EDIT_OWN] : options.steps),
    missingScope: () => false,
    now: () => NOW,
    waitToClaim: options.claim ?? (async () => {}),
    publishLines: (each) => {
      lines = each;
      published.push(each);
    },
    publishRecord: (each) => (record = each),
    log: () => {},
  };
  const engine = new BotNames(ctx);
  return { engine, lines: () => lines, published, record: () => record };
}

describe("F-552: a bot that takes a name is renamed, with Undo", () => {
  it("F-552: the person's ask is renamed at once, recorded with the name before, and the line says what happened", async () => {
    const gw = gateway();
    const me = device(gw);
    me.engine.sent("agent:pip:main", "run-1", "call yourself Juniper");
    await me.engine.afterRun("pip", "agent:pip:main", "run-1");
    expect(gw.state.updates).toEqual(["Juniper"]);
    expect(me.lines()).toEqual([
      expect.objectContaining({ from: "Pip", to: "Juniper", asked: true, status: "renamed" }),
    ]);
    expect(parseNameRecord(gw.state.record, NOW).changes).toEqual([
      change({ at: NOW, asked: true }),
    ]);
  });

  it("F-552: a run this device didn't send waits before it applies, and is the bot's own doing", async () => {
    const gw = gateway();
    let waited = false;
    const other = device(gw, {
      claim: async () => {
        waited = true;
      },
    });
    await other.engine.afterRun("pip", "agent:pip:main", "run-1");
    expect(waited).toBe(true);
    expect(other.lines()[0]).toMatchObject({ asked: false, status: "renamed" });
  });

  it("F-552: with two devices open, the one that sent the run applies it, and the other only shows it", async () => {
    const gw = gateway();
    const sender = device(gw);
    const other = device(gw);
    sender.engine.sent("agent:pip:main", "run-1", "call yourself Juniper");
    await Promise.all([
      other.engine.afterRun("pip", "agent:pip:main", "run-1"),
      sender.engine.afterRun("pip", "agent:pip:main", "run-1"),
    ]);
    expect(gw.state.updates).toEqual(["Juniper"]);
    expect(other.lines()[0]).toMatchObject({ status: "renamed", asked: true });
  });

  it("F-552: two devices that both claim at once apply it once: the second write finds the change there", async () => {
    const gw = gateway();
    const a = device(gw);
    const b = device(gw);
    // Device b's claim lands between a's read and a's write.
    gw.state.meddle = () => {
      gw.state.record = { rev: 1, changes: [change({ at: NOW, asked: false })], declined: [] };
    };
    await a.engine.afterRun("pip", "agent:pip:main", "run-1");
    void b;
    expect(gw.state.updates).toEqual([]);
    expect(a.lines()[0]).toMatchObject({ status: "renamed", asked: false });
  });

  it("F-552: not done, and said: no admin, a name another bot has, past three renames today, and no record to keep the way back", async () => {
    const noAdmin = device(gateway(), { admin: false });
    await noAdmin.engine.afterRun("pip", "agent:pip:main", "run-1");
    expect(noAdmin.lines()[0]).toMatchObject({ status: "not-done", reason: "no-admin" });

    const taken = gateway({ file: "- Name: otto\n" });
    const t = device(taken);
    await t.engine.afterRun("pip", "agent:pip:main", "run-1");
    expect(t.lines()[0]).toMatchObject({ status: "not-done", reason: "taken" });

    const busy = gateway();
    busy.state.record = {
      rev: 3,
      changes: [1, 2, 3].map((n) => change({ run: runTag(`old-${n}`), at: NOW - n * 1000 })),
      declined: [],
    };
    const limited = device(busy);
    await limited.engine.afterRun("pip", "agent:pip:main", "run-1");
    expect(limited.lines()[0]).toMatchObject({ status: "not-done", reason: "limit" });

    const none = gateway({ prefs: "none" });
    const n = device(none);
    await n.engine.afterRun("pip", "agent:pip:main", "run-1");
    expect(n.lines()[0]).toMatchObject({ status: "not-done", reason: "no-record" });
    expect([taken, busy, none].flatMap((g) => g.state.updates)).toEqual([]);
  });

  it("F-552: Undo puts the name before back, marks the change undone and declines the name, so the same edit doesn't rename the bot again", async () => {
    const gw = gateway();
    const me = device(gw);
    await me.engine.afterRun("pip", "agent:pip:main", "run-1");
    await me.engine.undo("pip", runTag("run-1"), STAMP);
    expect(gw.state.updates).toEqual(["Juniper", "Pip"]);
    expect(me.lines()[0]).toMatchObject({ status: "undone" });
    const kept = parseNameRecord(gw.state.record, NOW);
    expect(kept.changes[0]!.undone).toBe(NOW);
    expect(kept.declined).toEqual([{ bot: "pip", name: "Juniper" }]);
    // The bot writes the same name again: nothing is renamed.
    await me.engine.afterRun("pip", "agent:pip:main", "run-2");
    expect(gw.state.updates).toEqual(["Juniper", "Pip"]);
  });

  it("F-552: Undo refuses a name changed again, a forged entry, one too old, and one another device undid", async () => {
    const renamedAgain = gateway();
    const a = device(renamedAgain);
    await a.engine.afterRun("pip", "agent:pip:main", "run-1");
    renamedAgain.state.bots = [bot("pip", "Maple")];
    await expect(a.engine.undo("pip", runTag("run-1"), STAMP)).rejects.toThrow(
      "can no longer be undone",
    );

    const forged = gateway();
    forged.state.bots = [bot("pip", "Juniper")];
    forged.state.record = { rev: 1, changes: [change({ from: "<b>x</b>\n" })], declined: [] };
    await expect(device(forged).engine.undo("pip", runTag("run-1"), STAMP)).rejects.toThrow();

    const old = gateway();
    old.state.bots = [bot("pip", "Juniper")];
    old.state.record = { rev: 1, changes: [change({ at: NOW - UNDO_WINDOW_MS - 1 })] };
    await expect(device(old).engine.undo("pip", runTag("run-1"), STAMP)).rejects.toThrow();

    const shared = gateway();
    const mine = device(shared);
    await mine.engine.afterRun("pip", "agent:pip:main", "run-1");
    await device(shared).engine.undo("pip", runTag("run-1"), STAMP);
    await mine.engine.onPrefsChanged([NAME_RECORD_KEY]);
    expect(mine.lines()[0]).toMatchObject({ status: "undone" });
    await expect(mine.engine.undo("pip", runTag("run-1"), STAMP)).rejects.toThrow();
    for (const each of [renamedAgain, forged, old, shared])
      expect(each.state.updates.filter((name) => name === "Pip").length).toBeLessThanOrEqual(1);
  });

  it("F-552: a name already declined is left alone, and the default bot is never read", async () => {
    const gw = gateway();
    gw.state.record = { rev: 1, changes: [], declined: [{ bot: "pip", name: "Juniper" }] };
    const me = device(gw);
    await me.engine.afterRun("pip", "agent:pip:main", "run-1");
    expect(gw.state.updates).toEqual([]);
    // Nothing is shown, not even for a moment.
    expect(me.published).toEqual([]);
    gw.state.bots = [{ ...bot("pip", "Pip"), isDefault: true }];
    await me.engine.afterRun("pip", "agent:pip:main", "run-2");
    expect(me.lines()).toEqual([]);
  });

  it("F-552: names are read as the gateway reads them, and made plain and bounded as a rename saves them", () => {
    expect(identityName("- **Name:** Johnny\n- Name: (pick something you like)\n")).toBe("Johnny");
    expect(identityName(identityFile("New bot", false))).toBe("New bot");
    expect(plainName("  <b>Jo</b>\u0000\n\u202eX  ")).toBe("<b>Jo</b> X");
    expect(Array.from(plainName("y".repeat(10_000))!)).toHaveLength(MAX_BOT_NAME_CHARS);
  });
});

describe("F-552: through the client", () => {
  it("F-552: a name the bot writes after this device's message is applied, the picture kept out of its file, and Undo is offered", async () => {
    const files = { content: "- **Name:** New bot\n" };
    const held = ADMIN_SCOPES;
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: held,
        heldScopes: held.filter((scope) => scope !== "operator.admin"),
        adminHeld: true,
      }),
    });
    const gw = grantingGateway();
    gw.handlers["gateway.identity.get"] = () => ({ deviceId: "gw-a" });
    let name = "New bot";
    let record: unknown;
    gw.handlers["agents.list"] = () => ({
      defaultId: "main",
      agents: [{ id: "main" }, { id: "new-bot", name, identity: { name } }],
    });
    gw.handlers["agents.files.get"] = () => ({
      file: { content: files.content, hash: "b".repeat(64) },
    });
    // The bot's picture is in its config; `agents.update` copies it into the file with the name.
    const picture = `data:image/png;base64,${"A".repeat(3_000)}`;
    gw.handlers["config.get"] = () => ({
      config: { agents: { entries: { "new-bot": { identity: { name, avatar: picture } } } } },
    });
    gw.handlers["agents.update"] = (params) => {
      name = String((params as { name: string }).name);
      files.content = `- Name: ${name}\n- Avatar: ${picture}\n`;
      return { ok: true };
    };
    gw.handlers["agents.files.set"] = (params) => {
      files.content = String((params as { content: string }).content);
      return { ok: true };
    };
    gw.handlers["users.prefs.get"] = () => ({
      status: "ok",
      entries: record === undefined ? {} : { [NAME_RECORD_KEY]: record },
    });
    gw.handlers["users.prefs.set"] = (params) => {
      record = (params as { entries: Record<string, unknown> }).entries[NAME_RECORD_KEY];
      return { status: "ok" };
    };
    const { client } = await openTask({
      gateway: gw,
      storage,
      held,
      key: "agent:new-bot:main",
      client: { nameClaimDelayMs: 0 },
    });
    const id = client.sendMessage("agent:new-bot:main", "#take-name Johnny");
    await until(() => gw.calls("chat.send").length === 1);
    files.content = "- **Name:** Johnny\n";
    gw.emit("agent", agentEvent(id, 1, "lifecycle", { phase: "end" }, "agent:new-bot:main"));
    await until(() => client.state.botNames?.[0]?.status === "renamed");
    expect(client.state.botNames![0]).toMatchObject({ from: "New bot", to: "Johnny", asked: true });
    expect(client.state.botNameRecord?.changes).toHaveLength(1);
    expect(files.content).toBe("- Name: Johnny\n");
    await client.undoBotName(
      "new-bot",
      client.state.botNames![0]!.run,
      client.state.botNames![0]!.stamp,
    );
    expect(name).toBe("New bot");
    expect(client.state.botNames![0]!.status).toBe("undone");
    client.stop();
  });
});
