// The picture picker (bots.md section 3): a creature family, its parts and a
// colour, or the person's own picture. New bot and Edit picture share it.

import {
  AVATAR_COLOR_NAMES,
  AVATAR_COLORS,
  AVATAR_FAMILIES,
  AVATAR_PARTS,
  avatarFor,
  defaultAvatar,
  firstChoice,
  MAX_PICTURE_CHARS as SHARED_MAX_PICTURE_CHARS,
  pictureWithChoice,
  type AvatarChoice,
  type AvatarFamily,
  type Bot,
} from "@clawtrate/core";
import { useEffect, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { Creature, PictureOr } from "../Avatar.tsx";

/** What the picker holds: a creature, and the person's own picture when there is one. */
export type PictureDraft = { choice: AvatarChoice; upload: string | null };

/** A bot's current picture, as the picker starts from it. */
export function draftOf(bot: Bot): PictureDraft {
  const avatar = avatarFor(bot);
  return avatar.kind === "image"
    ? { choice: defaultAvatar(bot.id), upload: avatar.url }
    : { choice: avatar.choice, upload: null };
}

export const FAMILY_WORDS: Record<AvatarFamily, string> = {
  clawling: "Clawlings",
  shellfolk: "Shellfolk",
  lantern: "Lanterns",
};

const PART_WORDS: Record<string, string> = {
  body: "Body",
  eyes: "Eyes",
  claws: "Claws",
  shell: "Shell",
  lure: "Lure",
};

const VALUE_WORDS: Record<string, string> = {
  dome: "Dome",
  tall: "Tall",
  wide: "Wide",
  round: "Round",
  pair: "Two eyes",
  splayed: "Splayed eyes",
  short: "Short stalks",
  single: "One eye",
  even: "Even claws",
  fiddler: "Fiddler claw",
  big: "Big claws",
  spiral: "Spiral",
  turret: "Turret",
  spotted: "Spotted",
  bell: "Bell",
  oval: "Oval",
  box: "Box",
  hook: "Hook",
  flick: "Flick",
  wave: "Wave",
  reach: "Reach",
  two: "Two eyes",
  one: "One eye",
};

const COLOR_WORDS: Record<string, string> = {
  green: "Green",
  blue: "Blue",
  orchid: "Orchid",
  violet: "Violet",
  yellow: "Yellow",
  pink: "Pink",
  sky: "Sky",
  lime: "Lime",
};

/** A radio group of one tab stop: arrows move and choose, Home and End go to the ends. */
export function onRadioKeys<T>(values: readonly T[], current: T, choose: (value: T) => void) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    const index = values.indexOf(current);
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % values.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = (index - 1 + values.length) % values.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = values.length - 1;
    if (next === null) return;
    event.preventDefault();
    // Focus moves now, as the key is handled: a key pressed straight after (Tab) acts from the
    // radio it reached, and this handler leaves no focus move for a later frame.
    event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
    choose(values[next]!);
  };
}

/** The live picture: the person's own, or the creature drawn at rest. */
export function PicturePreview({
  draft,
  label,
  previewRef,
  small = false,
}: {
  draft: PictureDraft;
  label: string | null;
  previewRef?: Ref<HTMLSpanElement>;
  small?: boolean;
}) {
  return (
    <span
      className="b-preview"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      {...(small ? { style: { ["--avatar-create" as string]: "56px", marginBottom: 10 } } : {})}
      ref={previewRef}
      data-testid="picture-preview"
    >
      {draft.upload ? (
        <PictureOr url={draft.upload}>
          <Creature choice={draft.choice} />
        </PictureOr>
      ) : (
        <Creature choice={draft.choice} />
      )}
    </span>
  );
}

/** The size New bot and Edit picture send: the creature, rasterised. */
const PICTURE_PX = 128;
/** The longest picture sent, the limit the core checks (`MAX_PICTURE_CHARS`). */
const MAX_PICTURE_CHARS = SHARED_MAX_PICTURE_CHARS;
/** An image this large or larger is refused before it is read (F-270). */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * The picture to keep with the bot, as a PNG data URL: the person's own, or
 * the creature's still pose with the choice written into it (`avatar.ts`), so
 * other clients show a picture and Clawtrate draws the creature again. Null
 * when it cannot be drawn: the bot then gets the Clawling its id gives.
 */
