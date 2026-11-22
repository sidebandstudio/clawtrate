// The shared avatar spec (avatar.ts; visual-language.md section 5).
import { describe, expect, it } from "vitest";
import {
  AVATAR_COLOR_NAMES,
  AVATAR_COLORS,
  AVATAR_FAMILIES,
  AVATAR_MOTIONS,
  AVATAR_PARTS,
  AVATAR_STATES,
  avatarFor,
  avatarPose,
  avatarScene,
  avatarVariation,
  choiceFromPicture,
  decodeAvatarChoice,
  defaultAvatar,
  encodeAvatarChoice,
  isGuardedColor,
  isKeepablePicture,
  MAX_PICTURE_CHARS,
  parseAvatarChoice,
  readPicture,
  pictureWithChoice,
  type AvatarChoice,
  type AvatarShape,
} from "../src/avatar.ts";

/** Every choice there is: each family with every combination of its parts, in every colour. */
function everyChoice(): AvatarChoice[] {
  const out: AvatarChoice[] = [];
  for (const family of AVATAR_FAMILIES) {
    let partial: Array<Record<string, string>> = [{ family }];
    for (const [key, values] of Object.entries(AVATAR_PARTS[family]))
      partial = partial.flatMap((each) =>
        values.map((value: string) => ({ ...each, [key]: value })),
      );
    for (const each of partial)
      for (const color of AVATAR_COLOR_NAMES) out.push({ ...each, color } as AvatarChoice);
  }
  return out;
}

function walk(shape: AvatarShape, visit: (shape: AvatarShape) => void): void {
  visit(shape);
  if (shape.kind === "group") for (const child of shape.children) walk(child, visit);
}

function shapes(choice: AvatarChoice, state: (typeof AVATAR_STATES)[number]): AvatarShape[] {
  const all: AvatarShape[] = [];
  walk(avatarScene(choice, state, avatarVariation("atlas")).root, (each) => all.push(each));
  return all;
}

const part = (list: AvatarShape[], name: string) => list.filter((each) => each.part === name);

/** A real 2×2 PNG: its IHDR, IDAT and IEND chunks. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC";
const png = () => PNG;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesOf(url: string): number[] {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of url.slice(url.indexOf(",") + 1).replace(/=+$/, "")) {
    value = (value << 6) | B64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return out;
}

/** CRC-32 as PNG defines it, written out here so the check does not lean on the code it checks. */
function crc(bytes: number[]): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** The chunks of a PNG data URL, each with whether its checksum holds. */
function chunks(url: string): Array<{ type: string; ok: boolean }> {
  const bytes = bytesOf(url);
  const u32 = (at: number) =>
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
  const out: Array<{ type: string; ok: boolean }> = [];
  for (let at = 8; at < bytes.length;) {
    const length = u32(at);
    const body = bytes.slice(at + 4, at + 8 + length);
    out.push({
      type: String.fromCharCode(...body.slice(0, 4)),
      ok: u32(at + 8 + length) === crc(body),
    });
    at += 12 + length;
  }
  return out;
}

