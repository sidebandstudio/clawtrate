// Clawtrate's guides as a marked section in a bot's AGENTS.md (#532, #544, #628): render, find,
// replace and remove, each bot's state, the switch and the rows' changes, Clawtrate's own change
// with nothing asked, and the client's guards. The gateway's half is the guide checks of
// `pnpm scenarios` (guides-checks.ts).
import { describe, expect, it, vi } from "vitest";
import { sha256Hex, utf8Bytes } from "../src/bytes.ts";
import { VOICE_GUIDE, WHERE_GUIDE } from "../src/guide-text.ts";
import { VOICE_GET } from "../src/voice.ts";
import {
  applyGuidesChange,
  GUIDES_NOT_READ,
  GUIDES_NOT_RECORDED,
  GUIDES_NOT_SAVED,
  GUIDES_DEFAULT_KEY,
  GUIDES_DEFAULT_NOT_SAVED,
  GUIDES_ON_NOT_RECORDED,
  refusedForGood,
  GUIDES_OFF,
  GUIDES_ON,
  guidesLimit,
  guidesWouldBeCut,
  findSection,
  GUIDES_LONG_CHARS,
  GUIDES_PINNED_SHA256,
  GUIDES_VERSION,
  GUIDES_NOTICE,
  GUIDES_SECTION,
  GUIDES_TEXT,
  guidesKey,
  MAX_CHANGED_SECTION_CHARS,
  parseGuidesRecord,
  readGuideFolders,
  withoutSection,
  withSection,
  fitGuidesHistory,
  GUIDES_HISTORY_KEY,
  GUIDES_HISTORY_NOT_SAVED,
  offRecord,
  MAX_GUIDES_HISTORY_BYTES,
} from "../src/guides.ts";
import { ADMIN_SCOPES, INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
import type { BotGuidesAnswer, GuidesChange } from "../src/guides.ts";
import { agentEvent, grantingGateway, openTask } from "./client-harness.ts";
import { GatewayError, memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { ClawtrateClient, CONNECTION_CHANGED } from "../src/client.ts";
import { PUBLISHED_SECTIONS } from "./guides-published.ts";
import { FAST } from "./client-harness.ts";
import { URL_A } from "./client-harness.ts";

const hash = (text: string) => sha256Hex(utf8Bytes(text));
/** The folders a record keeps for `bots` of `fakeFiles`: each reads `/w/<its name>`, or `shared`'s. */
const at = (bots: string[], shared: Record<string, string> = {}) =>
  Object.fromEntries(bots.map((bot) => [bot, hash(`w:/w/${shared[bot] ?? bot}`).slice(0, 16)]));
/** What the section adds to each prompt, with the blank line after it. */
const GUIDES_SIZE = GUIDES_SECTION.length + 1;
const BOT_FILE = "# AGENTS.md\n\nYou help with the house.\n- Be brief.\n";

/** A section of another version, as Clawtrate wrote it: its marker's hash matches its text. */
function olderSection(text = "## An older guide\n") {
  const inner = `${GUIDES_NOTICE}\n${text}`;
  return `<!-- clawtrate:guides begin v0 sha256=${hash(inner)} -->\n${inner}<!-- clawtrate:guides end -->\n`;
}

/** A gateway's bots and their AGENTS.md, answering agents.list, .files.get and .files.set. */
function fakeFiles(
  files: Record<string, string | null>,
  workspaces: Record<string, string> = {},
  /** The hash of a file's bytes on disk, where they aren't the UTF-8 of its text. */
  bytesHash: Record<string, string> = {},
  /** What `config.get` answers: by default a config that sets no limit; null, a read that fails. */
  config: Record<string, unknown> | null = {},
) {
  const store = new Map(Object.entries(files));
  const hashOf = (key: string, content: string) => bytesHash[key] ?? hash(content);
  const sets: { agentId: string; content: string }[] = [];
  const faults = { conflicts: 0, refuse: new Set<string>(), unavailable: 0 };
  /** The person's preferences on the gateway (`users.prefs`); `prefs.answer` other than ok: kept none. */
  const prefs = {
    entries: new Map<string, unknown>(),
    answer: "ok" as string,
    sets: 0,
    /** A save the gateway fails, as it does when its store is busy. */
    failSets: false,
  };
  const folder = (agentId: string) => workspaces[agentId] ?? agentId;
  const request = async (method: string, params: unknown) => {
    const p = params as Record<string, unknown>;
    if (method === "agents.list")
      return {
        defaultId: Object.keys(files)[0] ?? "main",
        mainKey: "main",
        scope: "per-sender",
        agents: Object.keys(files).map((id) => ({ id, workspace: `/w/${folder(id)}` })),
      };
    const key = folder(p.agentId as string);
    const content = store.get(key) ?? null;
    if (method === "agents.files.get")
      return {
        file:
          content === null
            ? { name: "AGENTS.md", missing: true }
            : { name: "AGENTS.md", content, hash: hashOf(key, content) },
      };
    if (method === "agents.files.set") {
      const held =
        content === null ? p.expectedMissing === true : p.expectedHash === hashOf(key, content);
      // The gateway's own refusal: it carries the gateway's code, as the protocol client's does.
      // The gateway's refusal for good, as the protocol client gives it.
      if (faults.refuse.has(key))
        throw new GatewayProtocolRequestError({
          code: "INVALID_REQUEST",
          message: "Workspace document exceeds its write bound",
        });
      // A handler's thrown error: the gateway answers it as `UNAVAILABLE`, `"Error: …"`.
      if (faults.unavailable > 0) {
        faults.unavailable -= 1;
        throw new GatewayProtocolRequestError({
          code: "UNAVAILABLE",
          message: "Error: Workspace access changed while saving an Agent document",
        });
      }
      if (!held || faults.conflicts > 0) {
        faults.conflicts = Math.max(0, faults.conflicts - 1);
        throw Object.assign(new Error("file changed"), {
          details: { type: "agent_file_conflict", name: "AGENTS.md" },
        });
      }
      store.set(key, p.content as string);
      delete bytesHash[key];
      sets.push({ agentId: p.agentId as string, content: p.content as string });
      return { ok: true };
    }
    if (method === "config.get") {
      if (config === null) throw new Error("config.get failed");
      // As both OpenClaw versions answer it: the file's revision beside the one the gateway applied.
      return { config, hash: "h", valid: true, configRevisionHash: "r1", appliedConfigHash: "r1" };
    }
    if (method === "users.prefs.get") {
      if (prefs.answer !== "ok") return { status: prefs.answer };
      const keys = (p.keys as string[] | undefined) ?? [...prefs.entries.keys()];
      return {
        status: "ok",
        entries: Object.fromEntries(
          keys.filter((key) => prefs.entries.has(key)).map((key) => [key, prefs.entries.get(key)]),
        ),
      };
    }
    if (method === "users.prefs.set") {
      if (prefs.failSets) throw new Error("database is locked");
      if (prefs.answer !== "ok") return { status: prefs.answer };
      const expected = (p.expectedEntries ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(expected))
        if (JSON.stringify(prefs.entries.get(key) ?? null) !== JSON.stringify(value))
          return { status: "conflict" };
      for (const [key, value] of Object.entries(p.entries as Record<string, unknown>))
        prefs.entries.set(key, value);
      prefs.sets += 1;
      return { status: "ok" };
    }
    throw new Error(`unknown method ${method}`);
  };
  return { request, store, sets, faults, prefs };
}

describe("the section", () => {
  it("is the two guides between Clawtrate's markers, with the hash of what's between them", () => {
    const lines = GUIDES_SECTION.split("\n");
    expect(lines[0]).toMatch(/^<!-- clawtrate:guides begin v2 sha256=[a-f0-9]{64} -->$/);
    expect(lines[1]).toBe(GUIDES_NOTICE);
    expect(GUIDES_NOTICE).toContain("Turn it off in Clawtrate: Settings, Conversation.");
    expect(GUIDES_SECTION.endsWith("<!-- clawtrate:guides end -->\n")).toBe(true);
    expect(GUIDES_TEXT).toBe(`${VOICE_GUIDE}\n\n${WHERE_GUIDE}`);
    expect(GUIDES_SECTION.split(VOICE_GUIDE)).toHaveLength(2);
    expect(GUIDES_SECTION.split(WHERE_GUIDE)).toHaveLength(2);
    // It is in every run's prompt: bounded, and said in Settings.
    expect(GUIDES_SIZE).toBe(3_966);
    expect(GUIDES_SIZE).toBeLessThanOrEqual(4_000);
  });

  it("adds at the top and takes out again, leaving every other byte as it was", () => {
    for (const before of [
      BOT_FILE,
      "",
      "\n",
      "\nstarts blank",
      "no newline at end",
      "a\r\nb\r\n",
    ]) {
      const added = withSection(before);
      expect(added.startsWith(GUIDES_SECTION)).toBe(true);
      expect(findSection(added)).toMatchObject({ kind: "ours", current: true, start: 0 });
      expect(withoutSection(added)).toBe(before);
      // Adding again changes nothing.
      expect(withSection(added)).toBe(added);
    }
    // An empty file gets the blank line after the section too, so a line the person adds below
    // it later is theirs, and stays when the section is taken out.
    expect(withSection("")).toBe(`${GUIDES_SECTION}\n`);
    expect(withoutSection(`${withSection("")}\n# Theirs\n`)).toBe("\n# Theirs\n");
    // A byte-order mark stays first: the section goes right after it, and comes out again.
    for (const before of ["\uFEFF# Otto\n", "\uFEFF"]) {
      const added = withSection(before);
      expect(added).toBe(`\uFEFF${GUIDES_SECTION}\n${before.slice(1)}`);
      expect(findSection(added)).toMatchObject({ kind: "ours", current: true, start: 1 });
      expect(withoutSection(added)).toBe(before);
    }
    expect(withoutSection(BOT_FILE)).toBe(BOT_FILE);
  });

  it("replaces an older version in place at the top, and leaves one anywhere else alone", () => {
    const top = `${olderSection()}\nBelow.\n`;
    expect(findSection(top)).toMatchObject({ kind: "ours", current: false });
    expect(withSection(top)).toBe(`${GUIDES_SECTION}\nBelow.\n`);
    // Changed on purpose: a section below other text isn't where Clawtrate put it, so it is
    // shown and never written, whether it is older or current.
    const lower = `# Top\n\n${olderSection()}\nBelow.\n`;
    expect(findSection(lower)).toMatchObject({ kind: "changed", replaceable: false, moved: true });
    expect(withSection(lower)).toBe(lower);
    expect(withoutSection(lower)).toBe(lower);
  });

  it("calls a section changed when its text, its hash or its markers aren't as Clawtrate wrote them", () => {
    const edited = withSection(BOT_FILE).replace("Lead with the answer", "Lead with a joke");
    expect(findSection(edited)).toMatchObject({ kind: "changed", start: 0 });
    const noEnd = withSection(BOT_FILE).replace("<!-- clawtrate:guides end -->\n", "");
    expect(findSection(noEnd).kind).toBe("changed");
    const twice = `${GUIDES_SECTION}\n${GUIDES_SECTION}`;
    expect(findSection(twice).kind).toBe("changed");
    const loose = "<!-- clawtrate:guides begin v1 -->\nhi\n<!-- clawtrate:guides end -->\nrest\n";
    const found = findSection(loose);
    expect(found).toMatchObject({ kind: "changed", replaceable: false, start: 0 });
    // Markers out of shape: nothing can tell where the section ends, so nothing is written.
    expect(withSection(loose)).toBe(loose);
    expect(withoutSection(loose)).toBe(loose);
    // A marker inside other text is not one: only whole lines count.
    expect(findSection("See `<!-- clawtrate:guides begin` in the docs.\n").kind).toBe("none");
  });
});

describe("the bots' states", () => {
  it("reads each folder once, and tells removed from never added by this device's record", async () => {
    const { request } = fakeFiles(
      {
        pip: withSection(BOT_FILE),
        marlow: withSection(BOT_FILE).replace("Be warm", "Be cold"),
        otto: olderSection() + BOT_FILE,
        juniper: BOT_FILE,
        main: BOT_FILE,
        shared: null,
      },
      { shared: "pip" },
    );
    const folders = await readGuideFolders(request, { on: true, bots: ["juniper"] });
    const state = Object.fromEntries(folders.map((f) => [f.bots.join("+"), f.state]));
    expect(state).toEqual({
      "pip+shared": "current",
      marlow: "changed",
      otto: "older",
      juniper: "removed",
      main: "none",
    });
    expect(folders.find((f) => f.bots[0] === "marlow")?.changedText).toContain("Be cold");
  });

  it("says a file couldn't be read rather than guess its state", async () => {
    const folders = await readGuideFolders(async (method) => {
      if (method === "agents.list") return { agents: [{ id: "pip", workspace: "/w/pip" }] };
      throw new Error("missing scope: operator.read");
    }, null);
    expect(folders).toEqual([
      {
        bots: ["pip"],
        state: null,
        replaceable: false,
        moved: false,
        long: false,
        utf8: true,
        missing: false,
        refused: null,
        changedText: null,
        error: "missing scope: operator.read",
      },
    ]);
  });
});

describe("the switch and the rows' changes", () => {
  it("a row's Add adds to its bots only, once per shared folder, and records them", async () => {
    const files = fakeFiles({ pip: BOT_FILE, shared: BOT_FILE, otto: BOT_FILE }, { shared: "pip" });
    const result = await applyGuidesChange(files.request, null, { action: "add", bots: ["pip"] });
    expect(result).toEqual({
      record: {
        on: true,
        bots: ["pip", "shared"],
        folders: at(["pip", "shared"], { shared: "pip" }),
      },
      errors: [],
      wrote: true,
      missing: [],
    });
    expect(files.sets).toHaveLength(1);
    expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
    expect(files.store.get("otto")).toBe(BOT_FILE);
  });

  it("never writes over a section changed outside Clawtrate, unless asked to replace it", async () => {
    const changed = withSection(BOT_FILE).replace("Be warm", "Be cold");
    const files = fakeFiles({ pip: changed });
    await applyGuidesChange(files.request, null, { action: "add", bots: ["pip"] });
    await applyGuidesChange(files.request, null, { action: "auto" });
    await applyGuidesChange(files.request, null, { action: "switch", on: true });
    await applyGuidesChange(files.request, null, { action: "switch", on: false });
    expect(files.sets).toEqual([]);
    const shown = (findSection(changed) as { text: string }).text;
    await applyGuidesChange(files.request, null, { action: "replace", bot: "pip", shown });
    expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
  });

  it("replaces only the section the person was shown: one changed again since is left", async () => {
    const changed = withSection(BOT_FILE).replace("Be warm", "Be cold");
    const shown = (findSection(changed) as { text: string }).text;
    const files = fakeFiles({ pip: changed.replace("Be cold", "Be colder") });
    const result = await applyGuidesChange(files.request, null, {
      action: "replace",
      bot: "pip",
      shown,
    });
    expect(files.sets).toEqual([]);
    expect(result.errors).toEqual([
      "pip: AGENTS.md changed again after Settings read it, so nothing was replaced. Look at its section again before you replace it.",
    ]);
    expect(result.record).toEqual({ on: true, bots: [] });
  });

  it("takes Replace from a viewer only with the section it was shown, at most what Show shows", () => {
    const command = {
      type: "changeBotGuides",
      change: { action: "replace", bot: "pip", shown: "<!-- clawtrate:guides begin -->" },
      stamp: { gatewayId: "gw-a", target: 1 },
    };
    expect(parseBridgeCommand(command)).toEqual(command);
    for (const shown of [undefined, 7, "x".repeat(MAX_CHANGED_SECTION_CHARS + 1)])
      expect(() =>
        parseBridgeCommand({ ...command, change: { action: "replace", bot: "pip", shown } }),
      ).toThrow("invalid guides change");
  });

  it("takes the switch from a viewer only as on or off, and never Clawtrate's own change", () => {
    const command = {
      type: "changeBotGuides",
      change: { action: "switch", on: false },
      stamp: { gatewayId: "gw-a", target: 1 },
    };
    expect(parseBridgeCommand(command)).toEqual(command);
    for (const change of [
      ...[undefined, "false", 0].map((on) => ({ action: "switch", on })),
      { action: "auto" },
      { action: "auto", bot: "pip" },
      // #542's changes, from a viewer of an earlier build: none of them is taken.
      { action: "remove" },
      { action: "decline" },
      { action: "newBots", on: true },
      { action: "update" },
    ])
      expect(() => parseBridgeCommand({ ...command, change })).toThrow("invalid guides change");
  });

  it("brings an older version up to date by itself, and leaves a current one", async () => {
    const files = fakeFiles({ otto: olderSection() + BOT_FILE, juniper: GUIDES_SECTION });
    const result = await applyGuidesChange(files.request, null, { action: "auto" });
    expect(result.errors).toEqual([]);
    expect(files.sets.map((set) => set.agentId)).toEqual(["otto"]);
    expect(findSection(files.store.get("otto")!)).toMatchObject({ kind: "ours", current: true });
  });

  it("turned off, takes it out of every file as it was, and forgets the bots so none reads as removed", async () => {
    const files = fakeFiles({ pip: withSection(BOT_FILE), otto: withSection(""), main: BOT_FILE });
    const result = await applyGuidesChange(
      files.request,
      { on: true, bots: ["pip", "otto"] },
      { action: "switch", on: false },
    );
    expect(result.record).toEqual({ on: false, bots: [] });
    expect(files.store.get("pip")).toBe(BOT_FILE);
    expect(files.store.get("otto")).toBe("");
    expect(files.sets).toHaveLength(2);
  });

  it("reads again and retries once when the file changed meanwhile, then says it left it", async () => {
    const files = fakeFiles({ pip: BOT_FILE });
    files.faults.conflicts = 1;
    await applyGuidesChange(files.request, null, { action: "add", bots: ["pip"] });
    expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
    const again = fakeFiles({ pip: BOT_FILE });
    again.faults.conflicts = 2;
    const result = await applyGuidesChange(again.request, null, { action: "add", bots: ["pip"] });
    expect(result.errors).toEqual([
      "pip: AGENTS.md kept changing while Clawtrate wrote it, so it was left as it is.",
    ]);
    expect(result.record).toEqual({ on: true, bots: [] });
    expect(again.store.get("pip")).toBe(BOT_FILE);
    // Clawtrate's own change reads again and retries once too.
    const own = fakeFiles({ pip: BOT_FILE });
    own.faults.conflicts = 1;
    await applyGuidesChange(own.request, null, { action: "auto" });
    expect(own.store.get("pip")).toBe(withSection(BOT_FILE));
  });

  it("while it is off, adds and replaces nothing, whoever asks, and asks the gateway nothing", async () => {
    const off = { on: false, bots: [] };
    const nothing = () => Promise.reject(new Error("nothing may be asked"));
    expect(await applyGuidesChange(nothing, off, { action: "auto" })).toEqual({
      record: off,
      errors: [],
      wrote: false,
      missing: [],
    });
    for (const change of [
      { action: "add", bots: ["pip"] },
      { action: "replace", bot: "pip", shown: "" },
    ] as GuidesChange[])
      expect(await applyGuidesChange(nothing, off, change)).toEqual({
        record: off,
        errors: [GUIDES_OFF],
        wrote: false,
        missing: [],
      });
  });

  it("by itself, leaves a section someone removed while it wrote, though this device didn't know it", async () => {
    // Otto's older section is being brought up to date when someone takes it out: the write is
    // refused for its stale hash, and the read again finds no section.
    const files = fakeFiles({ otto: olderSection() + BOT_FILE });
    let removed = false;
    const request = async (method: string, params: unknown) => {
      if (method === "agents.files.set" && !removed) {
        removed = true;
        files.store.set("otto", BOT_FILE);
      }
      return files.request(method, params);
    };
    const result = await applyGuidesChange(request, null, { action: "auto" });
    expect(removed).toBe(true);
    expect(files.store.get("otto")).toBe(BOT_FILE);
    expect(files.sets).toEqual([]);
    // Recorded as one it saw, so the next change leaves it too.
    expect(result.record).toEqual({ on: true, bots: ["otto"], folders: at(["otto"]) });
    await applyGuidesChange(request, result.record, { action: "auto" });
    expect(files.store.get("otto")).toBe(BOT_FILE);
  });

  it("keeps in its record only bots still on the gateway's list", async () => {
    const files = fakeFiles({ pip: withSection(BOT_FILE) });
    for (const change of [
      { action: "auto" },
      { action: "switch", on: true },
      { action: "add", bots: ["pip"] },
    ] as GuidesChange[])
      expect(
        (await applyGuidesChange(files.request, { on: true, bots: ["gone", "pip"] }, change))
          .record,
        change.action,
      ).toEqual({ on: true, bots: ["pip"], folders: at(["pip"]) });
  });

  it("keeps a record it can read back, and refuses one it can't", () => {
    expect(parseGuidesRecord(JSON.stringify({ on: true, bots: ["pip", 3] }))).toEqual({
      on: true,
      bots: ["pip"],
    });
    expect(parseGuidesRecord(JSON.stringify({ on: false, bots: [] }))).toEqual({
      on: false,
      bots: [],
    });
    for (const bad of [
      null,
      "",
      "{",
      "[]",
      "{not json",
      JSON.stringify({ bots: ["pip"] }),
      JSON.stringify({ on: "no", bots: [] }),
      JSON.stringify({ on: true }),
    ])
      expect(parseGuidesRecord(bad), String(bad)).toBeNull();
    // Off is off, whatever else is there.
    for (const off of [{ on: false }, { on: false, bots: "x" }, { on: false, bots: [3] }])
      expect(parseGuidesRecord(JSON.stringify(off))).toEqual({ on: false, bots: [] });
  });

  it("reads every record left by the card before the switch as on, with the bots it added", () => {
    const old = (bots: string[], newBots: boolean) =>
      parseGuidesRecord(JSON.stringify({ bots, newBots }));
    // "Not now", "Remove from all bots", or New bots too turned off with nothing added: the same
    // bytes, which can't be told apart. Bots know how Clawtrate works by default.
    expect(old([], false)).toEqual({ on: true, bots: [] });
    expect(old(["pip"], false)).toEqual({ on: true, bots: ["pip"] });
    expect(old([], true)).toEqual({ on: true, bots: [] });
    expect(old(["pip"], true)).toEqual({ on: true, bots: ["pip"] });
  });

  it("takes the gateway's own limit for a bot's AGENTS.md, as OpenClaw resolves it", () => {
    const answer = (agents: Record<string, unknown>) => ({ config: { agents }, hash: "h" });
    expect(guidesLimit({}, "pip")).toBe(GUIDES_LONG_CHARS);
    expect(guidesLimit(answer({ defaults: { bootstrapMaxChars: 10_000 } }), "pip")).toBe(10_000);
    // The bot's own value comes first, from either roster shape, by its id in any case.
    const own = { bootstrapMaxChars: 8_000 };
    expect(
      guidesLimit(
        answer({ defaults: { bootstrapMaxChars: 10_000 }, entries: { Pip: own } }),
        "pip",
      ),
    ).toBe(8_000);
    expect(guidesLimit(answer({ list: [{ id: "pip", ...own }] }), "pip")).toBe(8_000);
    expect(guidesLimit(answer({ list: [{ id: "otto", ...own }] }), "pip")).toBe(GUIDES_LONG_CHARS);
    // Never more than the total for all instruction files, which AGENTS.md comes first in.
    expect(
      guidesLimit(
        answer({ defaults: { bootstrapMaxChars: 50_000, bootstrapTotalMaxChars: 30_000 } }),
        "pip",
      ),
    ).toBe(30_000);
    expect(guidesLimit(answer({ defaults: { bootstrapMaxChars: 90_000 } }), "pip")).toBe(60_000);
    // Only a positive number counts, rounded down.
    for (const bad of [0, -5, "9000", null, Number.NaN])
      expect(guidesLimit(answer({ defaults: { bootstrapMaxChars: bad } }), "pip")).toBe(
        GUIDES_LONG_CHARS,
      );
    expect(guidesLimit(answer({ defaults: { bootstrapMaxChars: 9_999.9 } }), "pip")).toBe(9_999);
  });

  it("by itself, never writes a file past the gateway's own lowered limit; the person's Add still can", async () => {
    // 8,000 characters fit a limit of 10,000 whole today; with the section they wouldn't.
    const file = `# Pip\n${"x".repeat(8_000)}\n`;
    const config = { agents: { defaults: { bootstrapMaxChars: 10_000 } } };
    for (const change of [{ action: "auto" }, { action: "switch", on: true }] as GuidesChange[]) {
      const files = fakeFiles({ pip: file }, {}, {}, config);
      await applyGuidesChange(files.request, null, change);
      expect(files.sets, change.action).toEqual([]);
    }
    const [folder] = await readGuideFolders(fakeFiles({ pip: file }, {}, {}, config).request, null);
    expect(folder?.long).toBe(true);
    // At the default limit it fits, and is written.
    const plain = fakeFiles({ pip: file });
    await applyGuidesChange(plain.request, null, { action: "auto" });
    expect(plain.sets).toHaveLength(1);
    const asked = fakeFiles({ pip: file }, {}, {}, config);
    await applyGuidesChange(asked.request, null, { action: "add", bots: ["pip"] });
    expect(asked.sets).toHaveLength(1);
  });

  it("by itself, writes nothing while the gateway's limit can't be read, and writes at the next occasion; the person's Add still can", async () => {
    // The config can't be read: the limit isn't known, so 20,000 isn't assumed.
    for (const change of [{ action: "auto" }, { action: "switch", on: true }] as GuidesChange[]) {
      const files = fakeFiles({ pip: BOT_FILE, otto: olderSection() + BOT_FILE }, {}, {}, null);
      const result = await applyGuidesChange(files.request, null, change);
      expect(files.sets, change.action).toEqual([]);
      expect(result.record?.bots ?? [], change.action).not.toContain("pip");
      // The next occasion, with the config readable and no limit set: 20,000, and written.
      const later = fakeFiles({ pip: BOT_FILE }, {}, {}, {});
      await applyGuidesChange(later.request, result.record, { action: "auto" });
      expect(later.store.get("pip")).toBe(withSection(BOT_FILE));
    }
    const asked = fakeFiles({ pip: BOT_FILE }, {}, {}, null);
    await applyGuidesChange(asked.request, null, { action: "add", bots: ["pip"] });
    expect(asked.store.get("pip")).toBe(withSection(BOT_FILE));
  });

  it("by itself, writes nothing while the gateway's settings file is invalid or not yet applied, as its answer says", async () => {
    // The gateway answers a settings file it can't read or parse with `valid: false` and an empty
    // `config`: every setting reads unset, so its limit would read as 20,000 though it may be lower.
    // 9,500 characters fit a gateway limit of 10,000 whole; with the section they wouldn't.
    const long = `# Pip\n${"x".repeat(9_500)}\n`;
    for (const change of [{ action: "auto" }, { action: "switch", on: true }] as GuidesChange[]) {
      const files = fakeFiles({ pip: long });
      const request: (method: string, params: unknown) => Promise<unknown> = (method, params) =>
        method === "config.get"
          ? Promise.resolve({
              valid: false,
              config: {},
              hash: "h",
              issues: [],
              configRevisionHash: null,
              appliedConfigHash: "r1",
            })
          : files.request(method, params);
      const result = await applyGuidesChange(request, null, change);
      expect(files.sets, change.action).toEqual([]);
      expect(result.record?.bots ?? [], change.action).not.toContain("pip");
    }
    // A saved revision the gateway hasn't applied yet, or an answer without both revisions: what
    // it runs may still set a lower limit.
    const revisions: [string, Record<string, unknown>, number][] = [
      ["applied", { configRevisionHash: "r2", appliedConfigHash: "r2" }, 1],
      ["not applied yet", { configRevisionHash: "r2", appliedConfigHash: "r1" }, 0],
      ["no applied revision", { configRevisionHash: "r2", appliedConfigHash: null }, 0],
      ["no revisions", {}, 0],
    ];
    for (const [name, fields, written] of revisions) {
      const files = fakeFiles({ pip: long });
      const request: (method: string, params: unknown) => Promise<unknown> = (method, params) =>
        method === "config.get"
          ? Promise.resolve({ valid: true, config: {}, hash: "h", ...fields })
          : files.request(method, params);
      await applyGuidesChange(request, null, { action: "auto" });
      expect(files.sets, name).toHaveLength(written);
    }
    // The same file under a valid config that sets no limit is written.
    const valid = fakeFiles({ pip: long }, {}, {}, {});
    await applyGuidesChange(valid.request, null, { action: "auto" });
    expect(valid.sets).toHaveLength(1);
    // The person's own Add doesn't depend on the limit.
    const asked = fakeFiles({ pip: long });
    const askedRequest: (method: string, params: unknown) => Promise<unknown> = (method, params) =>
      method === "config.get"
        ? Promise.resolve({
            valid: false,
            config: {},
            hash: "h",
            issues: [],
            configRevisionHash: null,
            appliedConfigHash: "r1",
          })
        : asked.request(method, params);
    await applyGuidesChange(askedRequest, null, { action: "add", bots: ["pip"] });
    expect(asked.sets).toHaveLength(1);
  });

  it("by itself, takes a folder's limit only when the config names no bot this connection isn't shown", async () => {
    // Otto shares Pip's folder, with a lower limit, and the gateway doesn't list him here.
    const file = `# Pip\n${"x".repeat(9_500)}\n`;
    const hidden = {
      agents: { list: [{ id: "pip" }, { id: "otto", bootstrapMaxChars: 10_000 }] },
    };
    for (const change of [{ action: "auto" }, { action: "switch", on: true }] as GuidesChange[]) {
      const files = fakeFiles({ pip: file }, {}, {}, hidden);
      await applyGuidesChange(files.request, null, change);
      expect(files.sets, change.action).toEqual([]);
    }
    // Every bot the config names is listed: the folder's limit is theirs, and it fits.
    const all = fakeFiles({ pip: file }, {}, {}, { agents: { list: [{ id: "Pip" }] } });
    await applyGuidesChange(all.request, null, { action: "auto" });
    expect(all.sets).toHaveLength(1);
    // The person's Add doesn't depend on it.
    const asked = fakeFiles({ pip: file }, {}, {}, hidden);
    await applyGuidesChange(asked.request, null, { action: "add", bots: ["pip"] });
    expect(asked.sets).toHaveLength(1);
  });

  it("a section removed on another device isn't added again by a device that never saw the gateway", async () => {
    const files = fakeFiles({ pip: BOT_FILE });
    // Device A adds it, and the gateway's history says Pip had it.
    const a = await applyGuidesChange(files.request, null, { action: "auto" });
    expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
    expect(files.prefs.entries.get(GUIDES_HISTORY_KEY)).toEqual({
      v: 1,
      bots: ["pip"],
      folders: at(["pip"]),
    });
    // Device A turns it off: the section comes out, and the history still has Pip.
    await applyGuidesChange(files.request, a.record, { action: "switch", on: false });
    expect(files.store.get("pip")).toBe(BOT_FILE);
    expect(files.prefs.entries.get(GUIDES_HISTORY_KEY)).toEqual({
      v: 1,
      bots: ["pip"],
      folders: at(["pip"]),
    });
    // Device B has no record of this gateway: it writes nothing, and shows Pip's as removed.
    const b = await applyGuidesChange(files.request, null, { action: "auto" });
    expect(files.sets).toHaveLength(2);
    expect(b.record).toEqual({ on: true, bots: ["pip"], folders: at(["pip"]) });
    const [folder] = await readGuideFolders(files.request, null);
    expect(folder?.state).toBe("removed");
    // A section this device knew from before the gateway kept a history: Off records it there.
    const before = fakeFiles({ otto: withSection(BOT_FILE) });
    await applyGuidesChange(
      before.request,
      { on: true, bots: ["otto"] },
      { action: "switch", on: false },
    );
    expect(before.prefs.entries.get(GUIDES_HISTORY_KEY)).toEqual({
      v: 1,
      bots: ["otto"],
      folders: at(["otto"]),
    });
    // Turning the switch on there asks for it on every bot, and starts the history again.
    await applyGuidesChange(files.request, null, { action: "switch", on: true });
    expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
    expect(files.prefs.entries.get(GUIDES_HISTORY_KEY)).toEqual({
      v: 1,
      bots: ["pip"],
      folders: at(["pip"]),
    });
  });

  it("turning it on keeps a bot another device recorded meanwhile, when its save tries again", async () => {
    const files = fakeFiles({ pip: BOT_FILE });
    // Another device records Otto (not on this change's list) just before this change saves.
    const request = files.request;
    let once = true;
    const racing: (method: string, params: unknown) => Promise<unknown> = (method, params) => {
      if (method === "users.prefs.set" && once) {
        once = false;
        files.prefs.entries.set(GUIDES_HISTORY_KEY, { v: 1, bots: ["otto"] });
      }
      return request(method, params);
    };
    await applyGuidesChange(racing, offRecord(), { action: "switch", on: true });
    expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
    expect(files.prefs.entries.get(GUIDES_HISTORY_KEY)).toEqual({
      v: 1,
      bots: ["pip", "otto"],
      folders: at(["pip"]),
    });
  });

  it("a removal is recorded on the gateway first: when that fails, nothing is taken out, and it says so", async () => {
    for (const change of [
      { action: "switch", on: false },
      { action: "remove", bots: ["pip"] },
    ] as GuidesChange[]) {
      const files = fakeFiles({ pip: withSection(BOT_FILE) });
      files.prefs.failSets = true;
      const record = change.action === "remove" ? offRecord() : { on: true, bots: ["pip"] };
      const result = await applyGuidesChange(files.request, record, change);
      expect(files.sets, change.action).toEqual([]);
      expect(files.store.get("pip"), change.action).toBe(withSection(BOT_FILE));
      expect(result.errors, change.action).toEqual([GUIDES_HISTORY_NOT_SAVED]);
      // While off, its row still has the section, with Remove, to try again.
      const [folder] = await readGuideFolders(files.request, offRecord());
      expect(folder?.state, change.action).toBe("current");
      // A second device, whose history read succeeds, finds the section still there.
      files.prefs.failSets = false;
      await applyGuidesChange(files.request, null, { action: "auto" });
      expect(files.store.get("pip"), change.action).toBe(withSection(BOT_FILE));
    }
    // A gateway that keeps no preferences for this connection has no history to record into.
    const none = fakeFiles({ pip: withSection(BOT_FILE) });
    none.prefs.answer = "no_durable_identity";
    await applyGuidesChange(
      none.request,
      { on: true, bots: ["pip"] },
      { action: "switch", on: false },
    );
    expect(none.store.get("pip")).toBe(BOT_FILE);
  });

  it("a removal recorded on the gateway whose write then fails leaves nothing that puts it back by itself", async () => {
    const files = fakeFiles({ pip: withSection(BOT_FILE) });
    files.faults.refuse.add("pip");
    const off = await applyGuidesChange(
      files.request,
      { on: true, bots: ["pip"] },
      {
        action: "switch",
        on: false,
      },
    );
    // The history says Pip had it; the section is still there, and the change says why.
    expect(files.prefs.entries.get(GUIDES_HISTORY_KEY)).toEqual({
      v: 1,
      bots: ["pip"],
      folders: at(["pip"]),
    });
    expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
    expect(off.errors).toEqual(["pip: Workspace document exceeds its write bound"]);
    // This device is off, so nothing is added; its row says the section is still there.
    const [folder] = await readGuideFolders(files.request, off.record);
    expect(folder?.state).toBe("current");
    // The person's Remove takes it out once the gateway lets it; then a device that never saw the
    // gateway doesn't add it again by itself.
    files.faults.refuse.clear();
    await applyGuidesChange(files.request, off.record, { action: "remove", bots: ["pip"] });
    expect(files.store.get("pip")).toBe(BOT_FILE);
    await applyGuidesChange(files.request, null, { action: "auto" });
    expect(files.store.get("pip")).toBe(BOT_FILE);
  });

  it("a bot moved to a new, empty folder never had the section there: it isn't removed, and is added by itself", async () => {
    const workspaces: Record<string, string> = {};
    const files = fakeFiles({ pip: BOT_FILE }, workspaces);
    const a = await applyGuidesChange(files.request, null, { action: "auto" });
    expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
    workspaces.pip = "fresh";
    files.store.set("fresh", BOT_FILE);
    // Neither this device's record nor the gateway's history knew it in this folder.
    expect((await readGuideFolders(files.request, a.record))[0]?.state).toBe("none");
    expect((await readGuideFolders(files.request, null))[0]?.state).toBe("none");
    const moved = await applyGuidesChange(files.request, a.record, { action: "auto" });
    expect(files.store.get("fresh")).toBe(withSection(BOT_FILE));
    expect(moved.record).toEqual({ on: true, bots: ["pip"], folders: at(["pip"], workspaces) });
  });

  it("a record from before folders were kept reads a bot without its section as removed, in any folder", async () => {
    const files = fakeFiles({ pip: BOT_FILE }, { pip: "fresh" });
    files.store.set("fresh", BOT_FILE);
    expect((await readGuideFolders(files.request, { on: true, bots: ["pip"] }))[0]?.state).toBe(
      "removed",
    );
    files.prefs.entries.set(GUIDES_HISTORY_KEY, { v: 1, bots: ["pip"] });
    expect((await readGuideFolders(files.request, null))[0]?.state).toBe("removed");
    await applyGuidesChange(files.request, null, { action: "auto" });
    expect(files.sets).toEqual([]);
  });

  it("a bot whose id is a name every object has reads its own folder entry only, and none means any folder", async () => {
    const files = fakeFiles({ constructor: BOT_FILE, pip: BOT_FILE });
    // The record kept a folder for Pip, and none for `constructor`, recorded before folders were.
    const record = { on: true, bots: ["constructor", "pip"], folders: at(["pip"]) };
    expect((await readGuideFolders(files.request, record)).map((folder) => folder.state)).toEqual([
      "removed",
      "removed",
    ]);
  });

  it("with a full history, a bot recorded in another folder doesn't make its new folder known", async () => {
    // Moved and Other share a folder; the history, full, has Moved only, recorded in the old one.
    const files = fakeFiles(
      { moved: BOT_FILE, other: BOT_FILE },
      { moved: "shared", other: "shared" },
    );
    files.store.set("shared", BOT_FILE);
    files.prefs.entries.set(GUIDES_HISTORY_KEY, {
      v: 1,
      bots: ["moved"],
      full: true,
      folders: at(["moved"], { moved: "old" }),
    });
    await applyGuidesChange(files.request, null, { action: "auto" });
    expect(files.sets).toEqual([]);
  });

  it("a removal records nothing for a file it can't read, so another device doesn't read it as removed", async () => {
    // Pip never had the section; the read the removal makes first fails once.
    const files = fakeFiles({ pip: BOT_FILE });
    let failRead = true;
    const flaky = async (method: string, params: unknown) => {
      if (method === "agents.files.get" && failRead) {
        failRead = false;
        throw new Error("connection reset");
      }
      return files.request(method, params);
    };
    const off = await applyGuidesChange(
      flaky,
      { on: true, bots: [] },
      { action: "switch", on: false },
    );
    expect(off.errors).toEqual(["pip: connection reset"]);
    expect(files.prefs.entries.get(GUIDES_HISTORY_KEY)).toBeUndefined();
    expect((await readGuideFolders(files.request, null))[0]?.state).toBe("none");
  });

  it("by itself, adds nothing to a folder whose history the gateway can't say; turning it on, or Add, still does", async () => {
    for (const answer of ["no_durable_identity", "full"]) {
      const files = fakeFiles({ pip: BOT_FILE, otto: withSection(BOT_FILE) });
      if (answer === "full")
        files.prefs.entries.set(GUIDES_HISTORY_KEY, { v: 1, bots: ["otto"], full: true });
      else files.prefs.answer = answer;
      const result = await applyGuidesChange(files.request, null, { action: "auto" });
      expect(files.sets, answer).toEqual([]);
      expect(result.record?.bots, answer).toEqual(["otto"]);
      await applyGuidesChange(files.request, null, { action: "switch", on: true });
      expect(files.store.get("pip"), answer).toBe(withSection(BOT_FILE));
    }
    const asked = fakeFiles({ pip: BOT_FILE });
    asked.prefs.answer = "no_durable_identity";
    await applyGuidesChange(asked.request, null, { action: "add", bots: ["pip"] });
    expect(asked.store.get("pip")).toBe(withSection(BOT_FILE));
  });

  it("the gateway's history fits one preference: past it, it says it is full", () => {
    // 300 bots, under the count kept, but past the bytes the gateway keeps in one preference.
    const bots = Array.from({ length: 300 }, (_, i) => `bot-with-a-long-name-${i}`);
    const fitted = fitGuidesHistory({ bots, full: false });
    expect(utf8Bytes(JSON.stringify(fitted)).length).toBeLessThanOrEqual(MAX_GUIDES_HISTORY_BYTES);
    expect(fitted.full).toBe(true);
    expect(fitted.bots).toEqual(bots.slice(0, fitted.bots.length));
    expect(fitGuidesHistory({ bots: ["pip", "pip"], full: false })).toEqual({
      v: 1,
      bots: ["pip"],
    });
  });

  it("a row's Remove of a section that changed since Settings read it says so, and leaves it", async () => {
    const changed = withSection(BOT_FILE).replace("Be warm", "Be cold");
    const files = fakeFiles({ pip: changed });
    const result = await applyGuidesChange(
      files.request,
      { on: false, bots: [] },
      { action: "remove", bots: ["pip"] },
    );
    expect(files.sets).toEqual([]);
    expect(files.store.get("pip")).toBe(changed);
    expect(result.errors).toEqual([
      "pip: AGENTS.md's section changed after Settings read it, so Clawtrate left it as it is.",
    ]);
  });

  it("a row's Add for a refused shared folder clears the refusal for every bot that shares it", async () => {
    const files = fakeFiles({ pip: BOT_FILE, shared: BOT_FILE, otto: BOT_FILE }, { shared: "pip" });
    const record = {
      on: true,
      bots: [],
      refused: { pip: "refused", shared: "refused", otto: "refused" },
    };
    const added = await applyGuidesChange(files.request, record, { action: "add", bots: ["pip"] });
    // Otto's folder is another: its refusal stays.
    expect(added.record).toEqual({
      on: true,
      bots: ["pip", "shared"],
      refused: { otto: "refused" },
      folders: at(["pip", "shared"], { shared: "pip" }),
    });
  });

  it("by itself, never makes a file that doesn't exist yet, and doesn't record the bot; the person's Add does", async () => {
    for (const change of [
      { action: "auto" },
      { action: "auto", bot: "pip" },
      { action: "switch", on: true },
    ] as GuidesChange[]) {
      const files = fakeFiles({ pip: null, otto: BOT_FILE });
      const result = await applyGuidesChange(files.request, null, change);
      expect(files.store.get("pip"), change.action).toBeNull();
      expect(result.missing, change.action).toEqual([["pip"]]);
      expect(result.record?.bots).not.toContain("pip");
    }
    const [folder] = await readGuideFolders(fakeFiles({ pip: null }).request, null);
    expect(folder).toMatchObject({ state: "none", missing: true });
    const asked = fakeFiles({ pip: null });
    await applyGuidesChange(asked.request, null, { action: "add", bots: ["pip"] });
    expect(asked.store.get("pip")).toBe(withSection(""));
  });

  it("by itself, doesn't try again a file whose write the gateway refused, and says why; Add and the switch try again", async () => {
    const files = fakeFiles({ pip: BOT_FILE, otto: BOT_FILE });
    files.faults.refuse.add("pip");
    const first = await applyGuidesChange(files.request, null, { action: "auto" });
    expect(first.record).toEqual({
      on: true,
      bots: ["otto"],
      refused: { pip: "Workspace document exceeds its write bound" },
      folders: at(["otto"]),
    });
    const [folder] = await readGuideFolders(files.request, first.record);
    expect(folder).toMatchObject({
      state: "none",
      refused: "Workspace document exceeds its write bound",
    });
    // Not tried again by itself: no write is even asked.
    let asked = 0;
    const counting = (method: string, params: unknown) => {
      if (method === "agents.files.set") asked += 1;
      return files.request(method, params);
    };
    const again = await applyGuidesChange(counting, first.record, { action: "auto" });
    expect(asked).toBe(0);
    expect(again.record).toEqual(first.record);
    // A conflict, or a lost connection, isn't a refusal.
    const lost = fakeFiles({ pip: BOT_FILE });
    lost.faults.conflicts = 2;
    expect((await applyGuidesChange(lost.request, null, { action: "auto" })).record).toEqual({
      on: true,
      bots: [],
    });
    // The person's Add, and the switch turned on, try again, and forget it once written.
    files.faults.refuse.delete("pip");
    const added = await applyGuidesChange(files.request, first.record, {
      action: "add",
      bots: ["pip"],
    });
    expect(added.record).toEqual({ on: true, bots: ["otto", "pip"], folders: at(["otto", "pip"]) });
    const switched = fakeFiles({ pip: BOT_FILE });
    await applyGuidesChange(switched.request, first.record, { action: "switch", on: true });
    expect(switched.sets.map((set) => set.agentId)).toEqual(["pip"]);
  });

  it("by itself, remembers no refusal for a write the gateway answers UNAVAILABLE, and tries again next time", async () => {
    const files = fakeFiles({ pip: BOT_FILE });
    files.faults.unavailable = 1;
    const first = await applyGuidesChange(files.request, null, { action: "auto" });
    expect(files.sets).toEqual([]);
    expect(first.record).toEqual({ on: true, bots: [] });
    const again = await applyGuidesChange(files.request, first.record, { action: "auto" });
    expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
    expect(again.record).toEqual({ on: true, bots: ["pip"], folders: at(["pip"]) });
  });

  it("remembers as a refusal only a lasting answer that isn't UNAVAILABLE", () => {
    const answer = (code: string, details?: unknown, retryable = false) =>
      new GatewayProtocolRequestError({ code, message: "m", details, retryable });
    expect(refusedForGood(answer("INVALID_REQUEST"))).toBe(true);
    expect(refusedForGood(answer("FORBIDDEN"))).toBe(true);
    // Any error a handler throws, and a full disk (lasting until someone frees space): tried again.
    expect(refusedForGood(answer("UNAVAILABLE"))).toBe(false);
    expect(refusedForGood(answer("UNAVAILABLE", { code: "SQLITE_FULL" }, true))).toBe(false);
    expect(refusedForGood(answer("INVALID_REQUEST", undefined, true))).toBe(false);
    // Not the gateway's answer at all.
    expect(refusedForGood(new Error("connection changed"))).toBe(false);
  });

  it("a row's Remove takes the section out of that row's bot only, and only while the switch is off", async () => {
    const files = fakeFiles({ pip: withSection(BOT_FILE), otto: withSection(BOT_FILE) });
    const on = await applyGuidesChange(files.request, null, { action: "remove", bots: ["pip"] });
    expect(on.errors).toEqual([GUIDES_ON]);
    expect(files.sets).toEqual([]);
    const off = await applyGuidesChange(
      files.request,
      { on: false, bots: [] },
      { action: "remove", bots: ["pip"] },
    );
    expect(off.errors).toEqual([]);
    expect(off.record).toEqual({ on: false, bots: [] });
    expect(files.store.get("pip")).toBe(BOT_FILE);
    expect(files.store.get("otto")).toBe(withSection(BOT_FILE));
  });
});

describe("the guides in the client", () => {
  /** Admin storage that counts the reads of this gateway's guides record (`guideReads`). */
  const adminStorage = () => {
    const storage = Object.assign(
      memoryStorage({
        connection: JSON.stringify({ url: URL_A, token: null }),
        [tokenKey(URL_A)]: JSON.stringify({
          token: "device-token",
          grantedScopes: ADMIN_SCOPES,
          heldScopes: INTERACTIVE_SCOPES,
          adminHeld: true,
        }),
      }),
      { guideReads: 0 },
    );
    const get = storage.get.bind(storage);
    storage.get = (key: string) => {
      if (key.startsWith("clawtrate.guides.") && key !== GUIDES_DEFAULT_KEY)
        storage.guideReads += 1;
      return get(key);
    };
    return storage;
  };
  const withFiles = <T extends { handlers: Record<string, (params: unknown) => unknown> }>(
    gateway: T,
    files: ReturnType<typeof fakeFiles>,
  ) => {
    // A gateway error the files give goes out as the gateway's own frame, with its code.
    for (const method of [
      "agents.list",
      "agents.files.get",
      "agents.files.set",
      "config.get",
      "users.prefs.get",
      "users.prefs.set",
    ])
      gateway.handlers[method] = (params) =>
        files.request(method, params).catch((error: unknown) => {
          if (error instanceof GatewayProtocolRequestError)
            throw new GatewayError({ code: error.gatewayCode, message: error.message });
          throw error;
        });
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gw-a" });
    return gateway;
  };
  const recordIn = (storage: { data: Map<string, string> }, gatewayId = "gw-a") =>
    parseGuidesRecord(storage.data.get(guidesKey(gatewayId)) ?? null);
  /** Connect again, and wait until Clawtrate's own change after it has had its turn. */
  /**
   * Connect again, and wait until Clawtrate's own change after it has had its turn: with admin
   * storage, until that change has read the record (a read of the guides then waits for it to
   * finish); without, where no change starts, a while.
   */
  const reconnect = async (
    client: Awaited<ReturnType<typeof openTask>>["client"],
    gateway: { dropAll(): void },
    storage?: { guideReads: number },
  ) => {
    // The client's own decision after a connect (`keepGuides`), watched where no record is read.
    const spy = vi.spyOn(client as unknown as { keepGuides: () => Promise<void> }, "keepGuides");
    const was = client.state.connection.connectedAt;
    const reads = storage?.guideReads ?? 0;
    const decided = spy.mock.results.length;
    gateway.dropAll();
    await until(
      () =>
        client.state.connection.status === "connected" &&
        client.state.connection.connectedAt !== was,
    );
    if (storage) await until(() => storage.guideReads > reads);
    else {
      // No change of Clawtrate's own starts: wait until the connect has decided so.
      await until(() => spy.mock.results.length > decided);
      await spy.mock.results.at(-1)?.value;
    }
    return client.readBotGuides();
  };

  /** Admin storage whose saves of this gateway's guides record fail ("disk full"). */
  const diskFull = (record: Record<string, unknown>) => {
    const storage = adminStorage();
    void storage.set(guidesKey("gw-a"), JSON.stringify(record));
    const set = storage.set.bind(storage);
    storage.set = (key: string, value: string) =>
      key === guidesKey("gw-a") ? Promise.reject(new Error("disk full")) : set(key, value);
    return storage;
  };

  it("on a connect with admin access, adds it to every bot without one, with no call from the screen, and records them", async () => {
    const files = fakeFiles({ pip: BOT_FILE, otto: null, shared: BOT_FILE }, { shared: "pip" });
    const storage = adminStorage();
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      const read = await reconnect(client, gateway, storage);
      expect(read.folders.map((f) => [f.bots.join("+"), f.state, f.missing])).toEqual([
        ["pip+shared", "current", false],
        // Otto's file doesn't exist yet: the gateway makes it on Otto's next run, so it's left.
        ["otto", "none", true],
      ]);
      expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
      expect(files.store.get("otto")).toBeNull();
      expect(files.sets).toHaveLength(1);
      expect(recordIn(storage)).toEqual({
        on: true,
        bots: ["pip", "shared"],
        folders: at(["pip", "shared"], { shared: "pip" }),
      });
      // Again on the next connect: nothing left to write.
      await reconnect(client, gateway, storage);
      expect(files.sets).toHaveLength(1);
    } finally {
      client.stop();
    }
  });

  it("never adds back a section this device added and that is gone: it reads removed, and Add puts it back", async () => {
    const files = fakeFiles({ pip: BOT_FILE, otto: BOT_FILE });
    const storage = adminStorage();
    await storage.set(guidesKey("gw-a"), JSON.stringify({ on: true, bots: ["pip"] }));
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      const read = await reconnect(client, gateway, storage);
      expect(read.folders.map((f) => [f.bots[0], f.state])).toEqual([
        ["pip", "removed"],
        ["otto", "current"],
      ]);
      expect(files.store.get("pip")).toBe(BOT_FILE);
      expect(files.sets.map((set) => set.agentId)).toEqual(["otto"]);
      // And on every connect after.
      await reconnect(client, gateway, storage);
      expect(files.store.get("pip")).toBe(BOT_FILE);
      const added = await client.changeBotGuides({ action: "add", bots: ["pip"] }, read.stamp);
      expect(added.folders[0]?.state).toBe("current");
      expect(added.errors).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("records a section it finds, another device's too, so one cleared later reads removed and is left", async () => {
    // A device with no record for this gateway: Pip's section came from elsewhere, and Marlow's
    // was changed since by the bot.
    const changed = withSection(BOT_FILE).replace("Be warm", "Be cold");
    const files = fakeFiles({ pip: withSection(BOT_FILE), otto: BOT_FILE, marlow: changed });
    const storage = adminStorage();
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      await reconnect(client, gateway, storage);
      // It can't tell a bot never given the section from one cleared elsewhere: Otto gets it.
      expect(files.store.get("otto")).toBe(withSection(BOT_FILE));
      expect(files.store.get("marlow")).toBe(changed);
      expect(recordIn(storage)).toEqual({
        on: true,
        bots: ["pip", "otto", "marlow"],
        folders: at(["pip", "otto", "marlow"]),
      });
      // Someone takes Pip's and Marlow's out outside Clawtrate: from now on this device's record
      // applies to both.
      files.store.set("pip", BOT_FILE);
      files.store.set("marlow", BOT_FILE);
      const read = await reconnect(client, gateway, storage);
      for (const bot of ["pip", "marlow"]) {
        expect(read.folders.find((f) => f.bots[0] === bot)?.state, bot).toBe("removed");
        expect(files.store.get(bot), bot).toBe(BOT_FILE);
      }
    } finally {
      client.stop();
    }
  });

  it("with the switch off writes nothing, across a reconnect and a reopen of the app", async () => {
    const files = fakeFiles({ pip: BOT_FILE, otto: olderSection() + BOT_FILE });
    const storage = adminStorage();
    await storage.set(guidesKey("gw-a"), JSON.stringify({ on: false, bots: [] }));
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      const read = await reconnect(client, gateway, storage);
      expect(read.record).toEqual({ on: false, bots: [] });
      expect(read.folders.map((f) => f.state)).toEqual(["none", "older"]);
    } finally {
      client.stop();
    }
    // The app opened again on this device, the same gateway.
    const reopened = new ClawtrateClient(testHost(gateway, storage), FAST);
    await reopened.start();
    try {
      await until(() => reopened.state.connection.status === "connected");
      await reconnect(reopened, gateway, storage);
      expect(files.sets).toEqual([]);
      expect(recordIn(storage)).toEqual({ on: false, bots: [] });
    } finally {
      reopened.stop();
    }
  });

  it("turning it off saves off first and takes the section out of every bot; on adds it again; neither asks", async () => {
    const files = fakeFiles({ pip: BOT_FILE, otto: BOT_FILE });
    const storage = adminStorage();
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      const on = await reconnect(client, gateway, storage);
      expect(on.folders.map((f) => f.state)).toEqual(["current", "current"]);
      const off = await client.changeBotGuides({ action: "switch", on: false }, on.stamp);
      expect(off.errors).toEqual([]);
      expect(off.record).toEqual({ on: false, bots: [] });
      expect([files.store.get("pip"), files.store.get("otto")]).toEqual([BOT_FILE, BOT_FILE]);
      // Off: nothing reads removed, and nothing comes back by itself.
      expect(off.folders.map((f) => f.state)).toEqual(["none", "none"]);
      await reconnect(client, gateway, storage);
      expect(files.store.get("pip")).toBe(BOT_FILE);
      const again = await client.changeBotGuides({ action: "switch", on: true }, off.stamp);
      expect(again.record).toEqual({
        on: true,
        bots: ["pip", "otto"],
        folders: at(["pip", "otto"]),
      });
      expect(again.folders.map((f) => f.state)).toEqual(["current", "current"]);
    } finally {
      client.stop();
    }
  });

  it("turns the switch only once it is saved: when it can't be, nothing is written and it says so", async () => {
    for (const [saved, on] of [
      [{ on: true, bots: ["pip"] }, false],
      [{ on: false, bots: [] }, true],
    ] as const) {
      const files = fakeFiles({ pip: on ? BOT_FILE : withSection(BOT_FILE) });
      const storage = diskFull(saved);
      const { client, gateway } = await openTask({ storage });
      withFiles(gateway, files);
      try {
        const shown = await client.readBotGuides();
        const writes = files.sets.length;
        const after = await client.changeBotGuides({ action: "switch", on }, shown.stamp);
        expect(after.errors, `on: ${on}`).toEqual([GUIDES_NOT_SAVED]);
        expect(files.sets).toHaveLength(writes);
        // The rows say what the files and this device hold.
        expect(after.folders[0]?.state).toBe(on ? "none" : "current");
        expect(after.record).toEqual(saved);
        expect(recordIn(storage)).toEqual(saved);
      } finally {
        client.stop();
      }
    }
  });

  it("after an Off that was saved, a file that refused keeps its section, and nothing is added after", async () => {
    const files = fakeFiles({ pip: withSection(BOT_FILE), otto: withSection(BOT_FILE) });
    files.faults.refuse.add("otto");
    const storage = adminStorage();
    await storage.set(guidesKey("gw-a"), JSON.stringify({ on: true, bots: ["pip", "otto"] }));
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      const shown = await client.readBotGuides();
      const after = await client.changeBotGuides({ action: "switch", on: false }, shown.stamp);
      expect(after.errors).toEqual([expect.stringMatching(/^otto: .*exceeds its write bound$/)]);
      expect(files.store.get("pip")).toBe(BOT_FILE);
      expect(after.folders.map((f) => [f.bots[0], f.state])).toEqual([
        ["pip", "none"],
        ["otto", "current"],
      ]);
      expect(recordIn(storage)).toEqual({ on: false, bots: [] });
      await reconnect(client, gateway, storage);
      expect(files.store.get("pip")).toBe(BOT_FILE);
    } finally {
      client.stop();
    }
  });

  it("a row's Add changes the files first and records them last, and says so truly when it can't record it", async () => {
    // Pip's section was removed outside Clawtrate; Otto's file doesn't exist yet, so Clawtrate's
    // own change leaves it, and only the person's Add makes it.
    const files = fakeFiles({ pip: BOT_FILE, otto: null });
    const storage = diskFull({ on: true, bots: ["pip"], folders: at(["pip"]) });
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      const shown = await client.readBotGuides();
      expect(shown.folders.map((f) => f.state)).toEqual(["removed", "none"]);
      // Pip was recorded already: nothing new to record, so nothing to say.
      const pip = await client.changeBotGuides({ action: "add", bots: ["pip"] }, shown.stamp);
      expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
      expect(pip.errors).toEqual([]);
      const otto = await client.changeBotGuides({ action: "add", bots: ["otto"] }, pip.stamp);
      expect(files.store.get("otto")).toBe(withSection(""));
      expect(otto.errors).toEqual([GUIDES_NOT_RECORDED]);
      expect(otto.folders.map((f) => f.state)).toEqual(["current", "current"]);
    } finally {
      client.stop();
    }
  });

  it("adds, reads back and records, on the gateway the screen was read from", async () => {
    const files = fakeFiles({ pip: BOT_FILE, otto: BOT_FILE });
    const storage = adminStorage();
    await storage.set(guidesKey("gw-a"), JSON.stringify({ on: true, bots: ["pip", "otto"] }));
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      const shown = await client.readBotGuides();
      expect(shown.folders.map((f) => f.state)).toEqual(["removed", "removed"]);
      expect(shown.stamp.gatewayId).toBe("gw-a");
      const after = await client.changeBotGuides({ action: "add", bots: ["pip"] }, shown.stamp);
      expect(after.folders.map((f) => [f.bots[0], f.state])).toEqual([
        ["pip", "current"],
        ["otto", "removed"],
      ]);
      expect(after.errors).toEqual([]);
      expect(recordIn(storage)).toEqual({
        on: true,
        bots: ["pip", "otto"],
        folders: at(["pip", "otto"]),
      });
      // A stale screen's stamp sends nothing.
      await expect(
        client.changeBotGuides(
          { action: "switch", on: false },
          { ...shown.stamp, gatewayId: "gw-b" },
        ),
      ).rejects.toThrow(/another gateway/);
      expect(files.sets).toHaveLength(1);
    } finally {
      client.stop();
    }
  });

  it("writes nothing below admin, or from a read-only viewer, by itself or when asked", async () => {
    for (const options of [
      { held: INTERACTIVE_SCOPES },
      { storage: adminStorage(), client: { readOnly: true } },
    ]) {
      const files = fakeFiles({ pip: BOT_FILE, otto: olderSection() + BOT_FILE });
      const { client, gateway } = await openTask(options);
      withFiles(gateway, files);
      try {
        // No change of Clawtrate's own starts here: wait for the connect to decide so.
        const shown = await reconnect(client, gateway);
        for (const change of [
          { action: "add", bots: ["pip"] },
          { action: "switch", on: true },
          { action: "switch", on: false },
          { action: "replace", bot: "pip", shown: "" },
        ] as GuidesChange[])
          await expect(client.changeBotGuides(change, shown.stamp)).rejects.toThrow(/admin/i);
        expect(files.sets).toEqual([]);
      } finally {
        client.stop();
      }
    }
  });

  it("refuses a change from a viewer that went away before it was sent", async () => {
    const files = fakeFiles({ pip: BOT_FILE });
    const storage = adminStorage();
    await storage.set(guidesKey("gw-a"), JSON.stringify({ on: true, bots: ["pip"] }));
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      const viewer = createBridgeSession(client);
      const shown = (await viewer.apply({ type: "readBotGuides" })) as BotGuidesAnswer;
      const change = viewer.apply({
        type: "changeBotGuides",
        change: { action: "add", bots: ["pip"] },
        stamp: shown.stamp,
      });
      viewer.dispose();
      await expect(change).rejects.toThrow(/withdrawn/);
      expect(files.sets).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("adds the section to a file the gateway made after a run ended, once per bot per connection", async () => {
    const files = fakeFiles({ pip: BOT_FILE, otto: null });
    const storage = adminStorage();
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    const endRun = (run: string) =>
      gateway.emit("agent", agentEvent(run, 1, "lifecycle", { phase: "end" }, "agent:otto:main"));
    try {
      await reconnect(client, gateway, storage);
      expect(files.store.get("otto")).toBeNull();
      // Otto's run ends before the gateway made the file: read once, still missing, left.
      const reads = storage.guideReads;
      endRun("run-1");
      await until(() => storage.guideReads > reads);
      await client.readBotGuides();
      expect(files.store.get("otto")).toBeNull();
      // The gateway made it on that run; another run's end doesn't read it again here.
      files.store.set("otto", "# Otto's template\n");
      const after = storage.guideReads;
      endRun("run-2");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(storage.guideReads).toBe(after);
      expect(files.store.get("otto")).toBe("# Otto's template\n");
      // The next connect reads it again, and adds the section to the gateway's own file.
      await reconnect(client, gateway, storage);
      expect(files.store.get("otto")).toBe(withSection("# Otto's template\n"));
    } finally {
      client.stop();
    }
  });

  it("adds the section to a file the gateway made once a run of the bot ends, with no reconnect", async () => {
    const files = fakeFiles({ otto: null });
    const storage = adminStorage();
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      await reconnect(client, gateway, storage);
      files.store.set("otto", "# Otto's template\n");
      gateway.emit(
        "agent",
        agentEvent("run-1", 1, "lifecycle", { phase: "end" }, "agent:otto:main"),
      );
      await until(() => files.store.get("otto") === withSection("# Otto's template\n"));
      expect(recordIn(storage)).toEqual({ on: true, bots: ["otto"], folders: at(["otto"]) });
    } finally {
      client.stop();
    }
  });

  it("when the gateway names itself late on the connection, adds the section then, with no reconnect", async () => {
    const files = fakeFiles({ pip: BOT_FILE, otto: BOT_FILE });
    const storage = adminStorage();
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    // The connect's read and the change's own read are refused; the client's next ask answers.
    let refusals = 0;
    gateway.handlers["gateway.identity.get"] = () => {
      if (refusals < 2) {
        refusals += 1;
        throw new Error("not ready");
      }
      return { deviceId: "gw-a" };
    };
    try {
      gateway.dropAll();
      await until(() => refusals === 2);
      await until(() => files.sets.length === 2, 8_000);
      expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
      expect(recordIn(storage)).toEqual({
        on: true,
        bots: ["pip", "otto"],
        folders: at(["pip", "otto"]),
      });
    } finally {
      client.stop();
    }
  });

  it("when Settings is what learns the gateway's late name, it shows what the change that follows leaves", async () => {
    const files = fakeFiles({ pip: BOT_FILE });
    const storage = adminStorage();
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    let refusals = 0;
    gateway.handlers["gateway.identity.get"] = () => {
      if (refusals < 2) {
        refusals += 1;
        throw new Error("not ready");
      }
      return { deviceId: "gw-a" };
    };
    try {
      gateway.dropAll();
      await until(() => refusals === 2);
      // Settings reads now: its own read learns the name, which queues the change.
      const read = await client.readBotGuides();
      expect(read.folders[0]?.state).toBe("current");
    } finally {
      client.stop();
    }
  });

  it("a Settings read whose connection changes on the way reads nothing more on the new one", async () => {
    const files = fakeFiles({ pip: BOT_FILE });
    const storage = adminStorage();
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      await reconnect(client, gateway, storage);
      // The connection changes while this device's record is read.
      const get = storage.get.bind(storage);
      let once = true;
      storage.get = async (key: string) => {
        if (key === guidesKey("gw-a") && once) {
          once = false;
          const was = client.state.connection.connectedAt;
          gateway.dropAll();
          await until(
            () =>
              client.state.connection.status === "connected" &&
              client.state.connection.connectedAt !== was,
          );
        }
        return get(key);
      };
      // Without the binding, it would read the files on the new connection and show them.
      await expect(client.readBotGuides()).rejects.toThrow(CONNECTION_CHANGED);
    } finally {
      client.stop();
    }
  });

  it("an Off whose default and bot list both fail keeps the gateway's Off, and says both", async () => {
    const files = fakeFiles({ pip: withSection(BOT_FILE) });
    const storage = adminStorage();
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      const shown = await reconnect(client, gateway, storage);
      const set = storage.set.bind(storage);
      storage.set = (key: string, value: string) =>
        key === GUIDES_DEFAULT_KEY ? Promise.reject(new Error("disk full")) : set(key, value);
      // The change's own list and the read-back's fail with different words, so neither stands
      // in for the other.
      let lists = 0;
      gateway.handlers["agents.list"] = () => {
        lists += 1;
        throw new Error(lists === 1 ? "the change's list failed" : "the read-back's list failed");
      };
      const failed = await client
        .changeBotGuides({ action: "switch", on: false }, shown.stamp)
        .then(
          () => null,
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
      expect(failed).toContain(GUIDES_DEFAULT_NOT_SAVED);
      expect(failed).toContain("the change's list failed");
      expect(recordIn(storage)).toEqual({ on: false, bots: [] });
    } finally {
      client.stop();
    }
  });

  it("adds the section to a bot made outside Clawtrate while the app is open, with no reconnect", async () => {
    const listed: Record<string, string | null> = { pip: withSection(BOT_FILE) };
    const files = fakeFiles(listed);
    const storage = adminStorage();
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      await reconnect(client, gateway, storage);
      expect(files.sets).toEqual([]);
      // The gateway's CLI makes Juniper; the gateway says its config changed.
      listed.juniper = BOT_FILE;
      files.store.set("juniper", BOT_FILE);
      gateway.emit("config.changed", {});
      await until(() => files.store.get("juniper") === withSection(BOT_FILE));
      expect(files.sets.map((set) => set.agentId)).toEqual(["juniper"]);
    } finally {
      client.stop();
    }
  });

  it("takes a stored value that isn't a record as unreadable: nothing is written, it is left, and Settings doesn't guess", async () => {
    for (const stored of [
      "{not json",
      JSON.stringify({ on: "no", bots: [] }),
      JSON.stringify({ on: false }),
    ]) {
      const files = fakeFiles({ pip: BOT_FILE });
      const storage = adminStorage();
      await storage.set(guidesKey("gw-a"), stored);
      const { client, gateway } = await openTask({ storage });
      withFiles(gateway, files);
      try {
        const read = await reconnect(client, gateway, storage);
        expect(files.sets, stored).toEqual([]);
        expect(storage.data.get(guidesKey("gw-a")), stored).toBe(stored);
        // `{"on":false}` is read as the off it says; the others can't be read at all.
        const off = stored === JSON.stringify({ on: false });
        expect(read.unreadable, stored).toBe(!off);
        if (!off) {
          const after = await client.changeBotGuides({ action: "switch", on: true }, read.stamp);
          expect(after.errors).toEqual([GUIDES_NOT_READ]);
          expect(files.sets).toEqual([]);
        }
      } finally {
        client.stop();
      }
    }
  });

  it("off on one gateway is off on a gateway this device hasn't seen; on changes that gateway only; a gateway's own record wins", async () => {
    const storage = adminStorage();
    const files = fakeFiles({ pip: withSection(BOT_FILE) });
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      const shown = await reconnect(client, gateway, storage);
      await client.changeBotGuides({ action: "switch", on: false }, shown.stamp);
      expect(JSON.parse(storage.data.get(GUIDES_DEFAULT_KEY)!)).toEqual({ on: false, bots: [] });
      // Another gateway, never seen: its bots are left, and its switch reads off.
      const other = fakeFiles({ otto: BOT_FILE });
      withFiles(gateway, other);
      gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gw-b" });
      const there = await reconnect(client, gateway, storage);
      expect(other.sets).toEqual([]);
      expect(there.record).toEqual({ on: false, bots: [] });
      expect(there.inherited).toBe(true);
      expect(storage.data.has(guidesKey("gw-b"))).toBe(false);
      // Turned on there: that gateway's own record says on, and the default stays.
      const on = await client.changeBotGuides({ action: "switch", on: true }, there.stamp);
      expect(JSON.parse(storage.data.get(GUIDES_DEFAULT_KEY)!)).toEqual({ on: false, bots: [] });
      expect(recordIn(storage, "gw-b")).toEqual({
        on: true,
        bots: ["otto"],
        folders: at(["otto"]),
      });
      expect(on.inherited).toBe(false);
      expect(on.folders[0]?.state).toBe("current");
      // A gateway with a record of its own keeps it whatever the default says.
      await storage.set(GUIDES_DEFAULT_KEY, JSON.stringify({ on: false, bots: [] }));
      other.store.set("otto", BOT_FILE);
      // No device of this person's has recorded Otto there either, on the gateway.
      other.prefs.entries.clear();
      await storage.set(guidesKey("gw-b"), JSON.stringify({ on: true, bots: [] }));
      await reconnect(client, gateway, storage);
      expect(other.store.get("otto")).toBe(withSection(BOT_FILE));
    } finally {
      client.stop();
    }
  });

  it("On for one gateway writes nothing to another that shows Off only because of the device-wide default", async () => {
    const storage = adminStorage();
    const a = fakeFiles({ pip: withSection(BOT_FILE) });
    const b = fakeFiles({ otto: BOT_FILE });
    const { client, gateway } = await openTask({ storage });
    const to = (files: typeof a, id: string) => {
      withFiles(gateway, files);
      gateway.handlers["gateway.identity.get"] = () => ({ deviceId: id });
    };
    try {
      to(a, "gw-a");
      const onA = await reconnect(client, gateway, storage);
      const offA = await client.changeBotGuides({ action: "switch", on: false }, onA.stamp);
      // B, never seen: Off by the default, nothing written.
      to(b, "gw-b");
      expect((await reconnect(client, gateway, storage)).inherited).toBe(true);
      // Back to A, On: that changes A only.
      to(a, "gw-a");
      const backA = await reconnect(client, gateway, storage);
      await client.changeBotGuides({ action: "switch", on: true }, backA.stamp);
      expect(offA.record).toEqual({ on: false, bots: [] });
      // B's next connect still writes nothing, and B still says Off, as the default.
      to(b, "gw-b");
      const againB = await reconnect(client, gateway, storage);
      expect(b.sets).toEqual([]);
      expect(againB.record).toEqual({ on: false, bots: [] });
      expect(againB.inherited).toBe(true);
    } finally {
      client.stop();
    }
  });

  it("after the switch is turned on, a file that doesn't exist yet gets the section once a run of its bot ends", async () => {
    const files = fakeFiles({ otto: null });
    const storage = adminStorage();
    await storage.set(guidesKey("gw-a"), JSON.stringify({ on: false, bots: [] }));
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      // The connect while off arms nothing.
      const shown = await reconnect(client, gateway, storage);
      const on = await client.changeBotGuides({ action: "switch", on: true }, shown.stamp);
      expect(on.folders[0]).toMatchObject({ state: "none", missing: true });
      files.store.set("otto", "# Otto's template\n");
      gateway.emit(
        "agent",
        agentEvent("run-1", 1, "lifecycle", { phase: "end" }, "agent:otto:main"),
      );
      await until(() => files.store.get("otto") === withSection("# Otto's template\n"));
    } finally {
      client.stop();
    }
  });

  it("a switch turned on whose later save fails says it is on, not that nothing changed", async () => {
    const files = fakeFiles({ pip: withSection(BOT_FILE) });
    const storage = adminStorage();
    await storage.set(guidesKey("gw-a"), JSON.stringify({ on: false, bots: [] }));
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      const shown = await reconnect(client, gateway, storage);
      // The first save (on) goes through; the next (the bots found holding it) fails.
      let saves = 0;
      const set = storage.set.bind(storage);
      storage.set = (key: string, value: string) =>
        key === guidesKey("gw-a") && ++saves > 1
          ? Promise.reject(new Error("disk full"))
          : set(key, value);
      const after = await client.changeBotGuides({ action: "switch", on: true }, shown.stamp);
      expect(files.sets).toEqual([]);
      expect(after.record?.on).toBe(true);
      expect(after.errors).toEqual([GUIDES_ON_NOT_RECORDED]);
    } finally {
      client.stop();
    }
  });

  it("Off saved for the gateway but not as the device's default says so, and still takes the section out", async () => {
    const files = fakeFiles({ pip: withSection(BOT_FILE) });
    const storage = adminStorage();
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      const shown = await reconnect(client, gateway, storage);
      const set = storage.set.bind(storage);
      storage.set = (key: string, value: string) =>
        key === GUIDES_DEFAULT_KEY ? Promise.reject(new Error("disk full")) : set(key, value);
      const after = await client.changeBotGuides({ action: "switch", on: false }, shown.stamp);
      expect(after.errors).toEqual([GUIDES_DEFAULT_NOT_SAVED]);
      expect(recordIn(storage)).toEqual({ on: false, bots: [] });
      expect(files.store.get("pip")).toBe(BOT_FILE);
    } finally {
      client.stop();
    }
  });

  it("says files changed only when one was written: an Add that found it already there, unsaved, says nothing changed", async () => {
    const files = fakeFiles({ pip: withSection(BOT_FILE) });
    const storage = diskFull({ on: true, bots: [] });
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      const shown = await client.readBotGuides();
      const after = await client.changeBotGuides({ action: "add", bots: ["pip"] }, shown.stamp);
      expect(files.sets).toEqual([]);
      expect(after.errors).toEqual([GUIDES_NOT_SAVED]);
    } finally {
      client.stop();
    }
  });

  it("after a write the gateway answers as it does a thrown error, the next connect writes it", async () => {
    const files = fakeFiles({ pip: BOT_FILE });
    const storage = adminStorage();
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    // The frame the gateway sends for any error its handler throws: UNAVAILABLE, no flag, no reason.
    let thrown = false;
    const set = gateway.handlers["agents.files.set"]!;
    gateway.handlers["agents.files.set"] = (params) => {
      if (thrown) return set(params);
      thrown = true;
      throw new Error("Workspace access changed while saving an Agent document");
    };
    try {
      const after = await reconnect(client, gateway, storage);
      expect(thrown).toBe(true);
      expect(files.store.get("pip")).toBe(BOT_FILE);
      expect(after.folders[0]).toMatchObject({ state: "none", refused: null });
      expect(recordIn(storage)?.refused).toBeUndefined();
      await reconnect(client, gateway, storage);
      expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
    } finally {
      client.stop();
    }
  });

  it("writes nothing while this device's record can't be read: it may say off", async () => {
    const files = fakeFiles({ pip: BOT_FILE });
    const storage = adminStorage();
    await storage.set(guidesKey("gw-a"), JSON.stringify({ on: false, bots: [] }));
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    const get = storage.get;
    storage.get = (key: string) => {
      if (key !== guidesKey("gw-a")) return get(key);
      storage.guideReads += 1;
      return Promise.reject(new Error("locked"));
    };
    try {
      const shown = await reconnect(client, gateway, storage);
      expect(files.sets).toEqual([]);
      for (const change of [
        { action: "switch", on: true },
        { action: "add", bots: ["pip"] },
      ] as GuidesChange[]) {
        const after = await client.changeBotGuides(change, shown.stamp);
        expect(after.errors, change.action).toEqual([GUIDES_NOT_READ]);
      }
      expect(files.sets).toEqual([]);
      expect(recordIn(storage)).toEqual({ on: false, bots: [] });
    } finally {
      client.stop();
    }
  });

  it("says files changed only when they did: a Replace that wrote nothing saves nothing", async () => {
    const changed = withSection(BOT_FILE).replace("Be warm", "Be cold");
    const files = fakeFiles({ pip: changed });
    const storage = diskFull({ on: true, bots: ["pip"] });
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      const shown = await client.readBotGuides();
      const after = await client.changeBotGuides(
        { action: "replace", bot: "pip", shown: "not what is there" },
        shown.stamp,
      );
      expect(after.errors).toEqual([
        "pip: AGENTS.md changed again after Settings read it, so nothing was replaced. Look at its section again before you replace it.",
      ]);
      expect(files.store.get("pip")).toBe(changed);
    } finally {
      client.stop();
    }
  });

  it("sends nothing for a change whose viewer went away while it waited its turn", async () => {
    const files = fakeFiles({ pip: BOT_FILE, otto: BOT_FILE });
    const storage = adminStorage();
    await storage.set(guidesKey("gw-a"), JSON.stringify({ on: true, bots: ["pip", "otto"] }));
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      const shown = await client.readBotGuides();
      // The first change holds the line at its read of the record until released.
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      const get = storage.get;
      let first = true;
      storage.get = async (key: string) => {
        if (key === guidesKey("gw-a") && first) {
          first = false;
          await held;
        }
        return get(key);
      };
      // Each change joins the line here: the second is in it before its viewer goes.
      const joined = vi.spyOn(
        client as unknown as { oneGuidesChangeAtATime: () => Promise<unknown> },
        "oneGuidesChangeAtATime",
      );
      const ahead = client.changeBotGuides({ action: "add", bots: ["pip"] }, shown.stamp);
      const viewer = createBridgeSession(client);
      const waiting = viewer.apply({
        type: "changeBotGuides",
        change: { action: "add", bots: ["otto"] },
        stamp: shown.stamp,
      });
      await until(() => joined.mock.calls.length >= 2);
      viewer.dispose();
      release();
      await ahead;
      await expect(waiting).rejects.toThrow(/withdrawn/);
      expect(files.sets.map((set) => set.agentId)).toEqual(["pip"]);
    } finally {
      client.stop();
    }
  });

  it("sends nothing for a change whose viewer went away while this device's record was being read", async () => {
    const files = fakeFiles({ pip: BOT_FILE });
    const storage = adminStorage();
    await storage.set(guidesKey("gw-a"), JSON.stringify({ on: true, bots: ["pip"] }));
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      const shown = await client.readBotGuides();
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      let reading = false;
      const get = storage.get;
      storage.get = async (key: string) => {
        if (key === guidesKey("gw-a") && !reading) {
          reading = true;
          await held;
        }
        return get(key);
      };
      const viewer = createBridgeSession(client);
      const change = viewer.apply({
        type: "changeBotGuides",
        change: { action: "add", bots: ["pip"] },
        stamp: shown.stamp,
      });
      await until(() => reading);
      viewer.dispose();
      release();
      await expect(change).rejects.toThrow(/withdrawn/);
      expect(files.sets).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("never changes the voice plugin's own guide: the switch sends nothing to the plugin", async () => {
    const files = fakeFiles({ pip: BOT_FILE });
    const gateway = grantingGateway();
    const reply = gateway.connectReply;
    // The hello lists the voice plugin's read, as a gateway with the plugin does.
    gateway.connectReply = (params, url) => {
      const hello = reply(params, url) as { ok: true; payload: Record<string, unknown> };
      return {
        ...hello,
        payload: { ...hello.payload, features: { methods: [VOICE_GET], events: [] } },
      };
    };
    const storage = adminStorage();
    const { client } = await openTask({ gateway, storage });
    withFiles(gateway, files);
    const voiceSets: unknown[] = [];
    const voice = (on: boolean) => ({
      plugin: "clawtrate-voice",
      on,
      changed: null,
      hook: { state: "allowed", lastRanAt: null },
      guide: "g",
    });
    let on = true;
    gateway.handlers["clawtrate-voice.get"] = () => voice(on);
    gateway.handlers["clawtrate-voice.set"] = (params) => {
      voiceSets.push(params);
      on = (params as { on: boolean }).on;
      return voice(on);
    };
    try {
      const shown = await reconnect(client, gateway, storage);
      expect(shown.voicePlugin).toBe(true);
      expect(shown.folders[0]?.state).toBe("current");
      const off = await client.changeBotGuides({ action: "switch", on: false }, shown.stamp);
      expect(off.voicePlugin).toBe(true);
      await client.changeBotGuides({ action: "switch", on: true }, off.stamp);
      expect(voiceSets).toEqual([]);
    } finally {
      client.stop();
    }
  });
});

