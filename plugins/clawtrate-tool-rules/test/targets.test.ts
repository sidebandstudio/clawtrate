// What a call acts on, as the plugin reads it, and how patterns match.

import { describe, expect, it } from "vitest";
import {
  commandMatches,
  pathMatches,
  readCommand,
  readPath,
  readTarget,
  toolMatches,
} from "../lib/targets.js";

const WS = "/srv/workspaces/otto";

describe("readPath", () => {
  it("reads a workspace path, without `.` and empty names", () => {
    expect(readPath({ path: "notes/a.md" }, WS)).toBe("notes/a.md");
    expect(readPath({ path: "./notes//a.md" }, WS)).toBe("notes/a.md");
    expect(readPath({ path: "." }, WS)).toBe("");
    expect(readPath({ file_path: "notes/a.md" }, WS)).toBe("notes/a.md");
  });

  it("reads an absolute path inside the workspace, by any of its names", () => {
    expect(readPath({ path: `${WS}/notes/a.md` }, WS)).toBe("notes/a.md");
    expect(readPath({ path: `${WS}/notes/a.md` }, () => ["/var/x", WS])).toBe("notes/a.md");
    expect(readPath({ path: `${WS}x/notes` }, WS)).toBeNull();
    expect(readPath({ path: "/etc/passwd" }, WS)).toBeNull();
    expect(readPath({ path: "/etc/passwd" }, () => [])).toBeNull();
  });

  it("does not read what the host would change or what could leave the folder", () => {
    for (const path of [
      "notes/../secrets/a",
      "..",
      "~/a",
      "@notes/a",
      "file:///etc/passwd",
      "C:/a",
      "notes\\a",
      "notes/a\u0000",
      "notes/a\n",
      "report.docxodex",
      "",
      "a".repeat(4097),
    ]) {
      expect(readPath({ path }, WS), path.slice(0, 40)).toBeNull();
    }
  });

  it("does not read a missing, ambiguous or non-text path", () => {
    expect(readPath({}, WS)).toBeNull();
    expect(readPath({ path: "a", file_path: "b" }, WS)).toBeNull();
    expect(readPath({ path: "a", filePath: "b" }, WS)).toBeNull();
    expect(readPath({ paths: ["a"] }, WS)).toBeNull();
    expect(readPath({ path: ["a"] }, WS)).toBeNull();
    expect(readPath(null, WS)).toBeNull();
  });
});

describe("readCommand", () => {
  it("reads a simple command as its words", () => {
    expect(readCommand({ command: "ls -la notes" })).toBe("ls -la notes");
    expect(readCommand({ command: "  rm   -rf\tbuild  " })).toBe("rm -rf build");
    expect(readCommand({ command: "echo 'Hello from Otto.'" })).toBe("echo Hello from Otto.");
    expect(readCommand({ command: `'rm' "-rf" x` })).toBe("rm -rf x");
    expect(readCommand({ command: "git commit -m 'a; b | c'" })).toBe("git commit -m a; b | c");
  });

  it("does not read what the shell would expand, chain or redirect", () => {
    for (const command of [
      "ls; rm -rf x",
      "ls && rm x",
      "ls | sh",
      "rm -rf $HOME",
      "echo `id`",
      "echo $(id)",
      "cat < secrets",
      "ls > out",
      "rm *",
      "rm ?",
      "ls ~",
      "ls # comment",
      "echo \\n",
      "echo 'unterminated",
      'echo "$HOME"',
      'echo "a`b`"',
      "ls\nrm x",
      "FOO=1 rm x",
      "",
      "   ",
    ]) {
      expect(readCommand({ command }), command).toBeNull();
    }
    expect(readCommand({})).toBeNull();
    expect(readCommand({ command: 7 })).toBeNull();
  });

  it("reads an argument that sets something, which is not a variable assignment", () => {
    expect(readCommand({ command: "git -c a=b status" })).toBe("git -c a=b status");
  });
});

describe("readTarget", () => {
  it("knows which tools act on what", () => {
    expect(readTarget("read", { path: "a" }, WS)).toEqual({ kind: "path", value: "a" });
    expect(readTarget("exec", { command: "ls" }, WS)).toEqual({ kind: "command", value: "ls" });
    expect(readTarget("apply_patch", { input: "x" }, WS)).toEqual({ kind: "path", value: null });
    expect(readTarget("process", { action: "list" }, WS)).toEqual({ kind: "command", value: null });
    expect(readTarget("web_search", { query: "x" }, WS)).toBeNull();
  });
});

describe("pathMatches", () => {
  it("matches * within a name and ** across names, none included", () => {
    expect(pathMatches("secrets/**", "secrets")).toBe(true);
    expect(pathMatches("secrets/**", "secrets/a/b.txt")).toBe(true);
    expect(pathMatches("secrets/**", "notes/secrets/a")).toBe(false);
    expect(pathMatches("**/.ssh/**", ".ssh/id")).toBe(true);
    expect(pathMatches("**/.ssh/**", "home/me/.ssh/id")).toBe(true);
    expect(pathMatches("**/.ssh/**", "home/ssh/id")).toBe(false);
    expect(pathMatches("notes/*.md", "notes/a.md")).toBe(true);
    expect(pathMatches("notes/*.md", "notes/x/a.md")).toBe(false);
    expect(pathMatches("**", "")).toBe(true);
    expect(pathMatches("**", "a/b")).toBe(true);
    expect(pathMatches("notes/disk-*.md", "notes/disk-2026-11-18.md")).toBe(true);
  });

  it("stays fast with many ** names and a deep path", () => {
    const pattern = Array(400).fill("**").join("/x/") + "/end";
    const path = Array(128).fill("x").join("/");
    const started = Date.now();
    expect(pathMatches(pattern, path)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("commandMatches and toolMatches", () => {
  it("matches * across the rest of a word or of the line", () => {
    expect(commandMatches("rm *", "rm -rf build")).toBe(true);
    expect(commandMatches("rm *", "sudo rm x")).toBe(false);
    expect(commandMatches("git push*", "git push origin main")).toBe(true);
    expect(commandMatches("ls", "ls -la")).toBe(false);
  });

  it("matches a tool by its name, or a server's tools by a pattern", () => {
    expect(toolMatches("write", "write")).toBe(true);
    expect(toolMatches("write", "writer")).toBe(false);
    expect(toolMatches("coder__*", "coder__run")).toBe(true);
    expect(toolMatches("coder__run_*", "coder__deploy")).toBe(false);
  });
});
