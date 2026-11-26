// The files a person sent, under their message and on its side (F-557), as the
// desktop shows them (`packages/ui/src/SentFiles.tsx`). A picture is read once it
// is on screen: a quiet placeholder keeps its place while it loads, and a tap opens
// it larger. A line shows only when it can't be shown, with Try again when the read
// failed. Any other file is its name and size.

import type { SentAttachment } from "@clawtrate/core";
import { useEffect, useRef, useState } from "react";
import { Image, Modal, Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRuntime } from "../runtime.ts";
import {
  drawsAsPicture,
  fileSize,
  pictureRatio,
  SENT_PICTURE_LINES,
  sentPictureAlt,
  type SentPictureShown,
} from "../presentation/sent-files.ts";
import { loadSentPicture } from "../sent-pictures.ts";
import { S, useTheme, type Theme } from "../theme/index.ts";
import { shownStamp, type ShownStamp } from "../../../../packages/ui/src/stamp.ts";
import { CloseIcon, FileIcon } from "./icons.tsx";
import { Button, Txt } from "./ui.tsx";

/** A picture's frame, the desktop's: 70% of the row and at most 280 points wide, in its proportions. */
const frame = (c: Theme["c"], ratio: number): ViewStyle => ({
  width: "70%",
  maxWidth: 280,
  minHeight: 72,
  aspectRatio: ratio,
  borderRadius: S["radius-lg"],
  borderWidth: 1,
  borderColor: c.border,
  backgroundColor: c["bg-inset"],
  overflow: "hidden",
});

/** A file's name and size, and the line that says why a picture isn't shown. */
function FileLine({
  file,
  line,
  testID,
  onRetry,
}: {
  file: SentAttachment;
  line: string | null;
  testID: string;
  onRetry?: (() => void) | undefined;
}) {
  const { c } = useTheme();
  const size = file.sizeBytes === null ? "" : fileSize(file.sizeBytes);
  return (
    <View
      style={{
        maxWidth: "86%",
        paddingVertical: 8,
        paddingHorizontal: 12,
        gap: 6,
        borderRadius: S["radius-md"],
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c["bg-inset"],
      }}
    >
      <View
        testID={testID}
        accessible
        accessibilityLabel={[[file.fileName, size].filter(Boolean).join(", "), line]
          .filter(Boolean)
          .join(". ")}
        style={{ gap: 2 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <FileIcon color={c["text-muted"]} />
          <Txt size={S["text-sm"]} style={{ flexShrink: 1 }}>
            {file.fileName}
          </Txt>
          {size !== "" && (
            <Txt size={S["text-sm"]} color="text-muted">
              {size}
            </Txt>
          )}
        </View>
        {line !== null && (
          <Txt size={S["text-sm"]} color="text-muted">
            {line}
          </Txt>
        )}
      </View>
      {onRetry && (
        <Button
          label="Try again"
          onPress={onRetry}
          testID="sent-picture-retry"
          style={{ backgroundColor: c.bg }}
        />
      )}
    </View>
  );
}

/** A picture over the whole app, at its own size and never larger; Close or the backdrop closes it. */
function PictureViewer({
  uri,
  alt,
  size,
  onClose,
}: {
  uri: string;
  alt: string;
  size: { width: number; height: number } | null;
  onClose: () => void;
}) {
  const { c } = useTheme();
  const inset = useSafeAreaInsets();
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View
        accessibilityViewIsModal
        testID="picture-viewer"
        style={{
          flex: 1,
          paddingTop: inset.top,
          paddingBottom: inset.bottom,
          paddingLeft: inset.left,
          paddingRight: inset.right,
        }}
      >
        <Pressable
          accessible={false}
          onPress={onClose}
          style={[StyleSheet.absoluteFill, { backgroundColor: c.bg, opacity: 0.96 }]}
        />
        {/* Close at the top, inside the safe area: the system's bar takes taps above it. */}
        <View
          pointerEvents="box-none"
          style={{ alignItems: "flex-end", paddingTop: 12, paddingHorizontal: 16 }}
        >
          <Pressable
            testID="picture-viewer-close"
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={onClose}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingVertical: 8,
              paddingHorizontal: 12,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: c.border,
              backgroundColor: pressed ? c["bg-selected"] : c.bg,
            })}
          >
            <CloseIcon color={c.text} />
            <Txt size={S["text-sm"]}>Close</Txt>
          </Pressable>
        </View>
        <View
          pointerEvents="box-none"
          style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16 }}
        >
          <Image
            source={{ uri }}
            accessible
            accessibilityRole="image"
            accessibilityLabel={alt}
            resizeMode="contain"
            style={{
              width: "100%",
              height: "100%",
              ...(size ? { maxWidth: size.width, maxHeight: size.height } : {}),
            }}
          />
        </View>
      </View>
    </Modal>
  );
}

