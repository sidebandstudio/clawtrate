import {
  AVATAR_EYE_CLIP,
  AVATAR_MOTIONS,
  avatarFor,
  avatarPose,
  avatarScene,
  avatarVariation,
  type AvatarChoice,
  type AvatarMotionName,
  type AvatarShape,
  type AvatarVariation,
  type Bot,
} from "@clawtrate/core";
import { useId, useInsertionEffect, type CSSProperties, type ReactElement } from "react";
import "./styles/avatars.css";

// Bot avatars (visual-language.md, section 5): Clawtrate's creatures, drawn as
// inline SVG from the shared spec in `@clawtrate/core` (`avatar.ts`). A bot
// that chose none gets the Clawling its id gives; a bot whose gateway identity
// carries its own picture shows the picture in a circle.

/** The states a creature can show (conversation.md, section 4). */
export type FaceState =
  "idle" | "thinking" | "working" | "waiting" | "blocked" | "done" | "failed" | "stopped";

const easing = ([a, b, c, d]: [number, number, number, number]) =>
  `cubic-bezier(${a}, ${b}, ${c}, ${d})`;

/** The spec's keyframes as CSS, `av-<motion>` each. */
export function avatarKeyframes(): string {
  return Object.entries(AVATAR_MOTIONS)
    .map(([name, motion]) => {
      const frames = motion.frames.map((frame) => {
        const rules: string[] = [];
        if (frame.translate)
          rules.push(`translate: ${frame.translate[0]}px ${frame.translate[1]}px`);
        if (frame.rotate !== undefined) rules.push(`rotate: ${frame.rotate}deg`);
        if (frame.scale !== undefined) rules.push(`scale: ${frame.scale}`);
        if (frame.opacity !== undefined) rules.push(`opacity: ${frame.opacity}`);
        if (frame.dash) rules.push(`stroke-dasharray: ${frame.dash[0]} ${frame.dash[1]}`);
        if (frame.dashOffset !== undefined) rules.push(`stroke-dashoffset: ${frame.dashOffset}`);
        return `${Math.round(frame.at * 1000) / 10}%{${rules.join(";")}}`;
      });
      return `@keyframes av-${name}{${frames.join("")}}`;
    })
    .join("\n");
}

/** The keyframes, added to the document once, before the first creature paints. */
function useKeyframes() {
  useInsertionEffect(() => {
    if (document.getElementById("avatar-keyframes")) return;
    const style = document.createElement("style");
    style.id = "avatar-keyframes";
    style.textContent = avatarKeyframes();
    document.head.append(style);
  }, []);
}

function animation(name: AvatarMotionName, delay = 0): string {
  const motion = AVATAR_MOTIONS[name];
  return `av-${name} ${motion.duration}ms ${easing(motion.easing)} ${delay}ms infinite`;
}

