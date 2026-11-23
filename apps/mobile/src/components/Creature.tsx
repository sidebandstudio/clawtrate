// A creature (visual-language.md, section 5) from core's `avatarScene`, drawn
// with react-native-svg as `packages/ui/src/Avatar.tsx` draws it with SVG and
// CSS. Each moving part plays its keyframes from `AVATAR_MOTIONS`; with iOS's
// Reduce Motion on, nothing moves and a part with a still pose holds it.

import {
  AVATAR_EYE_CLIP,
  AVATAR_MOTIONS,
  avatarPose,
  avatarScene,
  type AvatarChoice,
  type AvatarMotionName,
  type AvatarShape,
  type AvatarVariation,
} from "@clawtrate/core";
import { memo, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { AccessibilityInfo, Easing } from "react-native";
import Svg, { Circle, ClipPath, Defs, Ellipse, G, Path, Rect } from "react-native-svg";
import {
  avatarElement,
  avatarFrame,
  avatarHold,
  fitTransform,
  type AvatarFrame,
  type AvatarSvgOptions,
} from "../presentation/avatar.ts";

/** Whether iOS's Reduce Motion is on. A creature starts still until iOS has answered. */
function useReduceMotion(animate: boolean): boolean {
  const [reduce, setReduce] = useState(true);
  useEffect(() => {
    if (!animate) return;
    let live = true;
    let changed = false;
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
      changed = true;
      setReduce(value);
    });
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (value) => {
        if (live && !changed) setReduce(value);
      },
      () => {},
    );
    return () => {
      live = false;
      subscription.remove();
    };
  }, [animate]);
  return reduce;
}

type ShapeProps = { shape: AvatarShape; options: AvatarSvgOptions };

function SvgElement({
  element,
  children,
}: {
  element: ReturnType<typeof avatarElement>;
  children?: ReactNode;
}) {
  if (!element) return null;
  switch (element.kind) {
    case "group":
      return <G {...element.props}>{children}</G>;
    case "path":
      return <Path {...element.props} />;
    case "circle":
      return <Circle {...element.props} />;
    case "ellipse":
      return <Ellipse {...element.props} />;
    case "rect":
      return <Rect {...element.props} />;
  }
}

function MotionElement({
  motion,
  shape,
  options,
  children,
}: ShapeProps & { motion: AvatarMotionName; children?: ReactNode }) {
  const delay = shape.delay ?? 0;
  const ease = useMemo(() => Easing.bezier(...AVATAR_MOTIONS[motion].easing), [motion]);
  const [frame, setFrame] = useState<AvatarFrame | undefined>(() =>
    avatarFrame(motion, 0, delay, ease),
  );
  useEffect(() => {
    const start = Date.now();
    let request = 0;
    let timer = 0;
    let previous = avatarFrame(motion, 0, delay, ease);
    const tick = () => {
      const elapsed = Date.now() - start;
      const next = avatarFrame(motion, elapsed, delay, ease);
      if (next !== previous) {
        previous = next;
        setFrame(next);
      }
      // A held pose (most of a blink's loop) waits on a timer, so an idle
      // creature does not wake the JavaScript thread on every screen frame.
      const hold = avatarHold(motion, elapsed, delay);
      if (hold > 32) timer = setTimeout(tick, hold);
      else request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(request);
      clearTimeout(timer);
    };
  }, [motion, ease, delay]);
  return <SvgElement element={avatarElement(shape, options, frame)}>{children}</SvgElement>;
}

const ShapeElement = memo(function ShapeElement({ shape, options }: ShapeProps) {
  const element = avatarElement(shape, options);
  if (!element) return null;
  const children =
    shape.kind === "group"
      ? shape.children.map((child, index) => (
          <ShapeElement key={index} shape={child} options={options} />
        ))
      : undefined;
  if (options.moving && shape.motion) {
    return (
      <MotionElement
        key={`${shape.motion}:${shape.delay ?? 0}`}
        motion={shape.motion}
        shape={shape}
        options={options}
      >
        {children}
      </MotionElement>
    );
  }
  return <SvgElement element={element}>{children}</SvgElement>;
});

/** A fitted creature from the shared avatar scene, drawn on its 40-unit grid. */
export function Creature({
  choice,
  variation,
  size,
  state = "idle",
  animate = true,
}: {
  choice: AvatarChoice;
  variation: AvatarVariation;
  size: number;
  state?: string;
  animate?: boolean;
}) {
  const clipId = `av${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const reduce = useReduceMotion(animate);
  const scene = useMemo(
    () => avatarScene(choice, avatarPose(state), variation),
    [choice, state, variation],
  );
  const moving = animate && !reduce;
  const options = useMemo(
    () => ({ size, clipId, muted: scene.muted, moving }),
    [size, clipId, scene.muted, moving],
  );

  return (
    <Svg width={size} height={size} viewBox="0 0 40 40">
      <Defs>
        {Object.entries(AVATAR_EYE_CLIP).map(([name, r]) => (
          <ClipPath key={name} id={`${clipId}-${name}`}>
            <Circle r={r} />
          </ClipPath>
        ))}
      </Defs>
      <G transform={fitTransform(scene)}>
        <ShapeElement shape={scene.root} options={options} />
      </G>
    </Svg>
  );
}
