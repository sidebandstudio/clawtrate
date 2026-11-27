// A file a bot hands over in the iPhone chat (F-115): where its row goes among the chat's rows,
// what the row says in each state, and Save, which reads the file through core for the gateway
// whose history drew the row and offers it in the share sheet from a folder of its own that is
// deleted afterwards. Core's read runs here through a client and its bridge session, as the app
// runs them, over the iOS host's fetch with a stand-in for its native module. The sheet itself
// opens only on a device: the Simulator check covers it (simulator/ios.test.ts).

import {
  ClawtrateClient,
  cleanFileName,
  createBridgeSession,
  MAX_CHAT_FILE_BYTES,
  type BridgeCommand,
  type BridgeResultFor,
  type ChatFile,
  type ClawtrateState,
  type ConnectionState,
  type Task,
  type TranscriptItem,
} from "@clawtrate/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// Core keeps its refusal to itself (not in its index): read where it is written.
import { FILE_FROM_ANOTHER_GATEWAY } from "../../../packages/core/src/client.ts";
import { FAST, grantingGateway, KEY } from "../../../packages/core/test/client-harness.ts";
import {
  memoryStorage,
  testHost,
  tokenKey,
  until,
} from "../../../packages/core/test/fake-gateway.ts";
import { shownStamp, type ShownStamp } from "../../../packages/ui/src/stamp.ts";
import { historyStamps, saveBotFile } from "../src/bot-files.ts";
import { createHostFetch, type NativeFetch } from "../src/host/fetch.ts";
import {
  createShareFile,
  SAVE_TO_FILES,
  SHARE_WORDS,
  type ShareFile,
  type ShareSystem,
} from "../src/host/share.ts";
import {
  BOT_FILE_WORDS as W,
  botFileView,
  canLoadFiles,
  type BotFilePhase,
} from "../src/presentation/bot-files.ts";
import { chatRows } from "../src/transcript.ts";

const PROTECTED = "wss://gateway.example";
const PDF = "artifact_managed_media_470797d5-f45d-444a-901d-21a6bd2c2f96";
const NOTES = "artifact_managed_media_dcdee85c-5f62-4293-9cc5-68c53084eba3";
const ROW = "d2659f35-1bb5-4140-bdd5-53d9ea49d1da";
const TEXT = "Both reviews are in this two-page draft.";
const outgoing = (artifactId: string) =>
  `/api/chat/media/outgoing/${encodeURIComponent(KEY)}/${artifactId.slice(-36)}/full`;
/** A download in OpenClaw 2026.11.10's form: a grant's UUID, an encoded slash, 43 characters. Made up. */
const GRANT = `${outgoing(PDF)}?mediaTicket=6f1c2a9e-3b7d-4e58-a0c4-9d2e81f7b630%2FQm9vay1yZXZpZXdzLWdyYW50LXRva2VuLWZvci10ZXM`;
const BYTES = Uint8Array.from("%PDF-1.4\nthe two reviews\n%%EOF\n", (char) => char.charCodeAt(0));

const attachment = (artifactId: string, label: string, mimeType: string, sizeBytes: number) => ({
  type: "attachment",
  attachment: {
    artifactId,
    url: outgoing(artifactId),
    kind: "document",
    label,
    mimeType,
    sizeBytes,
  },
});

/** The person's ask and the bot's answer, its text and files in one row, as the gateway gives them. */
const history = (files: unknown[]) => [
  { role: "user", content: "#attach", __openclaw: { id: "u1", seq: 1 } },
  {
    role: "assistant",
    content: [{ type: "text", text: TEXT }, ...files],
    model: "dev-1",
    stopReason: "stop",
    __openclaw: { runId: "probe-attach", id: ROW, seq: 2 },
  },
];

const TASK: Task = {
  key: KEY,
  botId: "otto",
  sessionId: null,
  title: "Reviews",
  preview: null,
  updatedAt: null,
  status: "idle",
  unread: false,
};
const LINK = { connected: true, closed: false };

const file = (over: Partial<ChatFile> = {}): ChatFile => ({
  artifactId: PDF,
  name: "reviews-draft.pdf",
  mimeType: "application/pdf",
  sizeBytes: 861,
  ...over,
});

/** A stand-in for the native fetch: records each address it is asked for and answers with `body`. */
function fakeNative(body: Uint8Array = BYTES) {
  const started: string[] = [];
  const left = new Map<string, Uint8Array[]>();
  const native: NativeFetch = {
    async start(id, url) {
      started.push(url);
      left.set(id, body.length === 0 ? [] : [body]);
      return { status: 200, headers: { "content-type": "application/pdf" } };
    },
    async read(id) {
      return left.get(id)?.shift() ?? null;
    },
    async cancel(id) {
      left.delete(id);
    },
  };
  return { native, started };
}

