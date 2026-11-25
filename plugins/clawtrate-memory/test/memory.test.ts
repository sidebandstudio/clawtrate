import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_BYTES, applyCas, read, rootOptions, sha256, writeCas } from "../lib/files.js";
import { registerMemory } from "../lib/memory.js";

type Params = Record<string, unknown>;
type Handler = (options: {
  params: Params;
  client: { connect: { role: string }; pairedClientId: string };
  context: { getRuntimeConfig: () => object };
  respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
}) => Promise<void>;
type Change = { name: string; payload: unknown; options: unknown };
type Reply = { ok: boolean; payload?: unknown; error?: unknown };
type Hook = (event: Params, context: Params) => Promise<void>;

let directory: string;
let fs: Pick<Parameters<typeof registerMemory>[1], "root" | "canonicalPathFromExistingAncestor">;
let agents: Pick<Parameters<typeof registerMemory>[1], "listAgentIds" | "resolveAgentConfig">;

beforeAll(async () => {
  // The OpenClaw package set aside for the tests. Never a global one: on a computer that runs its
  // own gateway, that is the person's own OpenClaw (#597).
  const packageDir = process.env.OPENCLAW_PACKAGE_DIR ?? "";
  if (!packageDir || !existsSync(join(packageDir, "package.json")))
    throw new Error(
      `OpenClaw is not installed at ${packageDir || "OPENCLAW_PACKAGE_DIR"}; the memory plugin's tests need it. Set OPENCLAW_PACKAGE_DIR.`,
    );
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  expect(manifest.version).toBe("2026.10.6");
  fs = await import(pathToFileURL(join(packageDir, "dist/plugin-sdk/file-access-runtime.js")).href);
  agents = await import(
    pathToFileURL(join(packageDir, "dist/plugin-sdk/agent-scope-runtime.js")).href
  );
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "clawtrate-memory-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function setup({
  visible = ["main", "other"],
  extraPaths,
  bridge,
  otherPath = "other",
  entries = { main: {}, other: { bootstrapMaxChars: 160 } },
  root = (...args: Parameters<typeof fs.root>) => fs.root(...args),
  stateDir = directory,
  failSaver = false,
}: {
  visible?: string[];
  extraPaths?: unknown[];
  bridge?: () => unknown;
  otherPath?: string;
  entries?: Record<string, object>;
  root?: typeof fs.root;
  stateDir?: string;
  failSaver?: boolean;
} = {}) {
  const workspace = join(directory, "workspace");
  const other = join(directory, otherPath);
  const shared = join(directory, "shared");
  for (const folder of [workspace, other, shared]) mkdirSync(folder, { recursive: true });
  const methods = new Map<string, { handler: Handler; scope: string }>();
  const events: Change[] = [];
  const warn = vi.fn();
  let config = {
    agents: { entries },
    memory: { search: { enabled: true, extraPaths: extraPaths ?? [shared] } },
  };
  let hook: Hook = async () => {};
  const savers = new Map<string, object>();
  registerMemory(
    {
      logger: { warn },
      runtime: {
        state: {
          openKeyedStore: ({
            namespace,
            maxEntries,
          }: {
            namespace: string;
            maxEntries: number;
          }) => {
            expect(namespace).toBe("savers");
            expect(maxEntries).toBe(512);
            return {
              register: async (key: string, value: object) => {
                if (failSaver) throw new Error("Saver store unavailable");
                savers.delete(key);
                savers.set(key, value);
                if (savers.size > maxEntries) savers.delete(savers.keys().next().value!);
              },
              delete: async (key: string) => savers.delete(key),
            };
          },
        },
        agent: {
          resolveAgentWorkspaceDir: (
            config: { agents: { entries: Record<string, { workspace?: string }> } },
            id: string,
          ) => config.agents.entries[id]?.workspace ?? (id === "main" ? workspace : other),
        },
      },
      registerGatewayMethod: (method: string, handler: Handler, options: { scope: string }) => {
        methods.set(method, { handler, scope: options.scope });
      },
      on: (_event: string, observe: Hook) => {
        hook = observe;
      },
      registerService: (service: { start: (ctx: object) => void }) =>
        service.start({
          stateDir,
          gatewayEvents: {
            emit: (name: string, payload: unknown, options: unknown) =>
              events.push({ name, payload, options }),
          },
        }),
    },
    {
      getAgentWorkspaceAccess: bridge ?? (() => undefined),
      ...fs,
      ...agents,
      root,
      dispatchGatewayMethod: () => ({
        ok: true,
        payload: { agents: visible.map((id) => ({ id })) },
      }),
    },
  );
  async function call(method: string, params: Params): Promise<Reply> {
    let response: Reply | undefined;
    await methods.get(`clawtrate-memory.${method}`)!.handler({
      params,
      client: { connect: { role: "operator" }, pairedClientId: "test-device" },
      context: { getRuntimeConfig: () => config },
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
      },
    });
    return response!;
  }
  return {
    workspace,
    other,
    shared,
    methods,
    events,
    hook,
    savers,
    warn,
    call,
    reload: (entries = config.agents.entries) => {
      config = { ...config, agents: { entries } };
    },
  };
}

