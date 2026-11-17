// Question cards (conversation.md section 13). Only an ordinary ask-user
// record is answerable here; any other is shown readable with its Raw. An
// answer names each chosen option by its place, as the engine gives it.

import type { QuestionAnswer, QuestionCard as Question, QuestionItem } from "@clawtrate/core";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useCardEnv } from "./context.tsx";
import { answeredRows, LETTERS, questionName, questionNote } from "./model.ts";
import {
  ArrowUpIcon,
  CardFoot,
  CloseIcon,
  Glyph,
  useRawDisclosure,
  type RawContent,
} from "./parts.tsx";

/**
 * Raw for a question: the record as the gateway sent it, which the engine keeps
 * (`question.requested`, or the same record from `question.list`). The engine
 * keeps the answers of a settled question but not the event that settled it,
 * so Raw says so and invents no event.
 */
function questionRaw(card: Question): RawContent {
  const notes: string[] = [];
  if (card.raw === null) notes.push("The question was too long for this app to keep as received.");
  if (card.status !== "pending") notes.push("This app does not keep the event that settled it.");
  return {
    state: "loaded",
    events:
      card.raw === null
        ? []
        : [
            [
              "The question record, as the gateway sent it (question.requested or question.list)",
              card.raw,
            ],
          ],
    ids: [
      { label: "Question", value: card.id },
      ...(card.runId ? [{ label: "Run", value: card.runId }] : []),
    ],
    ...(notes.length ? { notes } : {}),
  };
}

type Draft = { picked: number[]; own: string };

export function QuestionCardView({ card, domId }: { card: Question; domId: string }) {
  const env = useCardEnv();
  const raw = useRawDisclosure();
  const name = env.bot?.name ?? "The bot";
  const focusInside = useRef(false);
  const wasPending = useRef(card.status === "pending");
  const settled = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    if (wasPending.current && card.status !== "pending" && focusInside.current) {
      settled.current?.focus();
    }
    wasPending.current = card.status === "pending";
  }, [card.status]);

  const track = {
    onFocus: () => (focusInside.current = true),
    onBlur: (event: React.FocusEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        focusInside.current = false;
      }
    },
  };

  if (card.status !== "pending") {
    const run = env.runOf(card.runId);
    return (
      <section
        ref={settled}
        className="card request"
        data-kind="question"
        data-state={card.status}
        id={domId}
        tabIndex={-1}
        aria-label={`Question, ${card.status}: ${card.questions[0]?.question ?? ""}`}
        data-testid="question-card"
        {...track}
      >
        {card.questions.map((item) => (
          <div key={item.id} className="question-settled">
            <h3 className="request-title">{item.question || item.header}</h3>
            {card.status === "answered" ? (
              answeredRows(item, card.answers?.[item.id]).map((row, index) => (
                <div className="answer" key={index}>
                  {row.letter ? (
                    <span className="option-key" aria-hidden="true">
                      {row.letter}
                    </span>
                  ) : (
                    <span />
                  )}
                  <span>{row.text}</span>
                  <Glyph state="check" />
                </div>
              ))
            ) : (
              <div className="answer">
                <span />
                <span>{questionNote(card, run)}</span>
              </div>
            )}
          </div>
        ))}
        <CardFoot disclosure={raw} raw={questionRaw(card)} />
      </section>
    );
  }

  if (!card.ordinary) {
    return (
      <section
        className="card request"
        data-kind="question"
        data-state="unanswerable"
        id={domId}
        tabIndex={-1}
        role="region"
        aria-label={`${name} asked something this app can't answer yet`}
        data-testid="question-card"
      >
        <h3 className="request-title">{name} asked something this app can't answer yet</h3>
        {card.questions.map((item) => (
          <div key={item.id}>
            <p className="request-summary">{item.question || item.header}</p>
            {item.options.length > 0 && (
              <p className="request-foot">
                Options: {item.options.map((option) => option.label).join(" · ")}
                {item.optionsOmitted > 0 ? ` and ${item.optionsOmitted} more` : ""}
              </p>
            )}
          </div>
        ))}
        <p className="request-foot">State: pending. Nothing is sent for it from here.</p>
        <CardFoot disclosure={raw} raw={questionRaw(card)} />
      </section>
    );
  }

  return <PendingQuestion card={card} domId={domId} name={name} raw={raw} track={track} />;
}

