// Clawtrate's guides as a marked section in a bot's AGENTS.md (#532, #544, #628, #795): render,
// find and keep current; each bot's state; Clawtrate's own pass, with nothing asked and no
// switch; and the client's guards. The gateway's half is the guide checks of `pnpm scenarios`
// (guide-checks.ts).
import { describe, expect, it, vi } from "vitest";
import { sha256Hex, utf8Bytes } from "../src/bytes.ts";
import { VOICE_GUIDE, WHERE_GUIDE } from "../src/guide-text.ts";
import {
  findSection,
  GUIDES_LONG_CHARS,
  GUIDES_NOTICE,
  GUIDES_PINNED_SHA256,
  GUIDES_SECTION,
  GUIDES_TEXT,
  GUIDES_VERSION,
  guidesLimit,
  guidesWouldBeCut,
  keepGuidesCurrent,
  MAX_SECTION_SPAN_CHARS,
  oldGuidesKeys,
  readGuideFolders,
  SECTION_FIRST_LINES,
  SECTION_LAST_LINES,
  withSection,
} from "../src/guides.ts";
import { ADMIN_SCOPES, INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { parseBridgeCommand } from "../src/bridge.ts";
import { agentEvent, openTask } from "./client-harness.ts";
import { GatewayError, memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { ClawtrateClient, CONNECTION_CHANGED } from "../src/client.ts";
import { PUBLISHED_SECTIONS } from "./guides-published.ts";
import { FAST, URL_A } from "./client-harness.ts";

const hash = (text: string) => sha256Hex(utf8Bytes(text));
/** What the section adds to each prompt, with the blank line after it. */
const GUIDES_SIZE = GUIDES_SECTION.length + 1;
const BOT_FILE = "# AGENTS.md\n\nYou help with the house.\n- Be brief.\n";
const END_LINE = "<!-- clawtrate:guides end -->\n";

/** A section of another version, as a build of Clawtrate writes it: its marker's hash matches. */
function sectionOf(version: number, text: string) {
  const inner = `${GUIDES_NOTICE}\n${text}`;
  return `<!-- clawtrate:guides begin v${version} sha256=${hash(inner)} -->\n${inner}${END_LINE}`;
}
const olderSection = (text = "## An older guide\n") => sectionOf(0, text);
/** A section a later build writes, on another of the person's devices. */
const newerSection = (text = "## A newer guide\n") => sectionOf(GUIDES_VERSION + 1, text);
/** This version's section with a person's or a bot's edit inside its markers. */
const edited = (file = BOT_FILE) => withSection(file).replace("Be warm", "Be cold");

/**
 * A gateway's bots and their AGENTS.md, answering agents.list, .files.get, .files.set and
 * config.get. `hidden`: bots whose files are there but that `agents.list` doesn't show this
 * connection.
 */
function fakeFiles(
  files: Record<string, string | null>,
  workspaces: Record<string, string> = {},
  /** The hash of a file's bytes on disk, where they aren't the UTF-8 of its text. */
  bytesHash: Record<string, string> = {},
  /** What `config.get` answers: by default a config that sets no limit; null, a read that fails. */
  config: Record<string, unknown> | null = {},
  hidden: Record<string, string> = {},
) {
  const store = new Map<string, string | null>([
    ...Object.entries(files),
    ...Object.entries(hidden),
  ]);
  const hashOf = (key: string, content: string) => bytesHash[key] ?? hash(content);
  const sets: { agentId: string; content: string }[] = [];
  /** Every file request, by bot. */
  const asked: string[] = [];
  const faults = { conflicts: 0, refuse: new Set<string>(), unavailable: 0 };
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
    if (method === "config.get") {
      if (config === null) throw new Error("config.get failed");
      // As both OpenClaw versions answer it: the file's revision beside the one the gateway applied.
      return { config, hash: "h", valid: true, configRevisionHash: "r1", appliedConfigHash: "r1" };
    }
    asked.push(p.agentId as string);
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
      // The gateway's own refusal, as the protocol client gives it.
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
    throw new Error(`unknown method ${method}`);
  };
  return { request, store, sets, faults, asked };
}

describe("the section", () => {
  it("is the two guides between Clawtrate's markers, says changes inside it are replaced, and is bounded", () => {
    const lines = GUIDES_SECTION.split("\n");
    expect(lines[0]).toMatch(/^<!-- clawtrate:guides begin v3 sha256=[a-f0-9]{64} -->$/);
    expect(lines[1]).toBe(GUIDES_NOTICE);
    expect(GUIDES_NOTICE).toBe(
      "<!-- Added by Clawtrate, which keeps it current. Changes inside this section are replaced, so edit outside it. -->",
    );
    // Nothing to turn off any more, so the section names no setting.
    expect(GUIDES_SECTION).not.toContain("Turn it off");
    expect(GUIDES_SECTION.endsWith(END_LINE)).toBe(true);
    expect(GUIDES_TEXT).toBe(`${VOICE_GUIDE}\n\n${WHERE_GUIDE}`);
    expect(GUIDES_SECTION.split(VOICE_GUIDE)).toHaveLength(2);
    expect(GUIDES_SECTION.split(WHERE_GUIDE)).toHaveLength(2);
    // It is in every run's prompt: bounded.
    expect(GUIDES_SIZE).toBe(3_978);
    expect(GUIDES_SIZE).toBeLessThanOrEqual(4_000);
  });

  it("is added at the top, and every other byte of the file stays as it was", () => {
    for (const before of [
      BOT_FILE,
      "",
      "\n",
      "\nstarts blank",
      "no newline at end",
      "a\r\nb\r\n",
    ]) {
      const added = withSection(before);
      expect(added).toBe(`${GUIDES_SECTION}\n${before}`);
      expect(findSection(added)).toMatchObject({ kind: "ours", current: true, start: 0 });
      // Adding again changes nothing.
      expect(withSection(added)).toBe(added);
    }
    // A byte-order mark stays first: the section goes right after it.
    for (const before of ["\uFEFF# Otto\n", "\uFEFF"]) {
      const added = withSection(before);
      expect(added).toBe(`\uFEFF${GUIDES_SECTION}\n${before.slice(1)}`);
      expect(findSection(added)).toMatchObject({ kind: "ours", current: true, start: 1 });
    }
  });

  it("writes over an older version, or an edit inside its markers, and nothing outside them", () => {
    const below = "\nThe person's own rules.\n- Keep these.\n";
    for (const span of [olderSection(), edited("").slice(0, -1)]) {
      const file = `${span}${below}`;
      expect(withSection(file)).toBe(`${GUIDES_SECTION}${below}`);
      expect(withSection(`\uFEFF${file}`)).toBe(`\uFEFF${GUIDES_SECTION}${below}`);
    }
    expect(findSection(edited())).toMatchObject({ kind: "changed", replaceable: true, start: 0 });
  });

  it("never writes an older version over a newer one, intact or edited", () => {
    // A later build on another device wrote it: this build leaves it, so the two never take turns.
    for (const file of [
      newerSection() + BOT_FILE,
      newerSection().replace("A newer guide", "An edited guide") + BOT_FILE,
    ]) {
      expect(withSection(file)).toBe(file);
      expect(withSection(`\uFEFF${file}`)).toBe(`\uFEFF${file}`);
    }
    expect(findSection(newerSection())).toMatchObject({ kind: "ours", current: true });
    expect(findSection(newerSection().replace("newer", "edited"))).toMatchObject({
      kind: "changed",
      newer: true,
    });
  });

  it("writes nothing to a file whose markers are out of shape, or whose section isn't at the top", () => {
    const shapes = {
      "the end marker deleted": edited().replace(END_LINE, ""),
      "the begin marker deleted": edited().slice(edited().indexOf("\n") + 1),
      "a quoted end marker below": `${edited()}\nTo turn it off:\n\n\`\`\`\n${END_LINE}\`\`\`\n`,
      "a marker in a code block only": `# Mine\n\n\`\`\`\n${END_LINE}\`\`\`\nMore.\n`,
      "an edited pair lower down": `# Mine\n\n${edited()}`,
      "two sections": `${GUIDES_SECTION}\n${GUIDES_SECTION}`,
      "loose markers":
        "<!-- clawtrate:guides begin v1 -->\nhi\n<!-- clawtrate:guides end -->\nrest\n",
      // The bot deleted its end marker, and the person quotes one in a code block lower down:
      // two markers again, the begin at the top.
      "the end marker deleted, and one quoted below": `${edited().replace(END_LINE, "")}# Mine\nmy rules\nTo remove it, delete down to\n\`\`\`\n${END_LINE}\`\`\`\nmy closing rules\n`,
      // Longer than Clawtrate's own text could make it: the span may hold the person's text.
      "a section longer than its bound": withSection(BOT_FILE).replace(
        "Be warm",
        `Be warm${"!".repeat(20_000)}`,
      ),
      // Intact, but moved by a bot or quoted by a person.
      "a section below other text": `# Mine\nmy rules\n\n${GUIDES_SECTION}\nMore.\n`,
      "a quoted section": `# Mine\n\n\`\`\`\n${GUIDES_SECTION}\`\`\`\nMore.\n`,
      "a quoted older section": `# Mine\n\n\`\`\`\n${olderSection()}\`\`\`\nMore.\n`,
    };
    for (const [name, file] of Object.entries(shapes)) {
      expect(findSection(file), name).toMatchObject({ kind: "changed", replaceable: false });
      expect(withSection(file), name).toBe(file);
    }
    // A marker inside other text is not one: only whole lines count.
    expect(findSection("See `<!-- clawtrate:guides begin` in the docs.\n").kind).toBe("none");
  });

  it("writes nothing when it can't tell where its section ends, the person's text below included", () => {
    const rules = "# My own rules\n- Never book anything on Fridays.\n- Ask before spending.\n";
    // The real end marker deleted; the person keeps a literal one further down, in an HTML block.
    const noEnd = edited().replace(END_LINE, "");
    const cases = {
      "a later end marker in a <pre> block": `${noEnd}\n${rules}\n<pre>\n${END_LINE}</pre>\n`,
      "a later end marker on a line of its own": `${noEnd}\n${rules}\n${END_LINE}\nMore of mine.\n`,
      "a quoted end marker, which isn't a marker line": `${noEnd}\n${rules}\n> ${END_LINE}`,
      "a start marker with no end": `${noEnd}\n${rules}`,
      "its first line edited": edited().replace(GUIDES_NOTICE, "<!-- mine now -->") + rules,
      "its last line edited":
        edited().replace("anyone else never does.", "anyone else does.") + rules,
    };
    for (const [name, file] of Object.entries(cases)) {
      expect(findSection(file), name).toMatchObject({ kind: "changed", replaceable: false });
      expect(withSection(file), name).toBe(file);
      expect(file.endsWith(rules) || file.includes(rules), name).toBe(true);
    }
    // Edited in its middle, with its own first and last lines: Clawtrate's, and written over.
    expect(findSection(edited() + rules)).toMatchObject({ kind: "changed", replaceable: true });
    expect(withSection(edited() + rules)).toBe(`${GUIDES_SECTION}\n${BOT_FILE}${rules}`);
  });

  it("knows the first and last line of every section a build has written", () => {
    for (const section of [GUIDES_SECTION, ...PUBLISHED_SECTIONS.map((each) => each.section)]) {
      const inner = section.split("\n").slice(1, -2);
      expect(SECTION_FIRST_LINES).toContain(inner[0]);
      expect(SECTION_LAST_LINES).toContain(inner.at(-1));
    }
  });

  it("pins the text to its version: changing the text means a new version", () => {
    expect(GUIDES_SECTION.split("\n")[0]).toMatch(
      new RegExp(
        `^<!-- clawtrate:guides begin v${GUIDES_VERSION} sha256=${GUIDES_PINNED_SHA256}[a-f0-9]{48} -->$`,
      ),
    );
    expect(GUIDES_VERSION).toBe(3);
  });
});

describe("the bots' states", () => {
  it("reads each folder once: current, behind (none, older or edited) or unclear", async () => {
    const { request, asked } = fakeFiles(
      {
        pip: withSection(BOT_FILE),
        marlow: edited(),
        otto: olderSection() + BOT_FILE,
        juniper: BOT_FILE,
        main: `# Mine\n\n${GUIDES_SECTION}`,
        newer: newerSection().replace("newer", "edited") + BOT_FILE,
        shared: null,
      },
      { shared: "pip" },
    );
    const folders = await readGuideFolders(request);
    expect(Object.fromEntries(folders.map((f) => [f.bots.join("+"), f.state]))).toEqual({
      "pip+shared": "current",
      marlow: "behind",
      otto: "behind",
      juniper: "behind",
      main: "unclear",
      // A newer build's to keep.
      newer: "current",
    });
    expect(asked.filter((bot) => bot === "pip" || bot === "shared")).toEqual(["pip"]);
  });

  it("says a file couldn't be read rather than guess its state", async () => {
    const folders = await readGuideFolders(async (method) => {
      if (method === "agents.list") return { agents: [{ id: "pip", workspace: "/w/pip" }] };
      throw new Error("missing scope: operator.read");
    });
    expect(folders).toEqual([
      {
        bots: ["pip"],
        state: null,
        long: false,
        utf8: true,
        missing: false,
        error: "missing scope: operator.read",
      },
    ]);
  });
});

describe("keeping the section current", () => {
  it("adds it to every folder once, a shared folder's included, and leaves the current ones", async () => {
    const files = fakeFiles(
      { pip: BOT_FILE, shared: BOT_FILE, otto: withSection(BOT_FILE) },
      { shared: "pip" },
    );
    expect(await keepGuidesCurrent(files.request)).toEqual({
      errors: [],
      wrote: true,
      missing: [],
    });
    expect(files.sets.map((set) => set.agentId)).toEqual(["pip"]);
    expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
    // Again: nothing left to write.
    await keepGuidesCurrent(files.request);
    expect(files.sets).toHaveLength(1);
    // `bot` keeps it to that bot's folder.
    const one = fakeFiles({ pip: BOT_FILE, otto: BOT_FILE });
    await keepGuidesCurrent(one.request, "otto");
    expect(one.sets.map((set) => set.agentId)).toEqual(["otto"]);
  });

  it("adds it again where someone took it out, and writes over an edit inside its markers", async () => {
    const below = "\n# The person's own\n- Keep this line.\n";
    const files = fakeFiles({ pip: BOT_FILE, otto: `${edited("").slice(0, -1)}${below}` });
    await keepGuidesCurrent(files.request);
    expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
    // The edit inside is gone; the text after the end marker is byte for byte as it was.
    expect(files.store.get("otto")).toBe(`${GUIDES_SECTION}${below}`);
    // Someone takes Pip's out again, and a bot edits Otto's: the next pass puts both back.
    files.store.set("pip", BOT_FILE);
    files.store.set("otto", files.store.get("otto")!.replace("Be warm", "Be bold"));
    await keepGuidesCurrent(files.request);
    expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
    expect(files.store.get("otto")).toBe(`${GUIDES_SECTION}${below}`);
  });

  it("brings an older version up to date, and leaves this one or a newer one, edited or not", async () => {
    const newer = newerSection() + BOT_FILE;
    const newerEdited = newerSection().replace("newer", "edited") + BOT_FILE;
    const files = fakeFiles({
      otto: olderSection() + BOT_FILE,
      juniper: withSection(BOT_FILE),
      pip: newer,
      marlow: newerEdited,
    });
    await keepGuidesCurrent(files.request);
    expect(files.sets.map((set) => set.agentId)).toEqual(["otto"]);
    expect(files.store.get("pip")).toBe(newer);
    expect(files.store.get("marlow")).toBe(newerEdited);
  });

  it("two devices of different builds don't take turns: each leaves what the newer wrote", async () => {
    // The file as a later build left it, and as this build leaves it, passes after passes.
    const files = fakeFiles({ pip: newerSection() + BOT_FILE });
    for (let pass = 0; pass < 3; pass += 1) await keepGuidesCurrent(files.request);
    expect(files.sets).toEqual([]);
    // An earlier build's section here is brought up to this one once, then left.
    const older = fakeFiles({ pip: olderSection() + BOT_FILE });
    for (let pass = 0; pass < 3; pass += 1) await keepGuidesCurrent(older.request);
    expect(older.sets).toHaveLength(1);
  });

  it("one writer at a time: a write held to a hash another device changed reads again, once", async () => {
    // Another device adds the section between this pass's read and its write.
    const files = fakeFiles({ pip: BOT_FILE });
    let first = true;
    const racing: (method: string, params: unknown) => Promise<unknown> = (method, params) => {
      if (method === "agents.files.set" && first) {
        first = false;
        files.store.set("pip", withSection(BOT_FILE));
      }
      return files.request(method, params);
    };
    expect(await keepGuidesCurrent(racing)).toEqual({ errors: [], wrote: false, missing: [] });
    // The other device's write stands; nothing was written over it.
    expect(files.sets).toEqual([]);
    expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
    // Changed again on the retry: left, and said, until the next occasion.
    const busy = fakeFiles({ pip: BOT_FILE });
    busy.faults.conflicts = 2;
    expect((await keepGuidesCurrent(busy.request)).errors).toEqual([
      "pip: AGENTS.md kept changing while Clawtrate wrote it, so it was left as it is.",
    ]);
    expect(busy.store.get("pip")).toBe(BOT_FILE);
  });

  it("a write that fails is tried once per pass, not in a loop, and again at the next pass", async () => {
    for (const fault of ["refuse", "unavailable"] as const) {
      const files = fakeFiles({ pip: BOT_FILE });
      if (fault === "refuse") files.faults.refuse.add("pip");
      else files.faults.unavailable = 1;
      let writes = 0;
      const counting = (method: string, params: unknown) => {
        if (method === "agents.files.set") writes += 1;
        return files.request(method, params);
      };
      const first = await keepGuidesCurrent(counting);
      expect(writes, fault).toBe(1);
      expect(first.errors, fault).toEqual([
        fault === "refuse"
          ? "pip: Workspace document exceeds its write bound"
          : "pip: Error: Workspace access changed while saving an Agent document",
      ]);
      // Nothing is remembered: the next pass tries again, and writes once the gateway lets it.
      files.faults.refuse.clear();
      await keepGuidesCurrent(counting);
      expect(writes, fault).toBe(2);
      expect(files.store.get("pip"), fault).toBe(withSection(BOT_FILE));
    }
  });

  it("writes nothing for a bot the gateway doesn't list to this connection", async () => {
    const files = fakeFiles({ pip: BOT_FILE }, {}, {}, {}, { secret: BOT_FILE });
    await keepGuidesCurrent(files.request);
    await keepGuidesCurrent(files.request, "secret");
    expect(files.asked).not.toContain("secret");
    expect(files.store.get("secret")).toBe(BOT_FILE);
  });

  it("never makes a file that doesn't exist yet: the gateway makes it on the bot's next run", async () => {
    for (const bot of [undefined, "pip"]) {
      const files = fakeFiles({ pip: null, otto: BOT_FILE });
      const result = await keepGuidesCurrent(files.request, bot);
      expect(files.store.get("pip")).toBeNull();
      expect(result.missing).toEqual(["pip"]);
    }
    const [folder] = await readGuideFolders(fakeFiles({ pip: null }).request);
    expect(folder).toMatchObject({ state: "behind", missing: true });
  });

  it("never writes a file that isn't plain UTF-8, so its bytes are never rewritten", async () => {
    // Latin-1 "café règles": the gateway gives the text with U+FFFD and the hash of the bytes.
    const bytes = Uint8Array.from([...`# Otto\ncaf\xe9 r\xe8gles\n`].map((c) => c.charCodeAt(0)));
    const text = "# Otto\ncaf� r�gles\n";
    for (const content of [text, olderSection() + text, edited(text)]) {
      const files = fakeFiles({ otto: content }, {}, { otto: sha256Hex(bytes) });
      expect(await keepGuidesCurrent(files.request)).toEqual({
        errors: [],
        wrote: false,
        missing: [],
      });
      expect(files.sets).toEqual([]);
      const [folder] = await readGuideFolders(files.request);
      expect(folder).toMatchObject({ utf8: false, error: null });
    }
  });

  it("writes nothing to a file whose markers are out of shape, or whose section moved", async () => {
    for (const file of [
      `${edited().replace(END_LINE, "")}\n# Mine\n- keep\n\n<pre>\n${END_LINE}</pre>\n`,
      edited().replace(END_LINE, ""),
      `# Mine\nmy rules\n\n${GUIDES_SECTION}\nMore.\n`,
      `# Mine\n\n\`\`\`\n${olderSection()}\`\`\`\nMore.\n`,
    ]) {
      const files = fakeFiles({ pip: file });
      await keepGuidesCurrent(files.request);
      expect(files.sets).toEqual([]);
      expect((await readGuideFolders(files.request))[0]?.state).toBe("unclear");
    }
  });
});

describe("the gateway's length limit", () => {
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

  it("never grows a file past the gateway's limit, an older or edited section's span included", async () => {
    const long = `# Pip\n${"x".repeat(GUIDES_LONG_CHARS - GUIDES_SIZE)}\n`;
    // Exactly at the limit once added, measured without trailing whitespace, as the gateway does.
    const edge = `# Pip\n${"x".repeat(GUIDES_LONG_CHARS - GUIDES_SIZE - 6)}\n\n\n\n`;
    // An older section is measured with its own span replaced, not with a second section.
    const olderNearLimit = `${olderSection("## Old\n")}${"y".repeat(GUIDES_LONG_CHARS - GUIDES_SIZE - 10)}\n`;
    const files = fakeFiles({ pip: long, otto: BOT_FILE, juniper: edge, marlow: olderNearLimit });
    const folders = await readGuideFolders(files.request);
    expect(folders.map((f) => [f.bots[0], f.long])).toEqual([
      ["pip", true],
      ["otto", false],
      ["juniper", false],
      ["marlow", false],
    ]);
    for (const content of [long, olderSection("## Old\n") + long])
      for (const bot of [undefined, "pip"]) {
        const files = fakeFiles({ pip: content });
        await keepGuidesCurrent(files.request, bot);
        expect(files.sets).toEqual([]);
      }
    // A lowered limit counts: 8,000 characters fit 10,000 whole; with the section they wouldn't.
    const file = `# Pip\n${"x".repeat(8_000)}\n`;
    const config = { agents: { defaults: { bootstrapMaxChars: 10_000 } } };
    const lowered = fakeFiles({ pip: file }, {}, {}, config);
    await keepGuidesCurrent(lowered.request);
    expect(lowered.sets).toEqual([]);
    expect((await readGuideFolders(lowered.request))[0]?.long).toBe(true);
    // At the default limit it fits, and is written.
    const plain = fakeFiles({ pip: file });
    await keepGuidesCurrent(plain.request);
    expect(plain.sets).toHaveLength(1);
  });

  it("writes nothing while the limit can't be read, and writes at the next occasion", async () => {
    const files = fakeFiles({ pip: BOT_FILE, otto: olderSection() + BOT_FILE }, {}, {}, null);
    await keepGuidesCurrent(files.request);
    expect(files.sets).toEqual([]);
    const later = fakeFiles({ pip: BOT_FILE }, {}, {}, {});
    await keepGuidesCurrent(later.request);
    expect(later.store.get("pip")).toBe(withSection(BOT_FILE));
  });

  it("writes nothing while the gateway's settings file is invalid or not yet applied, as its answer says", async () => {
    // 9,500 characters fit a gateway limit of 10,000 whole; with the section they wouldn't.
    const long = `# Pip\n${"x".repeat(9_500)}\n`;
    const answers: [string, Record<string, unknown>, number][] = [
      // An invalid file reads every setting unset: its limit would read 20,000 though it may be lower.
      [
        "invalid",
        { valid: false, config: {}, issues: [], configRevisionHash: null, appliedConfigHash: "r1" },
        0,
      ],
      [
        "applied",
        { valid: true, config: {}, configRevisionHash: "r2", appliedConfigHash: "r2" },
        1,
      ],
      [
        "not applied yet",
        { valid: true, config: {}, configRevisionHash: "r2", appliedConfigHash: "r1" },
        0,
      ],
      [
        "no applied revision",
        { valid: true, config: {}, configRevisionHash: "r2", appliedConfigHash: null },
        0,
      ],
      ["no revisions", { valid: true, config: {} }, 0],
    ];
    for (const [name, fields, written] of answers) {
      const files = fakeFiles({ pip: long });
      const request: (method: string, params: unknown) => Promise<unknown> = (method, params) =>
        method === "config.get"
          ? Promise.resolve({ hash: "h", ...fields })
          : files.request(method, params);
      await keepGuidesCurrent(request);
      expect(files.sets, name).toHaveLength(written);
    }
  });

  it("takes a folder's limit only when the config names no bot this connection isn't shown", async () => {
    // Otto shares Pip's folder, with a lower limit, and the gateway doesn't list him here.
    const file = `# Pip\n${"x".repeat(9_500)}\n`;
    const hidden = { agents: { list: [{ id: "pip" }, { id: "otto", bootstrapMaxChars: 10_000 }] } };
    const files = fakeFiles({ pip: file }, {}, {}, hidden);
    await keepGuidesCurrent(files.request);
    expect(files.sets).toEqual([]);
    // Every bot the config names is listed: the folder's limit is theirs, and it fits.
    const all = fakeFiles({ pip: file }, {}, {}, { agents: { list: [{ id: "Pip" }] } });
    await keepGuidesCurrent(all.request);
    expect(all.sets).toHaveLength(1);
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
    // A gateway error the files give goes out as the gateway's own frame, with its code.
    for (const method of ["agents.list", "agents.files.get", "agents.files.set", "config.get"])
      gateway.handlers[method] = (params) =>
        files.request(method, params).catch((error: unknown) => {
          if (error instanceof GatewayProtocolRequestError)
            throw new GatewayError({ code: error.gatewayCode, message: error.message });
          throw error;
        });
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gw-a" });
    return gateway;
  };
  type Client = Awaited<ReturnType<typeof openTask>>["client"];
  /** Connect again, wait until Clawtrate's own change after it has finished, and read. */
  const reconnect = async (client: Client, gateway: { dropAll(): void }) => {
    const spy = vi.spyOn(client as unknown as { keepGuides: () => Promise<void> }, "keepGuides");
    const was = client.state.connection.connectedAt;
    const decided = spy.mock.results.length;
    gateway.dropAll();
    await until(
      () =>
        client.state.connection.status === "connected" &&
        client.state.connection.connectedAt !== was,
    );
    await until(() => spy.mock.results.length > decided);
    await spy.mock.results.at(-1)?.value;
    spy.mockRestore();
    return client.readBotGuides();
  };

  it("on a connect with admin access, keeps every bot's section current, with no call from the screen", async () => {
    const files = fakeFiles(
      { pip: BOT_FILE, otto: null, shared: BOT_FILE, marlow: edited() },
      { shared: "pip" },
    );
    const { client, gateway } = await openTask({ storage: adminStorage() });
    withFiles(gateway, files);
    try {
      const read = await reconnect(client, gateway);
      expect(read.folders.map((f) => [f.bots.join("+"), f.state, f.missing])).toEqual([
        ["pip+shared", "current", false],
        // Otto's file doesn't exist yet: the gateway makes it on Otto's next run, so it's left.
        ["otto", "behind", true],
        ["marlow", "current", false],
      ]);
      expect(files.store.get("otto")).toBeNull();
      expect(files.sets.map((set) => set.agentId)).toEqual(["pip", "marlow"]);
      // Someone takes Pip's out: the next connect puts it back, and only it.
      files.store.set("pip", BOT_FILE);
      await reconnect(client, gateway);
      expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
      expect(files.sets.map((set) => set.agentId)).toEqual(["pip", "marlow", "pip"]);
    } finally {
      client.stop();
    }
  });

  it("a device that had turned the switch off gets the section on its first connect, and forgets the switch", async () => {
    const storage = adminStorage();
    // What builds before #795 kept: off for this gateway, and off for gateways it hadn't seen.
    for (const key of oldGuidesKeys("gw-a"))
      await storage.set(key, JSON.stringify({ on: false, bots: [] }));
    const files = fakeFiles({ pip: BOT_FILE });
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    try {
      await reconnect(client, gateway);
      expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
      await until(() => oldGuidesKeys("gw-a").every((key) => !storage.data.has(key)));
    } finally {
      client.stop();
    }
  });

  it("writes nothing below admin, or from a read-only viewer, and takes no change from a viewer", async () => {
    for (const options of [
      { held: INTERACTIVE_SCOPES },
      { storage: adminStorage(), client: { readOnly: true } },
    ]) {
      const files = fakeFiles({ pip: BOT_FILE, otto: olderSection() + BOT_FILE });
      const { client, gateway } = await openTask(options);
      withFiles(gateway, files);
      try {
        const shown = await reconnect(client, gateway);
        expect(shown.folders.map((f) => f.state)).toEqual(["behind", "behind"]);
        expect(files.sets).toEqual([]);
      } finally {
        client.stop();
      }
    }
    // There is no switch: a viewer of an earlier build asking to change the guides is refused.
    for (const change of [
      { action: "switch", on: false },
      { action: "add", bots: ["pip"] },
      { action: "replace", bot: "pip", shown: "" },
      { action: "remove", bots: ["pip"] },
    ])
      expect(() =>
        parseBridgeCommand({
          type: "changeBotGuides",
          change,
          stamp: { gatewayId: "gw-a", target: 1 },
        }),
      ).toThrow();
  });

  it("adds the section to a file the gateway made after a run ended, once per bot per connection", async () => {
    const files = fakeFiles({ pip: BOT_FILE, otto: null });
    const { client, gateway } = await openTask({ storage: adminStorage() });
    withFiles(gateway, files);
    const endRun = (run: string) =>
      gateway.emit("agent", agentEvent(run, 1, "lifecycle", { phase: "end" }, "agent:otto:main"));
    const ottoReads = () => files.asked.filter((bot) => bot === "otto").length;
    try {
      await reconnect(client, gateway);
      expect(files.store.get("otto")).toBeNull();
      // Otto's run ends before the gateway made the file: read once, still missing, left.
      const reads = ottoReads();
      endRun("run-1");
      await until(() => ottoReads() > reads);
      await client.readBotGuides();
      expect(files.store.get("otto")).toBeNull();
      // The gateway made it on that run; another run's end doesn't read it again here.
      files.store.set("otto", "# Otto's template\n");
      const after = ottoReads();
      endRun("run-2");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(ottoReads()).toBe(after);
      // The next connect reads it again, and adds the section to the gateway's own file.
      await reconnect(client, gateway);
      expect(files.store.get("otto")).toBe(withSection("# Otto's template\n"));
    } finally {
      client.stop();
    }
  });

  it("adds the section to a file the gateway made once a run of the bot ends, with no reconnect", async () => {
    const files = fakeFiles({ otto: null });
    const { client, gateway } = await openTask({ storage: adminStorage() });
    withFiles(gateway, files);
    try {
      await reconnect(client, gateway);
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

  it("adds the section to a bot made outside Clawtrate while the app is open, with no reconnect", async () => {
    const listed: Record<string, string | null> = { pip: withSection(BOT_FILE) };
    const files = fakeFiles(listed);
    const { client, gateway } = await openTask({ storage: adminStorage() });
    withFiles(gateway, files);
    try {
      await reconnect(client, gateway);
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

  it("a read made while the change after a connect runs shows what that change leaves", async () => {
    const files = fakeFiles({ pip: BOT_FILE });
    const { client, gateway } = await openTask({ storage: adminStorage() });
    withFiles(gateway, files);
    // The change's write waits until the read has been asked for.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const set = gateway.handlers["agents.files.set"]!;
    gateway.handlers["agents.files.set"] = async (params) => {
      await held;
      return set(params);
    };
    try {
      const was = client.state.connection.connectedAt;
      gateway.dropAll();
      await until(
        () =>
          client.state.connection.status === "connected" &&
          client.state.connection.connectedAt !== was,
      );
      await until(() => files.asked.includes("pip"));
      const read = client.readBotGuides();
      release();
      expect((await read).folders[0]?.state).toBe("current");
    } finally {
      client.stop();
    }
  });

  it("a Settings read whose connection changes on the way reads nothing more on the new one", async () => {
    const files = fakeFiles({ pip: BOT_FILE, otto: BOT_FILE });
    const { client, gateway } = await openTask({ storage: adminStorage() });
    withFiles(gateway, files);
    try {
      await reconnect(client, gateway);
      // The connection changes while the gateway's limit is read, between the list and the files.
      const config = gateway.handlers["config.get"]!;
      let once = true;
      gateway.handlers["config.get"] = async (params) => {
        if (once) {
          once = false;
          const was = client.state.connection.connectedAt;
          gateway.dropAll();
          await until(
            () =>
              client.state.connection.status === "connected" &&
              client.state.connection.connectedAt !== was,
          );
          // The new connection's own change after its connect is done before the files are asked.
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
        return config(params);
      };
      const asked = files.asked.length;
      const read = await client.readBotGuides();
      // Without the binding, it would read the files on the new connection and show them as this one's.
      expect(read.stamp.gatewayId).toBeNull();
      expect(read.folders.every((f) => f.error === CONNECTION_CHANGED)).toBe(true);
      expect(files.asked.slice(asked).length).toBeLessThanOrEqual(2);
    } finally {
      client.stop();
    }
  });

  it("the app opened again keeps the section current as well", async () => {
    const storage = adminStorage();
    const files = fakeFiles({ pip: BOT_FILE });
    const { client, gateway } = await openTask({ storage });
    withFiles(gateway, files);
    await reconnect(client, gateway);
    client.stop();
    files.store.set("pip", edited());
    const reopened = new ClawtrateClient(testHost(gateway, storage), FAST);
    await reopened.start();
    try {
      await until(() => reopened.state.connection.status === "connected");
      await reconnect(reopened, gateway);
      expect(files.store.get("pip")).toBe(withSection(BOT_FILE));
    } finally {
      reopened.stop();
    }
  });
});

// Every section a released build wrote (guides-published.ts) reads as Clawtrate's own and older,
// so it is brought up to date by itself under the same rules as any write.
describe("the sections earlier builds wrote", () => {
  it("each is pinned, of a lower version, and reads as Clawtrate's own, unedited and older", () => {
    expect(PUBLISHED_SECTIONS.map((each) => each.version)).toEqual([1, 2]);
    for (const { version, pin, section } of PUBLISHED_SECTIONS) {
      expect(section.split("\n")[0]).toMatch(
        new RegExp(`^<!-- clawtrate:guides begin v${version} sha256=${pin}[a-f0-9]{48} -->$`),
      );
      expect(version).toBeLessThan(GUIDES_VERSION);
      expect(findSection(section + BOT_FILE)).toMatchObject({ kind: "ours", current: false });
    }
  });

  it("version 3 changes only the notice: it names no switch, and says edits inside are replaced", () => {
    const v2 = PUBLISHED_SECTIONS.find((each) => each.version === 2)!.section;
    const body = (section: string) => section.slice(section.indexOf("## How you talk"));
    expect(body(v2)).toBe(body(GUIDES_SECTION));
    expect(v2).toContain("Turn it off in Clawtrate: Settings, Conversation.");
    expect(GUIDES_SECTION.length - v2.length).toBe(12);
    // Written over only within its bound, and a file with only the section is far from the cut.
    expect(GUIDES_SECTION.length).toBeLessThanOrEqual(MAX_SECTION_SPAN_CHARS);
    expect(guidesWouldBeCut(withSection(""), GUIDES_LONG_CHARS)).toBe(false);
  });

  it("an unedited one is brought up to date, and nothing else in the file changes", async () => {
    for (const { section } of PUBLISHED_SECTIONS)
      for (const below of [`\n${BOT_FILE}`, "\n", ""]) {
        const files = fakeFiles({ pip: section + below });
        expect((await readGuideFolders(files.request))[0]?.state).toBe("behind");
        expect((await keepGuidesCurrent(files.request)).errors).toEqual([]);
        expect(files.store.get("pip")).toBe(GUIDES_SECTION + below);
        expect((await readGuideFolders(files.request))[0]?.state).toBe("current");
      }
  });

  it("an edited one is written over too, and nothing outside it changes", async () => {
    for (const { section } of PUBLISHED_SECTIONS) {
      const files = fakeFiles({ pip: `${section.replace("Be warm", "Be warmer")}\n${BOT_FILE}` });
      await keepGuidesCurrent(files.request);
      expect(files.store.get("pip")).toBe(`${GUIDES_SECTION}\n${BOT_FILE}`);
    }
  });

  it("one waits while the gateway's limit can't be read, as any write does", async () => {
    for (const { section } of PUBLISHED_SECTIONS) {
      const files = fakeFiles({ pip: `${section}\n${BOT_FILE}` }, {}, {}, null);
      await keepGuidesCurrent(files.request);
      expect(files.sets).toEqual([]);
    }
  });
});
