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
  CheckIcon,
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
  const [read, setRead] = useState<Read>({ status: "loading", view: null, error: null });
  const generation = useRef(0);
  const connected = connection.status === "connected";
  const reload = useCallback(() => {
    const mine = (generation.current += 1);
    bridge
      .invoke({ type: "readPermissions", botId })
      .then((view) => {
        if (mine === generation.current) setRead({ status: "ready", view, error: null });
      })
      .catch((error: unknown) => {
        if (mine === generation.current)
          setRead((was) => ({ status: "error", view: was.view, error: errorText(error) }));
      });
  }, [bridge, botId]);
  const [forBot, setForBot] = useState(botId);
  if (forBot !== botId) {
    setForBot(botId);
    setRead({ status: "loading", view: null, error: null });
  }
  useEffect(() => {
    if (!shown || !connected) return;
    reload();
    const timer = setInterval(reload, PERMISSIONS_READ_MS);
    return () => clearInterval(timer);
  }, [shown, connected, connection.connectedAt, reload]);
  const replace = useCallback((view: BotPermissions) => {
    generation.current += 1;
    setRead({ status: "ready", view, error: null });
  }, []);
  return { read, reload, replace };
}

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

export function Mark({ mark }: { mark: LineMark }) {
  if (!mark) return null;
  return (
    <span
      className="c-mark"
      data-tone={mark === "not-now" || mark === "unread" ? "danger" : undefined}
    >
      {MARK_ICONS[mark]}
      {MARK_WORDS[mark]}
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
      return `Never: ${list(e.tools)} (${name}'s settings)`;
    case "not-offered":
      return e.by === "every"
        ? `Not offered: ${list(e.tools)} (set on the gateway)`
        : `Not in ${name}'s allow list: ${list(e.tools)}`;
    case "not-listed":
      return `Not in ${name}'s latest task's tools as the gateway listed them at ${clock(listedAt)}: ${list(e.tools)}`;
    case "unnamed":
      return `The gateway hasn't named this server's tools in ${name}'s latest task's listing`;
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

const countWords = (view: BotPermissions) => {
  const g = permissionGroups(view.lines);
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
  const { read, reload, replace } = usePermissions(bot.id, visible, connection);
  const [lineId, setLineId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const name = bot.name;
  const focusIn = (selector: string) =>
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(selector)?.focus());
  const open = (id: string) => {
    setLineId(id);
    focusIn("[data-bs-focus]");
  };
  const back = () => {
    const from = lineId;
    setLineId(null);
    focusIn(from ? `[data-c-line="${CSS.escape(from)}"]` : "[data-bs-focus]");
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
  // A read again that failed leaves the last view, said as such.
  const stale =
    read.status === "error" && view ? (
      <Note tone="warn" testId="stale-read">
        <p>
          Couldn't read {name}'s permissions again: {unstopped(read.error)}. This shows what
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

function Overview({
  view,
  name,
  onLine,
}: {
  view: BotPermissions;
  name: string;
  onLine: (id: string) => void;
}) {
  const groups = permissionGroups(view.lines);
  const byId = new Map(view.lines.map((line) => [line.id, line]));
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
  const gatewayLine = byId.get("gateway");
  const execLine = byId.get("exec");
  const everyRules = view.lines.reduce(
    (n, line) => n + line.exceptions.filter((e) => e.kind === "rule" && e.scope === "every").length,
    0,
  );
  return (
    <>
      <PluginLine view={view} name={name} />
      <NotEnforced view={view} name={name} />
      {view.settingsApplied === "no" && (
        <Note tone="warn" testId="not-applied">
          <p>
            The gateway reports it isn't using its stored settings yet. These lines show the stored
            settings, which may not be the ones in force.
          </p>
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
            aria-label={block.lines.length === 0 ? `${block.title}: nothing` : block.title}
          >
            <h4>
              {block.title} <span className="c-glance-n">{block.lines.length}</span>
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
                        aria-label={extra ? `${line.words} (${extra})` : line.words}
                        onClick={() => onLine(line.id)}
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
            <h4 className="b-group">{block.title}</h4>
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
      {view.linesOmitted > 0 && (
        <p className="b-hint">{view.linesOmitted} more tools aren't shown.</p>
      )}
      <h4 className="b-group">For these rules to hold</h4>
      <ul className="c-holds" data-testid="holds">
        {gatewayLine?.value === "never" ? (
          <li>
            <CheckIcon />
            {name} can't change the gateway or its plugins: Never.
          </li>
        ) : (
          <li data-tone="warn">
            <WarnIcon />
            {name} can change the gateway or its plugins, and so its rules.
          </li>
        )}
        {/* Said only of a Run commands line the gateway's catalog gives. */}
        {execLine &&
          (execLine.value === "never" ? (
            <li>
              <CheckIcon />
              {name} can't run commands.
            </li>
          ) : (
            <li data-tone="warn">
              <WarnIcon />
              {name} can run commands, and this page doesn't show where. On the gateway's machine,
              outside a sandbox, a command can change the gateway's settings and the rules plugin's
              store, so {name}'s plugin rules are advice there until Run commands is Never or runs
              elsewhere.
            </li>
          ))}
        <li>
          <FileIcon />A rule about a file tool covers that tool, not the file.
        </li>
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
  const value = VALUE_WORDS[line.value];
  const label = [line.words, value, ...subs, line.mark ? MARK_WORDS[line.mark] : ""]
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
            <Mark mark={line.mark} />
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

function sentence(line: PermissionLine, name: string): string {
  const verb = line.words.charAt(0).toLowerCase() + line.words.slice(1);
  if (line.kind === "question")
    return `${name} asks its questions in the conversation, which already waits for you.`;
  if (line.value === "not-offered")
    return `The gateway's settings for every bot don't offer this to ${name}. Set on the gateway; Clawtrate can't change it.`;
  if (line.value === "never" && line.mark === "set")
    return `The gateway's settings deny this for every bot. Set on the gateway; Clawtrate can't change it, and no choice here can loosen it.`;
  if (line.kind === "exec") {
    const policy = line.exec?.applies ?? "none";
    const words: Record<ExecPolicy | "none", string> = {
      full: `${name} runs any command without asking, as the user of the machine it runs on.`,
      auto: "Commands on the machine's allowlist run; the gateway's reviewer decides the rest and asks you when unsure.",
      ask: `${name} asks you before each command that isn't on the machine's allowlist; listed commands run.`,
      deny: `${name} can't run commands.`,
      allowlist: `Only listed commands: set outside Clawtrate. It can be left by choosing another value, not chosen again here.`,
      legacy: `A legacy setting (security and ask), set outside Clawtrate. It can be left by choosing another value, not chosen again here.`,
      none: `${name} has no command policy and none is set for every bot, so the gateway runs its commands without asking.`,
    };
    const whose = line.exec?.own
      ? `${name}'s own setting.`
      : "The default for every bot; a choice here sets one for " + name + ".";
    return `${words[policy]} ${whose} The gateway enforces this.`;
  }
  if (line.kind === "server" && line.tools.length === 0)
    return `The gateway hasn't named this server's tools in ${name}'s latest task's listing, so Clawtrate says nothing about them and can't allow, ask or deny them here. Once denied, a server's tools aren't listed: the deny is shown as its own line.`;
  if (line.kind === "entry")
    return line.value === "never" && line.mark === "gateway"
      ? `${name}'s deny list names ${line.words}. No tool the gateway lists for ${name} now has that name, so this page can't say what it removes. Allow takes it off the list.`
      : `${line.words} names no tool the gateway lists for ${name} now.`;
  const can =
    line.kind === "server"
      ? `use the tool server ${line.id.slice("server:".length)}`
      : line.kind === "plugin"
        ? `use the tools ${line.words.charAt(0).toLowerCase()}${line.words.slice(1)}`
        : line.kind === "tool"
          ? `use ${line.words}`
          : verb;
  if (line.choice === "never") {
    // What an attempt then looks like, said only for the kinds established on a development
    // gateway (OpenClaw 2026.10.6, e2e/permissions.spec.ts): a tool group's and a tool server's.
    const these = line.tools.length > 1 || line.kind === "server" ? "these tools" : "this tool";
    const attempt =
      line.kind === "group" || line.kind === "server"
        ? ` The gateway removes ${these} from ${name}. If ${name} tries ${line.tools.length > 1 || line.kind === "server" ? "one" : "it"}, the attempt fails as a tool that was not found.`
        : ` The gateway removes ${these} from ${name}.`;
    return `${name} can't ${can}.${attempt}`;
  }
  const ownDeny = line.exceptions.find((e) => e.kind === "bot-deny");
  if (line.choice === null && ownDeny?.kind === "bot-deny")
    return `${name}'s own settings deny only some of these tools: ${list(ownDeny.tools)}. The gateway still offers the rest unless something else removes them. Never denies them all; Allow takes ${name}'s deny off.`;
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
  return subs.length > 0
    ? `${VALUE_WORDS[line.value]}: ${subs.join("; ")}`
    : VALUE_WORDS[line.value];
}

function LinePage({
  bot,
  view,
  line,
  admin,
  announce,
  onRead,
}: {
  bot: Bot;
  view: BotPermissions;
  line: PermissionLine;
  admin: boolean;
  announce: (text: string) => void;
  onRead: (view: BotPermissions) => void;
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
      if (result.outcome === "saved") announce(`Saved. ${line.words}: ${SAVED_WORDS[choice]}`);
      else if (result.outcome === "conflict")
        setNote({
          text: `Someone else changed ${name}'s settings. ${result.view ? "This shows what the gateway has now." : "Reading what the gateway has now failed."}`,
          tone: "warn",
        });
      else if (result.outcome === "stored") {
        announce("Stored, not confirmed in use");
        setNote({
          text: `Saved in the gateway's settings, and not confirmed in use: ${unstopped(result.error ?? "the gateway didn't say")}. This shows the stored settings.`,
          tone: "warn",
        });
      } else if (result.outcome === "unconfirmed") {
        announce("Couldn't be confirmed");
        setNote({
          text: `Sent, but whether it was saved couldn't be confirmed: ${unstopped(result.error ?? "the gateway's answer was lost")}. ${result.view ? "This shows what the gateway has now." : "Reading what the gateway has now failed too."}`,
          tone: "warn",
        });
      } else if (result.outcome === "partial") {
        announce("Saved in part");
        setNote({
          text: `The rules plugin saved ${name}'s ${choice === "ask" ? "Ask" : "rule change"}, and ${name}'s deny list in the gateway's settings wasn't changed: ${unstopped(result.error ?? "the gateway refused it")}. ${result.view ? "This shows what the gateway has now." : "Reading what the gateway has now failed."}`,
          tone: "warn",
        });
      } else if (result.outcome === "not-shown")
        setNote({
          text: `Sent, but ${name}'s settings read back don't show it. This shows what the gateway has now.`,
          tone: "warn",
        });
      else {
        announce("Couldn't save");
        setNote({
          text: `Couldn't save: ${unstopped(result.error ?? "the gateway refused it")}. ${result.view ? "This shows what the gateway has now." : "Reading what the gateway has now failed too."}`,
          tone: "danger",
        });
      }
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
            Commands: {EXEC_WORDS[line.exec.every]} <Mark mark="set" />
          </>
        ) : (
          "None"
        )
      ) : line.mark === "set" && line.value !== "allowed" ? (
        <>
          {VALUE_WORDS[line.value]} <Mark mark="set" />
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
      line.mark ? MARK_WORDS[line.mark] : "Nothing in the settings and rules Clawtrate reads",
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
        {saving ? "Saving…" : sentence(line, name)}
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
      {exec && line.value !== "never" && (
        <p className="b-hint">
          Two checks: Clawtrate's rules plugin first, then the gateway's own ({name}'s policy and
          the machine's approvals file). An allow in one never passes the other.
        </p>
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
          text={`${name} runs any command without asking, as the user of the machine it runs on.`}
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
