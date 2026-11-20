import { utf8Length } from "./encoding.ts";
import { asRecord } from "./mapping.ts";

export const MAX_MEMORY_BYTES = 256 * 1024;
export const ROOT_MEMORY = ["MEMORY.md", "USER.md"] as const;

export type MemoryFile = {
  path: string;
  hash: string | null;
  modifiedAt: number | null;
};

export type MemoryDocument = MemoryFile & { content: string };
export type MemoryList = { files: MemoryFile[]; notesError: string | null; truncated: boolean };

type Request = (method: string, params: unknown) => Promise<unknown>;

function metadata(value: unknown, path: string, date: unknown): MemoryFile {
  const file = asRecord(value);
  if (!file || typeof file.hash !== "string" || !/^[a-f0-9]{64}$/i.test(file.hash))
    throw new Error("The gateway did not return the file's revision.");
  return { path, hash: file.hash, modifiedAt: typeof date === "number" ? date : null };
}

export async function readMemory(
  request: Request,
  agentId: string,
  path: string,
): Promise<MemoryDocument> {
  const root = ROOT_MEMORY.some((name) => name === path);
  const response = asRecord(
    await (root
      ? request("agents.files.get", { agentId, name: path })
      : request("clawtrate-memory.read", { agentId, path })),
  );
  const file = root ? asRecord(response?.file) : response;
  if (root && file?.missing === true) return { path, hash: null, modifiedAt: null, content: "" };
  if (typeof file?.content !== "string") throw new Error("The gateway did not return the file.");
  if (utf8Length(file.content) > MAX_MEMORY_BYTES)
    throw new Error("This memory file is too large to open here.");
  return {
    ...metadata(file, path, root ? file.updatedAtMs : file.modifiedAt),
    content: file.content,
  };
}

export async function listMemory(request: Request, agentId: string): Promise<MemoryList> {
  const notes = await request("clawtrate-memory.list", { agentId }).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  );
  if (notes instanceof Error) return { files: [], notesError: notes.message, truncated: false };
  const result = asRecord(notes);
  if (!Array.isArray(result?.files)) throw new Error("The gateway did not return the note list.");
  const files = result.files.slice(0, 256).map((value: unknown) => {
    const file = asRecord(value);
    if (
      typeof file?.path !== "string" ||
      !/^memory\/.+\.md$/i.test(file.path) ||
      file.path.length > 512
    )
      throw new Error("The gateway returned an invalid note path.");
    return metadata(file, file.path, file.modifiedAt);
  });
  return {
    files,
    notesError: null,
    truncated: result.truncated === true || result.files.length > 256,
  };
}

/**
 * Note writes wait on plugins/clawtrate-memory's recorded security review
 * (#41): until then the viewer offers none, while note reads and root file
 * edits stay.
 */
export const MEMORY_NOTES_WRITABLE = false;

export async function writeMemory(
  request: Request,
  agentId: string,
  path: string,
  gatewayId: string | null,
  expectedHash: string | null,
  content: string | null,
): Promise<void> {
  const root = ROOT_MEMORY.some((name) => name === path);
  if (!root && !MEMORY_NOTES_WRITABLE) throw new Error("Memory notes are read-only.");
  // A missing-file guard or matching hash is valid on two gateways at one
  // address, so ask the connected gateway who it is and hold the draft to it.
  const identity = asRecord(await request("gateway.identity.get", {}))?.deviceId;
  if (typeof identity !== "string" || identity === "" || identity !== gatewayId)
    throw new Error(
      "This draft came from a different gateway. Reopen the memory screen and save again.",
    );
  if (root) {
    if (content === null) throw new Error("Root memory files can only be edited.");
    const result = asRecord(
      await request("agents.files.set", {
        agentId,
        name: path,
        content,
        ...(expectedHash === null ? { expectedMissing: true } : { expectedHash }),
      }),
    );
    if (result?.ok !== true) throw new Error("The gateway did not confirm the save.");
  } else if (content === null) {
    const result = asRecord(
      await request("clawtrate-memory.delete", { agentId, path, expectedHash }),
    );
    if (result?.deleted !== true) throw new Error("The gateway did not confirm the deletion.");
  } else {
    const result = asRecord(
      await request("clawtrate-memory.write", { agentId, path, expectedHash, content }),
    );
    metadata(result, path, null);
  }
}