const note = { agentId: "main", path: "memory/nested/note.md" };
const initial = { ...note, content: "first", expectedHash: null };

describe("memory paths", () => {
  beforeEach(() => vi.stubEnv("FS_SAFE_NATIVE_MODE", "require"));

  it.each([
    "MEMORY.md",
    "USER.md",
    "memory",
    "memory/notes.txt",
    "/memory/note.md",
    "C:/memory/note.md",
    "memory/../note.md",
    "memory/child/../../note.md",
    "memory/nul\0.md",
    "memory/../memory/note.md",
    "memory\\nested\\note.md",
    "memory/./note.md",
    "memory//note.md",
    "memory/note.md/.",
  ])("refuses %j", async (path) => {
    const { call, workspace } = setup();
    expect((await call("write", { ...initial, path })).ok).toBe(false);
    expect(readdirSync(workspace)).toEqual([]);
  });

  it("refuses a linked file, linked ancestor, linked notes folder and a hard link", async () => {
    const { call, workspace, shared } = setup();
    const outside = join(shared, "outside.md");
    writeFileSync(outside, "outside");
    mkdirSync(join(workspace, "memory"));
    symlinkSync(shared, join(workspace, "memory", "nested"), "dir");
    symlinkSync(outside, join(workspace, "memory", "linked.md"));
    linkSync(outside, join(workspace, "memory", "hard.md"));
    for (const path of ["memory/nested/new.md", "memory/linked.md", "memory/hard.md"]) {
      expect((await call("write", { ...initial, path })).ok).toBe(false);
      expect((await call("read", { ...note, path })).ok).toBe(false);
      expect((await call("delete", { ...note, path, expectedHash: sha256("outside") })).ok).toBe(
        false,
      );
    }
    expect(readdirSync(shared)).toEqual(["outside.md"]);
    expect(readFileSync(outside, "utf8")).toBe("outside");
    writeFileSync(join(shared, "another.md"), "also outside");
    rmSync(join(workspace, "memory"), { recursive: true });
    symlinkSync(shared, join(workspace, "memory"), "dir");
    expect((await call("write", initial)).ok).toBe(false);
    expect(await call("list", { agentId: "main" })).toMatchObject({
      ok: false,
      payload: undefined,
      error: { message: "The notes folder must be a real directory" },
    });
  });

  it("refuses a linked shared root, an external root, and an overlapping workspace", async () => {
    const alias = join(directory, "alias");
    const outside = tmpdir();
    const { call, shared, workspace } = setup({
      extraPaths: [alias, outside, join(directory, "workspace")],
    });
    symlinkSync(shared, alias, "dir");
    expect(await call("list", {})).toMatchObject({ ok: true, payload: { folders: [] } });
    for (const path of [alias, outside, workspace]) {
      expect(
        (
          await call("write", {
            sharedRoot: sha256(path),
            path: "note.md",
            expectedHash: null,
            content: "ignored",
          })
        ).ok,
      ).toBe(false);
    }
  });

  it("checks the caller's bot access and refuses bridged workspaces", async () => {
    const { call } = setup({ visible: ["main"], bridge: () => ({}) });
    expect((await call("list", { agentId: "main" })).error).toMatchObject({
      message: "Device workspace is unsupported",
    });
    for (const agentId of ["missing", "other", 2, null]) {
      expect((await call("list", { agentId })).error).toMatchObject({
        message: "Unknown or inaccessible bot",
      });
    }
    expect((await call("list", {})).ok).toBe(false);
  });

  it("hides a nested workspace from readers of the parent bot", async () => {
    const { call, workspace, other } = setup({
      visible: ["main"],
      otherPath: "workspace/memory/other",
    });
    writeFileSync(join(other, "MEMORY.md"), "private");
    writeFileSync(join(workspace, "memory/public.md"), "public");
    expect(await call("list", { agentId: "main" })).toMatchObject({
      ok: true,
      payload: { files: [{ path: "memory/public.md" }] },
    });
    const nested = { ...note, path: "memory/other/MEMORY.md" };
    expect((await call("read", nested)).ok).toBe(false);
    expect(
      (await call("write", { ...nested, content: "edit", expectedHash: sha256("private") })).ok,
    ).toBe(false);
    expect((await call("delete", { ...nested, expectedHash: sha256("private") })).ok).toBe(false);
  });

  it("uses a keyed bot's per-agent shared memory paths", async () => {
    const path = join(directory, "shared");
    const { call } = setup({
      entries: { main: {}, other: { memory: { search: { extraPaths: [path] } } } },
      extraPaths: [],
    });
    expect(await call("list", {})).toMatchObject({
      ok: true,
      payload: { folders: [{ searchConfiguredFor: ["other"] }] },
    });
  });

  it("combines patterns and bot IDs for both spellings of a shared folder", async () => {
    const stateDir = join(directory, "state-alias");
    symlinkSync(directory, stateDir, "dir");
    const canonical = await fs.canonicalPathFromExistingAncestor(directory);
    const { call, shared } = setup({
      stateDir,
      entries: {
        main: {
          memory: { search: { extraPaths: [{ path: join(stateDir, "shared"), pattern: "a.md" }] } },
        },
        other: {
          memory: {
            search: { extraPaths: [{ path: join(canonical, "shared"), pattern: "b.md" }] },
          },
        },
      },
      extraPaths: [],
    });
    const sharedRoot = sha256(join(canonical, "shared"));
    expect(await call("list", {})).toMatchObject({
      ok: true,
      payload: { folders: [{ sharedRoot, searchConfiguredFor: ["main", "other"] }] },
    });
    for (const path of ["a.md", "b.md"]) {
      writeFileSync(join(shared, path), path);
      expect(await call("read", { sharedRoot, path })).toMatchObject({
        ok: true,
        payload: { content: path },
      });
    }
  });

  it("accepts a configured underscore bot and records its tool receipts", async () => {
    const { call, hook, savers } = setup({ entries: { main: {}, _ops: {} }, visible: ["_ops"] });
    expect(await call("list", { agentId: "_ops" })).toMatchObject({ ok: true });
    await hook(
      {
        toolName: "write",
        params: { path: note.path },
        result: {
          content: [{ text: `Successfully wrote 5 bytes to ${note.path}` }],
          details: { changed: true },
        },
      },
      { agentId: "_ops", sessionKey: "agent:_ops:script" },
    );
    expect([...savers.values()]).toMatchObject([{ agentId: "_ops" }]);
  });

  it("streams wide directories before applying the listing budget", async () => {
    const { call, shared } = setup();
    const sharedRoot = sha256(await fs.canonicalPathFromExistingAncestor(shared));
    for (let i = 0; i < 2060; i += 1) writeFileSync(join(shared, `${i}.txt`), "");
    const streaming = vi.spyOn(fsPromises, "opendir");
    const buffered = vi.spyOn(fsPromises, "readdir");
    expect(await call("list", { sharedRoot })).toMatchObject({
      ok: true,
      payload: { files: [], truncated: true },
    });
    expect(streaming).toHaveBeenCalled();
    expect(buffered).not.toHaveBeenCalled();
  });
});

