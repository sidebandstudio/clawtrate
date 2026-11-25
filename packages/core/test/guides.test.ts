// Clawtrate's guides as a marked section in a bot's AGENTS.md (#532, #544): render, find,
// replace and remove, each bot's state, the changes the person asks for, and the client's
// guards. The gateway's half is the guide checks of `pnpm scenarios` (guides-checks.ts).
import { describe, expect, it } from "vitest";
import { sha256Hex, utf8Bytes } from "../src/bytes.ts";
import { VOICE_GUIDE, WHERE_GUIDE } from "../src/guide-text.ts";
import { VOICE_GET } from "../src/voice.ts";
import {
  applyGuidesChange,
  GUIDES_NOT_RECORDED,
  GUIDES_NOT_SAVED,
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
import { memoryStorage, tokenKey, until } from "./fake-gateway.ts";
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
    const folders = await readGuideFolders(request, { bots: ["juniper"], newBots: true });
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

describe("the changes the person asks for", () => {
  it("adds to the chosen bots only, once per shared folder, and records them", async () => {
    const files = fakeFiles({ pip: BOT_FILE, shared: BOT_FILE, otto: BOT_FILE }, { shared: "pip" });
    const result = await applyGuidesChange(files.request, null, {
      action: "add",
      bots: ["pip"],
      newBots: true,
    });
    expect(result).toEqual({ record: { bots: ["pip", "shared"], newBots: true }, errors: [] });
    expect(files.sets).toHaveLength(1);
    expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
    expect(files.store.get("otto")).toBe(BOT_FILE);
  });

  it("never writes over a section changed outside Clawtrate, unless asked to replace it", async () => {
    const changed = withSection(BOT_FILE).replace("Be warm", "Be cold");
    const files = fakeFiles({ pip: changed });
    await applyGuidesChange(files.request, null, { action: "add", bots: ["pip"], newBots: false });
    await applyGuidesChange(files.request, null, { action: "update" });
    await applyGuidesChange(files.request, null, { action: "remove" });
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
    expect(result.record).toEqual({ bots: [], newBots: false });
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

  it("takes New bots too from a viewer only as on or off", () => {
    const command = {
      type: "changeBotGuides",
      change: { action: "newBots", on: false },
      stamp: { gatewayId: "gw-a", target: 1 },
    };
    expect(parseBridgeCommand(command)).toEqual(command);
    for (const on of [undefined, "false", 0])
      expect(() => parseBridgeCommand({ ...command, change: { action: "newBots", on } })).toThrow(
        "invalid guides change",
      );
  });

  it("brings an older version up to date after a connect, and leaves the rest", async () => {
    const files = fakeFiles({
      otto: olderSection() + BOT_FILE,
      pip: BOT_FILE,
      juniper: GUIDES_SECTION,
    });
    const result = await applyGuidesChange(files.request, null, { action: "update" });
    expect(result.errors).toEqual([]);
    expect(files.sets.map((set) => set.agentId)).toEqual(["otto"]);
    expect(findSection(files.store.get("otto")!)).toMatchObject({ kind: "ours", current: true });
  });

  it("removes it from every file as it was, and forgets the bots so none reads as removed", async () => {
    const files = fakeFiles({ pip: withSection(BOT_FILE), otto: withSection(""), main: BOT_FILE });
    const result = await applyGuidesChange(
      files.request,
      { bots: ["pip", "otto"], newBots: true },
      { action: "remove" },
    );
    expect(result.record).toEqual({ bots: [], newBots: false });
    expect(files.store.get("pip")).toBe(BOT_FILE);
    expect(files.store.get("otto")).toBe("");
    expect(files.sets).toHaveLength(2);
  });

  it("reads again and retries once when the file changed meanwhile, then says it left it", async () => {
    const files = fakeFiles({ pip: BOT_FILE });
    files.faults.conflicts = 1;
    await applyGuidesChange(files.request, null, { action: "add", bots: ["pip"], newBots: false });
    expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
    const again = fakeFiles({ pip: BOT_FILE });
    again.faults.conflicts = 2;
    const result = await applyGuidesChange(again.request, null, {
      action: "add",
      bots: ["pip"],
      newBots: false,
    });
    expect(result.errors).toEqual([
      "pip: AGENTS.md kept changing while Clawtrate wrote it, so it was left as it is.",
    ]);
    expect(result.record).toEqual({ bots: [], newBots: false });
    expect(again.store.get("pip")).toBe(BOT_FILE);
  });

  it("answers Not now without asking the gateway anything", async () => {
    const result = await applyGuidesChange(
      () => Promise.reject(new Error("nothing may be asked")),
      null,
      { action: "decline" },
    );
    expect(result).toEqual({ record: { bots: [], newBots: false }, errors: [] });
  });

  it("keeps a record it can read back, and refuses one it can't", () => {
    expect(parseGuidesRecord(JSON.stringify({ bots: ["pip", 3], newBots: true }))).toEqual({
      bots: ["pip"],
      newBots: true,
    });
    for (const bad of [null, "", "{", "[]", JSON.stringify({ bots: ["pip"] })])
      expect(parseGuidesRecord(bad)).toBeNull();
  });
});

describe("the guides in the client", () => {
  const adminStorage = () =>
    memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: ADMIN_SCOPES,
        heldScopes: INTERACTIVE_SCOPES,
        adminHeld: true,
      }),
    });
  const withFiles = <T extends { handlers: Record<string, (params: unknown) => unknown> }>(
    gateway: T,
    files: ReturnType<typeof fakeFiles>,
  ) => {
    for (const method of ["agents.list", "agents.files.get", "agents.files.set"])
      gateway.handlers[method] = (params) => files.request(method, params);
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gw-a" });
    return gateway;
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

  it("takes a yes back only once it is saved: when it can't be, nothing is removed and it says so", async () => {
    const files = fakeFiles({ pip: withSection(BOT_FILE) });
    const saved = { bots: ["pip"], newBots: true };
    const storage = diskFull(saved);
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      const shown = await client.readBotGuides();
      for (const change of [
        { action: "remove" },
        { action: "newBots", on: false },
      ] as GuidesChange[]) {
        const after = await client.changeBotGuides(change, shown.stamp);
        expect(after.errors, change.action).toEqual([GUIDES_NOT_SAVED]);
        expect(files.sets).toEqual([]);
        // The rows say what the files and this device hold: the section is still Pip's.
        expect(after.folders[0]?.state).toBe("current");
        expect(after.record).toEqual(saved);
      }
      expect(parseGuidesRecord(storage.data.get(guidesKey("gw-a")) ?? null)).toEqual(saved);
    } finally {
      client.stop();
    }
  });

  it("after a Remove that was saved, a file that refused keeps its section, offered again, and new bots get nothing", async () => {
    const files = fakeFiles({ pip: withSection(BOT_FILE), otto: withSection(BOT_FILE) });
    files.faults.refuse.add("otto");
    const storage = adminStorage();
    await storage.set(guidesKey("gw-a"), JSON.stringify({ bots: ["pip", "otto"], newBots: true }));
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      const shown = await client.readBotGuides();
      const after = await client.changeBotGuides({ action: "remove" }, shown.stamp);
      expect(after.errors).toEqual([expect.stringMatching(/^otto: .*exceeds its write bound$/)]);
      expect(files.store.get("pip")).toBe(BOT_FILE);
      expect(after.folders.map((f) => [f.bots[0], f.state])).toEqual([
        ["pip", "none"],
        ["otto", "current"],
      ]);
      expect(parseGuidesRecord(storage.data.get(guidesKey("gw-a")) ?? null)).toEqual({
        bots: [],
        newBots: false,
      });
    } finally {
      client.stop();
    }
  });

  it("gives a yes on the files first and records it last, and says so truly when it can't record it", async () => {
    const files = fakeFiles({ pip: BOT_FILE });
    const storage = diskFull({ bots: [], newBots: false });
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      const shown = await client.readBotGuides();
      const after = await client.changeBotGuides(
        { action: "add", bots: ["pip"], newBots: true },
        shown.stamp,
      );
      expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
      expect(after.errors).toEqual([GUIDES_NOT_RECORDED]);
      expect(after.folders[0]?.state).toBe("current");
      // Not recorded: this device keeps nothing current and adds nothing to new bots.
      expect(after.record).toEqual({ bots: [], newBots: false });
      const on = await client.changeBotGuides({ action: "newBots", on: true }, after.stamp);
      expect(on.errors).toEqual([GUIDES_NOT_SAVED]);
      expect(on.record?.newBots).toBe(false);
    } finally {
      client.stop();
    }
  });

  it("adds, reads back and records, on the gateway the screen was read from", async () => {
    const files = fakeFiles({ pip: BOT_FILE, otto: BOT_FILE });
    const { client, gateway, storage } = await openTask({ storage: adminStorage() });
    withFiles(gateway, files);
    try {
      const shown = await client.readBotGuides();
      expect(shown.folders.map((f) => f.state)).toEqual(["none", "none"]);
      expect(shown.stamp.gatewayId).toBe("gw-a");
      const after = await client.changeBotGuides(
        { action: "add", bots: ["pip"], newBots: true },
        shown.stamp,
      );
      expect(after.folders.map((f) => [f.bots[0], f.state])).toEqual([
        ["pip", "current"],
        ["otto", "none"],
      ]);
      expect(after.errors).toEqual([]);
      expect(parseGuidesRecord(storage.data.get(guidesKey("gw-a")) ?? null)).toEqual({
        bots: ["pip"],
        newBots: true,
      });
      // A stale screen's stamp sends nothing.
      await expect(
        client.changeBotGuides({ action: "remove" }, { ...shown.stamp, gatewayId: "gw-b" }),
      ).rejects.toThrow(/another gateway/);
      expect(files.sets).toHaveLength(1);
    } finally {
      client.stop();
    }
  });

  it("writes nothing below admin, or from a read-only viewer, and Not now or New bots too off writes nothing anywhere", async () => {
    for (const options of [
      { held: INTERACTIVE_SCOPES },
      { storage: adminStorage(), client: { readOnly: true } },
    ]) {
      const files = fakeFiles({ pip: BOT_FILE });
      const { client, gateway } = await openTask(options);
      withFiles(gateway, files);
      try {
        const shown = await client.readBotGuides();
        await expect(
          client.changeBotGuides({ action: "add", bots: ["pip"], newBots: false }, shown.stamp),
        ).rejects.toThrow(/admin/i);
        expect((await client.changeBotGuides({ action: "decline" }, shown.stamp)).record).toEqual({
          bots: [],
          newBots: false,
        });
        // A yes for new bots needs admin too; taking it back never does.
        await expect(
          client.changeBotGuides({ action: "newBots", on: true }, shown.stamp),
        ).rejects.toThrow(/admin/i);
        expect(
          (await client.changeBotGuides({ action: "newBots", on: false }, shown.stamp)).record,
        ).toEqual({ bots: [], newBots: false });
        expect(files.sets).toEqual([]);
      } finally {
        client.stop();
      }
    }
  });

  it("brings an older section up to date after a connect with admin, where this device said yes, and only then", async () => {
    for (const [admin, said] of [
      [true, true],
      [false, true],
      [true, false],
    ] as const) {
      const files = fakeFiles({ otto: olderSection() + BOT_FILE });
      const storage = admin ? adminStorage() : undefined;
      if (said)
        await (storage ?? memoryStorage({})).set(
          guidesKey("gw-a"),
          JSON.stringify({ bots: ["otto"], newBots: false }),
        );
      const { client, gateway } = await openTask({
        ...(storage ? { storage } : {}),
      });
      withFiles(gateway, files);
      try {
        gateway.dropAll();
        await until(() => client.state.connection.status === "connected");
        if (admin && said) await until(() => files.sets.length === 1);
        else await new Promise<void>((resolve) => setTimeout(resolve, 100));
        expect(files.sets.length).toBe(admin && said ? 1 : 0);
      } finally {
        client.stop();
      }
    }
  });

  it("brings nothing up to date from a read-only viewer, even where this device said yes", async () => {
    const files = fakeFiles({ otto: olderSection() + BOT_FILE });
    const storage = adminStorage();
    await storage.set(guidesKey("gw-a"), JSON.stringify({ bots: ["otto"], newBots: false }));
    const { client, gateway } = await openTask({ storage, client: { readOnly: true } });
    withFiles(gateway, files);
    try {
      gateway.dropAll();
      await until(() => client.state.connection.status === "connected");
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      expect(files.sets).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("refuses a change from a viewer that went away before it was sent", async () => {
    const files = fakeFiles({ pip: BOT_FILE });
    const { client, gateway } = await openTask({ storage: adminStorage() });
    withFiles(gateway, files);
    try {
      const viewer = createBridgeSession(client);
      const shown = (await viewer.apply({ type: "readBotGuides" })) as BotGuidesAnswer;
      const change = viewer.apply({
        type: "changeBotGuides",
        change: { action: "add", bots: ["pip"], newBots: false },
        stamp: shown.stamp,
      });
      viewer.dispose();
      await expect(change).rejects.toThrow(/withdrawn/);
      expect(files.sets).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("never changes the voice plugin's own guide: adding the section sends nothing to the plugin", async () => {
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
    const { client } = await openTask({ gateway, storage: adminStorage() });
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
      const shown = await client.readBotGuides();
      expect(shown.voicePlugin).toBe(true);
      const after = await client.changeBotGuides(
        { action: "add", bots: ["pip"], newBots: false },
        shown.stamp,
      );
      expect(voiceSets).toEqual([]);
      expect(after.voicePlugin).toBe(true);
      expect(after.folders[0]?.state).toBe("current");
      await client.changeBotGuides({ action: "remove" }, after.stamp);
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
      [text, { action: "add", bots: ["otto"], newBots: false }],
      [withSection(text), { action: "remove" }],
      [olderSection() + text, { action: "update" }],
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
  });

  it("still shows the section a file that isn't plain UTF-8 holds, and offers nothing that writes", async () => {
    // A section, then a person's Latin-1 "café" further down.
    const bytesHash = sha256Hex(utf8Bytes("not the bytes of the text"));
    const text = `${withSection("# Otto\ncaf\uFFFD\n")}`;
    const files = fakeFiles({ otto: text }, {}, { otto: bytesHash });
    const [folder] = await readGuideFolders(files.request, { bots: ["otto"], newBots: true });
    expect(folder).toMatchObject({ state: "current", utf8: false, error: null });
    for (const change of [
      { action: "add", bots: ["otto"], newBots: true },
      { action: "remove" },
      { action: "update" },
      { action: "replace", bot: "otto", shown: "" },
    ] as GuidesChange[]) {
      await applyGuidesChange(files.request, { bots: ["otto"], newBots: true }, change);
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
        { action: "add", bots: ["pip"], newBots: true },
        { action: "remove" },
        { action: "update" },
      ] as GuidesChange[]) {
        const files = fakeFiles({ pip: file });
        await applyGuidesChange(files.request, { bots: ["pip"], newBots: true }, change);
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
      { action: "update" },
      { action: "add", bots: ["pip"], newBots: true },
    ] as GuidesChange[]) {
      const files = fakeFiles({ pip: newer });
      await applyGuidesChange(files.request, { bots: ["pip"], newBots: true }, change);
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
    // The background update and New bots too leave a file the section would push past the limit.
    const older = fakeFiles({ pip: olderSection("## Old\n") + long });
    await applyGuidesChange(older.request, { bots: ["pip"], newBots: true }, { action: "update" });
    expect(older.sets).toEqual([]);
    const newBot = fakeFiles({ pip: long });
    await applyGuidesChange(newBot.request, null, {
      action: "add",
      bots: ["pip"],
      newBots: true,
      background: true,
    });
    expect(newBot.sets).toEqual([]);
    // The person's own Add still adds it.
    const asked = fakeFiles({ pip: long });
    await applyGuidesChange(asked.request, null, { action: "add", bots: ["pip"], newBots: true });
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
    const added = await applyGuidesChange(changed.request, null, {
      action: "add",
      bots: ["otto"],
      newBots: false,
    });
    expect(changed.sets).toEqual([]);
    expect(added.record?.bots).toEqual([]);
    // Already current: recorded, with nothing written.
    const current = fakeFiles({ otto: withSection(BOT_FILE) });
    const kept = await applyGuidesChange(current.request, null, {
      action: "add",
      bots: ["otto"],
      newBots: false,
    });
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
        { action: "add", bots: ["pip"], newBots: true },
        { action: "update" },
        { action: "replace", bot: "pip", shown: file },
        { action: "remove" },
      ] as GuidesChange[]) {
        const files = fakeFiles({ pip: file });
        await applyGuidesChange(files.request, { bots: ["pip"], newBots: true }, change);
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
        { bots: ["pip"], newBots: true },
        { action: "remove" },
      );
      expect(files.store.get("pip")).toBe(
        file.startsWith("\uFEFF") ? `\uFEFF${BOT_FILE}` : BOT_FILE,
      );
    }
  });
});
