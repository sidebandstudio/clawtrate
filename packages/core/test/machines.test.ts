// Where a bot runs and Settings, Machines (machines.ts) against answers shaped
// as OpenClaw 2026.10.6 gave them on a development instance (docs/decisions.md,
// "Where a bot runs and Machines"). Machines and devices have invented names.
import { describe, expect, it } from "vitest";
import {
  choiceOf,
  combinePosture,
  MachinesEngine,
  readBrowserPlace,
  readCommandPlace,
  readDevices,
  readExecPolicy,
  readNodes,
  readApprovalsFile,
  fileLevelsFor,
  workspaceProblem,
  type MachinesContext,
} from "../src/machines.ts";

const NODE = "node-media-box";
const OTHER = "node-other";

const nodeRow = (over: Record<string, unknown> = {}) => ({
  nodeId: NODE,
  displayName: "media-box",
  platform: "macos",
  clientId: "node-host",
  clientMode: "node",
  caps: ["system"],
  commands: ["system.execApprovals.get", "system.execApprovals.set"],
  approvalState: "approved",
  connectedAtMs: 1_000,
  lastSeenAtMs: 1_000,
  lastSeenReason: "connect",
  paired: true,
  connected: true,
  ...over,
});

type Json = Record<string, unknown>;

/** A gateway whose config, files and lists live in memory and change as the methods say. */
function gateway(start: { config?: Json; nodes?: Json[]; devices?: Json[] } = {}) {
  let config: Json = start.config ?? {
    agents: {
      entries: {
        otto: { workspace: "/srv/claw/workspaces/otto", tools: { exec: { mode: "ask" } } },
        pip: { workspace: "/srv/claw/workspaces/pip" },
        marlow: { workspace: "/srv/claw/workspaces/pip" },
      },
    },
    tools: { exec: { mode: "deny" }, deny: [] },
    mcp: { servers: { coder: {}, t3code: {} } },
  };
  let configHash = 1;
  const files: Record<string, { file: Json; hash: number }> = {
    gateway: { file: { version: 1, defaults: {}, agents: {} }, hash: 1 },
    [NODE]: { file: { version: 1, defaults: {}, agents: {} }, hash: 1 },
  };
  const nodes = start.nodes ?? [nodeRow()];
  const devices = start.devices ?? [
    { deviceId: "dev-self", displayName: "Clawtrate Desktop", role: "operator", connected: true },
    {
      deviceId: "dev-phone",
      displayName: "Clawtrate on iPhone",
      role: "operator",
      lastSeenAtMs: 5,
    },
    { deviceId: NODE, displayName: "media-box", role: "node" },
  ];
  const agents = () =>
    Object.entries((config.agents as Json).entries as Json).map(([id, entry]) => ({
      id,
      workspace: (entry as Json).workspace,
    }));
  const calls: Array<[string, Json]> = [];
  const refuse = new Map<string, string>();
  const ignore = new Set<string>();
  const merge = (target: Json, patch: Json): Json => {
    const out: Json = { ...target };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete out[key];
      else if (value && typeof value === "object" && !Array.isArray(value))
        out[key] = merge((out[key] as Json) ?? {}, value as Json);
      else out[key] = value;
    }
    return out;
  };
  const snapshot = (id: string, withResolved: boolean) => ({
    path: "/redacted",
    exists: true,
    file: { ...files[id]!.file, socket: { path: "/redacted.sock" } },
    hash: `h${files[id]!.hash}`,
    ...(withResolved ? { resolvedDefaults: { security: "full", ask: "off" } } : {}),
  });
  const handlers: Record<string, (params: Json) => unknown> = {
    "config.get": () => ({ config, hash: `c${configHash}` }),
    "config.patch": (params) => {
      if (params.baseHash !== `c${configHash}`)
        throw new Error("config changed since last load; re-run config.get and retry");
      if (!ignore.has("config.patch")) {
        config = merge(config, JSON.parse(params.raw as string) as Json);
        configHash += 1;
      }
      return { ok: true };
    },
    "agents.list": () => ({ agents: agents() }),
    "agents.update": (params) => {
      const entry = ((config.agents as Json).entries as Json)[params.agentId as string] as Json;
      if (!ignore.has("agents.update")) entry.workspace = params.workspace;
      return { ok: true };
    },
    "node.list": () => ({ ts: 1, nodes }),
    "models.authStatus": () => ({
      providers: [
        {
          provider: "acme",
          profiles: [{ profileId: "acme:work", displayName: "Work" }, { profileId: "acme:home" }],
        },
      ],
    }),
    "secrets.store.list": () => ({ entries: [{ name: "router-admin" }, { name: "nas-backup" }] }),
    "plugins.credentials.inspect": () => ({ credentials: [] }),
    "exec.approvals.get": () => snapshot("gateway", true),
    "exec.approvals.set": (params) => {
      if (params.baseHash !== `h${files.gateway!.hash}`)
        throw new Error(
          "exec approvals changed since last load; re-run exec.approvals.get and retry",
        );
      files.gateway = { file: params.file as Json, hash: files.gateway!.hash + 1 };
      return snapshot("gateway", true);
    },
    "exec.approvals.node.get": (params) => {
      if (!nodes.find((n) => n.nodeId === params.nodeId)?.connected)
        throw new Error("NOT_CONNECTED: node not connected");
      return snapshot(params.nodeId as string, false);
    },
    "exec.approvals.node.set": (params) => {
      const id = params.nodeId as string;
      if (params.baseHash !== `h${files[id]!.hash}`)
        throw new Error("INVALID_REQUEST: exec approvals changed; reload and retry");
      if (!ignore.has("exec.approvals.node.set"))
        files[id] = { file: params.file as Json, hash: files[id]!.hash + 1 };
      return snapshot(id, false);
    },
    "device.pair.list": () => ({ pending: [], paired: devices }),
    "device.pair.rename": (params) => {
      const d = devices.find((each) => each.deviceId === params.deviceId)!;
      d.operatorLabel = params.label;
      return { deviceId: params.deviceId, label: params.label };
    },
    "device.pair.remove": (params) => {
      devices.splice(
        devices.findIndex((each) => each.deviceId === params.deviceId),
        1,
      );
      return { ok: true };
    },
    "node.rename": (params) => {
      nodes.find((n) => n.nodeId === params.nodeId)!.displayName = params.displayName;
      return params;
    },
    "node.pair.remove": (params) => {
      nodes.splice(
        nodes.findIndex((n) => n.nodeId === params.nodeId),
        1,
      );
      return { ok: true };
    },
  };
  const request = async (method: string, params: unknown) => {
    calls.push([method, params as Json]);
    const message = refuse.get(method);
    if (message) {
      const error = new Error(message) as Error & { details?: unknown };
      if (message.startsWith("missing scope: "))
        error.details = { missingScope: message.slice("missing scope: ".length) };
      throw error;
    }
    const handler = handlers[method];
    if (!handler) throw new Error(`unknown method ${method}`);
    return handler(params as Json);
  };
  return { request, calls, refuse, ignore, files, nodes, devices, config: () => config };
}

