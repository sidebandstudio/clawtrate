// The fixture's machines (docs/design/controls.md sections 14 and 15): the
// gateway's machine, a paired machine and one not connected, each bot's
// configured place, the approvals files and the paired devices, answered for
// the engine's commands closely enough for interface checks. Every machine,
// device, folder, account and secret name is made up.
//
// Address parameters:
//   machine=shared|offline|gatewayhost|ownbrowser|unlisted|unsupported|none|loading|error
//            shared: Otto and Pip are set to media-box and have the same folder; offline:
//            media-box isn't connected; gatewayhost: Otto's commands set to the gateway's
//            machine; ownbrowser: the computer plugin names a profile for Otto; unlisted: Otto
//            names a machine the gateway doesn't list; unsupported: Otto's stored host is a
//            value the app doesn't know; none: no paired machine; loading, error: the read
//            never answers, or fails
//   devices=noscope   no device access
//   override=1        media-box's file has an entry for Otto that asks every time
//   mwrite=refused|conflict|unanswered|unconfirmed|pending|notapplied   how a change goes
//   mslow=<bot>       that bot's placement read never answers
//   plugins=none      the settings hold no plugin entries to inspect
//   pairing=grant     a request for device access is approved after a moment

import {
  type ApprovalsFile,
  type BotPlacement,
  type BridgeCommand,
  type ClawtrateState,
  type CommandPlace,
  type ConfigSave,
  type DefaultsChoice,
  type DeviceRow,
  type MachinesView,
  type NodeFacts,
} from "@clawtrate/core";

export type MachineParams = {
  machine: string | null;
  devices: string | null;
  override: boolean;
  write: string | null;
  slow: string | null;
  plugins: string | null;
  pairing: string | null;
};

export function machineParams(params: URLSearchParams): MachineParams {
  return {
    machine: params.get("machine"),
    devices: params.get("devices"),
    override: params.get("override") === "1",
    write: params.get("mwrite"),
    slow: params.get("mslow"),
    plugins: params.get("plugins"),
    pairing: params.get("pairing"),
  };
}

export const NO_MACHINE_PARAMS: MachineParams = {
  machine: null,
  devices: null,
  override: false,
  write: null,
  slow: null,
  plugins: null,
  pairing: null,
};

const MEDIA = "node-media-box";
const STUDIO = "node-studio-mac";

const choiceLevels: Record<
  DefaultsChoice,
  { security: "deny" | "allowlist" | "full"; ask: "off" | "on-miss" | "always" }
> = {
  always: { security: "allowlist", ask: "always" },
  miss: { security: "allowlist", ask: "on-miss" },
  allow: { security: "full", ask: "off" },
  never: { security: "deny", ask: "off" },
};