/** A section of a later version, as a newer build of Clawtrate writes it. */
function newerSection(text = "## A newer guide\n") {
  const inner = `${GUIDES_NOTICE}\n${text}`;
  return `<!-- clawtrate:guides begin v${GUIDES_VERSION + 1} sha256=${hash(inner)} -->\n${inner}<!-- clawtrate:guides end -->\n`;
}
const END_LINE = "<!-- clawtrate:guides end -->\n";

describe("files Clawtrate leaves alone", () => {
  it("refuses a file that isn't plain UTF-8, so its bytes are never rewritten", async () => {
    // Latin-1 "café règles": the gateway gives the text with U+FFFD and the hash of the bytes.
    const bytes = Uint8Array.from([...`# Otto\ncaf\xe9 r\xe8gles\n`].map((c) => c.charCodeAt(0)));
    const text = "# Otto\ncaf\uFFFD r\uFFFDgles\n";
    for (const [content, change] of [
      [text, { action: "add", bots: ["otto"] }],
      [olderSection() + text, { action: "add", bots: ["otto"] }],
      [withSection(text), { action: "switch", on: false }],
      [
        withSection(text).replace("Be warm", "Be cold"),
        { action: "replace", bot: "otto", shown: "" },
      ],
    ] as [string, GuidesChange][]) {
      const files = fakeFiles({ otto: content }, {}, { otto: sha256Hex(bytes) });
      const result = await applyGuidesChange(files.request, null, change);
      expect(files.sets).toEqual([]);
      expect(result.errors).toEqual([
        "otto: otto's AGENTS.md isn't plain UTF-8 text, so Clawtrate can't change it.",
      ]);
    }
    // Clawtrate's own change, and the switch turned on, leave it without a word: Settings says why.
    for (const content of [text, olderSection() + text])
      for (const change of [{ action: "auto" }, { action: "switch", on: true }] as GuidesChange[]) {
        const files = fakeFiles({ otto: content }, {}, { otto: sha256Hex(bytes) });
        const result = await applyGuidesChange(files.request, null, change);
        expect(files.sets).toEqual([]);
        expect(result.errors).toEqual([]);
      }
  });

  it("still shows the section a file that isn't plain UTF-8 holds, and offers nothing that writes", async () => {
    // A section, then a person's Latin-1 "café" further down.
    const bytesHash = sha256Hex(utf8Bytes("not the bytes of the text"));
    const text = `${withSection("# Otto\ncaf\uFFFD\n")}`;
    const files = fakeFiles({ otto: text }, {}, { otto: bytesHash });
    const [folder] = await readGuideFolders(files.request, { on: true, bots: ["otto"] });
    expect(folder).toMatchObject({ state: "current", utf8: false, error: null });
    for (const change of [
      { action: "add", bots: ["otto"] },
      { action: "switch", on: false },
      { action: "auto" },
      { action: "replace", bot: "otto", shown: "" },
    ] as GuidesChange[]) {
      await applyGuidesChange(files.request, { on: true, bots: ["otto"] }, change);
      expect(files.sets, change.action).toEqual([]);
    }
  });

  it("replaces only one well-formed pair at the top, and writes nothing to a file whose markers are out of shape", async () => {
    const edited = withSection(BOT_FILE).replace("Be warm", "Be cold");
    // Replaceable: one pair, at the top (or right after a byte-order mark), its hash failing.
    expect(findSection(edited)).toMatchObject({ kind: "changed", replaceable: true });
    expect(findSection(`\uFEFF${edited}`)).toMatchObject({ kind: "changed", replaceable: true });
    const shapes = {
      "the end marker deleted": edited.replace(END_LINE, ""),
      "the begin marker deleted": edited.slice(edited.indexOf("\n") + 1),
      "a quoted end marker below": `${edited}\nTo turn it off:\n\n\`\`\`\n${END_LINE}\`\`\`\n`,
      "a marker in a code block only": `# Mine\n\n\`\`\`\n${END_LINE}\`\`\`\nMore.\n`,
      "a pair lower down": `# Mine\n\n${edited}`,
      // The bot deleted its end marker, and the person quotes one in a code block lower down:
      // two markers again, the begin at the top.
      "the end marker deleted, and one quoted below": `${edited.replace(END_LINE, "")}# Mine\nmy rules\nTo remove it, delete down to\n\`\`\`\n${END_LINE}\`\`\`\nmy closing rules\n`,
      // Longer than Show shows: Replace would take out text the person never saw.
      "a section longer than Show shows": withSection(BOT_FILE).replace(
        "Be warm",
        `Be warm${"!".repeat(20_000)}`,
      ),
    };
    for (const [name, file] of Object.entries(shapes)) {
      expect(findSection(file), name).toMatchObject({ kind: "changed", replaceable: false });
      for (const change of [
        { action: "replace", bot: "pip", shown: "" },
        { action: "add", bots: ["pip"] },
        { action: "switch", on: false },
        { action: "switch", on: true },
        { action: "auto" },
      ] as GuidesChange[]) {
        const files = fakeFiles({ pip: file });
        await applyGuidesChange(files.request, null, change);
        expect(files.sets, `${name}: ${change.action}`).toEqual([]);
      }
      const [folder] = await readGuideFolders(fakeFiles({ pip: file }).request, null);
      expect(folder).toMatchObject({ state: "changed", replaceable: false });
    }
    const files = fakeFiles({ pip: edited });
    const shown = (findSection(edited) as { text: string }).text;
    await applyGuidesChange(files.request, null, { action: "replace", bot: "pip", shown });
    expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
  });

  it("leaves a section of this version or a newer one alone, and updates only a lower one", async () => {
    const newer = newerSection() + BOT_FILE;
    expect(findSection(newer)).toMatchObject({ kind: "ours", current: true });
    for (const change of [
      { action: "auto" },
      { action: "switch", on: true },
      { action: "add", bots: ["pip"] },
    ] as GuidesChange[]) {
      const files = fakeFiles({ pip: newer });
      await applyGuidesChange(files.request, null, change);
      expect(files.sets).toEqual([]);
    }
    const [folder] = await readGuideFolders(fakeFiles({ pip: newer }).request, null);
    expect(folder?.state).toBe("current");
  });

  it("pins the text to its version: changing the text means a new version", () => {
    expect(GUIDES_SECTION.split("\n")[0]).toMatch(
      new RegExp(
        `^<!-- clawtrate:guides begin v${GUIDES_VERSION} sha256=${GUIDES_PINNED_SHA256}[a-f0-9]{48} -->$`,
      ),
    );
    expect(GUIDES_VERSION).toBe(2);
  });

  it("says a long file would be cut, and never makes one longer than the limit in the background", async () => {
    const long = `# Pip\n${"x".repeat(GUIDES_LONG_CHARS - GUIDES_SIZE)}\n`;
    // Exactly at the limit once added, measured without trailing whitespace, as the gateway does.
    const edge = `# Pip\n${"x".repeat(GUIDES_LONG_CHARS - GUIDES_SIZE - 6)}\n\n\n\n`;
    const short = BOT_FILE;
    // An older section is measured with its own span replaced, not with a second section.
    const olderNearLimit = `${olderSection("## Old\n")}${"y".repeat(GUIDES_LONG_CHARS - GUIDES_SIZE - 10)}\n`;
    const files = fakeFiles({ pip: long, otto: short, juniper: edge, marlow: olderNearLimit });
    const folders = await readGuideFolders(files.request, null);
    expect(folders.map((f) => [f.bots[0], f.long])).toEqual([
      ["pip", true],
      ["otto", false],
      ["juniper", false],
      ["marlow", false],
    ]);
    // Clawtrate's own change, for every bot or a new one, and the switch turned on leave a file
    // the section would push past the limit, an older section's included.
    for (const content of [long, olderSection("## Old\n") + long])
      for (const change of [
        { action: "auto" },
        { action: "auto", bot: "pip" },
        { action: "switch", on: true },
      ] as GuidesChange[]) {
        const files = fakeFiles({ pip: content });
        await applyGuidesChange(files.request, null, change);
        expect(files.sets).toEqual([]);
      }
    // The person's own Add on its row still adds it.
    const asked = fakeFiles({ pip: long });
    await applyGuidesChange(asked.request, null, { action: "add", bots: ["pip"] });
    expect(asked.sets).toHaveLength(1);
  });

  it("records a bot, and lets Settings report it, only when its file was written or already current", async () => {
    // The bot changes its own file between Settings' read and the press: Replace finds it out
    // of shape, Add finds it changed. Nothing is written, so nothing is recorded.
    const files = fakeFiles({ otto: `# Otto\n\`\`\`\n${END_LINE}\`\`\`\n` });
    const replaced = await applyGuidesChange(files.request, null, {
      action: "replace",
      bot: "otto",
      shown: "",
    });
    expect(files.sets).toEqual([]);
    expect(replaced.record?.bots ?? []).toEqual([]);
    const changed = fakeFiles({ otto: withSection(BOT_FILE).replace("Be warm", "Be cold") });
    const added = await applyGuidesChange(changed.request, null, { action: "add", bots: ["otto"] });
    expect(changed.sets).toEqual([]);
    expect(added.record?.bots).toEqual([]);
    // Already current: recorded, with nothing written.
    const current = fakeFiles({ otto: withSection(BOT_FILE) });
    const kept = await applyGuidesChange(current.request, null, { action: "add", bots: ["otto"] });
    expect(current.sets).toEqual([]);
    expect(kept.record?.bots).toEqual(["otto"]);
  });

  it("treats a section as its own only at the top of the file: a moved or quoted copy is never written", async () => {
    const fenced = `# Mine\n\nHere is what Clawtrate adds:\n\n\`\`\`\n${GUIDES_SECTION}\`\`\`\nMore.\n`;
    const fencedOlder = `# Mine\n\nHere is what Clawtrate adds:\n\n\`\`\`\n${olderSection()}\`\`\`\nMore.\n`;
    const below = `# Mine\nmy rules\n\n${GUIDES_SECTION}\nMore.\n`;
    for (const [name, file] of Object.entries({ fenced, fencedOlder, below })) {
      expect(findSection(file), name).toMatchObject({
        kind: "changed",
        replaceable: false,
        moved: true,
      });
      for (const change of [
        { action: "add", bots: ["pip"] },
        { action: "auto" },
        { action: "replace", bot: "pip", shown: file },
        { action: "switch", on: false },
      ] as GuidesChange[]) {
        const files = fakeFiles({ pip: file });
        await applyGuidesChange(files.request, null, change);
        expect(files.sets, `${name}: ${change.action}`).toEqual([]);
      }
      const [folder] = await readGuideFolders(fakeFiles({ pip: file }).request, null);
      expect(folder, name).toMatchObject({ state: "changed", replaceable: false, moved: true });
    }
    // At the top, and right after a byte-order mark, it is Clawtrate's as before.
    for (const file of [withSection(BOT_FILE), withSection(`\uFEFF${BOT_FILE}`)]) {
      expect(findSection(file)).toMatchObject({ kind: "ours", current: true });
      const files = fakeFiles({ pip: file });
      await applyGuidesChange(
        files.request,
        { on: true, bots: ["pip"] },
        {
          action: "switch",
          on: false,
        },
      );
      expect(files.store.get("pip")).toBe(
        file.startsWith("\uFEFF") ? `\uFEFF${BOT_FILE}` : BOT_FILE,
      );
    }
  });
});

