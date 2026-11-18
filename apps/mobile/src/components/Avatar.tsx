// A bot's avatar: its picture cropped to a circle when the gateway gives one,
// otherwise its character, drawn from the same shapes and hash as the desktop
// (`@clawtrate/ui/character`). The primary bot carries the star at its lower
// right (F-015), a neutral disc as on the desktop.

import type { Bot } from "@clawtrate/core";
import {
  BODIES,
  characterFor,
  eyesOf,
  EYE_COLOR,
  VISOR_COLOR,
  visorOf,
  visorY,
  type FaceState,
  type Shape,
} from "@clawtrate/ui/character";
import { Image, View } from "react-native";
import Svg, { Circle, Ellipse, G, Path, Rect } from "react-native-svg";
import { useTheme } from "../theme/index.ts";
import { StarIcon } from "./icons.tsx";

function ShapeElement({ shape }: { shape: Shape }) {
  const { el, ...attributes } = shape;
  switch (el) {
    case "circle":
      return <Circle {...attributes} />;
    case "ellipse":
      return <Ellipse {...attributes} />;
    case "rect":
      return <Rect {...attributes} />;
    case "path":
      return <Path {...attributes} />;
  }
}

export function Character({
  id,
  size,
  state = "idle",
}: {
  id: string;
  size: number;
  state?: FaceState;
}) {
  const spec = characterFor(id);
  const y = visorY(spec);
  const { el: _el, ...visor } = visorOf(y);
  return (
    <Svg width={size} height={size} viewBox="0 0 40 40">
      <G fill={spec.color} stroke={spec.color} strokeWidth={0}>
        {BODIES[spec.body].map((shape, index) => (
          <ShapeElement key={index} shape={shape} />
        ))}
      </G>
      <G transform={`rotate(${spec.tilt} 20 ${y})`}>
        <Rect {...visor} fill={VISOR_COLOR} />
        <G fill={EYE_COLOR}>
          {eyesOf(state, spec.look, y).map((shape, index) => (
            <ShapeElement key={index} shape={shape} />
          ))}
        </G>
      </G>
    </Svg>
  );
}

export function Avatar({
  bot,
  size,
  primary = false,
  state = "idle",
}: {
  bot: Bot;
  size: number;
  primary?: boolean;
  state?: FaceState;
}) {
  const { c } = useTheme();
  return (
    <View style={{ width: size, height: size }}>
      {bot.avatarUrl ? (
        <Image
          source={{ uri: bot.avatarUrl }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <Character id={bot.id} size={size} state={state} />
      )}
      {primary && (
        <View
          testID="primary-star"
          style={{
            position: "absolute",
            right: -2,
            bottom: -2,
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: c["bg-inverse"],
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <StarIcon color={c["text-inverse"]} size={11} />
        </View>
      )}
    </View>
  );
}
