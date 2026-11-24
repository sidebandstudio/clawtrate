// Edit picture (bots.md section 8): the Work pane's picture opens the same
// picker New bot has. Save sends the picture to the gateway with
// `agents.update` and closes once the gateway's bot list shows it. The pane
// owns the dialog: it opens it for one bot, and closes it when that bot, the
// connection or admin access goes.

import type { Bot, GatewayStamp } from "@clawtrate/core";
import { useLayoutEffect, useRef, useState } from "react";
import { useBridge } from "../bridge.tsx";
import { CloseIcon } from "../icons.tsx";
import {
  AvatarPicker,
  PicturePreview,
  draftOf,
  pictureFor,
  type PictureDraft,
} from "./AvatarPicker.tsx";
import { Dialog } from "./Dialog.tsx";

/** What the foot says when a save did not land. Fixed words: the gateway's own stay in its log. */
export const PICTURE_NOT_SAVED = "Couldn't save the picture. Your changes are still here.";
export const PICTURE_NOT_CONFIRMED = "The gateway hasn't confirmed this picture yet.";

const same = (a: PictureDraft, b: PictureDraft) =>
  a.upload === b.upload &&
  (a.upload !== null || JSON.stringify(a.choice) === JSON.stringify(b.choice));

export function EditPicture({
  bot,
  stamp,
  canSave,
  onClose,
  onSaved,
}: {
  bot: Bot;
  /** Where the pane is read now (`GatewayStamp`): nothing is written anywhere else. */
  stamp: GatewayStamp;
  /** Admin access on a live connection: what saving needs. */
  canSave: boolean;
  onClose: () => void;
  /** Told once the gateway's list shows the picture, after the dialog has gone. */
  onSaved: () => void;
}) {
  const bridge = useBridge();
  const [initial] = useState(() => draftOf(bot));
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const previewRef = useRef<HTMLSpanElement>(null);
  // Whether this opening still stands: not once it is closed or replaced, and not without access.
  // Layout effects, so the guard changes as the dialog is committed, before a save can resume.
  const live = useRef(true);
  const allowed = useRef(canSave);
  // The gateway's identity as the pane has it now, sent with the picture for the host to check.
  const gateway = useRef(stamp.gatewayId);
  useLayoutEffect(() => {
    gateway.current = stamp.gatewayId;
  }, [stamp.gatewayId]);
  // The host's target as the dialog opened: a Connect, Disconnect or switch since refuses the save.
  const [target] = useState(stamp.target);
  useLayoutEffect(() => {
    allowed.current = canSave;
  }, [canSave]);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const stands = () => live.current && allowed.current;
  const unchanged = same(draft, initial);
  const save = async () => {
    if (saving || busy || unchanged || !canSave) return;
    setSaving(true);
    setProblem(null);
    try {
      const avatar = await pictureFor(draft, previewRef.current?.querySelector("svg"));
      if (!stands()) return;
      if (!avatar) throw new Error("not drawn");
      const { confirmed } = await bridge.invoke({
        type: "setBotPicture",
        botId: bot.id,
        avatar,
        stamp: { gatewayId: gateway.current, target },
      });
      if (!stands()) return;
      if (!confirmed) {
        setProblem(PICTURE_NOT_CONFIRMED);
        setSaving(false);
        return;
      }
      onSaved();
      onClose();
    } catch {
      if (!stands()) return;
      setProblem(PICTURE_NOT_SAVED);
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
          <AvatarPicker draft={draft} onChange={setDraft} onBusy={setBusy} frozen={saving} />
        </div>
        <footer className="b-foot">
          {problem && (
            <p className="b-field-error" role="alert" style={{ textAlign: "center", margin: 0 }}>
              {problem}
            </p>
          )}
          <button
            type="button"
            className="button"
            data-variant="primary"
            data-size="lg"
            disabled={saving || busy || unchanged || !canSave}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </Dialog>
  );
}
