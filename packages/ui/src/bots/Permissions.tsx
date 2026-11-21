// What a bot may do (docs/design/controls.md sections 2 to 5), in the Work
// pane's Settings tab: the row with its counts, the bot's permissions page
// (the rules plugin's state, the glance, the lines) and one line's page with
// its choice and its facts. Everything shown is what the gateway and the
// rules plugin answered, read when the page opens, every 60 seconds while it
// shows, and after each save; a save is announced only once its read-back
// shows it. Nothing here predicts what happens to a particular call.

import {
  choiceRefusal,
  EXEC_WORDS,
  permissionGroups,
  VALUE_WORDS,
  type Bot,
  type BotPermissions,
  type ConnectionState,
  type ExecPolicy,
  type HostInfo,
  type LineException,
  type LineMark,
  type PermissionChoice,
  type PermissionLine,
  type PermissionWrite,
  type ToolList,
} from "@clawtrate/core";
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useBridge } from "../bridge.tsx";
import {
  BackIcon,
  ChevronIcon,
  FileIcon,
  LockIcon,
  PlugIcon,
  ShieldIcon,
  WarnIcon,
} from "../icons.tsx";
import { Confirm } from "./Dialog.tsx";
import { AdminBar, GrantedBar, Note, useGranted } from "./parts.tsx";
import { clock } from "./words.ts";
import "./permissions.css";

/** How often an open page reads the permissions again (section 23). */
export const PERMISSIONS_READ_MS = 60_000;

type Read =
  | { status: "loading"; view: null; error: null }
  | { status: "ready"; view: BotPermissions; error: null }
  | { status: "error"; view: BotPermissions | null; error: string };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** An error's words inside a sentence of the page's: without their own full stop. */
const unstopped = (text: string) => text.replace(/\.+$/, "");

/** One bot's permissions, read while `shown`: on opening, on each new connection and every 60 s. */
export function usePermissions(botId: string, shown: boolean, connection: ConnectionState) {
  const bridge = useBridge();
  const connected = connection.status === "connected";
  // A view belongs to the bot and the connection it was read on. Another bot, or a new
  // connection (a reconnect, another gateway), shows nothing old as current: until its own read
  // lands it is loading, and answers to reads made before are dropped. While disconnected the
  // last view stays, said as last read.
  const key = `${botId}\n${connection.gatewayUrl ?? ""}\n${connection.connectedAt ?? ""}`;
  const [stored, setRead] = useState<Read & { key: string }>({ ...LOADING, key });
  const generation = useRef(0);
  const reload = useCallback(() => {
    const mine = (generation.current += 1);
    bridge
      .invoke({ type: "readPermissions", botId })
      .then((view) => {
        if (mine === generation.current) setRead({ status: "ready", view, error: null, key });
      })
      .catch((error: unknown) => {
        if (mine === generation.current)
          setRead((was) => ({
            status: "error",
            view: was.key === key ? was.view : null,
            error: errorText(error),
            key,
          }));
      });
  }, [bridge, botId, key]);
  useEffect(() => {
    if (!shown || !connected) return;
    reload();
    const timer = setInterval(reload, PERMISSIONS_READ_MS);
    return () => clearInterval(timer);
  }, [shown, connected, reload]);
  const replace = useCallback(
    (view: BotPermissions) => {
      generation.current += 1;
      setRead({ status: "ready", view, error: null, key });
    },
    [key],
  );
  // A write with no read-back leaves the last view, said as last read.
  const lose = useCallback(
    (error: string) => {
      generation.current += 1;
      setRead((was) => ({ status: "error", view: was.key === key ? was.view : null, error, key }));
    },
    [key],
  );
  const same = stored.key === key || (!connected && stored.key.split("\n")[0] === botId);
  const read: Read = same ? stored : LOADING;
  return { read, reload, replace, lose };
}

const LOADING: Read = { status: "loading", view: null, error: null };

// Words -------------------------------------------------------------------------------------

const MARK_WORDS: Record<Exclude<LineMark, null>, string> = {
  set: "Set on the gateway",
  gateway: "The gateway enforces this",
  plugin: "Only while Clawtrate's rules plugin runs",
  "not-now": "Not enforced now: the rules plugin isn't enforcing its rules",
  unread: "Unknown: the rules plugin may enforce rules Clawtrate didn't read now",
};
const MARK_ICONS: Record<Exclude<LineMark, null>, ReactNode> = {
  set: <LockIcon />,
  gateway: <ShieldIcon />,
  plugin: <PlugIcon />,
  "not-now": <WarnIcon />,
  unread: <WarnIcon />,
};

/** Whether the gateway didn't confirm it is using the settings it has stored. */
const notInUse = (view: BotPermissions) => view.settingsApplied !== "yes";
/** What is said instead of in-force counts while the gateway doesn't confirm its settings. */
export const STORED_WORDS =
  "Stored permissions. The gateway did not confirm which settings it is using.";
const fromSettings = (mark: LineMark) => mark === "set" || mark === "gateway";

/** Who holds a line. The gateway's stored settings it doesn't use yet hold nothing for sure. */
function markWords(mark: Exclude<LineMark, null>, stored: boolean): string {
  return stored && fromSettings(mark)
    ? "Stored in the gateway's settings, not confirmed in use"
    : MARK_WORDS[mark];
}

export function Mark({ mark, stored = false }: { mark: LineMark; stored?: boolean }) {
  if (!mark) return null;
  return (
    <span
      className="c-mark"
      data-tone={
        mark === "not-now" || mark === "unread" || (stored && fromSettings(mark))
          ? "danger"
          : undefined
      }
    >
      {MARK_ICONS[mark]}
      {markWords(mark, stored)}
    </span>
  );
}

const LIST_WORDS: Record<ToolList, (name: string) => string> = {
  "every-allow": () => "The gateway's allow list for every bot",
  "every-deny": () => "The gateway's deny list for every bot",
  "bot-allow": (name) => `${name}'s allow list`,
  "bot-deny": (name) => `${name}'s deny list`,
};