/** The fixture gateway's machines and settings, changed by the commands as the gateway would. */
function world(now: number, params: MachineParams) {
  const nodes: NodeFacts[] =
    params.machine === "none"
      ? []
      : [
          {
            id: MEDIA,
            name: "media-box",
            connected: params.machine !== "offline",
            lastSeenAt: params.machine === "offline" ? now - 29 * 60_000 : now - 40_000,
            lastSeenReason: "connect",
            approved: true,
            approvalsCommands: true,
            listsRun: true,
            paired: true,
          },
          {
            id: STUDIO,
            name: "studio-mac",
            connected: false,
            lastSeenAt: now - 2 * 86_400_000,
            lastSeenReason: "connect",
            approved: true,
            approvalsCommands: true,
            listsRun: true,
            paired: true,
          },
        ];
  const exec: Record<string, { host: string | null; node: string | null }> = {
    juniper: { host: null, node: null },
    marlow: { host: null, node: null },
    otto:
      params.machine === "gatewayhost" || params.machine === "none"
        ? { host: null, node: null }
        : params.machine === "unlisted"
          ? { host: "node", node: "garage-pi" }
          : params.machine === "unsupported"
            ? { host: "cluster", node: null }
            : { host: "node", node: MEDIA },
    pip: params.machine === "shared" ? { host: "node", node: MEDIA } : { host: null, node: null },
  };
  const workspaces: Record<string, string> = {
    juniper: "/srv/clawtrate/workspace",
    marlow: "/srv/clawtrate/workspaces/marlow",
    otto: "/srv/clawtrate/workspaces/otto",
    pip:
      params.machine === "shared"
        ? "/srv/clawtrate/workspaces/otto"
        : "/srv/clawtrate/workspaces/pip",
  };
  const files: Record<string, ApprovalsFile> = {
    gateway: {
      hash: "g1",
      exists: true,
      defaults: { security: null, ask: null },
      resolved: { security: "full", ask: "off" },
      entries: [],
      entriesOmitted: 0,
    },
    [MEDIA]: {
      hash: "m1",
      exists: true,
      defaults: { security: "allowlist", ask: "on-miss" },
      resolved: null,
      entries: params.override
        ? [{ botId: "otto", levels: { security: null, ask: "always" }, allowlist: 3 }]
        : [],
      // The file's `*` entry, which names no listed bot.
      entriesOmitted: 1,
    },
  };
  const devices: DeviceRow[] = [
    {
      id: "dev-desk",
      name: "Clawtrate on this Mac",
      role: "operator",
      connected: true,
      lastSeenAt: now,
      lastSeenReason: "connect",
      thisDevice: true,
      operatorOnly: true,
    },
    {
      id: "dev-phone",
      name: "Clawtrate on iPhone",
      role: "operator",
      connected: false,
      lastSeenAt: now - 43 * 60_000,
      lastSeenReason: "connect",
      thisDevice: false,
      operatorOnly: true,
    },
  ];
  return {
    nodes,
    exec,
    workspaces,
    files,
    devices,
    hashes: { gateway: 1, [MEDIA]: 1 } as Record<string, number>,
  };
}

const later = <T>(ms: number, value: () => T) =>
  new Promise<T>((resolve, reject) =>
    setTimeout(() => {
      try {
        resolve(value());
      } catch (error) {
        reject(error);
      }
    }, ms),
  );

/**
 * The machine commands, answered on the fixture's world. Returns undefined for
 * a command that is not one of them.
 */
