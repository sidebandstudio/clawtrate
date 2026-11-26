// Pieces the account screens share (docs/design/bots.md, section 2): notes,
// results, the waiting line, commands and codes with their copy buttons, the
// model and effort selects, the access bar for admin, and the announcer.

import type { ConnectionState, HostInfo } from "@clawtrate/core";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useCommand } from "../bridge.tsx";
import { copyText } from "../clipboard.ts";
import { Menu, type MenuEntry } from "../Menu.tsx";
import {
  CheckIcon,
  ChevronIcon,
  ClockIcon,
  CloseIcon,
  CopyIcon,
  EyeIcon,
  WarnIcon,
} from "../icons.tsx";
import { CopyValue } from "../AccessBar.tsx";

/** A sentence on a soft fill: neutral, something to act on, or a failure. */
export function Note({
  tone,
  icon,
  children,
  testId,
}: {
  tone?: "warn" | "danger" | undefined;
  icon?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="b-note" data-tone={tone} data-testid={testId}>
      {icon ?? (tone ? <WarnIcon /> : <ClockIcon />)}
      <div>{children}</div>
    </div>
  );
}

/** How a stage ended: the empty mark with a state in it, a title and a sentence. */
export function Result({
  tone,
  mark,
  title,
  children,
  focus = true,
}: {
  tone: "ok" | "warn" | "danger" | "";
  mark: "check" | "clock" | "warning" | "x";
  title: string;
  children?: ReactNode;
  /** The title takes focus when the stage shows; not where a field after it should. */
  focus?: boolean;
}) {
  const icon =
    mark === "check" ? (
      <CheckIcon />
    ) : mark === "clock" ? (
      <ClockIcon />
    ) : mark === "x" ? (
      <CloseIcon />
    ) : (
      <WarnIcon />
    );
  return (
    <div className="b-result">
      <span className="empty-mark" data-tone={tone || undefined}>
        {icon}
      </span>
      <h3 tabIndex={-1} data-b-focus={focus ? "" : undefined}>
        {title}
      </h3>
      {children && <p>{children}</p>}
    </div>
  );
}

/** The pairing screen's waiting line, flush left: a live region with the pulsing dot. */
export function Wait({ children }: { children: ReactNode }) {
  return (
    <p className="b-wait" role="status">
      <span className="status-dot" data-status="connecting" />
      {children}
    </p>
  );
}

/** A command to run on the gateway's machine. It breaks between words, never inside one. */
export function CommandBlock({
  command,
  label,
  onCopied,
}: {
  command: string;
  label: string;
  onCopied?: () => void;
}) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const codeRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1400);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    const result = await copyText(command);
    if (result === "manual" && codeRef.current) {
      const range = document.createRange();
      range.selectNodeContents(codeRef.current);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    setState(result);
    onCopied?.();
  };
  return (
    <>
      <div className="command command-line" data-testid="command">
        <code ref={codeRef}>
          {command.split(" ").map((token, index) => (
            <span key={index}>
              {index > 0 ? " " : ""}
              <span className="b-tok">{token}</span>
            </span>
          ))}
        </code>
        <button
          type="button"
          className="icon-button copy"
          data-variant="quiet"
          aria-label={label}
          title={state === "copied" ? "Copied" : label}
          data-copied={state === "copied" || undefined}
          onClick={() => void copy()}
        >
          {state === "copied" ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
      <p className="visually-hidden" role="status">
        {state === "copied"
          ? "Copied command"
          : state === "manual"
            ? "The command is selected. Copy it with your keyboard."
            : ""}
      </p>
    </>
  );
}

/** A code to type on the provider's page: large, mono, read in parts. */
export function CodeBlock({ code }: { code: string }) {
  return (
    <div className="b-code" role="group" aria-label={`Code ${code.replace(/-/g, " ")}`}>
      <code>{code}</code>
      <CopyValue value={code} label="Copy code" />
    </div>
  );
}

type Choice = { value: string; label: string; disabled?: boolean; note?: string };

