// Deleting a bot (bot-delete.ts) against a gateway shaped as OpenClaw 2026.10.6
// answers `agents.list` and `agents.delete`: a journal that a second call for
// an unlisted id resumes, `failed[]` and `purgeFailed` on an `ok` answer, and
// its refusals. Then the client: one gateway and one connection per delete,
// one delete at a time, and a deleted bot's queued work let go. Bots, folders
// and reasons are made up.
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { describe, expect, it } from "vitest";
import {
  deleteBot,
  deleteFacts,
  foldersOverlap,
  MAX_DELETE_PATHS,
  MAX_DELETE_RESULT_CHARS,
  partialCleanup,
  readBotDelete,
  readDeleteAnswer,
  reviewOf,
  type BotDeleteContext,
  type BotDeleteRead,
  type DeleteRequest,
} from "../src/bot-delete.ts";
import {
  createBridgeSession,
  MAX_VIEWER_PENDING_COMMANDS,
  parseBridgeCommand,
} from "../src/bridge.ts";
import { isActive } from "../src/runs.ts";
import { ADMIN_SCOPES } from "../src/scopes.ts";
import {
  agentEvent,
  grantingGateway,
  openTask,
  questionRecord,
  sentTexts,
  URL_A,
  URL_B,
} from "./client-harness.ts";
import { deferred, GatewayError, memoryStorage, sleep, tokenKey, until } from "./fake-gateway.ts";
import { toBase64 } from "../src/bytes.ts";
import { SHOT, sentRow, solidPng } from "./sent-attachments-rows.ts";

type Json = Record<string, unknown>;
type Agent = { id: string; name: string; workspace?: string; createdAt?: number };

const GATEWAY = "gateway-a";
const STAMP = { gatewayId: GATEWAY, target: 1 };
const refusal = (message: string) =>
  new GatewayProtocolRequestError({ code: "INVALID_REQUEST", message });

const BOTS: Agent[] = [
  { id: "main", name: "Juniper", workspace: "/srv/claw/workspace", createdAt: 1 },
  { id: "pip", name: "Pip", workspace: "/srv/claw/workspaces/pip", createdAt: 2 },
  { id: "marlow", name: "Marlow", workspace: "/srv/claw/workspaces/marlow", createdAt: 3 },
];

const rosterOf = (bots: Agent[]) => ({
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: bots.map((bot) => ({
    id: bot.id,
    name: bot.name,
    ...(bot.workspace === undefined ? {} : { workspace: bot.workspace }),
    ...(bot.createdAt === undefined ? {} : { createdAt: bot.createdAt }),
  })),
});

/** A gateway whose bots live in memory; `agents.delete` answers as `answers` says, in turn. */
function gateway(agents: Agent[] = BOTS) {
  let bots = agents.map((bot) => ({ ...bot }));
  const journal = new Set<string>();
  const calls: Array<{ method: string; params: unknown }> = [];
  const shown: unknown[] = [];
  const answers: Array<(params: Json) => unknown> = [];
  let admin = true;
  let wanted = true;
  let listFails = false;
  /** Reads the host had already superseded with a newer list, in turn. */
  let stale = 0;
  /** The bots the engine passed on as deleted, as the gateway's answer arrived. */
  const confirmed: string[] = [];
  /** Replaces the next list answers, in turn. */
  const lists: Array<() => unknown> = [];
  const ctx: BotDeleteContext = {
    stamp: STAMP,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "agents.list") {
        if (listFails) throw new Error("socket closed");
        const next = lists.shift();
        return next ? next() : rosterOf(bots);
      }
      if (method === "agents.delete") {
        const p = params as Json;
        const id = String(p.agentId);
        if (!bots.some((bot) => bot.id === id) && !journal.has(id))
          throw refusal(`agent "${id}" not found`);
        const answer = answers.shift();
        const result = answer?.(p);
        // The gateway refuses before it changes anything (OpenClaw 2026.10.6): the bot stays.
        if (result instanceof GatewayProtocolRequestError) throw result;
        bots = bots.filter((bot) => bot.id !== id);
        if (answer) {
          if (result instanceof Error) throw result;
          const r = result as Json;
          if ((r.failed as unknown[] | undefined)?.length || r.purgeFailed) journal.add(id);
          else journal.delete(id);
          return result;
        }
        journal.delete(id);
        return { ok: true, agentId: id, removedBindings: 0, removed: [], failed: [] };
      }
      throw new Error(`unexpected ${method}`);
    },
    readBots: async () => {
      const result = await ctx.request("agents.list", {});
      const current = stale === 0;
      if (stale > 0) stale -= 1;
      else shown.push(result);
      return { result, current: () => current };
    },
    admin: () => admin,
    wanted: () => wanted,
    deleted: (id) => confirmed.push(id),
  };
  return {
    ctx,
    calls,
    shown,
    answers,
    lists,
    confirmed,
    deletes: () => calls.filter((call) => call.method === "agents.delete").map((c) => c.params),
    setAdmin: (value: boolean) => (admin = value),
    setWanted: (value: boolean) => (wanted = value),
    failList: (value: boolean) => (listFails = value),
    /** The next `count` reads answer after a newer list was shown. */
    supersede: (count: number) => (stale = count),
    add: (agent: Agent) => (bots = [...bots, agent]),
    change: (id: string, patch: Partial<Agent>) =>
      (bots = bots.map((bot) => (bot.id === id ? { ...bot, ...patch } : bot))),
    remove: (id: string) => (bots = bots.filter((bot) => bot.id !== id)),
    listed: () => bots.map((bot) => bot.id),
  };
}

/** What the dialog read and showed, then the request it sends. */
async function reviewed(
  g: ReturnType<typeof gateway>,
  botId = "pip",
): Promise<{ read: BotDeleteRead; ask: (more?: Partial<DeleteRequest>) => DeleteRequest }> {
  const read = await readBotDelete(g.ctx, botId);
  return {
    read,
    ask: (more = {}) => ({
      botId,
      stamp: STAMP,
      deleteFiles: false,
      reviewed: reviewOf(read),
      typed: read.confirm.text,
      ...more,
    }),
  };
}

/** A question the gateway lists as pending until it is resolved, as its list would say. */
function listQuestion(
  gateway: { handlers: Record<string, (params: unknown) => unknown> },
  record: unknown,
) {
  let listed = [record];
  gateway.handlers["question.list"] = () => ({ questions: listed });
  gateway.handlers["question.resolve"] = () => {
    listed = [];
    return { status: "cancelled" };
  };
}

describe("deleting a bot: what the dialog reads", () => {
  it("F-464: a folder another bot has, inside it or around it, in any case or slash, is shared", () => {
    const facts = (pip: string, others: Array<[string, string]>) =>
      deleteFacts(
        rosterOf([
          { id: "pip", name: "Pip", workspace: pip },
          ...others.map(([name, workspace]) => ({ id: name.toLowerCase(), name, workspace })),
        ]),
        "pip",
        STAMP,
      );
    expect(facts("/srv/claw/shared", [["Marlow", "/srv/claw/shared/"]])).toMatchObject({
      folder: "shared",
      sharedWith: ["Marlow"],
    });
    // Nested either way.
    expect(facts("/srv/claw/shared", [["Otto", "/srv/claw/shared/otto"]]).sharedWith).toEqual([
      "Otto",
    ]);
    expect(facts("/srv/claw/shared/pip", [["Otto", "/srv/claw"]]).sharedWith).toEqual(["Otto"]);
    // A case alias, as on a case-insensitive volume, and Windows slashes.
    expect(facts("/srv/Claw/Pip", [["Otto", "/SRV/claw/pip"]]).folder).toBe("shared");
    expect(facts("C:\\claw\\pip", [["Otto", "c:/claw/pip/sub"]]).folder).toBe("shared");
    // A sibling whose name only starts the same is not.
    expect(facts("/srv/claw/pip", [["Otto", "/srv/claw/pip2"]])).toMatchObject({
      folder: "own",
      sharedWith: [],
    });
    expect(foldersOverlap("/", "/anything")).toBe(true);
  });

  it("F-464: a missing workspace, the bot's or another's, leaves the folder unknown", () => {
    expect(
      deleteFacts(
        rosterOf([
          { id: "main", name: "J" },
          { id: "pip", name: "Pip" },
        ]),
        "pip",
        STAMP,
      ).folder,
    ).toBe("unknown");
    expect(
      deleteFacts(
        rosterOf([
          { id: "main", name: "J" },
          { id: "pip", name: "Pip", workspace: "/w/pip" },
        ]),
        "pip",
        STAMP,
      ).folder,
    ).toBe("unknown");
  });

  it("F-050: the gateway's default bot is the Main Bot, and a bot the list lacks is not listed", () => {
    const list = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }, { id: "pip", createdAt: 7 }],
    };
    expect(deleteFacts(list, "main", STAMP).main).toBe(true);
    expect(deleteFacts(list, "pip", STAMP)).toMatchObject({
      main: false,
      listed: true,
      createdAt: 7,
      stamp: STAMP,
    });
    expect(deleteFacts(list, "gone", STAMP)).toMatchObject({ listed: false, createdAt: null });
  });

  it("F-050: a list that isn't whole is refused, never read as an empty one", () => {
    const whole = { defaultId: "main", mainKey: "main", scope: "per-sender" };
    for (const bad of [
      {},
      null,
      { agents: [] },
      { defaultId: "main" },
      { ...whole, agents: [{}] },
      { ...whole, agents: [{ id: "pip" }, { id: "pip" }] },
      { ...whole, agents: "pip" },
      // Fields the protocol requires, missing or wrong.
      { defaultId: "main", agents: [] },
      { ...whole, scope: "everyone", agents: [] },
      { ...whole, mainKey: "", agents: [] },
      // A blank or padded id can't stand for the default bot or any other.
      { ...whole, defaultId: " ", agents: [{ id: "main" }] },
      { ...whole, defaultId: " main", agents: [{ id: "main" }] },
      { ...whole, agents: [{ id: "pip " }] },
    ])
      expect(() => deleteFacts(bad, "pip", STAMP)).toThrow("didn't come back whole");
  });

  it("F-050: the read is agents.list alone, and its answer is shown as the bot list", async () => {
    const g = gateway();
    const read = await readBotDelete(g.ctx, "pip");
    expect(read).toMatchObject({
      stamp: STAMP,
      listed: true,
      name: "Pip",
      createdAt: 2,
      workspace: "/srv/claw/workspaces/pip",
      folder: "own",
    });
    expect(g.calls.map((call) => call.method)).toEqual(["agents.list"]);
    expect(g.shown).toHaveLength(1);
  });
});

