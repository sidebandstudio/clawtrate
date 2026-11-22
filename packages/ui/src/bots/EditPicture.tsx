// Edit picture (bots.md section 8): the Work pane's picture opens the same
// picker New bot has. Save sends the picture to the gateway with
// `agents.update` and closes once the gateway's bot list shows it.

import type { Bot } from "@clawtrate/core";
import { useRef, useState } from "react";
import { useBridge } from "../bridge.tsx";
import { CloseIcon } from "../icons.tsx";
import { AvatarPicker, PicturePreview, draftOf, pictureFor } from "./AvatarPicker.tsx";
import { Dialog } from "./Dialog.tsx";
import { useAnnouncer } from "./parts.tsx";

export function EditPicture({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const bridge = useBridge();
  const [draft, setDraft] = useState(() => draftOf(bot));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [announcer, announce] = useAnnouncer();
  const previewRef = useRef<HTMLSpanElement>(null);
  const save = async () => {
    setSaving(true);
    setProblem(null);
    try {
      const avatar = await pictureFor(draft, previewRef.current?.querySelector("svg"));
      if (!avatar) throw new Error("The picture couldn't be drawn.");
      await bridge.invoke({ type: "setBotPicture", botId: bot.id, avatar });
      announce("Picture saved");
      onClose();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setSaving(false);
    }
  };
  return (
    <Dialog kind="create" labelledBy="picture-title" onClose={onClose} testId="edit-picture">
      <div className="b-sheet">
        <header className="b-head">
          <h2 id="picture-title" tabIndex={-1}>
            {bot.name}'s picture
          </h2>
          <button
            type="button"
            className="icon-button b-close"
            aria-label="Close"
            title="Close (Esc)"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </header>
        <div className="b-body">
          <PicturePreview
            draft={draft}
            label={`${bot.name}'s new picture`}
            previewRef={previewRef}
          />
          <AvatarPicker draft={draft} onChange={setDraft} />
        </div>
        <footer className="b-foot">
          {problem && (
            <p className="b-field-error" role="alert" style={{ textAlign: "center", margin: 0 }}>
              Couldn't save the picture. {problem}
            </p>
          )}
          <button
            type="button"
            className="button"
            data-variant="primary"
            data-size="lg"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
        {announcer}
      </div>
    </Dialog>
  );
}