const list = (items: readonly string[]) =>
  items.length > 1
    ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
    : (items[0] ?? "");

function exceptionWords(
  e: LineException,
  name: string,
  pre: string,
  lineTools: readonly string[],
  listedAt: number,
): string {
  const owner = (scope: "bot" | "every") =>
    scope === "bot" ? `${name}'s rule` : "a rule for every bot";
  switch (e.kind) {
    case "every-deny":
      return `Never: ${list(e.tools)} (set on the gateway)`;
    case "bot-deny":
      return `Never: ${list(e.tools)} (${name}'s settings${e.entries?.length ? `: ${list(e.entries)}` : ""})`;
    case "not-offered":
      return e.by === "every"
        ? `Not offered: ${list(e.tools)} (set on the gateway)`
        : `Not in ${name}'s allow list: ${list(e.tools)}`;
    case "not-listed":
      return `Not in ${name}'s latest task's tools as the gateway listed them at ${clock(listedAt)}: ${list(e.tools)}`;
    case "unnamed":
      return `The gateway hasn't named this server's tools in ${name}'s latest task's listing`;
    case "list-cut":
      return `Unknown: ${list(e.lists.map((each) => LIST_WORDS[each](name)))} ${e.lists.length === 1 ? "is" : "are"} longer than this page reads, and the entries it couldn't read may deny these tools`;
    case "ask-every-call":
      return "The rules plugin asks before every tool call but a question: its rules file can't be read";
    case "fallback":
      return `${pre}"Ask when nothing else decides" is on for ${e.scope === "bot" ? name : "every bot"}`;
    case "rule": {
      // A rule on some of the line's tools names them.
      const some = e.tools.length < lineTools.length ? `: ${list(e.tools)}` : "";
      const what = e.pattern ?? null;
      const words =
        e.action === "never"
          ? what
            ? `Never under ${what}`
            : `Never${some}`
          : e.action === "ask"
            ? what
              ? `Asks before ${what}`
              : `Asks first${some}`
            : what
              ? `Allow rule: ${what}`
              : "Allow rule";
      return `${pre}${words} (${owner(e.scope)}, version ${e.version})`;
    }
  }
}

function execSub(line: PermissionLine, name: string): string {
  const exec = line.exec!;
  const policy = exec.own
    ? `${name}'s setting: ${EXEC_WORDS[exec.own]}`
    : exec.every
      ? `Default for every bot: ${EXEC_WORDS[exec.every]}`
      : EXEC_WORDS.none;
  return policy;
}

function subWords(line: PermissionLine, view: BotPermissions, name: string): string[] {
  // A rule shown is enforced now, not enforced now, or as this client last read it.
  const pre =
    view.enforcement === "read"
      ? ""
      : view.enforcement === "unread"
        ? "As Clawtrate last read it: "
        : "Not enforced now: ";
  const out: string[] = [];
  if (line.kind === "exec" && line.value !== "never") out.push(execSub(line, name));
  for (const e of line.exceptions) out.push(exceptionWords(e, name, pre, line.tools, view.readAt));
  return out;
}

/** The exception the glance names beside a line: the rules that make it Limited, or whose setting asks. */
function glanceExtra(line: PermissionLine, name: string): string | null {
  if (line.kind === "exec" && line.value === "asks" && line.exec?.own)
    return `${name}'s setting: ${EXEC_WORDS[line.exec.own]}`;
  if (line.value !== "limited") return null;
  // A Limited line names what holds part of it back: the tools asked about or denied, the paths a
  // rule asks before or refuses, the tools the latest task wasn't offered.
  const parts: string[] = [];
  const asked = line.exceptions.flatMap((e) =>
    e.kind === "rule" && e.action === "ask"
      ? [e.pattern ? `before ${e.pattern}` : `only ${list(e.tools)}`]
      : [],
  );
  if (asked.length > 0) parts.push(list(asked));
  const denied = line.exceptions.flatMap((e) =>
    e.kind === "bot-deny" || e.kind === "every-deny" ? e.tools : [],
  );
  if (denied.length > 0) parts.push(`except ${list(denied)}`);
  const under = line.exceptions.flatMap((e) =>
    e.kind === "rule" && e.action === "never" && e.pattern ? [e.pattern] : [],
  );
  if (under.length > 0) parts.push(`not under ${list(under)}`);
  const unlisted = line.exceptions.flatMap((e) => (e.kind === "not-listed" ? e.tools : []));
  if (unlisted.length > 0) parts.push(`${list(unlisted)} not listed`);
  return parts.length > 0 ? parts.join("; ") : null;
}

/** The lines whose value is a verdict; Run commands shows its configured mode instead. */
const verdictLines = (view: BotPermissions) => view.lines.filter((line) => line.kind !== "exec");

/** The settings row's counts: verdicts only, and none while the settings aren't confirmed in use. */
export const countWords = (view: BotPermissions) => {
  if (notInUse(view)) return STORED_WORDS;
  const g = permissionGroups(verdictLines(view));
  const fallback = view.fallback.bot || view.fallback.every;
  const parts = fallback
    ? [`${g.never.length} never`, "the rules plugin can ask for other calls"]
    : [
        `${g.never.length} never`,
        `${g.asks.length} ask first`,
        `${g.without.length} without asking`,
      ];
  if (g.unknown.length > 0) parts.push(`${g.unknown.length} unknown`);
  return parts.join(" · ");
};

