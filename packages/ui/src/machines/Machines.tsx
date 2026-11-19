// Settings, Machines (controls.md section 15): the gateway's machine and each
// paired machine, as last seen, with the bots whose settings name it for
// commands; each machine's approvals file (admin) as its settings, its
// defaults as a radio group written with the file's hash and announced only
// once read back; paired devices (device access). Renaming or removing another
// machine's or device's record is offered with admin only: the gateway refuses
// it to a connection signed in with its device token below admin.

import {
  choiceOf,
  DEFAULTS_CHOICES,
  type ApprovalsFile,
  type Bot,
  type ConnectionState,
  type DefaultsChoice,
  type DeviceRow,
  type HostInfo,
  type MachineRow,
  type MachinesView,
} from "@clawtrate/core";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useBridge, useCommand } from "../bridge.tsx";
import { CopyValue } from "../AccessBar.tsx";
import { clockTime } from "../format.ts";
import { CheckIcon, EyeIcon, WarnIcon } from "../icons.tsx";
import { AdminBar, CommandBlock, GrantedBar, useGranted } from "../bots/parts.tsx";
import { Confirm } from "../bots/Dialog.tsx";
import { Mark } from "./RunsOn.tsx";
import { CHOICE_WORDS, lastSeen, levelsWords, names, nodeState } from "./words.ts";
import "./machines.css";

type Read =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; view: MachinesView };

const PAIRING = "operator.pairing";

/** Whether the connection holds device access by name (admin implies it on the gateway). */
const holdsPairing = (connection: ConnectionState) =>
  connection.status === "connected" &&
  (connection.scopes.includes(PAIRING) || connection.scopes.includes("operator.admin"));

/**
 * The access bar asking for device access only (`operator.pairing`), the
 * request's progress in the same words as the admin bar's.
 */
function DeviceBar({ connection, info }: { connection: ConnectionState; info: HostInfo }) {
  const send = useCommand();
  const ask = () => void send({ type: "requestAccess", tier: "pairing" }).catch(() => {});
  const upgrade = connection.upgrade;
  const mine = upgrade.scopes.includes(PAIRING);
  const status = mine ? upgrade.status : "idle";
  let body: ReactNode;
  let action: ReactNode = null;
  if (info.readOnly)
    body = (
      <>
        <b>Read-only.</b> This connection only reads.
      </>
    );
  else if (status === "requesting") body = "Asking the gateway…";
  else if (status === "pending")
    body = (
      <>
        <b>Waiting for the gateway's owner.</b> Approve this request on the gateway's machine:
      </>
    );
  else if (status === "approved")
    body = (
      <>
        <b>Approved.</b> Connecting again with the new access…
      </>
    );
  else if (status === "rejected" || status === "expired" || status === "error") {
    body =
      status === "rejected" ? (
        <>
          <b>The request was denied.</b> Nothing changed.
        </>
      ) : status === "expired" ? (
        <>
          <b>The request expired</b> before it was approved.
        </>
      ) : (
        <>
          <b>Couldn't send the request.</b> {upgrade.error}
        </>
      );
    action = (
      <button type="button" className="button" data-size="sm" onClick={ask}>
        Request again
      </button>
    );
  } else {
    body = <b>Device access needed.</b>;
    action = (
      <button type="button" className="button" data-variant="primary" data-size="sm" onClick={ask}>
        Request access
      </button>
    );
  }
  if (connection.status !== "connected" || info.readOnly) action = null;
  return (
    <section
      className="access-bar"
      role="region"
      aria-label="Access"
      data-status={info.readOnly ? "pinned" : status}
      data-testid="device-bar"
    >
      <div className="access-row">
        <EyeIcon />
        <span className="shelf-text" aria-live="polite">
          {body}
        </span>
        {action}
      </div>
      {status === "pending" && upgrade.approveCommand && (
        <CommandBlock command={upgrade.approveCommand} label="Copy approve command" />
      )}
      {status === "pending" && upgrade.requestId && (
        <div className="access-id">
          <span className="mono">Request {upgrade.requestId.slice(0, 8)}</span>
          <CopyValue value={upgrade.requestId} label="Copy request id" />
        </div>
      )}
    </section>
  );
}