function engine(
  gw: ReturnType<typeof gateway>,
  access: { admin?: boolean; pairing?: boolean; readOnly?: boolean } = {},
) {
  const ctx: MachinesContext = {
    request: gw.request,
    connected: () => true,
    admin: () => access.admin ?? false,
    pairing: () => access.pairing ?? false,
    readOnly: () => access.readOnly ?? false,
    bots: () => [
      { id: "otto", name: "Otto" },
      { id: "pip", name: "Pip" },
      { id: "marlow", name: "Marlow" },
    ],
    latestTask: () => null,
    deviceId: () => "dev-self",
    now: () => 42,
  };
  return new MachinesEngine(ctx);
}

describe("where a bot runs: the engine", () => {
  it("F-046: a bot's command machine is its own setting or the one it inherits, matched to a listed node", () => {
    const { nodes } = readNodes({
      nodes: [nodeRow(), nodeRow({ nodeId: OTHER, paired: false, connected: false })],
    });
    expect(nodes.map((n) => n.name)).toEqual(["media-box"]);
    const config = {
      tools: { exec: { host: "node", node: "media-box" } },
      agents: { entries: { otto: { tools: { exec: { host: "gateway" } } }, pip: {} } },
    };
    const otto = readCommandPlace(config, "otto", nodes);
    expect(otto).toMatchObject({ host: "gateway", inherited: false, node: null });
    const pip = readCommandPlace(config, "pip", nodes);
    expect(pip).toMatchObject({ host: "node", inherited: true, nodeSelector: "media-box" });
    expect(pip.node?.id).toBe(NODE);
    expect(readCommandPlace({}, "pip", nodes)).toMatchObject({ host: "auto", inherited: true });
  });

  it("F-046: admin sets Otto's commands to media-box with the config's hash, and only a read-back that agrees is answered", async () => {
    const gw = gateway();
    const place = await engine(gw, { admin: true }).setCommandMachine("otto", {
      host: "node",
      nodeId: NODE,
    });
    const patch = gw.calls.find(([method]) => method === "config.patch")![1];
    expect(patch.baseHash).toBe("c1");
    expect(JSON.parse(patch.raw as string)).toEqual({
      agents: { entries: { otto: { tools: { exec: { host: "node", node: NODE } } } } },
    });
    expect(place).toMatchObject({ ownHost: "node", ownNode: NODE });
    expect(place.node?.name).toBe("media-box");
    // Back to the gateway's machine removes the node it named.
    const back = await engine(gw, { admin: true }).setCommandMachine("otto", { host: "gateway" });
    expect(back).toMatchObject({ ownHost: "gateway", ownNode: null });
  });

  it("F-046: a save the read-back does not show is refused, not announced", async () => {
    const gw = gateway();
    gw.ignore.add("config.patch");
    await expect(
      engine(gw, { admin: true }).setCommandMachine("otto", { host: "node", nodeId: NODE }),
    ).rejects.toThrow(/Nothing is shown as saved/);
  });

  it("F-046: below admin, or on a host that only reads, nothing is sent", async () => {
    const gw = gateway();
    await expect(
      engine(gw).setCommandMachine("otto", { host: "node", nodeId: NODE }),
    ).rejects.toThrow("Changing where a bot runs needs admin access.");
    await expect(
      engine(gw, { admin: true, readOnly: true }).setCommandMachine("otto", { host: "gateway" }),
    ).rejects.toThrow(/only reads/);
    expect(gw.calls).toEqual([]);
  });

  it("F-046: the gateway's refusal is shown in its own words", async () => {
    const gw = gateway();
    gw.refuse.set("config.patch", "invalid config: agents.entries.otto.tools.exec.host");
    await expect(
      engine(gw, { admin: true }).setCommandMachine("otto", { host: "gateway" }),
    ).rejects.toThrow("Couldn't save where its commands run. The gateway answered: invalid config");
  });

  it("F-047: the inventory names accounts, tool servers and, with admin only, secrets; none is a permission", async () => {
    const gw = gateway({
      config: {
        agents: {
          entries: {
            otto: { model: "acme/dev-1@acme:work", tools: { deny: ["t3code__*"] } },
          },
        },
        tools: { fs: { workspaceOnly: true } },
        mcp: { servers: { coder: {}, t3code: {} } },
      },
    });
    const read = await engine(gw).readPlacement("otto");
    expect(read.inventory.accounts).toEqual([
      { id: "acme:work", label: "Work", bound: true },
      { id: "acme:home", label: null, bound: false },
    ]);
    expect(read.inventory.toolServers).toEqual([
      { name: "coder", denied: null, offered: null },
      { name: "t3code", denied: "bot", offered: null },
    ]);
    expect(read.inventory.secrets).toEqual({ status: "needs-admin" });
    expect(read.inventory.pluginSignIns).toEqual({ status: "needs-admin" });
    expect(read.inventory.workspaceOnly).toBe(true);
    expect(gw.calls.map(([method]) => method)).not.toContain("secrets.store.list");
    const admin = await engine(gw, { admin: true }).readPlacement("otto");
    expect(admin.inventory.secrets).toEqual(["router-admin", "nas-backup"]);
  });

  it("F-047: a refused read at the tier says which access it needs, not that there is nothing", async () => {
    const gw = gateway();
    gw.refuse.set("secrets.store.list", "missing scope: operator.admin");
    const read = await engine(gw, { admin: true }).readPlacement("otto");
    expect(read.inventory.secrets).toEqual({ status: "needs-admin" });
  });

  it("F-272: bots set to the same machine or the same folder are named as sharing it", async () => {
    const gw = gateway();
    await engine(gw, { admin: true }).setCommandMachine("otto", { host: "node", nodeId: NODE });
    await engine(gw, { admin: true }).setCommandMachine("pip", { host: "node", nodeId: NODE });
    const pip = await engine(gw).readPlacement("pip");
    expect(pip.sharedWith.machine).toEqual(["otto"]);
    expect(pip.sharedWith.workspace).toEqual(["marlow"]);
    const otto = await engine(gw).readPlacement("otto");
    expect(otto.sharedWith.workspace).toEqual([]);
  });

  it("F-273: the browser is a bot's own only with the computer plugin's entry; a denied browser says so", () => {
    const config = {
      tools: { deny: [] },
      agents: { entries: { otto: { tools: { deny: ["browser"] } } } },
      plugins: {
        entries: {
          "clawtrate-computer": {
            enabled: true,
            config: { bots: { pip: { profile: "bot-pip" } } },
          },
        },
      },
    };
    expect(readBrowserPlace(config, "pip")).toEqual({
      kind: "own",
      profile: "bot-pip",
      pluginEnabled: true,
    });
    expect(readBrowserPlace(config, "marlow")).toEqual({ kind: "shared" });
    expect(readBrowserPlace(config, "otto")).toEqual({ kind: "denied", by: "bot" });
    expect(readBrowserPlace({ tools: { deny: ["browser"] } }, "pip")).toEqual({
      kind: "denied",
      by: "every-bot",
    });
  });

  it("F-274: a workspace is changed with agents.update and answered only as read back", async () => {
    const gw = gateway();
    expect(workspaceProblem("workspaces/otto")).toMatch(/starting with \//);
    expect(workspaceProblem("/srv/../etc")).toMatch(/'\.\.'/);
    await expect(engine(gw, { admin: true }).setWorkspace("otto", "relative")).rejects.toThrow(
      /starting with/,
    );
    expect(gw.calls).toEqual([]);
    const read = await engine(gw, { admin: true }).setWorkspace("otto", "/srv/claw/otto-2");
    expect(read).toBe("/srv/claw/otto-2");
    gw.ignore.add("agents.update");
    await expect(
      engine(gw, { admin: true }).setWorkspace("otto", "/srv/claw/otto-3"),
    ).rejects.toThrow(/reads the folder back as \/srv\/claw\/otto-2/);
  });
});

describe("Settings, Machines: the engine", () => {
  it("F-157: machines are the gateway's and each paired node, last seen as reported; devices leave nodes out, this device first", async () => {
    const gw = gateway({
      nodes: [nodeRow({ connected: false, lastSeenAtMs: 900, lastSeenReason: "connect" })],
    });
    const view = await engine(gw).readMachines();
    expect(view.machines.map((m) => [m.kind, m.name])).toEqual([
      ["gateway", "The gateway's machine"],
      ["node", "media-box"],
    ]);
    expect(view.machines[1]!.node).toMatchObject({
      connected: false,
      lastSeenAt: 900,
      lastSeenReason: "connect",
    });
    expect(view.devices).toEqual({ status: "needs-pairing" });
    const { devices } = readDevices(
      {
        paired: [
          { deviceId: "b", displayName: "B" },
          { deviceId: "a", displayName: "A", operatorLabel: "Desk" },
          { deviceId: "n", role: "node" },
        ],
      },
      "a",
    );
    expect(devices.map((d) => [d.name, d.thisDevice])).toEqual([
      ["Desk", true],
      ["B", false],
    ]);
  });

  it("F-157: with device access, a machine and a device are renamed and removed, each read back", async () => {
    const gw = gateway();
    await expect(engine(gw).renameMachine(NODE, "x")).rejects.toThrow("needs device access");
    const e = engine(gw, { pairing: true });
    await e.renameMachine(NODE, "studio-mac");
    expect(gw.nodes[0]!.displayName).toBe("studio-mac");
    await expect(e.removeMachine(NODE)).rejects.toThrow(/connected/);
    gw.nodes[0]!.connected = false;
    await e.removeMachine(NODE);
    expect(gw.nodes).toEqual([]);
    await e.renameDevice("dev-phone", "Phone");
    const view = await e.readMachines();
    expect(Array.isArray(view.devices) && view.devices.map((d) => d.name)).toEqual([
      "Clawtrate Desktop",
      "Phone",
    ]);
    await expect(e.removeDevice("dev-self")).rejects.toThrow(/itself/);
    await e.removeDevice("dev-phone");
    expect(gw.devices.map((d) => d.deviceId)).not.toContain("dev-phone");
  });

  it("F-156: a node's approvals file needs admin to read; an offline node's is not connected", async () => {
    const gw = gateway();
    expect((await engine(gw).readMachines()).machines.map((m) => m.approvals)).toEqual([
      { status: "needs-admin" },
      { status: "needs-admin" },
    ]);
    expect(gw.calls.map(([m]) => m)).not.toContain("exec.approvals.node.get");
    const admin = await engine(gw, { admin: true }).readMachines();
    const file = admin.machines[1]!.approvals;
    expect(file).toMatchObject({
      hash: "h1",
      defaults: { security: null, ask: null },
      resolved: null,
    });
    expect(JSON.stringify(admin)).not.toContain("redacted");
    gw.nodes[0]!.connected = false;
    expect((await engine(gw, { admin: true }).readMachines()).machines[1]!.approvals).toEqual({
      status: "not-connected",
    });
  });

  it("F-156: admin sets media-box's defaults to Ask every time with the file's hash; it reads back with a new hash", async () => {
    const gw = gateway();
    gw.files[NODE]!.file = {
      version: 1,
      defaults: { askFallback: "deny" },
      agents: { otto: { allowlist: [{ pattern: "ls" }] } },
    };
    const after = await engine(gw, { admin: true }).setMachineDefaults(NODE, "always", "h1");
    const set = gw.calls.find(([m]) => m === "exec.approvals.node.set")![1];
    expect(set).toEqual({
      nodeId: NODE,
      baseHash: "h1",
      file: {
        version: 1,
        defaults: { askFallback: "deny", security: "allowlist", ask: "always" },
        agents: { otto: { allowlist: [{ pattern: "ls" }] } },
      },
    });
    expect(after.hash).toBe("h2");
    expect(choiceOf(after.defaults)).toBe("always");
    expect(after.entries).toEqual([
      { botId: "otto", levels: { security: null, ask: null }, allowlist: 1 },
    ]);
  });

  it("F-156: a file changed since it was read is refused, and so is a write the machine did not keep", async () => {
    const gw = gateway();
    await expect(
      engine(gw, { admin: true }).setMachineDefaults(NODE, "always", "h0"),
    ).rejects.toThrow(/changed since it was read/);
    expect(gw.calls.map(([m]) => m)).not.toContain("exec.approvals.node.set");
    gw.ignore.add("exec.approvals.node.set");
    await expect(
      engine(gw, { admin: true }).setMachineDefaults(NODE, "never", "h1"),
    ).rejects.toThrow(/Nothing is shown as saved/);
    const gwFile = await engine(gw, { admin: true }).setMachineDefaults("gateway", "miss", "h1");
    expect(gwFile.resolved).toEqual({ security: "full", ask: "off" });
    expect(gw.calls.some(([m]) => m === "exec.approvals.set")).toBe(true);
  });

  it("F-156: the effective result is the gateway's combination: the stricter, the more asking, the reviewer only when no file asks more", () => {
    const auto = readExecPolicy(
      { agents: { entries: { otto: { tools: { exec: { mode: "auto" } } } } } },
      "otto",
    );
    expect(auto).toMatchObject({
      mode: "auto",
      security: "allowlist",
      ask: "on-miss",
      autoReview: true,
      own: true,
    });
    const miss = fileLevelsFor(
      readApprovalsFile({ file: { defaults: { security: "allowlist", ask: "on-miss" } } }),
      "otto",
    );
    expect(combinePosture(auto, [miss])).toEqual({
      security: "allowlist",
      ask: "on-miss",
      autoReview: true,
      raisedBy: null,
      narrowedBy: null,
    });
    const always = fileLevelsFor(
      readApprovalsFile({ file: { defaults: {}, agents: { otto: { ask: "always" } } } }),
      "otto",
    );
    expect(combinePosture(auto, [miss, always])).toEqual({
      security: "allowlist",
      ask: "always",
      autoReview: false,
      raisedBy: 1,
      narrowedBy: null,
    });
    const empty = fileLevelsFor(readApprovalsFile({ file: {} }), "otto");
    expect(empty).toEqual({ security: "full", ask: "off" });
    const full = readExecPolicy({ tools: { exec: { mode: "full" } } }, "pip");
    expect(combinePosture(full, [{ security: "deny", ask: "off" }])).toMatchObject({
      security: "deny",
      narrowedBy: 0,
    });
    expect(readExecPolicy({}, "pip")).toMatchObject({ none: true, security: "full", ask: "off" });
    expect(
      readExecPolicy({ tools: { exec: { security: "allowlist", ask: "on-miss" } } }, "pip"),
    ).toMatchObject({ legacy: true, mode: null });
  });
});

describe("the answers' size", () => {
  // The web host sends one answer in one result frame (`MAX_RESULT_CHARS`, 262,144, in
  // apps/desktop/src/web-host/server.ts), so the largest answer must fit with room to spare.
  const FRAME = 262_144 - 4_096;
  const long = (n: number, c = "x") => c.repeat(n);

  it("the largest machines answer and placement answer fit one result frame", async () => {
    const nodes = Array.from({ length: 100 }, (_, i) =>
      nodeRow({
        nodeId: `${i}${long(300)}`.slice(0, 128),
        displayName: long(2_000, "é"),
        lastSeenReason: long(2_000),
      }),
    );
    const bots = Array.from({ length: 32 }, (_, i) => `${i}${long(127, "b")}`.slice(0, 128));
    const entries = Object.fromEntries(
      bots.map((id) => [
        id,
        { tools: { exec: { host: "node", node: nodes[0]!.nodeId, mode: "auto" } } },
      ]),
    );
    const gw = gateway({
      config: {
        agents: { entries },
        mcp: {
          servers: Object.fromEntries(
            Array.from({ length: 100 }, (_, i) => [`${i}${long(300)}`, {}]),
          ),
        },
      },
      nodes,
      devices: Array.from({ length: 200 }, (_, i) => ({
        deviceId: `${i}${long(2_000)}`,
        displayName: long(2_000),
        operatorLabel: long(2_000),
        role: "operator",
        lastSeenReason: long(2_000),
      })),
    });
    // Entries for every listed bot, and many for ids no listed bot has.
    const agentsFile = Object.fromEntries([
      ...bots.map((id) => [id, { security: "allowlist", ask: "always", allowlist: [] }]),
      ...Array.from({ length: 200 }, (_, i) => [`${i}${long(2_000)}`, { ask: "always" }]),
    ]);
    gw.files.gateway!.file = { version: 1, defaults: {}, agents: agentsFile };
    for (const node of nodes)
      gw.files[node.nodeId as string] = {
        file: { version: 1, defaults: {}, agents: agentsFile },
        hash: 1,
      };
    const e = new MachinesEngine({
      request: gw.request,
      connected: () => true,
      admin: () => true,
      pairing: () => true,
      readOnly: () => false,
      bots: () => bots.map((id) => ({ id, name: id })),
      latestTask: () => null,
      deviceId: () => null,
      now: () => 1,
    });
    const machines = JSON.stringify(await e.readMachines()).length;
    const placement = JSON.stringify(await e.readPlacement(bots[0]!)).length;
    expect(machines).toBeLessThan(FRAME);
    expect(placement).toBeLessThan(FRAME);
  });
});
