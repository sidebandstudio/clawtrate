// A file a bot handed over that isn't a picture, under its message (F-115):
// the row in each state, what it says, and Save, which reads the file through
// the host and says "Saved" only once the host's save has the bytes.

import type { ChatFile, ChatFileRead, ClawtrateBridge, SaveResult } from "@clawtrate/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BotFiles, fileNote, saveChatFile, type Phase } from "../src/BotFiles.tsx";
import { BridgeProvider } from "../src/bridge.tsx";

const KEY = "agent:pip:reports";
const pdf: ChatFile = {
  artifactId: "artifact_managed_media_pdf",
  name: "reviews-draft.pdf",
  mimeType: "application/pdf",
  sizeBytes: 861,
};
const big: ChatFile = {
  artifactId: "artifact_managed_media_zip",
  name: "trail-photos.zip",
  mimeType: "application/zip",
  sizeBytes: 5_242_881,
};
const refused: ChatFile = {
  artifactId: null,
  name: "blob.bin",
  mimeType: "application/octet-stream",
  sizeBytes: null,
};
/** The gateway the rows were drawn from. */
const SHOWN = { gatewayId: "gateway-a", target: 1, connectedAt: 1 };
const BYTES = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");

function render(files: ChatFile[]) {
  const html = renderToStaticMarkup(
    createElement(BridgeProvider, {
      bridge: {
        getState: () => ({ connection: { gatewayId: "gateway-a", target: 1, connectedAt: 1 } }),
      } as unknown as ClawtrateBridge,
      children: createElement(BotFiles, { taskKey: KEY, files }),
    }),
  );
  return {
    html,
    states: [...html.matchAll(/data-testid="bot-file" data-state="([a-z-]+)"/g)].map((m) => m[1]),
  };
}

/** A host whose read gives `read` and whose save, if it has one, answers `saved`. */
function host(read: ChatFileRead | Error, saved?: SaveResult | Error) {
  const invoked: unknown[] = [];
  const handed: Array<{ name: string; data: Uint8Array }> = [];
  const bridge = {
    invoke: async (command: unknown) => {
      invoked.push(command);
      if (read instanceof Error) throw read;
      return read;
    },
    send: async () => {},
    ...(saved === undefined
      ? {}
      : {
          save: async (file: { name: string; data: ArrayBuffer }) => {
            handed.push({ name: file.name, data: new Uint8Array(file.data) });
            if (saved instanceof Error) throw saved;
            return saved;
          },
        }),
  } as unknown as ClawtrateBridge;
  return { bridge, invoked, handed };
}

const content: ChatFileRead = {
  status: "content",
  mimeType: "application/pdf",
  bytes: BYTES.length,
  transfer: { id: null, chunks: 1, data: Buffer.from(BYTES).toString("base64") },
};

async function phases(bridge: ClawtrateBridge, file = pdf): Promise<Phase[]> {
  const seen: Phase[] = [];
  await saveChatFile(bridge, KEY, file, (phase) => seen.push(phase), SHOWN);
  return seen;
}

describe("F-115: the row of a file a bot handed over", () => {
  it("F-115: shows each file in order with its icon, name, size and type; Save, named with the file, only where it can be saved", () => {
    const { html, states } = render([pdf, big, refused]);
    expect(states).toEqual(["ready", "too-large", "unreadable"]);
    expect(html.indexOf("reviews-draft.pdf")).toBeLessThan(html.indexOf("trail-photos.zip"));
    expect(html).toContain("1 KB · application/pdf");
    expect(html).toContain('aria-label="Save reviews-draft.pdf"');
    expect(html).not.toContain('aria-label="Save trail-photos.zip"');
    expect(html).not.toContain('aria-label="Save blob.bin"');
    expect(html.match(/<svg [^>]*aria-hidden="true"><path d="M4 2.75h5.25/g)).toHaveLength(3);
    expect(html).toContain("Too large to save here: Clawtrate saves files up to 5 MB.");
    expect(html).toContain(
      "The gateway didn&#x27;t hand this file over, so it can&#x27;t be saved.",
    );
    // What it says is in a live region, so it is announced.
    // One live region per row, always there, with one role: the ready row's is empty.
    expect(html.match(/role="status"/g)).toHaveLength(3);
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('<span class="bot-file-note" role="status"></span>');
  });

  it("F-115: a message with no files draws nothing for them", () => {
    expect(render([]).html).toBe("");
  });

  it("F-115: says what each state means", () => {
    expect(fileNote(pdf, { status: "ready" })).toBeNull();
    expect(fileNote(pdf, { status: "saving" })).toBe("Saving…");
    expect(fileNote(pdf, { status: "saved" })).toBe("Saved.");
    expect(fileNote(pdf, { status: "downloaded" })).toBe("Handed to your browser's downloads.");
    expect(fileNote(pdf, { status: "too-large" })).toBe(
      "Too large to save here: Clawtrate saves files up to 5 MB.",
    );
    expect(
      fileNote(pdf, { status: "failed", message: "The gateway answered 404 for this file." }),
    ).toBe("Couldn't save it. The gateway answered 404 for this file.");
  });
});

describe("F-115: Save", () => {
  it("F-115: reads the file by its id, hands its exact bytes to the host's save under its name, and says Saved once the host has", async () => {
    const { bridge, invoked, handed } = host(content, {
      status: "saved",
      name: "reviews-draft.pdf",
    });
    expect(await phases(bridge)).toEqual([{ status: "saving" }, { status: "saved" }]);
    expect(invoked).toEqual([
      {
        type: "readChatFile",
        key: KEY,
        artifactId: "artifact_managed_media_pdf",
        stamp: { gatewayId: "gateway-a", target: 1 },
      },
    ]);
    expect(handed).toEqual([{ name: "reviews-draft.pdf", data: BYTES }]);
  });

  it("F-115: a closed save dialog goes back to ready, and a host that couldn't save is a failure, never Saved", async () => {
    expect(await phases(host(content, { status: "cancelled" }).bridge)).toEqual([
      { status: "saving" },
      { status: "ready" },
    ]);
    const unsaved = await phases(
      host(content, {
        status: "failed",
        message: "The disk is full.",
        target: "unchanged",
      } as SaveResult).bridge,
    );
    expect(unsaved.at(-1)).toEqual({
      status: "failed",
      message: "The disk is full. The file that was there is unchanged.",
    });
    expect((await phases(host(content, new Error("no window")).bridge)).at(-1)).toEqual({
      status: "failed",
      message: "no window",
    });
  });

  it("F-115: a read the gateway refused, one too large, or a lost connection says so", async () => {
    expect(
      (
        await phases(
          host(
            { status: "failed", message: "The gateway answered 404 for this file." },
            { status: "cancelled" },
          ).bridge,
        )
      ).at(-1),
    ).toEqual({ status: "failed", message: "The gateway answered 404 for this file." });
    expect(
      (
        await phases(
          host({ status: "too-large", limit: 5_242_880 }, { status: "cancelled" }).bridge,
        )
      ).at(-1),
    ).toEqual({ status: "too-large" });
    expect(
      (await phases(host(new Error("Not connected"), { status: "cancelled" }).bridge)).at(-1),
    ).toEqual({
      status: "failed",
      message: "Not connected",
    });
  });

  it("F-115: a file the gateway didn't hand over reads nothing", async () => {
    const { bridge, invoked } = host(content, { status: "saved", name: "blob.bin" });
    expect(await phases(bridge, refused)).toEqual([]);
    expect(invoked).toEqual([]);
  });
});
