// Another computer over SSH, as the host runs it (docs/design/setup.md §5 to
// §8): the field's refusals by name, the account's confirmation, first
// contact, a key already trusted and a changed key, the LOOK and its found
// card, Connect with a one-time code made there by the CODE script, the
// forward connected into the client, the route's life in the status strip,
// Start when the gateway is proven stopped, and Remove.
//
// The interface asks; the host decides. Every step that runs anything on the
// other computer, pins or replaces a key, registers this device, starts a
// gateway or forgets a route waits for the host's own dialog, and reads its
// facts again after the answer. The page never names a program, a port, a
// profile, a key or a route: it sends what was typed, and the host resolves
// everything else from its own state.

import { createHash, randomBytes } from "node:crypto";

import {
  initialSetupState,
  SETUP_ENDPOINT_CHANGED,
  SETUP_PAIRING_GONE,
  type ApprovalPlace,
  type ClawtrateClient,
  type ClawtrateState,
  type RouteStatus,
  type SetupState,
  type SshFailureKind,
  type SshSetup,
  type UnreachableWords,
} from "@clawtrate/core";

import type { ForwardState, ForwardSupervisor } from "../main/ssh/forward.ts";
import { sameService, serviceOnPort, type FoundService } from "../main/ssh/look.ts";
import type { SshFailure } from "../main/ssh/ssh-output.ts";
import type { Route, SshTransport } from "../main/ssh/transport.ts";
import { OPERATION_LIFETIME_MS, type Confirmation } from "./controller.ts";
import { parseSetupCode } from "./parse.ts";
import type { RouteStore, SshRouteRecord } from "./routes.ts";
import { sshLook, type SshLook } from "./ssh-look.ts";

/** The host's dialog, with a checkbox the person must tick for some operations (§2). */
export type HostQuestion = Confirmation & { checkbox?: string };
export type HostAnswer = { confirmed: boolean; checked: boolean };

/** Why this host offers no SSH route: its app files aren't proven private, or its `ssh` can't be used. */
export type TransportRefusal = { refused: "app-files-unsafe" | "not-supported" };

export type RemoteSetupOptions = {
  client: ClawtrateClient;
  /**
   * The SSH transport, made once and only after the app-data privacy check
   * passed (`private-dir.ts`), or why there is none.
   */
  transport: () => SshTransport | TransportRefusal;
  routes: RouteStore;
  /** The host's native dialog, or null where it has none. */
  ask: ((question: HostQuestion) => Promise<HostAnswer>) | null;
  /** The setup slice's main part, and its route part (`SetupSlice`). */
  publish: (next: SetupState) => void;
  publishRoute: (route: RouteStatus | null) => void;
  log?: (line: string) => void;
  now?: () => number;
  /** How long the strip says "connected again" (§8). */
  restoredMs?: number;
  /** How long Connect waits for the forward to come up. */
  forwardWaitMs?: number;
};

/**
 * How far the other computer's clock may be ahead of this one's when a code
 * made there is checked: a code lives ten minutes from when it was made there.
 */
export const CODE_CLOCK_SKEW_MS = 2 * 60_000;
/** After Start, the LOOK is repeated this many times, this far apart, for the gateway to come up. */
const START_LOOKS = 10;
const START_LOOK_GAP_MS = 2_000;

/** A route's key: what identifies it, never the forward's local port (docs/decisions.md, "Routes"). */
export function sshRouteKey(parts: {
  fingerprint: string;
  endpoint: string;
  gatewayPort: number;
  profile: "default" | "clawtrate";
}): string {
  const digest = createHash("sha256")
    .update(`ssh\n${parts.fingerprint}\n${parts.endpoint}\n${parts.gatewayPort}\n${parts.profile}`)
    .digest("hex");
  return `ssh-${digest.slice(0, 24)}`;
}

const newRouteId = () => `r${randomBytes(6).toString("hex")}`;

const emptyThere = (destination: string): SshSetup => ({
  destination,
  account: null,
  name: null,
  port: null,
  invalid: false,
  refusal: null,
  key: null,
  failure: null,
});

/** What a failure of `ssh` is shown as (§5): the three failures, and the rest in fixed copy. */
function failureOf(failure: SshFailure): {
  kind: SshFailureKind;
  cause: UnreachableWords | null;
  exit: number | null;
} {
  switch (failure.kind) {
    case "unreachable":
      return { kind: "unreachable", cause: failure.cause, exit: failure.exit };
    case "sign-in-refused":
      return { kind: "sign-in-refused", cause: null, exit: failure.exit };
    case "timed-out":
      return { kind: "timed-out", cause: null, exit: null };
    case "spawn-failed":
      return { kind: "spawn-failed", cause: null, exit: null };
    default:
      return { kind: "ssh-stopped", cause: null, exit: "exit" in failure ? failure.exit : null };
  }
}