/** A row of a select's menu that does something other than choose. */
export type SelectRow = {
  label: string;
  note?: string;
  disabled?: boolean;
  /** Whether the menu closes before it runs. */
  close?: boolean;
  /** It shows a second section in place: focus moves to that section's first choice. */
  expands?: boolean;
  /** One line of text under the row, such as what its action found. */
  line?: string;
  /** More text, one step away: a small item on the line, named `label`, shows it under it. */
  more?: { label: string; lines: string[] };
  onSelect: () => void;
};

/** A second section of a select's menu, under a rule: one line, then its choices and rows. */
export type SelectSection = { line: string; choices: Choice[]; rows: SelectRow[] };

/** The tallest a select's menu grows before it scrolls. */
const MENU_MAX_HEIGHT = 360;
/** The height of one row of a select's menu, with its padding. */
const MENU_ROW = 36;

/** A select: a label over its value and a chevron, opening a `.menu` of choices under it. */
export function Select({
  label,
  value,
  choices,
  rows = [],
  section,
  onChoose,
  disabled,
  testId,
}: {
  label: string;
  value: string;
  choices: Choice[];
  /** Rows after the choices. */
  rows?: SelectRow[];
  /** A second section after them. */
  section?: SelectSection;
  onChoose: (value: string) => void;
  disabled?: boolean;
  testId?: string;
}) {
  // Where the menu opens: the select's own box, taken when it opens.
  const [anchor, setAnchor] = useState<{ rect: DOMRect; element: HTMLButtonElement } | null>(null);
  // Nothing to choose, or not allowed: an open menu closes, and none opens (#406). The rows after
  // the choices ("View more", a typed id) and the second section count as something to choose.
  const unavailable =
    Boolean(disabled) ||
    choices.length + rows.length + (section?.choices.length ?? 0) + (section?.rows.length ?? 0) ===
      0;
  if (unavailable && anchor !== null) setAnchor(null);
  const open = !unavailable && anchor !== null;
  // A row that shows the second section was chosen in this opening of the menu.
  const [expanding, setExpanding] = useState(false);
  // The row whose more text shows, for the line it is under: a new line closes it.
  const [moreFor, setMoreFor] = useState<string | null>(null);
  const moreKey = (each: SelectRow) => `${each.label}\n${each.line ?? ""}`;
  const panelId = useId();
  const close = useCallback(
    (refocus: boolean) => {
      const element = anchor?.element;
      setAnchor(null);
      if (refocus) element?.focus();
    },
    [anchor],
  );
  const openFrom = (element: HTMLButtonElement) => {
    if (unavailable) return;
    setExpanding(false);
    setMoreFor(null);
    setAnchor({ rect: element.getBoundingClientRect(), element });
  };
  const radio = (choice: Choice): MenuEntry => ({
    kind: "radio",
    label: choice.label,
    checked: choice.value === value,
    ...(choice.note ? { note: choice.note } : {}),
    onSelect: () => {
      if (unavailable || choice.disabled) return;
      close(true);
      onChoose(choice.value);
    },
  });
  const row = (each: SelectRow): MenuEntry => ({
    kind: "item",
    label: each.label,
    ...(each.note ? { note: each.note } : {}),
    ...(each.disabled ? { disabled: true } : {}),
    onSelect: () => {
      if (unavailable) return;
      if (each.close) close(false);
      if (each.expands) setExpanding(true);
      each.onSelect();
    },
  });
  const entries: MenuEntry[] = [
    ...choices.map(radio),
    ...rows.flatMap((each, n): MenuEntry[] => {
      if (each.line === undefined) return [row(each)];
      const id = `${panelId}-${n}`;
      const open = each.more !== undefined && moreFor === moreKey(each);
      return [
        row(each),
        {
          kind: "line",
          text: each.line,
          ...(each.more
            ? {
                more: {
                  label: each.more.label,
                  open,
                  panel: id,
                  onToggle: () => setMoreFor(open ? null : moreKey(each)),
                },
              }
            : {}),
        },
        ...(open && each.more ? [{ kind: "panel" as const, id, lines: each.more.lines }] : []),
      ];
    }),
  ];
  // Escape closes the more text that shows before the menu.
  const onEscape = () => {
    if (!rows.some((each) => each.more && moreFor === moreKey(each))) return false;
    setMoreFor(null);
    return true;
  };
  // After a row that shows the second section, focus moves to its first choice.
  const focusAt =
    expanding && section && section.choices.length > 0
      ? entries.filter(
          (entry) =>
            entry.kind === "item" ||
            entry.kind === "radio" ||
            (entry.kind === "line" && entry.more !== undefined),
        ).length
      : undefined;
  if (section)
    entries.push(
      { kind: "rule" },
      { kind: "label", text: section.line },
      ...section.choices.map(radio),
      ...section.rows.map(row),
    );
  const shown =
    [...choices, ...(section?.choices ?? [])].find((choice) => choice.value === value)?.label ??
    value;
  const rect = anchor?.rect ?? null;
  // The menu stays inside the dialog it opens in (or the window): under the select when it fits,
  // else above it where there is more room, and it scrolls past that height.
  const box = anchor?.element.closest("dialog")?.getBoundingClientRect() ?? null;
  const floor = Math.min(innerHeight, box?.bottom ?? innerHeight) - 8;
  const ceiling = Math.max(0, box?.top ?? 0) + 8;
  const wanted = Math.min(MENU_MAX_HEIGHT, 10 + MENU_ROW * entries.length);
  const below = rect ? floor - (rect.bottom + 6) : wanted;
  const above = rect ? rect.top - 6 - ceiling : 0;
  const under = below >= wanted || below >= above;
  const height = Math.max(MENU_ROW, Math.min(wanted, under ? below : above));
  const top = rect ? (under ? rect.bottom + 6 : rect.top - 6 - height) : 0;
  return (
    <>
      <button
        type="button"
        className="b-select"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${shown}`}
        disabled={unavailable}
        data-testid={testId}
        onClick={(event) => (open ? setAnchor(null) : openFrom(event.currentTarget))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            openFrom(event.currentTarget);
          }
        }}
      >
        <small>{label}</small>
        <span>{shown}</span>
        <ChevronIcon />
      </button>
      {open && rect && anchor && (
        <Menu
          label={label}
          entries={entries}
          onClose={close}
          trigger={anchor.element}
          onEscape={onEscape}
          className="b-menu"
          {...(focusAt !== undefined ? { focusAt } : {})}
          style={{
            position: "fixed",
            left: Math.max(8, Math.min(rect.left, innerWidth - 228)),
            top,
            minWidth: Math.max(200, rect.width),
            maxHeight: height,
            overflowY: "auto",
          }}
        />
      )}
    </>
  );
}

/** One polite live region and a way to speak into it. */
export function useAnnouncer(): [ReactNode, (text: string) => void] {
  const [text, setText] = useState("");
  const announce = useCallback((next: string) => {
    setText("");
    requestAnimationFrame(() => setText(next));
  }, []);
  const node = (
    <p className="visually-hidden" role="status" aria-live="polite" data-testid="b-announcer">
      {text}
    </p>
  );
  return [node, announce];
}

/** Whether the request under way asks for admin. */
export function askingAdmin(connection: ConnectionState): boolean {
  return connection.upgrade.scopes.includes("operator.admin");
}

/**
 * The access bar of conversation.md section 3, asking for admin, with this
 * screen's words (bots.md section 2). The command and the request id are the
 * host's. The engine waits on the gateway's answer continuously, as the
 * conversation's bar says, so there is no "Check now" and no countdown.
 */
export function AdminBar({
  connection,
  info,
  need,
}: {
  connection: ConnectionState;
  info: HostInfo;
  need: string;
}) {
  const send = useCommand();
  const ask = () => void send({ type: "requestAccess", tier: "admin" }).catch(() => {});
  const upgrade = connection.upgrade;
  const mine = askingAdmin(connection);
  const status = mine ? upgrade.status : "idle";
  const readOnly = info.readOnly || !connection.canWrite;
  let body: ReactNode;
  let action: ReactNode = null;
  let tone: "danger" | undefined;
  if (connection.status === "connected" && connection.fullPairing && !info.readOnly) {
    // A full pairing the gateway granted less: its limit stands, and nothing asks again (§2).
    // Said only while connected: a drop clears the scopes until the next hello.
    body = (
      <>
        <b>OpenClaw granted less than full control.</b> {need}
      </>
    );
  } else if (info.readOnly) {
    body = (
      <>
        <b>Read-only.</b> {need} This connection only reads.
      </>
    );
  } else if (status === "requesting") body = "Asking the gateway…";
  else if (status === "approved")
    body = (
      <>
        <b>Approved.</b> Connecting again with the new access…
      </>
    );
  else if (status === "pending")
    body = (
      <>
        <b>Waiting for the gateway's owner.</b>
        {upgrade.approveCommand
          ? " Approve this request on the gateway's machine:"
          : " The owner approves this request on the gateway's machine."}
      </>
    );
  else if (status === "rejected") {
    body = (
      <>
        <b>The request was denied.</b> Nothing changed. This device keeps the access it had.
      </>
    );
    action = (
      <button type="button" className="button" data-size="sm" onClick={ask}>
        Request again
      </button>
    );
  } else if (status === "expired") {
    body = (
      <>
        <b>The request expired</b> before it was approved.
      </>
    );
    action = (
      <button type="button" className="button" data-size="sm" onClick={ask}>
        Request again
      </button>
    );
  } else if (status === "error") {
    tone = "danger";
    body = (
      <>
        <b>Couldn't send the request.</b> {upgrade.error}
      </>
    );
    action = (
      <button type="button" className="button" data-size="sm" onClick={ask}>
        Try again
      </button>
    );
  } else {
    body = (
      <>
        <b>{readOnly ? "Read-only." : "Admin access needed."}</b> {need}
      </>
    );
    action = (
      <button type="button" className="button" data-variant="primary" data-size="sm" onClick={ask}>
        Request admin access
      </button>
    );
  }
  if (connection.status !== "connected" || info.readOnly || connection.fullPairing) action = null;
  const pending = status === "pending";
  return (
    <section
      className="access-bar"
      role="region"
      aria-label="Access"
      data-tone={tone}
      data-status={info.readOnly ? "pinned" : status}
      data-testid="admin-bar"
    >
      <div className="access-row">
        <EyeIcon />
        <span className="shelf-text" aria-live="polite">
          {body}
        </span>
        {action}
      </div>
      {pending && upgrade.approveCommand && (
        <CommandBlock command={upgrade.approveCommand} label="Copy approve command" />
      )}
      {pending && (
        <p className="access-wait">
          This changes by itself as soon as the owner approves or denies the request, or it expires.
        </p>
      )}
      {pending && upgrade.requestId && (
        <div className="access-id">
          <span className="mono">Request {upgrade.requestId.slice(0, 8)}</span>
          <CopyValue value={upgrade.requestId} label="Copy request id" />
          {upgrade.approveNote && <span>{upgrade.approveNote}</span>}
        </div>
      )}
    </section>
  );
}

/**
 * "Admin access granted. You can change this now." for 4 seconds after the
 * grant, then the screen's own action takes the bar's place. Only while the
 * connection the grant came on still holds admin: a drop, a revoke or another
 * gateway ends it at once.
 */
export function useGranted(connection: ConnectionState): boolean {
  // The gateway address and device the grant came on, or null.
  const [granted, setGranted] = useState<string | null>(null);
  const [had, setHad] = useState(connection.canAdmin);
  const on = `${connection.gatewayUrl ?? ""}\n${connection.deviceId ?? ""}`;
  const live = connection.status === "connected" && connection.canAdmin;
  if (connection.canAdmin !== had) {
    setHad(connection.canAdmin);
    if (connection.canAdmin && askingAdmin(connection) && connection.upgrade.status === "approved")
      setGranted(on);
  }
  if (granted !== null && (!live || granted !== on)) setGranted(null);
  useEffect(() => {
    if (granted === null) return;
    const timer = setTimeout(() => setGranted(null), 4000);
    return () => clearTimeout(timer);
  }, [granted]);
  return granted !== null && live && granted === on;
}

export function GrantedBar() {
  return (
    <section
      className="access-bar"
      role="region"
      aria-label="Access"
      data-status="granted"
      data-testid="admin-bar"
    >
      <div className="access-row">
        <CheckIcon />
        <span className="shelf-text" role="status">
          <b>Admin access granted.</b> You can change this now.
        </span>
      </div>
    </section>
  );
}