describe("deleting a bot: the delete", () => {
  it("F-050 F-276: the folder choice is sent as asked, always explicitly, and the list is read again after", async () => {
    for (const deleteFiles of [false, true]) {
      const g = gateway();
      const { ask } = await reviewed(g);
      const outcome = await deleteBot(g.ctx, ask({ deleteFiles }));
      expect(g.deletes()).toEqual([{ agentId: "pip", deleteFiles }]);
      expect(g.calls.map((call) => call.method)).toEqual([
        "agents.list",
        "agents.list",
        "agents.delete",
        "agents.list",
      ]);
      expect(outcome).toMatchObject({ kind: "answered", deleteFiles, listed: false });
      expect(partialCleanup(outcome)).toBe(false);
      expect(g.listed()).not.toContain("pip");
    }
  });

  it("F-050: without admin nothing is read or sent, and the reason is the access", async () => {
    const g = gateway();
    const { ask } = await reviewed(g);
    g.setAdmin(false);
    expect(await deleteBot(g.ctx, ask())).toEqual({
      kind: "not-sent",
      message: "Deleting a bot needs admin access.",
    });
    expect(g.calls.map((call) => call.method)).toEqual(["agents.list"]);
  });

  it("F-050: the Main Bot is never sent for deletion", async () => {
    const g = gateway();
    const { ask } = await reviewed(g, "main");
    expect(await deleteBot(g.ctx, ask())).toMatchObject({ kind: "changed", reason: "main" });
    expect(g.deletes()).toEqual([]);
  });

  it("F-050: a delete whose window went away before the send is not sent", async () => {
    const g = gateway();
    const { ask } = await reviewed(g);
    g.setWanted(false);
    expect(await deleteBot(g.ctx, ask())).toEqual({
      kind: "not-sent",
      message: "The window that asked for this delete closed. Nothing was sent.",
    });
    expect(g.deletes()).toEqual([]);
  });

  it("F-050: a request for another gateway than the context's is never sent", async () => {
    const g = gateway();
    const { ask } = await reviewed(g);
    for (const stamp of [
      { gatewayId: "gateway-b", target: 1 },
      // The same gateway on another target: pointed at a gateway anew since the dialog read.
      { gatewayId: GATEWAY, target: 2 },
      { gatewayId: null, target: 1 },
    ])
      expect(await deleteBot(g.ctx, ask({ stamp }))).toMatchObject({
        kind: "not-sent",
        message: expect.stringMatching(/another gateway/),
      });
    expect(g.deletes()).toEqual([]);
  });

  it("F-050: a list that fails or isn't whole just before the delete sends nothing, and one not whole is read again", async () => {
    const g = gateway();
    const { ask } = await reviewed(g);
    g.lists.push(() => ({}));
    expect(await deleteBot(g.ctx, ask())).toMatchObject({
      kind: "unread",
      message: expect.stringMatching(/didn't come back whole\. Nothing was sent\./),
    });
    g.failList(true);
    expect(await deleteBot(g.ctx, ask())).toEqual({ kind: "not-sent", message: "socket closed" });
    expect(g.deletes()).toEqual([]);
  });

  it("F-050: anything the dialog showed that changed sends nothing: gone, replaced, renamed", async () => {
    const g = gateway();
    const { ask } = await reviewed(g);
    g.change("pip", { createdAt: 99 });
    expect(await deleteBot(g.ctx, ask())).toMatchObject({ kind: "changed", reason: "replaced" });
    g.change("pip", { createdAt: 2, name: "Pip II" });
    expect(await deleteBot(g.ctx, ask())).toMatchObject({ kind: "changed", reason: "changed" });
    g.remove("pip");
    expect(await deleteBot(g.ctx, ask())).toMatchObject({ kind: "changed", reason: "gone" });
    expect(g.deletes()).toEqual([]);
  });

  it("F-050: a rename past the part of a long name the dialog shows still sends nothing", async () => {
    const long = "P".repeat(300);
    const g = gateway([BOTS[0]!, { ...BOTS[1]!, name: `${long} one` }]);
    const { read, ask } = await reviewed(g);
    expect(read.name).toHaveLength(256);
    // The same first 300 characters, another name: the whole name is what is compared.
    g.change("pip", { name: `${long} two` });
    expect(await deleteBot(g.ctx, ask())).toMatchObject({ kind: "changed", reason: "changed" });
    expect(g.deletes()).toEqual([]);
  });

  it("F-050: two names that differ only in a lone surrogate are two names: a rename between them sends nothing", async () => {
    const g = gateway([BOTS[0]!, { ...BOTS[1]!, name: "Pip\uD800" }]);
    const { ask } = await reviewed(g);
    g.change("pip", { name: "Pip\uD801" });
    expect(await deleteBot(g.ctx, ask())).toMatchObject({ kind: "changed", reason: "changed" });
    expect(g.deletes()).toEqual([]);
  });

  it("F-050: nothing is sent unless what was typed is the bot's name, or its id where the dialog asks for that", async () => {
    const g = gateway();
    const { read, ask } = await reviewed(g);
    expect(read.confirm).toEqual({ text: "Pip", by: "name" });
    for (const typed of ["", "pip", "Pi", "Pip!", "P ip"])
      expect(await deleteBot(g.ctx, ask({ typed }))).toEqual({
        kind: "not-sent",
        message: "What was typed isn't what the dialog asks for, so nothing was sent.",
      });
    expect(g.deletes()).toEqual([]);
    // Spaces around it are ignored; case is not.
    expect(await deleteBot(g.ctx, ask({ typed: "  Pip " }))).toMatchObject({ kind: "answered" });
    expect(g.deletes()).toHaveLength(1);
  });

  it("F-050: what confirms a delete is the name the gateway gives, or the id when it gives none or one that can't be typed", () => {
    const confirm = (agent: Json) =>
      deleteFacts(
        {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main" }, agent],
        },
        "pip",
        STAMP,
      ).confirm;
    // A bot really named as its id is confirmed by that name.
    expect(confirm({ id: "pip", name: "pip" })).toEqual({ text: "pip", by: "name" });
    expect(confirm({ id: "pip", identity: { name: " Pip " } })).toEqual({
      text: "Pip",
      by: "name",
    });
    expect(confirm({ id: "pip" })).toEqual({ text: "pip", by: "unnamed" });
    expect(confirm({ id: "pip", name: "   " })).toEqual({ text: "pip", by: "unnamed" });
    // A line break, a tab or a name longer than the dialog shows can't be typed in one line.
    for (const name of [
      "Pip\nII",
      "Pip\tII",
      "Pip\u2028II",
      "P".repeat(257),
      // A lone surrogate, high or low, draws as a replacement character.
      "Pip\uD800",
      "\uDC00Pip",
      "Pip\uD800\uD800\uDC00",
    ])
      expect(confirm({ id: "pip", name })).toEqual({ text: "pip", by: "untypable" });
    // A pair, as in an emoji, is a name like any other.
    expect(confirm({ id: "pip", name: "Pip \uD83D\uDE80" })).toEqual({
      text: "Pip \uD83D\uDE80",
      by: "name",
    });
    expect(confirm({ id: "pip", name: "P".repeat(256) })).toEqual({
      text: "P".repeat(256),
      by: "name",
    });
  });

  it("F-050: a bot with no creation record replaced by another with none is told apart by what the dialog showed", async () => {
    const g = gateway([
      { id: "main", name: "Juniper", workspace: "/w/main" },
      { id: "pip", name: "Pip", workspace: "/w/pip" },
    ]);
    const { read, ask } = await reviewed(g);
    expect(read.createdAt).toBeNull();
    // Another client deletes Pip and makes a new bot under the same id, elsewhere.
    g.remove("pip");
    g.add({ id: "pip", name: "Pip", workspace: "/w/new-pip" });
    expect(await deleteBot(g.ctx, ask())).toMatchObject({ kind: "changed", reason: "moved" });
    g.remove("pip");
    g.add({ id: "pip", name: "Quill", workspace: "/w/pip" });
    expect(await deleteBot(g.ctx, ask())).toMatchObject({ kind: "changed", reason: "changed" });
    expect(g.deletes()).toEqual([]);
  });

  it("F-276: a bot with no creation record is deleted with its files kept, never with them removed", async () => {
    const g = gateway([
      { id: "main", name: "Juniper", workspace: "/w/main" },
      { id: "pip", name: "Pip", workspace: "/w/pip" },
    ]);
    const { ask } = await reviewed(g);
    expect(await deleteBot(g.ctx, ask({ deleteFiles: true }))).toMatchObject({
      kind: "changed",
      reason: "files",
    });
    expect(g.deletes()).toEqual([]);
    expect(await deleteBot(g.ctx, ask())).toMatchObject({ kind: "answered", listed: false });
    expect(g.deletes()).toEqual([{ agentId: "pip", deleteFiles: false }]);
  });

  it("F-276: the folder reviewed is the folder sent: one moved since sends nothing, files or not", async () => {
    const g = gateway();
    const { read, ask } = await reviewed(g);
    expect(read.workspace).toBe("/srv/claw/workspaces/pip");
    g.change("pip", { workspace: "/srv/claw/workspaces/elsewhere" });
    const outcome = await deleteBot(g.ctx, ask({ deleteFiles: true }));
    expect(outcome).toMatchObject({ kind: "changed", reason: "moved" });
    if (outcome.kind === "changed")
      expect(outcome.read.workspace).toBe("/srv/claw/workspaces/elsewhere");
    expect(await deleteBot(g.ctx, ask())).toMatchObject({ kind: "changed", reason: "moved" });
    expect(g.deletes()).toEqual([]);
  });

  it("F-464: a folder another bot now uses, nested or not, sends nothing, and the fresh read names that bot", async () => {
    for (const workspace of ["/srv/claw/workspaces/pip", "/srv/claw/workspaces/pip/inner"]) {
      const g = gateway();
      const { ask } = await reviewed(g);
      g.add({ id: "quill", name: "Quill", workspace, createdAt: 4 });
      const outcome = await deleteBot(g.ctx, ask({ deleteFiles: true }));
      expect(outcome).toMatchObject({ kind: "changed", reason: "shared" });
      if (outcome.kind === "changed") expect(outcome.read.sharedWith).toEqual(["Quill"]);
      expect(g.deletes()).toEqual([]);
    }
  });

  it("F-464: removing a folder that is shared, or whose sharing is unknown, is refused even when reviewed so", async () => {
    const g = gateway([
      ...BOTS,
      { id: "otto", name: "Otto", workspace: "/srv/claw/workspaces", createdAt: 5 },
    ]);
    const { read, ask } = await reviewed(g);
    expect(read.folder).toBe("shared");
    expect(await deleteBot(g.ctx, ask({ deleteFiles: true }))).toMatchObject({
      kind: "changed",
      reason: "files",
    });
    expect(g.deletes()).toEqual([]);
  });

  it("F-050: an ok answer with paths not moved, or task records not cleared, is partial and keeps every path", async () => {
    const g = gateway();
    const { ask } = await reviewed(g);
    g.answers.push(() => ({
      ok: true,
      agentId: "pip",
      removedBindings: 1,
      removed: [{ path: "/srv/claw/workspaces/pip", method: "trash" }],
      failed: [{ path: "/srv/claw/agents/pip", reason: "permission denied" }],
    }));
    const outcome = await deleteBot(g.ctx, ask({ deleteFiles: true }));
    expect(outcome).toEqual({
      kind: "answered",
      deleteFiles: true,
      removedBindings: 1,
      removed: [{ path: "/srv/claw/workspaces/pip", method: "trash" }],
      removedOmitted: 0,
      missingOmitted: 0,
      failed: [{ path: "/srv/claw/agents/pip", reason: "permission denied" }],
      failedOmitted: 0,
      purgeFailed: false,
      listed: false,
    });
    expect(partialCleanup(outcome)).toBe(true);
    const purge = readDeleteAnswer({
      ok: true,
      agentId: "pip",
      removedBindings: 0,
      purgeFailed: true,
    });
    expect(purge.purgeFailed).toBe(true);
    expect(partialCleanup({ kind: "answered", deleteFiles: true, ...purge, listed: false })).toBe(
      true,
    );
  });

  it("F-050 F-276: an answer with many long paths fits one result: what the gateway confirmed stays, paths not moved first, the rest counted", async () => {
    const g = gateway();
    const { ask } = await reviewed(g);
    const long = (n: number) => `/srv/claw/${String(n).padStart(4, "0")}/${"x".repeat(4_000)}`;
    g.answers.push(() => ({
      ok: true,
      agentId: "pip",
      removedBindings: 3,
      removed: Array.from({ length: MAX_DELETE_PATHS }, (_, n) => ({
        path: long(n),
        method: n % 2 ? "missing" : "trash",
      })),
      failed: Array.from({ length: MAX_DELETE_PATHS }, (_, n) => ({
        path: long(100 + n),
        reason: "r".repeat(512),
      })),
    }));
    const outcome = await deleteBot(g.ctx, ask({ deleteFiles: true }));
    if (outcome.kind !== "answered") throw new Error(outcome.kind);
    // Through the web host, a result over 262,144 characters is replaced by an error.
    expect(JSON.stringify({ type: "result", id: 1, ok: true, value: outcome }).length).toBeLessThan(
      262_144,
    );
    expect(JSON.stringify(outcome).length).toBeLessThanOrEqual(MAX_DELETE_RESULT_CHARS);
    expect(outcome).toMatchObject({ removedBindings: 3, listed: false, deleteFiles: true });
    // Paths not moved come first, in order; every path is shown or counted, by what happened.
    expect(outcome.failed.length).toBeGreaterThan(0);
    expect(outcome.failed[0]!.path).toBe(long(100));
    expect(outcome.failed.length + outcome.failedOmitted).toBe(MAX_DELETE_PATHS);
    expect(outcome.removed.length + outcome.removedOmitted + outcome.missingOmitted).toBe(
      MAX_DELETE_PATHS,
    );
    const shownTrash = outcome.removed.filter((each) => each.method === "trash").length;
    expect(shownTrash + outcome.removedOmitted).toBe(MAX_DELETE_PATHS / 2);
    expect(partialCleanup(outcome)).toBe(true);
  });

  it("F-050 F-276: a path too long to show whole is never shown cut, and is counted under what happened to it", () => {
    const long = `/srv/claw/${"x".repeat(4_090)}/child`;
    expect(long.length).toBeGreaterThan(4_096);
    const answer = readDeleteAnswer({
      removed: [
        { path: long, method: "trash" },
        { path: long, method: "missing" },
        { path: "/srv/claw/short", method: "trash" },
      ],
      failed: [{ path: long, reason: "busy" }],
    });
    expect(answer.removed).toEqual([{ path: "/srv/claw/short", method: "trash" }]);
    expect(answer).toMatchObject({
      removedOmitted: 1,
      missingOmitted: 1,
      failed: [],
      failedOmitted: 1,
    });
    expect(JSON.stringify(answer)).not.toContain("xxxx");
  });

  it("F-050: a path too large for what is left of the result is skipped, and a shorter one after it still shown", async () => {
    const g = gateway();
    const { ask } = await reviewed(g);
    const long = (n: number) => `/srv/claw/${String(n).padStart(4, "0")}/${"x".repeat(4_000)}`;
    g.answers.push(() => ({
      ok: true,
      agentId: "pip",
      removedBindings: 0,
      removed: [],
      failed: [
        ...Array.from({ length: MAX_DELETE_PATHS - 1 }, (_, n) => ({
          path: long(n),
          reason: "r".repeat(512),
        })),
        { path: "/srv/claw/short", reason: "busy" },
      ],
    }));
    const outcome = await deleteBot(g.ctx, ask());
    if (outcome.kind !== "answered") throw new Error(outcome.kind);
    expect(outcome.failed.at(-1)).toEqual({ path: "/srv/claw/short", reason: "busy" });
    expect(outcome.failedOmitted).toBeGreaterThan(0);
    expect(outcome.failed.length + outcome.failedOmitted).toBe(MAX_DELETE_PATHS);
    expect(JSON.stringify(outcome).length).toBeLessThanOrEqual(MAX_DELETE_RESULT_CHARS);
  });

  it("F-050: a failure the answer gives without a path is still counted as not moved", () => {
    const many = Array.from({ length: MAX_DELETE_PATHS + 2 }, (_, n) => ({
      path: `/srv/claw/x${n}`,
      reason: "busy",
    }));
    const answer = readDeleteAnswer({ failed: [...many, { reason: "no path" }] });
    expect(answer.failed).toHaveLength(MAX_DELETE_PATHS);
    expect(answer.failedOmitted).toBe(3);
  });

  it("F-276: paths past the cap keep their method: one already gone is never counted as moved", () => {
    const removed = Array.from({ length: MAX_DELETE_PATHS }, (_, n) => ({
      path: `/srv/claw/x${n}`,
      method: "trash",
    }));
    const answer = readDeleteAnswer({
      removed: [
        ...removed,
        { path: "/srv/claw/late", method: "trash" },
        { path: "/srv/claw/gone-1", method: "missing" },
        { path: "/srv/claw/gone-2", method: "missing" },
      ],
    });
    expect(answer).toMatchObject({ removedOmitted: 1, missingOmitted: 2 });
  });

  it("F-050: any failure once the request left is unconfirmed, in the gateway's words, and the list is read after", async () => {
    const g = gateway();
    const { ask } = await reviewed(g);
    // A refusal the gateway gives in its own words is no proof nothing was removed either.
    g.answers.push(() => refusal('Agent "pip" owns the shared sign-ins and cannot be deleted.'));
    // It refuses before it changes anything, so the list after it still has Pip.
    expect(await deleteBot(g.ctx, ask())).toEqual({
      kind: "unconfirmed",
      message: 'Agent "pip" owns the shared sign-ins and cannot be deleted.',
      deleteFiles: false,
      listed: true,
      listedAs: "Pip",
    });
    const h = gateway();
    const second = await reviewed(h);
    h.answers.push(() => new Error("request timed out"));
    expect(await deleteBot(h.ctx, second.ask({ deleteFiles: true }))).toEqual({
      kind: "unconfirmed",
      message: "request timed out",
      deleteFiles: true,
      listed: false,
    });
  });

  it("F-050: when the list after the delete fails or isn't whole, the outcome says so instead of guessing", async () => {
    for (const after of [() => Promise.reject(new Error("socket closed")), () => ({})]) {
      const g = gateway();
      const { ask } = await reviewed(g);
      let reads = 0;
      const list = g.ctx.readBots;
      g.ctx.readBots = async () => {
        reads += 1;
        return reads > 1 ? { result: await after(), current: () => true } : list();
      };
      expect(await deleteBot(g.ctx, ask())).toMatchObject({ kind: "answered", listed: null });
    }
  });

  it("F-050: the Main Bot is refused before any other fact of the read, whatever else changed", async () => {
    const g = gateway();
    const { ask } = await reviewed(g, "main");
    g.change("main", { name: "Juniper II", createdAt: 7, workspace: "/elsewhere" });
    expect(await deleteBot(g.ctx, ask())).toMatchObject({ kind: "changed", reason: "main" });
    expect(g.deletes()).toEqual([]);
  });

  it("F-050: a list read before the delete that a newer one superseded decides nothing and hands back no facts", async () => {
    for (const change of [
      // Gone in the old read, the Main Bot in it, or anything else changed: none of it is said.
      (g: ReturnType<typeof gateway>) => g.remove("pip"),
      (g: ReturnType<typeof gateway>) => g.change("pip", { name: "Quill" }),
      () => {},
    ]) {
      const g = gateway();
      const { ask } = await reviewed(g);
      change(g);
      g.supersede(1);
      const outcome = await deleteBot(g.ctx, ask());
      expect(outcome).toEqual({
        kind: "unread",
        message: "The bot list changed while Clawtrate read it. Nothing was sent.",
      });
      expect(g.deletes()).toEqual([]);
    }
  });

  it("F-050: the list after the delete names the bot it lists under the id as the gateway names it", async () => {
    const g = gateway();
    const { ask } = await reviewed(g);
    // Pip is deleted, and another client makes Quill under the same id before the list is read.
    g.answers.push((params) => {
      g.lists.push(() =>
        rosterOf([
          ...BOTS.filter((bot) => bot.id !== "pip"),
          { id: "pip", name: "Quill", workspace: "/w/quill", createdAt: 9 },
        ]),
      );
      return { ok: true, agentId: params.agentId, removedBindings: 0, removed: [], failed: [] };
    });
    expect(await deleteBot(g.ctx, ask())).toMatchObject({
      kind: "answered",
      listed: true,
      listedAs: "Quill",
    });
  });

  it("F-050: a list read after the delete that a newer one superseded says nothing of the bot", async () => {
    const g = gateway();
    const { ask } = await reviewed(g);
    let reads = 0;
    const list = g.ctx.readBots;
    g.ctx.readBots = async () => {
      reads += 1;
      const read = await list();
      return reads > 1 ? { ...read, current: () => false } : read;
    };
    expect(await deleteBot(g.ctx, ask())).toMatchObject({ kind: "answered", listed: null });
  });

  it("F-050: only `ok: true` for the bot asked about is a delete; any other answer is unconfirmed", async () => {
    for (const answer of [
      { ok: true, agentId: "marlow", removedBindings: 0 },
      { agentId: "pip", removedBindings: 0 },
      { ok: false, agentId: "pip" },
      {},
    ]) {
      const g = gateway();
      const { ask } = await reviewed(g);
      g.answers.push(() => answer);
      expect(await deleteBot(g.ctx, ask())).toMatchObject({
        kind: "unconfirmed",
        message: "its answer didn't say this bot was deleted",
      });
    }
  });

  it("F-050: the bridge checks the delete's fields", () => {
    const review = {
      nameDigest: "a".repeat(64),
      createdAt: 2,
      workspace: "/w/pip",
      folder: "own",
      sharedWith: [],
      sharedOmitted: 0,
    };
    const command = {
      type: "deleteBot",
      botId: "pip",
      stamp: STAMP,
      deleteFiles: true,
      reviewed: review,
      typed: "Pip",
    };
    expect(parseBridgeCommand(command)).toEqual(command);
    expect(() => parseBridgeCommand({ ...command, deleteFiles: "yes" })).toThrow("invalid flag");
    expect(() => parseBridgeCommand({ ...command, botId: "../x" })).toThrow("invalid bot id");
    expect(() => parseBridgeCommand({ ...command, stamp: undefined })).toThrow(
      "invalid gateway stamp",
    );
    // There is no delete without what the person typed to confirm it.
    expect(() => parseBridgeCommand({ ...command, typed: undefined })).toThrow(
      "invalid typed text",
    );
    expect(() =>
      parseBridgeCommand({ ...command, reviewed: { ...review, nameDigest: "Pip" } }),
    ).toThrow("invalid name");
    // There is no delete without what the dialog showed: nothing is ever sent again by itself.
    expect(() => parseBridgeCommand({ ...command, reviewed: null })).toThrow("invalid review");
    expect(() =>
      parseBridgeCommand({ ...command, reviewed: { ...review, folder: "mine" } }),
    ).toThrow("invalid folder");
  });
});

// The client: a development-shaped gateway with an admin pairing and one open task of Pip's.

const PIP_TASK = "agent:pip:chores";
const ADMIN_STORAGE = () =>
  memoryStorage({
    connection: JSON.stringify({ url: URL_A, token: null }),
    [tokenKey(URL_A)]: JSON.stringify({
      token: "device-token",
      grantedScopes: ADMIN_SCOPES,
      heldScopes: ADMIN_SCOPES.filter((scope) => scope !== "operator.admin"),
      adminHeld: true,
    }),
  });

async function adminClient() {
  const fake = grantingGateway();
  const state = { identity: GATEWAY, bots: BOTS.map((bot) => ({ ...bot })) };
  fake.handlers["gateway.identity.get"] = () => ({ deviceId: state.identity });
  fake.handlers["agents.list"] = () => rosterOf(state.bots);
  fake.handlers["agents.delete"] = (params) => {
    const id = (params as Json).agentId;
    state.bots = state.bots.filter((bot) => bot.id !== id);
    return { ok: true, agentId: id, removedBindings: 0, removed: [], failed: [] };
  };
  const opened = await openTask({ gateway: fake, storage: ADMIN_STORAGE(), key: PIP_TASK });
  await until(() => opened.client.state.connection.gatewayId === GATEWAY);
  /** The host now reaches another gateway at the same address. */
  const switchTo = async (identity: string) => {
    state.identity = identity;
    const was = opened.client.state.connection.connectedAt;
    fake.dropAll();
    await until(
      () =>
        opened.client.state.connection.status === "connected" &&
        opened.client.state.connection.connectedAt !== was &&
        opened.client.state.connection.gatewayId === identity,
    );
  };
  /** The person switches to another saved gateway while work is under way. */
  const connectB = () => {
    state.identity = "gateway-b";
    opened.storage.data.set(tokenKey(URL_B), opened.storage.data.get(tokenKey(URL_A))!);
    return opened.client.connect({ url: URL_B });
  };
  return { ...opened, fake, state, switchTo, connectB };
}

describe("deleting a bot: one gateway, one connection", () => {
  it("F-557: a deleted bot's tasks let the pictures you sent in them go; another bot's stay", async () => {
    const { client, fake } = await adminClient();
    // A picture sent in a task of Pip's and one in a task of Marlow's, each held in history.
    const MARLOW_TASK = "agent:marlow:letters";
    client.openSession(MARLOW_TASK);
    await until(() => client.state.transcripts[MARLOW_TASK]?.status === "ready");
    const rows = new Map<string, unknown[]>();
    fake.handlers["chat.history"] = (params) => ({
      messages: rows.get((params as Json).sessionKey as string) ?? [],
    });
    const png = solidPng(8, 8, [10, 120, 200]);
    const picture = {
      type: "image",
      mimeType: "image/png",
      fileName: "shot.png",
      content: toBase64(png),
    };
    for (const task of [PIP_TASK, MARLOW_TASK]) {
      const id = client.sendMessage(task, "look", { attachments: [picture] });
      await until(() => client.state.transcripts[task]!.outbox[0]?.status === "sent");
      rows.set(task, [sentRow(id, "look", [SHOT])]);
      fake.emit("sessions.changed", { sessionKey: task, phase: "message", updatedAt: 2 });
      await until(() => client.state.transcripts[task]!.outbox.length === 0);
    }
    expect(client.keptPictureBytes).toBe(2 * png.length);
    const read = await client.readBotDelete("pip");
    const outcome = await client.deleteBot({
      botId: "pip",
      stamp: read.stamp,
      deleteFiles: false,
      reviewed: reviewOf(read),
      typed: "Pip",
    });
    expect(outcome.kind).toBe("answered");
    expect(client.keptPictureBytes).toBe(png.length);
    client.stop();
  });

  for (const early of [false, true])
    it(`F-557: a deleted bot's pictures go by the bot each task is listed under, not its key${early ? ", even when the bot list read after the delete lands before its answer" : ""}`, async () => {
      const { client, fake } = await adminClient();
      // Listed under Pip with no bot in its key, and under Marlow with Pip's name in its key.
      const UNPREFIXED = "webchat:direct:u1";
      const MISNAMED = "agent:pip:for-marlow";
      const listed = [
        { key: UNPREFIXED, agentId: "pip", updatedAt: 5 },
        { key: MISNAMED, agentId: "marlow", updatedAt: 4 },
      ];
      fake.handlers["sessions.list"] = () => ({ sessions: listed, hasMore: false });
      fake.handlers["sessions.subscribe"] = () => ({
        subscribed: true,
        list: { sessions: listed, hasMore: false },
      });
      fake.dropAll();
      await until(() =>
        (client.state.tasksByBot.marlow ?? []).some((each) => each.key === MISNAMED),
      );
      const listedUnderPip = () =>
        (client.state.tasksByBot.pip ?? []).some((each) => each.key === UNPREFIXED);
      expect(listedUnderPip()).toBe(true);
      const rows = new Map<string, unknown[]>();
      const ids = new Map<string, string>();
      fake.handlers["chat.history"] = (params) => ({
        messages: rows.get((params as Json).sessionKey as string) ?? [],
      });
      const png = solidPng(8, 8, [10, 120, 200]);
      const picture = {
        type: "image",
        mimeType: "image/png",
        fileName: "shot.png",
        content: toBase64(png),
      };
      for (const task of [UNPREFIXED, MISNAMED]) {
        client.openSession(task);
        await until(() => client.state.transcripts[task]?.status === "ready");
        const id = client.sendMessage(task, "look", { attachments: [picture] });
        ids.set(task, id);
        await until(() => client.state.transcripts[task]!.outbox[0]?.status === "sent");
        rows.set(task, [sentRow(id, "look", [SHOT])]);
        fake.emit("sessions.changed", { sessionKey: task, phase: "message", updatedAt: 6 });
        await until(() => client.state.transcripts[task]!.outbox.length === 0);
      }
      expect(client.keptPictureBytes).toBe(2 * png.length);
      if (early) {
        const answer = fake.handlers["agents.delete"]!;
        fake.handlers["agents.delete"] = async (params) => {
          const result = await answer(params);
          // OpenClaw 2026.10.6 commits the delete, which broadcasts config.changed, and answers
          // only after its cleanup: the bot list read that event brings drops Pip's rows first.
          fake.emit("config.changed", { path: "openclaw.json", hash: "h1", ts: 1 });
          await until(() => !listedUnderPip());
          return result;
        };
      }
      const read = await client.readBotDelete("pip");
      const outcome = await client.deleteBot({
        botId: "pip",
        stamp: read.stamp,
        deleteFiles: false,
        reviewed: reviewOf(read),
        typed: "Pip",
      });
      expect(outcome.kind).toBe("answered");
      expect(client.keptPictureBytes).toBe(png.length);
      expect(await client.readSentPicture(UNPREFIXED, `${ids.get(UNPREFIXED)}:user`, 0)).toEqual({
        status: "cannot-load",
      });
      expect((await client.readSentPicture(MISNAMED, `${ids.get(MISNAMED)}:user`, 0)).status).toBe(
        "content",
      );
      client.stop();
    });

  /** Lists `listed` from now on, and has the client read the list again. */
  const relist = (fake: ReturnType<typeof grantingGateway>, listed: Json[], unknown: string) => {
    fake.handlers["sessions.list"] = () => ({ sessions: listed, hasMore: false });
    fake.handlers["sessions.subscribe"] = () => ({
      subscribed: true,
      list: { sessions: listed, hasMore: false },
    });
    // A change to a task the client hasn't listed is read with the whole list.
    fake.emit("sessions.changed", { sessionKey: unknown, updatedAt: 7 });
  };

  it("F-557: pictures sent before their tasks were listed go by the bot the list then places each task under", async () => {
    const { client, fake } = await adminClient();
    const UNPREFIXED = "webchat:direct:u1";
    const MISNAMED = "agent:pip:for-marlow";
    const rows = new Map<string, unknown[]>();
    const ids = new Map<string, string>();
    fake.handlers["chat.history"] = (params) => ({
      messages: rows.get((params as Json).sessionKey as string) ?? [],
    });
    const png = solidPng(8, 8, [10, 120, 200]);
    const picture = {
      type: "image",
      mimeType: "image/png",
      fileName: "shot.png",
      content: toBase64(png),
    };
    // Opened and sent in before any list names them: the bot noted is the key's, or none.
    for (const task of [UNPREFIXED, MISNAMED]) {
      client.openSession(task);
      await until(() => client.state.transcripts[task]?.status === "ready");
      const id = client.sendMessage(task, "look", { attachments: [picture] });
      ids.set(task, id);
      await until(() => client.state.transcripts[task]!.outbox[0]?.status === "sent");
      rows.set(task, [sentRow(id, "look", [SHOT])]);
      fake.emit("sessions.changed", { sessionKey: task, phase: "message", updatedAt: 6 });
      await until(() => client.state.transcripts[task]!.outbox.length === 0);
    }
    expect(client.keptPictureBytes).toBe(2 * png.length);
    relist(
      fake,
      [
        { key: UNPREFIXED, agentId: "pip", updatedAt: 5 },
        { key: MISNAMED, agentId: "marlow", updatedAt: 4 },
      ],
      UNPREFIXED,
    );
    await until(() => (client.state.tasksByBot.marlow ?? []).some((each) => each.key === MISNAMED));
    const read = await client.readBotDelete("pip");
    const outcome = await client.deleteBot({
      botId: "pip",
      stamp: read.stamp,
      deleteFiles: false,
      reviewed: reviewOf(read),
      typed: "Pip",
    });
    expect(outcome.kind).toBe("answered");
    expect(client.keptPictureBytes).toBe(png.length);
    expect(await client.readSentPicture(UNPREFIXED, `${ids.get(UNPREFIXED)}:user`, 0)).toEqual({
      status: "cannot-load",
    });
    expect((await client.readSentPicture(MISNAMED, `${ids.get(MISNAMED)}:user`, 0)).status).toBe(
      "content",
    );
    client.stop();
  });

  it("F-050: a message queued in a task listed under another bot stays queued when the bot its key names is deleted", async () => {
    const { client, fake } = await adminClient();
    const MISNAMED = "agent:pip:for-marlow";
    relist(fake, [{ key: MISNAMED, agentId: "marlow", updatedAt: 4 }], MISNAMED);
    await until(() => (client.state.tasksByBot.marlow ?? []).some((each) => each.key === MISNAMED));
    client.openSession(MISNAMED);
    await until(() => client.state.transcripts[MISNAMED]?.status === "ready");
    client.sendMessage(MISNAMED, "Take your time");
    const transcript = () => client.state.transcripts[MISNAMED]!;
    await until(
      () => transcript().runs[0]?.bound === true && transcript().runs[0]?.state === "running",
    );
    const png = solidPng(8, 8, [10, 120, 200]);
    client.sendMessage(MISNAMED, "Then this", {
      mode: "queue",
      attachments: [
        { type: "image", mimeType: "image/png", fileName: "shot.png", content: toBase64(png) },
      ],
    });
    await until(() => transcript().outbox[1]?.status === "queued");
    const read = await client.readBotDelete("pip");
    const outcome = await client.deleteBot({
      botId: "pip",
      stamp: read.stamp,
      deleteFiles: false,
      reviewed: reviewOf(read),
      typed: "Pip",
    });
    expect(outcome.kind).toBe("answered");
    expect(transcript().outbox[1]).toMatchObject({ status: "queued", text: "Then this" });
    client.stop();
  });

  it("F-050: a dialog read on one gateway sends nothing once the host reaches another", async () => {
    const { client, fake, switchTo } = await adminClient();
    const read = await client.readBotDelete("pip");
    expect(read.stamp).toEqual({ gatewayId: GATEWAY, target: client.state.connection.target });
    await switchTo("gateway-b");
    const viewer = createBridgeSession(client);
    await expect(
      viewer.apply({
        type: "deleteBot",
        botId: "pip",
        stamp: read.stamp,
        deleteFiles: false,
        reviewed: reviewOf(read),
        typed: "Pip",
      }),
    ).resolves.toMatchObject({
      kind: "not-sent",
      message: expect.stringMatching(/made for another gateway/),
    });
    expect(fake.calls("agents.delete")).toEqual([]);
    client.stop();
  });

  it("F-050: a connection replaced during the read before the delete sends nothing", async () => {
    const { client, fake, state, switchTo } = await adminClient();
    const read = await client.readBotDelete("pip");
    const held = deferred<unknown>();
    fake.handlers["agents.list"] = () => held.promise;
    const pending = client.deleteBot({
      botId: "pip",
      stamp: read.stamp,
      deleteFiles: false,
      reviewed: reviewOf(read),
      typed: "Pip",
    });
    await until(() => fake.calls("agents.list").length >= 3);
    fake.handlers["agents.list"] = () => rosterOf(state.bots);
    await switchTo("gateway-b");
    held.resolve(rosterOf(state.bots));
    expect(await pending).toMatchObject({ kind: "not-sent" });
    expect(fake.calls("agents.delete")).toEqual([]);
    client.stop();
  });

  it("F-050: the list after a delete is never read from another gateway", async () => {
    const { client, fake, state, connectB } = await adminClient();
    const read = await client.readBotDelete("pip");
    const lost = deferred<unknown>();
    fake.handlers["agents.delete"] = () => {
      state.bots = state.bots.filter((bot) => bot.id !== "pip");
      return lost.promise;
    };
    const pending = client.deleteBot({
      botId: "pip",
      stamp: read.stamp,
      deleteFiles: false,
      reviewed: reviewOf(read),
      typed: "Pip",
    });
    await until(() => fake.calls("agents.delete").length === 1);
    // The answer is lost with the connection, and gateway B, which doesn't list Pip either, is
    // opened at once: its list says nothing about gateway A's.
    const switching = connectB();
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: "unconfirmed", listed: null });
    await switching;
    await until(() => client.state.connection.gatewayId === "gateway-b");
    client.stop();
  });

  it("F-050: a delete refused at a viewer's command cap says nothing was sent; other requests are refused as before", async () => {
    const { client, fake, state } = await adminClient();
    const read = await client.readBotDelete("pip");
    const viewer = createBridgeSession(client);
    // Sixteen reads held on this viewer fill its commands in flight.
    const held = deferred<unknown>();
    fake.handlers["agents.list"] = () => held.promise;
    const reads = Array.from({ length: MAX_VIEWER_PENDING_COMMANDS }, () =>
      viewer.apply({ type: "readBotDelete", botId: "pip" }).catch(() => null),
    );
    expect(
      await viewer.apply({
        type: "deleteBot",
        botId: "pip",
        stamp: read.stamp,
        deleteFiles: false,
        reviewed: reviewOf(read),
        typed: "Pip",
      }),
    ).toMatchObject({ kind: "not-sent", message: expect.stringMatching(/Nothing was sent/) });
    await expect(viewer.apply({ type: "readBotDelete", botId: "pip" })).rejects.toThrow(
      "Too many requests are waiting",
    );
    expect(fake.calls("agents.delete")).toEqual([]);
    held.resolve(rosterOf(state.bots));
    await Promise.all(reads);
    client.stop();
  });

  it("F-050: a viewer's delete without the bot's name typed is refused by the host, and nothing is sent", async () => {
    const { client, fake } = await adminClient();
    const read = await client.readBotDelete("pip");
    const viewer = createBridgeSession(client);
    for (const typed of ["", "pip", "Marlow"])
      expect(
        await viewer.apply({
          type: "deleteBot",
          botId: "pip",
          stamp: read.stamp,
          deleteFiles: false,
          reviewed: reviewOf(read),
          typed,
        }),
      ).toMatchObject({ kind: "not-sent", message: expect.stringMatching(/What was typed/) });
    expect(fake.calls("agents.delete")).toEqual([]);
    client.stop();
  });

  it("F-050: a viewer that goes away while the list before the delete is read sends nothing", async () => {
    const { client, fake, state } = await adminClient();
    const read = await client.readBotDelete("pip");
    const viewer = createBridgeSession(client);
    const held = deferred<unknown>();
    fake.handlers["agents.list"] = () => held.promise;
    const lists = fake.calls("agents.list").length;
    const pending = viewer.apply({
      type: "deleteBot",
      botId: "pip",
      stamp: read.stamp,
      deleteFiles: false,
      reviewed: reviewOf(read),
      typed: "Pip",
    });
    await until(() => fake.calls("agents.list").length === lists + 1);
    viewer.dispose();
    held.resolve(rosterOf(state.bots));
    await pending.catch(() => null);
    await sleep(30);
    expect(fake.calls("agents.delete")).toEqual([]);
    client.stop();
  });

  it("F-050: a delete naming an id longer than the client keeps is refused whole, before anything is kept or read", async () => {
    const { client, fake } = await adminClient();
    const read = await client.readBotDelete("pip");
    const lists = fake.calls("agents.list").length;
    for (const [botId, stamp] of [
      ["p".repeat(3_000), read.stamp],
      ["pip", { ...read.stamp, gatewayId: "g".repeat(3_000) }],
      // Short as text, long as JSON: each quote takes two characters there.
      ['"'.repeat(600), read.stamp],
      ["pip", { ...read.stamp, gatewayId: '"'.repeat(600) }],
    ] as const)
      expect(
        await client.deleteBot({
          botId,
          stamp,
          deleteFiles: false,
          reviewed: reviewOf(read),
          typed: "Pip",
        }),
      ).toMatchObject({ kind: "not-sent" });
    expect(fake.calls("agents.list")).toHaveLength(lists);
    expect(fake.calls("agents.delete")).toEqual([]);
    client.stop();
  });

  it("F-050: a second viewer's delete of the same bot, while one is under way, is refused before anything is read", async () => {
    const { client, fake } = await adminClient();
    const read = await client.readBotDelete("pip");
    const held = deferred<unknown>();
    const answer = { ok: true, agentId: "pip", removedBindings: 0, removed: [], failed: [] };
    fake.handlers["agents.delete"] = () => held.promise;
    const request = {
      type: "deleteBot" as const,
      botId: "pip",
      stamp: read.stamp,
      deleteFiles: false,
      reviewed: reviewOf(read),
      typed: "Pip",
    };
    const first = createBridgeSession(client).apply(request);
    await until(() => fake.calls("agents.delete").length === 1);
    const lists = fake.calls("agents.list").length;
    expect(await createBridgeSession(client).apply(request)).toMatchObject({
      kind: "not-sent",
      message: expect.stringMatching(/already being deleted/),
    });
    expect(fake.calls("agents.list").length).toBe(lists);
    held.resolve(answer);
    expect(await first).toMatchObject({ kind: "answered" });
    expect(fake.calls("agents.delete")).toHaveLength(1);
    client.stop();
  });
});

