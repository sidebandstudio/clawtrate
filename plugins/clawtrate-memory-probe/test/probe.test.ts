import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import probe, { notePath } from "../index.js";

type Method = (options: {
  params: Record<string, string>;
  respond: (ok: boolean, payload?: unknown) => void;
}) => void;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function load() {
  const workspace = mkdtempSync(join(tmpdir(), "clawtrate-memory-probe-"));
  temps.push(workspace);
  const methods = new Map<string, { handler: Method; scope?: string }>();
  const api = {
    config: { marker: "live-config" },
    runtime: {
      agent: {
        resolveAgentWorkspaceDir(config: unknown, agentId: string) {
          expect(config).toBe(api.config);
          return join(workspace, agentId);
        },
      },
    },
    registerGatewayMethod(name: string, handler: Method, options: { scope?: string }) {
      methods.set(name, { handler, ...options });
    },
  };
  probe.register(api);
  return { workspace, methods };
}

describe("the memory probe", () => {
  it("uses the public resolver for the requested bot and registers admin-only methods", () => {
    const { workspace, methods } = load();
    expect([...methods.keys()]).toEqual([
      "clawtrate-memory-probe.workspace",
      "clawtrate-memory-probe.write",
    ]);
    for (const method of methods.values()) expect(method.scope).toBe("operator.admin");

    let answer: unknown;
    methods.get("clawtrate-memory-probe.workspace")!.handler({
      params: { agentId: "second" },
      respond: (_ok, payload) => (answer = payload),
    });
    expect(answer).toEqual({ agentId: "second", workspace: join(workspace, "second") });
  });

  it("writes a note in that bot's workspace", () => {
    const { workspace, methods } = load();
    let answer: unknown;
    methods.get("clawtrate-memory-probe.write")!.handler({
      params: { agentId: "otto", path: "memory/probe.md", content: "a live marker\n" },
      respond: (_ok, payload) => (answer = payload),
    });
    const botWorkspace = join(workspace, "otto");
    expect(readFileSync(join(botWorkspace, "memory/probe.md"), "utf8")).toBe("a live marker\n");
    expect(answer).toEqual({ agentId: "otto", path: "memory/probe.md", workspace: botWorkspace });
  });

  it("confines writes to normalized Markdown note paths", () => {
    const workspace = join(tmpdir(), "memory-probe-boundary");
    for (const path of [
      "MEMORY.md",
      "/memory/note.md",
      "memory/../MEMORY.md",
      "memory//note.md",
      "memory/note.txt",
      "memory",
    ]) {
      expect(() => notePath(workspace, path), path).toThrow(/Markdown note under memory/);
    }
    expect(notePath(workspace, "memory/nested/note.md")).toBe(
      join(workspace, "memory/nested/note.md"),
    );
  });

  it("refuses a write through a linked note or a linked folder", () => {
    const { workspace, methods } = load();
    const outside = join(workspace, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "target.md"), "kept\n");
    const write = (agentId: string) =>
      methods.get("clawtrate-memory-probe.write")!.handler({
        params: { agentId, path: "memory/nested/note.md", content: "overwritten\n" },
        respond: () => {},
      });

    mkdirSync(join(workspace, "linked-note/memory/nested"), { recursive: true });
    symlinkSync(join(outside, "target.md"), join(workspace, "linked-note/memory/nested/note.md"));
    expect(() => write("linked-note")).toThrow(/symbolic link/);

    mkdirSync(join(workspace, "linked-folder"));
    symlinkSync(outside, join(workspace, "linked-folder/memory"));
    expect(() => write("linked-folder")).toThrow(/symbolic link/);

    expect(readFileSync(join(outside, "target.md"), "utf8")).toBe("kept\n");
    expect(() => readFileSync(join(outside, "nested/note.md"))).toThrow();
  });
});
