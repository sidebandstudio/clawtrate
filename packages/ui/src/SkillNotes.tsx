import { skillNoteWords, updateNoticeText, type TranscriptItem } from "@clawtrate/core";
import { useContext, useState } from "react";
import { ActionEnvContext } from "./actions/ActionCards.tsx";
import { useBridge, useClawtrateState } from "./bridge.tsx";
import { ChevronIcon } from "./icons.tsx";
import { screenStamp, shownStamp } from "./stamp.ts";

/** The gateway's skill notes folded into a line (F-560): only items that carry one. */
export type SkillNoteItem = TranscriptItem & {
  skillNote: NonNullable<TranscriptItem["skillNote"]>;
};

/** What the folded line says for these notes, in their own words ("Saved a skill: …"). */
export const skillNotesWords = (notes: readonly SkillNoteItem[]) =>
  skillNoteWords(notes.map((note) => note.skillNote));

type UndoPhase =
  | { status: "ready" }
  | { status: "busy" }
  | { status: "done"; words: string }
  | { status: "failed"; words: string };

/**
 * A note's undo, the gateway's own way where this connection may use it. A marked note (OpenClaw
 * 2026.11.10) is undone by the gateway (`skills.workshop.undo`), which needs admin access. An
 * unmarked one (2026.10.6) is undone by the bot when asked in the task: the button sends exactly
 * "undo", and says so. A connection that can do neither shows what it would take, or nothing;
 * so does a host pinned read-only. Once done, the button stays where it was, so focus stays.
 */
function SkillNoteUndo({
  note,
  taskKey,
  botName,
}: {
  note: SkillNoteItem;
  taskKey: string;
  botName: string;
}) {
  const bridge = useBridge();
  const { connection } = useClawtrateState();
  // The gateway this note was drawn from: the undo goes only to that one.
  const [shown] = useState(() => shownStamp(bridge.getState().connection));
  const [phase, setPhase] = useState<UndoPhase>({ status: "ready" });
  // What this viewer may change: a host pinned read-only changes nothing.
  const readOnly = useContext(ActionEnvContext)?.readOnly ?? !connection.canWrite;
  const online = connection.status === "connected";
  const { agentId, reviewId } = note.skillNote;
  const byGateway = agentId !== null;
  if (readOnly) return null;
  if (byGateway && !connection.canAdmin)
    return (
      <p className="skill-note-undo" data-testid="skill-note-undo">
        Undoing it needs admin access to this gateway.
      </p>
    );
  const press = () => {
    if (phase.status === "busy" || phase.status === "done" || !online) return;
    setPhase({ status: "busy" });
    const fail = (error: unknown) =>
      setPhase({
        status: "failed",
        words: `Couldn't undo it. ${error instanceof Error ? error.message : String(error)}`,
      });
    if (byGateway) {
      void screenStamp(bridge, shown)
        .then((stamp) => bridge.invoke({ type: "undoSkillChange", agentId, reviewId, stamp }))
        .then(
          ({ undone }) =>
            setPhase({ status: "done", words: undone ? "Undone." : "It was already undone." }),
          fail,
        );
    } else {
      void bridge
        .invoke({
          type: "sendMessage",
          key: taskKey,
          text: "undo",
          mode: "auto",
          attachmentIds: [],
        })
        .then(() => setPhase({ status: "done", words: `Sent "undo" to ${botName}.` }), fail);
    }
  };
  const label = byGateway ? "Undo" : `Send "undo" to ${botName}`;
  return (
    <div className="skill-note-undo" data-testid="skill-note-undo">
      <button
        type="button"
        className="button"
        onClick={press}
        aria-disabled={!online || phase.status === "busy" || phase.status === "done" || undefined}
        aria-busy={phase.status === "busy" || undefined}
        aria-label={byGateway ? `Undo: ${skillNotesWords([note])}` : undefined}
      >
        {label}
      </button>
      <span role="status">
        {phase.status === "done" || phase.status === "failed" ? phase.words : ""}
      </span>
    </div>
  );
}

/** Under a line that folds skill notes: each note's own text, whole, and its undo. */
export function SkillNoteBody({
  notes,
  taskKey,
  botName,
}: {
  notes: readonly SkillNoteItem[];
  taskKey: string;
  botName: string;
}) {
  return (
    <div className="skill-notes" data-testid="skill-notes">
      {notes.map((note) => (
        <div
          className="skill-note"
          key={note.id}
          data-testid="skill-note"
          // The row's gateway id, so a search hit on it is brought into view as a message's is.
          data-message={note.messageId}
        >
          <p className="skill-note-text">{updateNoticeText(note)}</p>
          <SkillNoteUndo note={note} taskKey={taskKey} botName={botName} />
        </div>
      ))}
    </div>
  );
}

/**
 * Skill notes that follow no run's line (a note after a run with no actions, or the first thing
 * on a history page): the same quiet line on its own, "Saved a skill: …", opening to the notes.
 */
export function SkillNoteLine({
  notes,
  taskKey,
  botName,
}: {
  notes: readonly SkillNoteItem[];
  taskKey: string;
  botName: string;
}) {
  const [open, setOpen] = useState(false);
  const words = skillNotesWords(notes);
  return (
    <details
      className="run-line skill-note-line"
      data-testid="skill-note-line"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="event-line" aria-label={words}>
        <span className="run-skill">{words}</span>
        <ChevronIcon className="chevron" />
      </summary>
      <SkillNoteBody notes={notes} taskKey={taskKey} botName={botName} />
    </details>
  );
}
