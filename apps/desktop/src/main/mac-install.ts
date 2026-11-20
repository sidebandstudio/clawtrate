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
import { ChangedMacArchive, holdMacArchive, type HeldMacArchive } from "./mac-archive.ts";
import type { UpdateInstaller } from "./update/install.ts";

async function runInspector(
  args: string[],
  signal: AbortSignal,
  archive?: HeldMacArchive,
): Promise<UpdateInstallRefusal | null> {
  signal.throwIfAborted();
  const reason = await new Promise<string>((resolve) => {
    const child = spawn(
      join(process.resourcesPath, "..", "Helpers", "ClawtrateUpdateInspection"),
      args,
      {
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "ignore", ...(archive ? [archive.file.fd] : [])],
        signal,
        timeout: 120000,
        killSignal: "SIGKILL",
      },
    );
    let output = "";
    let failed = false;
    child.stdout!.on("data", (data: Buffer) => {
      if (failed) return;
      if (output.length + data.length > 128) {
        failed = true;
        child.kill("SIGKILL");
      } else output += data.toString("utf8");
    });
    // An abort emits error before the inherited descriptors close.
    child.on("error", () => {
      failed = true;
    });
    child.once("close", (code) =>
      resolve(!failed && !signal.aborted && code === 0 ? output.trim() : "inspection-failed"),
    );
  });
  switch (reason) {
    case "ok":
      return null;
    case "build-not-signed":
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
}

async function inspectBundle(
  archive: HeldMacArchive,
  arch: string,
  signal: AbortSignal,
): Promise<UpdateInstallRefusal | null> {
  signal.throwIfAborted();
  const scratch = await mkdtemp(join(dirname(archive.proof.path), ".inspect-"));
  try {
    return await runInspector([scratch, APP_ID, archive.proof.version, arch], signal, archive);
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
  inspect?: typeof inspectBundle,
  stage = stageWithElectron,
  deadlineMs = 120000,
): UpdateInstaller {
  let kept: HeldMacArchive | undefined;
  let inspection: AbortController | undefined;
  let unsigned = false;
  function retire() {
    inspection?.abort();
    inspection = undefined;
    if (kept) void kept.file.close().catch(() => {});
    kept = undefined;
  }
  return {
    get unavailable() {
      return unsigned ? ("build-not-signed" as const) : null;
    },
    completesOnQuit: true,
    retire,
    async inspect(file) {
      if (kept?.proof.offerId === file.offerId && kept.proof.identity === file.identity)
        return null;
      retire();
      inspection = new AbortController();
      const { signal } = inspection;
      if (!inspect) {
        // The signature-only invocation receives neither a descriptor nor a scratch path.
        const refusal = await runInspector(["--running-signature", APP_ID], signal);
        if (signal.aborted) return "artifact-changed";
        if (refusal === "build-not-signed") unsigned = true;
        if (refusal) return refusal;
      }
      let held: HeldMacArchive;
      try {
        held = await holdMacArchive(file, signal);
      } catch (error) {
        return error instanceof ChangedMacArchive ? "artifact-changed" : "inspection-failed";
      }
      try {
        const reason = await (inspect ?? inspectBundle)(held, arch, signal);
        if (reason || signal.aborted) return reason ?? "artifact-changed";
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
