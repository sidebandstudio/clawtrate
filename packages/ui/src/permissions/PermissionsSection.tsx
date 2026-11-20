// Settings → Permissions (docs/design/controls.md sections 7 to 9). Its first
// line is the rules plugin's state; under it three parts: Rules, which in this
// version only says that rules for every bot are not here yet; Saved approvals,
// the standing approvals the gateway lists, with Revoke and Remove…; and
// Activity, the audit log's tool actions with what a record made with each call
// says caused it. Everything shown is an answer read now: nothing is kept, and
// "Revoked" or "Removed" is said only after a read back shows it.

import {
  MAX_GRANTS_LISTED,
  type ActivityCause,
  type ActivityPage,
  type ActivityRow,
  type AllowlistEntry,
  type AuditStatus,
  type Bot,
  type ConnectionState,
  type HostInfo,
  type RecordedRule,
  type RoutineGrant,
  type RulesPluginState,
  type SavedApprovals,
  type Task,
} from "@clawtrate/core";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Avatar } from "../Avatar.tsx";
import { useBridge } from "../bridge.tsx";
import { clockTime, fullDate, rowTime } from "../format.ts";
import { ChevronIcon, PlugIcon, ShieldIcon } from "../icons.tsx";
import { Confirm } from "../bots/Dialog.tsx";
import { AdminBar, Select } from "../bots/parts.tsx";
import { useNow } from "../usage/parts.tsx";
import "./permissions.css";

type Part = "rules" | "saved" | "activity";
const PARTS: Array<[Part, string]> = [
  ["rules", "Rules"],
  ["saved", "Saved approvals"],
  ["activity", "Activity"],
];
/** The gateway keeps 30 days of activity (its audit ledger). */
const AUDIT_DAYS = 30;
const DAY = 86_400_000;
/** The rules plugin's state is read again this often while the section is open. */
const PLUGIN_REREAD_MS = 60_000;

export type ShowInChat = (target: { botId: string; key: string; callId: string }) => void;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The rules plugin's state (section 2) --------------------------------------------------

export function pluginWords(plugin: RulesPluginState | "checking" | { failed: string }): string {
  if (plugin === "checking") return "Checking Clawtrate's rules plugin…";
  if ("failed" in plugin) return `Couldn't check Clawtrate's rules plugin. ${plugin.failed}`;
  switch (plugin.state) {
    case "unavailable":
      return "Rules methods unavailable on this gateway.";
    case "stopped":
      return `Couldn't read Clawtrate's rules plugin's status. ${plugin.reason}`;
    case "not-enforcing":
      return `Rules plugin answered at ${clockTime(plugin.answeredAt)}: it isn't enforcing rules, because its hook isn't registered or its service isn't running.`;
    case "old":
      return `Clawtrate's rules plugin is version ${plugin.version}; these rules need 1.0.0 or newer.`;
    case "running": {
      const seen =
        plugin.lastCallAt === null
          ? "No tool call seen yet."
          : `Last tool call seen ${clockTime(plugin.lastCallAt)}.`;
      const enforcing =
        plugin.enforcing === "kept-copy"
          ? ` Its rules file can't be read; it enforces the copy it read${plugin.keptCopyReadAt === null ? "" : ` at ${clockTime(plugin.keptCopyReadAt)}`}.`
          : plugin.enforcing === "ask-every-call"
            ? " Its rules file can't be read and it holds no earlier copy, so it asks before every tool call it sees, other than ask_user."
            : plugin.enforcing === "nothing"
              ? " No rules are saved in it."
              : "";
      return `Rules plugin answered at ${clockTime(plugin.answeredAt)}. ${seen}${enforcing}`;
    }
  }
}

// Saved approvals (section 8) -------------------------------------------------------------

function grantWhen(grant: RoutineGrant, now: number): string {
  const until =
    grant.expiresAtMs === null
      ? "until revoked or the routine changes"
      : grant.expiresAtMs <= now
        ? `ended ${fullDate(grant.expiresAtMs)}`
        : `until ${fullDate(grant.expiresAtMs)}`;
  const used =
    grant.useCount === 0
      ? "not used yet"
      : `used ${grant.useCount} ${grant.useCount === 1 ? "time" : "times"}${grant.lastUsedAtMs === null ? "" : `, last ${fullDate(grant.lastUsedAtMs)}`}`;
  return `grant ${grant.grantId.slice(0, 4)} · granted ${fullDate(grant.createdAtMs)} · ${until} · ${used}`;
}

function GatewayMark() {
  return (
    <small className="c-enforced">
      <ShieldIcon /> The gateway enforces this
    </small>
  );
}