it.each(["off", "auto"])(
  "refuses all mutations in SDK mode %s and keeps reads available",
  async (mode) => {
    vi.stubEnv("FS_SAFE_NATIVE_MODE", mode);
    const { call, workspace, shared } = setup();
    mkdirSync(join(workspace, "memory/nested"), { recursive: true });
    writeFileSync(join(workspace, note.path), "first");
    writeFileSync(join(shared, "sample.md"), "source");
    const sharedRoot = sha256(await fs.canonicalPathFromExistingAncestor(shared));
    const failure = {
      message: "Memory changes require FS_SAFE_NATIVE_MODE=require on the gateway",
    };
    expect(await call("read", note)).toMatchObject({ ok: true });
    expect(await call("write", { ...initial, expectedHash: sha256("first") })).toMatchObject({
      ok: false,
      error: failure,
    });
    expect(await call("delete", { ...note, expectedHash: sha256("first") })).toMatchObject({
      ok: false,
      error: failure,
    });
    for (const method of ["copy", "uncopy"]) {
      expect(
        await call(method, {
          item: { sharedRoot, path: "sample.md" },
          agents: ["main"],
          expectedHashes: { main: null },
        }),
      ).toMatchObject({
        ok: true,
        payload: { results: [{ refused: true, reason: failure.message }] },
      });
    }
    expect(readFileSync(join(workspace, note.path), "utf8")).toBe("first");
  },
);

it("stages complete new notes and root files on the POSIX SDK fallback", async () => {
  vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
  const { workspace } = setup();
  const root = await fs.root(workspace, rootOptions);
  for (const path of [note.path, "MEMORY.md"]) {
    await expect(
      writeCas(root, path, { hash: null }, () => {}, "complete", true),
    ).resolves.toBeUndefined();
    expect(readFileSync(join(workspace, path), "utf8")).toBe("complete");
  }
});

