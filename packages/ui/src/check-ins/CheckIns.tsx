// A bot's check-ins (automation.md section 13): each bot's block, read from
// its heartbeat job, and with admin the dialog that sets it. Shown as a
// Settings section until the Routines view, which the design gives the block
// to, exists.
//
// The dialog is mounted only while the connection holds admin, whatever
// opened it: below admin there is nothing that changes anything, and admin
// is asked for only by the access bar's button. A save's outcome is shown
// only in the dialog whose draft made it (`checkIns.save.id`).

import {
  keptByDefault,
  type Bot,
  type CheckInJob,
  type CheckInsState,
  type ConnectionState,
  type HostInfo,
} from "@clawtrate/core";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useBridge } from "../bridge.tsx";
import { Avatar } from "../Avatar.tsx";
import { CheckIcon, CloseIcon } from "../icons.tsx";
import { Dialog } from "../bots/Dialog.tsx";
import { AdminBar, GrantedBar, Note, Select, useGranted } from "../bots/parts.tsx";
import { clock } from "../bots/words.ts";
import type { SectionView } from "../bots/AccountsSection.tsx";
import {
  asksForSilence,
  choiceOf,
  choiceWords,
  DEFAULT_PROMPT,
  EVERY_CHOICES,
  everyFor,
  sentence,
  summary,
  type Choice,
} from "./words.ts";
import "./check-ins.css";

const CHOICES: Array<[Choice, string]> = [
  ["off", "Off"],
  ["daily", "Daily"],
  ["asneeded", "As needed"],
  ["every", "Every…"],
];

export function useCheckInsSection({
  checkIns,
  bots,
  connection,
  info,
  announce,
  toNav,
}: {
  checkIns: CheckInsState | undefined;
  bots: readonly Bot[];
  connection: ConnectionState;
  info: HostInfo;
  announce: (text: string) => void;
  toNav: ReactNode;
}): SectionView {
  const bridge = useBridge();
  const [editing, setEditing] = useState<string | null>(null);
  const granted = useGranted(connection);
  const admin = connection.canAdmin;

  useEffect(() => {
    void bridge.send({ type: "refreshCheckIns" }).catch(() => {});
  }, [bridge]);

  const jobOf = (botId: string) => checkIns?.jobs.find((job) => job.botId === botId);
  const editingBot = bots.find((bot) => bot.id === editing);

  let body: ReactNode;
  if (!checkIns || (checkIns.status === "loading" && checkIns.jobs.length === 0)) {
    body = <p className="ci-faint">Reading check-ins…</p>;
  } else if (checkIns.status === "error") {
    body = (
      <div className="form-error" role="alert">
        <strong>Couldn't read check-ins</strong>
        {checkIns.error}
      </div>
    );
  } else {
    body = (
      <>
        <p className="ci-intro">
          A bot that checks in starts a turn in its main conversation on a schedule, to look for
          anything that needs you.
        </p>
        {checkIns.scheduler === false && (
          <Note tone="warn" testId="scheduler-off">
            <p>
              <b>The gateway's scheduler is off,</b> so scheduled check-ins don't run.
            </p>
          </Note>
        )}
        <div className="ci-list" data-testid="check-ins">
          {bots.map((bot) => {
            const job = jobOf(bot.id);
            const next =
              job?.enabled && checkIns.scheduler !== false && job.nextRunAtMs !== null
                ? `Next check-in ${clock(job.nextRunAtMs)} · In ${bot.name}'s main conversation`
                : null;
            return (
              <section
                key={bot.id}
                className="ci-block"
                aria-labelledby={`ci-${bot.id}`}
                data-testid="check-in"
                data-bot={bot.id}
              >
                <div className="ci-head">
                  <Avatar bot={bot} className="ci-avatar" />
                  <h4 id={`ci-${bot.id}`}>{bot.name}</h4>
                  <span className="ci-summary">{summary(job)}</span>
                  {admin && (
                    <button
                      type="button"
                      className="button"
                      data-size="sm"
                      aria-label={`Change ${bot.name}'s check-ins`}
                      onClick={() => setEditing(bot.id)}
                    >
                      Change
                    </button>
                  )}
                </div>
                <p data-testid="check-in-text">{sentence(bot.name, job, checkIns.settings)}</p>
                {next && <p className="ci-faint">{next}</p>}
              </section>
            );
          })}
        </div>
      </>
    );
  }

  return {
    title: "Check-ins",
    back: toNav,
    body: (
      <>
        {body}
        {admin && checkIns && editingBot && (
          <CheckInsDialog
            bot={editingBot}
            bots={bots}
            checkIns={checkIns}
            job={jobOf(editingBot.id)}
            announce={announce}
            onClose={() => setEditing(null)}
          />
        )}
      </>
    ),
    foot: granted ? (
      <GrantedBar />
    ) : admin ? null : (
      <AdminBar connection={connection} info={info} need="Changing check-ins needs admin access." />
    ),
  };
}