// Activity (section 9) -------------------------------------------------------------------

const STATUS_WORDS: Record<AuditStatus, string> = {
  started: "Started",
  succeeded: "Ran",
  failed: "Failed",
  cancelled: "Cancelled",
  timed_out: "Timed out",
  blocked: "Blocked",
  unknown: "Outcome unknown",
};
const STATUS_TONE: Partial<Record<AuditStatus, "danger" | "warn">> = {
  failed: "danger",
  blocked: "danger",
  timed_out: "warn",
};
/** The outcome filter: the audit record's own statuses, as the gateway filters them. */
const OUTCOMES: Array<[AuditStatus | "all", string]> = [
  ["all", "All"],
  ["succeeded", "Ran"],
  ["failed", "Failed"],
  ["blocked", "Blocked"],
  ["cancelled", "Cancelled"],
  ["timed_out", "Timed out"],
  ["started", "Started"],
];

const ACTION_WORD: Record<RecordedRule["action"], string> = {
  never: "Never",
  ask: "Ask first",
  allow: "Allow",
};

function ruleWords(rule: RecordedRule, botName: (id: string) => string): string {
  const whose = rule.scope === "*" ? "A rule for every bot" : `${botName(rule.scope)}'s rule`;
  const now = rule.now;
  if (now !== null && now !== "unread" && now.version === rule.version) {
    const what = now.pattern ?? now.tools.join(", ");
    return `${whose} '${ACTION_WORD[rule.action]} · ${what}', version ${rule.version}`;
  }
  const named =
    rule.scope === "*"
      ? `A ${ACTION_WORD[rule.action]} rule for every bot`
      : `${botName(rule.scope)}'s ${ACTION_WORD[rule.action]} rule`;
  const since =
    now === null ? " (since removed)" : now === "unread" ? "" : ` (now version ${now.version})`;
  return `${named}, version ${rule.version}${since}`;
}

const ANSWER_WORDS = {
  "allow-once": "answered Allow once",
  deny: "answered Deny",
  timeout: "no answer in time",
  cancelled: "the gateway cancelled the ask",
} as const;

export function causeWords(cause: ActivityCause, botName: (id: string) => string): string {
  if (cause.kind === "not-recorded") return "Cause not recorded";
  if (cause.kind === "not-read") return `Cause not read. ${cause.reason}`;
  const source = cause.source;
  const by =
    source.kind === "rule"
      ? ruleWords(source.rule, botName)
      : source.kind === "fallback"
        ? `"Ask when nothing else decides", on for ${source.scope === "*" ? "every bot" : botName(source.scope)}`
        : "Clawtrate's rules couldn't be read";
  if (cause.decision === "block") return `Recorded: ${by}.`;
  if (cause.decision === "allow")
    return `Recorded: ${by} kept "Ask when nothing else decides" from asking.`;
  const answer = cause.answer ? ANSWER_WORDS[cause.answer] : "no answer recorded";
  return source.kind === "rule"
    ? `Recorded: asked by ${by}; ${answer}.`
    : `Recorded: asked because ${by}; ${answer}.`;
}

function taskWords(row: ActivityRow, tasksByBot: Record<string, Task[]>): string {
  const key = row.sessionKey;
  if (!key) return "No task recorded";
  const task = (tasksByBot[row.agentId] ?? []).find((each) => each.key === key);
  if (task) return task.title;
  if (/^agent:[^:]+:cron:/.test(key)) return "A routine's run";
  return "A task not listed here";
}

// The section ------------------------------------------------------------------------------

type Load<T> =
  { status: "loading" } | { status: "failed"; message: string } | { status: "ready"; value: T };

