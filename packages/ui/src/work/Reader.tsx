// The reader (work-pane.md, sections 6 to 9): a file's name, its facts, its
// views, and every state the gateway's limits produce, each with its reason.

import {
  toBase64,
  fileChanges,
  fileMarks,
  fileSource,
  fileSteps,
  stepPatch,
  type CheckoutDiff,
  type ClawtrateBridge,
  type FileRead,
  type FileSource,
  type TaskFileList,
  type Transcript,
} from "@clawtrate/core";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { copyText, selectContents } from "../clipboard.ts";
import { clockTime, stampTime } from "../format.ts";
import { BackIcon, CopyIcon, DownloadIcon } from "../icons.tsx";
import { Markdown } from "../Markdown.tsx";
import { collect, isShown, type Shown } from "./content.ts";
import { downloadBytes } from "./download.ts";
import { folderOf, formatSize, limitSentence } from "./files-format.ts";
import { parseNumberedDiff, parsePatch, patchCounts, type Hunk } from "./patch.ts";

/** Where the file is read from. */
export type ReaderSource =
  | { kind: "task"; key: string; path: string }
  | { kind: "workspace"; botId: string; path: string; size: number | null; key: string | null };

export type View = "preview" | "source" | "changes";

const nameOf = (path: string) => path.split("/").pop() ?? path;
const isMarkdown = (name: string) => /\.(md|markdown|mdx)$/i.test(name);
/** Prose, for which "Wrap lines" is offered. */
const isProse = (name: string) => /\.(md|markdown|mdx|txt|log|rst|adoc)$/i.test(name);

/** How long "Updated just now" and a write that didn't finish stay. */
const NOTE_MS = 4000;

type Note = { text: string; tone: "quiet" | "working" } | null;