describe("deleting a bot: what this client still held for it", () => {
  const request = (read: BotDeleteRead): DeleteRequest => ({
    botId: read.botId,
    stamp: read.stamp,
    deleteFiles: false,
    reviewed: reviewOf(read),
    typed: read.confirm.text,
  });
  /** A message for Pip's task, queued behind a run of its own. */
  const queueForPip = async (opened: Awaited<ReturnType<typeof adminClient>>) => {
    opened.gateway.emit("agent", agentEvent("run-x", 1, "lifecycle", { phase: "start" }, PIP_TASK));
    await until(() => opened.transcript().runs.length === 1);
    opened.client.sendMessage(PIP_TASK, "after this", { mode: "queue" });
    expect(opened.transcript().outbox[0]?.status).toBe("queued");
  };

  it("F-050: the gateway's `ok` cancels queued messages as it arrives, before the list is read again", async () => {
    const opened = await adminClient();
    const { client, fake, gateway, transcript } = opened;
    await queueForPip(opened);
    const held = deferred<unknown>();
    fake.handlers["agents.delete"] = () => {
      opened.state.bots = opened.state.bots.filter((bot) => bot.id !== "pip");
      fake.handlers["agents.list"] = () => held.promise;
      return { ok: true, agentId: "pip", removedBindings: 0, removed: [], failed: [] };
    };
    const pending = client.deleteBot(request(await client.readBotDelete("pip")));
    const lists = fake.calls("agents.list").length;
    await until(
      () => fake.calls("agents.list").length > lists && fake.calls("agents.delete").length === 1,
    );
    // The list after it is held; the run ends meanwhile: nothing queued starts.
    gateway.emit("agent", agentEvent("run-x", 2, "lifecycle", { phase: "end" }, PIP_TASK));
    await sleep(60);
    expect(sentTexts(gateway)).toEqual([]);
    expect(transcript().outbox[0]?.status).toBe("cancelled");
    // The connection is lost before the list answers: the cancellation stands.
    gateway.dropAll();
    expect(await pending).toMatchObject({ kind: "answered", listed: null });
    expect(transcript().outbox[0]?.status).toBe("cancelled");
    client.stop();
  });

  it("F-050: the run's end in the same batch as the gateway's `ok` starts no queued message", async () => {
    const opened = await adminClient();
    const { client, fake, gateway, transcript } = opened;
    await queueForPip(opened);
    // The delete's reply is held, then sent by hand with the run's end right behind it.
    fake.handlers["agents.delete"] = () => new Promise(() => {});
    const pending = client.deleteBot(request(await client.readBotDelete("pip")));
    await until(() => fake.calls("agents.delete").length === 1);
    const id = fake.requests.filter((each) => each.method === "agents.delete")[0]!.id;
    opened.state.bots = opened.state.bots.filter((bot) => bot.id !== "pip");
    const socket = (
      fake as unknown as { sockets: Array<{ push(frame: unknown): void }> }
    ).sockets.at(-1)!;
    socket.push({
      type: "res",
      id,
      ok: true,
      payload: { ok: true, agentId: "pip", removedBindings: 0, removed: [], failed: [] },
    });
    socket.push({
      type: "event",
      event: "agent",
      payload: agentEvent("run-x", 2, "lifecycle", { phase: "end" }, PIP_TASK),
    });
    expect(await pending).toMatchObject({ kind: "answered" });
    await sleep(60);
    expect(sentTexts(gateway)).toEqual([]);
    expect(transcript().outbox[0]?.status).toBe("cancelled");
    client.stop();
  });

  it("F-050: a message held by a question that came with its run's end leaves no run showing once it is cancelled", async () => {
    const opened = await adminClient();
    const { client, fake, gateway, transcript } = opened;
    await queueForPip(opened);
    const answer = deferred<unknown>();
    fake.handlers["agents.delete"] = () => answer.promise;
    const pending = client.deleteBot(request(await client.readBotDelete("pip")));
    await until(() => fake.calls("agents.delete").length === 1);
    // The run ends and a new question, from another run, arrives in the same batch: the queued
    // message starts a local run of its own, then is held before it is sent.
    const queued = transcript().outbox.find((message) => message.text === "after this")!;
    const socket = (
      fake as unknown as { sockets: Array<{ push(frame: unknown): void }> }
    ).sockets.at(-1)!;
    socket.push({
      type: "event",
      event: "agent",
      payload: agentEvent("run-x", 2, "lifecycle", { phase: "end" }, PIP_TASK),
    });
    listQuestion(fake, questionRecord("ask_1", "run-y", PIP_TASK));
    socket.push({
      type: "event",
      event: "question.requested",
      payload: questionRecord("ask_1", "run-y", PIP_TASK),
    });
    await until(() => transcript().outbox.find((m) => m.id === queued.id)?.status === "held");
    expect(transcript().runs.some((run) => run.id === queued.id)).toBe(true);
    opened.state.bots = opened.state.bots.filter((bot) => bot.id !== "pip");
    answer.resolve({ ok: true, agentId: "pip", removedBindings: 0, removed: [], failed: [] });
    expect(await pending).toMatchObject({ kind: "answered" });
    expect(transcript().outbox.find((m) => m.id === queued.id)?.status).toBe("cancelled");
    expect(transcript().runs.some((run) => run.id === queued.id)).toBe(false);
    expect(sentTexts(gateway)).not.toContain("after this");
    client.stop();
  });

  it("F-050: a held message released before the delete's answer runs once, under one run, and nothing is left showing", async () => {
    const opened = await adminClient();
    const { client, fake, gateway, transcript } = opened;
    await queueForPip(opened);
    const answer = deferred<unknown>();
    fake.handlers["agents.delete"] = () => answer.promise;
    const pending = client.deleteBot(request(await client.readBotDelete("pip")));
    await until(() => fake.calls("agents.delete").length === 1);
    const queued = transcript().outbox.find((message) => message.text === "after this")!;
    const socket = (
      fake as unknown as { sockets: Array<{ push(frame: unknown): void }> }
    ).sockets.at(-1)!;
    socket.push({
      type: "event",
      event: "agent",
      payload: agentEvent("run-x", 2, "lifecycle", { phase: "end" }, PIP_TASK),
    });
    listQuestion(fake, questionRecord("ask_1", "run-y", PIP_TASK));
    socket.push({
      type: "event",
      event: "question.requested",
      payload: questionRecord("ask_1", "run-y", PIP_TASK),
    });
    await until(() => transcript().outbox.find((m) => m.id === queued.id)?.status === "held");
    // The question settles before the delete answers: the message goes, in the one run it started,
    // which the gateway names.
    fake.handlers["chat.send"] = () => ({ runId: "run-gw", status: "started" });
    await client.dismissQuestion(PIP_TASK, "ask_1");
    await until(() => sentTexts(gateway).includes("after this"));
    const active = () => transcript().runs.filter((run) => isActive(run.state));
    await until(() => active().some((run) => run.id === "run-gw"));
    expect(active().map((run) => run.id)).toEqual(["run-gw"]);
    opened.state.bots = opened.state.bots.filter((bot) => bot.id !== "pip");
    answer.resolve({ ok: true, agentId: "pip", removedBindings: 0, removed: [], failed: [] });
    expect(await pending).toMatchObject({ kind: "answered" });
    expect(sentTexts(gateway).filter((text) => text === "after this")).toHaveLength(1);
    // The gateway keeps a run in flight going after the delete, and ends it in an error the next
    // time it reaches the bot's database (OpenClaw 2026.10.6). Until then it is running; then it
    // is over, as the gateway says.
    expect(active().map((run) => run.id)).toEqual(["run-gw"]);
    const ended = "OpenClaw agent database is unavailable while agent pip is deleted.";
    gateway.emit(
      "agent",
      agentEvent("run-gw", 1, "lifecycle", { phase: "error", error: ended }, PIP_TASK),
    );
    gateway.emit("chat", {
      runId: "run-gw",
      sessionKey: PIP_TASK,
      agentId: "pip",
      seq: 2,
      state: "error",
      errorMessage: ended,
    });
    await until(() => active().length === 0);
    expect(transcript().runs.find((run) => run.id === "run-gw")?.state).toBe("failed");
    client.stop();
  });

  it("F-050: a message promoted while write access is pending is cancelled with its run, and the access failing after leaves it cancelled", async () => {
    const opened = await adminClient();
    const { client, fake, gateway, transcript } = opened;
    await queueForPip(opened);
    // The delete is sent; its answer is held.
    const answer = deferred<unknown>();
    fake.handlers["agents.delete"] = () => answer.promise;
    const pending = client.deleteBot(request(await client.readBotDelete("pip")));
    await until(() => fake.calls("agents.delete").length === 1);
    // Meanwhile a steer is refused for want of write access: the host no longer holds it.
    fake.handlers["chat.send"] = () => {
      throw new GatewayError({
        code: "FORBIDDEN",
        message: "missing scope",
        details: {
          code: "MISSING_SCOPE",
          missingScope: "operator.write",
          requiredScopes: ["operator.write"],
        },
      });
    };
    const access = deferred<unknown>();
    fake.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
    fake.handlers["device.scopes.waitUpgrade"] = () => access.promise;
    client.sendMessage(PIP_TASK, "now");
    await until(() => client.state.connection.canWrite === false);
    // Another steer waits for access; the promoted message will wait behind it, its turn to come.
    const steer = client.sendMessage(PIP_TASK, "and this");
    await until(
      () => transcript().outbox.find((m) => m.id === steer)?.status === "awaiting-access",
    );
    // The run ends: the queued message is promoted, with a run of its own, and waits for access.
    const queued = transcript().outbox.find((message) => message.text === "after this")!;
    gateway.emit("agent", agentEvent("run-x", 2, "lifecycle", { phase: "end" }, PIP_TASK));
    await until(
      () => transcript().outbox.find((m) => m.id === queued.id)?.status === "awaiting-access",
    );
    expect(transcript().runs.some((run) => run.id === queued.id)).toBe(true);
    // The gateway's `ok` arrives.
    opened.state.bots = opened.state.bots.filter((bot) => bot.id !== "pip");
    answer.resolve({ ok: true, agentId: "pip", removedBindings: 0, removed: [], failed: [] });
    expect(await pending).toMatchObject({ kind: "answered" });
    expect(transcript().outbox.find((m) => m.id === queued.id)?.status).toBe("cancelled");
    expect(transcript().runs.some((run) => run.id === queued.id)).toBe(false);
    expect(transcript().outbox.find((m) => m.id === steer)?.status).toBe("cancelled");
    // Access is refused afterwards: both stay cancelled, no run comes back, and the delivery
    // waiting behind asks for no access of its own.
    const asked = fake.calls("device.scopes.requestUpgrade").length;
    access.resolve({ status: "rejected", requestId: "up-1" });
    await sleep(60);
    expect(fake.calls("device.scopes.requestUpgrade")).toHaveLength(asked);
    expect(transcript().outbox.find((m) => m.id === steer)?.status).toBe("cancelled");
    expect(transcript().outbox.find((m) => m.id === queued.id)?.status).toBe("cancelled");
    expect(transcript().runs.some((run) => run.id === queued.id)).toBe(false);
    expect(sentTexts(gateway)).not.toContain("after this");
    client.stop();
  });

  it("F-050: a read before the delete, answered back to back with a newer list, sends nothing", async () => {
    const { client, fake, state } = await adminClient();
    const read = await client.readBotDelete("pip");
    const preflight = deferred<unknown>();
    const newer = deferred<unknown>();
    const replies = [preflight.promise, newer.promise];
    fake.handlers["agents.list"] = () => replies.shift() ?? rosterOf(state.bots);
    const lists = fake.calls("agents.list").length;
    const pending = client.deleteBot({ ...request(read), deleteFiles: true });
    await until(() => fake.calls("agents.list").length === lists + 1);
    const other = client.readBotDelete("pip").catch(() => null);
    await until(() => fake.calls("agents.list").length === lists + 2);
    // Another client replaces Pip under the same id. The old list and the newer one arrive together.
    const old = rosterOf(state.bots);
    state.bots = state.bots.map((bot) =>
      bot.id === "pip" ? { ...bot, name: "Quill", createdAt: 77, workspace: "/w/quill" } : bot,
    );
    preflight.resolve(old);
    newer.resolve(rosterOf(state.bots));
    expect(await pending).toMatchObject({ kind: "unread" });
    expect(fake.calls("agents.delete")).toEqual([]);
    expect(await other).toMatchObject({ name: "Quill", createdAt: 77 });
    client.stop();
  });

  it("F-050: a dialog's read answered after a newer list is refused, never shown", async () => {
    const { client, fake, state } = await adminClient();
    const held = deferred<unknown>();
    const replies = [held.promise];
    fake.handlers["agents.list"] = () => replies.shift() ?? rosterOf(state.bots);
    const old = rosterOf(state.bots.filter((bot) => bot.id !== "pip"));
    const stale = client.readBotDelete("pip");
    // A newer list, which shows Pip, is shown first.
    expect(await client.readBotDelete("pip")).toMatchObject({ listed: true });
    held.resolve(old);
    await expect(stale).rejects.toThrow("The bot list changed while Clawtrate read it");
    expect(client.state.bots.some((bot) => bot.id === "pip")).toBe(true);
    client.stop();
  });

  it("F-050: opening the dialog for a bot the list doesn't show cancels nothing", async () => {
    const opened = await adminClient();
    await queueForPip(opened);
    // The gateway hides Pip from this operator's list; it still has it.
    opened.fake.handlers["agents.list"] = () =>
      rosterOf(opened.state.bots.filter((bot) => bot.id !== "pip"));
    expect(await opened.client.readBotDelete("pip")).toMatchObject({ listed: false });
    expect(opened.transcript().outbox[0]?.status).toBe("queued");
    opened.client.stop();
  });

  it("F-050: only the gateway's `ok` for this bot cancels its queued messages; another answer leaves them", async () => {
    const opened = await adminClient();
    const { client, fake, transcript } = opened;
    await queueForPip(opened);
    fake.handlers["agents.delete"] = () => ({ ok: true, agentId: "marlow", removedBindings: 0 });
    expect(await client.deleteBot(request(await client.readBotDelete("pip")))).toMatchObject({
      kind: "unconfirmed",
    });
    expect(transcript().outbox[0]?.status).toBe("queued");
    fake.handlers["agents.delete"] = () => {
      opened.state.bots = opened.state.bots.filter((bot) => bot.id !== "pip");
      return { ok: true, agentId: "pip", removedBindings: 0, removed: [], failed: [] };
    };
    expect(await client.deleteBot(request(await client.readBotDelete("pip")))).toMatchObject({
      kind: "answered",
      listed: false,
    });
    expect(transcript().outbox[0]?.status).toBe("cancelled");
    // The run ends: nothing queued starts.
    opened.gateway.emit("agent", agentEvent("run-x", 2, "lifecycle", { phase: "end" }, PIP_TASK));
    await sleep(60);
    expect(sentTexts(opened.gateway)).toEqual([]);
    client.stop();
  });

  it("F-050: a read before the delete that a newer list superseded sends nothing", async () => {
    const { client, fake, state } = await adminClient();
    const read = await client.readBotDelete("pip");
    const held = deferred<unknown>();
    fake.handlers["agents.list"] = () => held.promise;
    const pending = client.deleteBot(request(read));
    await until(() => fake.calls("agents.list").length >= 3);
    // A newer read is shown first: the held one is obsolete when it answers.
    fake.handlers["agents.list"] = () => rosterOf(state.bots);
    await client.readBotDelete("pip");
    // The held read omitted Pip, which the newer list shows: it says nothing of Pip either.
    held.resolve(rosterOf(state.bots.filter((bot) => bot.id !== "pip")));
    expect(await pending).toMatchObject({ kind: "unread" });
    expect(fake.calls("agents.delete")).toEqual([]);
    expect(client.state.bots.some((bot) => bot.id === "pip")).toBe(true);
    client.stop();
  });

  it("F-050: a read after the delete that a newer list superseded doesn't decide the result", async () => {
    const { client, fake, state } = await adminClient();
    const read = await client.readBotDelete("pip");
    const held = deferred<unknown>();
    fake.handlers["agents.delete"] = () => {
      state.bots = state.bots.filter((bot) => bot.id !== "pip");
      fake.handlers["agents.list"] = () => held.promise;
      return { ok: true, agentId: "pip", removedBindings: 0, removed: [], failed: [] };
    };
    const pending = client.deleteBot(request(read));
    await until(() => fake.calls("agents.delete").length === 1);
    await until(() => fake.calls("agents.list").length >= 4);
    // A newer list, which shows Pip made again, is shown before the old read answers.
    fake.handlers["agents.list"] = () => rosterOf(state.bots);
    state.bots.push({ id: "pip", name: "Pip", workspace: "/w/new", createdAt: 99 });
    await client.readBotDelete("pip");
    held.resolve(rosterOf(state.bots.filter((bot) => bot.id !== "pip")));
    expect(await pending).toMatchObject({ kind: "answered", listed: null });
    expect(client.state.bots.some((bot) => bot.id === "pip")).toBe(true);
    client.stop();
  });
});