/** One picture you sent, in each of its states. */
function SentPicture({
  taskKey,
  messageKey,
  index,
  file,
  onScreen,
}: {
  taskKey: string;
  messageKey: string | null;
  index: number;
  file: SentAttachment;
  onScreen: boolean;
}) {
  const { send, client } = useRuntime();
  const { c } = useTheme();
  const [shown, setShown] = useState<SentPictureShown>(
    messageKey ? { status: "loading" } : { status: "cannot-load" },
  );
  const [attempt, setAttempt] = useState(0);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [open, setOpen] = useState(false);
  // Where this chat was drawn: a picture read back goes only to that gateway.
  const drawnOn = useRef<ShownStamp | null>(null);
  useEffect(() => {
    if (!messageKey || !onScreen) return;
    let current = true;
    drawnOn.current ??= shownStamp(client.store.get().connection);
    const source = { getState: client.store.get, subscribe: client.store.subscribe };
    void loadSentPicture(send, source, drawnOn.current, { key: taskKey, messageKey, index }).then(
      (next) => {
        if (current) setShown(next);
      },
    );
    return () => {
      current = false;
    };
  }, [send, client, taskKey, messageKey, index, onScreen, attempt]);

  const alt = sentPictureAlt(file);
  if (shown.status === "loading")
    return (
      <View
        testID="sent-picture"
        accessible
        accessibilityLabel={`Loading ${alt}`}
        accessibilityState={{ busy: true }}
        style={frame(c, 4 / 3)}
      />
    );
  if (shown.status === "shown")
    return (
      <>
        <Pressable
          testID="sent-picture"
          accessibilityRole="imagebutton"
          accessibilityLabel={alt}
          accessibilityHint="Opens it larger"
          onPress={() => setOpen(true)}
          style={frame(c, size ? pictureRatio(size.width, size.height) : 4 / 3)}
        >
          <Image
            source={{ uri: shown.uri }}
            resizeMode="contain"
            style={{ width: "100%", height: "100%" }}
            onLoad={({ nativeEvent }) =>
              setSize({ width: nativeEvent.source.width, height: nativeEvent.source.height })
            }
            onError={() => setShown({ status: "failed" })}
          />
        </Pressable>
        {open && (
          <PictureViewer uri={shown.uri} alt={alt} size={size} onClose={() => setOpen(false)} />
        )}
      </>
    );
  // Named as a picture, but its bytes aren't one, or it's over 5 MB: a file, by its name and size.
  if (shown.status === "not-a-picture")
    return <FileLine file={file} line={null} testID="sent-file" />;
  return (
    <FileLine
      file={file}
      line={SENT_PICTURE_LINES[shown.status]}
      testID="sent-picture"
      onRetry={
        shown.status === "failed"
          ? () => {
              setShown({ status: "loading" });
              setAttempt((n) => n + 1);
            }
          : undefined
      }
    />
  );
}

/**
 * Every file of your message, in its order, on the message's side. `messageKey` names the
 * message; `onScreen` says the message has come on screen, so its pictures are read.
 */
export function SentFiles({
  taskKey,
  messageKey,
  files,
  onScreen,
}: {
  taskKey: string;
  messageKey: string | null;
  files: readonly SentAttachment[];
  onScreen: boolean;
}) {
  return (
    <View testID="sent-files" style={{ alignSelf: "stretch", alignItems: "flex-end", gap: 6 }}>
      {files.map((file, index) =>
        drawsAsPicture(file) ? (
          <SentPicture
            key={index}
            taskKey={taskKey}
            messageKey={messageKey}
            index={index}
            file={file}
            onScreen={onScreen}
          />
        ) : (
          <FileLine key={index} file={file} line={null} testID="sent-file" />
        ),
      )}
    </View>
  );
}
