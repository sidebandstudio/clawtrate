// Clawtrate's guides as a marked section in a bot's AGENTS.md (#532, #544): render, find,
// replace and remove, each bot's state, the changes the person asks for, and the client's
// guards. The gateway's half is the guide checks of `pnpm scenarios` (guides-checks.ts).
import { describe, expect, it } from "vitest";
import { sha256Hex, utf8Bytes } from "../src/bytes.ts";
import { VOICE_GUIDE, WHERE_GUIDE } from "../src/guide-text.ts";
import { VOICE_GET } from "../src/voice.ts";
import {
  applyGuidesChange,
  findSection,
  GUIDES_NOTICE,
  GUIDES_SECTION,
  GUIDES_SIZE,
  GUIDES_TEXT,
  guidesKey,
  parseGuidesRecord,
  readGuideFolders,
  withoutSection,
  withSection,
} from "../src/guides.ts";
import { ADMIN_SCOPES, INTERACTIVE_SCOPES } from "../src/scopes.ts";
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
function fakeFiles(files: Record<string, string | null>, workspaces: Record<string, string> = {}) {
  const store = new Map(Object.entries(files));
  const sets: { agentId: string; content: string }[] = [];
  const faults = { conflicts: 0 };
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
            : { name: "AGENTS.md", content, hash: hash(content) },
      };
    if (method === "agents.files.set") {
      const held = content === null ? p.expectedMissing === true : p.expectedHash === hash(content);
      if (!held || faults.conflicts > 0) {
        faults.conflicts = Math.max(0, faults.conflicts - 1);
        throw Object.assign(new Error("file changed"), {
          details: { type: "agent_file_conflict", name: "AGENTS.md" },
        });
      }
      store.set(key, p.content as string);
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
    expect(withSection("")).toBe(GUIDES_SECTION);
    expect(withoutSection(BOT_FILE)).toBe(BOT_FILE);
  });

  it("replaces an older version in place, wherever it is, and nothing else", () => {
    const file = `# Top\n\n${olderSection()}\nBelow.\n`;
    expect(findSection(file)).toMatchObject({ kind: "ours", current: false });
    expect(withSection(file)).toBe(`# Top\n\n${GUIDES_SECTION}\nBelow.\n`);
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
    expect(found).toMatchObject({ kind: "changed", start: 0 });
    // Replace puts this version in its place, and the rest stays.
    expect(withSection(loose)).toBe(`${GUIDES_SECTION}rest\n`);
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
      { bots: ["pip"], state: null, changedText: null, error: "missing scope: operator.read" },
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
    await applyGuidesChange(files.request, null, { action: "replace", bot: "pip" });
    expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
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

  it("writes nothing below admin, or from a read-only viewer, and Not now writes nothing anywhere", async () => {
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

  it("turns the voice plugin's own guide off before adding the section, so none gets it twice", async () => {
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
      expect(voiceSets).toEqual([{ on: false }]);
      expect(after.voicePlugin).toBe(false);
      expect(after.folders[0]?.state).toBe("current");
    } finally {
      client.stop();
    }
  });
});