/** The route the app is connected through: its record, prepared route, forward and watchers. */
type Live = {
  record: SshRouteRecord;
  route: Route;
  forward: ForwardSupervisor;
  /** The forward's local address the client was last given. */
  url: string;
  status: RouteStatus;
  stop: Array<() => void>;
  restoredTimer: ReturnType<typeof setTimeout> | null;
};

export class RemoteSetup {
  private readonly options: RemoteSetupOptions;
  private readonly now: () => number;
  private transportMade: SshTransport | TransportRefusal | null = null;
  private state: SetupState = initialSetupState;
  /** Counts attempts; anything finishing for an older one is dropped. */
  private attempt = 0;
  private route: Route | null = null;
  private capture: { captureId: string; replaces: boolean } | null = null;
  /** The pinned key's fingerprint, once the route is pinned. */
  private fingerprint: string | null = null;
  private found: SshLook | null = null;
  /** The setup attempt's forward and record, until it becomes live or is let go. */
  private pending: {
    forward: ForwardSupervisor | null;
    record: SshRouteRecord | null;
    fresh: boolean;
    url: string | null;
  } | null = null;
  private live: Live | null = null;
  /** A gateway Clawtrate started over SSH, by its route's endpoint, profile and port. */
  private started = new Set<string>();
  /** Every local address a route's forward has had: only the current one while it is up is allowed. */
  private readonly localUrls = new Set<string>();
  private watching: (() => void) | null = null;

