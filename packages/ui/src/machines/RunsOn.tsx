// Where a bot runs (controls.md section 14): the Runs on row of a bot's
// Settings tab and its page. Three settings kept apart, each shown as the
// gateway's settings store it or as the gateway reports it: the machine named
// for its commands, its workspace, what its settings say about the browser.
// Then what its settings name, as inventory. Nothing is inferred from them.
// Nothing is kept: the page reads the gateway when it opens and after a save.

import type { BotPlacement, ConnectionState, HostInfo } from "@clawtrate/core";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useBridge } from "../bridge.tsx";
import { CopyValue } from "../AccessBar.tsx";
import { clockTime } from "../format.ts";
import { BackIcon, ChevronIcon, EyeIcon, LockIcon, WarnIcon } from "../icons.tsx";
import { AdminBar, GrantedBar, Note, Select, useGranted } from "../bots/parts.tsx";
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

type Read =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; placement: BotPlacement };

/**
 * A bot's placement, read when shown and again on `reload()`. A read belongs to
 * the bot and the connection's access it was made for: while another bot's, an
 * earlier connection's or other scopes' read is all there is, nothing is drawn.
 */
export function usePlacement(botId: string, connection: ConnectionState, active: boolean) {
  const bridge = useBridge();
  const [held, setHeld] = useState<{ key: string; read: Read } | null>(null);
  const [tick, setTick] = useState(0);
  const connected = connection.status === "connected";
  // Read again when the granted scopes change, not when a snapshot brings an equal list.
  const scopesKey = connection.scopes.join(" ");
  const key = `${botId}\n${connection.connectedAt ?? ""}\n${scopesKey}`;
  useEffect(() => {
    if (!active || !connected) return;
    let live = true;
    bridge.invoke({ type: "readPlacement", botId }).then(
      (placement) => live && setHeld({ key, read: { status: "ready", placement } }),
      (error: unknown) =>
        live &&
        setHeld({
          key,
          read: {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        }),
    );
    return () => {
      live = false;
    };
  }, [bridge, botId, active, connected, key, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const read: Read = !connected
    ? { status: "error", message: "Not connected to the gateway." }
    : held && held.key === key
      ? held.read
      : { status: "loading" };
  return { read, reload };
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
  const { commands, browser, inventory, sameSetting } = placement;
  const node = commands.node;
  const onNode = commands.host === "node";
  const machineName = hostWords(commands);

  const save = async (value: string) => {
    setSaving(true);
    setError(null);
    try {
      const saved = await bridge.invoke({
        type: "setCommandMachine",
        botId,
        host: value === "gateway" ? "gateway" : "node",
        nodeId: value === "gateway" ? null : value,
        baseHash: placement.configHash,
      });
      const where = `${botName}'s command machine setting: ${hostWords(saved.place)}`;
      if (saved.active === "applied") announce(`Saved and applied. ${where}`);
      else if (saved.active === "pending")
        announce(`Saved. The gateway doesn't report it applied yet. ${where}`);
      else {
        setError(`Saved, but not applied. The gateway answered: ${saved.message ?? ""}`);
        announce("Saved, not applied");
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      announce("Couldn't save");
    } finally {
      setSaving(false);
      // Whatever the outcome, the page shows the gateway as it is now.
      reload();
    }
  };

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
    ...placement.nodes.map((each) => ({
      value: each.id,
      label: `${each.name} · ${each.connected ? "Connected" : "Not connected"}`,
    })),
    ...(current === "stored" ? [{ value: "stored", label: storedLabel, disabled: true }] : []),
  ];

  const sameNotes: string[] = [];
  if (sameSetting.machine.length > 0)
    sameNotes.push(
      `${botName} and ${names(sameSetting.machine.map(nameOf))} have the same command machine setting: ${machineName}.`,
    );
  if (sameSetting.workspace.length > 0)
    sameNotes.push(
      `${botName} and ${names(sameSetting.workspace.map(nameOf))} have the same workspace setting.`,
    );

  const origin =
    commands.host === null
      ? `Not set in the gateway's settings for ${botName} or for every bot.`
      : commands.inherited
        ? "From the gateway's setting for every bot."
        : `Set in ${botName}'s own settings.`;

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
      <p className="b-hint m-label" id="m-machine-label">
        The machine {botName}'s settings name for its commands:
      </p>
      <Select
        label={`${botName}'s command machine`}
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
      {placement.configActive === false && (
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

      <h4 className="b-group">Workspace</h4>
      <dl className="facts m-facts">
        <Fact label="Folder" testId="runs-on-workspace">
          {placement.workspace ? (
            <>
              <span className="mono m-path">{placement.workspace}</span>{" "}
              <CopyValue value={placement.workspace} label="Copy folder" />
            </>
          ) : (
            "Not reported"
          )}
        </Fact>
      </dl>
      <p className="b-hint">{botName}'s workspace, as the gateway reports it.</p>
      {onNode && (
        <p className="b-hint" data-testid="runs-on-node-folder">
          A folder on {machineName}: Not supported on this machine. Change… sets {botName}'s
          workspace in the gateway's settings.
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
          <span className="b-hint">The gateway checks the path you enter.</span>
        </div>
      )}
      {admin && editing !== null && (
        <WorkspaceForm
          botId={botId}
          botName={botName}
          initial={editing}
          current={placement.workspace}
          onDone={(saved) => {
            setEditing(null);
            if (saved) {
              announce(
                saved.asTyped
                  ? `Saved. ${botName}'s workspace: ${saved.workspace}`
                  : `The gateway answered that it saved it. It reports ${botName}'s workspace as ${saved.workspace ?? "none"}.`,
              );
              reload();
            }
          }}
          onFailed={reload}
        />
      )}

      <h4 className="b-group">Browser</h4>
      <dl className="facts m-facts">
        <Fact label={`${botName}'s tool lists`} testId="runs-on-browser">
          Allow: {listWords(browser.own.allow)} · Deny: {listWords(browser.own.deny)}
        </Fact>
        <Fact label="Every bot's tool lists">
          Allow: {listWords(browser.everyBot.allow)} · Deny: {listWords(browser.everyBot.deny)}
        </Fact>
        <Fact label="The gateway's browser switches" testId="runs-on-browser-gateway">
          Browser control: {switchWords(browser.gateway.control)} · Browser plugin:{" "}
          {switchWords(browser.gateway.plugin)}
        </Fact>
        <Fact label="Clawtrate's computer plugin" testId="runs-on-browser-profile">
          {!browser.plugin.present
            ? "No entry in the gateway's settings"
            : browser.plugin.profile
              ? `Names the profile ${browser.plugin.profile} for ${botName}`
              : `Names no profile for ${botName}`}
          {browser.plugin.enabled === false ? "; turned off in the gateway's settings" : ""}
        </Fact>
      </dl>
      <p className="b-hint" data-testid="runs-on-browser-choice">
        As stored in the gateway's settings. <Mark kind="shown" />{" "}
        {onNode
          ? `A browser profile on ${machineName}: Not supported on this machine.`
          : "Choosing or creating a browser profile isn't offered here."}
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
                      server.deniedBy
                        ? `${server.deniedBy.list === "bot" ? `${botName}'s` : "every bot's"} deny list: ${server.deniedBy.entry}`
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
        <Fact label="Plugin credentials" testId="inventory-signins">
          {Array.isArray(inventory.pluginCredentials) ? (
            inventory.pluginCredentials.length === 0 ? (
              "No plugin is turned on in the gateway's settings"
            ) : (
              inventory.pluginCredentials
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
                    }`,
                )
                .join(" · ") +
              (inventory.pluginsOmitted > 0 ? ` · ${inventory.pluginsOmitted} more not read` : "")
            )
          ) : (
            <span className="b-faint">{unavailableWords(inventory.pluginCredentials.status)}</span>
          )}
        </Fact>
        <Fact label="Workspace-only file tools" testId="inventory-folders">
          {inventory.workspaceOnly === null
            ? "Not set"
            : `${inventory.workspaceOnly.value ? "On" : "Off"}, in ${inventory.workspaceOnly.set === "bot" ? `${botName}'s settings` : "the gateway's settings for every bot"}`}
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
      {foot}
    </div>
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
          onDone(null);
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
          onClick={() => onDone(null)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
