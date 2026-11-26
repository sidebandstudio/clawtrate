// "This computer" with local connect (docs/design/setup-effortless.md §3, "The
// first screen on a Mac with OpenClaw"): OpenClaw's own settings file, read by
// the bounded reader, and the port it names proved on one socket of the look's
// own, which sends nothing and is closed at once. No OpenClaw program runs. The
// token the reader finds is dropped here, unused; Connect reads it afresh
// (`readToken`) and holds it for its one attempt.

import { connect as dial } from "node:net";
import type { SetupLook } from "@clawtrate/core";
import { localPortAllowed, proveFor, type LocalConnect } from "./local-connect.ts";
import { refusalKind, type ProveRefusal } from "./local-prove.ts";
import type { SettingsProfile } from "./settings-extract.ts";
import {
  readLocalSettings,
  SETTINGS_PROFILES,
  type HeldToken,
  type SettingsOutcome,
} from "./settings-reader.ts";
import { SetupRefusedError } from "./world.ts";

/** What the look found that Connect may pair with: a profile's folder and its port. */
export type LocalFound = { profile: SettingsProfile; folder: string; port: number; url: string };

export type LocalReport = { look: SetupLook; found: LocalFound | null };

/** How long the look waits for its socket to the port to open. */
export const DIAL_MS = 2_000;

const empty: Omit<SetupLook, "outcome"> = {
  reason: null,
  version: null,
  profile: null,
  listens: null,
  service: null,
  port: null,
  authMode: null,
  access: null,
  others: [],
};

const folderOf = (profile: SettingsProfile) =>
  SETTINGS_PROFILES.find((entry) => entry.profile === profile)!.folder;

type Probe = { kind: "stopped" } | { kind: "proved" } | { kind: "refused"; why: ProveRefusal };

/**
 * One socket to the port, opened and proved, with nothing written to it, and
 * closed: whether anything listens there, and whether it is this profile's
 * gateway. A discovery hint only: Connect proves its own sockets again.
 */
async function probe(local: LocalConnect, folder: string, port: number): Promise<Probe> {
  const socket = dial({ host: "127.0.0.1", port });
  try {
    const open = await new Promise<boolean>((done) => {
      const timer = setTimeout(() => done(false), DIAL_MS);
      socket.once("connect", () => (clearTimeout(timer), done(true)));
      socket.once("error", () => (clearTimeout(timer), done(false)));
    });
    if (!open) return { kind: "stopped" };
    let why: ProveRefusal = "failed";
    const proved = await proveFor(
      local,
      folder,
      port,
      (refused) => (why = refused),
    )(socket.localPort!);
    return proved ? { kind: "proved" } : { kind: "refused", why };
  } finally {
    socket.destroy();
  }
}

/** A refusal of the settings, as the card says it: another sign-in, or settings it can't use. */
function settingsLook(outcome: Exclude<SettingsOutcome, { kind: "found" }>): SetupLook | null {
  if (outcome.kind === "refused" && outcome.reason === "absent") return null;
  if (
    outcome.reason === "credential" &&
    (outcome.why === "auth-mode" || outcome.why === "password")
  )
    return { ...empty, outcome: "not-token" };
  return { ...empty, outcome: "cant-tell", reason: "settings" };
}

/**
 * The look: each profile's settings, in the reader's order (the default first);
 * the first one proved is offered. Otherwise what came closest, in this order:
 * a gateway that answered but wasn't proved, one that isn't running, settings
 * that can't be used, none at all. Throws the reader's `SetupRefusedError`.
 */
export async function lookLocally(
  local: LocalConnect,
  worker: URL,
  onStep: (step: number) => void = () => {},
  cancelled: () => boolean = () => false,
): Promise<LocalReport | null> {
  onStep(0);
  if (local.platform === "win32") return { look: { ...empty, outcome: "windows" }, found: null };
  const read = await readLocalSettings({ ...local, worker });
  // The look only decides what the card says: every token found is dropped now.
  for (const { outcome } of read) if (outcome.kind === "found") outcome.token.drop();
  if (cancelled()) return null;
  onStep(1);
  const closest: { rank: number; look: SetupLook }[] = [];
  const keep = (rank: number, look: SetupLook) => closest.push({ rank, look });
  for (const { profile, outcome } of read) {
    if (outcome.kind !== "found") {
      const look = settingsLook(outcome);
      if (look) keep(3, look);
      continue;
    }
    const folder = folderOf(profile);
    const { port } = outcome;
    // Outside a person's app, never OpenClaw's default ports, before any socket is opened.
    if (!localPortAllowed(local, port)) throw new SetupRefusedError("state");
    const facts = { ...empty, profile, port };
    const result = await probe(local, folder, port);
    if (cancelled()) return null;
    if (result.kind === "proved") {
      const url = `ws://127.0.0.1:${port}`;
      return {
        look: { ...facts, outcome: "running", access: "new" },
        found: { profile, folder, port, url },
      };
    }
    if (result.kind === "stopped") keep(2, { ...facts, outcome: "stopped" });
    else
      keep(1, {
        ...facts,
        outcome: "unverified",
        reason: refusalKind(result.why),
      });
  }
  // The closest result; between two alike, the reader's order.
  const best = closest.sort((a, b) => a.rank - b.rank)[0];
  return { look: best?.look ?? { ...empty, outcome: "not-found" }, found: null };
}

/**
 * Connect's own read of the token for what the look found: afresh, for that
 * profile only, and only while its settings still name the same port. Every
 * other token read is dropped. Null when they changed.
 */
export async function readToken(
  local: LocalConnect,
  worker: URL,
  found: LocalFound,
): Promise<HeldToken | null> {
  const read = await readLocalSettings({ ...local, worker });
  let held: HeldToken | null = null;
  for (const { profile, outcome } of read) {
    if (outcome.kind !== "found") continue;
    if (profile === found.profile && outcome.port === found.port) held = outcome.token;
    else outcome.token.drop();
  }
  if (held && !localPortAllowed(local, found.port)) {
    held.drop();
    throw new SetupRefusedError("state");
  }
  return held;
}
