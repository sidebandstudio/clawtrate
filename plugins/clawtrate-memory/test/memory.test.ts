import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_BYTES, applyCas, read, rootOptions, sha256 } from "../lib/files.js";
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

beforeAll(async () => {
  const packageDir =
    process.env.OPENCLAW_PACKAGE_DIR ??
    join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "openclaw");
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  expect(manifest.version).toBe("2026.10.6");
  fs = await import(pathToFileURL(join(packageDir, "dist/plugin-sdk/file-access-runtime.js")).href);
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "clawtrate-memory-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function setup({
  visible = ["main", "other"],
  extraPaths,
  bridge,
}: {
  visible?: string[];
  extraPaths?: unknown[];
  bridge?: () => unknown;
} = {}) {
  const workspace = join(directory, "workspace");
  const other = join(directory, "other");
  const shared = join(directory, "shared");
  for (const folder of [workspace, other, shared]) mkdirSync(folder);
  const methods = new Map<string, { handler: Handler; scope: string }>();
  const events: Change[] = [];
  const config = {
    agents: { list: [{ id: "main" }, { id: "other", bootstrapMaxChars: 160 }] },
    memory: { search: { enabled: true, extraPaths: extraPaths ?? [shared] } },
  };
  let hook: Hook = async () => {};
  const savers = new Map<string, object>();
  registerMemory(
    {
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
                savers.delete(key);
                savers.set(key, value);
                if (savers.size > maxEntries) savers.delete(savers.keys().next().value!);
              },
              delete: async (key: string) => savers.delete(key),
              lookupMany: async (keys: string[]) =>
                keys.map((key) => ({ ok: true, value: savers.get(key) })),
            };
          },
        },
        agent: {
          resolveAgentWorkspaceDir: (_config: object, id: string) =>
            id === "main" ? workspace : other,
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
          stateDir: directory,
          gatewayEvents: {
            emit: (name: string, payload: unknown, options: unknown) =>
              events.push({ name, payload, options }),
          },
        }),
    },
    {
      listAgentIds: () => config.agents.list.map(({ id }) => id),
      getAgentWorkspaceAccess: bridge ?? (() => undefined),
      ...fs,
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
  return { workspace, other, shared, methods, events, hook, savers, call };
}

const note = { agentId: "main", path: "memory/nested/note.md" };
const initial = { ...note, content: "first", expectedHash: null };

describe("memory paths", () => {
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
    rmSync(join(workspace, "memory"), { recursive: true });
    symlinkSync(shared, join(workspace, "memory"), "dir");
    expect((await call("write", initial)).ok).toBe(false);
    expect((await call("list", { agentId: "main" })).payload).not.toMatchObject({
      files: [expect.objectContaining({ path: "memory/outside.md" })],
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
});

describe("memory changes", () => {
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
        savedBy: { kind: "operator", id: "test-device", hash: sha256("second") },
      },
    });
    expect(JSON.stringify([...savers.values()])).not.toContain("second");
    expect(events).toEqual(
      Array(2).fill({
        name: "changed",
        payload: {},
        options: { scope: "operator.read" },
      }),
    );
    writeFileSync(target, "outside edit");
    expect((await call("read", note)).payload).not.toHaveProperty("savedBy");
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

  it("records successful tool saves without a revision or tool content", async () => {
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
    expect(events).toHaveLength(1);
  });

  it("copies and uncopies each bot independently, and protects root files from notes methods", async () => {
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
});