describe("choosing a bot's creature from its id", () => {
  it("is always a Clawling, the same on every call, and differs between bots", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `bot-${i}`);
    for (const id of ids) {
      expect(defaultAvatar(id).family).toBe("clawling");
      expect(defaultAvatar(id)).toEqual(defaultAvatar(id));
      expect(avatarVariation(id)).toEqual(avatarVariation(id));
    }
    const distinct = new Set(ids.map((id) => encodeAvatarChoice(defaultAvatar(id))));
    expect(distinct.size).toBeGreaterThan(100);
  });

  it("gives these ids these creatures on every device: the choice is a pure function of the id", () => {
    expect(defaultAvatar("main")).toEqual({
      family: "clawling",
      body: "wide",
      eyes: "single",
      claws: "fiddler",
      color: "blue",
    });
    expect(defaultAvatar("otto")).toEqual({
      family: "clawling",
      body: "tall",
      eyes: "splayed",
      claws: "big",
      color: "sky",
    });
    expect(avatarVariation("otto")).toEqual({ gaze: [0.58, 0.57], blink: 4000 });
  });

  it("pins the hash, the salts and the order of every part list: this corpus covers every body, eyes, claws and colour", () => {
    // Computed once and checked in. A change to the hash, a salt or a list's order moves one of these.
    const table: Array<[string, string, string, string, string, [number, number], number]> = [
      ["main", "wide", "single", "fiddler", "blue", [0, -0.2], 4000],
      ["otto", "tall", "splayed", "big", "sky", [0.58, 0.57], 4000],
      ["bot-0", "round", "pair", "fiddler", "lime", [0, -0.2], 800],
      ["bot-1", "wide", "splayed", "fiddler", "blue", [0.82, 0.25], 1600],
      ["bot-2", "tall", "single", "fiddler", "yellow", [0, 0.7], 0],
      ["bot-3", "dome", "splayed", "big", "lime", [0.58, 0.57], 800],
      ["bot-4", "tall", "splayed", "even", "sky", [-0.82, 0.25], 1600],
      ["bot-5", "dome", "single", "big", "pink", [0.58, 0.57], 4000],
      ["bot-6", "wide", "short", "fiddler", "pink", [0.58, -0.07], 1600],
      ["bot-7", "tall", "short", "fiddler", "violet", [-0.58, -0.07], 800],
      ["bot-14", "round", "pair", "even", "orchid", [0, -0.2], 3200],
      ["bot-18", "round", "single", "fiddler", "green", [0.58, 0.57], 0],
    ];
    for (const [id, body, eyes, claws, color, gaze, blink] of table) {
      expect([id, defaultAvatar(id)]).toEqual([
        id,
        { family: "clawling", body, eyes, claws, color },
      ]);
      expect([id, avatarVariation(id)]).toEqual([id, { gaze, blink }]);
    }
    const covered = (index: number) => new Set(table.map((row) => row[index]));
    expect(covered(1).size).toBe(4);
    expect(covered(2).size).toBe(4);
    expect(covered(3).size).toBe(3);
    expect(covered(4).size).toBe(8);
  });

  it("keeps the colour the previous character had, except orange, which is gone", () => {
    // The previous palette, in its order: the hash picked an index into it.
    const before = [
      "#58c26f",
      "#5b8dff",
      "#ff8552",
      "#a98bff",
      "#f6bd3b",
      "#ff6f9c",
      "#45bdf5",
      "#a5d955",
    ];
    let kept = 0;
    for (let i = 0; i < 100; i++) {
      const id = `colour-${i}`;
      const now = AVATAR_COLORS[defaultAvatar(id).color];
      const index = AVATAR_COLOR_NAMES.indexOf(defaultAvatar(id).color);
      if (before[index] === "#ff8552") expect(now).toBe(AVATAR_COLORS.orchid);
      else {
        expect(now).toBe(before[index]);
        kept++;
      }
    }
    expect(kept).toBeGreaterThan(70);
  });

  it("draws a bot with no picture as its Clawling, and one with its own picture as that picture", () => {
    expect(avatarFor({ id: "otto", avatarUrl: null })).toEqual({
      kind: "creature",
      choice: defaultAvatar("otto"),
      chosen: false,
    });
    const own = png();
    expect(avatarFor({ id: "otto", avatarUrl: own })).toEqual({ kind: "image", url: own });
    expect(avatarFor({ id: "otto", avatarUrl: "https://example.com/a.png" }).kind).toBe("image");
  });
});

