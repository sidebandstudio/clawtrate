import type { UpdateInstallRefusal } from "@clawtrate/core";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AddressInfo } from "node:net";
import { APP_ID } from "./identity.ts";
import { holdMacArchive, type HeldMacArchive } from "./mac-archive.ts";
import type { UpdateInstaller } from "./update/install.ts";

async function inspectBundle(
  archive: HeldMacArchive,
  arch: string,
): Promise<UpdateInstallRefusal | null> {
  const scratch = await mkdtemp(join(dirname(archive.proof.path), ".inspect-"));
  try {
    const reason = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        join(process.resourcesPath, "..", "Helpers", "ClawtrateUpdateInspection"),
        [scratch, APP_ID, archive.proof.version, arch],
        {
          env: { PATH: "/usr/bin:/bin" },
          stdio: ["ignore", "pipe", "ignore", archive.file.fd],
          timeout: 120000,
          killSignal: "SIGKILL",
        },
      );
      let output = "";
      child.stdout!.on("data", (data: Buffer) => {
        output += data.toString("utf8");
        if (output.length > 128) child.kill("SIGKILL");
      });
      child.once("error", reject);
      child.once("close", (code) => resolve(code === 0 ? output.trim() : "inspection-failed"));
    });
    switch (reason) {
      case "ok":
        return null;
      case "running-signature-untrusted":
      case "mac-archive":
      case "mac-bundle-identifier":
      case "mac-architecture":
      case "installer-version":
      case "mac-designated-requirement":
        return reason;
      default:
        return "inspection-failed";
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

type Stage = (
  url: string,
  signal: AbortSignal,
  handed: () => void,
  submitted: () => void,
) => Promise<void>;

const observedUpdaters = new WeakSet<object>();
const stageWithElectron: Stage = async (url, signal, handed, submitted) => {
  const { autoUpdater } = await import("electron");
  signal.throwIfAborted();
  if (!observedUpdaters.has(autoUpdater)) {
    // Native errors can still arrive after the operation ends.
    autoUpdater.on("error", () => {});
    observedUpdaters.add(autoUpdater);
  }
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    let checking = false;
    const abort = () => finish(() => reject(signal.reason));
    const failed = () => finish(() => reject(Error("System updater stopped")));
    const ready = () => {
      if (!checking) return;
      finish(() => {
        handed();
        try {
          autoUpdater.quitAndInstall();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    };
    function finish(done: () => void) {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      autoUpdater.off("error", failed);
      autoUpdater.off("update-not-available", failed);
      autoUpdater.off("update-downloaded", ready);
      done();
    }
    autoUpdater.on("error", failed);
    autoUpdater.on("update-not-available", failed);
    autoUpdater.on("update-downloaded", ready);
    signal.addEventListener("abort", abort, { once: true });
    try {
      autoUpdater.setFeedURL({ url, serverType: "default" });
      if (finished) return;
      checking = true;
      submitted();
      autoUpdater.checkForUpdates();
    } catch (error) {
      finish(() => reject(error));
    }
  });
};

export async function serveMacArchive(
  archive: HeldMacArchive,
  signal: AbortSignal,
  stage: Stage,
  handed: () => void,
  deadlineMs = 120000,
  submitted = () => {},
) {
  const prefix = "/" + randomUUID();
  let feedRead = false,
    archiveRead = false;
  const local = new AbortController();
  const stop = AbortSignal.any([signal, local.signal]);
  stop.throwIfAborted();
  const listener = createServer((req, res) => {
    if (req.method !== "GET" || req.headers.host !== host) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    if (req.url === prefix + "/feed" && !feedRead) {
      feedRead = true;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          url: "http://" + host + prefix + "/archive.zip",
          size: archive.proof.size,
          sha256: archive.sha256,
        }),
      );
    } else if (req.url === prefix + "/archive.zip" && feedRead && !archiveRead) {
      archiveRead = true;
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": archive.proof.size,
      });
      const stream = Readable.from(
        (async function* () {
          let offset = 0;
          while (offset < archive.proof.size) {
            const buffer = Buffer.allocUnsafe(Math.min(65536, archive.proof.size - offset));
            const { bytesRead } = await archive.file.read(buffer, 0, buffer.length, offset);
            if (!bytesRead) throw Error("Short archive");
            offset += bytesRead;
            yield buffer.subarray(0, bytesRead);
          }
        })(),
      );
      void pipeline(stream, res, { signal: stop }).catch(() => local.abort());
    } else res.writeHead(404).end();
  });
  let host = "";
  const timer = setTimeout(() => local.abort(), deadlineMs);
  const stopped = Promise.withResolvers<never>();
  const abort = () => stopped.reject(Error("Local handoff ended"));
  stop.addEventListener("abort", abort, { once: true });
  listener.on("error", abort);
  try {
    await Promise.race([
      new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve)),
      stopped.promise,
    ]);
    host = "127.0.0.1:" + (listener.address() as AddressInfo).port;
    await Promise.race([
      stage("http://" + host + prefix + "/feed", stop, handed, submitted),
      stopped.promise,
    ]);
  } finally {
    clearTimeout(timer);
    stop.removeEventListener("abort", abort);
    local.abort();
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
}

export function macInstaller(
  arch: string,
  inspect = inspectBundle,
  stage = stageWithElectron,
  deadlineMs = 120000,
): UpdateInstaller {
  let kept: HeldMacArchive | undefined;
  let generation = 0;
  function retire() {
    generation++;
    if (kept) void kept.file.close().catch(() => {});
    kept = undefined;
  }
  return {
    unavailable: null,
    completesOnQuit: true,
    retire,
    async inspect(file) {
      if (kept?.proof.offerId === file.offerId && kept.proof.identity === file.identity)
        return null;
      retire();
      const current = generation;
      const held = await holdMacArchive(file).catch(() => null);
      if (!held) return "artifact-changed";
      try {
        const reason = await inspect(held, arch);
        if (reason || current !== generation) return reason ?? "artifact-changed";
        kept = held;
        return null;
      } finally {
        if (kept !== held) await held.file.close();
      }
    },
    async launch(file, signal, handed, submitted) {
      if (
        !kept ||
        kept.proof.offerId !== file.offerId ||
        kept.proof.identity !== file.identity ||
        kept.proof.sha512 !== file.sha512
      )
        return "artifact-changed";
      const archive = kept;
      kept = undefined;
      try {
        await serveMacArchive(archive, signal, stage, handed, deadlineMs, submitted);
        return null;
      } finally {
        await archive.file.close();
      }
    },
  };
}
