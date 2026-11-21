// Where a bot runs and Settings, Machines (machines.ts) against answers shaped
// as OpenClaw 2026.10.6 gave them on a development instance (docs/decisions.md,
// "Where a bot runs and Machines"). Machines and devices have invented names.
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { describe, expect, it } from "vitest";
import {
  choiceOf,
  MachinesEngine,
  MAX_MACHINE_NAME_CHARS,
  MAX_NODES,
  MAX_PATH_CHARS,
  readBrowserSettings,
  readCommandPlace,
  readDevices,
  readInventoryAccounts,
  readNodes,
  readToolServers,
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
  /** The revision the gateway reports active; it follows each save unless `pending` holds it back. */
  let applied = 1;
  const plugins: Record<string, Json[]> = {};
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
    "config.get": () => ({
      config,
      hash: `c${configHash}`,
      configRevisionHash: `r${configHash}`,
      appliedConfigHash: `r${applied}`,
    }),
    "config.patch": (params) => {
      if (params.baseHash !== `c${configHash}`)
        throw new GatewayProtocolRequestError({
          code: "INVALID_REQUEST",
          message: "config changed since last load; re-run config.get and retry",
        });
      if (!ignore.has("config.patch")) {
        config = merge(config, JSON.parse(params.raw as string) as Json);
        configHash += 1;
        if (!ignore.has("apply")) applied = configHash;
      }
      return { ok: true, hash: `c${configHash}` };
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
    "plugins.inspect": (params) => ({
      ok: true,
      credentials: plugins[params.pluginId as string] ?? [],
    }),
    "plugins.credentials.inspect": (params) => {
      if (params.baseHash !== `c${configHash}`)
        throw new Error("Configuration changed. Reload Settings before inspecting this reference.");
      const field = (plugins[params.pluginId as string] ?? []).find(
        (each) => JSON.stringify(each.path) === JSON.stringify(params.path),
      );
      if (!field) throw new Error("This installed plugin does not declare that credential field.");
      return { baseHash: params.baseHash, credential: { kind: field.status } };
    },
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
      // As the gateway: an id it doesn't hold is refused, and nothing else is touched.
      const at = devices.findIndex((each) => each.deviceId === params.deviceId);
      if (at < 0) throw new Error("unknown deviceId");
      devices.splice(at, 1);
      return { ok: true };
    },
    "node.rename": (params) => {
      nodes.find((n) => n.nodeId === params.nodeId)!.displayName = params.displayName;
      return params;
    },
    "node.pair.remove": (params) => {
      const at = nodes.findIndex((n) => n.nodeId === params.nodeId);
      if (at < 0) throw new Error("unknown nodeId");
      nodes.splice(at, 1);
      return { ok: true };
    },
  };
  const request = async (method: string, params: unknown) => {
    calls.push([method, params as Json]);
    const message = refuse.get(method);
    if (message)
      throw new GatewayProtocolRequestError({
        code: "INVALID_REQUEST",
        message,
        ...(message.startsWith("missing scope: ")
          ? { details: { missingScope: message.slice("missing scope: ".length) } }
          : {}),
      });
    const handler = handlers[method];
    if (!handler) throw new Error(`unknown method ${method}`);
    return handler(params as Json);
  };
  return {
    request,
    calls,
    refuse,
    ignore,
    files,
    nodes,
    devices,
    plugins,
    handlers,
    config: () => config,
  };
}

