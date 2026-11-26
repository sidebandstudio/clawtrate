// Clawtrate's guides as a marked section in a bot's AGENTS.md (#532, #544, #628): render, find,
// replace and remove, each bot's state, the switch and the rows' changes, Clawtrate's own change
// with nothing asked, and the client's guards. The gateway's half is the guide checks of
// `pnpm scenarios` (guides-checks.ts).
import { describe, expect, it } from "vitest";
import { sha256Hex, utf8Bytes } from "../src/bytes.ts";
import { VOICE_GUIDE, WHERE_GUIDE } from "../src/guide-text.ts";
import { VOICE_GET } from "../src/voice.ts";
import {
  applyGuidesChange,
  GUIDES_NOT_READ,
  GUIDES_NOT_RECORDED,
  GUIDES_NOT_SAVED,
  GUIDES_OFF,
  findSection,
  GUIDES_LONG_CHARS,
  GUIDES_PINNED_SHA256,
  GUIDES_VERSION,
  GUIDES_NOTICE,
  GUIDES_SECTION,
  GUIDES_SIZE,
  GUIDES_TEXT,
  guidesKey,
  MAX_CHANGED_SECTION_CHARS,
  parseGuidesRecord,
  readGuideFolders,
  withoutSection,
  withSection,
} from "../src/guides.ts";
import { ADMIN_SCOPES, INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
import type { BotGuidesAnswer, GuidesChange } from "../src/guides.ts";
import { grantingGateway, openTask } from "./client-harness.ts";
import { memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";
import { ClawtrateClient } from "../src/client.ts";
import { FAST } from "./client-harness.ts";
import { URL_A } from "./client-harness.ts";

const hash = (text: string) => sha256Hex(utf8Bytes(text));
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
) {
  const store = new Map(Object.entries(files));
  const hashOf = (key: string, content: string) => bytesHash[key] ?? hash(content);
  const sets: { agentId: string; content: string }[] = [];
  const faults = { conflicts: 0, refuse: new Set<string>() };
  const folder = (agentId: string) => workspaces[agentId] ?? agentId;
  const request = async (method: string, params: unknown) => {
    const p = params as Record<string, unknown>;
    if (method === "agents.list")
      return { agents: Object.keys(files).map((id) => ({ id, workspace: `/w/${folder(id)}` })) };
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
      if (faults.refuse.has(key)) throw new Error("Workspace document exceeds its write bound");
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
    throw new Error(`unknown method ${method}`);
  };
  return { request, store, sets, faults };
}

describe("the section", () => {
  it("is the two guides between Clawtrate's markers, with the hash of what's between them", () => {
    const lines = GUIDES_SECTION.split("\n");
    expect(lines[0]).toMatch(/^<!-- clawtrate:guides begin v1 sha256=[a-f0-9]{64} -->$/);
    expect(lines[1]).toBe(GUIDES_NOTICE);
    expect(GUIDES_NOTICE).toContain("Turn it off in Clawtrate: Settings, Conversation.");
    expect(GUIDES_SECTION.endsWith("<!-- clawtrate:guides end -->\n")).toBe(true);
    expect(GUIDES_TEXT).toBe(`${VOICE_GUIDE}\n\n${WHERE_GUIDE}`);
    expect(GUIDES_SECTION.split(VOICE_GUIDE)).toHaveLength(2);
    expect(GUIDES_SECTION.split(WHERE_GUIDE)).toHaveLength(2);
    // It is in every run's prompt: bounded, and said in Settings.
    expect(GUIDES_SIZE).toBe(GUIDES_SECTION.length + 1);
    expect(GUIDES_SIZE).toBeLessThanOrEqual(3_200);
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
    expect(result).toEqual({ record: { on: true, bots: ["pip", "shared"] }, errors: [] });
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
    });
    for (const change of [
      { action: "add", bots: ["pip"] },
      { action: "replace", bot: "pip", shown: "" },
    ] as GuidesChange[])
      expect(await applyGuidesChange(nothing, off, change)).toEqual({
        record: off,
        errors: [GUIDES_OFF],
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
    expect(result.record).toEqual({ on: true, bots: ["otto"] });
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
      ).toEqual({ on: true, bots: ["pip"] });
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
    for (const bad of [null, "", "{", "[]", JSON.stringify({ bots: ["pip"] })])
      expect(parseGuidesRecord(bad)).toBeNull();
  });

  it("reads a record from before the switch as off only when it holds no yes, so an update never turns a no into a yes", () => {
    const old = (bots: string[], newBots: boolean) =>
      parseGuidesRecord(JSON.stringify({ bots, newBots }));
    // "Not now", "Remove from all bots", or New bots too turned off with nothing added.
    expect(old([], false)).toEqual({ on: false, bots: [] });
    // Any yes: bots it added, or New bots too.
    expect(old(["pip"], false)).toEqual({ on: true, bots: ["pip"] });
    expect(old([], true)).toEqual({ on: true, bots: [] });
    expect(old(["pip"], true)).toEqual({ on: true, bots: ["pip"] });
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
      if (key === guidesKey("gw-a")) storage.guideReads += 1;
      return get(key);
    };
    return storage;
  };
  const withFiles = <T extends { handlers: Record<string, (params: unknown) => unknown> }>(
    gateway: T,
    files: ReturnType<typeof fakeFiles>,
  ) => {
    for (const method of ["agents.list", "agents.files.get", "agents.files.set"])
      gateway.handlers[method] = (params) => files.request(method, params);
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gw-a" });
    return gateway;
  };
  const recordIn = (storage: { data: Map<string, string> }) =>
    parseGuidesRecord(storage.data.get(guidesKey("gw-a")) ?? null);
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
    const was = client.state.connection.connectedAt;
    const reads = storage?.guideReads ?? 0;
    gateway.dropAll();
    await until(
      () =>
        client.state.connection.status === "connected" &&
        client.state.connection.connectedAt !== was,
    );
    if (storage) await until(() => storage.guideReads > reads);
    else await new Promise<void>((resolve) => setTimeout(resolve, 300));
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
      expect(read.folders.map((f) => [f.bots.join("+"), f.state])).toEqual([
        ["pip+shared", "current"],
        ["otto", "current"],
      ]);
      expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
      expect(files.store.get("otto")).toBe(withSection(""));
      expect(files.sets).toHaveLength(2);
      expect(recordIn(storage)).toEqual({ on: true, bots: ["pip", "shared", "otto"] });
      // Again on the next connect: nothing left to write.
      await reconnect(client, gateway, storage);
      expect(files.sets).toHaveLength(2);
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
      expect(recordIn(storage)).toEqual({ on: true, bots: ["pip", "otto", "marlow"] });
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
      expect(again.record).toEqual({ on: true, bots: ["pip", "otto"] });
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
    // Pip's section was removed outside Clawtrate; Otto never had one (this connect's own change
    // came before the files could be read).
    const files = fakeFiles({ pip: BOT_FILE, otto: BOT_FILE });
    const storage = diskFull({ on: true, bots: ["pip"] });
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
      expect(files.store.get("otto")).toBe(withSection(BOT_FILE));
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
      expect(recordIn(storage)).toEqual({ on: true, bots: ["pip", "otto"] });
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
        // No change of Clawtrate's own starts here, so there is nothing to wait for.
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
      const ahead = client.changeBotGuides({ action: "add", bots: ["pip"] }, shown.stamp);
      const viewer = createBridgeSession(client);
      const waiting = viewer.apply({
        type: "changeBotGuides",
        change: { action: "add", bots: ["otto"] },
        stamp: shown.stamp,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      viewer.dispose();
      release();
      await ahead;
      await expect(waiting).rejects.toThrow(/withdrawn/);
      expect(files.sets.map((set) => set.agentId)).toEqual(["pip"]);
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
    expect(GUIDES_VERSION).toBe(1);
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
