// Where a bot runs (controls.md section 14): the Runs on row of a bot's
// Settings tab and its page. Three places kept apart, each a setting of its
// own and marked as configured: where its commands run, the folder of its
// file tools, its browser. Then what its settings name, as inventory.
// Nothing is kept: the page reads the gateway when it opens and after a save.

import type { BotPlacement, ConnectionState, HostInfo } from "@clawtrate/core";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useBridge } from "../bridge.tsx";
import { CopyValue } from "../AccessBar.tsx";
import { clockTime } from "../format.ts";
import { BackIcon, ChevronIcon, EyeIcon, LockIcon, ShieldIcon, WarnIcon } from "../icons.tsx";
import { AdminBar, GrantedBar, Note, Select, useGranted } from "../bots/parts.tsx";
import { lastSeen, names, nodeState, runsOnValue } from "./words.ts";
import "./machines.css";

type Read =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; placement: BotPlacement };

/** A bot's placement, read when shown and again on `reload()`, the connection or its access changing. */
export function usePlacement(botId: string, connection: ConnectionState, active: boolean) {
  const bridge = useBridge();
  const [read, setRead] = useState<Read>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const connected = connection.status === "connected";
  useEffect(() => {
    if (!active || !connected) return;
    let live = true;
    bridge.invoke({ type: "readPlacement", botId }).then(
      (placement) => live && setRead({ status: "ready", placement }),
      (error: unknown) =>
        live &&
        setRead({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
    );
    return () => {
      live = false;
    };
  }, [bridge, botId, active, connected, connection.connectedAt, connection.scopes, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { read, reload };
}

/** A mark of section 2: an icon and its words, never colour alone. */
export function Mark({ kind }: { kind: "gateway" | "set" | "shown" }) {
  const [icon, words] =
    kind === "gateway"
      ? [<ShieldIcon key="i" />, "The gateway enforces this"]
      : kind === "set"
        ? [<LockIcon key="i" />, "Set on the gateway"]
        : [<EyeIcon key="i" />, "Shown only"];
  return (
    <span className="m-mark">
      {icon}
      {words}
    </span>
  );
}

/** The Runs on group's one row. */
export function RunsOnRow({
  botName,
  read,
  nameOf,
  onOpen,
}: {
  botName: string;
  read: Read;
  nameOf: (id: string) => string;
  onOpen: () => void;
}) {
  const value =
    read.status === "ready"
      ? runsOnValue(read.placement, nameOf)
      : read.status === "error"
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

/** The page "Where <bot> runs". */
export function RunsOnPage({
  botId,
  botName,
  read,
  reload,
  nameOf,
  connection,
  info,
  announce,
  onBack,
}: {
  botId: string;
  botName: string;
  read: Read;
  reload: () => void;
  nameOf: (id: string) => string;
  connection: ConnectionState;
  info: HostInfo;
  announce: (text: string) => void;
  onBack: () => void;
}) {
  const bridge = useBridge();
  const granted = useGranted(connection);
  const admin = connection.canAdmin && !info.readOnly;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const foot = granted ? (
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

  if (read.status !== "ready") {
    return (
      <div className="b-tab m-page" data-testid="runs-on-page">
        {head}
        {read.status === "loading" ? (
          <div
            aria-busy="true"
            aria-label={`Loading where ${botName} runs`}
            data-testid="runs-on-loading"
          >
            <div className="skeleton" style={{ height: 52, width: "100%" }} />
            <div className="skeleton" style={{ height: 96, width: "100%", marginTop: 12 }} />
            <div className="skeleton" style={{ height: 120, width: "100%", marginTop: 12 }} />
          </div>
        ) : (
          <div className="work-empty" data-testid="runs-on-error">
            <span className="empty-mark">
              <WarnIcon />
            </span>
            <h4>Couldn't load where {botName} runs</h4>
            <p>{read.message || "The gateway did not answer."}</p>
            <div style={{ marginTop: 10 }}>
              <button type="button" className="button" data-size="sm" onClick={reload}>
                Try again
              </button>
            </div>
          </div>
        )}
        {foot}
      </div>
    );
  }

  const { placement } = read;
  const { commands, browser, inventory, sharedWith } = placement;
  const node = commands.node;
  const onNode = commands.host === "node";
  const machineName = node?.name ?? commands.nodeSelector ?? "a paired machine";

  const save = async (value: string) => {
    setSaving(true);
    setError(null);
    try {
      const place = await bridge.invoke({
        type: "setCommandMachine",
        botId,
        host: value === "gateway" ? "gateway" : "node",
        nodeId: value === "gateway" ? null : value,
      });
      announce(`Saved. ${botName}'s commands: ${place.node?.name ?? "the gateway's machine"}`);
      reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      announce("Couldn't save");
    } finally {
      setSaving(false);
    }
  };

  const current = onNode ? (node?.id ?? `?${commands.nodeSelector ?? ""}`) : "gateway";
  const choices = [
    { value: "gateway", label: "The gateway's machine" },
    ...placement.nodes.map((each) => ({
      value: each.id,
      label: `${each.name} · ${each.connected ? "Connected" : "Not connected"}`,
    })),
    ...(onNode && !node
      ? [{ value: current, label: `${machineName} · Not listed`, disabled: true }]
      : []),
  ];

  const shareNotes: string[] = [];
  if (sharedWith.workspace.length > 0)
    shareNotes.push(
      `${botName} shares its workspace folder with ${names(sharedWith.workspace.map(nameOf))}. Files one bot writes, the other can change.`,
    );
  if (sharedWith.machine.length > 0)
    shareNotes.push(
      `${botName}'s commands are set to run on ${machineName}, as ${names(sharedWith.machine.map(nameOf))}'s are.`,
    );
  if (sharedWith.browser.length > 0)
    shareNotes.push(
      `${botName} shares the gateway's browser with ${names(sharedWith.browser.map(nameOf))}.`,
    );

  const hostLine =
    commands.host === "auto"
      ? commands.sandbox
        ? "Not set: with a sandbox configured, the gateway runs commands in it."
        : "Not set: the gateway runs commands on its own machine when no sandbox runs."
      : commands.host === "sandbox"
        ? "Configured to run in a sandbox."
        : null;

  return (
    <div className="b-tab m-page" data-testid="runs-on-page">
      {head}
      {shareNotes.length > 0 && (
        <Note tone="warn" testId="runs-on-shared">
          {shareNotes.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </Note>
      )}

      <h4 className="b-group">Commands</h4>
      <p className="b-hint m-label" id="m-machine-label">
        Configured to run {botName}'s commands on:
      </p>
      <Select
        label={`Where ${botName}'s commands run`}
        value={current}
        choices={choices}
        disabled={!admin || saving}
        onChoose={(value) => {
          if (value !== current) void save(value);
        }}
        testId="runs-on-machine"
      />
      {error && (
        <p className="b-field-error" role="alert" data-testid="runs-on-error-line">
          {error}
        </p>
      )}
      <p className="m-sentence">
        A configured setting for {botName}
        {commands.inherited && commands.host !== "auto"
          ? ", inherited from the gateway's settings for every bot"
          : ""}
        . A task can be sent to another machine; where a command ran is in its own result.{" "}
        <Mark kind="gateway" />
      </p>
      {hostLine && <p className="b-hint">{hostLine}</p>}
      {onNode && node && !node.connected && (
        <p className="b-hint" data-testid="runs-on-offline">
          {node.name} isn't connected: {lastSeen(node, now)}.
        </p>
      )}
      {onNode && node && !node.runsCommands && (
        <p className="b-hint" data-testid="runs-on-no-run">
          {node.name} doesn't offer to run commands: it doesn't declare system.run, so the gateway
          refuses {botName}'s commands there.
        </p>
      )}
      {onNode && !node && (
        <p className="b-hint">
          The gateway lists no machine named {commands.nodeSelector}: it refuses {botName}'s
          commands until one connects.
        </p>
      )}

      <h4 className="b-group">Workspace</h4>
      <dl className="facts m-facts">
        <Fact label="Configured folder" testId="runs-on-workspace">
          {placement.workspace ? (
            <>
              <span className="mono m-path">{placement.workspace}</span>, on the gateway's machine{" "}
              <CopyValue value={placement.workspace} label="Copy folder" />
            </>
          ) : (
            "Not reported"
          )}
        </Fact>
      </dl>
      <p className="b-hint">
        Configured as the folder for {botName}'s file tools.
        {onNode
          ? ` On ${machineName}, commands run in ${machineName}'s own folder unless a task names one.`
          : ""}
      </p>
      {onNode && (
        <p className="b-hint" data-testid="runs-on-node-folder">
          A folder on {machineName}: Not supported on this machine. The gateway sets a workspace on
          its own machine only.
        </p>
      )}
      {admin && editing === null && (
        <div className="b-actions">
          <button
            type="button"
            className="button"
            data-size="sm"
            data-bs="workspace-change"
            onClick={() => setEditing(placement.workspace ?? "")}
          >
            Change…
          </button>
          <span className="b-hint">
            Takes a path on the gateway's machine; the gateway creates it if it doesn't exist.
          </span>
        </div>
      )}
      {admin && editing !== null && (
        <WorkspaceForm
          botId={botId}
          botName={botName}
          initial={editing}
          onDone={(saved) => {
            setEditing(null);
            if (saved) {
              announce(`Saved. ${botName}'s workspace: ${saved}`);
              reload();
            }
          }}
        />
      )}

      <h4 className="b-group">Browser</h4>
      <dl className="facts m-facts">
        <Fact label="Browser" testId="runs-on-browser">
          {browser.kind === "own"
            ? `${botName}'s own browser, on the gateway's machine (Clawtrate's computer plugin, profile ${browser.profile})${browser.pluginEnabled ? "" : "; the plugin is turned off"}`
            : browser.kind === "shared"
              ? "The gateway's shared browser, on the gateway's machine. Every bot that uses the browser shares it."
              : browser.by === "bot"
                ? `None: ${botName}'s settings deny the browser.`
                : "None: the gateway's settings deny the browser to every bot."}
        </Fact>
      </dl>
      <p className="b-hint">
        {onNode
          ? `Commands running on ${machineName} don't change where the browser is.`
          : "Where commands run doesn't change where the browser is."}{" "}
        {browser.kind === "own" ? <Mark kind="shown" /> : <Mark kind="gateway" />}
      </p>
      <p className="b-hint" data-testid="runs-on-browser-choice">
        {onNode
          ? `A browser profile on ${machineName}: Not supported on this machine.`
          : "Choosing or creating a browser profile isn't offered here: a profile of a bot's own is set in the gateway's settings with Clawtrate's computer plugin."}
      </p>

      <h4 className="b-group">What {botName}'s settings name</h4>
      <p className="b-hint" style={{ marginTop: 0 }}>
        Inventory. Whether {botName} can use each isn't reported.
      </p>
      <dl className="facts m-facts" data-testid="runs-on-inventory">
        <Fact label="Accounts" testId="inventory-accounts">
          {"status" in inventory.accounts
            ? unavailableWords(inventory.accounts.status)
            : inventory.accounts.length === 0
              ? "None listed"
              : inventory.accounts
                  .map(
                    (account) => `${account.label ?? account.id}${account.bound ? " (bound)" : ""}`,
                  )
                  .join(", ")}
        </Fact>
        <Fact label="Tool servers" testId="inventory-servers">
          {inventory.toolServers.length === 0
            ? "None configured"
            : inventory.toolServers
                .map(
                  (server) =>
                    `${server.name} (${
                      server.denied === "bot"
                        ? `denied for ${botName}`
                        : server.denied === "every-bot"
                          ? "denied for every bot"
                          : server.offered === true
                            ? "offered in the latest task"
                            : server.offered === false
                              ? "not offered in the latest task"
                              : "configured"
                    })`,
                )
                .join("; ")}
        </Fact>
        <Fact label="Secrets" testId="inventory-secrets">
          {Array.isArray(inventory.secrets) ? (
            inventory.secrets.length === 0 ? (
              "None in the gateway's secret store"
            ) : (
              `Names in the gateway's secret store, shared by every bot: ${inventory.secrets.join(", ")}`
            )
          ) : (
            <span className="b-faint">{unavailableWords(inventory.secrets.status)}</span>
          )}
        </Fact>
        <Fact label="Plugin sign-ins" testId="inventory-signins">
          {Array.isArray(inventory.pluginSignIns) ? (
            inventory.pluginSignIns.length === 0 ? (
              "None"
            ) : (
              inventory.pluginSignIns
                .map((each) => `${each.plugin}: ${each.names.join(", ")}`)
                .join("; ")
            )
          ) : (
            <span className="b-faint">{unavailableWords(inventory.pluginSignIns.status)}</span>
          )}
        </Fact>
        <Fact label="Folders">
          Its workspace.{" "}
          {inventory.workspaceOnly === true
            ? "File tools stay inside it (the gateway's file-tool confinement is on)"
            : inventory.workspaceOnly === false
              ? "File tools may reach outside it (the gateway's file-tool confinement is off)"
              : "File tools stay inside a task's folder in the guarded modes"}
          ; commands reach whatever the machine's user can.
        </Fact>
      </dl>
      <p className="b-hint" data-testid="runs-on-read-at">
        From {botName}'s settings and the gateway's, read at {clockTime(placement.readAt)}.
        {inventory.listing
          ? ` Tool servers offered: the listing of ${botName}'s latest task, read at ${clockTime(inventory.listing.readAt)}.`
          : ""}
        {placement.nodesOmitted > 0
          ? ` ${placement.nodesOmitted} more machines aren't listed.`
          : ""}
      </p>
      {onNode && node && (
        <p className="b-hint">
          {node.name}: {nodeState(node, now)}.
        </p>
      )}
      {foot}
    </div>
  );
}

function WorkspaceForm({
  botId,
  botName,
  initial,
  onDone,
}: {
  botId: string;
  botName: string;
  initial: string;
  onDone: (saved: string | null) => void;
}) {
  const bridge = useBridge();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const problem = !value.startsWith("/")
    ? "Enter a full path on the gateway's machine, starting with /."
    : value.split("/").includes("..")
      ? "Enter a path without '..'."
      : null;
  const submit = async () => {
    if (problem) {
      setError(problem);
      field.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { workspace } = await bridge.invoke({ type: "setBotWorkspace", botId, path: value });
      onDone(workspace);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      field.current?.focus();
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
          onDone(null);
        }
      }}
    >
      <label className="b-hint m-label" htmlFor="m-workspace">
        {botName}'s folder on the gateway's machine. A full path, starting with /.
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
          onClick={() => onDone(null)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
