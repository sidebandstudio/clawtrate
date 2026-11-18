import type { Bot } from "@clawtrate/core";
import {
  BODIES,
  characterFor,
  eyesOf,
  EYE_COLOR,
  FACE_WORDS,
  VISOR_COLOR,
  visorOf,
  visorY,
  type CharacterSpec,
  type FaceState,
  type Shape,
} from "./character.ts";

// Bot characters, drawn for Clawtrate: the shapes, colours and hash are in
// `character.ts`, which the iOS app draws from too, so a bot looks the same on
// every device.

export {
  CHARACTER_COLORS,
  characterFor,
  type BodyName,
  type CharacterSpec,
  type FaceState,
} from "./character.ts";

/** A rect shape's attributes. */
function rectOf({ el: _el, ...attributes }: Extract<Shape, { el: "rect" }>) {
  return attributes;
}

/** One shape of a character as an SVG element. */
function ShapeElement({ shape }: { shape: Shape }) {
  const { el, ...attributes } = shape;
  switch (el) {
    case "circle":
      return <circle {...attributes} />;
    case "ellipse":
      return <ellipse {...attributes} />;
    case "rect":
      return <rect {...attributes} />;
    case "path":
      return <path {...attributes} />;
  }
}

export function Character({ spec, state = "idle" }: { spec: CharacterSpec; state?: FaceState }) {
  const y = visorY(spec);
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <g fill={spec.color} stroke={spec.color} strokeWidth="0">
        {BODIES[spec.body].map((shape, index) => (
          <ShapeElement key={index} shape={shape} />
        ))}
      </g>
      <g transform={`rotate(${spec.tilt} 20 ${y})`}>
        <rect {...rectOf(visorOf(y))} fill={VISOR_COLOR} />
        <g className="eyes" fill={EYE_COLOR}>
          {eyesOf(state, spec.look, y).map((shape, index) => (
            <ShapeElement key={index} shape={shape} />
          ))}
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

/**
 * A bot's avatar with its state (conversation.md, section 4): the face, the
 * ring that travels while a tool runs, and a badge for the states that need
 * the person or went wrong. Named "<Bot>, <state>" unless `hidden`, for where
 * the control around it already says the state.
 */
export function Presence({
  bot,
  state,
  badge = null,
  hidden = false,
}: {
  bot: Bot;
  state: FaceState;
  badge?: "waiting" | "blocked" | "failed" | "stopped" | null;
  hidden?: boolean;
}) {
  return (
    <span
      className="presence"
      data-state={state}
      data-kind={bot.avatarUrl ? "image" : "character"}
      {...(hidden
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": `${bot.name}, ${FACE_WORDS[state]}` })}
    >
      <span className="avatar" aria-hidden="true">
        {bot.avatarUrl ? (
          <img src={bot.avatarUrl} alt="" draggable={false} />
        ) : (
          <Character spec={characterFor(bot.id)} state={state} />
        )}
      </span>
      {badge && <span className="glyph" data-state={badge} aria-hidden="true" />}
    </span>
  );
}
