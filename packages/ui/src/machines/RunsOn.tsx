// Where a bot runs (controls.md section 14): the Runs on row of a bot's
// Settings tab and its page. Three settings kept apart, each shown as the
// gateway's settings store it or as the gateway reports it: the machine named
// for its commands, its workspace, what its settings say about the browser.
// Then what its settings name, as inventory. Nothing is inferred from them.
// Nothing is kept: the page reads the gateway when it opens and after a save.
// Each part is read apart and drawn when its own read answers.

import {
  PLACEMENT_PARTS,
  type ConnectionState,
  type HostInfo,
  type PlacementPart,
  type PlacementParts,
} from "@clawtrate/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useBridge } from "../bridge.tsx";
import { CopyValue } from "../AccessBar.tsx";
import { clockTime } from "../format.ts";
import { BackIcon, ChevronIcon, EyeIcon, LockIcon, WarnIcon } from "../icons.tsx";
import { AdminBar, GrantedBar, Note, Select } from "../bots/parts.tsx";
import {
  credentialWords,
  hostWords,
  lastSeen,
  listWords,
  names,
  runsOnValue,
  switchWords,
} from "./words.ts";
import "./machines.css";

type Read<T> =
  { status: "loading" } | { status: "error"; message: string } | { status: "ready"; value: T };

/** Each part of where a bot runs, as far as its own read has answered. */
export type Placement = { [P in PlacementPart]: Read<PlacementParts[P]> };

/** The connection and the access a read or a form belongs to. */
export const connectionKey = (connection: ConnectionState) =>
  [
    connection.status,
    connection.gatewayUrl ?? "",
    connection.deviceId ?? "",
    connection.connectedAt ?? "",
    connection.scopes.join(" "),
  ].join("\n");

const fallbackScope = (connection: ConnectionState) =>
  `connection:${connection.target}\n${connectionKey(connection)}`;

const confirmedScope = (gatewayId: string) => `gateway:${gatewayId}`;

/**
 * Which gateway a placement save belongs to: its confirmed identity, or a key
 * local to this connection while that identity isn't known yet.
 */
const placementScope = (connection: ConnectionState) =>
  connection.gatewayId ? confirmedScope(connection.gatewayId) : fallbackScope(connection);

const OTHER_PLACEMENT_PARTS = PLACEMENT_PARTS.filter((part) => part !== "commands");

// `commandsSeq` moves with every save on the gateway, `workspaceSeq` with every workspace save
// (another bot's folder can now be the same as this one's), and `botSeqs` with a bot's own saves.
type SaveEntry = {
  pending: number;
  commandsSeq: number;
  workspaceSeq: number;
  botSeqs: Record<string, number>;
};

const EMPTY_SAVE: SaveEntry = { pending: 0, commandsSeq: 0, workspaceSeq: 0, botSeqs: {} };

/** A fallback scope whose saves were still out when its gateway was confirmed, and how many. */
type Redirect = { to: string; pending: number };

type SavesState = {
  seq: number;
  entries: Record<string, SaveEntry>;
  redirects: Record<string, Redirect>;
};

export const EMPTY_SAVES: SavesState = { seq: 0, entries: {}, redirects: {} };

const resolveScope = (state: SavesState, scope: string) => state.redirects[scope]?.to ?? scope;

/** The redirects once a save under `rawScope` begins (+1) or ends (-1): one is kept while its saves are out. */
function countRedirect(state: SavesState, rawScope: string, by: 1 | -1): SavesState["redirects"] {
  const redirect = state.redirects[rawScope];
  if (!redirect) return state.redirects;
  const { [rawScope]: _, ...rest } = state.redirects;
  const pending = redirect.pending + by;
  return pending > 0 ? { ...rest, [rawScope]: { ...redirect, pending } } : rest;
}

export function promoteScope(state: SavesState, fallback: string, confirmed: string): SavesState {
  const carried = state.entries[fallback];
  if (!carried) return state;
  // Only a save still out under the fallback finishes through it; each connection has its own.
  const redirects =
    carried.pending > 0
      ? { ...state.redirects, [fallback]: { to: confirmed, pending: carried.pending } }
      : state.redirects;
  const existing = state.entries[confirmed] ?? EMPTY_SAVE;
  const botSeqs: Record<string, number> = { ...existing.botSeqs };
  for (const [botId, seq] of Object.entries(carried.botSeqs)) {
    botSeqs[botId] = Math.max(botSeqs[botId] ?? 0, seq);
  }
  const entries = { ...state.entries };
  delete entries[fallback];
  entries[confirmed] = {
    pending: existing.pending + carried.pending,
    commandsSeq: Math.max(existing.commandsSeq, carried.commandsSeq),
    workspaceSeq: Math.max(existing.workspaceSeq, carried.workspaceSeq),
    botSeqs,
  };
  return { ...state, entries, redirects };
}

