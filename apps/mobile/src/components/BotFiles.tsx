// The files a bot handed over that aren't pictures, under the message that carried them
// (F-115), as the desktop shows them (`packages/ui/src/BotFiles.tsx`), in the look of the
// files you sent (`SentFiles.tsx`): a document icon, the file's name and size, and Save.
// Nothing is read until Save. Save then reads the file from the gateway whose history drew
// the row and opens the share sheet for it at once, with no question first (`bot-files.ts`).
// A line under the name says why a file can't be saved, or why Save failed, with Try again.

import type { ChatFile } from "@clawtrate/core";
import { useLayoutEffect, useRef, useState } from "react";
import { AccessibilityInfo, View } from "react-native";
import { saveBotFile } from "../bot-files.ts";
import { createViewer } from "../host/share.ts";
import { BOT_FILE_WORDS as W, botFileView, type BotFilePhase } from "../presentation/bot-files.ts";
import { fileSize } from "../presentation/sent-files.ts";
import { useRuntime } from "../runtime.ts";
import { S, TOUCH, useTheme } from "../theme/index.ts";
import type { ShownStamp } from "../../../../packages/ui/src/stamp.ts";
import { FileIcon } from "./icons.tsx";
import { Button, Txt } from "./ui.tsx";

function BotFile({
  taskKey,
  file,
  drawnOn,
  canLoad,
}: {
  taskKey: string;
  file: ChatFile;
  drawnOn: ShownStamp;
  canLoad: boolean;
}) {
  const { send, client, shareFile, redact } = useRuntime();
  const { c } = useTheme();
  const [phase, setPhase] = useState<BotFilePhase>({ status: "ready" });
  // A row that has left the screen reads nothing more and opens no sheet. It is marked gone in
  // the commit that removes it (a layout effect's cleanup runs then, not after paint), and that
  // reaches a share waiting to be presented at once (`host/share.ts`).
  const viewer = useRef(createViewer());
  useLayoutEffect(() => {
    if (viewer.current.gone()) viewer.current = createViewer();
    const shown = viewer.current;
    return () => shown.leave();
  }, []);
  const view = botFileView(file, phase, canLoad);
  const size = file.sizeBytes === null ? "" : fileSize(file.sizeBytes);

  const save = () => {
    if (view.busy) return;
    const shown = viewer.current;
    const source = { getState: client.store.get, subscribe: client.store.subscribe };
    void saveBotFile(
      send,
      source,
      drawnOn,
      taskKey,
      file,
      shareFile,
      (next) => {
        if (shown.gone()) return;
        setPhase(next);
        // Each state is said as it comes, as the desktop's live region says it.
        const note = botFileView(file, next, true).note;
        if (note) AccessibilityInfo.announceForAccessibility(note);
      },
      shown,
      redact,
    );
  };

  return (
    <View
      testID="bot-file"
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
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View
          testID="bot-file-info"
          accessible
          accessibilityLabel={[[file.name, size].filter(Boolean).join(", "), view.note]
            .filter(Boolean)
            .join(". ")}
          style={{ flexShrink: 1, gap: 2 }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <FileIcon color={c["text-muted"]} />
            <Txt size={S["text-sm"]} style={{ flexShrink: 1 }}>
              {file.name}
            </Txt>
            {size !== "" && (
              <Txt size={S["text-sm"]} color="text-muted">
                {size}
              </Txt>
            )}
          </View>
          {view.note !== null && (
            <Txt testID="bot-file-note" size={S["text-sm"]} color="text-muted">
              {view.note}
            </Txt>
          )}
        </View>
        {view.action !== null && (
          <Button
            label={view.action === "save" ? W.save : W.tryAgain}
            spoken={view.action === "save" ? `Save ${file.name}` : `Try again to save ${file.name}`}
            hint="Opens the share sheet"
            busy={view.busy}
            onPress={save}
            testID={view.action === "save" ? "bot-file-save" : "bot-file-retry"}
            // 44 points, the least a touch target takes, rather than the pill's 40.
            style={{ backgroundColor: c.bg, marginLeft: "auto", minHeight: TOUCH.taskRow }}
          />
        )}
      </View>
    </View>
  );
}

/** Each file of a bot's message, in its order, on the bot's side. */
export function BotFiles({
  taskKey,
  files,
  drawnOn,
  canLoad,
}: {
  taskKey: string;
  files: readonly ChatFile[];
  /** Where the history these rows come from was read: Save reads only from that gateway. */
  drawnOn: ShownStamp;
  /** The connection can load files from the gateway (`canLoadFiles`). */
  canLoad: boolean;
}) {
  return (
    <View testID="bot-files" style={{ alignSelf: "stretch", alignItems: "flex-start", gap: 6 }}>
      {files.map((file, index) => (
        <BotFile
          key={`${file.artifactId ?? "none"}:${index}`}
          taskKey={taskKey}
          file={file}
          drawnOn={drawnOn}
          canLoad={canLoad}
        />
      ))}
    </View>
  );
}