describe("every family, part and state", () => {
  const choices = everyChoice();

  it("covers each family's whole range", () => {
    const count = (family: string) => choices.filter((c) => c.family === family).length;
    expect(count("clawling")).toBe(4 * 4 * 3 * 8);
    expect(count("shellfolk")).toBe(4 * 8);
    expect(count("lantern")).toBe(4 * 4 * 2 * 8);
  });

  it("resolves to a drawable scene, on the grid, whose motions all exist", () => {
    // Problems are collected and compared once: thousands of separate assertions are slow.
    const problems: string[] = [];
    for (const choice of choices)
      for (const state of AVATAR_STATES) {
        const where = `${encodeAvatarChoice(choice)} ${state}`;
        const scene = avatarScene(choice, state, avatarVariation("atlas"));
        if (scene.root.kind !== "group" || scene.root.children.length <= 3)
          problems.push(`${where}: no creature`);
        for (const each of shapes(choice, state)) {
          if (each.motion && !AVATAR_MOTIONS[each.motion])
            problems.push(`${where}: motion ${each.motion}`);
          if (each.kind === "path" && !/^M[-\d.]+ [-\d.]+[MLQCSHVZ\d .-]*$/.test(each.d))
            problems.push(`${where}: path ${each.d}`);
          if (each.kind === "circle" && (each.cx < -6 || each.cx > 46 || each.r <= 0))
            problems.push(`${where}: circle ${each.cx} ${each.r}`);
          for (const value of Object.values(each))
            if (typeof value === "number" && !Number.isFinite(value))
              problems.push(`${where}: ${value}`);
        }
      }
    expect(problems).toEqual([]);
  });

  it("each motion loops from where it starts; the ping starts again only once it has faded out", () => {
    for (const [name, motion] of Object.entries(AVATAR_MOTIONS)) {
      const first = motion.frames[0]!;
      const last = motion.frames.at(-1)!;
      expect(first.at).toBe(0);
      expect(last.at).toBe(1);
      if (name === "ping") expect(last.opacity).toBe(0);
      else expect({ ...last, at: 0 }).toEqual(first);
    }
  });

  it("maps every presence state to a pose: failed is blocked, stopped is idle", () => {
    expect(AVATAR_STATES.map(avatarPose)).toEqual([...AVATAR_STATES]);
    expect(avatarPose("failed")).toBe("blocked");
    expect(avatarPose("stopped")).toBe("idle");
    expect(avatarPose("anything")).toBe("idle");
  });
});

describe("each family acts out each state as the issue says", () => {
  const clawling: AvatarChoice = {
    family: "clawling",
    body: "dome",
    eyes: "pair",
    claws: "even",
    color: "blue",
  };
  const shellfolk: AvatarChoice = { family: "shellfolk", shell: "spiral", color: "blue" };
  const lantern: AvatarChoice = {
    family: "lantern",
    body: "round",
    lure: "hook",
    eyes: "two",
    color: "sky",
  };
  const root = (choice: AvatarChoice, state: (typeof AVATAR_STATES)[number]) =>
    avatarScene(choice, state, avatarVariation("atlas")).root;

  it("Clawlings: blink at rest, lean and look up, snap, wave, droop, raise both claws with the ball", () => {
    expect(part(shapes(clawling, "idle"), "lid").every((lid) => lid.motion === "blink")).toBe(true);
    expect(part(shapes(clawling, "idle"), "arm").map((arm) => arm.rotate ?? 0)).toEqual([0, 0]);
    expect(root(clawling, "thinking").motion).toBe("sway");
    expect(
      part(shapes(clawling, "thinking"), "pupil").every((p) => p.kind === "circle" && p.cy < 0),
    ).toBe(true);
    expect(part(shapes(clawling, "working"), "claw").map((claw) => claw.motion)).toEqual([
      "snap",
      "snap",
    ]);
    const waving = part(shapes(clawling, "waiting"), "arm");
    expect(waving.map((arm) => arm.motion ?? null)).toEqual([null, "wave"]);
    expect(waving[1]!.still).toBeLessThan(-30);
    expect(part(shapes(clawling, "blocked"), "arm").map((arm) => arm.rotate)).toEqual([-62, 62]);
    expect(avatarScene(clawling, "blocked", avatarVariation("atlas")).muted).toBe(true);
    expect(part(shapes(clawling, "done"), "arm").map((arm) => arm.rotate)).toEqual([42, -42]);
    expect(part(shapes(clawling, "done"), "ball")).toHaveLength(1);
    expect(part(shapes(clawling, "idle"), "ball")).toHaveLength(0);
    expect(root(clawling, "done").motion).toBe("hop");
  });

  it("Shellfolk: tilt its head, crawl, stretch up, hide with only its eyes out, pop out", () => {
    expect(part(shapes(shellfolk, "thinking"), "neck")[0]!.motion).toBe("tilt");
    expect(root(shellfolk, "thinking").motion).toBeUndefined();
    expect(root(shellfolk, "working").motion).toBe("crawl");
    expect(root(shellfolk, "waiting").motion).toBe("lean");
    const hidden = shapes(shellfolk, "blocked");
    expect(part(hidden, "foot")).toHaveLength(0);
    expect(part(hidden, "head")).toHaveLength(0);
    expect(part(hidden, "opening")).toHaveLength(1);
    expect(part(hidden, "eye")).toHaveLength(2);
    expect(root(shellfolk, "done").motion).toBe("hop");
  });

  it("Lanterns: hold the lure still, sway and watch it, conduct, light it, let it droop and dim, bounce", () => {
    expect(part(shapes(lantern, "idle"), "lure")[0]!.motion).toBeUndefined();
    expect(part(shapes(lantern, "thinking"), "lure")[0]!.motion).toBe("lure-sway");
    expect(
      part(shapes(lantern, "thinking"), "pupil").every((p) => p.kind === "circle" && p.cx > 0.5),
    ).toBe(true);
    expect(part(shapes(lantern, "working"), "lure")[0]!.motion).toBe("conduct");
    expect(part(shapes(lantern, "waiting"), "ping")[0]!.motion).toBe("ping");
    const blocked = shapes(lantern, "blocked");
    expect(part(blocked, "lure")[0]!.rotate).toBe(-58);
    expect(part(blocked, "ball")[0]!.fill).not.toBe(part(shapes(lantern, "idle"), "ball")[0]!.fill);
    expect(root(lantern, "done").motion).toBe("hop");
  });

  it("drops only fine detail at small sizes, never what says the state", () => {
    for (const choice of [clawling, shellfolk, lantern])
      for (const state of AVATAR_STATES)
        for (const each of shapes(choice, state))
          if (each.fine) expect(["mouth", "glint", "pattern"]).toContain(each.part);
  });
});