  constructor(options: RemoteSetupOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  get current(): SetupState {
    return this.state;
  }

  /** Whether setup is on another computer now: the router sends Connect, Back and Cancel here. */
  get active(): boolean {
    return this.state.there !== undefined && this.state.there !== null;
  }

  private publish(next: SetupState): void {
    this.state = next;
    this.options.publish(next);
  }

  private log(line: string): void {
    this.options.log?.(`[setup] ${line}`);
  }

  private withThere(patch: Partial<SshSetup>): SshSetup {
    return { ...(this.state.there ?? emptyThere("")), ...patch };
  }

  private transport(): SshTransport | TransportRefusal {
    this.transportMade ??= this.options.transport();
    return this.transportMade;
  }

  private failThere(failure: SshSetup["failure"], look = this.state.look): void {
    this.publish({ ...this.state, phase: "failed", look, there: this.withThere({ failure }) });
  }

  /**
   * Whether the client may open a socket to `url` now: a route's forward
   * address only while that forward is up there, and null for an address no
   * route ever had, which the host's other rules decide.
   */
  allows(url: string): boolean | null {
    if (!this.localUrls.has(url)) return null;
    const forward = this.live?.url === url ? this.live.forward : null;
    const pending = this.pending?.url === url ? this.pending.forward : null;
    const holder = forward ?? pending;
    if (!holder) return false;
    const state = holder.state;
    return state.phase === "up" && `ws://127.0.0.1:${state.localPort}` === url;
  }

  /** Where the owner approves a request for the gateway at `url` (§9), when it is a route's. */
  placeFor(url: string): ApprovalPlace | null {
    const holder =
      this.live?.url === url
        ? this.live.record
        : this.pending?.url === url
          ? this.pending.record
          : null;
    return holder ? { route: "ssh", where: holder.name, profile: holder.profile } : null;
  }

  /** Look on another computer for what was typed (§5). */
  async there(destination: string): Promise<void> {
    const attempt = (this.attempt += 1);
    this.stopWatching();
    await this.letGoPending();
    if (attempt !== this.attempt) return;
    this.route = null;
    this.capture = null;
    this.found = null;
    this.fingerprint = null;
    const base = emptyThere(destination);
    const transport = this.transport();
    if ("refused" in transport) {
      this.publish({
        ...initialSetupState,
        phase: "failed",
        there: { ...base, failure: { kind: transport.refused, cause: null, exit: null } },
      });
      return;
    }
    // A computer saved before keeps its route id, so its pinned key is checked, never replaced by itself.
    const saved = this.options.routes.list().find((route) => route.destination === destination);
    let prepared = transport.prepareRoute(saved?.id ?? newRouteId(), destination);
    if (!prepared.ok && prepared.kind === "forward-open")
      prepared = transport.prepareRoute(newRouteId(), destination);
    if (!prepared.ok) {
      if (prepared.kind === "invalid-destination") {
        this.publish({ ...initialSetupState, there: { ...base, invalid: true } });
      } else if (prepared.kind === "refused") {
        this.publish({
          ...initialSetupState,
          there: {
            ...base,
            refusal: {
              category: prepared.category,
              setting: prepared.setting,
              title: prepared.title,
              sentence: prepared.sentence,
            },
          },
        });
      } else {
        this.publish({
          ...initialSetupState,
          phase: "failed",
          there: {
            ...base,
            failure: { kind: "app-files-unsafe", cause: null, exit: null },
          },
        });
      }
      return;
    }
    this.route = prepared;
    const there: SshSetup = {
      ...base,
      account: prepared.account,
      name: prepared.target.name,
      port: prepared.target.port,
    };
    const ask = this.options.ask;
    if (!ask) {
      this.publish({
        ...initialSetupState,
        phase: "failed",
        there: { ...there, failure: { kind: "not-supported", cause: null, exit: null } },
      });
      return;
    }
    this.publish({ ...initialSetupState, phase: "confirming", there });
    // The full resolved account, host and port, before anything runs there (rule 3).
    const answer = await this.askSafely({
      message: `Look for OpenClaw as ${prepared.accountWithPort}?`,
      detail: "This uses the remote account's SSH login environment.",
      confirm: "Look",
    });
    if (attempt !== this.attempt) return;
    if (!answer.confirmed) {
      // Back to the field, with what was typed still in it.
      this.publish({ ...initialSetupState, there });
      return;
    }
    await this.reach(attempt);
  }

  private async askSafely(question: HostQuestion): Promise<HostAnswer> {
    try {
      return (await this.options.ask?.(question)) ?? { confirmed: false, checked: false };
    } catch {
      return { confirmed: false, checked: false };
    }
  }

  /** "Reaching devbox": where the route's key stands, then the look (§5). */
  private async reach(attempt: number): Promise<void> {
    const transport = this.transport();
    const route = this.route;
    if ("refused" in transport || !route) return;
    this.publish({
      ...this.state,
      phase: "looking",
      step: 0,
      slow: false,
      look: null,
      failure: null,
      there: this.withThere({ key: null, failure: null }),
    });
    const check = await transport.checkHostKey(route);
    if (attempt !== this.attempt) return;
    if (check.ok) {
      if (check.state === "pinned" || check.state === "pinned-from-known-hosts") {
        this.fingerprint = check.fingerprint;
        this.capture = null;
        await this.lookThere(attempt);
        return;
      }
      this.capture = { captureId: check.presented.captureId, replaces: check.state === "changed" };
      this.publish({
        ...this.state,
        phase: "key",
        there: this.withThere({
          key: {
            state: check.state,
            presented: { label: check.presented.label, fingerprint: check.presented.fingerprint },
            trusted: check.state === "changed" ? check.trusted : null,
          },
        }),
      });
      return;
    }
    this.failFromTransport(check);
  }

  private failFromTransport(result: { ok: false; kind: string; failure?: SshFailure }): void {
    if (result.kind === "stale-route") return;
    if (result.kind === "failed" && result.failure) {
      this.failThere(failureOf(result.failure));
      return;
    }
    this.failThere({
      kind:
        result.kind === "app-files-unsafe"
          ? "app-files-unsafe"
          : result.kind === "not-supported-here"
            ? "not-supported"
            : "ssh-stopped",
      cause: null,
      exit: null,
    });
  }

  /** The LOOK over the pinned connection, and the found card (§5, §6). */
  private async lookThere(attempt: number): Promise<void> {
    const transport = this.transport();
    const route = this.route;
    if ("refused" in transport || !route) return;
    this.publish({
      ...this.state,
      phase: "looking",
      step: 1,
      there: this.withThere({ key: null }),
    });
    const result = await transport.look(route);
    if (attempt !== this.attempt) return;
    if (!result.ok) {
      if (result.kind === "cant-tell") {
        this.publish({
          ...this.state,
          phase: "found",
          look: {
            outcome: "cant-tell",
            reason: result.reason === "timed-out" ? "timeout" : "shape",
            version: null,
            profile: null,
            listens: null,
            service: null,
            port: null,
            authMode: null,
            access: null,
            others: [],
          },
        });
        return;
      }
      if (result.kind === "not-pinned") {
        await this.reach(attempt);
        return;
      }
      this.failFromTransport(result);
      return;
    }
    const found = sshLook(result.facts);
    this.found = found;
    let access: "new" | "paired" | null = null;
    if (found.found && this.fingerprint) {
      const key = this.keyFor(route, found.found);
      access = (await this.options.client.hasRouteToken(key).catch(() => false)) ? "paired" : "new";
      if (attempt !== this.attempt) return;
    }
    this.publish({
      ...this.state,
      phase: "found",
      step: 0,
      look: { ...found.look, access },
      failure: null,
    });
  }

  private keyFor(route: Route, found: FoundService): string {
    return sshRouteKey({
      fingerprint: this.fingerprint!,
      endpoint: route.endpoint,
      gatewayPort: found.service.port,
      profile: found.service.profile,
    });
  }

  /** After the host's dialog: pins exactly the key first contact captured (rule 8). */
  async trustKey(): Promise<void> {
    const route = this.route;
    const capture = this.capture;
    const key = this.state.there?.key;
    const transport = this.transport();
    if (
      this.state.phase !== "key" ||
      !route ||
      !capture ||
      capture.replaces ||
      key?.state !== "first-contact" ||
      "refused" in transport
    )
      throw new Error("There is no key to trust. Look again.");
    const attempt = (this.attempt += 1);
    const name = route.target.name;
    const answer = await this.askSafely({
      message: `Trust ${name}'s key?`,
      detail: `${key.presented.label} ${key.presented.fingerprint}\n\nClawtrate will connect to ${name} only while it presents this key.`,
      confirm: "Trust",
    });
    if (attempt !== this.attempt) return;
    if (!answer.confirmed) return;
    const pinned = transport.trustCapturedKey(route, capture.captureId);
    this.capture = null;
    if (!pinned.ok) {
      // Expired, used or changed meanwhile: the key is captured again and shown again.
      await this.reach(attempt);
      return;
    }
    this.fingerprint = pinned.fingerprint;
    await this.lookThere(attempt);
  }

  /** After the host's dialog and its checkbox: replaces a changed key by the one captured (§5). */
  async replaceKey(): Promise<void> {
    const route = this.route;
    const capture = this.capture;
    const key = this.state.there?.key;
    const transport = this.transport();
    if (
      this.state.phase !== "key" ||
      !route ||
      !capture?.replaces ||
      key?.state !== "changed" ||
      !key.trusted ||
      "refused" in transport
    )
      throw new Error("There is no changed key to replace. Look again.");
    const attempt = (this.attempt += 1);
    const name = route.target.name;
    const answer = await this.askSafely({
      message: `Replace ${name}'s trusted key?`,
      detail: `Trusted: ${key.trusted.label} ${key.trusted.fingerprint}\nPresented now: ${key.presented.label} ${key.presented.fingerprint}`,
      confirm: "Replace",
      checkbox: `I checked the new key on ${name} itself`,
    });
    if (attempt !== this.attempt) return;
    // Replace is unavailable until the box is ticked: unticked, nothing is replaced.
    if (!answer.confirmed || !answer.checked) return;
    const replaced = transport.replaceTrustedKey(route, capture.captureId);
    this.capture = null;
    if (!replaced.ok) {
      await this.reach(attempt);
      return;
    }
    this.fingerprint = replaced.fingerprint;
    await this.lookThere(attempt);
  }

  /** Connect (§7 over SSH): the code made there, the forward, a read-only pairing. */
  async connect(): Promise<void> {
    const route = this.route;
    const found = this.found;
    const service = found?.found;
    const transport = this.transport();
    const look = this.state.look;
    if (
      (this.state.phase !== "found" && this.state.phase !== "failed") ||
      !route ||
      !service ||
      look?.outcome !== "running" ||
      !this.fingerprint ||
      "refused" in transport
    )
      throw new Error("There is nothing to connect to. Look again.");
    const attempt = (this.attempt += 1);
    const access = look.access ?? "new";
    const where = `the ${service.service.profile} gateway on ${route.account}`;
    const at = this.now();
    this.publish({
      ...this.state,
      phase: "confirming",
      failure: null,
      there: this.withThere({ failure: null }),
    });
    const answer = await this.askSafely(
      access === "paired"
        ? {
            message: `Connect this device read-only to ${where}?`,
            detail: "This device has a saved pairing for this route.",
            confirm: "Connect read-only",
          }
        : {
            message: `Pair this device read-only with ${where}?`,
            detail:
              "Clawtrate asks for read access. The gateway may ask its owner to approve this device.",
            confirm: "Pair",
          },
    );
    if (attempt !== this.attempt) return;
    if (!answer.confirmed) {
      this.publish({ ...this.state, phase: "found" });
      return;
    }
    if (this.now() - at > OPERATION_LIFETIME_MS) {
      this.publish({ ...this.state, phase: "found" });
      return;
    }
    const key = this.keyFor(route, service);
    const record: SshRouteRecord = {
      kind: "ssh",
      id: route.id,
      key,
      destination: this.state.there?.destination ?? route.target.destination.typed,
      name: route.target.name,
      account: route.account,
      endpoint: route.endpoint,
      fingerprint: this.fingerprint,
      profile: service.service.profile,
      serviceLabel: service.service.serviceLabel as SshRouteRecord["serviceLabel"],
      configPath: service.service.configPath,
      gatewayPort: service.service.port,
      identity: this.options.routes.byKey(key)?.identity ?? null,
      startedByClawtrate:
        this.started.has(
          startedKey(route.endpoint, service.service.profile, service.service.port),
        ) ||
        (this.options.routes.byKey(key)?.startedByClawtrate ?? false),
      lastUsed: this.now(),
    };
    this.publish({ ...this.state, phase: "connecting", step: 0 });
    // Step 1: the code, made there over the pinned connection, unless this route is paired.
    let code: { bootstrapToken: string; expiresAtMs: number } | null = null;
    if (access === "new") {
      const made = await transport.runScript(route, "code", {
        profile: service.service.profile,
        port: service.service.port,
      });
      if (attempt !== this.attempt) return;
      if (!made.ok) {
        if (
          made.kind === "failed" ||
          made.kind === "app-files-unsafe" ||
          made.kind === "not-supported-here"
        ) {
          this.failFromTransport(made);
        } else {
          this.failThere({ kind: "code-failed", cause: null, exit: null });
        }
        return;
      }
      // The same program the look found, or nothing is used.
      if (made.program !== found.program || !made.answer) {
        this.failThere({ kind: "code-failed", cause: null, exit: made.answer?.exit ?? null });
        return;
      }
      const parsed =
        made.answer.exit === 0
          ? parseSetupCode(
              made.answer.text,
              `ws://127.0.0.1:${service.service.port}`,
              this.now() + CODE_CLOCK_SKEW_MS,
            )
          : null;
      if (!parsed) {
        this.failThere({ kind: "code-failed", cause: null, exit: made.answer.exit });
        return;
      }
      code = { bootstrapToken: parsed.bootstrapToken, expiresAtMs: parsed.expiresAtMs };
    }
    // Step 2: the forward to the gateway's port there, up only after a LOOK names the same service.
    this.publish({ ...this.state, step: 1 });
    const opened = await transport.openForward(route, service);
    if (attempt !== this.attempt) {
      if (opened.ok && this.live?.forward !== opened.forward) void opened.forward.close();
      return;
    }
    if (!opened.ok) {
      this.failFromTransport(opened as { ok: false; kind: string });
      return;
    }
    const forward = opened.forward;
    this.pending = { forward, record, fresh: access === "new", url: null };
    const up = await this.waitUp(forward, attempt);
    if (attempt !== this.attempt) return;
    if (up.phase !== "up") {
      await this.letGoPending();
      this.failThere(forwardFailure(up));
      return;
    }
    const url = `ws://127.0.0.1:${up.localPort}`;
    this.localUrls.add(url);
    this.pending.url = url;
    // The route is recorded before its first token, which only the store keeps.
    this.options.routes.put(record);
    this.publish({ ...this.state, step: 2 });
    this.watchConnect(attempt, key);
    await this.options.client.connectRoute({
      url,
      route: key,
      ...(code ? { code } : {}),
      setup: {
        check: () => {
          const state = forward.state;
          return state.phase === "up" && state.localPort === up.localPort;
        },
      },
    });
  }

  /** The forward's first "up", or how it failed, within the wait. */
  private waitUp(forward: ForwardSupervisor, attempt: number): Promise<ForwardState> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (state: ForwardState) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        stop();
        resolve(state);
      };
      const timer = setTimeout(() => finish(forward.state), this.options.forwardWaitMs ?? 45_000);
      const stop = forward.onState((state) => {
        if (attempt !== this.attempt) return finish(state);
        if (state.phase === "up" || state.phase === "closed") finish(state);
        // A forward that fails is shown at its first failure: Connect is the person's to retry.
        else if (state.phase === "waiting") finish(state);
      });
      const now = forward.state;
      if (now.phase === "up" || now.phase === "closed" || now.phase === "waiting") finish(now);
    });
  }

  /** Follows Connect's connection until the bots are read, or it failed (§7). */
  private watchConnect(attempt: number, key: string): void {
    this.stopWatching();
    const client = this.options.client;
    const check = (state: ClawtrateState) => {
      if (attempt !== this.attempt || client.route !== key) return;
      const { connection, discovery } = state;
      if (connection.status === "connected") {
        if (discovery.status === "ready") {
          this.stopWatching();
          void this.becomeLive(key);
          this.publish({ ...this.state, phase: "done", step: 3 });
        } else if (discovery.status === "error") {
          if (this.state.failure?.kind !== "bots")
            this.publish({
              ...this.state,
              phase: "failed",
              failure: { kind: "bots", exitCode: null, port: null, reason: null },
            });
        } else if (this.state.step !== 3) this.publish({ ...this.state, step: 3 });
        return;
      }
      if (connection.status === "error") {
        this.stopWatching();
        const code = connection.error?.code;
        void this.letGoPending();
        this.publish({
          ...this.state,
          phase: "failed",
          failure: {
            kind:
              code === "SETUP_GRANT_REFUSED"
                ? "grant"
                : code === "AUTH_BOOTSTRAP_TOKEN_INVALID"
                  ? "code-refused"
                  : code === "UNREACHABLE"
                    ? "unreachable"
                    : code === SETUP_ENDPOINT_CHANGED || code === SETUP_PAIRING_GONE
                      ? "changed"
                      : "other",
            exitCode: null,
            port: null,
            reason: null,
          },
        });
      }
    };
    this.watching = client.store.subscribe(check);
  }

  private stopWatching(): void {
    this.watching?.();
    this.watching = null;
  }

  /** The setup attempt's forward and new record go, unless they became the live route. */
  private async letGoPending(): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    const client = this.options.client;
    if (
      pending.record &&
      client.route === pending.record.key &&
      this.live?.record.key !== pending.record.key
    ) {
      await client.disconnect();
    }
    if (pending.forward && this.live?.forward !== pending.forward) await pending.forward.close();
    // A route made by this attempt and never connected is forgotten with its token.
    if (pending.fresh && pending.record && this.live?.record.id !== pending.record.id)
      this.options.routes.remove(pending.record.id);
  }

  /** The attempt's forward is the app's route now: its life is the status strip's (§8). */
  private async becomeLive(key: string): Promise<void> {
    const pending = this.pending;
    const route = this.route;
    if (!pending?.forward || !pending.record || !pending.url || !route) return;
    this.pending = null;
    const old = this.live;
    if (old && old.record.id !== pending.record.id)
      await this.closeLive(old, { stopGateway: false, forget: false });
    const record = { ...pending.record, lastUsed: this.now() };
    this.options.routes.put(record);
    const live: Live = {
      record,
      route,
      forward: pending.forward,
      url: pending.url,
      status: {
        name: record.name,
        account: record.account,
        phase: "up",
        cause: null,
        profile: record.profile,
        startedByClawtrate: record.startedByClawtrate,
      },
      stop: [],
      restoredTimer: null,
    };
    this.live = live;
    this.followLive(live, key);
    this.setStatus(live, live.status);
  }

  private setStatus(live: Live, status: RouteStatus): void {
    live.status = status;
    if (this.live === live) this.options.publishRoute(status);
  }

  /** The forward's drops and returns, and the gateway's identity after every hello (§8, §15). */
  private followLive(live: Live, key: string): void {
    const client = this.options.client;
    const status = (patch: Partial<RouteStatus>) =>
      this.setStatus(live, { ...live.status, ...patch });
    let down = false;
    live.stop.push(
      live.forward.onState((state) => {
        if (this.live !== live) return;
        if (state.phase === "up") {
          if (!down) return;
          down = false;
          const url = `ws://127.0.0.1:${state.localPort}`;
          this.localUrls.add(url);
          live.url = url;
          // Back: the route's own token, sent by itself to the gateway's port on the pinned computer.
          void client.connectRoute({ url, route: key });
          status({ phase: "restored", cause: null });
          if (live.restoredTimer) clearTimeout(live.restoredTimer);
          live.restoredTimer = setTimeout(() => {
            if (this.live === live && live.status.phase === "restored") status({ phase: "up" });
          }, this.options.restoredMs ?? 4_000);
          return;
        }
        if (state.phase === "closed") {
          if (state.reason === "closed") return;
          down = true;
          client.holdRoute(key);
          if (state.reason === "different-gateway") {
            void client.dropRouteToken(key);
            status({ phase: "different-gateway", cause: null });
          } else status({ phase: "key-changed", cause: null });
          return;
        }
        if (!down) {
          down = true;
          client.holdRoute(key);
        }
        if (state.phase === "waiting") {
          const cause = state.cause;
          if (cause.kind === "gateway-not-running") status({ phase: "stopped", cause: null });
          else if (state.longOutage)
            status({
              phase: "unreachable",
              cause: cause.kind === "unreachable" ? cause.cause : null,
            });
          else status({ phase: "restoring", cause: null });
        } else if (live.status.phase !== "unreachable") status({ phase: "restoring", cause: null });
      }),
    );
    live.stop.push(
      client.store.subscribe((state) => {
        if (this.live !== live || client.route !== key) return;
        const id = state.connection.gatewayId;
        if (state.connection.status !== "connected" || !id) return;
        if (live.record.identity === null) {
          live.record = { ...live.record, identity: id };
          this.options.routes.put(live.record);
          return;
        }
        if (id !== live.record.identity) {
          // Not that gateway any more: disconnected, its token dropped, nothing sent again by itself.
          client.holdRoute(key);
          void client.dropRouteToken(key);
          void live.forward.close();
          status({ phase: "different-gateway", cause: null });
        }
      }),
    );
  }

  /**
   * The status strip's "Retry now" while the forward is being restored, and
   * its "Review" when the key changed, a different gateway answered or the
   * gateway stopped (§8): that computer's screens again, from the account's
   * confirmation, with the route's record and pin kept.
   */
  async retryRoute(): Promise<void> {
    const live = this.live;
    if (!live) return;
    const phase = live.status.phase;
    if (phase === "key-changed" || phase === "different-gateway" || phase === "stopped") {
      const destination = live.record.destination;
      await this.closeLive(live, { stopGateway: false, forget: false });
      await this.there(destination);
      return;
    }
    if (live.forward.state.phase === "waiting") live.forward.retryNow();
  }

  /** Start OpenClaw there, when the look proved it stopped (F-497), after the host's dialog. */
  async start(): Promise<void> {
    const route = this.route;
    const stopped = this.found?.stopped;
    const transport = this.transport();
    if (
      this.state.phase !== "found" ||
      this.state.look?.outcome !== "stopped" ||
      !route ||
      !stopped ||
      "refused" in transport
    )
      throw new Error("There is nothing to start. Look again.");
    const attempt = (this.attempt += 1);
    const label = stopped.label?.label ?? "service";
    const answer = await this.askSafely({
      message: `Start OpenClaw on ${route.target.name}?`,
      detail: `Starts the ${stopped.profile} profile's ${label} there. It keeps running after Clawtrate closes.`,
      confirm: "Start",
    });
    if (attempt !== this.attempt || !answer.confirmed) return;
    // The facts again after the answer: still proven stopped, the same profile and port.
    const again = await transport.look(route);
    if (attempt !== this.attempt) return;
    const still = again.ok ? sshLook(again.facts).stopped : null;
    if (!still || still.profile !== stopped.profile || still.port !== stopped.port) {
      this.publish({
        ...this.state,
        phase: "failed",
        failure: { kind: "changed", exitCode: null, port: null, reason: null },
      });
      return;
    }
    this.publish({ ...this.state, phase: "connecting", step: 0 });
    const ran = await transport.runScript(route, "start", {
      profile: stopped.profile,
      port: stopped.port,
    });
    if (attempt !== this.attempt) return;
    if (!ran.ok || !ran.answer || ran.answer.exit !== 0) {
      if (!ran.ok && ran.kind === "failed") this.failFromTransport(ran);
      else
        this.failThere({
          kind: "start-failed",
          cause: null,
          exit: ran.ok ? (ran.answer?.exit ?? null) : null,
        });
      return;
    }
    // Clawtrate's record: it started this gateway (rule 9), so Remove may offer to stop it.
    this.started.add(startedKey(route.endpoint, stopped.profile, stopped.port));
    this.publish({ ...this.state, step: 1 });
    for (let i = 0; i < START_LOOKS; i += 1) {
      const look = await transport.look(route);
      if (attempt !== this.attempt) return;
      const now = look.ok ? sshLook(look.facts) : null;
      if (
        now?.found &&
        now.found.service.profile === stopped.profile &&
        now.found.service.port === stopped.port
      ) {
        await this.lookThere(attempt);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, START_LOOK_GAP_MS));
      if (attempt !== this.attempt) return;
    }
    this.failThere({ kind: "start-failed", cause: null, exit: null });
  }

  /**
   * Settings, Gateway, "Remove this gateway…" (§8): after the host's dialog,
   * the forward is stopped by its PID, the route and its pinned key and token
   * are forgotten, and the gateway there is stopped only when Clawtrate
   * started it and the box was ticked.
   */
  async removeRoute(): Promise<void> {
    const live = this.live;
    if (!live) throw new Error("There is no route to another computer to remove.");
    const name = live.record.name;
    const answer = await this.askSafely({
      message: `Remove ${name} from Clawtrate?`,
      detail: `Clawtrate disconnects, forgets this route and its pinned key, and leaves OpenClaw on ${name} running.`,
      confirm: "Remove",
      ...(live.record.startedByClawtrate
        ? { checkbox: `Also stop OpenClaw on ${name} (Clawtrate started it).` }
        : {}),
    });
    if (this.live !== live || !answer.confirmed) return;
    this.attempt += 1;
    this.stopWatching();
    await this.closeLive(live, {
      stopGateway: answer.checked && live.record.startedByClawtrate,
      forget: true,
    });
    this.publish(initialSetupState);
  }

  private async closeLive(
    live: Live,
    { stopGateway, forget }: { stopGateway: boolean; forget: boolean },
  ): Promise<void> {
    if (this.live === live) this.live = null;
    for (const stop of live.stop) stop();
    if (live.restoredTimer) clearTimeout(live.restoredTimer);
    const client = this.options.client;
    if (client.route === live.record.key) await client.disconnect();
    await live.forward.close();
    const transport = this.transport();
    if (!("refused" in transport)) {
      if (stopGateway) {
        const stopped = await transport.runScript(live.route, "stop", {
          profile: live.record.profile,
          port: live.record.gatewayPort,
        });
        this.log(
          stopped.ok && stopped.answer?.exit === 0
            ? "Stopped the gateway Clawtrate started on the other computer."
            : "The gateway Clawtrate started on the other computer didn't confirm it stopped.",
        );
      }
      if (forget) transport.forget(live.route);
    }
    if (forget) {
      this.options.routes.remove(live.record.id);
      await client.dropRouteToken(live.record.key);
    }
    this.options.publishRoute(null);
  }

  /**
   * At launch, the route the app was connected through, when the client's
   * saved connection names it: the same endpoint, pinned key and gateway
   * service, then the forward, then the route's own token (§8, §15). Nothing
   * is asked: the pinned computer is authenticated first. Anything that
   * differs ends here, and the first screen shows.
   */
  async resume(): Promise<void> {
    const saved = await this.options.client.savedSettings();
    const record = saved?.route ? this.options.routes.byKey(saved.route) : null;
    if (!record || saved?.suspended) return;
    const transport = this.transport();
    if ("refused" in transport) return;
    const attempt = (this.attempt += 1);
    const route = transport.prepareRoute(record.id, record.destination);
    if (!route.ok || route.endpoint !== record.endpoint) return;
    this.route = route;
    const there: SshSetup = {
      ...emptyThere(record.destination),
      account: route.account,
      name: route.target.name,
      port: route.target.port,
    };
    this.publish({ ...initialSetupState, phase: "connecting", step: 1, there });
    const check = await transport.checkHostKey(route);
    if (attempt !== this.attempt) return;
    if (!check.ok || check.state !== "pinned" || check.fingerprint !== record.fingerprint) {
      this.publish({ ...initialSetupState, there });
      return;
    }
    this.fingerprint = check.fingerprint;
    const look = await transport.look(route);
    if (attempt !== this.attempt) return;
    const now = look.ok ? serviceOnPort(look.facts, record.gatewayPort) : null;
    const expected = {
      profile: record.profile,
      serviceLabel: record.serviceLabel,
      configPath: record.configPath,
      port: record.gatewayPort,
    };
    if (!now?.ok || !sameService(now.service, expected)) {
      if (look.ok) {
        this.found = sshLook(look.facts);
        this.publish({ ...initialSetupState, phase: "found", look: this.found.look, there });
      } else this.publish({ ...initialSetupState, there });
      return;
    }
    const opened = await transport.openForward(route, now);
    if (attempt !== this.attempt || !opened.ok) return;
    this.found = sshLook(look.ok ? look.facts : emptyFacts());
    this.pending = { forward: opened.forward, record, fresh: false, url: null };
    const up = await this.waitUp(opened.forward, attempt);
    if (attempt !== this.attempt) return;
    if (up.phase !== "up") {
      await this.letGoPending();
      this.failThere(forwardFailure(up));
      return;
    }
    const url = `ws://127.0.0.1:${up.localPort}`;
    this.localUrls.add(url);
    this.pending.url = url;
    this.publish({ ...this.state, step: 2 });
    this.watchConnect(attempt, record.key);
    await this.options.client.connectRoute({ url, route: record.key });
  }

  /** Back from a wait or a failure: to the card, or to the field. */
  cancel(): void {
    const phase = this.state.phase;
    this.attempt += 1;
    this.stopWatching();
    void this.letGoPending();
    if (phase === "connecting" || phase === "failed" || phase === "confirming") {
      if (this.state.look && this.found) {
        this.publish({
          ...this.state,
          phase: "found",
          failure: null,
          there: this.withThere({ failure: null }),
        });
        return;
      }
    }
    this.publish({
      ...initialSetupState,
      there: this.state.there ? emptyThere(this.state.there.destination) : null,
    });
  }

  /** Back to the first screen. The live route, if any, is left as it is. */
  reset(): void {
    this.attempt += 1;
    this.stopWatching();
    void this.letGoPending();
    this.route = null;
    this.capture = null;
    this.found = null;
    if (this.state.there !== undefined && this.state.there !== null)
      this.publish(initialSetupState);
    else this.state = initialSetupState;
  }

  /** Ends every forward and `ssh` this host started, by PID. */
  async closeAll(): Promise<void> {
    this.attempt += 1;
    this.stopWatching();
    const live = this.live;
    this.live = null;
    if (live) for (const stop of live.stop) stop();
    const transport = this.transportMade;
    if (transport && !("refused" in transport)) await transport.closeAll();
  }
}

