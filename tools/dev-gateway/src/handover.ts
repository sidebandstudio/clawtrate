// What Juniper can hand over in the artifact scenarios (`#hand-*`): a picture,
// a large picture, a recording, a file over Clawtrate's limit, a note that the
// gateway later loses, and a page. Every byte is made here; nothing is copied
// from anywhere. The files go into Juniper's workspace at start, and the page
// into the instance's canvas documents, where the gateway's `canvas.document.view`
// reads it.
//
// A bot hands a file over by naming it on a `MEDIA:` line of its reply. The
// gateway copies the file into its own media store and puts an attachment
// block on the reply, with a managed id (`artifact_managed_…`), which
// `artifacts.list` lists with download mode `url`.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

/** The bot whose workspace holds the handover files. */
export const HANDOVER_BOT = "main";

/** Where each file is, relative to the bot's workspace. */
export const HANDOVER = {
  /** A small chart: shown on its card from its own bytes. */
  picture: "handover/ridge-profile.png",
  /** A large photo-like picture, over the 256 KB a card draws from its own bytes. */
  photo: "handover/trail-photo.png",
  /** Two seconds of a fading chime. */
  audio: "handover/trail-chime.wav",
  /** Over the 5 MiB the gateway attaches (`MEDIA_MAX_BYTES`): it refuses it with `delivery-failed`. */
  large: "handover/elevation-log.csv",
  /** The note `forgetHandover` removes from the gateway's store after it was handed over. */
  gone: "handover/old-route.md",
} as const;

/** The report `#hand-file` writes, then hands over. Any bot can do this one. */
export const REPORT_PATH = "notes/trail-report.md";
export const REPORT_TEXT =
  "# Trail report, Saturday\n\n## Found\n\n- Lake loop: dry, 6 km, flat.\n- Ridge path: muddy below the saddle.\n\n## Left\n\n- Check the ridge again on Friday.\n";

/** The link `#hand-link` ends its reply with, on a reserved domain that never resolves. */
export const HANDOVER_LINK = "https://trails.example/conditions";

/** The canvas document `#hand-page` names. */
export const PAGE_ID = "trail-guide";
export const PAGE_TITLE = "Trail guide";

export const LARGE_BYTES = 6 * 1024 * 1024;
export const OLD_ROUTE_TEXT =
  "# Old route\n\nThe ridge path before the bridge was moved. Kept for reference.\n";

// Pictures -------------------------------------------------------------------

function crc32(bytes: Uint8Array): number {
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

/** An RGB PNG whose pixels `pixel` gives. */
export function encodePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) raw.set(pixel(x, y), row + 1 + x * 3);
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

/** The ridge path's height along its length: a filled profile on a pale ground. */
export function ridgeProfile(): Buffer {
  const width = 320;
  const height = 200;
  const ground = (x: number) =>
    150 - 60 * Math.sin((x / width) * Math.PI) - 14 * Math.sin((x / width) * Math.PI * 5);
  return encodePng(width, height, (x, y) => {
    if (y > ground(x)) return [72, 132, 104];
    if (Math.abs(y - ground(x)) < 2) return [36, 84, 64];
    if (y % 40 === 0) return [222, 226, 220];
    return [246, 247, 244];
  });
}

/**
 * A photo-like picture: sky, hills and grain, about 4 MB as a PNG, so its card
 * asks for the gateway's thumbnail rather than its own bytes. The grain is
 * fixed by a seed, so the bytes are the same at every start.
 */
export function trailPhoto(): Buffer {
  const width = 2400;
  const height = 1600;
  let seed = 7;
  const grain = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 7) - 3;
  };
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  return encodePng(width, height, (x, y) => {
    const hill = 900 + 160 * Math.sin(x / 260) + 60 * Math.sin(x / 70);
    const checker = (x + y) % 2 === 0 ? 6 : -6;
    const g = grain();
    if (y < hill) {
      const t = y / hill;
      return [clamp(150 + 70 * t + g), clamp(190 + 40 * t + g), clamp(235 + checker + g)];
    }
    const t = (y - hill) / (height - hill);
    return [clamp(70 - 30 * t + checker + g), clamp(120 - 40 * t + g), clamp(60 - 20 * t + g)];
  });
}

// A recording -----------------------------------------------------------------

