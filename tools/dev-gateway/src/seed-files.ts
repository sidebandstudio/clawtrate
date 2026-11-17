// Files seeded into Pip's workspace for the Work pane's Files tab: a picture
// drawn here (the `#picture` scenario reads it), and a small git checkout a task
// can be started in to compare its changes with the last commit. Everything is
// made by this file; nothing is copied from anywhere.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

/** Where the picture is, relative to Pip's workspace. */
export const PICTURE_PATH = "pictures/trail-map.png";
/** The checkout, relative to Pip's workspace. */
export const CHECKOUT_PATH = "projects/trail-guide";
/** The bot whose workspace holds them. */
export const FILES_BOT = "pip";

function crc32(bytes: Buffer): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** A trail map: a green ground, a lake, and a dashed path between two markers. */
export function trailMap(width = 240, height = 160): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      let color = [206, 226, 196];
      const lake = ((x - 160) / 46) ** 2 + ((y - 60) / 30) ** 2 <= 1;
      if (lake) color = [120, 176, 214];
      const pathY = 130 - x * 0.45;
      if (Math.abs(y - pathY) < 2 && Math.floor(x / 8) % 2 === 0 && !lake) color = [140, 92, 60];
      if ((x - 24) ** 2 + (y - 120) ** 2 < 36 || (x - 210) ** 2 + (y - 36) ** 2 < 36)
        color = [196, 64, 52];
      raw.set(color, row + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const README = "# Trail guide\n\nRoutes Pip keeps for weekend walks.\n";
const ROUTES = "# Routes\n\n- Lake loop: 6 km, flat.\n- Ridge path: 11 km, steep at the start.\n";

/**
 * Write the picture and the checkout into a bot's workspace. The checkout's
 * one commit is on `main`, authored by the tool with no address.
 */
export function seedWorkspaceFiles(workspace: string): void {
  mkdirSync(join(workspace, "pictures"), { recursive: true });
  writeFileSync(join(workspace, PICTURE_PATH), trailMap());
  const checkout = join(workspace, CHECKOUT_PATH);
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, "README.md"), README);
  writeFileSync(join(checkout, "routes.md"), ROUTES);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: checkout,
      stdio: ["ignore", "ignore", "pipe"],
      // Nothing from the user's own git configuration applies here.
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: checkout,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
  git("init", "-q", "-b", "main");
  git("add", "README.md", "routes.md");
  git(
    "-c",
    "user.name=Clawtrate dev gateway",
    "-c",
    "user.email=",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "Start the trail guide",
  );
}