describe("the palette guard", () => {
  it("flags a red lobster and an orange crab", () => {
    for (const hex of ["#d8402b", "#e5322d", "#f74c00", "#ff8552", "#ff7a1a"])
      expect(isGuardedColor(hex)).toBe(true);
  });

  it("holds for every colour a creature is drawn in", () => {
    for (const hex of Object.values(AVATAR_COLORS)) expect(isGuardedColor(hex)).toBe(false);
    const paints = new Set<string>();
    for (const choice of everyChoice())
      for (const state of AVATAR_STATES)
        for (const each of shapes(choice, state))
          for (const paint of [each.fill, each.stroke])
            if (paint?.startsWith("#")) paints.add(paint);
    expect(paints.size).toBeGreaterThan(8);
    expect([...paints].filter(isGuardedColor)).toEqual([]);
  });
});

describe("the choice as kept with the bot", () => {
  it("round-trips every choice through its text form", () => {
    for (const choice of everyChoice())
      expect(decodeAvatarChoice(encodeAvatarChoice(choice))).toEqual(choice);
    expect(encodeAvatarChoice({ family: "shellfolk", shell: "turret", color: "pink" })).toBe(
      "v=1&family=shellfolk&shell=turret&color=pink",
    );
  });

  it("refuses anything unknown, missing or extra", () => {
    expect(decodeAvatarChoice("v=2&family=shellfolk&shell=turret&color=pink")).toBeNull();
    expect(decodeAvatarChoice("v=1&family=shellfolk&shell=turret&color=red")).toBeNull();
    expect(parseAvatarChoice({ family: "shellfolk", color: "pink" })).toBeNull();
    expect(
      parseAvatarChoice({ family: "shellfolk", shell: "turret", color: "pink", claws: "even" }),
    ).toBeNull();
    expect(parseAvatarChoice({ family: "lobster", color: "pink" })).toBeNull();
    expect(
      parseAvatarChoice({
        family: "lantern",
        body: "box",
        lure: "reach",
        eyes: "one",
        color: "lime",
      }),
    ).toEqual({
      family: "lantern",
      body: "box",
      lure: "reach",
      eyes: "one",
      color: "lime",
    });
  });

  it("writes the choice into a PNG that stays valid, and reads it back", () => {
    const choice: AvatarChoice = {
      family: "lantern",
      body: "bell",
      lure: "wave",
      eyes: "one",
      color: "lime",
    };
    const plain = png();
    expect(choiceFromPicture(plain)).toBeNull();
    const kept = pictureWithChoice(plain, choice)!;
    expect(kept.startsWith("data:image/png;base64,")).toBe(true);
    expect(chunks(plain).every((c) => c.ok)).toBe(true);
    expect(chunks(kept).map((c) => c.type)).toEqual(["IHDR", "tEXt", "IDAT", "IEND"]);
    expect(chunks(kept).every((c) => c.ok)).toBe(true);
    expect(choiceFromPicture(kept)).toEqual(choice);
    expect(avatarFor({ id: "otto", avatarUrl: kept })).toEqual({
      kind: "creature",
      choice,
      chosen: true,
    });
    // A new choice replaces the old one rather than adding a second.
    const again = pictureWithChoice(kept, { family: "shellfolk", shell: "dome", color: "green" })!;
    expect(chunks(again).filter((c) => c.type === "tEXt")).toHaveLength(1);
    expect(choiceFromPicture(again)).toEqual({
      family: "shellfolk",
      shell: "dome",
      color: "green",
    });
    expect(pictureWithChoice("data:image/jpeg;base64,AAAA", choice)).toBeNull();
    expect(choiceFromPicture("data:image/png;base64,not-a-png")).toBeNull();
  });
});