function pluginWords(view: BotPermissions, name: string): { text: string; tone?: "danger" } {
  const p = view.plugin;
  switch (p.kind) {
    case "unchecked":
      return { text: "Checking Clawtrate's rules plugin…" };
    case "unavailable":
      return { text: "Rules methods unavailable on this gateway." };
    case "stopped":
      return p.answered
        ? {
            text: `Clawtrate's rules plugin isn't enforcing its rules. ${p.reason}`,
            tone: "danger",
          }
        : { text: `Clawtrate's rules plugin: Unavailable (${p.reason}).`, tone: "danger" };
    case "old":
      return {
        text: `Clawtrate's rules plugin is version ${p.version}; ${name}'s rules need 1.0.0 or newer.`,
        tone: "danger",
      };
    case "running": {
      const seen = p.lastCallAt
        ? `Last tool call seen ${clock(p.lastCallAt)}.`
        : "No tool call seen since the gateway started.";
      if (p.rules !== "lost")
        return { text: `Rules plugin answered at ${clock(p.answeredAt)}. ${seen}` };
      const inForce =
        p.enforcing === "kept-copy" && p.keptCopyReadAt
          ? `It enforces the copy of its rules it read at ${clock(p.keptCopyReadAt)}.`
          : "It asks before every tool call except a question.";
      return {
        text: `Rules plugin answered at ${clock(p.answeredAt)}, and its rules file can't be read${p.lostReason ? ` (${p.lostReason})` : ""}. ${inForce} It refuses to show or change its rules until the file is restored.`,
        tone: "danger",
      };
    }
  }
}

/** The not-enforced note (section 2): what isn't held, or can't be known, about the plugin's rules. */
function NotEnforced({ view, name }: { view: BotPermissions; name: string }) {
  const p = view.plugin;
  if (view.enforcement === "unread") {
    if (p.kind === "unchecked") return null;
    const why =
      p.kind === "running"
        ? p.enforcing === "kept-copy"
          ? `enforces a copy of its rules${p.keptCopyReadAt ? ` it read at ${clock(p.keptCopyReadAt)}` : ""} and won't show it`
          : "didn't answer Clawtrate's read of its rules"
        : p.kind === "old"
          ? "is too old to read"
          : "didn't answer";
    return (
      <Note tone="danger" testId="not-enforced">
        <p>
          <b>Enforcement not confirmed.</b> Clawtrate's rules plugin {why}, so Clawtrate can't tell
          which of {name}'s tools its rules ask about or refuse: those lines are Unknown. The
          gateway's own restrictions still apply.{" "}
          <span className="b-faint">
            {view.rules.from === null
              ? "Clawtrate hasn't read its rules since it last started."
              : `Rules shown as Clawtrate last read them, ${clock(view.rules.readAt)}.`}
          </span>
        </p>
        <p className="b-hint">To deny a tool, open its line below and choose Never.</p>
      </Note>
    );
  }
  if (view.enforcement !== "none" || p.kind === "unavailable") return null;
  if (view.rules.from === null)
    return (
      <Note tone="danger" testId="not-enforced">
        <p>
          <b>Enforcement not confirmed.</b> Clawtrate's rules plugin reports it isn't enforcing its
          rules, and Clawtrate hasn't read them since it last started, so it can't tell which aren't
          being enforced. The gateway's own restrictions still apply.
        </p>
        <p className="b-hint">To deny a tool, open its line below and choose Never.</p>
      </Note>
    );
  const lines = view.lines.filter((line) => line.mark === "not-now");
  if (lines.length === 0) return null;
  return (
    <Note tone="danger" testId="not-enforced">
      <p>
        <b>Enforcement not confirmed.</b> Clawtrate cannot confirm these plugin rules are being
        enforced: {list(lines.map((l) => l.words))}. The gateway's own restrictions still apply.{" "}
        <span className="b-faint">
          Rules as Clawtrate last read them, {clock(view.rules.readAt)}.
        </span>
      </p>
      <p className="b-hint">To deny a tool, open its line below and choose Never.</p>
    </Note>
  );
}

// The row in the bot's settings ---------------------------------------------------------------

export function PermissionsRow({
  bot,
  connection,
  visible,
  onOpen,
}: {
  bot: Bot;
  connection: ConnectionState;
  visible: boolean;
  onOpen: () => void;
}) {
  const { read } = usePermissions(bot.id, visible, connection);
  // A read that failed is Unavailable, never the counts of an earlier read.
  const value =
    read.status === "error"
      ? "Unavailable"
      : read.view !== null
        ? countWords(read.view)
        : "Loading…";
  return (
    <dl className="facts">
      <div>
        <button
          type="button"
          className="b-open c-wraprow"
          data-bs="permissions"
          aria-label={`What ${bot.name} may do: ${value}. Open.`}
          onClick={onOpen}
        >
          <span>What {bot.name} may do</span>
          <span className="c-wrapvalue" data-testid="permission-counts">
            {value}
          </span>
          <ChevronIcon />
        </button>
      </div>
    </dl>
  );
}

// The page --------------------------------------------------------------------------------------