export function beginSave(state: SavesState, rawScope: string): SavesState {
  const scope = resolveScope(state, rawScope);
  const was = state.entries[scope] ?? EMPTY_SAVE;
  return {
    ...state,
    entries: { ...state.entries, [scope]: { ...was, pending: was.pending + 1 } },
    redirects: countRedirect(state, rawScope, 1),
  };
}

/** A command save ended: every bot's commands and the saving bot's whole placement are read again. */
export function finishSave(state: SavesState, rawScope: string, botId: string): SavesState {
  const scope = resolveScope(state, rawScope);
  const was = state.entries[scope] ?? EMPTY_SAVE;
  const seq = state.seq + 1;
  return {
    seq,
    entries: {
      ...state.entries,
      [scope]: {
        ...was,
        pending: Math.max(0, was.pending - 1),
        commandsSeq: seq,
        botSeqs: { ...was.botSeqs, [botId]: seq },
      },
    },
    redirects: countRedirect(state, rawScope, -1),
  };
}

/** What a bot's parts other than commands follow: its own saves and any workspace save. */
const otherSeq = (entry: SaveEntry | undefined, botId: string) =>
  Math.max(entry?.botSeqs[botId] ?? 0, entry?.workspaceSeq ?? 0);

/** A workspace save settled: every bot's commands and workspace are read again. */
function settleSave(state: SavesState, rawScope: string): SavesState {
  const scope = resolveScope(state, rawScope);
  const was = state.entries[scope] ?? EMPTY_SAVE;
  const seq = state.seq + 1;
  return {
    ...state,
    seq,
    entries: { ...state.entries, [scope]: { ...was, commandsSeq: seq, workspaceSeq: seq } },
  };
}

type PlacementSaves = {
  seq: number;
  entries: Record<string, SaveEntry>;
  begin: (scope: string, botId: string) => () => void;
  settled: (scope: string) => void;
  commandsSeqOf: (scope: string) => number;
  otherSeqOf: (scope: string, botId: string) => number;
};

const PlacementSavesContext = createContext<PlacementSaves | null>(null);

/**
 * Tracks in-flight placement saves and completion reloads above Work, keyed by
 * confirmed gateway id (with a connection-local fallback while unknown) so
 * closing Work or switching bots keeps a save's pending state and refresh, and
 * another gateway at the same address is never affected by it.
 */
export function PlacementSavesProvider({
  connection,
  children,
}: {
  connection: ConnectionState;
  children: ReactNode;
}) {
  const [state, setState] = useState<SavesState>(EMPTY_SAVES);
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  const fallback = fallbackScope(connection);
  if (!connection.gatewayId) {
    if (unconfirmed !== fallback) setUnconfirmed(fallback);
  } else if (unconfirmed !== null || state.entries[fallback]) {
    const confirmed = confirmedScope(connection.gatewayId);
    if (unconfirmed !== null) setUnconfirmed(null);
    if (unconfirmed === fallback || state.entries[fallback]) {
      setState((current) => promoteScope(current, fallback, confirmed));
    }
  }
  // Mirrors the latest saves state synchronously so reads started before a
  // save settles are dropped immediately, before the reload render commits.
  const mirror = useRef<SavesState>(EMPTY_SAVES);
  useLayoutEffect(() => {
    mirror.current = state;
  }, [state]);
  const commandsSeqOf = useCallback((scope: string) => {
    const target = resolveScope(mirror.current, scope);
    return mirror.current.entries[target]?.commandsSeq ?? 0;
  }, []);
  const otherSeqOf = useCallback(
    (scope: string, botId: string) =>
      otherSeq(mirror.current.entries[resolveScope(mirror.current, scope)], botId),
    [],
  );
  const settled = useCallback((scope: string) => {
    mirror.current = settleSave(mirror.current, scope);
    setState((current) => settleSave(current, scope));
  }, []);
  const begin = useCallback((scope: string, botId: string) => {
    mirror.current = beginSave(mirror.current, scope);
    setState((current) => beginSave(current, scope));
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      mirror.current = finishSave(mirror.current, scope, botId);
      setState((current) => finishSave(current, scope, botId));
    };
  }, []);
  const value = useMemo<PlacementSaves>(
    () => ({ seq: state.seq, entries: state.entries, begin, settled, commandsSeqOf, otherSeqOf }),
    [state.seq, state.entries, begin, settled, commandsSeqOf, otherSeqOf],
  );
  return <PlacementSavesContext.Provider value={value}>{children}</PlacementSavesContext.Provider>;
}

type ReadBatch = { sessionId: number; generation: number; seq: number };

