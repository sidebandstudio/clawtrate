import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, posix, relative, resolve, sep } from "node:path";
import {
  HASH,
  MAX_BYTES,
  MAX_DEPTH,
  MAX_PATH,
  Refusal,
  applyCas,
  inside,
  missing,
  notePath,
  read,
  requireHash,
  requireNativeMutations,
  rootOptions,
  sha256,
  sharedDirectory,
  writeCas,
} from "./files.js";

const ID = "clawtrate-memory";
const AGENT = /^[a-z0-9_][a-z0-9_-]{0,63}$/i;
const MAX_LIST = 256;
const MAX_ROOTS = 32;
const MAX_AGENTS = 32;
const MAX_SAVERS = 512;
const MAX_PENDING_WRITES = 64;
const ROOT_FILE = "MEMORY.md";
const MARK = "<!-- clawtrate-memory:";
const FACTS = { loadedIntoNewTasks: false, searchable: "unconfirmed" };
const sourceIdFor = (sharedRoot, path) => sha256(`${sharedRoot}\0${path}`);

function fields(value, allowed) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    throw new Refusal("Unexpected parameters");
  }
}

function expected(value) {
  if (value !== null && (typeof value !== "string" || !HASH.test(value))) {
    throw new Refusal("Expected a SHA-256 hash or null for a missing file");
  }
  return value;
}

function text(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_BYTES || !value.isWellFormed()) {
    throw new Refusal("Content must be UTF-8 text of at most 256 KiB");
  }
  return value;
}

function rootBudget(config, agent) {
  const limit = agent?.bootstrapMaxChars ?? config.agents?.defaults?.bootstrapMaxChars;
  return limit > 0 ? Math.floor(limit) : 20_000;
}

function copyContents(content, sourceId, item, uncopy, limit) {
  const start = `\n\n${MARK}${sourceId}:start -->\n`;
  const end = `\n${MARK}${sourceId}:end -->\n`;
  const index = content.indexOf(start);
  const endIndex = content.indexOf(end);
  const mentions = content.split(`${MARK}${sourceId}`).length - 1;
  if (uncopy) {
    if (
      mentions !== 2 ||
      index < 0 ||
      endIndex < index + start.length ||
      content.slice(index + start.length, endIndex).includes(MARK)
    ) {
      throw new Refusal("There is no intact, unique copy with this source id");
    }
    return content.slice(0, index) + content.slice(endIndex + end.length);
  }
  if (mentions) throw new Refusal("Root memory already contains a mark for this item");
  if (item.includes(MARK)) throw new Refusal("The shared item contains a copy marker");
  const next = content + start + item + end;
  if (next.length > limit) throw new Refusal("The copy would exceed the root memory budget");
  return text(next);
}

