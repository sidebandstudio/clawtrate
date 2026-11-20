import type { BridgeCommand, MemoryDocument } from "@clawtrate/core";

const hash = (revision: number) => `${revision}c7e9a4b`.repeat(8).slice(0, 64);

export function memoryCommands(now: number) {
  const documents = new Map<string, MemoryDocument>();
  const root = "MEMORY.md";
  const note = "memory/meeting-notes.md";
  let revision = 1;
  for (const [path, content] of [
    [root, "Run the checks before opening a pull request.\n\nKeep meeting notes in Markdown.\n"],
    ["USER.md", "Prefers weekly summaries on Friday.\n"],
    [note, "Discuss the next release at the weekly meeting.\n"],
  ] as const) {
    documents.set(`otto/${path}`, {
      path,
      content,
      hash: hash(revision++),
      modifiedAt: now,
    });
  }
  return async (
    command: Extract<BridgeCommand, { type: "listMemory" | "readMemory" | "writeMemory" }>,
  ) => {
    const { botId } = command;
    if (command.type === "listMemory") {
      const files = [...documents.entries()].flatMap(([key, { path, hash, modifiedAt }]) =>
        key.startsWith(`${botId}/memory/`) ? [{ path, hash, modifiedAt }] : [],
      );
      return { files, truncated: false, notesError: null };
    }
    const { path } = command;
    const key = `${botId}/${path}`;
    const file = documents.get(key);
    if (command.type === "readMemory") {
      if (!file && path.startsWith("memory/")) throw new Error("Note does not exist");
      return file ?? { path, hash: null, modifiedAt: null, content: "" };
    }
    if ((file?.hash ?? null) !== command.expectedHash)
      throw new Error("The memory revision changed.");
    if (command.content === null) documents.delete(key);
    else
      documents.set(key, {
        path,
        hash: hash(revision++),
        modifiedAt: now,
        content: command.content,
      });
  };
}
