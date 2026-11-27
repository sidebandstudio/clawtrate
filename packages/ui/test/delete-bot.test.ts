// The words of Delete bot… (delete-words.ts): whether it is offered, what goes
// and what stays for the box as it is, the shared-folder rule, and a result
// that says only what the gateway's answer and the bot list read after it
// established. Bots and folders are made up.
import {
  confirmMatches,
  confirmTargetOf,
  type BotDeleteOutcome,
  type BotDeleteRead,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import {
  changedLine,
  confirmLabel,
  deletedOnClose,
  deleteLines,
  deleteOffer,
  finalLine,
  folderOption,
  newestOnly,
  LEFT_LINE,
  resultView,
  sharedLine,
} from "../src/bots/delete-words.ts";

const read = (over: Partial<BotDeleteRead> = {}): BotDeleteRead => ({
  stamp: { gatewayId: "gateway-a", target: 1 },
  botId: "pip",
  listed: true,
  main: false,
  name: "Pip",
  nameDigest: "0".repeat(64),
  confirm: { text: "Pip", by: "name" },
  createdAt: 2,
  workspace: "/srv/claw/workspaces/pip",
  folder: "own",
  sharedWith: [],
  sharedOmitted: 0,
  ...over,
});

const answered = (over: Partial<Extract<BotDeleteOutcome, { kind: "answered" }>> = {}) =>
  ({
    kind: "answered",
    deleteFiles: true,
    removedBindings: 0,
    removed: [],
    removedOmitted: 0,
    missingOmitted: 0,
    failed: [],
    failedOmitted: 0,
    purgeFailed: false,
    listed: false,
    ...over,
  }) satisfies BotDeleteOutcome;

describe("Delete bot…: who may delete", () => {
  const connected = { status: "connected" as const, canAdmin: true };

  it("F-050: the Main Bot is never offered a delete, whatever the access", () => {
    expect(deleteOffer({ isDefault: true }, connected, {})).toBe("main");
    expect(deleteOffer({ isDefault: false }, connected, {})).toBe("ready");
  });

  it("F-050: a connection without admin, or a read-only host, is told why; offline is its own state", () => {
    expect(deleteOffer({ isDefault: false }, { ...connected, canAdmin: false }, {})).toBe(
      "needs-admin",
    );
    expect(deleteOffer({ isDefault: false }, connected, { readOnly: true })).toBe("needs-admin");
    expect(deleteOffer({ isDefault: false }, { status: "disconnected", canAdmin: true }, {})).toBe(
      "offline",
    );
  });
});

describe("Delete bot…: what goes and what stays", () => {
  it("F-050: with the box clear, the folders stay and the gateway's own removals are listed", () => {
    const lines = deleteLines("Pip", read(), false);
    expect(lines.goes).toEqual([
      "Pip, with its settings and its place in your sidebar",
      "Its tasks",
      "Its routines and channel routes",
      "Approvals saved for its commands",
    ]);
    expect(lines.stays).toEqual([
      "Its workspace folder, with its files and memory",
      "Its own folder and its tasks' transcripts",
      "What Pip said in other bots' tasks",
    ]);
  });

  it("F-276: ticked, the workspace folder moves to what goes, with its path, never promised", () => {
    const lines = deleteLines("Pip", read(), true);
    expect(lines.goes).toContain(
      "Its workspace folder, with its files and memory, if no other bot uses it: /srv/claw/workspaces/pip",
    );
    expect(lines.goes).toContain(
      "Its own folder, which may hold its sign-ins, and its tasks' transcripts, if no other bot uses them",
    );
    expect(lines.stays).toEqual(["What Pip said in other bots' tasks"]);
    expect(folderOption("Pip", read())).toEqual({
      shown: true,
      enabled: true,
      line: "Folders go to the Trash on the gateway's machine. The gateway removes a folder only if no other bot uses it.",
    });
  });

  it("F-276: a bot the gateway keeps no creation record for has no folder box, and says why", () => {
    const unrecorded = read({ createdAt: null });
    expect(folderOption("Pip", unrecorded)).toEqual({
      shown: false,
      enabled: false,
      line: "The gateway keeps no creation record for Pip, so Clawtrate asks the gateway to keep its files and workspace folder. You can remove them on the gateway itself.",
    });
    // Even with the box's state left ticked, the folder stays.
    const lines = deleteLines("Pip", unrecorded, true);
    expect(lines.goes.some((line) => line.startsWith("Its workspace folder"))).toBe(false);
    expect(lines.stays[0]).toBe("Its workspace folder, with its files and memory");
  });

  it("F-464: a folder whose sharing Clawtrate can't tell is not offered for removal", () => {
    const unknown = read({ folder: "unknown", workspace: null });
    expect(folderOption("Pip", unknown)).toMatchObject({ shown: true, enabled: false });
    expect(folderOption("Pip", unknown).line).toMatch(/can't offer to remove/);
    expect(deleteLines("Pip", unknown, true).goes.join(" ")).not.toMatch(/workspace folder/);
  });

  it("F-464: a folder another bot uses can't be removed, and says who uses it", () => {
    const shared = read({ folder: "shared", sharedWith: ["Marlow"] });
    expect(folderOption("Pip", shared)).toEqual({
      shown: true,
      enabled: false,
      line: "Also used by Marlow",
    });
    expect(sharedLine(shared)).toBe("Also used by Marlow");
    // Even with the box's state left ticked, the folder stays.
    const lines = deleteLines("Pip", shared, true);
    expect(lines.goes.some((line) => line.startsWith("Its workspace folder"))).toBe(false);
    expect(lines.stays[0]).toBe(
      "Its workspace folder, with its files and memory. Also used by Marlow.",
    );
    expect(sharedLine(read({ sharedWith: ["Marlow", "Otto"] }))).toBe(
      "Also used by Marlow and Otto",
    );
    expect(sharedLine(read({ sharedWith: ["Marlow", "Otto"], sharedOmitted: 2 }))).toBe(
      "Also used by Marlow, Otto and 2 more",
    );
    expect(sharedLine(read())).toBeNull();
  });
});

describe("Delete bot…: the result", () => {
  it("F-050 F-276: deleted is said on the gateway's answer, with what the list read after shows; each moved path is the answer's", () => {
    const view = resultView(
      "Pip",
      answered({
        removed: [
          { path: "/srv/claw/workspaces/pip", method: "trash" },
          { path: "/srv/claw/agents/pip", method: "missing" },
        ],
      }),
    )!;
    expect(view.title).toBe("Pip was deleted");
    expect(view.lines.map((line) => line.text)).toEqual([
      "The gateway no longer lists Pip.",
      "Moved to the Trash: /srv/claw/workspaces/pip",
      "Already gone: /srv/claw/agents/pip",
    ]);
    expect(view).toMatchObject({ check: false, tone: null });
    const listed = resultView("Pip", answered({ listed: true, listedAs: "Pip" }))!;
    expect(listed).toMatchObject({ title: "Pip was deleted", tone: "warn" });
    expect(listed.lines[0]).toEqual({
      text: "The gateway still lists a bot under the same id: Pip.",
      tone: "warn",
    });
    // The list says only that some bot has the id: it is named as the gateway names it now.
    expect(resultView("Pip", answered({ listed: true, listedAs: "Quill" }))!.lines[0]).toEqual({
      text: "The gateway still lists a bot under the same id: Quill.",
      tone: "warn",
    });
    expect(resultView("Pip", answered({ listed: null }))!.lines[0]!.text).toBe(
      "Clawtrate couldn't read the gateway's bot list to check.",
    );
  });

  it("F-050: with the box clear the result says Clawtrate asked to keep the folders, and names none", () => {
    const view = resultView("Pip", answered({ deleteFiles: false }))!;
    expect(view.lines.map((line) => line.text)).toEqual([
      "The gateway no longer lists Pip.",
      "Clawtrate asked the gateway to keep its folders.",
    ]);
  });

  it("F-276: a folder the gateway moved though asked to keep it is said first: where, and that it is in the Trash, not gone", () => {
    const view = resultView(
      "Pip",
      answered({
        deleteFiles: false,
        removed: [{ path: "/srv/claw/workspaces/pip", method: "trash" }],
      }),
    )!;
    expect(view.lines[0]).toEqual({
      text: "Clawtrate asked the gateway to keep Pip's folders, but it moved one to the Trash on its machine. It is in the Trash there, not gone.",
      tone: "danger",
    });
    expect(view.lines.map((line) => line.text)).toContain(
      "Moved to the Trash: /srv/claw/workspaces/pip",
    );
    expect(view.lines.map((line) => line.text)).not.toContain(
      "Clawtrate asked the gateway to keep its folders.",
    );
    // Past the cap, the count still says it.
    expect(
      resultView("Pip", answered({ deleteFiles: false, removedOmitted: 3 }))!.lines[0]!.text,
    ).toMatch(/moved 3 to the Trash on its machine\. They are in the Trash there, not gone\./);
  });

  it("F-276: paths past the cap are counted by what happened to them", () => {
    const lines = resultView(
      "Pip",
      answered({
        removed: [{ path: "/srv/claw/workspaces/pip", method: "trash" }],
        removedOmitted: 2,
        missingOmitted: 1,
      }),
    )!.lines.map((line) => line.text);
    expect(lines).toContain("And 2 more the gateway moved to the Trash.");
    expect(lines).toContain("And 1 more already gone.");
  });

  it("F-050: “deleted” is said only on the gateway's answer; a bot merely no longer listed is said to be that", () => {
    const lost = resultView("Pip", {
      kind: "unconfirmed",
      message: "it didn't answer in time",
      deleteFiles: false,
      listed: false,
    })!;
    expect(lost.title).toBe("Pip is no longer listed on this gateway");
    expect(lost.title).not.toMatch(/deleted/);
    expect(lost.lines.map((line) => line.text)).toContain(
      "What became of Pip's folder is the gateway's to say.",
    );
    expect(resultView("Pip", answered())!.title).toBe("Pip was deleted");
  });

  it("F-050: a lost answer offers Check again, which only reads; nothing offers to send again", () => {
    const lost = resultView("Pip", {
      kind: "unconfirmed",
      message: "it didn't answer in time",
      deleteFiles: true,
      listed: true,
    })!;
    expect(lost).toMatchObject({ title: "The gateway didn't confirm the delete", check: true });
    expect(lost.lines[0]).toEqual({
      text: "The gateway didn't confirm the delete: it didn't answer in time",
      tone: "warn",
    });
    expect(Object.keys(lost).sort()).toEqual(["check", "lines", "title", "tone"]);
  });

  it("F-050: a partial clean-up lists what is left, says the gateway's machine is where it is handled, and is never worded as done", () => {
    const partial = resultView(
      "Pip",
      answered({
        removed: [{ path: "/srv/claw/workspaces/pip", method: "trash" }],
        failed: [{ path: "/srv/claw/agents/pip", reason: "Operation not permitted" }],
      }),
    )!;
    expect(partial.title).toBe("Pip was deleted, but some of it is left");
    expect(partial).toMatchObject({ tone: "danger", check: false });
    expect(partial.lines).toContainEqual({
      text: "Couldn't move to the Trash: /srv/claw/agents/pip. Operation not permitted",
      tone: "danger",
    });
    expect(partial.lines.at(-1)).toEqual({ text: LEFT_LINE, tone: "danger" });
    expect(LEFT_LINE).toBe("What is left has to be handled on the gateway's machine.");
    const purge = resultView("Pip", answered({ purgeFailed: true }))!;
    expect(purge.title).toBe("Pip was deleted, but some of it is left");
    expect(purge.lines.map((line) => line.text)).toContain(LEFT_LINE);
    // A list that couldn't be read after it can be read again; the answer stands.
    expect(resultView("Pip", answered({ purgeFailed: true, listed: null }))!).toMatchObject({
      title: "Pip was deleted, but some of it is left",
      check: true,
    });
  });

  it("F-050: a bot listed under the id with no name of its own is not given the deleted bot's", () => {
    const view = resultView("Pip", answered({ listed: true }))!;
    expect(view.lines[0]!.text).toBe("The gateway still lists a bot under the same id.");
    expect(view.lines[0]!.text).not.toMatch(/Pip/);
  });

  it("F-050: a task-record clean-up that failed is said without a claim about folders", () => {
    const view = resultView(
      "Pip",
      answered({
        purgeFailed: true,
        removed: [{ path: "/srv/claw/workspaces/pip", method: "trash" }],
      }),
    )!;
    const text = view.lines.map((line) => line.text);
    expect(text).toContain("The gateway couldn't clear its task records.");
    expect(text).toContain("Moved to the Trash: /srv/claw/workspaces/pip");
    expect(text.join(" ")).not.toMatch(/moved no folders/);
  });

  it("F-276: a moved path counted but not shown is a move in every line", () => {
    const view = resultView(
      "Pip",
      answered({ deleteFiles: true, removed: [], removedOmitted: 1 }),
    )!;
    const text = view.lines.map((line) => line.text);
    expect(text).toContain("The gateway moved one path to the Trash, not shown here.");
    expect(text.join(" ")).not.toMatch(/didn't report moving/);
    const kept = resultView(
      "Pip",
      answered({ deleteFiles: false, removed: [], removedOmitted: 1 }),
    )!;
    expect(kept.lines[0]!.text).toMatch(/but it moved one to the Trash/);
    expect(kept.lines.map((line) => line.text)).not.toContain(
      "Clawtrate asked the gateway to keep its folders.",
    );
    const gone = resultView(
      "Pip",
      answered({ deleteFiles: true, removed: [], missingOmitted: 2 }),
    )!;
    expect(gone.lines.map((line) => line.text)).toContain(
      "2 paths were already gone, not shown here.",
    );
    expect(gone.lines.map((line) => line.text).join(" ")).not.toMatch(/didn't report moving/);
  });

  it("F-050: closing a result lands on the Main Bot only on the gateway's answer, never on absence", () => {
    expect(deletedOnClose(answered())).toBe(true);
    expect(deletedOnClose(answered({ listed: null }))).toBe(false);
    for (const outcome of [
      { kind: "unconfirmed", message: "lost", deleteFiles: false, listed: false },
      { kind: "not-sent", message: "Not connected to the gateway." },
    ] as const)
      expect(deletedOnClose(outcome)).toBe(false);
  });

  it("F-050: a reply that establishes nothing reads as not confirmed, as a lost one does", () => {
    const view = resultView("Pip", {
      kind: "unconfirmed",
      message: "its answer didn't say this bot was deleted",
      deleteFiles: false,
      listed: true,
    })!;
    expect(view.title).toBe("The gateway didn't confirm the delete");
    expect(view.lines[0]!.text).toBe(
      "The gateway didn't confirm the delete: its answer didn't say this bot was deleted",
    );
    expect(resultView("Pip", { kind: "not-sent", message: "x" })).toBeNull();
  });

  it("F-050: any failure once the request left offers Check again, also when the list after it lacks the bot", () => {
    // A refusal in the gateway's words, as a timeout: neither establishes what was removed.
    const refused = resultView("Pip", {
      kind: "unconfirmed",
      message: "agent is busy",
      deleteFiles: false,
      listed: true,
    })!;
    expect(refused).toMatchObject({ title: "The gateway didn't confirm the delete", check: true });
    expect(refused.lines[0]!.text).toBe("The gateway didn't confirm the delete: agent is busy");
    const gone = resultView("Pip", {
      kind: "unconfirmed",
      message: "it didn't answer in time",
      deleteFiles: true,
      listed: false,
    })!;
    expect(gone).toMatchObject({ title: "Pip is no longer listed on this gateway", check: true });
  });

  it("F-050 F-464: nothing sent says why, over the fresh read", () => {
    expect(
      changedLine("Pip", {
        kind: "changed",
        reason: "shared",
        read: read({ folder: "shared", sharedWith: ["Quill"] }),
      }),
    ).toBe(
      "Also used by Quill, so Clawtrate won't ask to remove its workspace folder. Nothing was sent. Check what goes, then delete again.",
    );
    // A read that decided nothing has no line over facts, and no result: the dialog reads again.
    const unread = { kind: "unread", message: "x" } as const;
    expect(changedLine("Pip", unread)).toBeNull();
    expect(resultView("Pip", unread)).toBeNull();
    expect(changedLine("Juniper", { kind: "changed", reason: "main", read: read() })).toBe(
      "Juniper is your Main Bot, so it can't be deleted. Nothing was sent.",
    );
    expect(changedLine("Pip", { kind: "changed", reason: "moved", read: read() })).toBe(
      "Pip's workspace folder has changed on the gateway. Nothing was sent, and the folder box is cleared. Check what goes, then delete again.",
    );
    expect(changedLine("Pip", { kind: "changed", reason: "changed", read: read() })).toMatch(
      /has changed on the gateway since you looked\. Nothing was sent\./,
    );
    expect(changedLine("Pip", { kind: "changed", reason: "files", read: read() })).toMatch(
      /can't remove Pip's folder now\. Nothing was sent\./,
    );
    expect(resultView("Pip", { kind: "changed", reason: "gone", read: read() })).toBeNull();
  });
});

describe("Delete bot…: the newest read decides", () => {
  it("F-050: a read a later one superseded is dropped, its answer and its failure alike", () => {
    const begin = newestOnly();
    const first = begin();
    expect(first()).toBe(true);
    const second = begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});

describe("Delete bot…: typing the name to confirm", () => {
  it("F-050: Delete waits for the bot's name, typed exactly: nothing, wrong or another case don't match", () => {
    const target = confirmTargetOf("Pip", "pip");
    expect(target).toEqual({ text: "Pip", by: "name" });
    expect(confirmLabel(target)).toBe("To confirm, type the bot's name: Pip");
    for (const typed of ["", "   ", "Pi", "pip", "PIP", "Pip!", "Pip Pip"])
      expect(confirmMatches(typed, target), typed).toBe(false);
    for (const typed of ["Pip", "  Pip", "Pip  "]) expect(confirmMatches(typed, target)).toBe(true);
  });

  it("F-050: a name that changes under the dialog is the one to type", () => {
    const before = confirmTargetOf("Pip", "pip");
    const after = confirmTargetOf("Quill", "pip");
    expect(confirmMatches("Pip", before)).toBe(true);
    expect(confirmMatches("Pip", after)).toBe(false);
    expect(confirmMatches("Quill", after)).toBe(true);
  });

  it("F-050: a bot with no name is confirmed by its id, and the label says so; one named as its id by that name", () => {
    const unnamed = confirmTargetOf(null, "pip");
    expect(unnamed).toEqual({ text: "pip", by: "unnamed" });
    expect(confirmLabel(unnamed)).toBe("This bot has no name. To confirm, type its id: pip");
    expect(confirmLabel(confirmTargetOf("pip", "pip"))).toBe(
      "To confirm, type the bot's name: pip",
    );
  });

  it("F-050: a name with a line break, or longer than the dialog shows, is confirmed by the id, and the label says why", () => {
    for (const name of ["Pip\nthe second", "P".repeat(257)]) {
      const target = confirmTargetOf(name, "pip");
      expect(target).toEqual({ text: "pip", by: "untypable" });
      expect(confirmLabel(target)).toBe(
        "This bot's name can't be typed here. To confirm, type its id: pip",
      );
    }
  });

  it("F-050: by the button, it says plainly what can't be undone, true to the folder choice", () => {
    expect(finalLine("Pip", false)).toBe(
      "This can't be undone. Pip and its tasks won't come back.",
    );
    expect(finalLine("Pip", true)).toBe(
      "This can't be undone. Pip and its tasks won't come back; folders the gateway removes go to the Trash on its machine.",
    );
  });
});