function CheckInsDialog({
  bot,
  bots,
  checkIns,
  job,
  announce,
  onClose,
}: {
  bot: Bot;
  bots: readonly Bot[];
  checkIns: CheckInsState;
  job: CheckInJob | undefined;
  announce: (text: string) => void;
  onClose: () => void;
}) {
  const bridge = useBridge();
  const setting = checkIns.settings?.find((each) => each.botId === bot.id);
  const [initial] = useState(() => choiceOf(job));
  const [choice, setChoice] = useState<Choice>(initial.choice);
  const [every, setEvery] = useState(initial.every);
  const [prompt, setPrompt] = useState(setting?.prompt ?? "");
  const [promptTouched, setPromptTouched] = useState(false);
  const [saveId, setSaveId] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const groupRef = useRef<HTMLUListElement>(null);
  const save = checkIns.save?.id === saveId ? checkIns.save : null;
  const saving = save?.status === "saving";

  useEffect(() => {
    if (save?.status !== "saved") return;
    announce("Check-ins saved");
    void bridge.send({ type: "dismissCheckInSave", saveId: save.id }).catch(() => {});
    onClose();
  }, [save?.status, save?.id, announce, bridge, onClose]);

  const ended = refused !== null || save?.status === "failed" || save?.status === "unknown";
  const outcomeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ended) outcomeRef.current?.scrollIntoView({ block: "nearest" });
  }, [ended, save?.status]);

  const close = () => {
    if (saveId && !saving) void bridge.send({ type: "dismissCheckInSave", saveId }).catch(() => {});
    onClose();
  };
  const submit = () => {
    const id = crypto.randomUUID();
    setSaveId(id);
    setRefused(null);
    bridge
      .send({
        type: "saveCheckIn",
        saveId: id,
        botId: bot.id,
        every: everyFor(choice, every),
        prompt: promptTouched && !setting?.promptCut ? prompt : null,
      })
      .catch((error: unknown) =>
        setRefused(error instanceof Error ? error.message : String(error)),
      );
  };

  const onKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const index = CHOICES.findIndex(([value]) => value === choice);
    let next: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight")
      next = (index + 1) % CHOICES.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft")
      next = (index - 1 + CHOICES.length) % CHOICES.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = CHOICES.length - 1;
    if (next === null || saving) return;
    event.preventDefault();
    const value = CHOICES[next]![0];
    setChoice(value);
    groupRef.current?.querySelector<HTMLElement>(`[data-value="${value}"]`)?.focus();
  };

  const kept = keptByDefault(bot.id, checkIns.jobs, checkIns.settings);
  const names = kept.map((id) => bots.find((each) => each.id === id)?.name ?? id).join(" and ");
  const selfByDefault =
    job?.enabled === true && checkIns.settings !== null && setting === undefined;
  const everyChoices = EVERY_CHOICES.some((each) => each.value === every)
    ? EVERY_CHOICES
    : [...EVERY_CHOICES, { value: every, label: `${every} (as set now)` }];
  const promptWarning = !asksForSilence(prompt);
  const title = `${bot.name}'s check-ins`;

  return (
    <Dialog kind="create" labelledBy="ci-title" onClose={close} testId="check-ins-dialog">
      <div className="b-sheet">
        <header className="b-head">
          <h2 id="ci-title" tabIndex={-1}>
            {title}
          </h2>
          <button type="button" className="icon-button b-close" aria-label="Close" onClick={close}>
            <CloseIcon />
          </button>
        </header>
        <div className="b-body ci-body">
          <ul
            className="b-choices"
            role="radiogroup"
            aria-label="Check-ins"
            ref={groupRef}
            onKeyDown={onKey}
          >
            {CHOICES.map(([value, label]) => (
              <li key={value}>
                <button
                  type="button"
                  className="b-choice"
                  role="radio"
                  aria-checked={choice === value}
                  aria-disabled={saving || undefined}
                  tabIndex={choice === value ? 0 : -1}
                  data-value={value}
                  data-b-focus={choice === value ? "" : undefined}
                  onClick={() => !saving && setChoice(value)}
                >
                  <span className="b-choice-text">
                    <span className="b-choice-title">{label}</span>
                    <span className="b-choice-sub">{choiceWords(value, bot.name)}</span>
                  </span>
                  <CheckIcon className="b-tick" />
                </button>
              </li>
            ))}
          </ul>
          {choice === "every" && (
            <div className="ci-every">
              <span>Every</span>
              <Select
                label="How often"
                value={every}
                choices={everyChoices}
                onChoose={setEvery}
                disabled={saving}
                testId="ci-every"
              />
            </div>
          )}
          {choice === "off" && (
            <p className="ci-hint" data-testid="off-note">
              {bot.name} still reports when a command it started in the background finishes: the
              gateway starts that turn, not the schedule.
            </p>
          )}
          <details className="ci-prompt" open={Boolean(setting?.prompt) || undefined}>
            <summary>What to check</summary>
            <label htmlFor="ci-prompt-field" className="ci-label">
              Prompt
            </label>
            <textarea
              id="ci-prompt-field"
              className="input"
              rows={4}
              value={prompt}
              readOnly={setting?.promptCut || saving}
              placeholder={DEFAULT_PROMPT}
              aria-describedby={promptWarning ? "ci-prompt-note" : "ci-prompt-hint"}
              onChange={(event) => {
                setPrompt(event.target.value);
                setPromptTouched(true);
              }}
            />
            {promptWarning && (
              <p className="ci-hint" id="ci-prompt-note" data-testid="prompt-note">
                This prompt doesn't ask for NO_REPLY when nothing needs attention, so check-ins may
                post a message even when nothing does.
              </p>
            )}
            <p className="ci-hint" id="ci-prompt-hint">
              {setting?.promptCut
                ? "This prompt is longer than Clawtrate edits. Saving leaves it as it is."
                : "Empty uses the gateway's own prompt, which asks the bot to reply NO_REPLY when nothing needs attention."}
            </p>
          </details>
          {kept.length > 0 && (
            <Note testId="catch-note">
              <p>
                {names} {kept.length > 1 ? "check" : "checks"} in now through the gateway's default.
                Once any bot has a setting of its own, only those bots check in, so saving also
                gives {names} a setting of its own with the same cadence.
              </p>
            </Note>
          )}
          {selfByDefault && (
            <Note testId="catch-self">
              <p>
                {bot.name} checks in now through the gateway's default. Saving gives {bot.name} a
                setting of its own.
              </p>
            </Note>
          )}
          <div ref={outcomeRef} role="alert">
            {(refused || save?.status === "failed") && (
              <Note tone="danger" testId="save-failed">
                <p>
                  <b>Couldn't save.</b> {refused ?? save?.error} Nothing changed.
                </p>
              </Note>
            )}
            {save?.status === "unknown" && (
              <Note tone="warn" testId="save-unknown">
                <p>
                  <b>Not confirmed.</b> {save.error} The gateway may have applied it; the check-ins
                  behind this dialog show what it reports now.
                </p>
              </Note>
            )}
          </div>
        </div>
        <footer className="b-foot">
          <div className="b-actions">
            <button type="button" className="button" data-variant="quiet" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="button"
              data-variant="primary"
              disabled={saving}
              onClick={submit}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </footer>
      </div>
    </Dialog>
  );
}