export function registerMemory(api, sdk) {
  const writes = new Map();
  let pendingWrites = 0;
  let service;
  let saverStore;

  const savers = () =>
    (saverStore ??= api.runtime.state.openKeyedStore({
      namespace: "savers",
      maxEntries: MAX_SAVERS,
    }));

  function remember(key, metadata) {
    return savers().register(key, { ...metadata, at: Date.now() });
  }

  function changed() {
    service?.gatewayEvents?.emit("changed", {}, { scope: "operator.read" });
  }

  // Canonical folder keys serialize aliases and share the lock with root copies.
  async function exclusive(key, action) {
    const previous = writes.get(key);
    const running = Promise.resolve(previous)
      .catch(() => {})
      .then(action);
    writes.set(key, running);
    try {
      return await running;
    } finally {
      if (writes.get(key) === running) writes.delete(key);
    }
  }

  async function workspace(config, agentId) {
    const configured = api.runtime.agent.resolveAgentWorkspaceDir(config, agentId);
    // Declared but offline bridges throw from the SDK. Keep that refusal.
    if (sdk.getAgentWorkspaceAccess(configured))
      throw new Refusal("Device workspace is unsupported");
    const canonical = await sdk.canonicalPathFromExistingAncestor(configured);
    const assertLocal = () => {
      if (
        sdk.getAgentWorkspaceAccess(configured) ||
        (canonical !== configured && sdk.getAgentWorkspaceAccess(canonical))
      ) {
        throw new Refusal("Device workspace is unsupported");
      }
    };
    assertLocal();
    const fs = await sdk.root(canonical, rootOptions);
    if (fs.rootReal !== canonical) throw new Refusal("Workspace changed");
    return { fs, assertLocal };
  }

  async function inventory(config, visible, state) {
    const ids = sdk.listAgentIds(config);
    if (ids.length > MAX_AGENTS) throw new Refusal("Too many agents to inspect shared folders");
    const locations = ids.map((id) => api.runtime.agent.resolveAgentWorkspaceDir(config, id));
    const candidates = new Map();
    for (const [index, id] of ids.entries()) {
      const override = sdk.resolveAgentConfig(config, id)?.memory?.search;
      const defaults = config.memory?.search;
      const paths = [...(defaults?.extraPaths ?? []), ...(override?.extraPaths ?? [])];
      if (paths.length > MAX_ROOTS) throw new Refusal("Too many configured shared folders");
      for (const entry of paths) {
        const name = (typeof entry === "string" ? entry : entry.path).trim();
        if (!name || name.length > MAX_PATH || name.includes("\0")) continue;
        const location = resolve(
          locations[index],
          /^~(?:$|[\\/])/.test(name) ? resolve(homedir(), name.slice(2)) : name,
        );
        if (!candidates.has(location)) candidates.set(location, { rules: [], agents: new Set() });
        const folder = candidates.get(location);
        folder.rules.push(
          typeof entry === "string" ? "" : (entry.pattern?.trim().replaceAll("\\", "/") ?? ""),
        );
        if ((override?.enabled ?? defaults?.enabled) !== false) folder.agents.add(id);
      }
    }
    if (candidates.size > MAX_ROOTS) throw new Refusal("Too many configured shared folders");
    // Workspace-wide shared notes have no session-level visibility rule.
    if (ids.some((id) => !visible.has(id)))
      throw new Refusal("Shared folders need access to all bots");
    const workspaces = await Promise.all(
      locations.map((location) => sdk.canonicalPathFromExistingAncestor(location)),
    );
    const folders = new Map();
    for (const [location, candidate] of candidates) {
      try {
        const path = await sharedDirectory(state, location);
        if (workspaces.some((dir) => dir === path || inside(dir, path) || inside(path, dir))) {
          throw new Refusal("A shared folder overlaps a bot workspace");
        }
        const existing = folders.get(path);
        if (existing) {
          existing.rules.push(...candidate.rules);
          for (const id of candidate.agents) existing.agents.add(id);
        } else {
          folders.set(path, { ...candidate, path, sharedRoot: sha256(path) });
        }
      } catch (error) {
        if (!(error instanceof Refusal) && !missing(error)) throw error;
      }
    }
    return [...folders.values()];
  }

  async function folderFor(params, call) {
    if (params.sharedRoot !== undefined) {
      if (
        params.agentId !== undefined ||
        typeof params.sharedRoot !== "string" ||
        !HASH.test(params.sharedRoot)
      ) {
        throw new Refusal("Select one configured shared folder");
      }
      const folder = (await inventory(call.config, call.visible, call.state)).find(
        ({ sharedRoot }) => sharedRoot === params.sharedRoot,
      );
      if (!folder) throw new Refusal("Shared folder is unavailable");
      const fs = await sdk.root(folder.path, rootOptions);
      if (fs.rootReal !== folder.path) throw new Refusal("Shared folder changed");
      return { fs, shared: true, sharedRoot: folder.sharedRoot, rules: folder.rules };
    }
    const id = allowedAgent(params.agentId, call);
    const local = await workspace(call.config, id);
    const nested = (
      await Promise.all(
        sdk
          .listAgentIds(call.config)
          .filter((other) => other !== id)
          .map((other) =>
            sdk.canonicalPathFromExistingAncestor(
              api.runtime.agent.resolveAgentWorkspaceDir(call.config, other),
            ),
          ),
      )
    ).filter((dir) => inside(local.fs.rootReal, dir));
    return { ...local, shared: false, nested };
  }

  function allowedAgent(agentId, call) {
    if (
      typeof agentId !== "string" ||
      !call.visible.has(agentId) ||
      !sdk.listAgentIds(call.config).includes(agentId)
    ) {
      throw new Refusal("Unknown or inaccessible bot");
    }
    return agentId;
  }

  function allowedPath(folder, path) {
    if (!notePath(path, folder.shared)) return false;
    if (folder.shared) return folder.rules.some((rule) => !rule || posix.matchesGlob(path, rule));
    const target = resolve(folder.fs.rootReal, path);
    return !folder.nested.some((dir) => dir === target || inside(dir, target));
  }

  function selectedPath(folder, path, realPath) {
    const canonical = relative(folder.fs.rootReal, realPath).split(sep).join("/");
    if (!allowedPath(folder, canonical))
      throw new Refusal("Path is outside the configured memory selection");
    if (folder.shared && canonical !== path) throw new Refusal("Use the shared item's exact path");
    return canonical;
  }

  function saverKey(fs, path) {
    return sha256(resolve(fs.rootReal, path));
  }

  function stored(folder, path, file) {
    return {
      path,
      hash: file.hash,
      size: file.stat.size,
      modifiedAt: file.stat.mtimeMs,
      ...FACTS,
      ...(folder.shared ? { sourceId: sourceIdFor(folder.sharedRoot, path) } : {}),
    };
  }

  async function list(params, call) {
    fields(params, ["agentId", "sharedRoot"]);
    if (params.agentId === undefined && params.sharedRoot === undefined) {
      const folders = await inventory(call.config, call.visible, call.state);
      return {
        folders: folders.map(({ sharedRoot, path, agents }) => ({
          sharedRoot,
          path,
          searchConfiguredFor: [...agents],
        })),
      };
    }
    let folder;
    try {
      folder = await folderFor(params, call);
    } catch (error) {
      if (params.sharedRoot === undefined && missing(error)) return { files: [], truncated: false };
      throw error;
    }
    const files = [];
    let truncated = false;
    if (folder.nested?.includes(resolve(folder.fs.rootReal, "memory"))) {
      return { files, truncated };
    }
    try {
      if (!folder.shared && !(await lstat(resolve(folder.fs.rootReal, "memory"))).isDirectory()) {
        throw new Refusal("The notes folder must be a real directory");
      }
      for await (const entry of folder.fs.walk(folder.shared ? "." : "memory", {
        order: "filesystem",
        symlinkPolicy: "skip",
        maxDepth: MAX_DEPTH,
        maxEntries: 2048,
        limitBehavior: "truncate",
        entryFilter: ({ kind, relativePath }) =>
          kind === "directory" && folder.nested?.includes(resolve(folder.fs.rootReal, relativePath))
            ? "skip-subtree"
            : "include",
      })) {
        if (entry.kind === "truncated") truncated = true;
        if (entry.kind !== "file") continue;
        const path = entry.relativePath.split(sep).join("/");
        if (!allowedPath(folder, path)) continue;
        if (files.length >= MAX_LIST) {
          truncated = true;
          break;
        }
        try {
          const file = await read(folder.fs, path);
          if (file.hash !== null) {
            files.push(stored(folder, selectedPath(folder, path, file.realPath), file));
          }
        } catch (error) {
          if (
            !(error instanceof Refusal) &&
            !["hardlink", "symlink", "too-large", "not-file"].includes(error.code)
          )
            throw error;
          truncated = true;
        }
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
    folder.assertLocal?.();
    return {
      files: files.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path)),
      truncated,
    };
  }

  async function note(method, params, call) {
    fields(params, [
      "agentId",
      "sharedRoot",
      "path",
      ...(method === "read" ? [] : ["expectedHash"]),
      ...(method === "write" ? ["content"] : []),
    ]);
    if (!notePath(params.path, params.sharedRoot !== undefined))
      throw new Refusal("Expected a relative Markdown note path");
    const hash = method === "read" ? undefined : expected(params.expectedHash);
    const content = method === "write" ? text(params.content) : undefined;
    const folder = await folderFor(params, call);
    const { fs } = folder;
    const { path } = params;
    if (!allowedPath(folder, path))
      throw new Refusal("Path is outside the configured memory selection");
    if (method === "read") {
      const file = await read(fs, path);
      if (file.hash === null) throw new Refusal("Note does not exist");
      const data = stored(folder, selectedPath(folder, path, file.realPath), file);
      folder.assertLocal?.();
      return { ...data, content: file.content };
    }
    return exclusive(fs.rootReal, async () => {
      call.assertCurrent();
      requireNativeMutations();
      const file = await read(fs, path);
      selectedPath(
        folder,
        path,
        file.realPath ?? (await sdk.canonicalPathFromExistingAncestor(resolve(fs.rootReal, path))),
      );
      requireHash(file, hash);
      const assertCurrent = () => {
        call.assertCurrent();
        folder.assertLocal?.();
      };
      const key = saverKey(fs, path);
      try {
        if (method === "delete") {
          if (file.hash === null) throw new Refusal("Note does not exist");
          await applyCas(fs, path, file, assertCurrent, (guard) =>
            fs.remove(path, { assertBeforeMutation: guard, force: false }),
          );
          await savers()
            .delete(key)
            .catch(() => {});
          changed();
          return { deleted: true };
        }
        await writeCas(fs, path, file, assertCurrent, content, true);
      } catch (error) {
        if (error.details?.unknown) changed();
        throw error;
      }
      const newHash = sha256(content);
      // Root writes return no publication identity to attach to saver metadata.
      await remember(key, { ...call.saver, hash: newHash }).catch(() => {});
      changed();
      return { hash: newHash };
    });
  }

  // Only copies may change the root file. OpenClaw's own writers don't share this lock.
  async function writeRoot(agentId, expectedHash, change, call) {
    const { fs, assertLocal } = await workspace(call.config, agentId);
    return exclusive(fs.rootReal, async () => {
      call.assertCurrent();
      requireNativeMutations();
      const name = basename(
        await sdk.canonicalPathFromExistingAncestor(resolve(fs.rootReal, ROOT_FILE)),
      );
      if (name !== ROOT_FILE && name.toLowerCase() === ROOT_FILE.toLowerCase())
        throw new Refusal("Rename the root memory file to MEMORY.md before copying or uncopying");
      const file = await read(fs, ROOT_FILE);
      if (file.realPath && basename(file.realPath) !== ROOT_FILE)
        throw new Refusal("Rename the root memory file to MEMORY.md before copying or uncopying");
      requireHash(file, expectedHash);
      const content = change(file.content ?? "");
      try {
        await writeCas(
          fs,
          ROOT_FILE,
          file,
          () => {
            call.assertCurrent();
            assertLocal();
          },
          content,
          false,
        );
      } catch (error) {
        if (error.details?.unknown) {
          changed();
          return { unknown: true };
        }
        throw error;
      }
      const hash = sha256(content);
      await remember(saverKey(fs, ROOT_FILE), { ...call.saver, hash }).catch(() => {});
      changed();
      return { hash };
    });
  }

  async function copies(method, params, call) {
    fields(params, ["item", "agents", "expectedHashes"]);
    fields(params.item, ["sharedRoot", "path"]);
    if (params.item.sharedRoot === undefined || !notePath(params.item.path, true)) {
      throw new Refusal("Expected a shared Markdown item");
    }
    if (
      !Array.isArray(params.agents) ||
      !params.agents.length ||
      params.agents.length > MAX_AGENTS ||
      new Set(params.agents).size !== params.agents.length
    ) {
      throw new Refusal("Choose between 1 and 32 distinct bots");
    }
    for (const id of params.agents) allowedAgent(id, call);
    fields(params.expectedHashes, params.agents);
    for (const id of params.agents)
      expected(Object.hasOwn(params.expectedHashes, id) ? params.expectedHashes[id] : undefined);
    const { sharedRoot, path } = params.item;
    const folder = await folderFor({ sharedRoot }, call);
    if (!allowedPath(folder, path))
      throw new Refusal("Path is outside the configured memory selection");
    const uncopy = method === "uncopy";
    const item = uncopy ? undefined : await read(folder.fs, path);
    if (item?.hash === null) throw new Refusal("Shared item does not exist");
    const canonical = selectedPath(
      folder,
      path,
      item?.realPath ??
        (await sdk.canonicalPathFromExistingAncestor(resolve(folder.fs.rootReal, path))),
    );
    const sourceId = sourceIdFor(sharedRoot, canonical);
    const results = [];
    for (const agentId of params.agents) {
      try {
        call.assertCurrent();
        const result = await writeRoot(
          agentId,
          params.expectedHashes[agentId],
          (content) =>
            copyContents(
              content,
              sourceId,
              item?.content,
              uncopy,
              rootBudget(call.config, sdk.resolveAgentConfig(call.config, agentId)),
            ),
          call,
        );
        results.push({
          agentId,
          ...(result.unknown
            ? result
            : {
                [uncopy ? "uncopied" : "copied"]: true,
                ...result,
              }),
        });
      } catch (error) {
        results.push({
          agentId,
          refused: true,
          reason: error instanceof Refusal ? error.message : "Root memory is unavailable",
          ...(error instanceof Refusal ? error.details : {}),
        });
      }
    }
    return { sourceId, results };
  }

  async function visibleAgents() {
    const roster = await sdk.dispatchGatewayMethod("agents.list", {});
    if (!roster.ok || !Array.isArray(roster.payload?.agents))
      throw new Refusal("Bot access could not be verified");
    return new Set(
      roster.payload.agents.filter(({ kind }) => kind !== "system").map(({ id }) => id),
    );
  }

  for (const method of ["list", "read", "write", "delete", "copy", "uncopy"]) {
    api.registerGatewayMethod(
      `${ID}.${method}`,
      async (opts) => {
        const { params, respond, context, client } = opts;
        try {
          if (!service || !client || client.connect.role !== "operator")
            throw new Refusal("Memory access needs an operator connection");
          const active = service;
          const config = context.getRuntimeConfig();
          const assertAuthority = () => {
            if (
              service !== active ||
              client.invalidated ||
              client.connectionSignal?.aborted ||
              opts.signal?.aborted ||
              opts.hasCurrentClientAuthority?.() === false
            )
              throw new Refusal("Gateway access or configuration changed");
          };
          const assertCurrent = () => {
            assertAuthority();
            if (context.getRuntimeConfig() !== config)
              throw new Refusal("Gateway access or configuration changed");
          };
          const visible = await visibleAgents();
          assertCurrent();
          const actor = client.authenticatedUserProfile?.profileId ?? client.pairedClientId;
          const saver =
            typeof actor === "string" && actor.length <= 128
              ? { kind: "operator", id: actor }
              : { kind: "operator" };
          const call = { config, visible, state: active.stateDir, saver, assertCurrent };
          const mutation = method !== "list" && method !== "read";
          const batch = method === "copy" || method === "uncopy";
          if (mutation && pendingWrites >= MAX_PENDING_WRITES)
            throw new Refusal("Too many pending memory writes");
          if (mutation) pendingWrites += 1;
          let data;
          try {
            data =
              method === "list"
                ? await list(params, call)
                : batch
                  ? await copies(method, params, call)
                  : await note(method, params, call);
          } finally {
            if (mutation) pendingWrites -= 1;
          }
          if (batch) {
            try {
              assertAuthority();
              const latest = context.getRuntimeConfig();
              if (latest !== config) {
                const access = await visibleAgents();
                const updated = { ...call, config: latest, visible: access };
                for (const [index, id] of params.agents.entries()) {
                  allowedAgent(id, updated);
                  const result = data.results[index];
                  if (
                    (result.hash || Object.hasOwn(result, "currentHash")) &&
                    api.runtime.agent.resolveAgentWorkspaceDir(config, id) !==
                      api.runtime.agent.resolveAgentWorkspaceDir(latest, id)
                  ) {
                    data.results[index] = {
                      agentId: id,
                      ...(result.refused ? { refused: true } : { unknown: true }),
                      reason: "The bot's workspace changed. Read its root memory before retrying",
                    };
                  }
                }
                const folder = await folderFor({ sharedRoot: params.item.sharedRoot }, updated);
                if (!allowedPath(folder, params.item.path) || context.getRuntimeConfig() !== latest)
                  throw new Refusal("Gateway access or configuration changed");
                assertAuthority();
              }
            } catch {
              throw new Refusal(
                "Copy results are unavailable. Check the root memory markers once access is restored",
                { unknown: true },
              );
            }
          } else {
            try {
              assertCurrent();
            } catch (error) {
              if (!mutation) throw error;
              throw new Refusal(
                "Memory may have changed. When access is restored, read the note again before retrying",
                { unknown: true },
              );
            }
          }
          respond(true, data);
        } catch (error) {
          respond(false, undefined, {
            code: error instanceof Refusal ? "INVALID_REQUEST" : "UNAVAILABLE",
            message:
              error instanceof Refusal ? error.message : "Memory file is unavailable or unsafe",
            ...(error.details && error instanceof Refusal ? { details: error.details } : {}),
          });
        }
      },
      { scope: method === "list" || method === "read" ? "operator.read" : "operator.admin" },
    );
  }

  api.on(
    "after_tool_call",
    async (event, ctx) => {
      const { agentId, sessionKey } = ctx;
      const { toolName, params, result, error } = event;
      const path = params?.path;
      if (
        error !== undefined ||
        result?.isError ||
        result?.details?.changed !== true ||
        typeof agentId !== "string" ||
        !AGENT.test(agentId) ||
        typeof sessionKey !== "string" ||
        !sessionKey ||
        sessionKey.length > 256 ||
        !(path === ROOT_FILE || path === "USER.md" || notePath(path, false))
      )
        return;
      const receipt = result.content?.[0]?.text;
      const confirmed =
        typeof receipt === "string" &&
        (toolName === "write"
          ? /^Successfully wrote [0-9]+ bytes to /.test(receipt)
          : toolName === "edit" && /^Successfully replaced [0-9]+ block\(s\) in /.test(receipt));
      if (!confirmed) return;
      // The hook gives an argument and a result, with no canonical target or revision.
      await remember(sha256(`${agentId}\0${path}`), { kind: "bot", agentId, sessionKey, path });
    },
    { matcher: ["write", "edit"] },
  );

  api.registerService({
    id: ID,
    start(ctx) {
      service = ctx;
    },
    stop() {
      service = undefined;
    },
  });
}