function PendingQuestion({
  card,
  domId,
  name,
  raw,
  track,
}: {
  card: Question;
  domId: string;
  name: string;
  raw: ReturnType<typeof useRawDisclosure>;
  track: { onFocus: () => void; onBlur: (event: React.FocusEvent) => void };
}) {
  const env = useCardEnv();
  const items = card.questions;
  const several = items.length > 1;
  const instant = !several && items[0] !== undefined && !items[0].multiSelect;
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [focusIndex, setFocusIndex] = useState<Record<string, number>>({});
  const draftOf = (id: string): Draft => drafts[id] ?? { picked: [], own: "" };
  const readOnly = env.connected && !env.connection.canAnswer;
  const busy = card.submitting;

  const answered = items.filter((item) => {
    const draft = draftOf(item.id);
    return draft.picked.length > 0 || draft.own.trim() !== "";
  }).length;
  const ready = answered === items.length;

  const answersOf = (next: Record<string, Draft>): Record<string, QuestionAnswer[]> =>
    Object.fromEntries(
      items.map((item) => {
        const draft = next[item.id] ?? { picked: [], own: "" };
        const typed = draft.own.trim();
        return [
          item.id,
          typed !== ""
            ? [typed]
            : draft.picked.map((index) => ({ option: item.options[index]!.index })),
        ];
      }),
    );

  const submit = (next: Record<string, Draft> = drafts) => {
    if (busy) return;
    void env
      .invoke({
        type: "answerQuestion",
        key: env.taskKey,
        questionId: card.id,
        answers: answersOf(next),
      })
      .catch(() => undefined);
  };

  const dismiss = () => {
    if (busy) return;
    void env
      .invoke({ type: "dismissQuestion", key: env.taskKey, questionId: card.id })
      .catch(() => undefined);
  };

  const choose = (item: QuestionItem, index: number) => {
    if (busy || readOnly) return;
    const draft = draftOf(item.id);
    // Choosing an option clears the typed answer; several answers toggle.
    const picked = item.multiSelect
      ? draft.picked.includes(index)
        ? draft.picked.filter((each) => each !== index)
        : [...draft.picked, index].sort((a, b) => a - b)
      : [index];
    const next = { ...drafts, [item.id]: { picked, own: "" } };
    setDrafts(next);
    setFocusIndex((current) => ({ ...current, [item.id]: index }));
    if (instant) submit(next);
  };

  const type = (item: QuestionItem, own: string) =>
    setDrafts((current) => ({ ...current, [item.id]: { picked: [], own } }));

  const optionRefs = useRef<Record<string, Array<HTMLButtonElement | null>>>({});

  const onOptionKey = (item: QuestionItem, index: number, event: KeyboardEvent) => {
    const count = item.options.length;
    const move = (to: number) => {
      event.preventDefault();
      setFocusIndex((current) => ({ ...current, [item.id]: to }));
      optionRefs.current[item.id]?.[to]?.focus();
    };
    if (event.key === "ArrowDown") move((index + 1) % count);
    else if (event.key === "ArrowUp") move((index - 1 + count) % count);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(count - 1);
    else if ((event.key === " " || event.key === "Enter") && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      choose(item, index);
    } else if (/^[a-d]$/i.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const letter = LETTERS.indexOf(event.key.toUpperCase() as (typeof LETTERS)[number]);
      if (letter >= 0 && letter < count) {
        event.preventDefault();
        optionRefs.current[item.id]?.[letter]?.focus();
        choose(item, letter);
      }
    }
  };

  // ⌘↵ anywhere in the card sends when the answers are complete, including from a typed field.
  // Escape clears a typed draft first, and dismisses on the next press.
  const onCardKey = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      if (ready && !readOnly) submit();
      return;
    }
    if (event.key === "Escape" && !readOnly) {
      event.stopPropagation();
      const target = event.target as HTMLElement;
      const field = target.closest<HTMLElement>("[data-question]");
      const id = field?.dataset.question;
      if (target instanceof HTMLInputElement && id && draftOf(id).own !== "") {
        type(
          items.find((item) => item.id === id)!,
          "",
        );
        return;
      }
      dismiss();
    }
  };

  return (
    <section
      className="card request"
      data-kind="question"
      data-state="pending"
      data-pending="true"
      id={domId}
      tabIndex={-1}
      role="region"
      aria-label={questionName(card, name)}
      aria-busy={busy || undefined}
      data-testid="question-card"
      onKeyDown={onCardKey}
      {...track}
    >
      <header className="request-head">
        <h3 className="request-title">
          {several
            ? `${name} has ${items.length} questions`
            : items[0]?.question || items[0]?.header}
        </h3>
        {!readOnly && (
          <button
            type="button"
            className="icon-button"
            data-variant="quiet"
            aria-label={`Dismiss ${name}'s question${several ? "s" : ""}`}
            title="Dismiss"
            aria-disabled={busy || undefined}
            onClick={dismiss}
          >
            <CloseIcon />
          </button>
        )}
      </header>
      {items.map((item, number) => {
        const draft = draftOf(item.id);
        const focused = focusIndex[item.id] ?? draft.picked[0] ?? 0;
        const title = item.question || item.header;
        return (
          <div className="question" key={item.id} data-question={item.id}>
            {several && (
              <h4 className="question-title">
                <span>
                  {number + 1} of {items.length}
                </span>
                {title}
              </h4>
            )}
            {item.multiSelect && <p className="request-hint">Choose all that apply.</p>}
            <ul
              className="options"
              role={item.multiSelect ? "group" : "radiogroup"}
              aria-label={title}
            >
              {item.options.map((option, index) => (
                <li key={option.index}>
                  <button
                    ref={(element) => {
                      (optionRefs.current[item.id] ??= [])[index] = element;
                    }}
                    type="button"
                    className="option"
                    role={item.multiSelect ? "checkbox" : "radio"}
                    aria-checked={draft.picked.includes(index)}
                    aria-disabled={busy || readOnly || undefined}
                    tabIndex={index === focused ? 0 : -1}
                    onClick={() => choose(item, index)}
                    onKeyDown={(event) => onOptionKey(item, index, event)}
                  >
                    <span className="option-key" aria-hidden="true">
                      {LETTERS[index]}
                    </span>
                    <span>
                      {option.label}
                      {option.description && (
                        <span className="option-sub">{option.description}</span>
                      )}
                    </span>
                    <Glyph state="check" />
                  </button>
                </li>
              ))}
            </ul>
            {item.allowsOther && !readOnly && (
              <label className="own-answer">
                <span className="visually-hidden">
                  Type your own answer{several ? ` to question ${number + 1}` : ""}
                </span>
                <input
                  type="text"
                  placeholder="Type your own answer"
                  value={draft.own}
                  readOnly={busy}
                  aria-disabled={busy || undefined}
                  onChange={(event) => type(item, event.target.value)}
                  onKeyDown={(event) => {
                    // ⌘↵ is the card's own shortcut; plain Enter sends a single question's answer.
                    if (
                      instant &&
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.metaKey &&
                      !event.ctrlKey &&
                      draft.own.trim() !== ""
                    ) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                />
                {instant && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Send this answer"
                    disabled={draft.own.trim() === ""}
                    aria-disabled={busy || undefined}
                    onClick={() => submit()}
                  >
                    <ArrowUpIcon />
                  </button>
                )}
              </label>
            )}
          </div>
        );
      })}
      {readOnly && (
        <>
          <p className="request-ended">
            You can read this question but not answer it from this device.
          </p>
          <div className="request-actions">
            <button
              type="button"
              className="button"
              data-variant="primary"
              onClick={() => void env.send({ type: "requestAccess" })}
            >
              Request access
            </button>
          </div>
        </>
      )}
      {card.error && !busy && (
        <p className="standing-error" role="alert">
          <b>Couldn't send.</b> {card.error}
        </p>
      )}
      {!instant && !readOnly && (
        <div className="request-actions">
          <button
            type="button"
            className="button"
            data-variant="primary"
            disabled={!ready}
            aria-disabled={busy || undefined}
            onClick={() => submit()}
          >
            {busy ? "Sending…" : several ? "Send answers" : "Send answer"}
          </button>
          <span className="request-foot question-count">
            {several
              ? `${answered} of ${items.length} answered`
              : draftOf(items[0]!.id).picked.length > 0
                ? `${draftOf(items[0]!.id).picked.length} chosen`
                : draftOf(items[0]!.id).own.trim() !== ""
                  ? "Your own answer"
                  : "Nothing chosen yet"}
          </span>
        </div>
      )}
      <CardFoot disclosure={raw} raw={questionRaw(card)} />
    </section>
  );
}