/** A radio group of the four defaults: one tab stop, arrows move and choose. */
function DefaultsChoices({
  labelledBy,
  value,
  disabled,
  onChoose,
}: {
  labelledBy: string;
  value: DefaultsChoice | null;
  disabled: boolean;
  onChoose: (choice: DefaultsChoice) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusAt = (index: number) => {
    const next = (index + DEFAULTS_CHOICES.length) % DEFAULTS_CHOICES.length;
    refs.current[next]?.focus();
    onChoose(DEFAULTS_CHOICES[next]!);
  };
  const tabStop = value ? DEFAULTS_CHOICES.indexOf(value) : 0;
  return (
    <dl className="facts m-facts" role="radiogroup" aria-labelledby={labelledBy}>
      {DEFAULTS_CHOICES.map((choice, index) => (
        <div key={choice}>
          <button
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            className="b-open"
            role="radio"
            aria-checked={value === choice}
            aria-disabled={disabled || undefined}
            tabIndex={index === tabStop ? 0 : -1}
            data-choice={choice}
            onClick={() => !disabled && value !== choice && onChoose(choice)}
            onKeyDown={(event) => {
              if (disabled) return;
              const moves: Record<string, number> = {
                ArrowDown: index + 1,
                ArrowRight: index + 1,
                ArrowUp: index - 1,
                ArrowLeft: index - 1,
                Home: 0,
                End: DEFAULTS_CHOICES.length - 1,
              };
              const to = moves[event.key];
              if (to === undefined) return;
              event.preventDefault();
              focusAt(to);
            }}
          >
            <span>{CHOICE_WORDS[choice]}</span>
            {value === choice && <CheckIcon />}
          </button>
        </div>
      ))}
    </dl>
  );
}

function Rename({
  initial,
  label,
  onSave,
  onCancel,
}: {
  initial: string;
  label: string;
  onSave: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="m-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim() === "") {
          setError("Enter a name.");
          return;
        }
        setBusy(true);
        onSave(value.trim()).then(
          () => setBusy(false),
          (failure: unknown) => {
            setBusy(false);
            setError(failure instanceof Error ? failure.message : String(failure));
          },
        );
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <input
        className="input"
        aria-label={label}
        value={value}
        autoFocus
        aria-invalid={error !== null}
        onChange={(event) => setValue(event.target.value)}
      />
      {error && (
        <p className="b-field-error" role="alert">
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
          {busy ? "Saving…" : "Save name"}
        </button>
        <button
          type="button"
          className="button"
          data-variant="quiet"
          data-size="sm"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Settings, Machines as a section of the Settings frame. */
export function useMachinesSection({
  active,
  connection,
  info,
  bots,
  announce,
  toNav,
}: {
  active: boolean;
  connection: ConnectionState;
  info: HostInfo;
  bots: readonly Bot[];
  announce: (text: string) => void;
  toNav: ReactNode;
}): { title: string; back: ReactNode; body: ReactNode; foot: ReactNode } {
  const bridge = useBridge();
  const [held, setHeld] = useState<{ key: string; read: Read } | null>(null);
  const [tick, setTick] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{
    kind: "machine" | "device";
    id: string;
    name: string;
    bots: string[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const granted = useGranted(connection);
  const connected = connection.status === "connected";
  // Read again when the granted scopes change, not when a snapshot brings an equal list.
  const scopesKey = connection.scopes.join(" ");
  // A read belongs to the connection and the access it was made with: nothing of another is drawn.
  const key = `${connection.connectedAt ?? ""}\n${scopesKey}`;
  const [forKey, setForKey] = useState(key);
  if (forKey !== key) {
    setForKey(key);
    setErrors({});
    setRenaming(null);
    setRemoving(null);
  }
  const now = Date.now();
  useEffect(() => {
    if (!active || !connected) return;
    let live = true;
    bridge.invoke({ type: "readMachines" }).then(
      (view) => live && setHeld({ key, read: { status: "ready", view } }),
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
  }, [bridge, active, connected, key, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const read: Read = !connected
    ? { status: "error", message: "Not connected to the gateway." }
    : held && held.key === key
      ? held.read
      : { status: "loading" };
  const admin = connection.canAdmin && !info.readOnly;
  const pairing = holdsPairing(connection) && !info.readOnly;
  const nameOf = (id: string) => bots.find((bot) => bot.id === id)?.name ?? id;

  const foot = granted ? (
    <GrantedBar />
  ) : !holdsPairing(connection) ? (
    <DeviceBar connection={connection} info={info} />
  ) : !connection.canAdmin ? (
    <AdminBar
      connection={connection}
      info={info}
      need="Setting approvals, and renaming or removing another machine or device, needs admin access."
    />
  ) : null;

  if (read.status !== "ready") {
    const body =
      read.status === "loading" ? (
        <div aria-busy="true" aria-label="Loading machines" data-testid="machines-loading">
          <div className="skeleton" style={{ height: 96, width: "100%" }} />
          <div className="skeleton" style={{ height: 160, width: "100%", marginTop: 12 }} />
        </div>
      ) : (
        <div className="work-empty" data-testid="machines-error">
          <span className="empty-mark">
            <WarnIcon />
          </span>
          <h4>Couldn't load the machines</h4>
          <p>{read.message || "The gateway did not answer."}</p>
          <div style={{ marginTop: 10 }}>
            <button type="button" className="button" data-size="sm" onClick={reload}>
              Try again
            </button>
          </div>
        </div>
      );
    return { title: "Machines", back: toNav, body, foot };
  }

  const { view } = read;
  const setDefaults = async (machine: MachineRow, file: ApprovalsFile, choice: DefaultsChoice) => {
    setErrors((all) => ({ ...all, [machine.id]: "" }));
    try {
      await bridge.invoke({
        type: "setMachineDefaults",
        machineId: machine.id,
        choice,
        expectedHash: file.hash,
      });
      announce(`Saved. ${machine.name}: ${CHOICE_WORDS[choice]}`);
    } catch (failure) {
      setErrors((all) => ({
        ...all,
        [machine.id]: failure instanceof Error ? failure.message : String(failure),
      }));
      announce("Couldn't save");
    }
    reload();
  };

  const approvalsPart = (machine: MachineRow) => {
    const titleId = `m-approvals-${machine.kind === "gateway" ? "gateway" : machine.id.slice(0, 12)}`;
    const title =
      machine.kind === "gateway"
        ? "The gateway's machine's approvals file"
        : `${machine.name}'s approvals file`;
    const file = machine.approvals;
    let inner: ReactNode;
    if ("status" in file) {
      inner = (
        <p className="b-hint" data-testid="approvals-unavailable">
          {file.status === "needs-admin"
            ? "Seeing a machine's approvals needs admin access."
            : file.status === "not-connected"
              ? `${machine.name} isn't connected, so its file can't be read now.`
              : `Couldn't read this file. ${file.status === "failed" ? file.message : ""}`}
        </p>
      );
    } else {
      const checked = choiceOf(file.defaults);
      const unset = file.defaults.security === null && file.defaults.ask === null;
      inner = (
        <>
          <p className="m-subgroup" id={titleId}>
            Defaults, for bots with no entry of their own
          </p>
          <DefaultsChoices
            labelledBy={titleId}
            value={checked}
            disabled={!admin}
            onChoose={(choice) => void setDefaults(machine, file, choice)}
          />
          {checked === null && (
            <p className="b-hint" data-testid="approvals-unset">
              {!unset
                ? `Set in this file to none of these: ${levelsWords(file.defaults)}.`
                : file.resolved
                  ? `Not set in this file. The gateway reports the defaults it resolved: ${levelsWords(file.resolved)}.`
                  : "Not set in this file, and the machine doesn't report the defaults it resolved."}
            </p>
          )}
          {errors[machine.id] ? (
            <p className="b-field-error" role="alert" data-testid="approvals-error">
              {errors[machine.id]}
            </p>
          ) : null}
          <p className="m-subgroup">Entries</p>
          <dl className="facts m-facts" data-testid="approvals-entries">
            {bots.map((bot) => {
              const entry = file.entries.find((each) => each.botId === bot.id);
              return (
                <div key={bot.id}>
                  <dt>{bot.name}</dt>
                  <dd className="m-value">
                    {entry ? levelsWords(entry.levels) : "No entry of its own"}
                    {entry && entry.allowlist > 0 ? ` · ${entry.allowlist} on its allowlist` : ""}
                  </dd>
                </div>
              );
            })}
          </dl>
          {file.entriesOmitted > 0 && (
            <p className="b-hint">
              {file.entriesOmitted} more entries name agents the gateway doesn't list.
            </p>
          )}
          <p className="b-hint">
            The file's settings, as stored. <Mark kind="set" />
          </p>
        </>
      );
    }
    return (
      <section
        key={`a-${machine.id}`}
        aria-labelledby={`${titleId}-h`}
        data-testid="approvals-file"
        data-machine={machine.name}
      >
        <h4 className="b-group" id={`${titleId}-h`}>
          {title}
        </h4>
        {inner}
      </section>
    );
  };

  const failed = (failure: unknown) => {
    // Whatever the outcome, the page shows the gateway as it is now.
    reload();
    throw failure;
  };

  const nodeActions = (machine: MachineRow) =>
    machine.kind === "node" && machine.node && admin ? (
      renaming === machine.id ? (
        <Rename
          initial={machine.name}
          label={`New name for ${machine.name}`}
          onCancel={() => setRenaming(null)}
          onSave={async (name) => {
            await bridge.invoke({ type: "renameMachine", nodeId: machine.id, name }).catch(failed);
            setRenaming(null);
            announce("Renamed");
            reload();
          }}
        />
      ) : (
        <div className="b-actions m-row-actions">
          <button
            type="button"
            className="button"
            data-size="sm"
            onClick={() => setRenaming(machine.id)}
          >
            Rename
          </button>
          <button
            type="button"
            className="button"
            data-size="sm"
            data-variant="quiet"
            onClick={() =>
              setRemoving({
                kind: "machine",
                id: machine.id,
                name: machine.name,
                bots: machine.named,
              })
            }
          >
            Remove {machine.name}…
          </button>
        </div>
      )
    ) : null;

  const devices = view.devices;
  const deviceRow = (device: DeviceRow) => (
    <div key={device.id}>
      <dt>{device.thisDevice ? "This device" : device.name}</dt>
      <dd className="m-value">
        {device.thisDevice ? `${device.name} · ` : ""}
        {device.connected ? "Connected" : lastSeen(device, now)}
        {renaming === device.id ? (
          <Rename
            initial={device.name}
            label={`New name for ${device.name}`}
            onCancel={() => setRenaming(null)}
            onSave={async (name) => {
              await bridge
                .invoke({ type: "renameDevice", deviceId: device.id, name })
                .catch(failed);
              setRenaming(null);
              announce("Renamed");
              reload();
            }}
          />
        ) : (
          // This device's own name needs device access; another's record needs admin.
          (device.thisDevice ? pairing : admin) && (
            <span className="b-actions m-row-actions">
              <button
                type="button"
                className="button"
                data-size="sm"
                data-variant="quiet"
                onClick={() => setRenaming(device.id)}
              >
                Rename
              </button>
              {!device.thisDevice && (
                <button
                  type="button"
                  className="button"
                  data-size="sm"
                  data-variant="quiet"
                  onClick={() =>
                    setRemoving({ kind: "device", id: device.id, name: device.name, bots: [] })
                  }
                >
                  Remove
                </button>
              )}
            </span>
          )
        )}
      </dd>
    </div>
  );

  const body = (
    <div className="m-page" data-testid="machines">
      <h4 className="b-group">Machines</h4>
      <dl className="facts m-facts" data-testid="machine-list">
        {view.machines.map((machine) => (
          <div key={machine.id} data-machine={machine.name}>
            <dt>{machine.name}</dt>
            <dd className="m-value">
              {machine.node ? nodeState(machine.node, now) : "Connected"}
              {machine.node && !machine.node.listsRun ? " · Lists no system.run command" : ""}
              {" · "}
              {machine.kind === "gateway"
                ? machine.named.length > 0
                  ? `Stored command setting for ${names(machine.named.map(nameOf))}`
                  : "No matching stored host setting"
                : machine.named.length > 0
                  ? `Node ID stored in the settings of ${names(machine.named.map(nameOf))}`
                  : "No matching stored node ID"}
              {nodeActions(machine)}
            </dd>
          </div>
        ))}
      </dl>
      {view.machines.length === 1 && (
        <p className="b-hint" data-testid="machines-none">
          No machine is paired with this gateway. A paired machine's node host appears here once its
          owner approves it.
        </p>
      )}
      {view.nodesOmitted > 0 && (
        <p className="b-hint">{view.nodesOmitted} more machines aren't listed.</p>
      )}
      {view.machines.every(
        (m) => "status" in m.approvals && m.approvals.status === "needs-admin",
      ) ? (
        <>
          <h4 className="b-group">Approvals files</h4>
          <p className="b-hint" data-testid="approvals-unavailable">
            Seeing a machine's approvals needs admin access.
          </p>
        </>
      ) : (
        view.machines.map(approvalsPart)
      )}
      <h4 className="b-group">Paired devices</h4>
      {"status" in devices ? (
        <p className="b-hint" data-testid="devices-unavailable">
          {devices.status === "needs-pairing"
            ? "Seeing paired devices needs device access."
            : `Couldn't read the paired devices. ${devices.status === "failed" ? devices.message : ""}`}
        </p>
      ) : (
        <dl className="facts m-facts" data-testid="device-list">
          {devices.map(deviceRow)}
        </dl>
      )}
      <p className="b-hint" data-testid="machines-read-at">
        As the gateway reported them at {clockTime(view.readAt)}.
      </p>
      {removing && (
        <Confirm
          title={`Remove ${removing.name}?`}
          text={`Asks the gateway to remove ${removing.name}'s pairing.${
            removing.bots.length > 0
              ? ` Its node ID is stored in the settings of ${names(removing.bots.map(nameOf))}.`
              : ""
          }`}
          action="Remove"
          busy={busy}
          onCancel={() => setRemoving(null)}
          onAction={() => {
            setBusy(true);
            const done =
              removing.kind === "machine"
                ? bridge.invoke({ type: "removeMachine", nodeId: removing.id })
                : bridge.invoke({ type: "removeDevice", deviceId: removing.id });
            done.then(
              () => {
                announce("Removed");
                setRemoving(null);
                setBusy(false);
                reload();
              },
              (failure: unknown) => {
                setBusy(false);
                setRemoving(null);
                setErrors((all) => ({
                  ...all,
                  remove: failure instanceof Error ? failure.message : String(failure),
                }));
                reload();
              },
            );
          }}
        />
      )}
      {errors.remove ? (
        <p className="b-field-error" role="alert">
          {errors.remove}
        </p>
      ) : null}
    </div>
  );
  return { title: "Machines", back: toNav, body, foot };
}