export function machineCommands(now: number, params: MachineParams) {
  const w = world(now, params);
  const admin = (state: ClawtrateState) => state.connection.canAdmin;
  /** The fixture's configuration revision: a save moves it on. */
  let revision = 1;
  const pairing = (state: ClawtrateState) =>
    state.connection.scopes.includes("operator.pairing") ||
    (params.devices !== "noscope" && state.connection.canAdmin);
  const place = (botId: string): CommandPlace => {
    const own = w.exec[botId] ?? { host: null, node: null };
    return {
      ownHost: own.host,
      ownNode: own.node,
      defaultHost: null,
      defaultNode: null,
      host: own.host,
      hostSupported:
        own.host === null ? null : ["auto", "sandbox", "gateway", "node"].includes(own.host),
      inherited: false,
      nodeSelector: own.node,
      nodeInherited: false,
      node: own.node === null ? null : (w.nodes.find((n) => n.id === own.node) ?? null),
    };
  };
  const bots = (state: ClawtrateState) => state.bots.map((bot) => bot.id);
  const refuse = () => {
    if (params.write === "refused")
      throw new Error(
        "Couldn't save. The gateway answered: invalid config: agents.entries.otto.tools.exec.node",
      );
    if (params.write === "conflict")
      throw new Error(
        "Couldn't save. The gateway answered: config changed since last load; re-run config.get and retry",
      );
    if (params.write === "unconfirmed")
      throw new Error(
        "The gateway took the change, but reading it back shows another setting. Nothing is shown as saved.",
      );
  };

  function placement(state: ClawtrateState, botId: string): BotPlacement {
    const commands = place(botId);
    const others = bots(state).filter((id) => id !== botId);
    const ownBrowser = params.machine === "ownbrowser" && botId === "otto";
    const same = (id: string) => {
      const other = place(id);
      return (
        commands.host === "node" &&
        commands.nodeSelector !== null &&
        other.host === "node" &&
        other.nodeSelector === commands.nodeSelector
      );
    };
    return {
      botId,
      readAt: now,
      configHash: `c${revision}`,
      configActive: params.write !== "pending" || revision === 1,
      commands,
      workspace: w.workspaces[botId] ?? null,
      browser: {
        own: { allow: null, deny: botId === "otto" || botId === "juniper" ? ["browser"] : null },
        everyBot: { allow: null, deny: [] },
        gateway: { control: null, plugin: true },
        plugin: ownBrowser
          ? { present: true, enabled: true, profile: "bot-otto" }
          : { present: false, enabled: null, profile: null },
      },
      sameSetting: {
        machine: others.filter(same),
        workspace: others.filter((id) => w.workspaces[id] === w.workspaces[botId]),
      },
      inventory: {
        accounts:
          botId === "otto"
            ? [
                { id: "openai:work", label: "Work", bound: true },
                { id: "openai:home", label: "Home", bound: false },
              ]
            : [{ id: "openai:work", label: "Work", bound: false }],
        toolServers: [
          { name: "coder", deniedBy: null, offered: true },
          {
            name: "t3code",
            deniedBy: botId === "otto" ? { list: "bot", entry: "t3code__*" } : null,
            offered: botId === "otto" ? false : true,
          },
        ],
        listing: { key: `agent:${botId}:main`, readAt: now - 120_000 },
        secrets: admin(state)
          ? ["router-admin", "nas-backup", "camera-feed"]
          : { status: "needs-admin" },
        pluginCredentials: admin(state)
          ? params.plugins === "none"
            ? []
            : [
                {
                  plugin: "clawtrate-computer",
                  fields: { status: "failed", message: "Credential metadata is unavailable." },
                  fieldsOmitted: 0,
                },
              ]
          : { status: "needs-admin" },
        pluginsOmitted: 0,
        workspaceOnly: { value: true, set: "every-bot" },
      },
      nodes: w.nodes,
      nodesOmitted: 0,
    };
  }

  function machines(state: ClawtrateState): MachinesView {
    const ids = bots(state);
    const here = (match: (p: CommandPlace) => boolean) => ids.filter((id) => match(place(id)));
    return {
      readAt: now,
      machines: [
        {
          id: "gateway",
          kind: "gateway",
          name: "The gateway's machine",
          node: null,
          named: here((p) => p.host === "gateway"),
          approvals: admin(state) ? w.files.gateway! : { status: "needs-admin" },
        },
        ...w.nodes.map((node) => ({
          id: node.id,
          kind: "node" as const,
          name: node.name,
          node,
          named: here((p) => p.host === "node" && p.nodeSelector === node.id),
          approvals: !admin(state)
            ? ({ status: "needs-admin" } as const)
            : !node.connected
              ? ({ status: "not-connected" } as const)
              : w.files[node.id]!,
        })),
      ],
      nodesOmitted: 0,
      // Below admin the gateway lists a device-token connection's own record only.
      devices: !pairing(state)
        ? { status: "needs-pairing" }
        : admin(state)
          ? w.devices
          : w.devices.filter((device) => device.thisDevice),
      devicesOmitted: 0,
    };
  }

  return function answer(
    command: BridgeCommand,
    get: () => ClawtrateState,
    set: (state: ClawtrateState) => void,
  ): Promise<unknown> | undefined {
    const state = get();
    switch (command.type) {
      case "readPlacement":
        if (params.machine === "loading" || params.slow === command.botId)
          return new Promise(() => {});
        if (params.machine === "error")
          return later(300, () => {
            throw new Error("The gateway did not answer.");
          });
        return later(0, () => placement(get(), command.botId));
      case "readMachines":
        if (params.machine === "loading") return new Promise(() => {});
        if (params.machine === "error")
          return later(300, () => {
            throw new Error("The gateway did not answer.");
          });
        return later(0, () => machines(get()));
      case "setCommandMachine":
        return later(300, (): ConfigSave => {
          if (!admin(state)) throw new Error("Changing where a bot runs needs admin access.");
          if (params.write === "refused")
            return {
              status: "refused",
              message: "invalid config: agents.entries.otto.tools.exec.node",
            };
          if (params.write === "conflict" || command.baseHash !== `c${revision}`)
            return {
              status: "refused",
              message: "config changed since last load; re-run config.get and retry",
            };
          refuse();
          revision += 1;
          w.exec[command.botId] =
            command.host === "node"
              ? { host: "node", node: command.nodeId }
              : { host: "gateway", node: null };
          // The change landed and its answer was lost: what reading it back shows is all there is.
          if (params.write === "unanswered")
            return {
              status: "unknown",
              message: "gateway request timed out after 30000ms: config.patch",
              place: place(command.botId),
            };
          return {
            status: "saved",
            place: place(command.botId),
            active:
              params.write === "pending"
                ? "pending"
                : params.write === "notapplied"
                  ? "failed"
                  : "applied",
            message:
              params.write === "notapplied"
                ? "config.patch persisted but was not applied to the active Gateway (failed)"
                : null,
          };
        });
      case "setBotWorkspace":
        return later(300, () => {
          if (params.write === "refused")
            throw new Error(
              `The gateway answered: workspace path is not usable. It may have created the folder or files before answering. It now reports the workspace as ${w.workspaces[command.botId] ?? "none"}.`,
            );
          refuse();
          w.workspaces[command.botId] = command.path;
          return { workspace: command.path, asTyped: true };
        });
      case "setMachineDefaults":
        return later(300, () => {
          refuse();
          const file = w.files[command.machineId];
          if (!file) throw new Error("This machine doesn't offer its approvals file.");
          if (command.expectedHash !== file.hash)
            throw new Error(
              "This file changed since it was read. It has been read again; choose again.",
            );
          const n = (w.hashes[command.machineId] ?? 1) + 1;
          w.hashes[command.machineId] = n;
          w.files[command.machineId] = {
            ...file,
            hash: `${command.machineId === "gateway" ? "g" : "m"}${n}`,
            defaults: choiceLevels[command.choice],
          };
          return w.files[command.machineId];
        });
      case "renameMachine":
        return later(200, () => {
          if (!admin(state)) throw new Error("Renaming a machine needs admin access.");
          const node = w.nodes.find((each) => each.id === command.nodeId);
          if (node) node.name = command.name;
        });
      case "removeMachine":
        return later(200, () => {
          if (!admin(state)) throw new Error("Removing a machine needs admin access.");
          w.nodes = w.nodes.filter((each) => each.id !== command.nodeId);
        });
      case "renameDevice":
        return later(200, () => {
          const device = w.devices.find((each) => each.id === command.deviceId);
          if (device) device.name = command.name;
        });
      case "removeDevice":
        return later(200, () => {
          if (!admin(state)) throw new Error("Removing a device needs admin access.");
          w.devices = w.devices.filter((each) => each.id !== command.deviceId);
        });
      case "requestAccess": {
        if (command.tier !== "pairing") return undefined;
        const upgrade = (patch: Partial<ClawtrateState["connection"]["upgrade"]>) =>
          set({
            ...get(),
            connection: { ...get().connection, upgrade: { ...get().connection.upgrade, ...patch } },
          });
        const scopes = [
          ...get().connection.scopes.filter((s) => s !== "operator.pairing"),
          "operator.pairing",
        ];
        upgrade({
          status: "requesting",
          scopes,
          requestId: null,
          approveCommand: null,
          error: null,
        });
        setTimeout(() => {
          upgrade({
            status: "pending",
            requestId: "8c2d4e6f-1a3b-4c5d-9e7f-0a1b2c3d4e5f",
            approveCommand: "openclaw devices approve 8c2d4e6f-1a3b-4c5d-9e7f-0a1b2c3d4e5f",
          });
          if (params.pairing === "grant")
            setTimeout(() => {
              set({
                ...get(),
                connection: {
                  ...get().connection,
                  scopes,
                  upgrade: { ...get().connection.upgrade, status: "approved" },
                },
              });
            }, 600);
        }, 300);
        return Promise.resolve();
      }
      default:
        return undefined;
    }
  };
}
