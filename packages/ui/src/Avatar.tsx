import type { Bot } from "@clawtrate/core";

// Bot characters, drawn for Clawtrate: a flat body in one colour and a dark
// visor with two eyes, on a 40-unit grid. A bot without a picture gets a body,
// a colour, a tilt and a direction to look in from a stable hash of its id, so
// it looks the same on every device.

const BODIES = {
  pebble: <ellipse cx="20" cy="20.5" rx="17.5" ry="15.5" transform="rotate(-10 20 20)" />,
  block: <rect x="3.5" y="4.5" width="33" height="31" rx="11" />,
  arch: <path d="M5 19.5a15 15 0 0 1 30 0V30a6 6 0 0 1-6 6H11a6 6 0 0 1-6-6V19.5Z" />,
  bloom: (
    <>
      <circle cx="20" cy="20" r="11" />
      {[0, 60, 120, 180, 240, 300].map((angle) => (
        <circle key={angle} cx="20" cy="9.6" r="7.4" transform={`rotate(${angle} 20 20)`} />
      ))}
    </>
  ),
  disc: <circle cx="20" cy="20" r="17" />,
  hex: (
    <path
      d="M20 6.5 31.7 13.2v13.6L20 33.5 8.3 26.8V13.2L20 6.5Z"
      strokeWidth="6"
      strokeLinejoin="round"
    />
  ),
  drop: (
    <path d="M20 3.5c8.8 0 15.5 6.2 15.5 14.6 0 9-7.2 15.3-15.5 18.4C11.7 33.4 4.5 27.1 4.5 18.1 4.5 9.7 11.2 3.5 20 3.5Z" />
  ),
  gem: <rect x="7.5" y="7.5" width="25" height="25" rx="8" transform="rotate(45 20 20)" />,
};

export type BodyName = keyof typeof BODIES;

const BODY_NAMES = Object.keys(BODIES) as BodyName[];

/** Every colour reads against the visor at 5.6:1 or better. */
export const CHARACTER_COLORS = [
  "#58c26f",
  "#5b8dff",
  "#ff8552",
  "#a98bff",
  "#f6bd3b",
  "#ff6f9c",
  "#45bdf5",
  "#a5d955",
] as const;

export type CharacterSpec = {
  body: BodyName;
  color: string;
  /** Degrees the visor leans. */
  tilt: number;
  /** Where the eyes look, in grid units. */
  look: [number, number];
  /** Moves the visor up (negative) or down. */
  lift?: number;
};

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (const char of text) {
    h ^= char.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** The character for a bot id. Stable across devices and restarts. */
export function characterFor(id: string): CharacterSpec {
  const angle = ((hash(`${id}:look`) % 8) / 8) * Math.PI * 2;
  return {
    body: BODY_NAMES[hash(`${id}:body`) % BODY_NAMES.length]!,
    color: CHARACTER_COLORS[hash(`${id}:colour`) % CHARACTER_COLORS.length]!,
    tilt: (hash(`${id}:tilt`) % 15) - 7,
    look: [Math.round(Math.cos(angle) * 8) / 10, Math.round(Math.sin(angle) * 5) / 10],
  };
}

export function Character({ spec }: { spec: CharacterSpec }) {
  const y = 19.3 + (spec.lift ?? 0);
  const [lx, ly] = spec.look;
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <g fill={spec.color} stroke={spec.color} strokeWidth="0">
        {BODIES[spec.body]}
      </g>
      <g transform={`rotate(${spec.tilt} 20 ${y})`}>
        <rect x="8.8" y={y - 4.8} width="22.4" height="9.6" rx="4.8" fill="#16181b" />
        <g fill="#fff">
          <circle cx={15.8 + lx} cy={y + ly} r="2.05" />
          <circle cx={24.2 + lx} cy={y + ly} r="2.05" />
        </g>
      </g>
    </svg>
  );
}

/**
 * A bot's avatar: its own picture cropped to a circle when the gateway gives
 * one, otherwise its character. No frame, ring or badge. Sized by CSS.
 */
export function Avatar({ bot, className }: { bot: Bot; className?: string }) {
  return (
    <span className={className ? `avatar ${className}` : "avatar"} aria-hidden="true">
      {bot.avatarUrl ? (
        <img src={bot.avatarUrl} alt="" draggable={false} />
      ) : (
        <Character spec={characterFor(bot.id)} />
      )}
    </span>
  );
}