/**
 * A bot's placement, its parts read when shown and again on `reload()`. A read
 * belongs to the bot and the connection's access it was made for: while another
 * bot's, an earlier connection's or other scopes' read is all there is, nothing
 * is drawn. Each part is kept as soon as its own read answers, with the reload
 * it was read after: `commandsCurrent` says the commands part shown was read
 * after the latest `reload()`, so a choice made over it isn't made over a
 * revision a save since has replaced, whichever page asked for that reload.
 */
export function usePlacement(botId: string, connection: ConnectionState, active: boolean) {
  const bridge = useBridge();
  const saves = useContext(PlacementSavesContext);
  // Every bot on a gateway writes against the same config revision.
  const scope = placementScope(connection);
  const entry = saves?.entries[scope] ?? EMPTY_SAVE;
  const botSeq = otherSeq(entry, botId);
  const currentSeq = saves?.seq ?? 0;
  const savesBegin = saves?.begin ?? null;
  const savesSettled = saves?.settled ?? null;
  const commandsSeqOf = saves?.commandsSeqOf ?? null;
  const otherSeqOf = saves?.otherSeqOf ?? null;
  const connected = connection.status === "connected";
  // Read again when the granted scopes change, not when a snapshot brings an equal list.
  const key = `${botId}\n${connectionKey(connection)}`;
  // Stay on the same session when this connection confirms its gateway id (null -> id);
  // start a fresh session when the bot, connection, access or confirmed gateway changes.
  const [session, setSession] = useState<{
    key: string;
    gatewayId: string | null;
    id: number;
  }>(() => ({ key, gatewayId: connection.gatewayId, id: 0 }));
  let sessionId = session.id;
  if (session.key !== key) {
    sessionId = session.id + 1;
    setSession({ key, gatewayId: connection.gatewayId, id: sessionId });
  } else if (session.gatewayId !== connection.gatewayId && connection.gatewayId !== null) {
    sessionId = session.gatewayId === null ? session.id : session.id + 1;
    setSession({ key, gatewayId: connection.gatewayId, id: sessionId });
  }
  const [held, setHeld] = useState<{
    sessionId: number;
    parts: Partial<Placement>;
    at: Partial<Record<PlacementPart, ReadBatch>>;
  } | null>(null);
  // The latest local reload asked for, as rendered.
  const [generation, setGeneration] = useState(0);
  // Bumped as soon as a reload is asked, so the reads started before it are dropped at once,
  // not only once the reload's render ends them.
  const asked = useRef(0);
  // Fallback pending count when rendered outside PlacementSavesProvider.
  const [localWriting, setLocalWriting] = useState(0);
  const writing = saves ? entry.pending : localWriting;
  const [commandsBatch, setCommandsBatch] = useState<ReadBatch>(() => ({
    sessionId,
    generation: 0,
    seq: currentSeq,
  }));
  if (
    commandsBatch.sessionId !== sessionId ||
    commandsBatch.generation !== generation ||
    commandsBatch.seq < entry.commandsSeq
  ) {
    setCommandsBatch({ sessionId, generation, seq: currentSeq });
  }
  const [otherBatch, setOtherBatch] = useState<ReadBatch>(() => ({
    sessionId,
    generation: 0,
    seq: currentSeq,
  }));
  if (
    otherBatch.sessionId !== sessionId ||
    otherBatch.generation !== generation ||
    otherBatch.seq < botSeq
  ) {
    setOtherBatch({ sessionId, generation, seq: currentSeq });
  }
  const scopeRef = useRef(scope);
  useLayoutEffect(() => {
    scopeRef.current = scope;
  }, [scope]);
  useEffect(() => {
    if (!active || !connected) return;
    if (commandsBatch.sessionId !== sessionId) return;
    let live = true;
    const req = commandsBatch;
    const keep = (part: Partial<Placement>) =>
      live &&
      req.generation === asked.current &&
      (!commandsSeqOf || req.seq >= commandsSeqOf(scopeRef.current)) &&
      setHeld((was) => {
        const same = was?.sessionId === req.sessionId;
        return {
          sessionId: req.sessionId,
          parts: { ...(same ? was.parts : {}), ...part },
          at: { ...(same ? was.at : {}), commands: req },
        };
      });
    bridge.invoke({ type: "readPlacement", botId, part: "commands" }).then(
      (value) => keep({ commands: { status: "ready", value } }),
      (error: unknown) =>
        keep({
          commands: {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        }),
    );
    return () => {
      live = false;
    };
  }, [bridge, botId, active, connected, commandsBatch, sessionId, commandsSeqOf]);
  useEffect(() => {
    if (!active || !connected) return;
    if (otherBatch.sessionId !== sessionId) return;
    let live = true;
    const req = otherBatch;
    const keep = (name: PlacementPart, part: Partial<Placement>) =>
      live &&
      req.generation === asked.current &&
      (!otherSeqOf || req.seq >= otherSeqOf(scopeRef.current, botId)) &&
      setHeld((was) => {
        const same = was?.sessionId === req.sessionId;
        return {
          sessionId: req.sessionId,
          parts: { ...(same ? was.parts : {}), ...part },
          at: { ...(same ? was.at : {}), [name]: req },
        };
      });
    for (const part of OTHER_PLACEMENT_PARTS)
      bridge.invoke({ type: "readPlacement", botId, part }).then(
        (value) => keep(part, { [part]: { status: "ready", value } }),
        (error: unknown) =>
          keep(part, {
            [part]: {
              status: "error",
              message: error instanceof Error ? error.message : String(error),
            },
          }),
      );
    return () => {
      live = false;
    };
  }, [bridge, botId, active, connected, otherBatch, sessionId, otherSeqOf]);
  const reload = useCallback(() => {
    asked.current += 1;
    setGeneration(asked.current);
  }, []);
  const begin = useCallback(() => {
    if (savesBegin) return savesBegin(scope, botId);
    setLocalWriting((n) => n + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      setLocalWriting((n) => n - 1);
      reload();
    };
  }, [savesBegin, scope, botId, reload]);
  const settled = useCallback(() => {
    if (savesSettled) savesSettled(scope);
    else reload();
  }, [savesSettled, scope, reload]);
  // On a disconnect or another session, what was read is dropped before anything is derived.
  if (held && (!connected || held.sessionId !== sessionId)) setHeld(null);
  const part = <P extends PlacementPart>(name: P): Placement[P] =>
    !connected
      ? { status: "error", message: "Not connected to the gateway." }
      : ((held?.sessionId === sessionId ? held.parts[name] : undefined) ?? { status: "loading" });
  const read: Placement = {
    commands: part("commands"),
    workspace: part("workspace"),
    browser: part("browser"),
    inventory: part("inventory"),
    credentials: part("credentials"),
  };
  const commandsCurrent =
    writing === 0 &&
    held?.sessionId === sessionId &&
    held.at.commands === commandsBatch &&
    commandsBatch.sessionId === sessionId &&
    commandsBatch.generation === generation &&
    commandsBatch.seq >= entry.commandsSeq;
  return { read, reload, begin, settled, commandsCurrent };
}

/** A mark of section 2: an icon and its words, never colour alone. */
export function Mark({ kind }: { kind: "set" | "shown" }) {
  const [icon, words] =
    kind === "set"
      ? [<LockIcon key="i" />, "Set on the gateway"]
      : [<EyeIcon key="i" />, "Shown only"];
  return (
    <span className="m-mark">
      {icon}
      {words}
    </span>
  );
}

/** The Runs on group's one row: the command setting, and bots with the same settings once read. */
export function RunsOnRow({
  botName,
  read,
  nameOf,
  onOpen,
}: {
  botName: string;
  read: Placement;
  nameOf: (id: string) => string;
  onOpen: () => void;
}) {
  const { commands, workspace } = read;
  const value =
    commands.status === "ready"
      ? runsOnValue(
          commands.value.commands,
          [
            ...commands.value.sameMachine,
            ...(workspace.status === "ready" ? workspace.value.sameWorkspace : []),
          ],
          nameOf,
        )
      : commands.status === "error"
        ? "Couldn't load"
        : "Reading…";
  return (
    <>
      <h3 className="b-tabgroup">Runs on</h3>
      <dl className="facts">
        <div>
          <button
            type="button"
            className="b-open m-open"
            data-bs="runs-on"
            aria-label={`Where ${botName} runs: ${value}. Open.`}
            onClick={onOpen}
          >
            <span className="m-open-text">
              <span>Where {botName} runs</span>
              <small data-testid="runs-on-value">{value}</small>
            </span>
            <ChevronIcon />
          </button>
        </div>
      </dl>
    </>
  );
}

function Fact({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="m-value" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

const unavailableWords = (status: string, message?: string) =>
  status === "needs-admin"
    ? "Needs admin access"
    : status === "needs-pairing"
      ? "Needs device access"
      : status === "not-connected"
        ? "Not connected"
        : `Couldn't read: ${message ?? ""}`;

/** A fact drawn from its part once that part's read answers; until then, that it is read or why it couldn't be. */
function shown<T>(read: Read<T>, draw: (value: T) => ReactNode): ReactNode {
  if (read.status === "ready") return draw(read.value);
  return read.status === "loading" ? (
    <span className="b-faint" aria-busy="true">
      Reading…
    </span>
  ) : (
    <span className="b-faint">{unavailableWords("failed", read.message)}</span>
  );
}

/** The page "Where <bot> runs". */
export function RunsOnPage({
  botId,
  botName,
  read,
  reload,
  begin,
  settled,
  commandsCurrent,
  nameOf,
  connection,
  info,
  granted,
  announce,
  onBack,
}: {
  botId: string;
  botName: string;
  read: Placement;
  reload: () => void;
  /** Counts a save as out until the returned function is called, on this page or one opened again. */
  begin: () => () => void;
  /** Refreshes placement on this gateway after a save settles, even if this page unmounted. */
  settled: () => void;
  /** Whether no save is out and the commands part shown was read after the latest reload. */
  commandsCurrent: boolean;
  nameOf: (id: string) => string;
  connection: ConnectionState;
  info: HostInfo;
  /** Whether admin was just granted, detected by the owner so a reconnect's new key can't drop it. */
  granted: boolean;
  announce: (text: string) => void;
  onBack: () => void;
}) {
  const bridge = useBridge();
  const admin = connection.canAdmin && !info.readOnly;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // A write that completes after this page went away (another bot, connection or access) changes nothing.
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [editing, setEditing] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const head = (
    <div className="b-subhead">
      <button
        type="button"
        className="icon-button"
        data-variant="quiet"
        aria-label="Back to settings"
        onClick={onBack}
      >
        <BackIcon />
      </button>
      <h3 tabIndex={-1} data-bs-focus="">
        Where {botName} runs
      </h3>
    </div>
  );
  const foot =
    granted && admin ? (
      <GrantedBar />
    ) : !admin ? (
      <div className="b-panel-foot">
        <AdminBar
          connection={connection}
          info={info}
          need={`Changing where ${botName} runs needs admin access.`}
        />
      </div>
    ) : null;
  // A save's outcome stays shown when the read after it fails.
  const saveLines = (
    <>
      {error && (
        <p className="b-field-error" role="alert" data-testid="runs-on-error-line">
          {error}
        </p>
      )}
      {note && (
        <p className="b-hint" data-testid="runs-on-save-note">
          {note}
        </p>
      )}
    </>
  );

  const commandsDisabled = !admin || saving || !commandsCurrent;

  const save = async (value: string, baseHash: string | null) => {
    if (commandsDisabled) return;
    const done = begin();
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const saved = await bridge.invoke({
        type: "setCommandMachine",
        botId,
        host: value === "gateway" ? "gateway" : "node",
        nodeId: value === "gateway" ? null : value,
        baseHash,
      });
      if (!mounted.current) return;
      if (saved.status === "refused") {
        setError(`Nothing was saved. The gateway answered: ${saved.message}`);
        announce("Couldn't save");
        return;
      }
      if (saved.status === "unknown") {
        setError(`The save couldn't be confirmed: ${saved.message}`);
        setNote(
          saved.place
            ? `Read back afterwards, ${botName}'s command machine setting is ${hostWords(saved.place)}.`
            : "The setting couldn't be read back either.",
        );
        announce("Save not confirmed");
        return;
      }
      const where = `${botName}'s command machine setting: ${hostWords(saved.place)}`;
      if (saved.active !== "failed" && saved.message)
        setNote(`The gateway answered: ${saved.message}`);
      if (saved.active === "applied") announce(`Saved and applied. ${where}`);
      else if (saved.active === "pending")
        announce(`Saved. The gateway doesn't report it applied yet. ${where}`);
      else {
        setError(`Saved, but not applied. The gateway answered: ${saved.message ?? ""}`);
        announce("Saved, not applied");
      }
    } catch (failure) {
      if (!mounted.current) return;
      setError(failure instanceof Error ? failure.message : String(failure));
      // A change never sent, or a read-back that failed or shows another setting: none confirms a save.
      announce("Save not confirmed");
    } finally {
      // Ending the save also bumps this gateway's version above Work, so any
      // open or reopened Runs on view on that gateway refreshes and waits for
      // the new read, without touching another gateway.
      done();
      if (mounted.current) setSaving(false);
    }
  };

  const { workspace, browser, inventory, credentials } = read;

  const sameNotes: string[] = [];
  if (read.commands.status === "ready" && read.commands.value.sameMachine.length > 0)
    sameNotes.push(
      `${botName} and ${names(read.commands.value.sameMachine.map(nameOf))} have the same command machine setting: ${hostWords(read.commands.value.commands)}.`,
    );
  if (workspace.status === "ready" && workspace.value.sameWorkspace.length > 0)
    sameNotes.push(
      `${botName} and ${names(workspace.value.sameWorkspace.map(nameOf))} have the same workspace setting.`,
    );
  const readAt = Object.values(read).flatMap((each) =>
    each.status === "ready" ? [each.value.readAt] : [],
  );
  const readSpan =
    readAt.length > 0 ? [clockTime(Math.min(...readAt)), clockTime(Math.max(...readAt))] : null;
  // Try again reads every part again; it is offered once, at the first part whose read failed.
  const failed = PLACEMENT_PARTS.find((part) => read[part].status === "error");
  const tryAgain = (
    <div className="b-actions">
      <button type="button" className="button" data-size="sm" onClick={reload}>
        Try again
      </button>
    </div>
  );

  return (
    <div className="b-tab m-page" data-testid="runs-on-page">
      {head}
      {sameNotes.length > 0 && (
        <Note tone="warn" testId="runs-on-shared">
          {sameNotes.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </Note>
      )}

      <h4 className="b-group">Commands</h4>
      {read.commands.status === "ready" ? (
        <CommandsPart
          part={read.commands.value}
          botName={botName}
          disabled={commandsDisabled}
          saveLines={saveLines}
          now={now}
          onSave={save}
        />
      ) : (
        <>
          {saveLines}
          {read.commands.status === "loading" ? (
            <div
              aria-busy="true"
              aria-label={`Loading where ${botName} runs`}
              data-testid="runs-on-loading"
            >
              <div className="skeleton" style={{ height: 52, width: "100%" }} />
            </div>
          ) : (
            <div className="work-empty" data-testid="runs-on-error">
              <span className="empty-mark">
                <WarnIcon />
              </span>
              <h4>Couldn't load where {botName} runs</h4>
              <p>{read.commands.message || "The gateway did not answer."}</p>
              <div style={{ marginTop: 10 }}>
                <button type="button" className="button" data-size="sm" onClick={reload}>
                  Try again
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <h4 className="b-group">Workspace</h4>
      <dl className="facts m-facts">
        <Fact label="Folder" testId="runs-on-workspace">
          {shown(workspace, ({ workspace: path }) =>
            path ? (
              <>
                <span className="mono m-path">{path}</span>{" "}
                <CopyValue value={path} label="Copy folder" />
              </>
            ) : (
              "Workspace path unavailable here"
            ),
          )}
        </Fact>
      </dl>
      {failed === "workspace" && tryAgain}
      <p className="b-hint">{botName}'s workspace, as the gateway reports it.</p>
      <p className="b-hint">This control sets the bot's workspace in the gateway's settings.</p>
      {admin && editing === null && workspace.status === "ready" && (
        <div className="b-actions">
          <button
            type="button"
            className="button"
            data-size="sm"
            data-bs="workspace-change"
            onClick={() => setEditing(workspace.value.workspace ?? "")}
          >
            Change…
          </button>
          <span className="b-hint">The gateway checks the path you enter.</span>
        </div>
      )}
      {admin && editing !== null && (
        <WorkspaceForm
          botId={botId}
          botName={botName}
          initial={editing}
          current={workspace.status === "ready" ? workspace.value.workspace : null}
          onDone={(saved) => {
            if (saved) settled();
            if (!mounted.current) return;
            setEditing(null);
            if (saved) {
              announce(
                saved.asTyped
                  ? `Saved. ${botName}'s workspace: ${saved.workspace}`
                  : saved.workspace === null
                    ? "The gateway accepted the workspace change. The current workspace could not be confirmed."
                    : `The gateway accepted the workspace change. It now lists ${botName}'s workspace as ${saved.workspace}.`,
              );
            }
          }}
          onFailed={settled}
        />
      )}

      <h4 className="b-group">Browser</h4>
      <dl className="facts m-facts">
        <Fact label={`${botName}'s tool lists`} testId="runs-on-browser">
          {shown(
            browser,
            ({ browser: { own } }) =>
              `Allow: ${listWords(own.allow)} · Deny: ${listWords(own.deny)}`,
          )}
        </Fact>
        <Fact label="Every bot's tool lists">
          {shown(
            browser,
            ({ browser: { everyBot } }) =>
              `Allow: ${listWords(everyBot.allow)} · Deny: ${listWords(everyBot.deny)}`,
          )}
        </Fact>
        <Fact label="The gateway's browser switches" testId="runs-on-browser-gateway">
          {shown(
            browser,
            ({ browser: { gateway } }) =>
              `Browser control: ${switchWords(gateway.control)} · Browser plugin: ${switchWords(gateway.plugin)}`,
          )}
        </Fact>
        <Fact label="Clawtrate's computer plugin" testId="runs-on-browser-profile">
          {shown(
            browser,
            ({ browser: { plugin } }) =>
              (!plugin.present
                ? "No entry in the gateway's settings"
                : plugin.profile
                  ? `Names the profile ${plugin.profile} for ${botName}`
                  : `Names no profile for ${botName}`) +
              (plugin.enabled === false ? "; turned off in the gateway's settings" : ""),
          )}
        </Fact>
      </dl>
      {failed === "browser" && tryAgain}
      <p className="b-hint" data-testid="runs-on-browser-choice">
        As stored in the gateway's settings. <Mark kind="shown" /> Choosing or creating a browser
        profile isn't offered here.
      </p>

      <h4 className="b-group">What {botName}'s settings name</h4>
      <p className="b-hint" style={{ marginTop: 0 }}>
        Inventory. Whether {botName} can use each isn't reported.
      </p>
      <dl className="facts m-facts" data-testid="runs-on-inventory">
        <Fact label="Accounts" testId="inventory-accounts">
          {shown(inventory, ({ accounts }) =>
            "status" in accounts
              ? unavailableWords(
                  accounts.status,
                  accounts.status === "failed" ? accounts.message : undefined,
                )
              : accounts.length === 0
                ? "None listed"
                : accounts
                    .map(
                      (account) =>
                        `${account.label ?? account.id}${account.bound ? " (bound)" : ""}`,
                    )
                    .join(", "),
          )}
        </Fact>
        <Fact label="Tool servers" testId="inventory-servers">
          {shown(inventory, ({ toolServers }) =>
            toolServers.length === 0
              ? "None configured"
              : toolServers
                  .map(
                    (server) =>
                      `${server.name} (${
                        server.deniedBy
                          ? `${server.deniedBy.list === "bot" ? `${botName}'s` : "every bot's"} deny list: ${server.deniedBy.entry}`
                          : server.offered === true
                            ? "offered in the latest task listed here"
                            : server.offered === false
                              ? "not offered in the latest task listed here"
                              : "configured"
                      })`,
                  )
                  .join("; "),
          )}
        </Fact>
        <Fact label="Secrets" testId="inventory-secrets">
          {shown(inventory, ({ secrets }) =>
            Array.isArray(secrets) ? (
              secrets.length === 0 ? (
                "None in the gateway's secret store"
              ) : (
                `Names in the gateway's secret store: ${secrets.join(", ")}`
              )
            ) : (
              <span className="b-faint">{unavailableWords(secrets.status)}</span>
            ),
          )}
        </Fact>
        <Fact label="Plugin credentials" testId="inventory-signins">
          {shown(credentials, ({ plugins, pluginsOmitted }) =>
            Array.isArray(plugins) ? (
              plugins.length === 0 ? (
                "No plugin entries to inspect in the gateway's settings"
              ) : (
                plugins
                  .map(
                    (each) =>
                      `${each.plugin}: ${
                        "status" in each.fields
                          ? `Unavailable (${unavailableWords(each.fields.status, each.fields.status === "failed" ? each.fields.message : undefined)})`
                          : each.fields.length === 0
                            ? "declares no credentials"
                            : each.fields
                                .map((field) => `${field.label}, ${credentialWords(field)}`)
                                .join("; ")
                      }${each.fieldsOmitted > 0 ? ` · ${each.fieldsOmitted} more fields not read` : ""}`,
                  )
                  .join(" · ") + (pluginsOmitted > 0 ? ` · ${pluginsOmitted} more not read` : "")
              )
            ) : (
              <span className="b-faint">{unavailableWords(plugins.status)}</span>
            ),
          )}
        </Fact>
        <Fact label="Workspace-only file tools" testId="inventory-folders">
          {shown(inventory, ({ workspaceOnly }) =>
            workspaceOnly === null
              ? "Not set"
              : `${workspaceOnly.value ? "On" : "Off"}, in ${workspaceOnly.set === "bot" ? `${botName}'s settings` : "the gateway's settings for every bot"}`,
          )}
        </Fact>
      </dl>
      {(failed === "inventory" || failed === "credentials") && tryAgain}
      {readSpan && (
        <p className="b-hint" data-testid="runs-on-read-at">
          From {botName}'s settings and the gateway's, read{" "}
          {readSpan[0] === readSpan[1]
            ? `at ${readSpan[0]}`
            : `from ${readSpan[0]} to ${readSpan[1]}`}
          .
          {inventory.status === "ready" && inventory.value.listing
            ? ` Tool servers offered: the listing of ${botName}'s latest task listed here, read at ${clockTime(inventory.value.listing.readAt)}.`
            : ""}
          {read.commands.status === "ready" && read.commands.value.nodesOmitted > 0
            ? ` ${read.commands.value.nodesOmitted} more machines aren't listed.`
            : ""}
        </p>
      )}
      {foot}
    </div>
  );
}

/** The command setting, once its own read answers. */
function CommandsPart({
  part,
  botName,
  disabled,
  saveLines,
  now,
  onSave,
}: {
  part: PlacementParts["commands"];
  botName: string;
  disabled: boolean;
  saveLines: ReactNode;
  now: number;
  onSave: (value: string, baseHash: string | null) => void;
}) {
  const { commands } = part;
  const node = commands.node;
  const onNode = commands.host === "node";
  const listed = onNode && node !== null;
  const current = commands.host === "gateway" ? "gateway" : listed ? node.id : "stored";
  const storedLabel =
    commands.host === null
      ? "Not set"
      : commands.hostSupported === false
        ? `“${commands.host}” · Not supported here`
        : onNode
          ? commands.nodeSelector
            ? `${commands.nodeSelector} · Not listed`
            : "node · No machine stored"
          : commands.host;
  const choices = [
    { value: "gateway", label: "The gateway's machine" },
    ...part.nodes.map((each) => ({
      value: each.id,
      label: `${each.name} · ${each.connected ? "Connected" : "Not connected"}`,
    })),
    ...(current === "stored" ? [{ value: "stored", label: storedLabel, disabled: true }] : []),
  ];
  const origin =
    commands.host === null
      ? `Not set in the gateway's settings for ${botName} or for every bot.`
      : commands.inherited
        ? "From the gateway's setting for every bot."
        : `Set in ${botName}'s own settings.`;
  return (
    <>
      <p className="b-hint m-label" id="m-machine-label">
        The machine {botName}'s settings name for its commands:
      </p>
      <Select
        label={`${botName}'s command machine`}
        value={current}
        choices={choices}
        disabled={disabled}
        onChoose={(value) => {
          if (!disabled && value !== current) onSave(value, part.configHash);
        }}
        testId="runs-on-machine"
      />
      {saveLines}
      <p className="m-sentence">
        {origin}
        {onNode && commands.nodeInherited
          ? " The node selector is from the gateway's setting for every bot."
          : ""}
        {commands.host !== null && (
          <>
            {" "}
            <Mark kind="set" />
          </>
        )}
      </p>
      {part.configActive === false && (
        <p className="b-hint" data-testid="runs-on-not-applied">
          The gateway reports saved settings it hasn't applied yet.
        </p>
      )}
      {commands.hostSupported === false && (
        <p className="b-hint" data-testid="runs-on-unsupported">
          Stored as “{commands.host}”, a value this app doesn't support. It is shown as stored.
        </p>
      )}
      {listed && !node.connected && (
        <p className="b-hint" data-testid="runs-on-offline">
          {node.name} isn't connected: {lastSeen(node, now)}.
        </p>
      )}
      {listed && !node.listsRun && (
        <p className="b-hint" data-testid="runs-on-no-run">
          {node.name} doesn't list system.run among its commands.
        </p>
      )}
      {onNode && !listed && (
        <p className="b-hint" data-testid="runs-on-unlisted">
          {commands.nodeSelector
            ? `No listed machine has the id “${commands.nodeSelector}”. The setting is shown as stored.`
            : "No machine is stored with this setting."}
        </p>
      )}
    </>
  );
}

function WorkspaceForm({
  botId,
  botName,
  initial,
  current,
  onDone,
  onFailed,
}: {
  botId: string;
  botName: string;
  initial: string;
  /** The bot's workspace now, as the example beside the field. */
  current: string | null;
  onDone: (saved: { workspace: string | null; asTyped: boolean } | null) => void;
  onFailed: () => void;
}) {
  const bridge = useBridge();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const submit = async () => {
    // The gateway judges the path; only an empty one, which would change nothing, isn't sent.
    if (value === "") {
      setError("Enter a path.");
      field.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onDone(await bridge.invoke({ type: "setBotWorkspace", botId, path: value }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      field.current?.focus();
      onFailed();
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="m-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          // While a save is pending the form stays: its answer belongs to it.
          if (!busy) onDone(null);
        }
      }}
    >
      <label className="b-hint m-label" htmlFor="m-workspace">
        {botName}'s folder, as a path on the gateway's machine.
        {current ? (
          <>
            {" "}
            Now: <span className="mono m-path">{current}</span>
          </>
        ) : null}
      </label>
      <input
        ref={field}
        id="m-workspace"
        className="input mono"
        value={value}
        autoFocus
        spellCheck={false}
        aria-invalid={error !== null}
        aria-describedby={error ? "m-workspace-error" : undefined}
        onChange={(event) => setValue(event.target.value)}
      />
      {error && (
        <p className="b-field-error" id="m-workspace-error" role="alert">
          {error}
        </p>
      )}
      <div className="b-actions">
        <button
          type="submit"
          className="button"
          data-variant="primary"
          data-size="sm"
          disabled={busy}
        >
          {busy ? "Saving…" : "Save folder"}
        </button>
        <button
          type="button"
          className="button"
          data-variant="quiet"
          data-size="sm"
          disabled={busy}
          onClick={() => onDone(null)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