export function Permissions({
  bot,
  connection,
  info,
  visible,
  announce,
  onBack,
}: {
  bot: Bot;
  connection: ConnectionState;
  info: HostInfo;
  visible: boolean;
  announce: (text: string) => void;
  onBack: () => void;
}) {
  const { read, reload, replace, lose } = usePermissions(bot.id, visible, connection);
  const [lineId, setLineId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const name = bot.name;
  // Focus a control of the page; when it is gone (its line left the summary), the page's heading.
  const focusIn = (selector: string) =>
    requestAnimationFrame(() => {
      const root = rootRef.current;
      const target = root?.querySelector<HTMLElement>(selector);
      const shown = target && target.getClientRects().length > 0 ? target : null;
      (shown ?? root?.querySelector<HTMLElement>("[data-bs-focus]"))?.focus();
    });
  // Back returns focus to the control that opened the line: its row, or its link in the glance.
  const opener = useRef<string | null>(null);
  const open = (id: string, from: "row" | "glance" = "row") => {
    opener.current = `[data-c-${from === "glance" ? "glance" : "line"}="${CSS.escape(id)}"]`;
    setLineId(id);
    focusIn("[data-bs-focus]");
  };
  const back = () => {
    setLineId(null);
    focusIn(opener.current ?? "[data-bs-focus]");
  };
  const [forBot, setForBot] = useState(bot.id);
  if (forBot !== bot.id) {
    setForBot(bot.id);
    setLineId(null);
  }
  // Opened from the settings' row: the page's title takes focus.
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>("[data-bs-focus]")?.focus();
  }, []);
  const granted = useGranted(connection);
  const foot = granted ? (
    <GrantedBar />
  ) : !connection.canAdmin ? (
    <div className="b-panel-foot">
      <AdminBar
        connection={connection}
        info={info}
        need={`Changing ${name}'s permissions needs admin access.`}
      />
    </div>
  ) : null;
  const view = read.view;
  const line = lineId && view ? view.lines.find((each) => each.id === lineId) : null;
  // A read again that failed, a write with no read-back, or no connection: the last view, said as such.
  const staleError =
    read.status === "error"
      ? read.error
      : connection.status !== "connected"
        ? "not connected to the gateway"
        : null;
  // An open line the latest read no longer has: the overview shows, and its heading takes focus.
  const vanished = lineId !== null && view !== null && !line;
  useEffect(() => {
    if (!vanished) return;
    const frame = requestAnimationFrame(() =>
      rootRef.current?.querySelector<HTMLElement>("[data-bs-focus]")?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [vanished]);
  const stale =
    staleError !== null && view ? (
      <Note tone="warn" testId="stale-read">
        <p>
          Couldn't read {name}'s permissions again: {unstopped(staleError)}. This shows what
          Clawtrate read at {clock(view.readAt)}.
        </p>
        <div style={{ marginTop: 8 }}>
          <button type="button" className="button" data-size="sm" onClick={reload}>
            Try again
          </button>
        </div>
      </Note>
    ) : null;
  if (line && view)
    return (
      <div ref={rootRef} className="b-tab" data-testid="permission-line">
        <Subhead title={line.words} back={`Back to what ${name} may do`} onBack={back} />
        {stale}
        <LinePage
          key={line.id}
          bot={bot}
          view={view}
          line={line}
          admin={connection.canAdmin}
          announce={announce}
          onRead={replace}
          onUnread={lose}
        />
        {foot}
      </div>
    );
  return (
    <div ref={rootRef} className="b-tab" data-testid="permissions">
      <Subhead title={`What ${name} may do`} back="Back to settings" onBack={onBack} />
      {view === null ? (
        read.status === "error" ? (
          <div className="work-empty">
            <span className="empty-mark">
              <WarnIcon />
            </span>
            <h4>What {name} may do: Unavailable</h4>
            <p>{read.error}</p>
            <div style={{ marginTop: 10 }}>
              <button type="button" className="button" data-size="sm" onClick={reload}>
                Try again
              </button>
            </div>
          </div>
        ) : (
          <div
            aria-busy="true"
            aria-label={`Loading what ${name} may do`}
            data-testid="permissions-loading"
          >
            <div className="skeleton" style={{ height: 40, width: "100%", marginTop: 12 }} />
            <div className="skeleton" style={{ height: 88, width: "100%", marginTop: 10 }} />
            {[0, 1, 2, 3].map((each) => (
              <div
                key={each}
                className="skeleton"
                style={{ height: 48, width: "100%", marginTop: 10 }}
              />
            ))}
          </div>
        )
      ) : (
        <>
          {stale}
          <Overview view={view} name={name} onLine={open} />
        </>
      )}
      {foot}
    </div>
  );
}

function Subhead({ title, back, onBack }: { title: string; back: string; onBack: () => void }) {
  return (
    <div className="b-subhead">
      <button
        type="button"
        className="icon-button"
        data-variant="quiet"
        aria-label={back}
        onClick={onBack}
      >
        <BackIcon />
      </button>
      <h3 tabIndex={-1} data-bs-focus="">
        {title}
      </h3>
    </div>
  );
}

function PluginLine({ view, name }: { view: BotPermissions; name: string }) {
  const { text, tone } = pluginWords(view, name);
  return (
    <p className="c-plugin" role="status" data-tone={tone} data-testid="rules-plugin">
      <PlugIcon />
      <span>{text}</span>
    </p>
  );
}

/**
 * "For these rules to hold": configured facts and what the page can't know. Nothing here says
 * what a bot can or can't do at run time: a task's own settings and the machine decide that.
 */
export function holdsWords(
  view: BotPermissions,
  name: string,
): Array<{ text: string; tone?: "warn" }> {
  const out: Array<{ text: string; tone?: "warn" }> = [];
  const gateway = view.lines.find((line) => line.id === "gateway");
  if (gateway) {
    const denied = gateway.exceptions.flatMap((e) =>
      e.kind === "bot-deny" || e.kind === "every-deny" ? e.tools : [],
    );
    const fact =
      gateway.value === "never" && fromSettings(gateway.mark)
        ? "denied in the gateway's settings"
        : denied.length > 0
          ? `${list(denied)} denied in the gateway's settings, the rest not denied there`
          : "not denied in the gateway's settings";
    const text = `Configured for ${name}: ${list(gateway.tools)}, the tools that change the gateway and its plugins and so its rules: ${fact}.`;
    out.push(fact.startsWith("denied") ? { text } : { text, tone: "warn" });
  }
  if (view.lines.some((line) => line.kind === "exec"))
    out.push({
      text: "Command access depends on the task and machine. Commands run on the gateway's machine outside a sandbox can change its files.",
      tone: "warn",
    });
  out.push({ text: "A rule about a file tool covers that tool, not the file." });
  return out;
}

/** The configured command mode a Run commands line shows in place of a verdict. */
const configuredMode = (line: PermissionLine) =>
  `Configured: ${EXEC_WORDS[line.exec?.own ?? line.exec?.every ?? "none"]}`;

function Overview({
  view,
  name,
  onLine,
}: {
  view: BotPermissions;
  name: string;
  onLine: (id: string, from?: "row" | "glance") => void;
}) {
  // Run commands is a configured mode, kept out of the verdicts' groups and counts.
  const groups = permissionGroups(verdictLines(view));
  const byId = new Map(view.lines.map((line) => [line.id, line]));
  const stored = notInUse(view);
  const of = (ids: string[]) => ids.map((id) => byId.get(id)!).filter(Boolean);
  const fallback = view.fallback.bot || view.fallback.every;
  const blocks: Array<{ title: string; kind: string; lines: PermissionLine[] }> = [
    { title: "Never", kind: "never", lines: of(groups.never) },
    ...(fallback
      ? [
          {
            title: "The rules plugin can ask for other calls",
            kind: "ask",
            lines: of([...groups.asks, ...groups.without]),
          },
        ]
      : [
          { title: "Asks first", kind: "ask", lines: of(groups.asks) },
          { title: "Without asking", kind: "allow", lines: of(groups.without) },
        ]),
    // Unknown lines: rules the plugin answered it isn't enforcing, apart from rules not read now.
    ...[
      { title: "Not enforced now", lines: of(groups.unknown).filter((l) => l.mark === "not-now") },
      { title: "Unknown", lines: of(groups.unknown).filter((l) => l.mark !== "not-now") },
    ]
      .filter((block) => block.lines.length > 0)
      .map((block) => ({ ...block, kind: "unknown" })),
  ];
  const offeredLine =
    view.offered.status === "no-task"
      ? `${name} hasn't run yet, so the gateway hasn't listed its tools. These lines come from its settings.`
      : view.offered.status === "failed"
        ? `The gateway's listing of ${name}'s latest task couldn't be read${view.offered.reason ? ` (${view.offered.reason})` : ""}. These lines come from its settings.`
        : `From ${name}'s settings and the gateway's, read at ${clock(view.readAt)}. Each line opens its exact rule.`;
  const notOffered = of(groups.notOffered);
  const execLine = byId.get("exec");
  const everyRules = view.lines.reduce(
    (n, line) => n + line.exceptions.filter((e) => e.kind === "rule" && e.scope === "every").length,
    0,
  );
  return (
    <>
      <PluginLine view={view} name={name} />
      <NotEnforced view={view} name={name} />
      {stored && (
        <Note tone="warn" testId="not-applied">
          <p>{STORED_WORDS}</p>
        </Note>
      )}
      {view.unread.length > 0 && (
        <Note tone="warn" testId="unread">
          <p>
            Clawtrate doesn't read these of the gateway's settings, and they can remove tools:{" "}
            {list(view.unread)}. The lines leave them out; a tool missing from {name}'s latest
            task's listing is named on its line.
          </p>
        </Note>
      )}
      {view.listsCut.length > 0 && (
        <Note tone="warn" testId="lists-cut">
          <p>
            {list(view.listsCut.map((each) => LIST_WORDS[each](name)))}{" "}
            {view.listsCut.length === 1 ? "is" : "are"} longer than this page reads (256 entries of
            up to 128 characters), or {view.listsCut.length === 1 ? "has" : "have"} an entry it
            can't read whole. The lines below leave out what was cut.
            {view.listsCut.includes("bot-deny") &&
              ` Clawtrate won't replace ${name}'s deny list, so its choices are off.`}
          </p>
        </Note>
      )}
      <div className="c-glance" data-testid="glance">
        {blocks.map((block) => (
          <section
            key={block.title}
            className="c-glance-block"
            data-kind={block.kind}
            data-empty={block.lines.length === 0 ? "" : undefined}
            aria-label={
              (block.lines.length === 0 ? `${block.title}: nothing` : block.title) +
              (stored ? ", stored" : "")
            }
          >
            <h4>
              {block.title}
              {stored ? (
                <span className="b-faint"> stored</span>
              ) : (
                <>
                  {" "}
                  <span className="c-glance-n">{block.lines.length}</span>
                </>
              )}
              {block.lines.length === 0 && <span className="b-faint">Nothing</span>}
            </h4>
            {block.lines.length > 0 && (
              <p>
                {block.lines.map((line, index) => {
                  const extra = glanceExtra(line, name);
                  const last = index === block.lines.length - 1;
                  return (
                    <Fragment key={line.id}>
                      {index > 0 && " "}
                      <button
                        type="button"
                        className="c-glance-link"
                        data-c-glance={line.id}
                        aria-label={extra ? `${line.words} (${extra})` : line.words}
                        onClick={() => onLine(line.id, "glance")}
                      >
                        {line.words}
                        {extra && <span className="c-glance-extra"> ({extra})</span>}
                        {last ? "" : ","}
                      </button>
                    </Fragment>
                  );
                })}
              </p>
            )}
          </section>
        ))}
      </div>
      <p className="b-hint">{offeredLine}</p>
      {blocks.map((block) =>
        block.lines.length === 0 ? null : (
          <div key={block.title}>
            <h4 className="b-group">
              {block.title}
              {stored ? " (stored)" : ""}
            </h4>
            <dl className="facts">
              {block.lines.map((line) => (
                <LineRow key={line.id} line={line} view={view} name={name} onOpen={onLine} />
              ))}
            </dl>
          </div>
        ),
      )}
      {notOffered.length > 0 && (
        <details className="b-disclosure">
          <summary>
            <ChevronIcon />
            Not offered to {name}: {notOffered.length} {notOffered.length === 1 ? "line" : "lines"}
          </summary>
          <div className="b-disclosure-body">
            <dl className="facts">
              {notOffered.map((line) => (
                <LineRow key={line.id} line={line} view={view} name={name} onOpen={onLine} />
              ))}
            </dl>
          </div>
        </details>
      )}
      {execLine && (
        <>
          <h4 className="b-group">Commands</h4>
          <dl className="facts">
            <LineRow line={execLine} view={view} name={name} onOpen={onLine} />
          </dl>
        </>
      )}
      {view.linesOmitted > 0 && (
        <p className="b-hint">{view.linesOmitted} more tools aren't shown.</p>
      )}
      <h4 className="b-group">For these rules to hold</h4>
      <ul className="c-holds" data-testid="holds">
        {holdsWords(view, name).map((item) => (
          <li key={item.text} data-tone={item.tone}>
            {item.tone === "warn" ? <WarnIcon /> : <FileIcon />}
            {item.text}
          </li>
        ))}
      </ul>
      <p className="b-hint">
        Rules for every bot also apply
        {everyRules > 0 ? ` (${everyRules} on ${name}'s lines)` : ""}. Their page, in Settings,
        Permissions, isn't built yet.
      </p>
    </>
  );
}

function LineRow({
  line,
  view,
  name,
  onOpen,
}: {
  line: PermissionLine;
  view: BotPermissions;
  name: string;
  onOpen: (id: string) => void;
}) {
  const subs = subWords(line, view, name);
  const value = line.kind === "exec" ? configuredMode(line) : VALUE_WORDS[line.value];
  const label = [line.words, value, ...subs, line.mark ? markWords(line.mark, notInUse(view)) : ""]
    .filter(Boolean)
    .join(", ");
  return (
    <div>
      <button
        type="button"
        className="b-open c-line"
        data-c-line={line.id}
        aria-label={`${label}. Open.`}
        onClick={() => onOpen(line.id)}
      >
        <span className="c-line-main">
          <span className="c-line-words">
            <span className={line.kind === "tool" ? "c-tool-name" : undefined}>{line.words}</span>
            {subs.map((text) => (
              <small key={text} data-tone={line.value === "unknown" ? "danger" : undefined}>
                {text}
              </small>
            ))}
            <Mark mark={line.mark} stored={notInUse(view)} />
          </span>
        </span>
        <span className="c-line-value">
          <b data-tone={line.value === "unknown" ? "warn" : undefined}>{value}</b>
        </span>
        <ChevronIcon />
      </button>
    </div>
  );
}

// One line, opened -----------------------------------------------------------------------------

const GROUP_CHOICES: Array<{ value: PermissionChoice; label: string; shown: string }> = [
  { value: "allow", label: "Allow", shown: "allow" },
  { value: "ask", label: "Ask", shown: "ask" },
  { value: "never", label: "Never", shown: "never" },
];
const EXEC_CHOICES: Array<{ value: PermissionChoice; label: string; shown: ExecPolicy }> = [
  { value: "full", label: "Allow all", shown: "full" },
  { value: "auto", label: "Review first", shown: "auto" },
  { value: "exec-ask", label: "Ask", shown: "ask" },
  { value: "deny", label: "Never", shown: "deny" },
];
const SAVED_WORDS: Record<PermissionChoice, string> = {
  allow: "allowed",
  ask: "asks first",
  never: "never",
  full: "allow all",
  auto: "review first",
  "exec-ask": "ask",
  deny: "never",
};

/** What a save's answer says: the words announced, and the note under the choices. */
export function saveNote(
  result: PermissionWrite,
  choice: PermissionChoice,
  line: Pick<PermissionLine, "words">,
  name: string,
): { announce: string | null; note: { text: string; tone?: "warn" | "danger" } | null } {
  const now = (failedToo: string) =>
    result.view
      ? "This shows what the gateway has now."
      : `Reading what the gateway has now ${failedToo}.`;
  switch (result.outcome) {
    case "saved":
      return { announce: `Saved. ${line.words}: ${SAVED_WORDS[choice]}`, note: null };
    case "conflict":
      return {
        announce: null,
        note: { text: `Someone else changed ${name}'s settings. ${now("failed")}`, tone: "warn" },
      };
    case "stored":
      return {
        announce: "Stored, not confirmed in use",
        note: {
          text: `Saved in the gateway's settings, and not confirmed in use: ${unstopped(result.error ?? "the gateway didn't say")}. This shows the stored settings.`,
          tone: "warn",
        },
      };
    case "unconfirmed":
      return {
        announce: "Couldn't be confirmed",
        note: {
          text: `Sent, but whether it was saved couldn't be confirmed: ${unstopped(result.error ?? "the gateway's answer was lost")}. ${now("failed too")}`,
          tone: "warn",
        },
      };
    case "partial":
      // The rules plugin's part landed; whether the deny list changed is not known.
      return {
        announce: "Saved in part",
        note: {
          text: `The rules plugin saved ${name}'s ${choice === "ask" ? "Ask" : "rule change"}. Clawtrate couldn't confirm the deny-list change. ${unstopped(result.error ?? "The gateway didn't say why")}. ${now("failed")}`,
          tone: "warn",
        },
      };
    case "not-shown":
      return {
        announce: null,
        note: {
          text: `Sent, but ${name}'s settings read back don't show it. This shows what the gateway has now.`,
          tone: "warn",
        },
      };
    case "failed":
      return {
        announce: "Couldn't save",
        note: {
          text: `Couldn't save: ${unstopped(result.error ?? "the gateway refused it")}. ${now("failed too")}`,
          tone: "danger",
        },
      };
  }
}

/** The sentence under a line's choices: what the reads establish about it, and nothing more. */
export function sentence(line: PermissionLine, view: BotPermissions, name: string): string {
  // Stored settings the gateway doesn't use yet are said as stored, never as in force.
  if (notInUse(view) && fromSettings(line.mark) && line.kind !== "exec")
    return `${name}'s stored settings say ${VALUE_WORDS[line.value]}. ${view.settingsApplied === "no" ? "The gateway reports it isn't using its stored settings yet" : "The gateway did not confirm which settings it is using"}, so this may not be in force.`;
  const verb = line.words.charAt(0).toLowerCase() + line.words.slice(1);
  if (line.kind === "question")
    return `${name} asks its questions in the conversation, which already waits for you.`;
  if (line.value === "not-offered" && line.mark === "set")
    return `The gateway's settings for every bot don't offer this to ${name}. Set on the gateway; Clawtrate can't change it.`;
  if (line.value === "not-offered" && line.mark === "gateway")
    return `${name}'s own allow list in the gateway's settings leaves this out. This page doesn't change allow lists.`;
  if (line.value === "not-offered" && line.kind !== "server")
    return `The settings Clawtrate reads leave this open, and the gateway didn't list it in ${name}'s latest task's tools at ${clock(view.readAt)}. Something this page doesn't read may remove it.`;
  if (line.value === "never" && line.mark === "set")
    return `The gateway's settings deny this for every bot. Set on the gateway; Clawtrate can't change it, and no choice here can loosen it.`;
  if (line.kind === "exec") {
    // What the page reads: the configured setting, and whether the rules plugin applies. A
    // task's own settings and the machine's approvals file aren't read, so nothing is promised.
    const exec = line.exec!;
    const setting = exec.own
      ? `${name}'s command setting: ${EXEC_WORDS[exec.own]}.`
      : exec.every
        ? `${name} has no command setting of its own; the default for every bot is ${EXEC_WORDS[exec.every]}. A choice here sets one for ${name}.`
        : `Neither ${name} nor every bot has a command setting.`;
    const plugin =
      view.enforcement === "read"
        ? "Clawtrate's rules plugin checks its rules before it."
        : view.enforcement === "ask-every-call"
          ? "Clawtrate's rules plugin asks before every command."
          : view.enforcement === "unread"
            ? "Whether Clawtrate's rules plugin has rules for commands is unknown."
            : view.plugin.kind === "unavailable"
              ? "Clawtrate's rules plugin isn't on this gateway."
              : "Clawtrate's rules plugin isn't enforcing rules now.";
    const other =
      exec.applies === "allowlist" || exec.applies === "legacy"
        ? " It was set outside Clawtrate: choosing another value leaves it, and it can't be chosen again here."
        : "";
    return `${setting}${other} ${plugin} A task's own settings and the machine's approvals file can also ask or refuse; this page doesn't read them.`;
  }
  if (line.kind === "server" && line.tools.length === 0)
    return `The gateway hasn't named this server's tools in ${name}'s latest task's listing, so Clawtrate says nothing about them and can't allow, ask or deny them here. Once denied, a server's tools aren't listed: the deny is shown as its own line.`;
  if (line.kind === "entry")
    return line.value === "never" && line.mark === "gateway"
      ? `${name}'s deny list names ${line.words}. No tool the gateway lists for ${name} now has that name, so this page can't say what it removes. Allow takes it off the list.`
      : `${line.words} names no tool the gateway lists for ${name} now.`;
  // Rules the plugin may enforce that weren't read now: no Ask or Allow is presented as current.
  if (line.mark === "unread")
    return "Clawtrate could not confirm which rules the plugin is enforcing.";
  if (line.kind === "server")
    return `These are the tools the gateway listed for this server in ${name}'s latest task at ${clock(view.readAt)}.`;
  const can =
    line.kind === "plugin"
      ? `use the tools ${line.words.charAt(0).toLowerCase()}${line.words.slice(1)}`
      : line.kind === "tool"
        ? `use ${line.words}`
        : verb;
  if (line.choice === "never") {
    // What an attempt then looks like, said only for the kind established on a development
    // gateway (OpenClaw 2026.10.6, e2e/permissions.spec.ts): a tool group's.
    const these = line.tools.length > 1 ? "these tools" : "this tool";
    const attempt =
      line.kind === "group"
        ? ` The gateway removes ${these} from ${name}. If ${name} tries ${line.tools.length > 1 ? "one" : "it"}, the attempt fails as a tool that was not found.`
        : ` The gateway removes ${these} from ${name}.`;
    return `${name} can't ${can}.${attempt}`;
  }
  const ownDeny = line.exceptions.find((e) => e.kind === "bot-deny");
  if (line.choice === null && ownDeny?.kind === "bot-deny")
    return `${name}'s own settings deny only some of these tools: ${list(ownDeny.tools)}${ownDeny.entries?.length ? ` (${list(ownDeny.entries)})` : ""}. Never denies them all${line.heldBy.length > 0 ? "" : `; Allow takes ${name}'s deny off them`}.`;
  if (line.ownAsk)
    return `${name} asks you first. Only while Clawtrate's rules plugin runs.${line.undoAsk ? " Allow takes this Ask off." : ""}`;
  if (line.exceptions.some((e) => e.kind === "rule" || e.kind === "fallback"))
    return `${name}'s own setting is Allow. See Effective for the rules that apply.`;
  return `${name}'s own setting is Allow: nothing in its settings denies or asks.`;
}

function effectiveWords(line: PermissionLine, view: BotPermissions, name: string): string {
  if (line.kind === "exec")
    return "Not given as one verdict: the facts above are shown separately.";
  const subs = subWords(line, view, name);
  const words =
    subs.length > 0 ? `${VALUE_WORDS[line.value]}: ${subs.join("; ")}` : VALUE_WORDS[line.value];
  return notInUse(view) && fromSettings(line.mark)
    ? `${words}, by the stored settings; the gateway reports it isn't using them yet`
    : words;
}

function LinePage({
  bot,
  view,
  line,
  admin,
  announce,
  onRead,
  onUnread,
}: {
  bot: Bot;
  view: BotPermissions;
  line: PermissionLine;
  admin: boolean;
  announce: (text: string) => void;
  onRead: (view: BotPermissions) => void;
  onUnread: (error: string) => void;
}) {
  const bridge = useBridge();
  const name = bot.name;
  const [saving, setSaving] = useState<PermissionChoice | null>(null);
  const [note, setNote] = useState<{ text: string; tone?: "warn" | "danger" } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const exec = line.kind === "exec";
  const choices = exec ? EXEC_CHOICES : GROUP_CHOICES;
  const checked = line.choice;
  const other = exec && (checked === "allowlist" || checked === "legacy") ? checked : null;
  const refusal = (value: PermissionChoice) =>
    saving ? "Saving…" : choiceRefusal(view, line, value, admin);
  const save = async (choice: PermissionChoice) => {
    setSaving(choice);
    setNote(null);
    try {
      const result: PermissionWrite = await bridge.invoke({
        type: "setPermission",
        botId: bot.id,
        line: line.id,
        choice,
        configHash: view.configHash,
        rulesVersion: view.versions.bot,
      });
      if (result.view) onRead(result.view);
      // No read-back: the view shown stays, said as last read.
      else onUnread("the read after the change failed");
      const said = saveNote(result, choice, line, name);
      if (said.announce) announce(said.announce);
      setNote(said.note);
    } catch (error) {
      announce("Couldn't save");
      setNote({ text: `Couldn't save: ${errorText(error)}`, tone: "danger" });
    } finally {
      setSaving(null);
    }
  };
  const choose = (value: PermissionChoice) => {
    if (refusal(value)) return;
    const shown = choices.find((c) => c.value === value)!.shown;
    if (shown === checked) return;
    if (value === "full") setConfirm(true);
    else void save(value);
  };
  const reasons = [
    ...new Set(
      choices
        .map((c) => refusal(c.value))
        .filter((r): r is string => r !== null && r !== "Saving…"),
    ),
  ];
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const order = choices.map((c) => c.value);
    const at = Math.max(
      0,
      order.findIndex((v) => choices.find((c) => c.value === v)!.shown === checked),
    );
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (at + 1) % order.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = (at - 1 + order.length) % order.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = order.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target =
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-value]")[next];
    target?.focus();
    choose(order[next]!);
  };
  const facts: Array<[string, ReactNode]> = [
    [
      "Offered",
      line.offered === "yes"
        ? `Yes, in ${name}'s latest task's tools as the gateway listed them at ${clock(view.readAt)}`
        : line.offered === "no"
          ? `No: not in ${name}'s latest task's tools as the gateway listed them at ${clock(view.readAt)}`
          : view.offered.status === "no-task"
            ? "Not listed yet"
            : "The listing couldn't be read",
    ],
    [
      "Default for every bot",
      exec ? (
        line.exec?.every ? (
          <>
            Commands: {EXEC_WORDS[line.exec.every]} <Mark mark="set" stored={notInUse(view)} />
          </>
        ) : (
          "None"
        )
      ) : line.mark === "set" && line.value !== "allowed" ? (
        <>
          {VALUE_WORDS[line.value]} <Mark mark="set" stored={notInUse(view)} />
        </>
      ) : (
        "None"
      ),
    ],
    [
      `${name}'s own setting`,
      exec
        ? line.exec?.own
          ? `${EXEC_WORDS[line.exec.own]}. It replaces the default for ${name}.`
          : "None: the default applies"
        : line.value === "never" && line.mark === "gateway"
          ? "Never (its deny list)"
          : line.exceptions.some((e) => e.kind === "bot-deny")
            ? `Never on ${list(line.exceptions.flatMap((e) => (e.kind === "bot-deny" ? e.tools : [])))} (its deny list)`
            : line.ownAsk
              ? "Ask (the rules plugin)"
              : "Allow",
    ],
    ...(exec
      ? ([
          [
            "Machine policy",
            "Not read here. A machine's approvals file can add asks and refusals.",
          ],
        ] as Array<[string, ReactNode]>)
      : []),
    ["Effective", effectiveWords(line, view, name)],
    [
      "Tools",
      <span className="c-tools" key="tools">
        {line.tools.map((tool) => (
          <code key={tool}>{tool}</code>
        ))}
      </span>,
    ],
    [
      "Held by",
      line.mark
        ? markWords(line.mark, notInUse(view))
        : "Nothing in the settings and rules Clawtrate reads",
    ],
  ];
  return (
    <>
      <p className="c-choice-label" id="c-choice-label">
        {name} may:
      </p>
      <div
        className="c-choice"
        role="radiogroup"
        aria-labelledby="c-choice-label"
        data-four={exec ? "" : undefined}
        data-locked={
          line.mark === "set" && (line.value === "never" || line.value === "not-offered")
            ? ""
            : undefined
        }
        onKeyDown={onKey}
      >
        {other && (
          <button type="button" role="radio" aria-checked="true" aria-disabled="true" tabIndex={0}>
            {EXEC_WORDS[other]}
          </button>
        )}
        {choices.map((c) => {
          const on = c.shown === checked;
          const off = refusal(c.value) !== null;
          return (
            <button
              key={c.value}
              type="button"
              role="radio"
              data-value={c.value}
              aria-checked={on}
              aria-disabled={off || undefined}
              tabIndex={on || (!checked && c === choices[0]) ? 0 : -1}
              onClick={() => choose(c.value)}
            >
              {c.label}
            </button>
          );
        })}
      </div>
      <p className="c-sentence" role="status" data-testid="choice-sentence">
        {saving ? "Saving…" : sentence(line, view, name)}
      </p>
      {reasons.length > 0 && !saving && (
        <p className="b-hint" data-testid="choice-reason">
          {reasons.join(" ")}
        </p>
      )}
      {note && (
        <Note tone={note.tone} testId="save-note">
          <p>{note.text}</p>
        </Note>
      )}
      <dl className="facts" style={{ marginTop: 14 }}>
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="b-wrap-value">{value}</dd>
          </div>
        ))}
      </dl>
      <details className="b-disclosure">
        <summary>
          <ChevronIcon />
          Raw
        </summary>
        <div className="b-disclosure-body">
          <pre className="code-block">
            <code>{JSON.stringify(line, null, 2)}</code>
          </pre>
        </div>
      </details>
      {confirm && (
        <Confirm
          title={`Allow ${name} every command?`}
          text={`Allow all sets ${name}'s command setting to run commands without asking. A task's own settings, the machine's approvals file and Clawtrate's rules plugin can still ask or refuse.`}
          action="Allow all"
          onCancel={() => setConfirm(false)}
          onAction={() => {
            setConfirm(false);
            void save("full");
          }}
        />
      )}
    </>
  );
}