export async function pictureFor(
  draft: PictureDraft,
  svg: SVGElement | null | undefined,
): Promise<string | null> {
  if (draft.upload) return draft.upload;
  if (!svg) return null;
  let markup = svg.outerHTML;
  if (!markup.includes("xmlns="))
    markup = markup.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  try {
    const image = new Image(PICTURE_PX, PICTURE_PX);
    image.src = `data:image/svg+xml;base64,${btoa(markup)}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = PICTURE_PX;
    canvas.height = PICTURE_PX;
    canvas.getContext("2d")?.drawImage(image, 0, 0, PICTURE_PX, PICTURE_PX);
    return pictureWithChoice(canvas.toDataURL("image/png"), draft.choice);
  } catch {
    return null;
  }
}

/** Why an upload was refused, in fixed words. */
export const UPLOAD_PROBLEMS = {
  type: "Choose a PNG, JPEG, WebP or GIF image.",
  size: "Choose an image under 25 MB.",
  pixels: "Choose an image no wider or taller than 8,192 pixels and under 16 million pixels.",
  read: "That image couldn't be read.",
  detail: "That image has too much detail to keep. Try a simpler one.",
} as const;
type UploadProblem = keyof typeof UPLOAD_PROBLEMS;

class UploadRefused extends Error {
  readonly problem: UploadProblem;
  constructor(problem: UploadProblem) {
    super(problem);
    this.problem = problem;
  }
}

/** The widest or tallest image read, and the most pixels: decoding is bounded before it starts. */
const MAX_UPLOAD_SIDE = 8192;
const MAX_UPLOAD_PIXELS = 16_000_000;
/** How much of the file the format's header is looked for in. */
const HEADER_BYTES = 256 * 1024;

/** The real format and size of an image, from its first bytes, or null when it is none of the four. */
export function imageHeader(
  bytes: Uint8Array,
): { width: number; height: number } | "unknown" | null {
  const at = (i: number) => bytes[i] ?? -1;
  const be16 = (i: number) => (at(i) << 8) | at(i + 1);
  const le16 = (i: number) => at(i) | (at(i + 1) << 8);
  const be32 = (i: number) => ((be16(i) << 16) | be16(i + 2)) >>> 0;
  const tag = (i: number, text: string) => [...text].every((c, k) => at(i + k) === c.charCodeAt(0));
  // PNG: the signature, then IHDR's width and height.
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => at(i) === b) && tag(12, "IHDR"))
    return { width: be32(16), height: be32(20) };
  // GIF: the logical screen.
  if (tag(0, "GIF87a") || tag(0, "GIF89a")) return { width: le16(6), height: le16(8) };
  // WebP: the first chunk is VP8 (lossy), VP8L (lossless) or VP8X (extended).
  if (tag(0, "RIFF") && tag(8, "WEBP")) {
    if (tag(12, "VP8 ")) return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (tag(12, "VP8L") && at(20) === 0x2f) {
      const bits = at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (tag(12, "VP8X"))
      return {
        width: (at(24) | (at(25) << 8) | (at(26) << 16)) + 1,
        height: (at(27) | (at(28) << 8) | (at(29) << 16)) + 1,
      };
    return null;
  }
  // JPEG: walk the markers to the first frame header.
  if (at(0) === 0xff && at(1) === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (at(i) !== 0xff) return null;
      const marker = at(i + 1);
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      const frame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (frame) return { width: be16(i + 7), height: be16(i + 5) };
      if (marker === 0xd9 || marker === 0xda) return null;
      i += 2 + be16(i + 2);
    }
    return null;
  }
  return "unknown";
}

/** An image the person chose, checked before it is decoded, cropped to its centre square and made small enough to keep. */
async function uploadedPicture(file: File): Promise<string> {
  if (file.size >= MAX_UPLOAD_BYTES) throw new UploadRefused("size");
  const header = imageHeader(new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer()));
  if (header === "unknown") throw new UploadRefused("type");
  if (!header || header.width < 1 || header.height < 1) throw new UploadRefused("read");
  if (
    header.width > MAX_UPLOAD_SIDE ||
    header.height > MAX_UPLOAD_SIDE ||
    header.width * header.height > MAX_UPLOAD_PIXELS
  )
    throw new UploadRefused("pixels");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new UploadRefused("read");
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    for (const px of [PICTURE_PX, 96, 72, 56]) {
      const canvas = document.createElement("canvas");
      canvas.width = px;
      canvas.height = px;
      const context = canvas.getContext("2d");
      if (!context) throw new UploadRefused("read");
      context.drawImage(
        bitmap,
        (bitmap.width - side) / 2,
        (bitmap.height - side) / 2,
        side,
        side,
        0,
        0,
        px,
        px,
      );
      const url = canvas.toDataURL("image/png");
      if (url.length <= MAX_PICTURE_CHARS) return url;
    }
  } finally {
    bitmap.close();
  }
  throw new UploadRefused("detail");
}

/** The family, the family's parts, the colour, and the person's own picture. */
export function AvatarPicker({
  draft,
  onChange,
  onBusy,
}: {
  draft: PictureDraft;
  onChange: (next: PictureDraft) => void;
  /** True while a chosen file is being read: whatever advances or saves waits for it. */
  onBusy?: (busy: boolean) => void;
}) {
  const { choice } = draft;
  const file = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Each file chosen is one attempt. Only the latest one may finish: a newer file, a creature
  // chosen meanwhile, or the picker going away makes an earlier one's result count for nothing.
  const attempt = useRef(0);
  const busyRef = useRef(onBusy);
  useEffect(() => {
    busyRef.current = onBusy;
  });
  useEffect(
    () => () => {
      attempt.current += 1;
      busyRef.current?.(false);
    },
    [],
  );
  const set = (next: AvatarChoice) => {
    attempt.current += 1;
    onBusy?.(false);
    setProblem(null);
    onChange({ choice: next, upload: null });
  };
  const withPart = (key: string, value: string) => ({ ...choice, [key]: value }) as AvatarChoice;
  const parts = AVATAR_PARTS[choice.family] as Record<string, readonly string[]>;
  const current = choice as unknown as Record<string, string>;
  const family = (next: AvatarFamily) =>
    next === choice.family ? choice : firstChoice(next, choice.color);
  return (
    <>
      <p className="b-label" id="b-family-label">
        Creature
      </p>
      <div
        className="b-families"
        role="radiogroup"
        aria-labelledby="b-family-label"
        onKeyDown={(event) =>
          onRadioKeys(AVATAR_FAMILIES, choice.family, (next) => set(family(next)))(event)
        }
      >
        {AVATAR_FAMILIES.map((each) => (
          <button
            key={each}
            type="button"
            className="b-family"
            role="radio"
            aria-checked={each === choice.family}
            tabIndex={each === choice.family ? 0 : -1}
            onClick={() => set(family(each))}
          >
            <Creature choice={family(each)} />
            <span>{FAMILY_WORDS[each]}</span>
          </button>
        ))}
      </div>
      {Object.entries(parts).map(([key, values]) => (
        <div key={`${choice.family}-${key}`}>
          <p className="b-label" id={`b-part-${key}`}>
            {PART_WORDS[key]}
          </p>
          <div
            className="b-shapes"
            role="radiogroup"
            aria-labelledby={`b-part-${key}`}
            data-part={key}
            onKeyDown={(event) =>
              onRadioKeys(values, current[key]!, (value) => set(withPart(key, value)))(event)
            }
          >
            {values.map((value) => (
              <button
                key={value}
                type="button"
                className="b-shape"
                role="radio"
                aria-checked={value === current[key]}
                tabIndex={value === current[key] ? 0 : -1}
                aria-label={VALUE_WORDS[value]}
                title={VALUE_WORDS[value]}
                onClick={() => set(withPart(key, value))}
              >
                <Creature choice={withPart(key, value)} />
              </button>
            ))}
          </div>
        </div>
      ))}
      <p className="b-label" id="b-color-label">
        Colour
      </p>
      <div
        className="b-colors"
        role="radiogroup"
        aria-labelledby="b-color-label"
        onKeyDown={(event) =>
          onRadioKeys(AVATAR_COLOR_NAMES, choice.color, (color) => set({ ...choice, color }))(event)
        }
      >
        {AVATAR_COLOR_NAMES.map((color) => (
          <button
            key={color}
            type="button"
            className="b-color"
            role="radio"
            aria-checked={color === choice.color}
            tabIndex={color === choice.color ? 0 : -1}
            aria-label={COLOR_WORDS[color]}
            style={{ ["--swatch" as string]: AVATAR_COLORS[color] }}
            onClick={() => set({ ...choice, color })}
          />
        ))}
      </div>
      <div className="b-upload">
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          data-testid="picture-file"
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            event.target.value = "";
            if (!chosen) return;
            const mine = ++attempt.current;
            onBusy?.(true);
            setProblem(null);
            uploadedPicture(chosen).then(
              (upload) => {
                if (mine !== attempt.current) return;
                onBusy?.(false);
                onChange({ choice, upload });
              },
              (error: unknown) => {
                if (mine !== attempt.current) return;
                onBusy?.(false);
                setProblem(
                  UPLOAD_PROBLEMS[error instanceof UploadRefused ? error.problem : "read"],
                );
              },
            );
          }}
        />
        <button
          type="button"
          className="button"
          data-variant="quiet"
          data-size="sm"
          onClick={() => file.current?.click()}
        >
          {draft.upload ? "Choose another picture" : "Use your own picture"}
        </button>
        {draft.upload && (
          <button
            type="button"
            className="button"
            data-variant="quiet"
            data-size="sm"
            onClick={() => set(choice)}
          >
            Use the creature
          </button>
        )}
        {problem && (
          <p className="b-field-error" role="alert">
            {problem}
          </p>
        )}
      </div>
    </>
  );
}