function engine(
  gw: ReturnType<typeof gateway>,
  access: { admin?: boolean; pairing?: boolean; readOnly?: boolean; noBots?: boolean } = {},
) {
  const ctx: MachinesContext = {
    request: gw.request,
    connected: () => true,
    admin: () => access.admin ?? false,
    pairing: () => access.pairing ?? false,
    readOnly: () => access.readOnly ?? false,
    bots: () =>
      access.noBots
        ? []
        : [
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
  it("F-046: a bot's command machine is the stored host and node, read as the gateway reads them", () => {
    const { nodes } = readNodes({
      nodes: [nodeRow(), nodeRow({ nodeId: OTHER, paired: false, connected: false })],
    });
    expect(nodes.map((n) => n.name)).toEqual(["media-box"]);
    const config = {
      tools: { exec: { host: "node", node: NODE } },
      agents: { entries: { otto: { tools: { exec: { host: "gateway" } } }, pip: {} } },
    };
    const otto = readCommandPlace(config, "otto", nodes);
    expect(otto).toMatchObject({ host: "gateway", inherited: false, hostSupported: true });
    const pip = readCommandPlace(config, "pip", nodes);
    expect(pip).toMatchObject({ host: "node", inherited: true, nodeSelector: NODE });
    expect(pip.node?.id).toBe(NODE);
    expect(readCommandPlace({}, "pip", nodes)).toMatchObject({
      host: null,
      hostSupported: null,
      inherited: false,
    });
  });

  it("F-046: a host the app doesn't know is kept as stored and marked unsupported, never read as another", () => {
    const place = readCommandPlace(
      { agents: { entries: { otto: { tools: { exec: { host: "cluster" } } } } } },
      "otto",
      [],
    );
    expect(place).toMatchObject({ host: "cluster", ownHost: "cluster", hostSupported: false });
  });

  it("F-046: a node inherited from every bot's setting counts when the bot sets only its host, and only an exact id names a listed machine", () => {
    const { nodes } = readNodes({ nodes: [nodeRow()] });
    const inherited = readCommandPlace(
      {
        tools: { exec: { node: NODE } },
        agents: { entries: { otto: { tools: { exec: { host: "node" } } } } },
      },
      "otto",
      nodes,
    );
    expect(inherited).toMatchObject({ nodeSelector: NODE, nodeInherited: true, inherited: false });
    expect(inherited.node?.id).toBe(NODE);
    // The gateway also matches names, addresses and id prefixes in its own way: the app doesn't.
    const byName = readCommandPlace(
      { agents: { entries: { otto: { tools: { exec: { host: "node", node: "Media Box" } } } } } },
      "otto",
      nodes,
    );
    expect(byName).toMatchObject({ nodeSelector: "Media Box", node: null });
  });

  it("F-046: a save sends the revision the page showed, never one read at the click", async () => {
    const gw = gateway();
    const shown = await engine(gw).readPlacement("otto");
    expect(shown.configHash).toBe("c1");
    // Another writer changes the config after the page read it.
    await engine(gw, { admin: true }).setCommandMachine("pip", { host: "gateway" }, "c1");
    await expect(
      engine(gw, { admin: true }).setCommandMachine(
        "otto",
        { host: "node", nodeId: NODE },
        shown.configHash,
      ),
    ).resolves.toEqual({
      status: "refused",
      message: "config changed since last load; re-run config.get and retry",
    });
    expect(gw.calls.filter(([m]) => m === "config.patch").map(([, p]) => p.baseHash)).toEqual([
      "c1",
      "c1",
    ]);
  });

  it("F-046: a save is said saved from the stored setting, and applied only when the gateway reports the saved revision active", async () => {
    const gw = gateway();
    const save = await engine(gw, { admin: true }).setCommandMachine(
      "otto",
      { host: "node", nodeId: NODE },
      "c1",
    );
    const patch = gw.calls.find(([method]) => method === "config.patch")![1];
    expect(JSON.parse(patch.raw as string)).toEqual({
      agents: { entries: { otto: { tools: { exec: { host: "node", node: NODE } } } } },
    });
    expect(save).toMatchObject({
      status: "saved",
      active: "applied",
      message: null,
      place: { ownHost: "node", ownNode: NODE },
    });
    gw.ignore.add("apply");
    const pending = await engine(gw, { admin: true }).setCommandMachine(
      "otto",
      { host: "gateway" },
      "c2",
    );
    expect(pending).toMatchObject({
      active: "pending",
      place: { ownHost: "gateway", ownNode: null },
    });
    expect((await engine(gw).readPlacement("otto")).configActive).toBe(false);
  });

  /** A gateway whose `config.patch` persists the change, then refuses with `message`. */
  function persisting(message: string, applies: boolean) {
    const gw = gateway();
    const patch = gw.handlers["config.patch"]!;
    gw.handlers["config.patch"] = (params) => {
      if (!applies) gw.ignore.add("apply");
      const receipt = patch(params) as { hash: string };
      const error = new Error(message) as Error & { details?: unknown };
      error.details = { persistedConfig: { hash: receipt.hash } };
      throw error;
    };
    return gw;
  }
  const save = (gw: ReturnType<typeof gateway>) =>
    engine(gw, { admin: true }).setCommandMachine("otto", { host: "node", nodeId: NODE }, "c1");
  const FAILED =
    "config.patch persisted but was not applied to the active Gateway (failed); run config.get, then use config.apply to reapply the saved config or restart the Gateway";
  const RESTART_PENDING =
    "config.patch persisted and was accepted for restart; wait for the Gateway to restart, then run config.get to confirm the active revision";
  const RECOVERY =
    "config.patch persisted and updated the active Gateway, but a recovery restart is required; wait for the Gateway to restart, then run config.get to confirm the active revision";

  it("F-046: only the gateway's not-applied reply is failed; its restart replies are kept in its words", async () => {
    expect(await save(persisting(FAILED, false))).toMatchObject({
      active: "failed",
      message: FAILED,
    });
    expect(await save(persisting(RESTART_PENDING, false))).toMatchObject({
      active: "pending",
      message: RESTART_PENDING,
    });
    expect(await save(persisting(RECOVERY, true))).toMatchObject({
      active: "applied",
      message: RECOVERY,
    });
  });

  it("F-046: applied needs the read-back revision to be the one this write's receipt names", async () => {
    // Another write lands between this one and the read-back: a later revision, also active.
    const later = gateway();
    const patch = later.handlers["config.patch"]!;
    later.handlers["config.patch"] = (params) => {
      const receipt = patch(params) as { hash: string };
      const config = later.config() as { agents: { entries: Record<string, unknown> } };
      config.agents.entries.marlow = { workspace: "/srv/claw/workspaces/other" };
      patch({ raw: JSON.stringify({}), baseHash: receipt.hash });
      return receipt;
    };
    const raced = await save(later);
    const read = (await later.request("config.get", {})) as { hash: string };
    expect(read.hash).toBe("c3");
    expect(raced).toMatchObject({ status: "saved", active: "pending" });
    // A receipt that names no revision is never applied.
    const bare = gateway();
    const plain = bare.handlers["config.patch"]!;
    bare.handlers["config.patch"] = (params) => {
      plain(params);
      return { ok: true };
    };
    expect(await save(bare)).toMatchObject({ status: "saved", active: "pending" });
  });

  it("F-046: a saved node the list doesn't have is the stored id, not the gateway's machine", async () => {
    const gw = gateway({ nodes: [] });
    const save = await engine(gw, { admin: true }).setCommandMachine(
      "otto",
      { host: "node", nodeId: NODE },
      "c1",
    );
    expect(save).toMatchObject({ place: { host: "node", nodeSelector: NODE, node: null } });
  });

  it("F-046: a confirmed save stands when the machine list can't be read; the stored id is shown", async () => {
    const gw = gateway();
    gw.refuse.set("node.list", "node list unavailable");
    const save = await engine(gw, { admin: true }).setCommandMachine(
      "otto",
      { host: "node", nodeId: NODE },
      "c1",
    );
    expect(save).toMatchObject({ active: "applied", place: { nodeSelector: NODE, node: null } });
  });

  it("F-046: a save the read-back does not show is refused, not announced", async () => {
    const gw = gateway();
    gw.ignore.add("config.patch");
    await expect(
      engine(gw, { admin: true }).setCommandMachine("otto", { host: "node", nodeId: NODE }, "c1"),
    ).rejects.toThrow(/Nothing is shown as saved/);
  });

  it("F-046: below admin, or on a host that only reads, nothing is sent", async () => {
    const gw = gateway();
    await expect(
      engine(gw).setCommandMachine("otto", { host: "node", nodeId: NODE }, "c1"),
    ).rejects.toThrow("Changing where a bot runs needs admin access.");
    await expect(
      engine(gw, { admin: true, readOnly: true }).setCommandMachine(
        "otto",
        { host: "gateway" },
        "c1",
      ),
    ).rejects.toThrow(/only reads/);
    expect(gw.calls).toEqual([]);
  });

  it("F-046: a refusal is answered in the gateway's own words, as nothing saved", async () => {
    const gw = gateway();
    gw.refuse.set("config.patch", "invalid config: agents.entries.otto.tools.exec.host");
    await expect(
      engine(gw, { admin: true }).setCommandMachine("otto", { host: "gateway" }, "c1"),
    ).resolves.toEqual({
      status: "refused",
      message: "invalid config: agents.entries.otto.tools.exec.host",
    });
    expect(gw.calls.map(([method]) => method)).toEqual(["config.patch"]);
  });

  /** A gateway whose `config.patch` answer is lost: `lands` says whether the change was written first. */
  function unanswered(lost: Error, lands: boolean) {
    const gw = gateway();
    const patch = gw.handlers["config.patch"]!;
    gw.handlers["config.patch"] = (params) => {
      if (lands) patch(params);
      throw lost;
    };
    return gw;
  }
  const CLOSED = new Error("gateway closed (1006): ");

  it("F-046: a save whose answer never came is read back, and answered as unconfirmed with what the gateway stores", async () => {
    const gw = unanswered(CLOSED, false);
    expect(await save(gw)).toEqual({
      status: "unknown",
      message: "gateway closed (1006): ",
      place: expect.objectContaining({ ownHost: null, ownNode: null }),
    });
    expect(gw.calls.map(([method]) => method)).toEqual(["config.patch", "config.get", "node.list"]);
    // An answer the gateway can give after it wrote the file settles nothing either.
    const written = unanswered(
      new GatewayProtocolRequestError({ code: "UNAVAILABLE", message: "config write failed" }),
      true,
    );
    expect(await save(written)).toMatchObject({
      status: "unknown",
      place: { ownHost: "node", ownNode: NODE },
    });
    // When the read fails too, nothing is said about the setting.
    const unread = unanswered(CLOSED, true);
    unread.refuse.set("config.get", "gateway closed (1006): ");
    expect(await save(unread)).toEqual({
      status: "unknown",
      message: "gateway closed (1006): ",
      place: null,
    });
  });

  it("F-046: saved and applied needs the receipt: a lost answer is unconfirmed even when its setting reads back active", async () => {
    const gw = unanswered(CLOSED, true);
    const result = await save(gw);
    const read = (await gw.request("config.get", {})) as Record<string, unknown>;
    expect(read.appliedConfigHash).toBe(read.configRevisionHash);
    expect(result).toMatchObject({ status: "unknown", place: { ownHost: "node", ownNode: NODE } });
    expect(result).not.toHaveProperty("active");
  });

  it("F-046: a settings file the gateway can't read is no setting, after a lost answer and when the page reads again", async () => {
    const gw = unanswered(CLOSED, true);
    const get = gw.handlers["config.get"]!;
    // As OpenClaw 2026.10.6 answers when its settings file fails to parse or read.
    gw.handlers["config.get"] = (params) => ({
      ...(get(params) as Json),
      valid: false,
      config: {},
    });
    expect(await save(gw)).toEqual({
      status: "unknown",
      message: "gateway closed (1006): ",
      place: null,
    });
    const unreadable =
      "The gateway reports that its settings file isn't valid, so it can't be read.";
    await expect(engine(gw).readPlacement("otto")).rejects.toThrow(unreadable);
    await expect(engine(gw).readMachines()).rejects.toThrow(unreadable);
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
      { name: "coder", deniedBy: null, offered: null },
      { name: "t3code", deniedBy: { list: "bot", entry: "t3code__*" }, offered: null },
    ]);
    expect(read.inventory.secrets).toEqual({ status: "needs-admin" });
    expect(read.inventory.pluginCredentials).toEqual({ status: "needs-admin" });
    expect(read.inventory.workspaceOnly).toEqual({ value: true, set: "every-bot" });
    expect(gw.calls.map(([method]) => method)).not.toContain("secrets.store.list");
    const admin = await engine(gw, { admin: true }).readPlacement("otto");
    expect(admin.inventory.secrets).toEqual(["router-admin", "nas-backup"]);
  });

  it("F-274: the bot's workspace is the one the gateway lists, even before the client lists its bots", async () => {
    const read = await engine(gateway(), { noBots: true }).readPlacement("otto");
    expect(read.workspace).toBe("/srv/claw/workspaces/otto");
    expect(read.sameSetting.workspace).toEqual([]);
  });

  it("F-047: a tool server is offered only by a listed tool of its own that the session doesn't deny", () => {
    const long = "a-tool-server-named-past-thirty-characters";
    const config = { mcp: { servers: { coder: {}, [long]: {}, t3code: {} } } };
    // Rows as OpenClaw 2026.10.6's tools.effective lists them: the id carries a shortened
    // server name, `mcpServer` the configured one; session-denied rows are listed too.
    const listing = {
      groups: [
        {
          tools: [
            { id: "coder__lookup", mcpServer: "coder", deniedBySession: true },
            { id: "a-tool-server-named-past-th__run", mcpServer: long },
            { id: "t3code__start", mcpServer: "t3code", deniedBySession: true },
            { id: "t3code__read", mcpServer: "t3code" },
          ],
        },
      ],
    };
    expect(
      readToolServers(config, "otto", listing).map((server) => [server.name, server.offered]),
    ).toEqual([
      ["coder", false],
      [long, true],
      ["t3code", true],
    ]);
  });

  it("F-047: accounts are told apart and matched to the model by their whole ids", () => {
    const head = `acme:${"a".repeat(130)}`;
    const accounts = readInventoryAccounts(
      { providers: [{ profiles: [{ profileId: `${head}-1` }, { profileId: `${head}-2` }] }] },
      `acme/dev-1@${head}-2`,
    );
    expect(accounts.map((each) => each.bound)).toEqual([false, true]);
    expect(accounts.every((each) => each.id.length === MAX_MACHINE_NAME_CHARS)).toBe(true);
  });

  it("F-047: accounts the gateway reports unavailable are unavailable, never none; an empty list stays empty", async () => {
    const gw = gateway();
    // OpenClaw 2026.10.6's answer before its model catalog is prepared.
    const message =
      "Model authentication status is unavailable. Refresh Models after setup finishes; restart the Gateway if it persists.";
    gw.handlers["models.authStatus"] = () => ({
      ts: 1,
      providers: [],
      unavailable: { code: "PREPARED_MODEL_AUTH_UNAVAILABLE", message },
    });
    expect((await engine(gw).readPlacement("otto")).inventory.accounts).toEqual({
      status: "failed",
      message,
    });
    gw.handlers["models.authStatus"] = () => ({ ts: 1, providers: [] });
    expect((await engine(gw).readPlacement("otto")).inventory.accounts).toEqual([]);
  });

  it("F-047: a refused read at the tier says which access it needs, not that there is nothing", async () => {
    const gw = gateway();
    gw.refuse.set("secrets.store.list", "missing scope: operator.admin");
    const read = await engine(gw, { admin: true }).readPlacement("otto");
    expect(read.inventory.secrets).toEqual({ status: "needs-admin" });
  });

  it("F-047: a plugin's credentials are read field by field with the descriptor's path and the revision, and a failed read is unavailable, never none", async () => {
    const gw = gateway({
      config: {
        agents: { entries: { otto: {} } },
        plugins: { entries: { weather: { enabled: true }, mailer: {}, off: { enabled: false } } },
      },
    });
    const path = ["plugins", "entries", "weather", "config", "apiKey"];
    gw.plugins.weather = [{ path, label: "API key", envVars: [], status: "configured" }];
    const inspect = gw.handlers["plugins.inspect"]!;
    gw.handlers["plugins.inspect"] = (params) => {
      if (params.pluginId === "mailer") throw new Error('Plugin "mailer" not found.');
      return inspect(params);
    };
    const read = await engine(gw, { admin: true }).readPlacement("otto");
    expect(read.inventory.pluginCredentials).toEqual([
      {
        plugin: "weather",
        fields: [{ label: "API key", kind: "configured", unresolved: false }],
        fieldsOmitted: 0,
      },
      {
        plugin: "mailer",
        fields: { status: "failed", message: 'Plugin "mailer" not found.' },
        fieldsOmitted: 0,
      },
    ]);
    expect(gw.calls.filter(([m]) => m === "plugins.credentials.inspect")).toEqual([
      ["plugins.credentials.inspect", { pluginId: "weather", path, baseHash: "c1" }],
    ]);
  });

  it("F-047: a missing or malformed field list, or a refused second field, is unavailable; an explicit empty list stays empty", async () => {
    const plugins = { empty: {}, missing: {}, pathless: {}, second: {} };
    const gw = gateway({
      config: { agents: { entries: { otto: {} } }, plugins: { entries: plugins } },
    });
    const path = (name: string) => ["plugins", "entries", "second", "config", name];
    gw.plugins.empty = [];
    gw.plugins.pathless = [{ label: "Key", status: "configured" }];
    gw.plugins.second = [
      { path: path("a"), label: "A", status: "literal" },
      { path: path("b"), label: "B", status: "literal" },
    ];
    const inspect = gw.handlers["plugins.inspect"]!;
    gw.handlers["plugins.inspect"] = (params) =>
      params.pluginId === "missing" ? { ok: true } : inspect(params);
    const credentials = gw.handlers["plugins.credentials.inspect"]!;
    gw.handlers["plugins.credentials.inspect"] = (params) => {
      if (JSON.stringify(params.path) === JSON.stringify(path("b")))
        throw new Error("Credential metadata is unavailable. Reload Settings and try again.");
      return credentials(params);
    };
    const read = await engine(gw, { admin: true }).readPlacement("otto");
    const unreported = {
      status: "failed",
      message: "The gateway did not report credential fields.",
    };
    expect(read.inventory.pluginCredentials).toEqual([
      { plugin: "empty", fields: [], fieldsOmitted: 0 },
      { plugin: "missing", fields: unreported, fieldsOmitted: 0 },
      { plugin: "pathless", fields: unreported, fieldsOmitted: 0 },
      {
        plugin: "second",
        fields: {
          status: "failed",
          message: "Credential metadata is unavailable. Reload Settings and try again.",
        },
        fieldsOmitted: 0,
      },
    ]);
  });

  it("F-272: bots with the same stored node or the same reported path are named as having the same setting", async () => {
    const gw = gateway();
    await engine(gw, { admin: true }).setCommandMachine(
      "otto",
      { host: "node", nodeId: NODE },
      "c1",
    );
    await engine(gw, { admin: true }).setCommandMachine(
      "pip",
      { host: "node", nodeId: NODE },
      "c2",
    );
    const pip = await engine(gw).readPlacement("pip");
    expect(pip.sameSetting.machine).toEqual(["otto"]);
    expect(pip.sameSetting.workspace).toEqual(["marlow"]);
    const otto = await engine(gw).readPlacement("otto");
    expect(otto.sameSetting.workspace).toEqual([]);
  });

  it("F-272: workspace paths are kept whole: a shared long prefix is not the same setting, and an oversize one is unavailable", async () => {
    const prefix = `/srv/${"p".repeat(1_020)}`;
    const ottoPath = `${prefix}/otto`;
    const pipPath = `${prefix}/pip`;
    const gw = gateway({
      config: {
        agents: {
          entries: {
            otto: { workspace: ottoPath },
            pip: { workspace: pipPath },
            marlow: { workspace: `/${"x".repeat(MAX_PATH_CHARS)}` },
          },
        },
      },
    });
    expect(ottoPath.slice(0, 1_024)).toBe(pipPath.slice(0, 1_024));
    const otto = await engine(gw).readPlacement("otto");
    expect(otto.workspace).toBe(ottoPath);
    expect(otto.sameSetting.workspace).toEqual([]);
    expect((await engine(gw).readPlacement("pip")).workspace).toBe(pipPath);
    expect((await engine(gw).readPlacement("marlow")).workspace).toBeNull();
  });

  it("F-273: the browser is the stored tool lists and the computer plugin's profile, and nothing more", () => {
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
    expect(readBrowserSettings(config, "pip")).toEqual({
      own: { allow: null, deny: null },
      everyBot: { allow: null, deny: [] },
      gateway: { control: null, plugin: null },
      plugin: { present: true, enabled: true, profile: "bot-pip" },
    });
    expect(readBrowserSettings(config, "otto")).toMatchObject({
      own: { allow: null, deny: ["browser"] },
      plugin: { profile: null },
    });
    // The gateway's own switches are shown as stored, never read as a browser bots share.
    expect(
      readBrowserSettings(
        { browser: { enabled: false }, plugins: { entries: { browser: { enabled: true } } } },
        "pip",
      ).gateway,
    ).toEqual({ control: false, plugin: true });
    expect(readBrowserSettings({}, "pip").plugin).toEqual({
      present: false,
      enabled: null,
      profile: null,
    });
  });

  it("F-274: a workspace is changed with agents.update, and what the gateway reports after is answered", async () => {
    const gw = gateway();
    await expect(engine(gw, { admin: true }).setWorkspace("otto", "")).rejects.toThrow(
      "Enter a path.",
    );
    expect(gw.calls).toEqual([]);
    expect(await engine(gw, { admin: true }).setWorkspace("otto", "/srv/claw/otto-2")).toEqual({
      workspace: "/srv/claw/otto-2",
      asTyped: true,
    });
    gw.ignore.add("agents.update");
    expect(await engine(gw, { admin: true }).setWorkspace("otto", "/srv/claw/otto-3")).toEqual({
      workspace: "/srv/claw/otto-2",
      asTyped: false,
    });
  });

  it("F-274: a path in another system's form reaches the gateway as typed; the app doesn't judge it", async () => {
    const gw = gateway();
    const paths = [
      "C:\\Workspaces\\Otto",
      "workspaces/otto",
      "~/otto",
      "/srv/../otto",
      "/srv/folder\twith tab",
      "\\\\server\\share\\otto",
    ];
    for (const path of paths) await engine(gw, { admin: true }).setWorkspace("otto", path);
    expect(gw.calls.filter(([m]) => m === "agents.update").map(([, p]) => p.workspace)).toEqual(
      paths,
    );
  });

  it("F-274: a refused workspace change is an unclear outcome with a fresh read, never a rollback", async () => {
    const gw = gateway();
    gw.refuse.set("agents.update", "workspace path is not absolute");
    await expect(engine(gw, { admin: true }).setWorkspace("otto", "relative")).rejects.toThrow(
      "The gateway answered: workspace path is not absolute. It may have created the folder or files before answering. The gateway now lists the workspace as /srv/claw/workspaces/otto.",
    );
    expect(gw.calls.map(([m]) => m)).toEqual(["agents.update", "agents.list"]);
  });

  it("F-274: a workspace the gateway can't be read back for is unconfirmed, never no workspace", async () => {
    const refused = gateway();
    refused.refuse.set("agents.update", "workspace path is not absolute");
    refused.handlers["agents.list"] = () => {
      throw new Error("agents.list unavailable");
    };
    const failure = await engine(refused, { admin: true })
      .setWorkspace("otto", "relative")
      .catch((error: Error) => error.message);
    expect(failure).toBe(
      "The gateway answered: workspace path is not absolute. It may have created the folder or files before answering. The current workspace could not be confirmed.",
    );
    const rejected = gateway();
    rejected.handlers["agents.list"] = () => {
      throw new Error("agents.list unavailable");
    };
    expect(await engine(rejected, { admin: true }).setWorkspace("otto", "/srv/a")).toEqual({
      workspace: null,
      asTyped: false,
    });
    const absent = gateway();
    absent.handlers["agents.list"] = () => ({ agents: [] });
    expect(await engine(absent, { admin: true }).setWorkspace("otto", "/srv/a")).toEqual({
      workspace: null,
      asTyped: false,
    });
    expect(failure).not.toContain("no workspace");
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

  it("F-157: a machine's bots are those whose stored host names it; nothing is counted for an unset host", async () => {
    const gw = gateway({
      config: {
        agents: {
          entries: {
            otto: { tools: { exec: { host: "node", node: NODE } } },
            pip: { tools: { exec: { host: "gateway" } } },
            marlow: {},
          },
        },
      },
    });
    const view = await engine(gw).readMachines();
    expect(view.machines.map((m) => [m.id, m.named])).toEqual([
      ["gateway", ["pip"]],
      [NODE, ["otto"]],
    ]);
  });

  it("F-157: with device access alone only this device's own name changes; another record's name or removal needs admin", async () => {
    const gw = gateway();
    const pairing = engine(gw, { pairing: true });
    await expect(pairing.renameMachine(NODE, "x")).rejects.toThrow(
      "Renaming a machine needs admin access.",
    );
    await expect(pairing.removeMachine(NODE)).rejects.toThrow(
      "Removing a machine needs admin access.",
    );
    await expect(pairing.renameDevice("dev-phone", "Phone")).rejects.toThrow(
      "Renaming a device needs admin access.",
    );
    await expect(pairing.removeDevice("dev-phone")).rejects.toThrow(
      "Removing a device needs admin access.",
    );
    expect(gw.calls).toEqual([]);
    await pairing.renameDevice("dev-self", "My desk");
    expect(gw.devices[0]!.operatorLabel).toBe("My desk");
  });

  it("F-157: with admin, a machine and a device are renamed and removed, connected or not, each read back", async () => {
    const gw = gateway();
    const e = engine(gw, { admin: true, pairing: true });
    await e.renameMachine(NODE, "studio-mac");
    expect(gw.nodes[0]!.displayName).toBe("studio-mac");
    // The gateway doesn't keep a connected machine from being removed, so neither does the app.
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
    // Again: the gateway refuses an id it no longer holds, and the other records stay.
    await expect(e.removeDevice("dev-phone")).rejects.toThrow(
      "Couldn't save the removal. The gateway answered: unknown deviceId",
    );
    expect(gw.devices.map((d) => d.deviceId)).toEqual(["dev-self", NODE]);
  });

  it("F-157: below admin, this device's own record is renamed only when every role it holds is operator", async () => {
    const gw = gateway();
    gw.devices[0]!.roles = ["operator", "node"];
    await expect(engine(gw, { pairing: true }).renameDevice("dev-self", "Desk")).rejects.toThrow(
      "Renaming this device needs admin access.",
    );
    expect(gw.calls.map(([m]) => m)).not.toContain("device.pair.rename");
    gw.devices[0]!.roles = ["operator"];
    gw.devices[0]!.tokens = [{ role: "operator" }, { role: "node" }];
    await expect(engine(gw, { pairing: true }).renameDevice("dev-self", "Desk")).rejects.toThrow(
      "Renaming this device needs admin access.",
    );
    const { devices } = readDevices({ paired: gw.devices }, "dev-self");
    expect(devices.map((d) => [d.id, d.operatorOnly])).toEqual([
      ["dev-self", false],
      ["dev-phone", true],
    ]);
  });

  it("F-157: a removal is not confirmed from a read-back that holds no pairing list", async () => {
    const gw = gateway();
    // What is checked here is the read-back: each removal is answered.
    gw.handlers["node.pair.remove"] = () => ({ ok: true });
    gw.handlers["device.pair.remove"] = () => ({ ok: true });
    gw.handlers["node.list"] = () => ({});
    await expect(engine(gw, { admin: true }).removeMachine(NODE)).rejects.toThrow(
      "The gateway did not return the pairing list. Removal could not be confirmed.",
    );
    gw.handlers["device.pair.list"] = () => ({ pending: [] });
    await expect(engine(gw, { admin: true }).removeDevice("dev-phone")).rejects.toThrow(
      "The gateway did not return the pairing list. Removal could not be confirmed.",
    );
    // A row without its id could be the record removed: the list proves nothing.
    gw.handlers["node.list"] = () => ({ nodes: [{ displayName: "media-box", paired: true }] });
    await expect(engine(gw, { admin: true }).removeMachine(NODE)).rejects.toThrow(
      "Removal could not be confirmed.",
    );
    gw.handlers["device.pair.list"] = () => ({ paired: [{ displayName: "Clawtrate on iPhone" }] });
    await expect(engine(gw, { admin: true }).removeDevice("dev-phone")).rejects.toThrow(
      "Removal could not be confirmed.",
    );
    // An empty list is complete.
    gw.handlers["node.list"] = () => ({ nodes: [] });
    await engine(gw, { admin: true }).removeMachine(NODE);
  });

  it("F-157: a rename is read back by id from the whole list, past the shown bound", async () => {
    const many = Array.from({ length: MAX_NODES + 4 }, (_, i) =>
      nodeRow({ nodeId: `node-${i}`, displayName: `m-${i}` }),
    );
    const gw = gateway({ nodes: many });
    await engine(gw, { admin: true }).renameMachine(`node-${MAX_NODES + 2}`, "far-box");
    expect(gw.nodes[MAX_NODES + 2]!.displayName).toBe("far-box");
  });

  it("F-157: a removal is done only when the whole listing read back lacks the id, not the first page", async () => {
    const many = Array.from({ length: MAX_NODES + 4 }, (_, i) =>
      nodeRow({ nodeId: `node-${i}`, displayName: `m-${i}` }),
    );
    const gw = gateway({ nodes: many });
    // A gateway that answers the removal but keeps the record, listed past the first page.
    gw.handlers["node.pair.remove"] = () => ({ ok: true });
    await expect(
      engine(gw, { admin: true }).removeMachine(`node-${MAX_NODES + 2}`),
    ).rejects.toThrow("The gateway still lists this machine.");
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
    // A page that showed no revision can't overwrite a file that has one now.
    await expect(
      engine(gw, { admin: true }).setMachineDefaults(NODE, "always", null),
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

  it("F-156: a machine whose approvals are a native policy is said as not a file, and no file is written to it", async () => {
    const gw = gateway();
    // The two host-native shapes of OpenClaw 2026.10.6's node snapshot: on, with rules, and off.
    const native = { enabled: true, hash: "n1", defaultAction: "prompt", rules: [] };
    gw.handlers["exec.approvals.node.get"] = () => native;
    const read = await engine(gw, { admin: true }).readMachines();
    expect(read.machines[1]!.approvals).toEqual({ status: "not-a-file" });
    await expect(
      engine(gw, { admin: true }).setMachineDefaults(NODE, "always", "n1"),
    ).rejects.toThrow(
      "This machine's approvals aren't kept in a file, so they can't be changed here.",
    );
    gw.handlers["exec.approvals.node.get"] = () => ({
      enabled: false,
      message: "Off on this host",
    });
    expect((await engine(gw, { admin: true }).readMachines()).machines[1]!.approvals).toEqual({
      status: "not-a-file",
    });
    await expect(
      engine(gw, { admin: true }).setMachineDefaults(NODE, "always", null),
    ).rejects.toThrow(/aren't kept in a file/);
    expect(gw.calls.map(([m]) => m)).not.toContain("exec.approvals.node.set");
  });

  it("F-156: a file's defaults are one of the four choices only when they are exactly that pair", () => {
    expect(choiceOf({ security: "allowlist", ask: "always" })).toBe("always");
    expect(choiceOf({ security: "deny", ask: "off" })).toBe("never");
    expect(choiceOf({ security: "deny", ask: "always" })).toBeNull();
    expect(choiceOf({ security: "full", ask: "always" })).toBeNull();
    expect(choiceOf({ security: "allowlist", ask: null })).toBeNull();
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