export function PermissionsSection({
  connection,
  info,
  bots,
  tasksByBot,
  announce,
  toNav,
  onShowInChat,
}: {
  connection: ConnectionState;
  info: HostInfo;
  bots: readonly Bot[];
  tasksByBot: Record<string, Task[]>;
  announce: (text: string) => void;
  toNav: ReactNode;
  onShowInChat: ShowInChat;
}) {
  const bridge = useBridge();
  // Saved approvals first: until rules for every bot are here, the Rules part only says so.
  const [part, setPart] = useState<Part>("saved");
  const [plugin, setPlugin] = useState<RulesPluginState | "checking" | { failed: string }>(
    "checking",
  );
  const connected = connection.status === "connected";
  const connectedAt = connection.connectedAt;

  // The plugin's state: on opening, after every connect, and every minute while open.
  useEffect(() => {
    if (!connected) return;
    let live = true;
    const read = () =>
      bridge.invoke({ type: "readRulesPlugin" }).then(
        (state) => live && setPlugin(state),
        (error: unknown) => live && setPlugin({ failed: errorText(error) }),
      );
    void read();
    const timer = setInterval(() => void read(), PLUGIN_REREAD_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [bridge, connected, connectedAt]);

  const botName = useCallback(
    (id: string) => bots.find((each) => each.id === id)?.name ?? id,
    [bots],
  );
  const running = plugin !== "checking" && !("failed" in plugin) && plugin.state === "running";
  const tone = running || plugin === "checking" ? undefined : "danger";

  const choose = (next: Part, focus: boolean) => {
    setPart(next);
    if (focus)
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(`[data-part="${next}"]`)?.focus(),
      );
  };
  const onSegKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = PARTS.findIndex(([id]) => id === part);
    const to =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? (index + 1) % PARTS.length
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? (index + PARTS.length - 1) % PARTS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? PARTS.length - 1
              : null;
    if (to === null) return;
    event.preventDefault();
    choose(PARTS[to]![0], true);
  };

  let body: ReactNode;
  let foot: ReactNode = null;
  if (part === "rules") {
    body = (
      <p className="b-hint c-rules-later" data-testid="rules-later">
        Rules for every bot aren't in this version of Clawtrate yet.
      </p>
    );
  } else if (part === "saved") {
    // A new connection is a new page: any confirmation and notes of the old one are gone.
    const saved = (
      <SavedPart
        key={savedKey(connection) ?? "disconnected"}
        connection={connection}
        info={info}
        botName={botName}
        announce={announce}
      />
    );
    body = saved;
    if (!connection.canApprove)
      foot = (
        <AdminBar
          connection={connection}
          info={info}
          tier="approvals"
          need="Seeing saved approvals needs approvals access."
        />
      );
    else if (!connection.canAdmin)
      foot = (
        <AdminBar
          connection={connection}
          info={info}
          need="Removing an allowlist entry needs admin access."
        />
      );
  } else {
    body = (
      <ActivityPart
        connected={connected}
        connectedAt={connectedAt}
        bots={bots}
        tasksByBot={tasksByBot}
        botName={botName}
        pluginListed={
          plugin === "checking" || "failed" in plugin ? null : plugin.state !== "unavailable"
        }
        onShowInChat={onShowInChat}
      />
    );
  }

  return (
    <>
      <header className="b-section-head">
        {toNav}
        <h3 id="b-section-title" tabIndex={-1}>
          Permissions
        </h3>
      </header>
      <div className="b-section-body" data-testid="permissions">
        <p className="c-plugin" role="status" data-tone={tone} data-testid="rules-plugin-state">
          <PlugIcon />
          <span>{pluginWords(plugin)}</span>
        </p>
        <div
          className="seg c-section-seg"
          role="radiogroup"
          aria-label="Permissions"
          onKeyDown={onSegKey}
        >
          {PARTS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={part === id}
              tabIndex={part === id ? 0 : -1}
              data-part={id}
              onClick={() => choose(id, false)}
            >
              {label}
            </button>
          ))}
        </div>
        {body}
      </div>
      {foot && <footer className="b-section-foot">{foot}</footer>}
    </>
  );
}

/**
 * One read, made again whenever `key` changes (null: not now) or `retry` is
 * called. An answer counts only for the question it was asked for: the read's
 * own, and a continuation's (`setFor`) only while its question is still the one
 * on screen, so an older answer never replaces a newer one.
 */
function useRead<T>(key: string | null, run: () => Promise<T>) {
  const [nonce, setNonce] = useState(0);
  const asked = key === null ? null : `${key}\u0000${nonce}`;
  const [answer, setAnswer] = useState<{ key: string; load: Load<T> } | null>(null);
  const runRef = useRef(run);
  const askedRef = useRef(asked);
  useEffect(() => {
    runRef.current = run;
    askedRef.current = asked;
  });
  useEffect(() => {
    if (asked === null) return;
    let live = true;
    runRef.current().then(
      (value) => live && setAnswer({ key: asked, load: { status: "ready", value } }),
      (error: unknown) =>
        live && setAnswer({ key: asked, load: { status: "failed", message: errorText(error) } }),
    );
    return () => {
      live = false;
    };
  }, [asked]);
  const load: Load<T> =
    answer !== null && answer.key === asked ? answer.load : { status: "loading" };
  /** Whether `forKey` is still the question on screen. */
  const current = (forKey: string | null) => forKey !== null && askedRef.current === forKey;
  const setFor = (forKey: string | null, value: T) => {
    if (current(forKey)) setAnswer({ key: forKey!, load: { status: "ready", value } });
  };
  return {
    load,
    asked,
    current,
    set: (value: T) => setFor(asked, value),
    setFor,
    retry: () => setNonce((n) => n + 1),
  };
}

