import type {
  UpdateCleanupFailure,
  UpdateInspectionFailure,
  UpdateInstallRefusal,
} from "@clawtrate/core";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { release } from "node:os";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AddressInfo } from "node:net";
import { APP_ID } from "./identity.ts";
import { ChangedMacArchive, holdMacArchive, type HeldMacArchive } from "./mac-archive.ts";
import type { UpdateInstaller } from "./update/install.ts";
import { rm } from "./update-tree-fs.ts";

type HelperFailure = Omit<UpdateInspectionFailure, "stage" | "system">;
type HelperResult = { reason: UpdateInstallRefusal | null; failure: HelperFailure | null };
type RecordFailure = (stage: UpdateInspectionFailure["stage"], failure: HelperFailure) => void;

const RESULTS = new Set<string>([
  "ok",
  "build-not-signed",
  "running-signature-untrusted",
  "mac-archive",
  "mac-bundle-identifier",
  "mac-architecture",
  "installer-version",
  "mac-designated-requirement",
]);

/** A system error's code, such as ENOENT, or its class name; never its message. */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code)) return code;
  return error instanceof Error && /^[A-Za-z]{1,32}$/.test(error.name) ? error.name : "unknown";
}

/** The operating system and its version, as the diagnostic records it. */
export function systemVersion(): string {
  const version = (process as { getSystemVersion?: () => string }).getSystemVersion?.();
  return version ? "macOS " + version : process.platform + " " + release();
}

/** The steps the helper names when one fails (packaging/mac/inspect-archive.m). */
export const HELPER_STEPS = new Set([
  "parent-code",
  "parent-static-code",
  "parent-signing-information",
  "requirement",
  "parent-validity",
  "parent-static-validity",
  "parent-designated-requirement",
  "scratch",
  "unpack",
  "candidate-code",
  "candidate-validity",
]);

/** The helper names the failed step on its error output as `<step> <status>`; anything else is dropped. */
function helperStep(text: string): string | null {
  const step = text.split("\n")[0] ?? "";
  const match = /^([a-z-]{1,32}) -?\d{1,11}$/.exec(step);
  return match && HELPER_STEPS.has(match[1]!) ? step : null;
}

async function runInspector(
  args: string[],
  signal: AbortSignal,
  archive?: HeldMacArchive,
): Promise<HelperResult> {
  signal.throwIfAborted();
  const started = performance.now();
  let output = "";
  let errors = "";
  let tooLong = false;
  let failed = false;
  let ran = false;
  let code: number | null = null;
  let killed: string | null = null;
  let error: string | null = null;
  await new Promise<void>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        join(process.resourcesPath, "..", "Helpers", "ClawtrateUpdateInspection"),
        args,
        {
          env: { PATH: "/usr/bin:/bin" },
          stdio: ["ignore", "pipe", "pipe", ...(archive ? [archive.file.fd] : [])],
          signal,
          timeout: 120000,
          killSignal: "SIGKILL",
        },
      );
    } catch (thrown) {
      failed = true;
      error = errorCode(thrown);
      resolve();
      return;
    }
    ran = child.pid !== undefined;
    child.stdout!.on("data", (data: Buffer) => {
      if (failed) return;
      if (output.length + data.length > 128) {
        failed = tooLong = true;
        child.kill("SIGKILL");
      } else output += data.toString("utf8");
    });
    // Only the first 256 bytes are kept; the rest is drained so the helper never blocks on it.
    child.stderr?.on("data", (data: Buffer) => {
      if (errors.length < 256) errors += data.toString("utf8", 0, 256 - errors.length);
    });
    // An abort emits error before the inherited descriptors close.
    child.on("error", (thrown) => {
      failed = true;
      error ??= errorCode(thrown);
    });
    child.once("close", (exit, sig) => {
      code = exit;
      killed = sig;
      resolve();
    });
  });
  const complete = !failed && !signal.aborted && code === 0 && output.endsWith("\n");
  const line = output.endsWith("\n") ? output.slice(0, -1) : null;
  if (complete && line !== null && RESULTS.has(line))
    return { reason: line === "ok" ? null : (line as UpdateInstallRefusal), failure: null };
  return {
    reason: "inspection-failed",
    failure: {
      exitCode: code !== null && code >= 0 ? code : null,
      signal: killed,
      output: !ran
        ? null
        : tooLong
          ? "too-long"
          : output === ""
            ? "empty"
            : line === null
              ? "no-line-ending"
              : line === "inspection-failed"
                ? "reported"
                : RESULTS.has(line)
                  ? "complete"
                  : "unrecognized",
      helperStep: helperStep(errors),
      errorCode: error,
      durationMs: Math.round(performance.now() - started),
    },
  };
}