describe("deleting a bot: the host's bookkeeping", () => {
  const request = (read: BotDeleteRead, deleteFiles = false): DeleteRequest => ({
    botId: read.botId,
    stamp: read.stamp,
    deleteFiles,
    reviewed: reviewOf(read),
    typed: read.confirm.text,
  });

  it("F-050: a request of the old connection is never sent on the one that replaced it, though that one takes requests", async () => {
    const { client, fake, switchTo } = await adminClient();
    // The connection a delete holds, taken as the delete takes it.
    const host = client as unknown as {
      deleteLink(): unknown;
      botDeleteContext(link: unknown, stamp: BotDeleteContext["stamp"]): BotDeleteContext;
    };
    const ctx = host.botDeleteContext(host.deleteLink(), {
      gatewayId: GATEWAY,
      target: client.state.connection.target,
    });
    await switchTo(GATEWAY);
    // The new connection answers others' requests; the old operation's are refused.
    expect(await client.readBotDelete("pip")).toMatchObject({ listed: true });
    const lists = fake.calls("agents.list").length;
    await expect(
      ctx.request("agents.delete", { agentId: "pip", deleteFiles: false }),
    ).rejects.toThrow();
    await expect(ctx.readBots()).rejects.toThrow();
    expect(fake.calls("agents.delete")).toEqual([]);
    expect(fake.calls("agents.list")).toHaveLength(lists);
    client.stop();
  });

  it("F-050: past eight deletes under way the next is refused, and once one ends another goes", async () => {
    const { client, fake, state } = await adminClient();
    const ids = Array.from({ length: 9 }, (_, n) => `bot${n}`);
    state.bots.push(
      ...ids.map((id, n) => ({ id, name: `Bot ${n}`, workspace: `/w/${id}`, createdAt: 10 + n })),
    );
    const held = new Map<string, () => void>();
    fake.handlers["agents.delete"] = (params) => {
      const id = String((params as Json).agentId);
      const answer = deferred<unknown>();
      held.set(id, () => answer.resolve(null));
      return answer.promise.then(() => {
        state.bots = state.bots.filter((bot) => bot.id !== id);
        return { ok: true, agentId: id, removedBindings: 0, removed: [], failed: [] };
      });
    };
    // One dialog after another, each on the newest list.
    const reads: BotDeleteRead[] = [];
    for (const id of ids) reads.push(await client.readBotDelete(id));
    // Eight confirmations, one after another; each is sent and waits for the gateway.
    const running: Array<Promise<unknown>> = [];
    for (const read of reads.slice(0, 8)) {
      running.push(client.deleteBot(request(read)));
      await until(() => held.size === running.length);
    }
    expect(await client.deleteBot(request(reads[8]!))).toMatchObject({
      kind: "not-sent",
      message: expect.stringMatching(/Too many deletes/),
    });
    expect(fake.calls("agents.delete")).toHaveLength(8);
    held.get("bot0")!();
    await running[0];
    const ninth = client.deleteBot(request(reads[8]!));
    await until(() => fake.calls("agents.delete").length === 9);
    for (const release of held.values()) release();
    expect(await ninth).toMatchObject({ kind: "answered" });
    await Promise.all(running);
    client.stop();
  });

  it("F-050: a bot list that isn't whole is never shown as the rail, even when it is the newest", async () => {
    const { client, fake } = await adminClient();
    const before = client.state.bots.map((bot) => bot.id);
    expect(before).toContain("pip");
    fake.handlers["agents.list"] = () => ({ agents: [] });
    await expect(client.readBotDelete("pip")).rejects.toThrow("didn't come back whole");
    expect(client.state.bots.map((bot) => bot.id)).toEqual(before);
    client.stop();
  });
});