function Shape({ shape, clip }: { shape: AvatarShape; clip: string }): ReactElement {
  const style: CSSProperties & Record<string, string> = {};
  if (shape.origin) {
    style.transformBox = "view-box";
    style.transformOrigin = `${shape.origin[0]}px ${shape.origin[1]}px`;
  }
  if (shape.rotate) style.rotate = `${shape.rotate}deg`;
  if (shape.motion) style.animation = animation(shape.motion, shape.delay);
  if (shape.still !== undefined) style["--av-still"] = `${shape.still}deg`;
  const className = [shape.fine && "av-fine", shape.still !== undefined && "av-still"]
    .filter(Boolean)
    .join(" ");
  const props = {
    ...(className ? { className } : {}),
    ...(Object.keys(style).length > 0 ? { style } : {}),
    ...(shape.part ? { "data-part": shape.part } : {}),
    ...(shape.fill ? { fill: shape.fill } : {}),
    ...(shape.stroke ? { stroke: shape.stroke } : {}),
    ...(shape.strokeWidth !== undefined ? { strokeWidth: shape.strokeWidth } : {}),
    ...(shape.round ? { strokeLinecap: "round" as const, strokeLinejoin: "round" as const } : {}),
    ...(shape.opacity !== undefined ? { opacity: shape.opacity } : {}),
    ...(shape.dash
      ? { pathLength: 100, strokeDasharray: `${shape.dash[0]} ${shape.dash[1]}` }
      : {}),
    ...(shape.fixedStroke ? { vectorEffect: "non-scaling-stroke" as const } : {}),
    ...(shape.transform ? { transform: shape.transform } : {}),
    ...(shape.clip ? { clipPath: `url(#${clip}-${shape.clip})` } : {}),
  };
  switch (shape.kind) {
    case "path":
      return <path {...props} d={shape.d} />;
    case "circle":
      return <circle {...props} cx={shape.cx} cy={shape.cy} r={shape.r} />;
    case "ellipse":
      return <ellipse {...props} cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} />;
    case "rect":
      return (
        <rect
          {...props}
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          {...(shape.rx !== undefined ? { rx: shape.rx } : {})}
        />
      );
    case "group":
      return (
        <g {...props}>
          {shape.children.map((child, index) => (
            <Shape key={index} shape={child} clip={clip} />
          ))}
        </g>
      );
  }
}

/** A creature in a state, as inline SVG on the 40-unit grid. Sized by CSS. */
export function Creature({
  choice,
  state = "idle",
  variation = { gaze: [0.6, 0.2], blink: 0 },
}: {
  choice: AvatarChoice;
  state?: FaceState;
  variation?: AvatarVariation;
}) {
  useKeyframes();
  const clip = `av${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const scene = avatarScene(choice, avatarPose(state), variation);
  return (
    <svg
      viewBox="0 0 40 40"
      className="creature"
      data-family={choice.family}
      data-state={scene.state}
      {...(scene.muted ? { "data-muted": "" } : {})}
      aria-hidden="true"
    >
      <defs>
        {Object.entries(AVATAR_EYE_CLIP).map(([name, r]) => (
          <clipPath key={name} id={`${clip}-${name}`}>
            <circle r={r} />
          </clipPath>
        ))}
      </defs>
      <Shape shape={scene.root} clip={clip} />
    </svg>
  );
}

/** A bot's face: its own picture, or its creature in the state given. */
function Face({ bot, state }: { bot: Bot; state: FaceState }) {
  const avatar = avatarFor(bot);
  if (avatar.kind === "image") return <img src={avatar.url} alt="" draggable={false} />;
  return <Creature choice={avatar.choice} state={state} variation={avatarVariation(bot.id)} />;
}

/**
 * A bot's avatar: its own picture cropped to a circle when the gateway gives
 * one, otherwise its creature, at rest or acting out `state`. No frame, ring
 * or badge. Sized by CSS.
 */
export function Avatar({
  bot,
  className,
  state = "idle",
}: {
  bot: Bot;
  className?: string;
  state?: FaceState;
}) {
  return (
    <span className={className ? `avatar ${className}` : "avatar"} aria-hidden="true">
      <Face bot={bot} state={state} />
    </span>
  );
}

const STATE_WORDS: Record<FaceState, string> = {
  idle: "idle",
  thinking: "thinking",
  working: "working",
  waiting: "waiting for you",
  blocked: "blocked",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

/**
 * A bot's avatar with its state (conversation.md, section 4): the creature
 * acting out the state, the ring that travels while a tool runs, and a badge
 * for the states that need the person or went wrong. Named "<Bot>, <state>"
 * unless `hidden`, for where the control around it already says the state.
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
      data-kind={avatarFor(bot).kind === "image" ? "image" : "character"}
      {...(hidden
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": `${bot.name}, ${STATE_WORDS[state]}` })}
    >
      <span className="avatar" aria-hidden="true">
        <Face bot={bot} state={state} />
      </span>
      {badge && <span className="glyph" data-state={badge} aria-hidden="true" />}
    </span>
  );
}