async function inspectBundle(
  archive: HeldMacArchive,
  arch: string,
  signal: AbortSignal,
  record?: RecordFailure,
  cleanupFailed?: (code: string) => void,
): Promise<UpdateInstallRefusal | null> {
  signal.throwIfAborted();
  const scratch = await mkdtemp(join(dirname(archive.proof.path), ".inspect-"));
  try {
    const { reason, failure } = await runInspector(
      [scratch, APP_ID, archive.proof.version, arch],
      signal,
      archive,
    );
    if (failure) record?.("archive", failure);
    return reason;
  } finally {
    // The checked copy holds the candidate's app.asar. Removing it can't change the
    // inspection's answer: a copy left behind goes with the update folder, which is cleared
    // at the next start and the next check.
    await rm(scratch, { recursive: true, force: true }).catch((error: unknown) => {
      console.error(`Couldn't remove the checked copy of the update (${errorCode(error)})`);
      cleanupFailed?.(errorCode(error));
    });
  }
}

type Stage = (url: string, signal: AbortSignal, handed: () => void) => Promise<void>;

/** The macOS updater reported an error, or that there is no update, or refused the call. */
class UpdaterRefused extends Error {}

// Native errors can still arrive after the operation ends.
const ignoreLateError = () => {};
const stageWithElectron: Stage = async (url, signal, handed) => {
  const { autoUpdater } = await import("electron");
  signal.throwIfAborted();
  if (!autoUpdater.listeners("error").includes(ignoreLateError))
    autoUpdater.on("error", ignoreLateError);
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    let checking = false;
    const abort = () => finish(() => reject(signal.reason));
    const failed = () => finish(() => reject(new UpdaterRefused("System updater stopped")));
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
      autoUpdater.checkForUpdates();
    } catch {
      finish(() => reject(new UpdaterRefused("System updater refused the call")));
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
    } else if (req.url === prefix + "/archive.zip" && feedRead && !archiveRead && !stop.aborted) {
      // From here the updater may stage the update. Before it, it cannot have.
      archiveRead = true;
      submitted();
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
    await Promise.race([stage("http://" + host + prefix + "/feed", stop, handed), stopped.promise]);
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
  system = systemVersion(),
): UpdateInstaller {
  let kept: HeldMacArchive | undefined;
  let inspection: AbortController | undefined;
  let unsigned = false;
  let failure: UpdateInspectionFailure | null = null;
  let cleanup: UpdateCleanupFailure | null = null;
  function retire() {
    inspection?.abort();
    inspection = undefined;
    if (kept) void kept.file.close().catch(() => {});
    kept = undefined;
  }
  const record: RecordFailure = (stage, helper) => {
    failure = { stage, ...helper, system };
  };
  return {
    get unavailable() {
      return unsigned ? ("build-not-signed" as const) : null;
    },
    get inspectionFailure() {
      return failure;
    },
    get cleanupFailure() {
      return cleanup;
    },
    completesOnQuit: true,
    retire,
    async inspect(file) {
      if (kept?.proof.offerId === file.offerId && kept.proof.identity === file.identity)
        return null;
      retire();
      failure = null;
      cleanup = null;
      inspection = new AbortController();
      const { signal } = inspection;
      // retire() aborts a superseded inspection; nothing it records later belongs to this one.
      const note: RecordFailure = (stage, helper) => {
        if (!signal.aborted) record(stage, helper);
      };
      const lost = (copy: UpdateCleanupFailure["copy"]) => (errorCode: string) => {
        if (!signal.aborted) cleanup = { copy, errorCode };
      };
      if (!inspect) {
        // The signature-only invocation receives neither a descriptor nor a scratch path.
        const { reason, failure: helper } = await runInspector(
          ["--running-signature", APP_ID],
          signal,
        );
        if (signal.aborted) return "artifact-changed";
        if (reason === "build-not-signed") unsigned = true;
        if (helper) record(helper.output === null ? "start-helper" : "running-signature", helper);
        if (reason) return reason;
      }
      let held: HeldMacArchive;
      const holding = performance.now();
      try {
        held = await holdMacArchive(file, signal, lost("held-copy"));
      } catch (error) {
        if (error instanceof ChangedMacArchive) return "artifact-changed";
        note("hold-archive", {
          exitCode: null,
          signal: null,
          output: null,
          helperStep: null,
          errorCode: errorCode(error),
          durationMs: Math.round(performance.now() - holding),
        });
        return "inspection-failed";
      }
      const inspecting = performance.now();
      try {
        const reason = await (inspect ?? inspectBundle)(
          held,
          arch,
          signal,
          (stage, helper) => note(helper.output === null ? "start-helper" : stage, helper),
          lost("checked-copy"),
        );
        if (reason || signal.aborted) return reason ?? "artifact-changed";
        kept = held;
        return null;
      } catch (error) {
        // The scratch folder could not be made, or the call was stopped.
        note("archive", {
          exitCode: null,
          signal: null,
          output: null,
          helperStep: null,
          errorCode: errorCode(error),
          durationMs: Math.round(performance.now() - inspecting),
        });
        return "inspection-failed";
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
      } catch (error) {
        // A refusal after the archive request is reported as unconfirmed by the caller.
        if (error instanceof UpdaterRefused) return "mac-updater-refused";
        throw error;
      } finally {
        await archive.file.close();
      }
    },
  };
}