// A PNG built here, chunk by chunk, so each malformation can be made on purpose.
type RawChunk = { type: string; data: number[]; crc?: number; length?: number };

function base64(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : "=";
    out += i + 2 < bytes.length ? B64[n & 63]! : "=";
  }
  return out;
}

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

function chunkBytes({ type, data, crc: forced, length }: RawChunk): number[] {
  const body = [...ascii(type), ...data];
  return [...be32(length ?? data.length), ...body, ...be32(forced ?? crc(body))];
}

/** The 2×2 PNG's own chunks, read from it. */
function baseChunks(): RawChunk[] {
  const bytes = bytesOf(PNG);
  const out: RawChunk[] = [];
  for (let at = 8; at < bytes.length;) {
    const length =
      (bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!;
    out.push({
      type: String.fromCharCode(...bytes.slice(at + 4, at + 8)),
      data: bytes.slice(at + 8, at + 8 + length),
    });
    at += 12 + length;
  }
  return out;
}

function build(chunks: RawChunk[], trailing: number[] = []): string {
  const bytes = [137, 80, 78, 71, 13, 10, 26, 10, ...chunks.flatMap(chunkBytes), ...trailing];
  return `data:image/png;base64,${base64(bytes)}`;
}

const text = (value: string, keyword = "clawtrate-avatar"): RawChunk => ({
  type: "tEXt",
  data: [...ascii(keyword), 0, ...ascii(value)],
});
const CHOICE = "v=1&family=shellfolk&shell=dome&color=green";
/** The base chunks with extra ones after IHDR. */
const withAfterHeader = (...extra: RawChunk[]) => {
  const [head, ...rest] = baseChunks();
  return [head!, ...extra, ...rest];
};

describe("reading a picture from the gateway", () => {
  it("tells a plain picture, a creature picture and an invalid one apart", () => {
    expect(readPicture(build(baseChunks()))).toEqual({ kind: "plain" });
    expect(readPicture(build(withAfterHeader(text(CHOICE))))).toEqual({
      kind: "creature",
      choice: { family: "shellfolk", shell: "dome", color: "green" },
    });
    expect(readPicture("data:image/png;base64,not-a-png")).toEqual({ kind: "invalid" });
  });

  it("refuses a picture over the shared limit before decoding it", () => {
    const long = build(withAfterHeader({ type: "tEXt", data: new Array(24_600).fill(65) }));
    expect(long.length).toBeGreaterThan(MAX_PICTURE_CHARS);
    expect(readPicture(long)).toEqual({ kind: "invalid" });
    expect(isKeepablePicture(long)).toBe(false);
  });

  it("takes only canonical base64", () => {
    // A picture whose base64 ends in padding, so dropping it and its pad bits can be tried.
    let good = build(baseChunks());
    for (let extra = 0; !good.endsWith("="); extra++)
      good = build(withAfterHeader({ type: "teXt", data: new Array(extra).fill(65) }));
    const body = good.slice("data:image/png;base64,".length);
    expect(readPicture(good).kind).toBe("plain");
    // Padding dropped, a space, the wrong alphabet, and pad bits that are not zero.
    expect(readPicture(good.replace(/=+$/, "")).kind).toBe("invalid");
    expect(readPicture(`data:image/png;base64, ${body}`).kind).toBe("invalid");
    expect(readPicture(good.replace(/\+|\//, "-")).kind).toBe(
      body.match(/[+/]/) ? "invalid" : "plain",
    );
    const last = body.replace(/=+$/, "").at(-1)!;
    const bumped = B64[B64.indexOf(last) + 1]!;
    expect(
      readPicture(good.replace(new RegExp(`${last.replace(/[+/]/, "\\$&")}(=+)$`), `${bumped}$1`))
        .kind,
    ).toBe("invalid");
  });

  it("refuses PNGs that are not well formed", () => {
    const [ihdr, idat, iend] = baseChunks() as [RawChunk, RawChunk, RawChunk];
    const header = (width: number, height: number, depth = 8, colour = 2) => ({
      type: "IHDR",
      data: [...be32(width), ...be32(height), depth, colour, 0, 0, 0],
    });
    const cases: Record<string, string> = {
      "a wrong CRC": build([ihdr, { ...idat, crc: 1 }, iend]),
      "a length past the end": build([ihdr, { ...idat, length: 9_999 }, iend]),
      "IHDR not first": build([idat, ihdr, iend]),
      "two IHDR": build([ihdr, ihdr, idat, iend]),
      "a short IHDR": build([{ type: "IHDR", data: ihdr.data.slice(0, 12) }, idat, iend]),
      "a zero width": build([header(0, 2), idat, iend]),
      "a side over 8192": build([header(8193, 2), idat, iend]),
      "an unsupported bit depth": build([header(2, 2, 3), idat, iend]),
      "no IDAT": build([ihdr, iend]),
      "IDAT split by another chunk": build([ihdr, idat, text("x", "Comment"), idat, iend]),
      "no IEND": build([ihdr, idat]),
      "IEND with data": build([ihdr, idat, { type: "IEND", data: [1] }]),
      "bytes after IEND": build([ihdr, idat, iend], [0]),
      "an unknown critical chunk": build([ihdr, { type: "ABCD", data: [] }, idat, iend]),
      "a type byte that is not a letter": build([ihdr, { type: "ab1d", data: [] }, idat, iend]),
      "the reserved bit set": build([ihdr, { type: "abcd", data: [] }, idat, iend]),
      "a palette after the image data": build([
        ihdr,
        idat,
        { type: "PLTE", data: [0, 0, 0] },
        iend,
      ]),
      "more than 128 chunks": build([
        ihdr,
        ...new Array(130).fill({ type: "teXt", data: [] }),
        idat,
        iend,
      ]),
    };
    for (const [name, url] of Object.entries(cases))
      expect([name, readPicture(url).kind]).toEqual([name, "invalid"]);
    // An ancillary chunk the reader doesn't know, before or after the image data, is fine.
    expect(
      readPicture(
        build([
          ihdr,
          { type: "teXt", data: [] },
          idat,
          { type: "tIME", data: [0, 0, 0, 0, 0, 0, 0] },
          iend,
        ]),
      ).kind,
    ).toBe("plain");
  });

  it("reads a choice only from Clawtrate's exact keyword, once, as at most 200 ASCII bytes", () => {
    expect(readPicture(build(withAfterHeader(text(CHOICE, "clawtrate-avatarX")))).kind).toBe(
      "plain",
    );
    expect(readPicture(build(withAfterHeader(text(CHOICE, "clawtrate-avata")))).kind).toBe("plain");
    expect(readPicture(build(withAfterHeader(text(CHOICE), text(CHOICE)))).kind).toBe("invalid");
    expect(readPicture(build(withAfterHeader(text(`${CHOICE}${"&".repeat(200)}`)))).kind).toBe(
      "invalid",
    );
    expect(
      readPicture(
        build(
          withAfterHeader({
            type: "tEXt",
            data: [...ascii("clawtrate-avatar"), 0, ...ascii(CHOICE), 0xe9],
          }),
        ),
      ).kind,
    ).toBe("invalid");
    expect(readPicture(build(withAfterHeader(text("v=1&family=lobster&color=red")))).kind).toBe(
      "invalid",
    );
    // A valid choice in a file that breaks later is still refused: the whole file is checked first.
    const [ihdr, idat] = baseChunks() as [RawChunk, RawChunk];
    expect(readPicture(build([ihdr, text(CHOICE), idat]))).toEqual({ kind: "invalid" });
  });

  it("draws an invalid picture as the bot's Clawling, and keeps a valid plain one", () => {
    const broken = build(baseChunks(), [0]);
    expect(avatarFor({ id: "otto", avatarUrl: broken })).toEqual({
      kind: "creature",
      choice: defaultAvatar("otto"),
      chosen: false,
    });
    const plain = build(baseChunks());
    expect(avatarFor({ id: "otto", avatarUrl: plain })).toEqual({ kind: "image", url: plain });
    expect(avatarFor({ id: "otto", avatarUrl: "data:image/jpeg;base64,/9j/" })).toEqual({
      kind: "image",
      url: "data:image/jpeg;base64,/9j/",
    });
  });

  it("writes nothing that would be over the limit, and replaces a choice already there", () => {
    const near = build(withAfterHeader({ type: "teXt", data: new Array(24_400).fill(65) }));
    expect(near.length).toBeLessThanOrEqual(MAX_PICTURE_CHARS);
    expect(
      pictureWithChoice(near, {
        family: "lantern",
        body: "box",
        lure: "reach",
        eyes: "one",
        color: "lime",
      }),
    ).toBeNull();
    const once = pictureWithChoice(build(withAfterHeader(text(CHOICE))), {
      family: "clawling",
      body: "dome",
      eyes: "pair",
      claws: "even",
      color: "blue",
    })!;
    expect(chunks(once).filter((c) => c.type === "tEXt")).toHaveLength(1);
    expect(choiceFromPicture(once)?.family).toBe("clawling");
    expect(
      pictureWithChoice(build(baseChunks(), [0]), {
        family: "shellfolk",
        shell: "dome",
        color: "green",
      }),
    ).toBeNull();
  });
});

describe("parsing a choice from untrusted input", () => {
  it("takes only own fields, exactly the family's, with no duplicates", () => {
    const inherited = Object.create({ shell: "dome" }) as Record<string, string>;
    Object.assign(inherited, { family: "shellfolk", color: "green" });
    expect(parseAvatarChoice(inherited)).toBeNull();
    expect(
      parseAvatarChoice({ family: "shellfolk", shell: "dome", color: "green", toString: "x" }),
    ).toBeNull();
    expect(
      parseAvatarChoice({ family: "shellfolk", constructor: "dome", color: "green" }),
    ).toBeNull();
    expect(
      parseAvatarChoice(JSON.parse('{"family":"shellfolk","__proto__":"dome","color":"green"}')),
    ).toBeNull();
    expect(
      decodeAvatarChoice("v=1&family=shellfolk&shell=dome&shell=spiral&color=green"),
    ).toBeNull();
    expect(decodeAvatarChoice("v=1&family=shellfolk&constructor=dome&color=green")).toBeNull();
    expect(decodeAvatarChoice("v=1&family=shellfolk&shell=dome&color=green")).toEqual({
      family: "shellfolk",
      shell: "dome",
      color: "green",
    });
  });
});