/** The iPhone's client at a protected address, the task open, its history with the bot's files. */
async function iphone(
  native: NativeFetch,
  files: unknown[] = [attachment(PDF, "reviews-draft.pdf", "application/pdf", 861)],
) {
  const gateway = grantingGateway();
  gateway.handlers["chat.history"] = () => ({ messages: history(files) });
  gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gateway-1" });
  gateway.handlers["artifacts.download"] = () => ({
    url: GRANT,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
  const storage = memoryStorage({
    connection: JSON.stringify({ url: PROTECTED, token: null }),
    [tokenKey(PROTECTED)]: JSON.stringify({
      token: "device-token",
      grantedScopes: ["operator.read"],
      heldScopes: ["operator.read"],
    }),
  });
  const client = new ClawtrateClient(
    { ...testHost(gateway, storage), fetch: createHostFetch(native) },
    { ...FAST, readOnly: true },
  );
  const session = createBridgeSession(client);
  const source = { getState: client.store.get, subscribe: client.store.subscribe };
  const reads = historyStamps(source);
  await client.start();
  await until(() => client.state.discovery.status === "ready");
  await session.apply({ type: "openSession", key: KEY });
  await until(() => client.state.transcripts[KEY]?.status === "ready");
  await until(() => client.state.connection.gatewayId === "gateway-1");
  const send = <C extends BridgeCommand>(command: C) => session.apply(command);
  return { client, gateway, send, source, reads };
}

/** A share sheet that records what it was given and closes as `closes` says. */
function sheetThatCloses(closes: "saved" | "shared" | "dismissed" = "saved") {
  const offered: Array<{ name: string; bytes: Uint8Array }> = [];
  const share: ShareFile = async (name, bytes) => {
    offered.push({ name, bytes });
    return closes;
  };
  return { share, offered };
}

describe("F-115: a bot's file among the iPhone chat's rows", () => {
  it("F-115: the files go under the bot's message that carried them, in their order, and the text stays the bot's bubble", async () => {
    const { client } = await iphone(fakeNative().native, [
      attachment(PDF, "reviews-draft.pdf", "application/pdf", 861),
      attachment(NOTES, "reviews.txt", "text/plain", 55),
    ]);
    const rows = chatRows(TASK, client.state.transcripts[KEY]!, "Otto", Date.now(), LINK);
    const at = rows.findIndex((row) => row.kind === "bot" && row.text === TEXT);
    expect(at).toBeGreaterThan(-1);
    expect(rows[at + 1]).toEqual({
      kind: "files",
      id: expect.any(String),
      files: [
        expect.objectContaining({ artifactId: PDF, name: "reviews-draft.pdf", sizeBytes: 861 }),
        expect.objectContaining({ artifactId: NOTES, name: "reviews.txt", sizeBytes: 55 }),
      ],
    });
    expect(rows.filter((row) => row.kind === "files")).toHaveLength(1);
    client.stop();
  });

  it("F-115: a file of a row with no bubble here goes at the end of the turn; a turn with none has no file row", () => {
    const item = (over: Partial<TranscriptItem>): TranscriptItem =>
      ({
        id: "a1",
        role: "assistant",
        timestamp: null,
        blocks: [{ kind: "text", text: "Here it is.", messageId: "row-1" }],
        ...over,
      }) as TranscriptItem;
    const transcript = (items: TranscriptItem[]) =>
      ({
        status: "ready",
        items,
        runs: [],
        hasMore: false,
      }) as unknown as Parameters<typeof chatRows>[1];
    const elsewhere = file({ messageId: "row-9" });
    const rows = chatRows(TASK, transcript([item({ files: [elsewhere] })]), "Otto", 0, LINK);
    expect(rows.map((row) => row.kind)).toEqual(["bot", "files"]);
    expect(chatRows(TASK, transcript([item({})]), "Otto", 0, LINK).map((row) => row.kind)).toEqual([
      "bot",
    ]);
  });
});

describe("F-115: what a bot's file row says on iPhone", () => {
  const view = (phase: BotFilePhase, over: Partial<ChatFile> = {}, canLoad = true) =>
    botFileView(file(over), phase, canLoad);

  it("F-115: before Save, it offers Save and says nothing; while reading it says so and a second press does nothing", () => {
    expect(view({ status: "ready" })).toEqual({
      state: "ready",
      note: null,
      action: "save",
      busy: false,
    });
    expect(view({ status: "reading" })).toEqual({
      state: "reading",
      note: W.reading,
      action: "save",
      busy: true,
    });
    // The sheet says the rest while it is open.
    expect(view({ status: "sharing" })).toMatchObject({ note: null, busy: true });
  });

  it("F-115: once the sheet closed it says where the file went, and Save stays to save it again", () => {
    expect(view({ status: "saved" })).toMatchObject({ note: W.saved, action: "save", busy: false });
    expect(view({ status: "shared" })).toMatchObject({ note: W.shared, action: "save" });
  });

  it("F-115: a failed read says why in core's words and offers Try again", () => {
    expect(view({ status: "failed", message: FILE_FROM_ANOTHER_GATEWAY })).toEqual({
      state: "failed",
      note: `Couldn't save it. ${FILE_FROM_ANOTHER_GATEWAY}`,
      action: "try-again",
      busy: false,
    });
  });

  it("F-115: a file the gateway didn't hand over, a recording without an id, and one too large keep their row with no button", () => {
    expect(view({ status: "ready" }, { artifactId: null })).toEqual({
      state: "unreadable",
      note: W.unreadable,
      action: null,
      busy: false,
    });
    expect(
      view({ status: "ready" }, { artifactId: null, name: "voice.m4a", mimeType: "audio/mp4" }),
    ).toMatchObject({ state: "unreadable", action: null });
    expect(view({ status: "ready" }, { sizeBytes: MAX_CHAT_FILE_BYTES + 1 })).toMatchObject({
      state: "too-large",
      note: W.tooLarge,
      action: null,
    });
    expect(view({ status: "ready" }, { sizeBytes: MAX_CHAT_FILE_BYTES })).toMatchObject({
      state: "ready",
    });
    // Too large by the bytes the gateway sent, though its size said otherwise.
    expect(view({ status: "too-large" })).toMatchObject({ state: "too-large", action: null });
  });

  it("F-115: at an address that isn't https, it says this connection can't load it and what can", () => {
    expect(view({ status: "ready" }, {}, false)).toEqual({
      state: "cannot-load",
      note: W.cannotLoad,
      action: null,
      busy: false,
    });
    expect(canLoadFiles("wss://gateway.example")).toBe(true);
    for (const url of ["ws://127.0.0.1:18789", "ws://gateway.example", "", null])
      expect(canLoadFiles(url)).toBe(false);
  });

  it("F-115: says what the desktop says where both do the same", () => {
    const desktop = readFileSync(
      join(import.meta.dirname, "../../../packages/ui/src/BotFiles.tsx"),
      "utf8",
    );
    expect(desktop).toContain(JSON.stringify(W.unreadable));
    expect(desktop).toContain("`Too large to save here: Clawtrate saves files up to ${LIMIT}.`");
    expect(W.tooLarge).toBe("Too large to save here: Clawtrate saves files up to 5 MB.");
    expect(desktop).toContain("`Couldn't save it. ${phase.message}`");
    expect(W.failed("Why.")).toBe("Couldn't save it. Why.");
    expect(desktop).toContain("aria-label={`Save ${file.name}`}");
  });
});

describe("F-115: Save on iPhone", () => {
  it("F-115: Save reads the file through core for the row's gateway and offers its exact bytes, under its name, in the share sheet; the grant's encoded slash reaches the native fetch as issued", async () => {
    const fake = fakeNative();
    const { client, send, source, reads } = await iphone(fake.native);
    const sheet = sheetThatCloses("saved");
    const phases: BotFilePhase[] = [];
    const drawnOn = reads.of(client.state.transcripts[KEY]!.items);
    expect(drawnOn.gatewayId).toBe("gateway-1");
    await saveBotFile(
      send,
      source,
      drawnOn,
      KEY,
      file(),
      sheet.share,
      (p) => phases.push(p),
      () => false,
    );
    expect(phases).toEqual([{ status: "reading" }, { status: "sharing" }, { status: "saved" }]);
    expect(sheet.offered).toEqual([{ name: "reviews-draft.pdf", bytes: BYTES }]);
    // Byte for byte: `%2F` is neither decoded nor encoded again on its way to the native layer.
    expect(fake.started).toEqual([`https://gateway.example${GRANT}`]);
    expect(fake.started[0]).toContain("%2F");
    client.stop();
  });

  it("F-115: an empty file saves", async () => {
    const fake = fakeNative(new Uint8Array(0));
    const { client, send, source, reads } = await iphone(fake.native);
    const sheet = sheetThatCloses("shared");
    const phases: BotFilePhase[] = [];
    await saveBotFile(
      send,
      source,
      reads.of(client.state.transcripts[KEY]!.items),
      KEY,
      file({ sizeBytes: 0 }),
      sheet.share,
      (p) => phases.push(p),
      () => false,
    );
    expect(phases.at(-1)).toEqual({ status: "shared" });
    expect(sheet.offered.map((each) => each.bytes.length)).toEqual([0]);
    client.stop();
  });

  it("F-115: a row another gateway listed is refused with core's line, and nothing is fetched or offered", async () => {
    const fake = fakeNative();
    const { client, send, source, reads } = await iphone(fake.native);
    const sheet = sheetThatCloses();
    const phases: BotFilePhase[] = [];
    const drawnOn = reads.of(client.state.transcripts[KEY]!.items);
    await saveBotFile(
      send,
      source,
      { ...drawnOn, gatewayId: "gateway-2" },
      KEY,
      file(),
      sheet.share,
      (p) => phases.push(p),
      () => false,
    );
    expect(phases.at(-1)).toEqual({ status: "failed", message: FILE_FROM_ANOTHER_GATEWAY });
    expect(fake.started).toEqual([]);
    expect(sheet.offered).toEqual([]);
    client.stop();
  });

  it("F-115: a closed sheet goes back to ready, and a file the gateway didn't hand over reads nothing", async () => {
    const fake = fakeNative();
    const { client, send, source, reads } = await iphone(fake.native);
    const drawnOn = reads.of(client.state.transcripts[KEY]!.items);
    const phases: BotFilePhase[] = [];
    await saveBotFile(
      send,
      source,
      drawnOn,
      KEY,
      file(),
      sheetThatCloses("dismissed").share,
      (p) => phases.push(p),
      () => false,
    );
    expect(phases.at(-1)).toEqual({ status: "ready" });
    const before = fake.started.length;
    const none: BotFilePhase[] = [];
    await saveBotFile(
      send,
      source,
      drawnOn,
      KEY,
      file({ artifactId: null }),
      sheetThatCloses().share,
      (p) => none.push(p),
      () => false,
    );
    expect(none).toEqual([]);
    expect(fake.started).toHaveLength(before);
    client.stop();
  });
});

describe("F-115: a row that has left the screen", () => {
  type Sent = BridgeCommand;
  const drawnOn: ShownStamp = { gatewayId: "gateway-1", target: 1, connectedAt: 1 };
  const connection = { gatewayId: "gateway-1", target: 1, connectedAt: 1 } as ConnectionState;
  const source = {
    getState: () => ({ connection }) as ClawtrateState,
    subscribe: () => () => {},
  };

  function stubSend(read: BridgeResultFor<Extract<BridgeCommand, { type: "readChatFile" }>>) {
    const sent: Sent[] = [];
    const send = (async (command: BridgeCommand) => {
      sent.push(command);
      if (command.type === "readChatFile") return read;
      if (command.type === "readFileChunk") return { data: "" };
      return undefined;
    }) as <C extends BridgeCommand>(command: C) => Promise<BridgeResultFor<C>>;
    return { send, sent };
  }

  it("F-115: one gone before the read asks for nothing", async () => {
    const { send, sent } = stubSend({ status: "failed", message: "unused" });
    const sheet = sheetThatCloses();
    await saveBotFile(
      send,
      source,
      drawnOn,
      KEY,
      file(),
      sheet.share,
      () => {},
      () => true,
    );
    expect(sent).toEqual([]);
    expect(sheet.offered).toEqual([]);
  });

  it("F-115: one gone while the file was read lets its transfer go and opens no sheet", async () => {
    const { send, sent } = stubSend({
      status: "content",
      mimeType: "application/pdf",
      bytes: 2,
      transfer: { id: "transfer-1", chunks: 2, data: "AA==" },
    });
    let gone = false;
    const sheet = sheetThatCloses();
    const tracking = (async (command: BridgeCommand) => {
      const answer = await send(command);
      if (command.type === "readChatFile") gone = true;
      return answer;
    }) as typeof send;
    await saveBotFile(
      tracking,
      source,
      drawnOn,
      KEY,
      file(),
      sheet.share,
      () => {},
      () => gone,
    );
    expect(sent.map((command) => command.type)).toEqual(["readChatFile", "releaseFile"]);
    expect(sent[1]).toEqual({ type: "releaseFile", id: "transfer-1" });
    expect(sheet.offered).toEqual([]);
  });
});

describe("F-115: which read drew a task's history", () => {
  type Shape = Pick<ConnectionState, "gatewayId" | "target" | "connectedAt">;
  function store(connection: Shape, items: TranscriptItem[]) {
    let state = { connection, transcripts: { [KEY]: { items } } } as unknown as ClawtrateState;
    const listeners = new Set<(s: ClawtrateState) => void>();
    return {
      getState: () => state,
      subscribe: (listener: (s: ClawtrateState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      set(next: { connection?: Shape; items?: TranscriptItem[] }) {
        state = {
          connection: next.connection ?? state.connection,
          transcripts: { [KEY]: { items: next.items ?? state.transcripts[KEY]!.items } },
        } as unknown as ClawtrateState;
        for (const listener of listeners) listener(state);
      },
    };
  }

  it("F-115: a row keeps the stamp of the read that drew it across a reconnect, and takes the new one once history is read again", () => {
    const first: TranscriptItem[] = [];
    const before = { gatewayId: "gateway-1", target: 1, connectedAt: 100 };
    const source = store(before, first);
    const reads = historyStamps(source);
    expect(reads.of(first)).toEqual(shownStamp(before));
    const after = { gatewayId: "gateway-2", target: 2, connectedAt: 200 };
    source.set({ connection: after });
    // Not read again: still the first gateway's, which core then refuses.
    expect(reads.of(first)).toEqual(shownStamp(before));
    const again: TranscriptItem[] = [];
    source.set({ items: again });
    expect(reads.of(again)).toEqual(shownStamp(after));
    // History no read drew is stamped with no connection at all.
    expect(reads.of([]).target).toBe(-1);
    reads.stop();
  });
});

describe("F-115: the share step", () => {
  function fakeSystem(closes: { completed: boolean; activityType: string | null } | "throws") {
    const log: string[] = [];
    let made = 0;
    const system: ShareSystem = {
      clear: () => log.push("clear"),
      folder: () => {
        made += 1;
        const name = `folder-${made}`;
        log.push(`make ${name}`);
        return {
          write: async (file, bytes) => {
            log.push(`write ${name}/${file} ${bytes.length}`);
            return `file:///cache/clawtrate-share/${name}/${encodeURIComponent(file)}`;
          },
          remove: () => log.push(`remove ${name}`),
        };
      },
      sheet: async (uri) => {
        log.push(`sheet ${uri}`);
        if (closes === "throws") throw new Error("no view controller");
        return closes;
      },
    };
    return { system, log };
  }

  it("F-115: the file is written to a folder of its own under core's cleaned name, offered, and deleted once the sheet closes; earlier runs' folders go before the first", async () => {
    const { system, log } = fakeSystem({ completed: true, activityType: SAVE_TO_FILES });
    const share = createShareFile(system);
    const name = `${"a".repeat(300)}.pdf`;
    expect(await share(name, BYTES)).toBe("saved");
    expect(log).toEqual([
      "clear",
      "make folder-1",
      `write folder-1/${cleanFileName(name)} ${BYTES.length}`,
      expect.stringMatching(/^sheet file:\/\/\/cache\/clawtrate-share\/folder-1\//),
      "remove folder-1",
    ]);
    expect(new TextEncoder().encode(cleanFileName(name)).length).toBeLessThanOrEqual(255);
    expect(cleanFileName(name).endsWith(".pdf")).toBe(true);
    // Cleared once a run, not again.
    expect(await share("b.txt", new Uint8Array(0))).toBe("saved");
    expect(log.filter((line) => line === "clear")).toHaveLength(1);
  });

  it("F-115: a cancelled sheet, another activity, or a sheet that didn't open each delete the file", async () => {
    for (const [closes, outcome] of [
      [{ completed: false, activityType: null }, "dismissed"],
      [{ completed: true, activityType: "com.apple.UIKit.activity.AirDrop" }, "shared"],
    ] as const) {
      const { system, log } = fakeSystem(closes);
      expect(await createShareFile(system)("a.pdf", BYTES)).toBe(outcome);
      expect(log.at(-1)).toBe("remove folder-1");
    }
    const { system, log } = fakeSystem("throws");
    await expect(createShareFile(system)("a.pdf", BYTES)).rejects.toThrow(SHARE_WORDS.noSheet);
    expect(log.at(-1)).toBe("remove folder-1");
  });

  it("F-115: a file that can't be written is said plainly, and its folder still goes", async () => {
    const { system, log } = fakeSystem({ completed: true, activityType: null });
    const failing: ShareSystem = {
      ...system,
      folder: () => ({
        ...system.folder(),
        write: async () => {
          throw new Error("ENOSPC");
        },
      }),
    };
    await expect(createShareFile(failing)("a.pdf", BYTES)).rejects.toThrow(SHARE_WORDS.notWritten);
    expect(log.at(-1)).toBe("remove folder-1");
  });
});