function Skeleton({ label, rows }: { label: string; rows: number }) {
  return (
    <div className="c-skeleton" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton" />
      ))}
    </div>
  );
}

function Failed({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="work-empty" role="alert">
      <h3>{title}</h3>
      <p>{message}</p>
      <button type="button" className="button" data-size="sm" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

// Saved approvals ------------------------------------------------------------------------

/**
 * The connection Saved approvals reads and confirms on: the gateway, its address,
 * the hello, and what this connection may do. Null while disconnected.
 */
function savedKey(connection: ConnectionState): string | null {
  return connection.status === "connected"
    ? JSON.stringify([
        connection.gatewayId,
        connection.gatewayUrl,
        connection.connectedAt,
        connection.canApprove,
        connection.canAdmin,
      ])
    : null;
}

/** Whether a listed entry can be confirmed for removal: its id, and its pattern shown whole. */
const removable = (entry: AllowlistEntry) => entry.entryId !== null && entry.shownWhole;

function SavedPart({
  connection,
  info,
  botName,
  announce,
}: {
  connection: ConnectionState;
  info: HostInfo;
  botName: (id: string) => string;
  announce: (text: string) => void;
}) {
  const bridge = useBridge();
  const [busy, setBusy] = useState<string | null>(null);
  /** What the gateway answered, and the read after it, per grant or entry. */
  const [notes, setNotes] = useState<Record<string, string>>({});
  /**
   * The entry the person is asked about, with the file's revision it was shown
   * from: Remove acts on that revision only. `changed` says the file changed
   * since, so the person is asked again with what it lists now.
   */
  const [confirm, setConfirm] = useState<{
    entry: AllowlistEntry;
    hash: string;
    digest: string;
    changed: boolean;
  } | null>(null);
  // A grant's end is judged against the clock as it moves, not as it was when the page opened.
  const now = useNow();
  const { canApprove, connectedAt, gatewayId, gatewayUrl } = connection;
  const connected = connection.status === "connected";
  const key = savedKey(connection);
  const {
    load,
    set: setValue,
    retry,
  } = useRead(canApprove ? key : null, () => bridge.invoke({ type: "readSavedApprovals" }));

  if (!canApprove)
    return <p className="b-hint">A standing approval lets a call run later without a card.</p>;
  if (load.status === "loading") return <Skeleton label="Loading saved approvals" rows={3} />;
  if (load.status === "failed")
    return <Failed title="Couldn't load saved approvals" message={load.message} onRetry={retry} />;
  const { grants, allowlist } = load.value;
  const set = (patch: Partial<SavedApprovals>) => setValue({ ...load.value, ...patch });

  const revoke = async (grant: RoutineGrant) => {
    setBusy(grant.grantId);
    try {
      const result = await bridge.invoke({ type: "revokeGrant", grantId: grant.grantId });
      set({ grants: result.grants });
      const listed = result.grant;
      let note: string;
      if (listed?.revokedAtMs != null) {
        note = "";
        announce(result.answer === "already-revoked" ? "Already revoked" : "Revoked");
      } else if (result.answer === "not-found" && !listed) {
        note = "The gateway has no such grant now.";
        announce("Not found");
      } else {
        const why = result.error ? `Couldn't revoke. ${result.error}` : "Couldn't revoke.";
        note = listed
          ? `${why} The gateway still lists this grant, not revoked.`
          : result.readError
            ? `${why} Couldn't read the grants back: ${result.readError}`
            : why;
        announce("Couldn't revoke");
      }
      setNotes((all) => ({ ...all, [grant.grantId]: note }));
    } catch (error) {
      setNotes((all) => ({ ...all, [grant.grantId]: `Couldn't revoke. ${errorText(error)}` }));
      announce("Couldn't revoke");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (entry: AllowlistEntry, shownHash: string, shownDigest: string) => {
    if (!entry.entryId || !connected || connectedAt === null || gatewayUrl === null) return;
    const entryId = entry.entryId;
    const id = `entry:${entry.agentId}:${entryId}`;
    setConfirm(null);
    setBusy(id);
    try {
      const result = await bridge.invoke({
        type: "removeAllowlistEntry",
        agentId: entry.agentId,
        entryId,
        shownHash,
        shownDigest,
        connectedAt,
        gatewayId,
        gatewayUrl,
      });
      set({ allowlist: result.allowlist });
      const bot = botName(entry.agentId);
      const now =
        result.allowlist.status === "ready"
          ? result.allowlist.items.find(
              (each) => each.agentId === entry.agentId && each.entryId === entryId,
            )
          : undefined;
      if (result.outcome === "changed") {
        // Nothing was written: the person is asked again, about the entry as it is now.
        if (now && removable(now) && result.allowlist.status === "ready") {
          setConfirm({
            entry: now,
            hash: result.allowlist.hash,
            digest: result.allowlist.snapshotDigest,
            changed: true,
          });
          setNotes((all) => ({ ...all, [id]: "" }));
        } else
          setNotes((all) => ({
            ...all,
            [id]: "The gateway's file changed since it was shown, and nothing was removed. This entry isn't shown in the refreshed list.",
          }));
        announce("Nothing removed");
        return;
      }
      // A refused write of a file that changed meanwhile: the refreshed file can be confirmed from.
      const stale =
        result.outcome !== "removed" &&
        /changed since last load/.test(result.error ?? "") &&
        now !== undefined &&
        removable(now);
      const note = stale
        ? "The gateway's file changed. Confirm this entry from the refreshed file."
        : result.outcome === "removed" && result.removed
          ? `Removed ${result.removed.pattern} for ${bot}. The file read back no longer lists the entry.`
          : result.outcome === "not-confirmed" || result.outcome === "removed"
            ? `Clawtrate couldn't confirm removal.${result.error ? ` ${result.error}` : ""}`
            : result.outcome === "ambiguous"
              ? `Nothing was removed: the gateway's file has more than one entry for ${bot} with this id, so Clawtrate can't tell which one you confirmed.`
              : result.outcome === "not-listed"
                ? `The gateway's file no longer lists ${entry.pattern} for ${bot}; nothing was written.`
                : result.outcome === "still-listed"
                  ? `Couldn't remove ${entry.pattern} for ${bot}.${result.error ? ` ${result.error}` : ""} The gateway's file still lists it.`
                  : `Couldn't read the gateway's file back.${result.error ? ` ${result.error}` : ""}`;
      setNotes((all) => ({ ...all, [id]: note }));
      announce(result.outcome === "removed" && result.removed ? "Removed" : "Couldn't remove");
    } catch (error) {
      setNotes((all) => ({ ...all, [id]: `Couldn't remove. ${errorText(error)}` }));
      announce("Couldn't remove");
    } finally {
      setBusy(null);
    }
  };

  const grantItems =
    grants.status === "ready"
      ? [...grants.items].sort((a, b) => b.createdAtMs - a.createdAtMs)
      : [];
  const entries = allowlist.status === "ready" ? allowlist.items : [];
  const empty =
    grants.status === "ready" &&
    grantItems.length === 0 &&
    allowlist.status === "ready" &&
    entries.length === 0;
  // Notes about entries the read afterwards no longer lists.
  const goneNotes = Object.entries(notes).filter(
    ([id, text]) =>
      text &&
      (id.startsWith("entry:")
        ? !entries.some((each) => `entry:${each.agentId}:${each.entryId}` === id)
        : !grantItems.some((each) => each.grantId === id)),
  );

  return (
    <div data-testid="saved-approvals">
      <p className="b-hint c-lead" data-testid="saved-read">
        Read here: the routines' grants the gateway lists, and the allowlist in the approvals file
        of the gateway's own machine. Clawtrate's rules plugin makes no standing approval.
      </p>
      {goneNotes.map(([id, text]) => (
        <p key={id} className="b-hint" role="status">
          {text}
        </p>
      ))}
      {empty ? (
        <div className="work-empty" data-testid="saved-empty">
          <h3>Nothing in the two lists read</h3>
          <p>
            The gateway lists no routine's grant, and its machine's approvals file has no allowlist
            entry. A routine's command allowed for some days, or a command allowed always on the
            gateway's machine, would be listed here.
          </p>
        </div>
      ) : (
        <>
          <h4 className="b-group">Routines' grants</h4>
          {grants.status === "failed" ? (
            <p className="b-hint" role="alert">
              Couldn't load the routines' grants. {grants.message}
            </p>
          ) : grants.status === "needs-approvals" ? (
            <p className="b-hint">Seeing saved approvals needs approvals access.</p>
          ) : grantItems.length === 0 ? (
            <p className="b-hint">The gateway lists no routine's grant.</p>
          ) : (
            <dl className="facts c-saved" data-testid="routine-grants">
              {grantItems.map((grant) => {
                const revoked = grant.revokedAtMs !== null;
                const ended = grant.expiresAtMs !== null && grant.expiresAtMs <= now;
                const note = notes[grant.grantId];
                const gone = grant.routineName === null;
                return (
                  <div key={grant.grantId} className="b-row" data-testid="routine-grant">
                    <span className="b-row-main">
                      <span className={revoked || ended ? "c-struck" : undefined}>
                        {gone
                          ? "A routine the gateway no longer has"
                          : `Routine ${grant.routineName}`}{" "}
                        ({botName(grant.agentId)}) · Saved command <code>{grant.command}</code>
                        {grant.cwd ? (
                          <>
                            {" "}
                            in <code>{grant.cwd}</code>
                          </>
                        ) : null}
                      </span>
                      <small>{grantWhen(grant, now)}</small>
                      {revoked ? (
                        <small role="status" data-testid="grant-revoked">
                          Revoked {fullDate(grant.revokedAtMs)}. The routine's next matching command
                          no longer runs under this grant.
                        </small>
                      ) : ended || gone ? null : (
                        <GatewayMark />
                      )}
                      {note && (
                        <small role="status" data-tone="danger">
                          {note}
                        </small>
                      )}
                    </span>
                    {!revoked && !ended && (
                      <button
                        type="button"
                        className="button"
                        data-size="sm"
                        disabled={busy !== null || info.readOnly}
                        onClick={() => void revoke(grant)}
                      >
                        {busy === grant.grantId ? "Revoking…" : "Revoke"}
                      </button>
                    )}
                  </div>
                );
              })}
            </dl>
          )}
          {grantItems.length > 0 && (
            <p className="b-hint">
              Each saved command and folder is as the gateway shows it, with what looks like a
              secret masked, invisible characters written as codes, and cut at 512 characters.
            </p>
          )}
          {grants.status === "ready" && grants.more && (
            <p className="b-hint">
              The gateway lists more grants than the {MAX_GRANTS_LISTED} shown here.
            </p>
          )}
          <h4 className="b-group">The gateway machine's allowlist</h4>
          {allowlist.status === "failed" ? (
            <p className="b-hint" role="alert">
              Couldn't load the allowlist. {allowlist.message}
            </p>
          ) : allowlist.status === "needs-admin" ? (
            <p className="b-hint">Seeing the gateway machine's allowlist needs admin access.</p>
          ) : entries.length === 0 ? (
            <p className="b-hint">Its approvals file lists no allowed command.</p>
          ) : (
            <dl className="facts c-saved" data-testid="allowlist">
              {entries.map((entry, index) => {
                const id = `entry:${entry.agentId}:${entry.entryId ?? index}`;
                const note = notes[id];
                return (
                  <div key={id} className="b-row" data-testid="allowlist-entry">
                    <span className="b-row-main">
                      <span>
                        <code>{entry.pattern}</code> · {botName(entry.agentId)} · on the gateway's
                        machine{entry.fromAlwaysAllow ? " · from Always allow" : ""}
                      </span>
                      {entry.argPattern && (
                        <small>
                          Argument pattern <code>{entry.argPattern}</code>
                        </small>
                      )}
                      <small>
                        {entry.lastUsedAt === null
                          ? "No last use recorded"
                          : `Last used ${fullDate(entry.lastUsedAt)}`}
                        {entry.addedAt === null ? "" : ` · Added ${fullDate(entry.addedAt)}`}
                      </small>
                      {entry.kind === "command" && (
                        <small>
                          Covers what the gateway matches it to, which can be wider than the command
                          that saved it.
                        </small>
                      )}
                      {!entry.entryId ? (
                        <small data-testid="entry-not-removable">
                          Clawtrate can't remove this entry: the file gives it no id.
                        </small>
                      ) : !entry.shownWhole ? (
                        <small data-testid="entry-not-removable">
                          Clawtrate can't remove this entry because its pattern is too long to show
                          in full.
                        </small>
                      ) : null}
                      <GatewayMark />
                      {note && (
                        <small role="status" data-tone="danger">
                          {note}
                        </small>
                      )}
                    </span>
                    {removable(entry) && connected && allowlist.status === "ready" && (
                      <button
                        type="button"
                        className="button"
                        data-variant="quiet"
                        data-size="sm"
                        disabled={busy !== null || info.readOnly}
                        onClick={() =>
                          allowlist.status === "ready" &&
                          setConfirm({
                            entry,
                            hash: allowlist.hash,
                            digest: allowlist.snapshotDigest,
                            changed: false,
                          })
                        }
                      >
                        {busy === id ? "Removing…" : "Remove…"}
                      </button>
                    )}
                  </div>
                );
              })}
            </dl>
          )}
          {entries.some((each) => each.addedAt === null) && (
            <p className="b-hint" data-testid="allowlist-no-time">
              The gateway records no time for these commands being added, so none is shown.
            </p>
          )}
          {allowlist.status === "ready" && allowlist.omitted > 0 && (
            <p className="b-hint">
              {allowlist.omitted} more {allowlist.omitted === 1 ? "entry isn't" : "entries aren't"}{" "}
              shown.
            </p>
          )}
        </>
      )}
      <p className="b-hint" data-testid="saved-not-listed">
        Not read here: placement grants, which the gateway keeps for some plugin commands on paired
        machines for up to 30 days and has no list for; the allowlists of paired machines; and any
        trust a plugin keeps for itself. Remove… is offered only for an allowlist entry with an id.
      </p>
      {confirm && (
        <Confirm
          title="Remove this allowlist entry?"
          text={
            <>
              {confirm.changed && (
                <>
                  The gateway's file changed since it was shown, and nothing was removed. It now
                  lists this entry as:{" "}
                </>
              )}
              <code>{confirm.entry.pattern}</code>
              {confirm.entry.argPattern && (
                <>
                  {" "}
                  with argument pattern <code>{confirm.entry.argPattern}</code>
                </>
              )}{" "}
              for {botName(confirm.entry.agentId)}, on the gateway's machine. Clawtrate writes the
              gateway's approvals file again without it, only if the file is still as shown here,
              then reads it back.
            </>
          }
          action="Remove"
          onAction={() => void remove(confirm.entry, confirm.hash, confirm.digest)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

// Activity -------------------------------------------------------------------------------

function ActivityPart({
  connected,
  connectedAt,
  bots,
  tasksByBot,
  botName,
  pluginListed,
  onShowInChat,
}: {
  connected: boolean;
  connectedAt: number | null;
  bots: readonly Bot[];
  tasksByBot: Record<string, Task[]>;
  botName: (id: string) => string;
  pluginListed: boolean | null;
  onShowInChat: ShowInChat;
}) {
  const bridge = useBridge();
  const [bot, setBot] = useState<string>("all");
  const [outcome, setOutcome] = useState<AuditStatus | "all">("all");
  const [older, setOlder] = useState<"idle" | "loading" | string>("idle");
  const [open, setOpen] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const ask = (cursor: string | null) =>
    bridge.invoke({
      type: "readActivity",
      cursor,
      agentId: bot === "all" ? null : bot,
      status: outcome === "all" ? null : outcome,
    });
  const read = useRead(connected ? `${bot}:${outcome}:${connectedAt}` : null, () =>
    ask(null).then((page) => ({ page, rows: page.rows })),
  );
  const load: Load<ActivityPage> =
    read.load.status === "ready" ? { status: "ready", value: read.load.value.page } : read.load;
  const rows = read.load.status === "ready" ? read.load.value.rows : [];
  const choose = (change: () => void) => {
    change();
    setOlder("idle");
    setOpen(null);
  };

  const more = () => {
    const current = read.load;
    if (current.status !== "ready" || !current.value.page.nextCursor) return;
    // The question this page continues: a newer filter, connection or retry drops its answer.
    const forKey = read.asked;
    setOlder("loading");
    ask(current.value.page.nextCursor).then(
      (page) => {
        if (!read.current(forKey)) return;
        const shown = current.value.rows;
        // A call whose start is on the next page is one row: the first one listed keeps it.
        read.setFor(forKey, {
          page,
          rows: [...shown, ...page.rows.filter((row) => !shown.some((each) => each.id === row.id))],
        });
        setOlder("idle");
      },
      (error: unknown) => {
        if (read.current(forKey)) setOlder(`Couldn't load older activity. ${errorText(error)}`);
      },
    );
  };

  const filters = (
    <div className="c-filters" role="group" aria-label="Filters">
      <Select
        label="Bot"
        value={bot}
        choices={[
          { value: "all", label: "Every bot" },
          ...bots.map((each) => ({ value: each.id, label: each.name })),
        ]}
        onChoose={(value) => choose(() => setBot(value))}
        testId="activity-bot"
      />
      <Select
        label="Outcome"
        value={outcome}
        choices={OUTCOMES.map(([value, label]) => ({ value, label }))}
        onChoose={(value) => choose(() => setOutcome(value as AuditStatus | "all"))}
        testId="activity-outcome"
      />
    </div>
  );

  let list: ReactNode;
  if (load.status === "loading") list = <Skeleton label="Loading activity" rows={5} />;
  else if (load.status === "failed")
    list = <Failed title="Couldn't load activity" message={load.message} onRetry={read.retry} />;
  else if (rows.length === 0 && load.value.recording === "off")
    list = (
      <div className="work-empty" data-testid="activity-off">
        <h3>No activity recorded</h3>
        <p>The gateway isn't recording activity: its audit log is switched off in its settings.</p>
      </div>
    );
  else if (rows.length === 0)
    list = (
      <div className="work-empty" data-testid="activity-empty">
        <h3>
          {bot === "all" && outcome === "all"
            ? "No tool activity in the last 30 days."
            : "No tool activity matches these filters."}
        </h3>
        <p>What your bots do with their tools shows here.</p>
      </div>
    );
  else
    list = (
      <ul className="c-logs" data-testid="activity">
        {rows.map((row) => {
          const agent = bots.find((each) => each.id === row.agentId);
          const cause = causeWords(row.cause, botName);
          const tag = STATUS_WORDS[row.status];
          const what = row.toolName ?? "A tool";
          const time = rowTime(row.at, now);
          const task = taskWords(row, tasksByBot);
          const expanded = open === row.id;
          return (
            <li key={row.id}>
              <button
                type="button"
                className="c-log"
                aria-expanded={expanded}
                aria-label={`${time}, ${botName(row.agentId)}, ${task}, ${what}, ${tag}, ${cause}`}
                onClick={() => setOpen(expanded ? null : row.id)}
                data-testid="activity-row"
              >
                <span className="c-log-time">{time}</span>
                {agent ? <Avatar bot={agent} /> : <span className="avatar" aria-hidden="true" />}
                <span className="c-log-what">
                  <span className="mono">{what}</span>
                  <br />
                  <span className="b-faint">
                    {botName(row.agentId)} · {task}
                  </span>
                </span>
                <span className="c-tag" data-tone={STATUS_TONE[row.status]}>
                  {tag}
                </span>
                <span className="c-log-source" data-cause={row.cause.kind}>
                  {cause}
                </span>
              </button>
              {expanded && (
                <div className="c-log-open">
                  <dl className="facts">
                    <div>
                      <dt>Run</dt>
                      <dd className="mono b-wrap-value">{row.runId}</dd>
                    </div>
                    {row.callId && (
                      <div>
                        <dt>Call</dt>
                        <dd className="mono b-wrap-value">{row.callId}</dd>
                      </div>
                    )}
                    <div>
                      <dt>The gateway's record</dt>
                      <dd className="mono b-wrap-value">{row.recordId}</dd>
                    </div>
                    {row.cause.kind === "recorded" && (
                      <div>
                        <dt>The rules plugin's record</dt>
                        <dd className="mono b-wrap-value">{row.cause.recordId}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Kept until</dt>
                      <dd>{fullDate(row.at + AUDIT_DAYS * DAY)} at most</dd>
                    </div>
                  </dl>
                  {row.inChat ? (
                    <div className="b-actions">
                      <button
                        type="button"
                        className="button"
                        data-size="sm"
                        onClick={() =>
                          row.inChat &&
                          onShowInChat({
                            botId: row.agentId,
                            key: row.inChat.key,
                            callId: row.inChat.callId,
                          })
                        }
                      >
                        Show in chat
                      </button>
                    </div>
                  ) : (
                    <p className="b-hint">This step isn't in a task this device has loaded.</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );

  const ready = load.status === "ready" ? load.value : null;
  return (
    <div data-testid="activity-part">
      <p className="b-hint c-lead">
        What your bots did with their tools, and what a record says caused it.
      </p>
      {filters}
      {ready?.recording === "off" && rows.length > 0 && (
        <p className="b-hint" role="status">
          The gateway isn't recording activity now: its audit log is switched off in its settings.
        </p>
      )}
      {ready?.decisionsUnread && (
        <p className="b-hint" role="status">
          Clawtrate's rules plugin's records couldn't be read. {ready.decisionsUnread}
        </p>
      )}
      {pluginListed === false && rows.length > 0 && (
        <p className="b-hint">
          Causes come only from Clawtrate's rules plugin's decision record, which this gateway
          doesn't have.
        </p>
      )}
      {list}
      {ready && rows.length > 0 && ready.nextCursor && (
        <div className="b-actions c-older">
          <button
            type="button"
            className="button"
            data-variant="quiet"
            data-size="sm"
            disabled={older === "loading"}
            onClick={more}
          >
            {older === "loading" ? "Loading…" : "Show older"}
            <ChevronIcon />
          </button>
        </div>
      )}
      {older !== "idle" && older !== "loading" && (
        <p className="b-hint" role="alert">
          {older}
        </p>
      )}
      {ready && rows.length > 0 && !ready.nextCursor && (
        <p className="b-hint" data-testid="activity-end">
          No older records available.
        </p>
      )}
      <p className="b-hint">
        The gateway keeps 30 days of activity, up to 100,000 records, without arguments or results.
        A call to a tool the gateway removed leaves no record here.
      </p>
    </div>
  );
}
