import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("../site/install.sh", import.meta.url), "utf8");
const page = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const BREW = "brew install --cask sidebandstudio/tap/clawtrate";
const CURL = "curl -fsSL https://clawtrate.dev/install.sh | sh";

describe("the install commands on the home page", () => {
  it("offers Homebrew and curl in the hero and in the closing band", () => {
    // Each command once in the hero's box and once in the close's.
    expect(page.split(`<code>${BREW}</code>`)).toHaveLength(3);
    expect(page.split(`<code>${CURL}</code>`)).toHaveLength(3);
    expect(page).toContain('id="cmd-hero-label"');
    expect(page).toContain('id="cmd-close-label"');
  });

  it("shows install.sh's own command, and not the old one or its note", () => {
    expect(script.match(/^# +(curl -fsSL .+)$/m)?.[1]).toBe(CURL);
    expect(page).not.toContain("mktemp");
    expect(page).not.toContain("cmd-note");
    expect(page).not.toContain("It downloads the installer whole before running it");
  });
});

// Every tool install.sh's main uses, as a stand-in that only records that it ran.
const TOOLS = (
  "uname id sysctl curl shasum osascript zipinfo unzip cmp ditto find readlink file " +
  "plutil codesign spctl stat mktemp mkdir rmdir rm mv ls sed awk grep sort uniq wc cat tr head"
).split(" ");

describe("install.sh piped into sh", () => {
  it("runs nothing and fails when the download is cut off anywhere", () => {
    const root = mkdtempSync(join(tmpdir(), "clawtrate-pipe-"));
    try {
      const ran = join(root, "ran");
      for (const tool of TOOLS)
        writeFileSync(join(root, tool), `#!/bin/sh\n: >"${ran}"\nexit 1\n`, { mode: 0o700 });
      const lines = script.split("\n");
      const lastLine = lines.lastIndexOf("main 'clawtrate-installer-complete'");
      expect(lastLine).toBeGreaterThan(0);
      const beforeMain = lines.slice(0, lastLine).join("\n");
      const cuts = [
        // Past the trap on its third line, every cut must fail. A cut within the
        // first two lines, the shebang and a comment, can only run nothing.
        ...lines
          .map((_, index) => lines.slice(0, index).join("\n"))
          .filter((_, i) => i >= 3 && i <= lastLine),
        beforeMain,
        `${beforeMain}\nmain`,
        `${beforeMain}\nmain 'clawtrate-installer-com`,
        `${beforeMain}\nmain 'clawtrate-installer-complete`,
      ];
      for (const prefix of cuts) {
        const result = spawnSync("/bin/sh", [], {
          input: prefix,
          env: { PATH: root, HOME: root },
        });
        expect(result.status, `cut at ${prefix.length} bytes`).not.toBe(0);
        expect(existsSync(ran), `cut at ${prefix.length} bytes ran a tool`).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // One run of sh for each line of the script.
  }, 60_000);
});
