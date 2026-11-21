import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "darwin")(
  "the Mac install command cleans up a temporary path containing a literal dollar sign",
  () => {
    const script = readFileSync(new URL("../site/install.sh", import.meta.url), "utf8");
    const command = script.match(/^# +(sh -c .+)$/m)?.[1];
    if (!command) throw new Error("Missing install command");
    const page = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
    expect(page.split(command.replaceAll("&", "&amp;"))).toHaveLength(3);

    const root = mkdtempSync(join(tmpdir(), "clawtrate-command-"));
    try {
      const temporary = join(root, "Mac $edition");
      mkdirSync(temporary);
      // A failed local stand-in still takes the command through its EXIT trap.
      writeFileSync(join(root, "curl"), "#!/bin/sh\nexit 7\n", { mode: 0o700 });
      const result = spawnSync("/bin/sh", ["-c", command], {
        env: { PATH: `${root}:/usr/bin:/bin`, TMPDIR: temporary },
      });
      expect(result.status).toBe(7);
      expect(readdirSync(temporary)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