describe("memory changes", () => {
  beforeEach(() => vi.stubEnv("FS_SAFE_NATIVE_MODE", "require"));

  it("creates, reads, lists, updates and deletes a literal shared tilde path", async () => {
    const { call, shared } = setup();
    const sharedRoot = sha256(await fs.canonicalPathFromExistingAncestor(shared));
    const note = { sharedRoot, path: "~/note.md" };
    const firstHash = sha256("first");
    writeFileSync(join(shared, "other.md"), "other");
    expect(await call("write", { ...note, content: "first", expectedHash: null })).toMatchObject({
      ok: true,
      payload: { hash: firstHash },
    });
    expect(readFileSync(join(shared, note.path), "utf8")).toBe("first");
    expect(await call("read", note)).toMatchObject({
      ok: true,
      payload: { path: note.path, content: "first" },
    });
    expect(await call("list", { sharedRoot })).toMatchObject({
      ok: true,
      payload: {
        files: expect.arrayContaining([
          expect.objectContaining({ path: note.path }),
          expect.objectContaining({ path: "other.md" }),
        ]),
        truncated: false,
      },
    });
    const secondHash = sha256("second");
    expect(
      await call("write", { ...note, content: "second", expectedHash: firstHash }),
    ).toMatchObject({
      ok: true,
      payload: { hash: secondHash },
    });
    expect(await call("delete", { ...note, expectedHash: secondHash })).toMatchObject({
      ok: true,
      payload: { deleted: true },
    });
    expect(readdirSync(join(shared, "~"))).toEqual([]);
  });

  it("keeps committed note and root writes successful when saver registration fails", async () => {
    const { call, workspace, shared, events, warn } = setup({ failSaver: true });
    expect(await call("write", initial)).toMatchObject({
      ok: true,
      payload: { hash: sha256(initial.content) },
    });
    writeFileSync(join(shared, "sample.md"), "source");
    const sharedRoot = sha256(await fs.canonicalPathFromExistingAncestor(shared));
    const copy = await call("copy", {
      item: { sharedRoot, path: "sample.md" },
      agents: ["main"],
      expectedHashes: { main: null },
    });
    expect(copy).toMatchObject({ ok: true, payload: { results: [{ copied: true }] } });
    expect(readFileSync(join(workspace, note.path), "utf8")).toBe(initial.content);
    expect(readFileSync(join(workspace, "MEMORY.md"), "utf8")).toContain("source");
    expect(events).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "returns only current-workspace note conflict hashes (workspace moved=%s)",
    async (moved) => {
      let onRead = () => {};
      const { call, workspace, other, reload } = setup({
        root: async (...args: Parameters<typeof fs.root>) => {
          const root = await fs.root(...args);
          const read = root.read.bind(root);
          root.read = async (path: string) => {
            const file = await read(path);
            onRead();
            return file;
          };
          return root;
        },
      });
      onRead = () => reload({ main: moved ? { workspace: other } : {}, other: {} });
      mkdirSync(join(workspace, "memory/nested"), { recursive: true });
      writeFileSync(join(workspace, note.path), "first");
      const reply = await call("write", { ...initial, content: "second" });
      if (moved) {
        expect(reply).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining("workspace changed. Read the note again") },
        });
        expect(reply.error).not.toHaveProperty("details.currentHash");
      } else {
        expect(reply).toMatchObject({
          ok: false,
          error: { details: { currentHash: sha256("first") } },
        });
      }
      expect(readFileSync(join(workspace, note.path), "utf8")).toBe("first");
    },
  );

  it("writes atomically and reports only a stored revision, plus metadata and an empty event", async () => {
    const { call, workspace, savers, events } = setup();
    expect(await call("write", initial)).toMatchObject({
      ok: true,
      payload: { hash: sha256("first") },
    });
    const target = join(workspace, note.path);
    const before = statSync(target).ino;
    expect(
      (await call("write", { ...initial, content: "second", expectedHash: sha256("first") })).ok,
    ).toBe(true);
    expect(statSync(target).ino).not.toBe(before);
    expect(readdirSync(join(workspace, "memory/nested"))).toEqual(["note.md"]);
    expect(await call("read", note)).toMatchObject({
      ok: true,
      payload: {
        content: "second",
        hash: sha256("second"),
        loadedIntoNewTasks: false,
        searchable: "unconfirmed",
      },
    });
    expect([...savers.values()]).toMatchObject([
      { kind: "operator", id: "test-device", hash: sha256("second") },
    ]);
    expect(JSON.stringify([...savers.values()])).not.toContain("second");
    expect(events).toEqual(
      Array(2).fill({
        name: "changed",
        payload: {},
        options: { scope: "operator.read" },
      }),
    );
  });

  it("refuses stale writes and deletes, including a concurrent second writer", async () => {
    const { call, events } = setup();
    await call("write", initial);
    const expectedHash = sha256("first");
    const answers = await Promise.all([
      call("write", { ...note, content: "winner", expectedHash }),
      call("write", { ...note, content: "other", expectedHash }),
    ]);
    const success = answers.find(({ ok }) => ok);
    expect(answers.filter(({ ok }) => ok)).toHaveLength(1);
    const currentHash = (success?.payload as { hash: string }).hash;
    expect(answers.find(({ ok }) => !ok)?.error).toMatchObject({ details: { currentHash } });
    expect((await call("delete", { ...note, expectedHash })).error).toMatchObject({
      details: { currentHash },
    });
    expect(events).toHaveLength(2);
    expect((await call("delete", { ...note, expectedHash: currentHash })).ok).toBe(true);
    expect((await call("read", note)).ok).toBe(false);
    expect(events).toHaveLength(3);
  });

  it("rechecks a file changed by an outside writer and returns the current hash", async () => {
    const { call, workspace } = setup();
    expect((await call("write", initial)).ok).toBe(true);
    const root = await fs.root(workspace, rootOptions);
    const original = await read(root, note.path);
    await expect(
      applyCas(
        root,
        note.path,
        original,
        () => {},
        (guard: () => void) => {
          writeFileSync(join(workspace, note.path), "outside edit");
          return root.write(note.path, "stale edit", { assertBeforeMutation: guard });
        },
      ),
    ).rejects.toMatchObject({ details: { currentHash: sha256("outside edit") } });
    expect(readFileSync(join(workspace, note.path), "utf8")).toBe("outside edit");
  });

  it("does not attribute an identical replacement published before the write returns", async () => {
    const { call, workspace, savers } = setup({
      root: async (...args: Parameters<typeof fs.root>) => {
        const root = await fs.root(...args);
        const create = root.create.bind(root);
        root.create = async (...options: unknown[]) => {
          await create(...options);
          const target = join(workspace, note.path);
          const replacement = `${target}.replacement`;
          writeFileSync(replacement, initial.content);
          renameSync(replacement, target);
        };
        return root;
      },
    });
    expect((await call("write", initial)).ok).toBe(true);
    expect([...savers.values()]).toMatchObject([
      { kind: "operator", hash: sha256(initial.content) },
    ]);
    expect([...savers.values()][0]).not.toHaveProperty("revision");
    expect((await call("read", note)).payload).not.toHaveProperty("savedBy");
    expect((await call("list", { agentId: "main" })).payload).toMatchObject({
      files: [expect.not.objectContaining({ savedBy: expect.anything() })],
    });
  });

  it.each(["write", "delete"])(
    "reports a committed note %s as uncertain after a config reload",
    async (method) => {
      const { call, workspace, events, reload } = setup({
        root: async (...args: Parameters<typeof fs.root>) => {
          const root = await fs.root(...args);
          const operation = method === "delete" ? "remove" : "write";
          const mutate = root[operation].bind(root);
          root[operation] = async (...options: unknown[]) => {
            await mutate(...options);
            reload();
          };
          return root;
        },
      });
      mkdirSync(join(workspace, "memory/nested"), { recursive: true });
      writeFileSync(join(workspace, note.path), "first");
      const change = { ...note, expectedHash: sha256("first") };
      expect(
        await call(method, method === "write" ? { ...change, content: "second" } : change),
      ).toMatchObject({
        ok: false,
        error: {
          message: expect.stringContaining("read the note again before retrying"),
          details: { unknown: true },
        },
      });
      expect(events).toHaveLength(1);
      const reread = await call("read", note);
      if (method === "write") {
        expect(reread).toMatchObject({ ok: true, payload: { content: "second" } });
      } else {
        expect(reread).toMatchObject({ ok: false, error: { message: "Note does not exist" } });
      }
    },
  );

  it("reports uncertain note replacement and removal and invalidates the view", async () => {
    const { call, workspace, events } = setup({
      root: async (...args: Parameters<typeof fs.root>) => {
        const root = await fs.root(...args);
        const write = root.write.bind(root);
        const remove = root.remove.bind(root);
        root.write = async (...options: unknown[]) => {
          await write(...options);
          throw Object.assign(new Error("verification failed"), { code: "path-mismatch" });
        };
        root.remove = async (...options: unknown[]) => {
          await remove(...options);
          throw Object.assign(new Error("verification failed"), { code: "path-mismatch" });
        };
        return root;
      },
    });
    expect((await call("write", initial)).ok).toBe(true);
    const uncertain = { ok: false, error: { details: { unknown: true } } };
    expect(
      await call("write", { ...initial, content: "second", expectedHash: sha256("first") }),
    ).toMatchObject(uncertain);
    expect(readFileSync(join(workspace, note.path), "utf8")).toBe("second");
    expect(await call("delete", { ...note, expectedHash: sha256("second") })).toMatchObject(
      uncertain,
    );
    expect((await call("read", note)).ok).toBe(false);
    expect(events).toHaveLength(3);
  });

  it("bounds content, paths, bot batches, the list and saver metadata", async () => {
    const { call, workspace, hook, savers } = setup();
    for (const content of [1, null, "😀".repeat(MAX_BYTES / 4 + 1), "\ud800"]) {
      expect((await call("write", { ...initial, content })).ok).toBe(false);
    }
    expect((await call("write", { ...initial, path: `memory/${"a".repeat(510)}.md` })).ok).toBe(
      false,
    );
    expect((await call("write", { ...initial, expectedHash: {} })).ok).toBe(false);
    expect(
      (
        await call("copy", {
          item: { path: "a.md", sharedRoot: sha256("root") },
          agents: Array(33).fill("main"),
          expectedHashes: { main: null },
        })
      ).ok,
    ).toBe(false);
    mkdirSync(join(workspace, "memory"));
    for (let i = 0; i < 520; i += 1) {
      const path = `memory/${i}.md`;
      writeFileSync(join(workspace, path), "note body");
      await hook(
        {
          toolName: "write",
          params: { path, content: "note body" },
          result: {
            content: [{ text: `Successfully wrote 9 bytes to ${path}` }],
            details: { changed: true },
          },
        },
        { agentId: "main", sessionKey: "agent:main:script" },
      );
    }
    expect(savers.size).toBe(512);
    const { files, truncated } = (await call("list", { agentId: "main" })).payload as {
      files: object[];
      truncated: boolean;
    };
    expect(files).toHaveLength(256);
    expect(truncated).toBe(true);
  });

  it("records tool save metadata without a revision, content or a change event", async () => {
    const { hook, savers, events } = setup();
    const context = { agentId: "main", sessionKey: "agent:main:script" };
    const event = {
      toolName: "write",
      params: { path: note.path, content: "body from a tool" },
      result: {
        content: [{ text: `Successfully wrote 16 bytes to ${note.path}` }],
        details: { changed: true },
      },
    };
    await hook({ ...event, error: "failed" }, context);
    await hook({ ...event, result: undefined }, context);
    await hook({ ...event, result: { ...event.result, details: { changed: false } } }, context);
    expect(savers.size).toBe(0);
    await hook(event, context);
    expect([...savers.values()]).toEqual([
      { kind: "bot", ...context, path: note.path, at: expect.any(Number) },
    ]);
    expect(events).toHaveLength(0);
  });

  it("copies and uncopies independently using keyed bot budgets", async () => {
    const { call, workspace, other, shared, methods } = setup();
    const { folders } = (await call("list", {})).payload as { folders: { sharedRoot: string }[] };
    const item = { sharedRoot: folders[0]!.sharedRoot, path: "sample.md" };
    expect(
      await call("write", { ...item, content: "shared item", expectedHash: null }),
    ).toMatchObject({ ok: true });
    expect((await call("list", { sharedRoot: item.sharedRoot })).payload).toMatchObject({
      files: [{ path: item.path, hash: sha256("shared item") }],
    });
    writeFileSync(join(workspace, "MEMORY.md"), "existing");
    const params = {
      item,
      agents: ["main", "other"],
      expectedHashes: { main: sha256("existing"), other: null },
    };
    const copied = (await call("copy", params)).payload as {
      sourceId: string;
      results: { hash: string }[];
    };
    expect(copied.results).toMatchObject([
      { agentId: "main", copied: true },
      { agentId: "other", refused: true, reason: "The copy would exceed the root memory budget" },
    ]);
    expect(readFileSync(join(workspace, "MEMORY.md"), "utf8")).toContain(copied.sourceId);
    expect(readdirSync(other)).toEqual([]);
    rmSync(join(shared, item.path));
    expect(
      await call("uncopy", {
        item,
        agents: ["main"],
        expectedHashes: { main: copied.results[0]!.hash },
      }),
    ).toMatchObject({ ok: true, payload: { results: [{ agentId: "main", uncopied: true }] } });
    expect(readFileSync(join(workspace, "MEMORY.md"), "utf8")).toBe("existing");
    for (const path of ["MEMORY.md", "USER.md"]) {
      expect(
        (await call("write", { ...item, path, expectedHash: null, content: "refused" })).ok,
      ).toBe(false);
    }
    expect(methods.has("clawtrate-memory.move")).toBe(false);
  });

  it("uses the exact shared path for pattern checks, source IDs and uncopy after removal", async () => {
    const shared = join(directory, "shared");
    const canonical = "Example.md";
    const alias = "example.md";
    const { call, workspace } = setup({
      extraPaths: [{ path: shared, pattern: "[Ee]xample.md" }],
      root: async (...args: Parameters<typeof fs.root>) => {
        const root = await fs.root(...args);
        if (args[0] === (await fs.canonicalPathFromExistingAncestor(shared))) {
          const read = root.read.bind(root);
          root.read = (path: string) => read(path === `./${alias}` ? `./${canonical}` : path);
        }
        return root;
      },
    });
    writeFileSync(join(shared, canonical), "source");
    const sharedRoot = sha256(await fs.canonicalPathFromExistingAncestor(shared));
    const item = { sharedRoot, path: canonical };
    const params = { item, agents: ["main"], expectedHashes: { main: null } };
    expect((await call("read", { ...item, path: alias })).ok).toBe(false);
    expect((await call("copy", { ...params, item: { ...item, path: alias } })).ok).toBe(false);
    const sourceId = sha256(`${sharedRoot}\0${canonical}`);
    expect(await call("read", item)).toMatchObject({ ok: true, payload: { sourceId } });
    expect(await call("copy", params)).toMatchObject({
      ok: true,
      payload: { sourceId, results: [{ copied: true }] },
    });
    rmSync(join(shared, canonical));
    const hash = sha256(readFileSync(join(workspace, "MEMORY.md")));
    expect(await call("uncopy", { ...params, expectedHashes: { main: hash } })).toMatchObject({
      ok: true,
      payload: { sourceId, results: [{ uncopied: true }] },
    });
  });

  it("refuses a differently cased root memory file with rename guidance", async () => {
    const { call, workspace, shared } = setup({
      root: async (...args: Parameters<typeof fs.root>) => {
        const root = await fs.root(...args);
        const read = root.read.bind(root);
        // Stands in for a case-insensitive filesystem, so the check also holds on Linux.
        root.read = (path: string) => read(path === "./MEMORY.md" ? "./memory.md" : path);
        return root;
      },
    });
    writeFileSync(join(workspace, "memory.md"), "legacy");
    writeFileSync(join(shared, "sample.md"), "source");
    const sharedRoot = sha256(await fs.canonicalPathFromExistingAncestor(shared));
    expect(
      await call("copy", {
        item: { sharedRoot, path: "sample.md" },
        agents: ["main"],
        expectedHashes: { main: sha256("legacy") },
      }),
    ).toMatchObject({
      ok: true,
      payload: {
        results: [
          {
            refused: true,
            reason: expect.stringContaining("Rename the root memory file to MEMORY.md"),
          },
        ],
      },
    });
    expect(readdirSync(workspace)).toEqual(["memory.md"]);
    expect(readFileSync(join(workspace, "memory.md"), "utf8")).toBe("legacy");
  });

  it("reports a root copy as unknown when publication succeeds and verification fails", async () => {
    const { call, workspace, shared, events } = setup({
      root: async (...args: Parameters<typeof fs.root>) => {
        const root = await fs.root(...args);
        const write = root.write.bind(root);
        root.write = async (...options: unknown[]) => {
          await write(...options);
          throw Object.assign(new Error("verification failed"), { code: "path-mismatch" });
        };
        return root;
      },
    });
    writeFileSync(join(workspace, "MEMORY.md"), "existing");
    writeFileSync(join(shared, "sample.md"), "source");
    const sharedRoot = sha256(await fs.canonicalPathFromExistingAncestor(shared));
    expect(
      await call("copy", {
        item: { sharedRoot, path: "sample.md" },
        agents: ["main"],
        expectedHashes: { main: sha256("existing") },
      }),
    ).toMatchObject({ ok: true, payload: { results: [{ agentId: "main", unknown: true }] } });
    expect(readFileSync(join(workspace, "MEMORY.md"), "utf8")).toContain("source");
    expect(events).toHaveLength(1);
  });

  it.each([false, true])(
    "stops a copy on config reload and releases results only with current access (revoked=%s)",
    async (revoked) => {
      let onWrite = () => {};
      const visible = ["main", "other"];
      const { call, workspace, other, shared, reload } = setup({
        visible,
        entries: { main: {}, other: {} },
        root: async (...args: Parameters<typeof fs.root>) => {
          const root = await fs.root(...args);
          const write = root.write.bind(root);
          root.write = async (...options: unknown[]) => {
            await write(...options);
            onWrite();
          };
          return root;
        },
      });
      onWrite = () => {
        if (revoked) visible.pop();
        reload();
      };
      writeFileSync(join(workspace, "MEMORY.md"), "existing");
      writeFileSync(join(shared, "sample.md"), "source");
      const sharedRoot = sha256(await fs.canonicalPathFromExistingAncestor(shared));
      const result = await call("copy", {
        item: { sharedRoot, path: "sample.md" },
        agents: ["main", "other"],
        expectedHashes: { main: sha256("existing"), other: null },
      });
      if (revoked) {
        expect(result).toMatchObject({ ok: false, error: { details: { unknown: true } } });
        expect(result.payload).toBeUndefined();
      } else {
        expect(result).toMatchObject({
          ok: true,
          payload: {
            results: [
              {
                agentId: "main",
                copied: true,
                hash: sha256(readFileSync(join(workspace, "MEMORY.md"))),
              },
              { agentId: "other", refused: true },
            ],
          },
        });
      }
      expect(readFileSync(join(workspace, "MEMORY.md"), "utf8")).toContain("source");
      expect(readdirSync(other)).toEqual([]);
    },
  );

  it("admits at most 64 copy batches before they read their sources", async () => {
    const { promise: blocked, resolve: release } = Promise.withResolvers<void>();
    const { promise: allReading, resolve: reading } = Promise.withResolvers<void>();
    const { promise: overflowed, resolve: overflow } = Promise.withResolvers<void>();
    let reads = 0;
    const { call, shared } = setup({
      root: async (...args: Parameters<typeof fs.root>) => {
        const root = await fs.root(...args);
        const read = root.read.bind(root);
        root.read = async (path: string) => {
          reads += 1;
          if (reads === 64) reading();
          if (reads === 65) overflow();
          await blocked;
          return read(path);
        };
        return root;
      },
    });
    const sharedRoot = sha256(await fs.canonicalPathFromExistingAncestor(shared));
    const params = {
      item: { sharedRoot, path: "sample.md" },
      agents: ["main"],
      expectedHashes: { main: null },
    };
    const batches = Array.from({ length: 64 }, () => call("copy", params));
    try {
      await allReading;
      const last = call("copy", params);
      await expect(Promise.race([last, overflowed])).resolves.toMatchObject({
        ok: false,
        error: { message: "Too many pending memory writes" },
      });
    } finally {
      release();
      await Promise.all(batches);
    }
  });

  it("withholds a completed copy hash when the bot moves to another workspace", async () => {
    let onWrite = () => {};
    const { call, workspace, shared, reload } = setup({
      root: async (...args: Parameters<typeof fs.root>) => {
        const root = await fs.root(...args);
        const write = root.write.bind(root);
        root.write = async (...options: unknown[]) => {
          await write(...options);
          onWrite();
        };
        return root;
      },
    });
    const newWorkspace = join(directory, "moved");
    mkdirSync(newWorkspace);
    onWrite = () => reload({ main: { workspace: newWorkspace }, other: {} });
    writeFileSync(join(workspace, "MEMORY.md"), "existing");
    writeFileSync(join(shared, "sample.md"), "source");
    const sharedRoot = sha256(await fs.canonicalPathFromExistingAncestor(shared));
    const reply = await call("copy", {
      item: { sharedRoot, path: "sample.md" },
      agents: ["main"],
      expectedHashes: { main: sha256("existing") },
    });
    expect(reply).toMatchObject({
      ok: true,
      payload: {
        results: [
          { agentId: "main", unknown: true, reason: expect.stringContaining("workspace changed") },
        ],
      },
    });
    expect((reply.payload as { results: object[] }).results[0]).not.toHaveProperty("hash");
    expect(readFileSync(join(workspace, "MEMORY.md"), "utf8")).toContain("source");
    expect(readdirSync(newWorkspace)).toEqual([]);
  });

  it("withholds a conflict hash when the bot moves to another workspace", async () => {
    let onWrite = () => {};
    const { call, workspace, other, shared, reload } = setup({
      entries: { main: {}, other: {} },
      root: async (...args: Parameters<typeof fs.root>) => {
        const root = await fs.root(...args);
        const write = root.write.bind(root);
        root.write = async (...options: unknown[]) => {
          await write(...options);
          onWrite();
        };
        return root;
      },
    });
    const newWorkspace = join(directory, "moved");
    mkdirSync(newWorkspace);
    onWrite = () => reload({ main: { workspace: newWorkspace }, other: {} });
    writeFileSync(join(workspace, "MEMORY.md"), "old main memory");
    writeFileSync(join(other, "MEMORY.md"), "other memory");
    writeFileSync(join(shared, "sample.md"), "source");
    const sharedRoot = sha256(await fs.canonicalPathFromExistingAncestor(shared));
    const reply = await call("copy", {
      item: { sharedRoot, path: "sample.md" },
      agents: ["main", "other"],
      expectedHashes: { main: null, other: sha256("other memory") },
    });
    expect(reply).toMatchObject({
      ok: true,
      payload: {
        results: [
          { agentId: "main", refused: true, reason: expect.stringContaining("workspace changed") },
          { agentId: "other", copied: true },
        ],
      },
    });
    expect((reply.payload as { results: object[] }).results[0]).not.toHaveProperty("currentHash");
  });
});