/** Two seconds of a 660 Hz chime fading out, as 8 kHz mono 16-bit WAV. */
export function trailChime(): Buffer {
  const rate = 8000;
  const samples = rate * 2;
  const out = Buffer.alloc(44 + samples * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + samples * 2, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.sin((2 * Math.PI * 660 * i) / rate) * Math.exp(-i / 4000) * 9000;
    out.writeInt16LE(Math.round(value), 44 + i * 2);
  }
  return out;
}

// Text ------------------------------------------------------------------------

/** Elevation samples along the ridge path, exactly `LARGE_BYTES` long. */
export function elevationLog(): Buffer {
  const lines: string[] = ["distance_m,elevation_m"];
  let length = lines[0]!.length + 1;
  for (let i = 0; length < LARGE_BYTES; i += 1) {
    const line = `${i},${(420 + 80 * Math.sin(i / 900)).toFixed(1)}`;
    lines.push(line);
    length += line.length + 1;
  }
  return Buffer.from(lines.join("\n") + "\n").subarray(0, LARGE_BYTES);
}

/** The page: routes in a table, sortable where its script may run. */
export function trailGuidePage(): string {
  const rows = [
    ["Lake loop", "6 km", "Flat", "Dry"],
    ["Ridge path", "11 km", "Steep at the start", "Muddy below the saddle"],
    ["Pine walk", "4 km", "Gentle", "Dry"],
  ];
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><title>Trail guide</title>',
    "<style>body{font:15px/1.5 system-ui,sans-serif;margin:32px 40px;color:#111213;background:#fff}",
    "table{border-collapse:collapse;width:100%;margin-top:16px}th,td{padding:10px 8px;border-bottom:1px solid #e2e2df;text-align:left}</style>",
    "</head><body><h1>Trail guide</h1><p>Saturday's routes, with what each was like this week.</p>",
    "<table><thead><tr><th>Route</th><th>Length</th><th>Climb</th><th>This week</th></tr></thead><tbody>",
    ...rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`),
    "</tbody></table>",
    "<script>document.querySelectorAll('th').forEach((th,i)=>th.addEventListener('click',()=>{const b=document.querySelector('tbody');[...b.rows].sort((x,y)=>x.cells[i].textContent.localeCompare(y.cells[i].textContent)).forEach(r=>b.append(r))}))</script>",
    "</body></html>",
  ].join("\n");
}

// Seeding and forgetting ------------------------------------------------------

/** Every file of the handover folder, with its bytes. */
export function handoverFiles(): Record<string, Buffer> {
  return {
    [HANDOVER.picture]: ridgeProfile(),
    [HANDOVER.photo]: trailPhoto(),
    [HANDOVER.audio]: trailChime(),
    [HANDOVER.large]: elevationLog(),
    [HANDOVER.gone]: Buffer.from(OLD_ROUTE_TEXT),
  };
}

/**
 * Write the handover files into the bot's workspace and the page into the
 * instance's canvas documents (`<state>/canvas/documents/<id>`, a manifest
 * and its HTML, as the gateway's canvas reader expects them).
 */
export function seedHandover(workspace: string, stateDir: string): void {
  for (const [path, bytes] of Object.entries(handoverFiles())) {
    mkdirSync(join(workspace, path, ".."), { recursive: true });
    writeFileSync(join(workspace, path), bytes);
  }
  const page = join(stateDir, "canvas", "documents", PAGE_ID);
  mkdirSync(page, { recursive: true });
  writeFileSync(join(page, "index.html"), trailGuidePage());
  writeFileSync(
    join(page, "manifest.json"),
    JSON.stringify(
      {
        id: PAGE_ID,
        localEntrypoint: "index.html",
        cspSandbox: "scripts",
        createdAt: "2026-11-16T12:00:00.000Z",
      },
      null,
      2,
    ),
  );
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Remove the gateway's stored copy of the old route note from the instance's
 * media store (`<state>/media/outgoing/originals`), as the gateway's own media
 * cleanup would: the transcript still names it, and `artifacts.download`
 * answers `artifact_not_found`. Only files whose bytes are exactly the note's
 * are removed. Returns how many.
 */
export function forgetHandover(stateDir: string): number {
  const dir = join(stateDir, "media", "outgoing", "originals");
  if (!existsSync(dir)) return 0;
  const target = digest(Buffer.from(OLD_ROUTE_TEXT));
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (digest(readFileSync(path)) !== target) continue;
    rmSync(path);
    removed += 1;
  }
  return removed;
}
