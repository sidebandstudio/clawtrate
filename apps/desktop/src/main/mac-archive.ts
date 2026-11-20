import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, rm, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { VerifiedArtifact } from "./update/install.ts";

/** A private, unlinked archive with no remaining writable descriptor. The
 * inspector and the loopback response both read this object by descriptor. */
export interface HeldMacArchive {
  readonly file: FileHandle;
  readonly proof: VerifiedArtifact;
  readonly sha256: string;
}

export class ChangedMacArchive extends Error {}

function sourcePathError(error: NodeJS.ErrnoException): never {
  if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code ?? "")) throw new ChangedMacArchive();
  throw error;
}

export async function holdMacArchive(
  proof: VerifiedArtifact,
  signal?: AbortSignal,
): Promise<HeldMacArchive> {
  signal?.throwIfAborted();
  const source = await open(
    proof.path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  ).catch(sourcePathError);
  let reader: FileHandle | undefined;
  try {
    try {
      const before = await source.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size !== BigInt(proof.size) ||
        [before.dev, before.ino, before.birthtimeNs].join(".") !== proof.identity
      )
        throw new ChangedMacArchive();
      const scratch = await mkdtemp(join(dirname(proof.path), ".hold-"));
      try {
        const path = join(scratch, "archive");
        const writer = await open(path, "wx", 0o400);
        try {
          reader = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          await unlink(path);
          const written = await writer.stat({ bigint: true }),
            opened = await reader.stat({ bigint: true });
          if (written.ino !== opened.ino || written.dev !== opened.dev || written.nlink !== 0n)
            throw Error("Cannot hold private archive");
          const sha256 = createHash("sha256"),
            sha512 = createHash("sha512");
          const buffer = Buffer.alloc(64 * 1024);
          let total = 0;
          while (total <= proof.size) {
            signal?.throwIfAborted();
            const { bytesRead } = await source.read(
              buffer,
              0,
              Math.min(buffer.length, proof.size - total + 1),
            );
            if (!bytesRead) break;
            total += bytesRead;
            if (total > proof.size) throw new ChangedMacArchive();
            const part = buffer.subarray(0, bytesRead);
            sha512.update(part);
            sha256.update(part);
            await writer.writeFile(part);
          }
          const end = await lstat(proof.path, { bigint: true }).catch(sourcePathError);
          if (
            total !== proof.size ||
            sha512.digest("base64") !== proof.sha512 ||
            end.ino !== before.ino ||
            end.dev !== before.dev ||
            end.ctimeNs !== before.ctimeNs
          )
            throw new ChangedMacArchive();
          return { file: reader, proof, sha256: sha256.digest("hex") };
        } finally {
          await writer.close();
        }
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    } finally {
      await source.close();
    }
  } catch (error) {
    await reader?.close();
    throw error;
  }
}
