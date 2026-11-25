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
  GUIDES_LONG_CHARS,
  GUIDES_PINNED_SHA256,
  GUIDES_VERSION,
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
import { createBridgeSession } from "../src/bridge.ts";
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
            : { name: "AGENTS.md", content, hash: hashOf(key, content) },
      };
    if (method === "agents.files.set") {
      const held =
        content === null ? p.expectedMissing === true : p.expectedHash === hashOf(key, content);
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
        length: null,
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
      [withSection(text).replace("Be warm", "Be cold"), { action: "replace", bot: "otto" }],
    ] as [string, GuidesChange][]) {
      const files = fakeFiles({ otto: content }, {}, { otto: sha256Hex(bytes) });
      const result = await applyGuidesChange(files.request, null, change);
      expect(files.sets).toEqual([]);
      expect(result.errors).toEqual([
        "otto: otto's AGENTS.md isn't plain UTF-8 text, so Clawtrate leaves it as it is.",
      ]);
      const [folder] = await readGuideFolders(files.request, null);
      expect(folder).toMatchObject({ state: null, error: expect.stringMatching(/plain UTF-8/) });
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
    };
    for (const [name, file] of Object.entries(shapes)) {
      expect(findSection(file), name).toMatchObject({ kind: "changed", replaceable: false });
      for (const change of [
        { action: "replace", bot: "pip" },
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
    await applyGuidesChange(files.request, null, { action: "replace", bot: "pip" });
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
    const short = BOT_FILE;
    const files = fakeFiles({ pip: long, otto: short });
    const folders = await readGuideFolders(files.request, null);
    expect(folders.map((f) => [f.bots[0], f.length])).toEqual([
      ["pip", long.length],
      ["otto", short.length],
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
});