// Every section a released build wrote (guides-published.ts) reads as Clawtrate's own and older,
// so it is brought up to date by itself under the same rules as any by-itself write (#666).
describe("the sections earlier builds wrote", () => {
  /** A published section's "Where you live", as it wrote it. */
  const whereOf = (section: string) =>
    section.slice(section.indexOf("## Where you live"), section.lastIndexOf("\n<!-- clawtrate:"));

  it("each is pinned, of a lower version, and reads as Clawtrate's own, unedited and older", () => {
    expect(PUBLISHED_SECTIONS.map((each) => each.version)).toEqual([1]);
    for (const { version, pin, section } of PUBLISHED_SECTIONS) {
      expect(section.split("\n")[0]).toMatch(
        new RegExp(`^<!-- clawtrate:guides begin v${version} sha256=${pin}[a-f0-9]{48} -->$`),
      );
      expect(version).toBeLessThan(GUIDES_VERSION);
      expect(findSection(section + BOT_FILE)).toMatchObject({ kind: "ours", current: false });
    }
  });

  it("changes only Where you live: 1,453 characters before, 2,270 now, and still fits", () => {
    const v1 = PUBLISHED_SECTIONS.find((each) => each.version === 1)!.section;
    expect(whereOf(v1).length).toBe(1_453);
    expect(WHERE_GUIDE.length).toBe(2_270);
    expect(whereOf(GUIDES_SECTION)).toBe(WHERE_GUIDE);
    expect(GUIDES_SECTION.length - v1.length).toBe(817);
    expect(v1.split(VOICE_GUIDE)).toHaveLength(2);
    // The limits #643 set: Replace takes out at most what Show shows, and a file with only the
    // section is far from the gateway's default cut.
    expect(GUIDES_SECTION.length).toBeLessThanOrEqual(MAX_CHANGED_SECTION_CHARS);
    expect(guidesWouldBeCut(withSection(""), GUIDES_LONG_CHARS)).toBe(false);
  });

  it("an unedited one is brought up to date by itself, and nothing else in the file changes", async () => {
    for (const { section } of PUBLISHED_SECTIONS)
      for (const below of [`\n${BOT_FILE}`, "\n", ""]) {
        const files = fakeFiles({ pip: section + below });
        expect((await readGuideFolders(files.request, null))[0]?.state).toBe("older");
        const result = await applyGuidesChange(files.request, null, { action: "auto" });
        expect(result.errors).toEqual([]);
        expect(files.store.get("pip")).toBe(GUIDES_SECTION + below);
        expect(result.record).toEqual({ on: true, bots: ["pip"], folders: at(["pip"]) });
        expect((await readGuideFolders(files.request, result.record))[0]?.state).toBe("current");
      }
  });

  it("an unedited one waits while the gateway's limit can't be read, as any write by itself does", async () => {
    for (const { section } of PUBLISHED_SECTIONS) {
      const files = fakeFiles({ pip: `${section}\n${BOT_FILE}` }, {}, {}, null);
      await applyGuidesChange(files.request, null, { action: "auto" });
      expect(files.sets).toEqual([]);
    }
  });

  it("an edited one is left as it is, by itself, and Settings offers Replace", async () => {
    for (const { section } of PUBLISHED_SECTIONS) {
      const edited = section.replace("Be warm", "Be warmer") + `\n${BOT_FILE}`;
      expect(edited).not.toBe(section + `\n${BOT_FILE}`);
      const files = fakeFiles({ pip: edited });
      await applyGuidesChange(files.request, null, { action: "auto" });
      await applyGuidesChange(files.request, null, { action: "switch", on: true });
      expect(files.sets).toEqual([]);
      const [folder] = await readGuideFolders(files.request, null);
      expect(folder).toMatchObject({ state: "changed", replaceable: true });
      // Replace, the person's own, puts this version in its place.
      const shown = folder!.changedText!;
      await applyGuidesChange(files.request, null, { action: "replace", bot: "pip", shown });
      expect(files.store.get("pip")).toBe(`${GUIDES_SECTION}\n${BOT_FILE}`);
    }
  });

  it("one removed on purpose stays out, by this device's record or the gateway's history", async () => {
    for (const { section } of PUBLISHED_SECTIONS) {
      // This device wrote it, and it was taken out since.
      const known = fakeFiles({ pip: BOT_FILE });
      const own = await applyGuidesChange(
        known.request,
        { on: true, bots: ["pip"] },
        {
          action: "auto",
        },
      );
      expect(known.sets).toEqual([]);
      expect((await readGuideFolders(known.request, own.record))[0]?.state).toBe("removed");
      // Another device wrote it, recorded it in the gateway's history, and it was taken out since.
      const elsewhere = fakeFiles({ pip: `${section}\n${BOT_FILE}` });
      await applyGuidesChange(elsewhere.request, null, { action: "auto" });
      expect(elsewhere.prefs.entries.get(GUIDES_HISTORY_KEY)).toEqual({
        v: 1,
        bots: ["pip"],
        folders: at(["pip"]),
      });
      elsewhere.store.set("pip", BOT_FILE);
      const before = elsewhere.sets.length;
      await applyGuidesChange(elsewhere.request, null, { action: "auto" });
      expect(elsewhere.sets).toHaveLength(before);
      expect((await readGuideFolders(elsewhere.request, null))[0]?.state).toBe("removed");
    }
  });
});
