// Writes fonts.local.css next to the prototype pages, so they render in the
// design's own typefaces. The file is ignored by git: no font is committed.
//
//   node tools/make-local-fonts.mjs
//
// It fetches two exact package versions from the npm registry with `npm pack`,
// reads the font files out of them, and embeds them in one stylesheet. This
// script is the only part of the prototype that uses the network, and the
// pages never do. Both fonts are under the SIL Open Font License 1.1.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packages = [
  {
    name: "@fontsource-variable/figtree",
    version: "5.3.0",
    family: "Figtree Variable",
    weights: "300 900",
    files: { normal: "files/figtree-latin-wght-normal.woff2", italic: "files/figtree-latin-wght-italic.woff2" },
  },
  {
    name: "@fontsource-variable/jetbrains-mono",
    version: "5.3.0",
    family: "JetBrains Mono Variable",
    weights: "100 800",
    files: { normal: "files/jetbrains-mono-latin-wght-normal.woff2" },
  },
];

const work = mkdtempSync(join(tmpdir(), "clawtrate-fonts-"));
let css = "/* Local only, not committed. Made by tools/make-local-fonts.mjs. */\n";

try {
  for (const pkg of packages) {
    const spec = `${pkg.name}@${pkg.version}`;
    const tarball = execFileSync("npm", ["pack", spec, "--silent"], { cwd: work, encoding: "utf8" }).trim().split("\n").pop();
    const dir = join(work, tarball.replace(/\.tgz$/, ""));
    execFileSync("mkdir", ["-p", dir]);
    execFileSync("tar", ["-xzf", join(work, tarball), "-C", dir]);
    for (const [style, file] of Object.entries(pkg.files)) {
      const data = readFileSync(join(dir, "package", file)).toString("base64");
      css +=
        `/* ${spec} ${file} */\n` +
        `@font-face{font-family:"${pkg.family}";font-style:${style};font-weight:${pkg.weights};font-display:block;` +
        `src:url(data:font/woff2;base64,${data}) format("woff2")}\n`;
    }
    console.log(`embedded ${spec}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "fonts.local.css");
writeFileSync(out, css);
console.log(`wrote ${out}`);