const startedKey = (endpoint: string, profile: string, port: number) =>
  `${endpoint}\n${profile}\n${port}`;

/** A forward that didn't come up, in the failure section 5 or 8 names. */
function forwardFailure(state: ForwardState): SshSetup["failure"] {
  if (state.phase === "waiting") {
    const cause = state.cause;
    switch (cause.kind) {
      case "unreachable":
        return { kind: "unreachable", cause: cause.cause, exit: null };
      case "sign-in-refused":
        return { kind: "sign-in-refused", cause: null, exit: null };
      case "forwarding-refused":
        return { kind: "forwarding-refused", cause: null, exit: null };
      case "gateway-not-answering":
      case "gateway-not-running":
        return { kind: "gateway-not-answering", cause: null, exit: null };
      case "timed-out":
        return { kind: "timed-out", cause: null, exit: null };
      case "spawn-failed":
        return { kind: "spawn-failed", cause: null, exit: null };
      case "ssh-stopped":
        return { kind: "ssh-stopped", cause: null, exit: cause.exit };
      default:
        return { kind: "ssh-stopped", cause: null, exit: null };
    }
  }
  return { kind: "ssh-stopped", cause: null, exit: null };
}

function emptyFacts() {
  return {
    system: null,
    program: null,
    version: null,
    gateways: [],
    signs: {
      defaultState: false,
      defaultService: false,
      clawtrateState: false,
      clawtrateService: false,
    },
  };
}