export function Reader({
  bridge,
  source,
  bot,
  transcript,
  list,
  now,
  initialView,
  focusStep,
  backLabel,
  onBack,
  onShowInChat,
  announce,
  headingRef,
}: {
  bridge: ClawtrateBridge;
  source: ReaderSource;
  bot: string;
  transcript: Transcript | undefined;
  list: TaskFileList | null;
  now: number;
  initialView: View | null;
  focusStep: string | null;
  backLabel: string;
  onBack: () => void;
  onShowInChat: (stepId: string) => void;
  announce: (text: string) => void;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  const name = nameOf(source.path);
  const [shown, setShown] = useState<Shown | null>(null);
  const [outcome, setOutcome] = useState<FileRead | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [wrap, setWrap] = useState(false);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const shownRef = useRef<Shown | null>(null);
  useEffect(() => {
    shownRef.current = shown;
  }, [shown]);
  const generation = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  /** Read the file again; `then` hears whether its bytes changed. */
  // The reader is keyed by its file: the source it was opened with is the one it reads.
  const sourceRef = useRef(source);
  const load = useCallback(
    (then?: (changed: boolean | null) => void) => {
      generation.current += 1;
      const mine = generation.current;
      setLoading(true);
      const source = sourceRef.current;
      const command =
        source.kind === "task"
          ? ({ type: "readTaskFile", key: source.key, path: source.path } as const)
          : ({
              type: "readWorkspaceFile",
              botId: source.botId,
              path: source.path,
              size: source.size,
              key: source.key,
            } as const);
      bridge
        .invoke(command)
        .then((read) => collect(bridge, read))
        .catch((error: unknown): FileRead => ({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        }))
        .then((result) => {
          if (mine !== generation.current) {
            return;
          }
          setLoading(false);
          if (isShown(result)) {
            const before = shownRef.current;
            const changed = before ? before.hash !== result.hash : null;
            if (!before || changed) setShown(result);
            setOutcome(null);
            setLoadedAt(Date.now());
            then?.(changed);
          } else {
            // Content loaded before stays under a failure or a missing file.
            setOutcome(result);
            if (result.status === "cannot-show") setShown(null);
            then?.(null);
          }
        });
    },
    [bridge],
  );

  // The reader is keyed by its file, so it starts empty; it reads once mounted.
  useEffect(() => {
    let live = true;
    queueMicrotask(() => {
      if (live) load();
    });
    return () => {
      live = false;
      generation.current += 1;
    };
  }, [load]);

  // While a file tool writes this path: say so; when its result lands, read it again.
  const path = source.path;
  const marks = useMemo(
    () => (transcript && source.kind === "task" ? fileMarks(transcript) : new Map()),
    [transcript, source.kind],
  );
  const writing = marks.get(path) === "writing";
  const wasWriting = useRef(writing);
  useEffect(() => {
    if (wasWriting.current && !writing) {
      const last = transcript ? fileSteps(transcript, path).at(-1) : undefined;
      const failed = last?.status === "failed";
      load((changed) => {
        if (changed) {
          setNote({ text: "Updated just now", tone: "quiet" });
          announce(`${name} updated`);
        } else if (failed && changed === false) {
          setNote({ text: `${bot}'s write didn't finish. The file is as it was.`, tone: "quiet" });
        }
      });
    }
    wasWriting.current = writing;
  }, [writing, transcript, path, load, announce, name, bot]);
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);

  // A newer modified time in the list (a command changed it): read it again.
  const listed = list?.files.find((file) => file.path === path);
  const listedAt = listed?.updatedAt ?? null;
  const loadedFor = shown?.facts.updatedAt ?? null;
  useEffect(() => {
    if (listedAt !== null && loadedFor !== null && listedAt > loadedFor && !writing) {
      queueMicrotask(() =>
        load((changed) => {
          if (changed) {
            setNote({ text: "Updated just now", tone: "quiet" });
            announce(`${name} updated`);
          }
        }),
      );
    }
    // Only a newer time in the list asks again.
  }, [listedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const changes = useMemo(
    () => (transcript && source.kind === "task" ? fileChanges(transcript, path) : []),
    [transcript, source.kind, path],
  );
  const checkout = source.kind === "task" && list?.gitCheckout === true;
  const sourceStep = transcript && source.kind === "task" ? fileSource(transcript, path) : null;

  const kind = shown?.kind ?? null;
  const views: View[] = [];
  if (kind === "text") {
    if (isMarkdown(name)) views.push("preview");
    views.push("source");
    if (changes.length > 0 || checkout) views.push("changes");
  }
  const [view, setView] = useState<View | null>(initialView);
  const current: View | null = view && views.includes(view) ? view : (views[0] ?? null);

  const facts = shown?.facts ?? (outcome && "facts" in outcome ? outcome.facts : null);

  const copy = async () => {
    if (!shown?.text) return;
    const result = await copyText(shown.text);
    if (result === "copied") {
      setActionNote(null);
      announce(`Copied ${name}`);
    } else {
      const body = bodyRef.current?.querySelector(".code-view, .reader-preview");
      if (body) selectContents(body);
      setActionNote("Couldn't copy. The text is selected.");
      announce("Couldn't copy. The text is selected.");
    }
  };
  const download = async () => {
    if (!shown) return;
    const result = await downloadBytes(bridge, name, shown.data);
    if (!result) return;
    setActionNote(
      result.ok
        ? null
        : `${result.announcement} ${"detail" in result ? (result.detail ?? "") : ""}`,
    );
    announce(result.announcement);
  };

  return (
    <div className="reader" data-testid="file-reader">
      <div className="files-head">
        <button
          type="button"
          className="icon-button"
          data-variant="quiet"
          aria-label={backLabel}
          title={`${backLabel} (⌘[)`}
          onClick={onBack}
        >
          <BackIcon />
        </button>
        <h3 tabIndex={-1} ref={headingRef} title={name}>
          {name}
        </h3>
        {shown && (
          <button
            type="button"
            className="icon-button"
            data-variant="quiet"
            aria-label={`Download ${name}`}
            title="Download"
            onClick={() => void download()}
          >
            <DownloadIcon />
          </button>
        )}
        {shown?.text !== null && shown?.text !== undefined && (
          <button
            type="button"
            className="icon-button"
            data-variant="quiet"
            aria-label={`Copy the text of ${name}`}
            title="Copy"
            onClick={() => void copy()}
          >
            <CopyIcon />
          </button>
        )}
      </div>
      <p className="reader-meta">
        {[
          folderOf(path) || null,
          formatSize(facts?.size ?? null) || null,
          facts?.updatedAt ? stampTime(facts.updatedAt, now) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {source.kind === "task" && (
        <SourceLine step={sourceStep} bot={bot} onShowInChat={onShowInChat} />
      )}
      {actionNote && (
        <p className="files-alert" role="status">
          {actionNote}
        </p>
      )}
      {writing && (
        <p className="reader-banner" data-testid="reader-writing">
          <span className="glyph" data-state="working" aria-hidden="true" />
          {bot} is writing this file. It updates when the write finishes.
        </p>
      )}
      {note && (
        <p className="reader-banner" data-testid="reader-note">
          {note.text}
        </p>
      )}
      {views.length > 1 && current && (
        <div className="seg reader-views" role="tablist" aria-label="View">
          {views.map((each) => (
            <button
              key={each}
              type="button"
              role="tab"
              aria-selected={current === each}
              tabIndex={current === each ? 0 : -1}
              onClick={() => setView(each)}
              onKeyDown={(event) => {
                const at = views.indexOf(each);
                const next =
                  event.key === "ArrowRight"
                    ? views[(at + 1) % views.length]
                    : event.key === "ArrowLeft"
                      ? views[(at - 1 + views.length) % views.length]
                      : null;
                if (!next) return;
                event.preventDefault();
                setView(next);
                (
                  event.currentTarget.parentElement?.querySelector(
                    `[data-view="${next}"]`,
                  ) as HTMLElement | null
                )?.focus();
              }}
              data-view={each}
            >
              {each === "preview" ? "Preview" : each === "source" ? "Source" : "Changes"}
            </button>
          ))}
        </div>
      )}
      {kind === "text" && isProse(name) && current === "source" && (
        <button
          type="button"
          className="link-button reader-wrap"
          aria-pressed={wrap}
          onClick={() => setWrap((on) => !on)}
        >
          Wrap lines
        </button>
      )}
      <Outcome
        outcome={outcome}
        name={name}
        bot={bot}
        loadedAt={loadedAt}
        hasContent={shown !== null}
        onRetry={() => load()}
        sourceStep={sourceStep}
        onShowInChat={onShowInChat}
        facts={facts}
      />
      {loading && !shown && !outcome && (
        <div className="files-loading" aria-busy="true" aria-label={`Opening ${name}`}>
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
      )}
      {shown && (
        <div
          className="reader-body"
          ref={bodyRef}
          tabIndex={0}
          aria-label={`${name}, ${current === "changes" ? "changes" : current === "preview" ? "preview" : "content"}`}
        >
          {current === "changes" && source.kind === "task" ? (
            <ChangesView
              key={changes.map((change) => change.stepId).join(" ")}
              bridge={bridge}
              taskKey={source.key}
              path={path}
              name={name}
              changes={changes}
              checkout={checkout}
              focusStep={focusStep}
              onShowInChat={onShowInChat}
              now={now}
            />
          ) : kind === "text" && current === "preview" ? (
            <div className="reader-preview">
              <Markdown text={shown.text ?? ""} />
            </div>
          ) : kind === "text" ? (
            <CodeView text={shown.text ?? ""} wrap={wrap} />
          ) : (
            <MediaView shown={shown} name={name} />
          )}
        </div>
      )}
    </div>
  );
}

function SourceLine({
  step,
  bot,
  onShowInChat,
}: {
  step: FileSource | null;
  bot: string;
  onShowInChat: (stepId: string) => void;
}) {
  if (!step)
    return (
      <p className="reader-source" data-none="true">
        No source in this task
      </p>
    );
  const verb =
    step.action === "read"
      ? "Read"
      : step.action === "write"
        ? "Written"
        : step.action === "edit"
          ? "Edited"
          : "Patched";
  return (
    <p className="reader-source">
      <span>
        {verb} by {bot}
        {step.at ? ` at ${clockTime(step.at)}` : ""}
      </span>
      <button type="button" className="link-button" onClick={() => onShowInChat(step.stepId)}>
        Show in chat
      </button>
    </p>
  );
}

function Outcome({
  outcome,
  name,
  bot,
  loadedAt,
  hasContent,
  onRetry,
  sourceStep,
  onShowInChat,
  facts,
}: {
  outcome: FileRead | null;
  name: string;
  bot: string;
  loadedAt: number | null;
  hasContent: boolean;
  onRetry: () => void;
  sourceStep: FileSource | null;
  onShowInChat: (stepId: string) => void;
  facts: {
    name: string;
    path: string;
    size: number | null;
    updatedAt: number | null;
    mimeType: string | null;
  } | null;
}) {
  if (!outcome) return null;
  if (outcome.status === "failed") {
    return (
      <div className="files-alert" role="alert" data-testid="reader-failed">
        <span>
          Couldn't open {name}. {outcome.message}
        </span>
        <button type="button" className="button" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  if (outcome.status === "missing") {
    return (
      <div className="files-alert" data-tone="quiet" data-testid="reader-missing">
        <span>
          This file no longer exists.
          {hasContent && loadedAt ? ` Showing what was loaded at ${clockTime(loadedAt)}.` : ""}
        </span>
      </div>
    );
  }
  if (outcome.status !== "cannot-show") return null;
  return (
    <div className="reader-cannot" data-testid="reader-cannot">
      <FactsBlock facts={facts ?? outcome.facts} />
      <p className="reader-why">{limitSentence(name, outcome.limit, bot)}</p>
      {sourceStep && (
        <p className="reader-why">
          <button
            type="button"
            className="link-button"
            onClick={() => onShowInChat(sourceStep.stepId)}
          >
            Show in chat
          </button>
        </p>
      )}
    </div>
  );
}

function FactsBlock({
  facts,
}: {
  facts: {
    name: string;
    path: string;
    size: number | null;
    updatedAt: number | null;
    mimeType: string | null;
  };
}) {
  const rows: Array<[string, ReactNode]> = [
    ["Name", facts.name],
    ["Size", facts.size === null ? "Not reported" : formatSize(facts.size)],
    ["Modified", facts.updatedAt ? stampTime(facts.updatedAt) : "Not reported"],
  ];
  if (facts.mimeType) rows.push(["Type", facts.mimeType]);
  rows.push(["Folder", folderOf(facts.path) || "The task's folder"]);
  return (
    <dl className="facts reader-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd title={typeof value === "string" ? value : undefined}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Code with line numbers. Lines scroll sideways; they wrap only when asked. */
function CodeView({ text, wrap }: { text: string; wrap: boolean }) {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return (
    <pre className="code-view" data-wrap={wrap}>
      {lines.map((line, index) => (
        <span className="code-line" key={index}>
          <span className="ln" aria-hidden="true">
            {index + 1}
          </span>
          <span className="lc">{line || " "}</span>
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function MediaView({ shown, name }: { shown: Shown; name: string }) {
  // A data: address: the pages' policies admit it for pictures and media, and it needs no revoking.
  const url = useMemo(() => `data:${shown.mimeType};base64,${toBase64(shown.data)}`, [shown]);
  // The reader sent it; this device could not draw or play it. Download still saves it.
  const [broken, setBroken] = useState(false);
  if (broken)
    return (
      <p className="reader-why" data-testid="reader-unrendered">
        {`${name} arrived from the gateway, but this device can't ${
          shown.kind === "image"
            ? "display this picture"
            : `play this ${shown.kind === "audio" ? "recording" : "video"}`
        }. It is ${shown.mimeType}, ${formatSize(shown.bytes)}; Download saves it as it is.`}
      </p>
    );
  const fail = () => setBroken(true);
  if (shown.kind === "image")
    return (
      <div className="reader-image">
        <img src={url} alt={name} onError={fail} />
      </div>
    );
  if (shown.kind === "audio")
    return <audio className="reader-audio" controls src={url} aria-label={name} onError={fail} />;
  return <video className="reader-video" controls src={url} aria-label={name} onError={fail} />;
}

/** A unified patch, signs in the gutter so colour is never the only cue. */
export function PatchView({ hunks }: { hunks: Hunk[] }) {
  return (
    <div className="diff">
      {hunks.map((hunk, h) => (
        <div key={h}>
          <p className="diff-hunk">
            Lines {hunk.newStart}–{Math.max(hunk.newStart, hunk.newEnd)}
          </p>
          {hunk.lines.map((line, i) => (
            <div className="diff-line" data-kind={line.kind} key={i}>
              <span className="ln" aria-hidden="true">
                {line.oldLine ?? ""}
              </span>
              <span className="ln" aria-hidden="true">
                {line.newLine ?? ""}
              </span>
              <span className="sign" aria-hidden="true">
                {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
              </span>
              <span className="lc">
                <span className="visually-hidden">
                  {line.kind === "add" ? "added: " : line.kind === "del" ? "removed: " : ""}
                </span>
                {line.text || " "}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

type StepChange = {
  source: FileSource;
  hunks: Hunk[] | null;
  state: "loading" | "ready" | "too-large" | "unavailable";
  reason?: string;
};

const actionTitle = (source: FileSource, name: string) =>
  source.action === "write"
    ? `Wrote ${name}`
    : source.action === "edit"
      ? `Edited ${name}`
      : `Patched ${name}`;

function ChangesView({
  bridge,
  taskKey,
  path,
  name,
  changes,
  checkout,
  focusStep,
  onShowInChat,
  now,
}: {
  bridge: ClawtrateBridge;
  taskKey: string;
  path: string;
  name: string;
  changes: FileSource[];
  checkout: boolean;
  focusStep: string | null;
  onShowInChat: (stepId: string) => void;
  now: number;
}) {
  const [steps, setSteps] = useState<StepChange[]>(() =>
    changes.map((source) => ({ source, hunks: null, state: "loading" })),
  );
  const ids = changes.map((change) => change.stepId).join("\n");
  useEffect(() => {
    let live = true;
    void (async () => {
      for (const source of changes) {
        let next: StepChange;
        try {
          const read = await bridge.invoke({
            type: "readStepRaw",
            key: taskKey,
            stepId: source.stepId,
          });
          if (read && (read.status === "available" || read.status === "cut-by-gateway")) {
            const { patch, diff, tooLarge } = stepPatch(read.raw);
            // The live result's patch, or the numbered diff the gateway's history keeps.
            const hunks = patch ? parsePatch(patch) : diff ? parseNumberedDiff(diff) : null;
            next = hunks
              ? { source, hunks, state: "ready" }
              : {
                  source,
                  hunks: null,
                  state: tooLarge ? "too-large" : "unavailable",
                  reason: "The tool's result carries no patch.",
                };
          } else {
            next = {
              source,
              hunks: null,
              state: "unavailable",
              reason:
                read && "reason" in read ? read.reason : "This step is not in this task any more.",
            };
          }
        } catch (error) {
          next = {
            source,
            hunks: null,
            state: "unavailable",
            reason: error instanceof Error ? error.message : String(error),
          };
        }
        if (!live) return;
        setSteps((previous) =>
          previous.map((each) => (each.source.stepId === source.stepId ? next : each)),
        );
      }
    })();
    return () => {
      live = false;
    };
    // The step ids say when the list of changes is a different one.
  }, [bridge, taskKey, ids]); // eslint-disable-line react-hooks/exhaustive-deps

  const [diff, setDiff] = useState<
    CheckoutDiff | { status: "loading" } | { status: "failed"; message: string } | null
  >(checkout ? { status: "loading" } : null);
  useEffect(() => {
    if (!checkout) return;
    let live = true;
    bridge.invoke({ type: "readCheckoutDiff", key: taskKey, path }).then(
      (answer) => live && setDiff(answer),
      (error: unknown) =>
        live &&
        setDiff({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        }),
    );
    return () => {
      live = false;
    };
  }, [bridge, taskKey, path, checkout]);

  const focused = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusStep || focused.current) return;
    const block = listRef.current?.querySelector<HTMLElement>(
      `[data-step="${CSS.escape(focusStep)}"]`,
    );
    if (block) {
      focused.current = true;
      block.scrollIntoView({ block: "nearest" });
    }
  }, [focusStep, steps]);

  const both = steps.length > 0 && checkout;
  return (
    <div className="changes" ref={listRef} data-testid="changes">
      {steps.length > 0 && (
        <>
          {both && <h4 className="change-group">This task's changes</h4>}
          <p className="change-summary">
            {steps.length} {steps.length === 1 ? "change" : "changes"} in this task
          </p>
          {steps.map((change) => {
            const counts = change.hunks ? patchCounts(change.hunks) : null;
            const head = actionTitle(change.source, name);
            return (
              <section
                className="change"
                key={change.source.stepId}
                data-step={change.source.stepId}
                aria-label={head}
              >
                <p className="change-head">
                  <strong>{head}</strong>
                  {change.source.at && <span>{stampTime(change.source.at, now)}</span>}
                  {counts && (
                    <span className="change-count">
                      +{counts.added} −{counts.removed}
                    </span>
                  )}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => onShowInChat(change.source.stepId)}
                  >
                    Show in chat
                  </button>
                </p>
                {change.source.created && <p className="change-note">Created in this task</p>}
                {change.state === "loading" && <div className="skeleton-row" aria-busy="true" />}
                {change.state === "too-large" && (
                  <p className="change-note">This change is too large for the gateway to send.</p>
                )}
                {change.state === "unavailable" && <p className="change-note">{change.reason}</p>}
                {change.hunks && <PatchView hunks={change.hunks} />}
              </section>
            );
          })}
        </>
      )}
      {checkout && diff && (
        <section className="change" aria-label="In the checkout">
          {both && <h4 className="change-group">In the checkout</h4>}
          <CheckoutBlock diff={diff} />
        </section>
      )}
    </div>
  );
}

function CheckoutBlock({
  diff,
}: {
  diff: CheckoutDiff | { status: "loading" } | { status: "failed"; message: string };
}) {
  if (diff.status === "loading") return <div className="skeleton-row" aria-busy="true" />;
  if (diff.status === "failed")
    return <p className="change-note">Couldn't read the checkout's comparison. {diff.message}</p>;
  if (diff.status === "unavailable")
    return (
      <p className="change-note">
        {diff.reason === "not_git"
          ? "This task's folder isn't a git checkout."
          : "The gateway can't compare this checkout now."}
      </p>
    );
  const base = diff.baseRef === "HEAD" || diff.baseRef === null ? "the last commit" : diff.baseRef;
  if (!diff.file)
    return (
      <>
        <p className="change-head" data-testid="checkout-label">
          <strong>Compared with {base}</strong>
        </p>
        <p className="change-note">No changes to this file in the checkout.</p>
      </>
    );
  const hunks = diff.file.patch ? parsePatch(diff.file.patch) : [];
  return (
    <>
      <p className="change-head" data-testid="checkout-label">
        <strong>
          Compared with {base} · +{diff.file.additions} −{diff.file.deletions}
        </strong>
      </p>
      <p className="change-note">
        In this checkout. This can include changes made before this task.
      </p>
      {diff.file.truncated && (
        <p className="change-note">
          This change is too large for the gateway to send. +{diff.file.additions} −
          {diff.file.deletions}.
        </p>
      )}
      {diff.file.cutByClient && (
        <p className="change-note">
          This patch is longer than Clawtrate's limit for one answer here, so it isn't shown.
        </p>
      )}
      {diff.file.binary && (
        <p className="change-note">A binary file: there are no lines to compare.</p>
      )}
      {hunks.length > 0 && <PatchView hunks={hunks} />}
    </>
  );
}
