// A bot's avatar: its picture cropped to a circle when the gateway gives one,
// otherwise its creature, drawn from core's shared spec as the desktop draws it
// (`Creature.tsx`). The primary bot carries the star at its lower right
// (F-015), a neutral disc as on the desktop.

import { avatarFor, avatarVariation, defaultAvatar, type Bot } from "@clawtrate/core";
import { useMemo, useState, type ReactElement } from "react";
import { Image, View } from "react-native";
import { useTheme } from "../theme/index.ts";
import { Creature } from "./Creature.tsx";
import { StarIcon } from "./icons.tsx";

function PictureOr({ url, size, children }: { url: string; size: number; children: ReactElement }) {
  const [failed, setFailed] = useState(false);
  if (failed) return children;
  return (
    <Image
      source={{ uri: url }}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      resizeMode="cover"
      accessibilityIgnoresInvertColors
      onError={() => setFailed(true)}
    />
  );
}

/** The picture the gateway gives this bot, or its shared creature and pose. */
export function Avatar({
  bot,
  size,
  primary = false,
  state = "idle",
}: {
  bot: Bot;
  size: number;
  primary?: boolean;
  state?: string;
}) {
  const { c } = useTheme();
  const { id, avatarUrl } = bot;
  const avatar = useMemo(() => avatarFor({ id, avatarUrl }), [id, avatarUrl]);
  const variation = useMemo(() => avatarVariation(id), [id]);
  const fallback = useMemo(() => defaultAvatar(id), [id]);
  const creature = (
    <Creature
      choice={avatar.kind === "creature" ? avatar.choice : fallback}
      variation={variation}
      size={size}
      state={state}
    />
  );

  return (
    <View style={{ width: size, height: size }}>
      <View testID={state === "working" ? "avatar-working" : undefined}>
        {avatar.kind === "image" ? (
          <PictureOr key={avatar.url} url={avatar.url} size={size}>
            {creature}
          </PictureOr>
        ) : (
          creature
        )}
      </View>
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
