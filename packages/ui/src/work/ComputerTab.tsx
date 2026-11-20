// The Computer tab (work-pane.md, sections 15 to 19): the bot's browser,
// watched only when the person asks, taken over and handed back, where the
// task's work runs, and what it did there. The engine keeps the pane
// (`state.computer.panes[viewer]`); this draws it and sends the person's
// commands. Words come from the engine's catalogue (`computerWords`).

import {
  approvalTarget,
  browserUse,
  callFromStep,
  commandRows,
  commandsRanOn,
  computerWords as words,
  lineOf,
  pictureAge,
  recentActions,
  type Bot,
  type ClawtrateBridge,
  type ComputerPane,
  type ComputerState,
  type ConnectionState,
  type MachineFacts,
  type NodeRecord,
  type QuestionCard,
  type Transcript,
} from "@clawtrate/core";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { KindIcon } from "../actions/icons.tsx";
import { useBridge } from "../bridge.tsx";
import { clockTime } from "../format.ts";
import {
  EyeIcon,
  EyeOffIcon,
  ExpandIcon,
  HandIcon,
  MachineIcon,
  PluginIcon,
  ScreenIcon,
} from "../icons.tsx";
import { readPreference, writePreference } from "../preferences.ts";
import { pictureWords, useFrames, useNow, type FrameCanvases, type Picture } from "./frames.ts";
import { ScreenView } from "./ScreenView.tsx";
import "./computer.css";

const glyph = (state: string) => <span className="glyph" data-state={state} aria-hidden="true" />;

const domainOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/** The tab is in front of the person: shown, and the window not hidden. */
function useShown(visible: boolean): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible && !hidden;
}

export type ComputerTabProps = {
  bridge: ClawtrateBridge;
  bot: Bot;
  taskKey: string;
  transcript: Transcript | undefined;
  computer: ComputerState | undefined;
  connection: ConnectionState;
  /** This connection may send (and the host is not pinned read-only). */
  interactive: boolean;
  visible: boolean;
  announce: (text: string) => void;
  onShowInChat: (stepId: string) => void;
  onShowQuestion: () => void;
  /** Absent on a host pinned to the read tier: it never asks for more access. */
  onRequestAccess: (() => void) | null;
};

export function ComputerTab(props: ComputerTabProps) {
  const { bridge, bot, taskKey, transcript, computer, connection, interactive, announce } = props;
  const name = bot.name;
  const shown = useShown(props.visible);
  const [viewer, setViewer] = useState<string | null>(null);
  /** Each showing of the tab has its number: the full view belongs to one showing. */
  const [showing, setShowing] = useState(0);
  const showings = useRef(0);
  const pane: ComputerPane | null = (viewer && computer?.panes[viewer]) || null;
  const send = useCallback(
    (command: Parameters<ClawtrateBridge["send"]>[0]) => void bridge.send(command).catch(() => {}),
    [bridge],
  );

  // The pane is this viewer's while the tab is in front of the person; leaving ends the view.
  const online = connection.status === "connected";
  useEffect(() => {
    if (!shown || !online) return;
    let gone = false;
    const number = ++showings.current;
    bridge
      .invoke({ type: "computerShow", key: taskKey })
      .then((answer) => {
        if (gone) return;
        setViewer(answer.viewer);
        setShowing(number);
      })
      .catch(() => {});
    return () => {
      gone = true;
      void bridge.send({ type: "computerLeave" }).catch(() => {});
    };
  }, [bridge, shown, online, taskKey]);

  const use = browserUse(transcript);
  const steps = transcript?.runs.reduce((sum, run) => sum + run.steps.length, 0) ?? 0;
  // A browser call's end can open or close a tab: the list is read again.
  const browserEnds = useMemo(
    () =>
      transcript?.runs
        .flatMap((run) => run.steps)
        .filter((step) => step.toolName === "browser" && step.status !== "running").length ?? 0,
    [transcript],
  );
  useEffect(() => {
    if (pane && browserEnds > 0) send({ type: "computerTabs" });
    // Only a new browser result asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserEnds]);

  // "Show live when I open Computer", kept per bot on this device.
  const [showLive, setShowLive] = useState(() => readPreference(`computerLive.${bot.id}`) === "1");
  const [noteSeen, setNoteSeen] = useState(() => readPreference(`computerNote.${bot.id}`) === "1");
  const autoStarted = useRef(false);
  useEffect(() => {
    autoStarted.current = false;
  }, [viewer, taskKey, shown]);
  useEffect(() => {
    // Only while the tab is in front of the person and its pane is about this task: leaving
    // clears the pane's view, and that never starts watching again.
    if (!pane || !shown || pane.key !== taskKey || !showLive || autoStarted.current) return;
    if (pane.availability !== "ready" || !pane.shown || pane.view || !use.used) return;
    autoStarted.current = true;
    send({ type: "computerWatch" });
  }, [pane, shown, taskKey, showLive, send, use.used]);

  const [fullFor, setFullFor] = useState<number | null>(null);
  const full = shown && fullFor === showing;
  const setFull = (open: boolean) => setFullFor(open ? showing : null);
  const openRef = useRef<HTMLButtonElement | null>(null);
  const control = pane?.control;
  // A read-only connection never opens the full view, whatever it is asked to show.
  const fullShown = full && interactive && pane !== null && pane.availability === "ready";

  const question: QuestionCard | null =
    transcript?.questions.find((each) => each.status === "pending") ?? null;
  const { canvases: frames, drawn } = useFrames(bridge, pane?.view ?? null);
  // "Live" only while a usable frame was drawn recently; the words change by themselves.
  const now = useNow(pane?.view?.status === "live");
  const picture = pictureAge(drawn, now);

  // After a release that was to answer in the chat: the full view closes and focus goes to the card.
  const answerInChat = useRef(false);
  useEffect(() => {
    if (!control) return;
    if (control.status === "none" && answerInChat.current) {
      answerInChat.current = false;
      setFullFor(null);
      props.onShowQuestion();
    }
    if (control.status === "granted")
      announce(`You have control of ${name}'s browser. ${words.pausedLine(name)}`);
    if (control.status === "none" && control.released) announce(`Control given back to ${name}`);
    // Announce each change of control once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [control?.status]);
  const released = control?.released === true;

  const take = () => {
    if (!interactive) return;
    setFull(true);
    send({ type: "computerTake" });
  };
  const watch = () => {
    if (!noteSeen) {
      writePreference(`computerNote.${bot.id}`, "1");
      setNoteSeen(true);
    }
    send({ type: "computerWatch" });
  };

  const held = heldLine(name, pane, full);
  const status = control?.status ?? "none";
  const banner =
    question &&
    pane?.availability === "ready" &&
    pane.tabs.length > 0 &&
    interactive &&
    connection.canAnswer &&
    !pane.stopped &&
    !["maybe-held", "checking", "unverified", "releasing", "unconfirmed"].includes(status) ? (
      <div
        className="computer-banner"
        role="region"
        aria-label={words.waitingBanner(name, released)}
        data-testid="computer-banner"
      >
        {glyph("waiting")}
        <div>
          <strong>{words.waitingBanner(name, released)}</strong>
          <p>{question.questions[0]?.question ?? question.questions[0]?.header}</p>
          <div className="computer-banner-actions">
            {status !== "granted" && (
              <button
                type="button"
                className="button"
                data-size="sm"
                data-variant="primary"
                onClick={take}
              >
                <HandIcon />
                Take control
              </button>
            )}
            <button type="button" className="button" data-size="sm" onClick={props.onShowQuestion}>
              Show the question
            </button>
          </div>
        </div>
      </div>
    ) : null;

  const stuck =
    pane && control && control.busyCount >= 3 && interactive ? (
      <StuckLine
        name={name}
        stopped={pane.stopped}
        onStop={() => send({ type: "computerStopTask" })}
      />
    ) : null;

  return (
    <div className="computer" data-testid="computer">
      {held}
      {banner}
      {stuck}
      <section className="work-section computer-section" aria-labelledby="computer-screen">
        <h3 id="computer-screen">Screen</h3>
        <ScreenSection
          name={name}
          pane={pane}
          computer={computer}
          used={use.used}
          interactive={interactive}
          online={online}
          frames={frames}
          picture={picture}
          noteSeen={noteSeen}
          showLive={showLive}
          full={fullShown}
          onOpenButton={(element) => {
            openRef.current = element;
          }}
          onNoteSeen={() => {
            writePreference(`computerNote.${bot.id}`, "1");
            setNoteSeen(true);
          }}
          onShowLive={(on) => {
            writePreference(`computerLive.${bot.id}`, on ? "1" : null);
            setShowLive(on);
          }}
          onWatch={watch}
          onStop={() => send({ type: "computerStopWatching" })}
          onOpen={() => setFull(true)}
          onChoose={(targetId) => send({ type: "computerChoose", targetId })}
          onRelease={() => send({ type: "computerRelease", answer: null })}
          onCheck={() => send({ type: "computerCheck" })}
          onRetry={() => send({ type: "computerTabs" })}
          onRequestAccess={props.onRequestAccess}
        />
      </section>
      <section className="work-section computer-section" aria-labelledby="computer-machine">
        <h3 id="computer-machine">Machine</h3>
        <MachineSection
          bridge={bridge}
          name={name}
          taskKey={taskKey}
          transcript={transcript}
          // Read only while the tab is in front of the person: nothing is asked of the gateway
          // for a tab no one is looking at.
          online={online && shown}
          browser={
            pane?.availability === "ready"
              ? `The gateway's machine, in ${name}'s own browser`
              : null
          }
        />
      </section>
      <RecentSections transcript={transcript} steps={steps} onShowInChat={props.onShowInChat} />
      {fullShown && pane && (
        <ScreenView
          bot={bot}
          pane={pane}
          question={question}
          canAnswer={connection.canAnswer}
          frames={frames}
          age={picture}
          onClose={() => {
            setFull(false);
            requestAnimationFrame(() => openRef.current?.focus());
          }}
          onTake={take}
          onWatch={watch}
          onCancel={() => send({ type: "computerCancelTake" })}
          onRelease={(answer) => send({ type: "computerRelease", answer })}
          onAnswerInChat={() => {
            answerInChat.current = true;
            send({ type: "computerRelease", answer: null });
          }}
          onCheck={() => send({ type: "computerCheck" })}
          onChoose={(targetId) => send({ type: "computerChoose", targetId })}
          onShowQuestion={() => {
            setFull(false);
            props.onShowQuestion();
          }}
          onInput={(input) => void bridge.invoke({ type: "computerInput", input }).catch(() => {})}
        />
      )}
    </div>
  );
}

/** Control this device may still hold, out of sight, or after a drop (section 18). */
function heldLine(name: string, pane: ComputerPane | null, full: boolean): ReactNode {
  const control = pane?.control;
  if (!control || full) return null;
  const bot = name;
  if (control.outOfSight && (control.status === "releasing" || control.status === "unconfirmed"))
    return (
      <p className="files-alert computer-held" role="alert" data-testid="computer-held">
        {words.outOfSightLine(bot, control.renewWithinMs)}
        <ReleaseAgain />
      </p>
    );
  if (control.status === "maybe-held")
    return (
      <p className="files-alert computer-held" role="alert" data-testid="computer-held">
        {words.droppedLine}
      </p>
    );
  if (control.status === "checking")
    return (
      <p className="files-alert computer-held" data-tone="quiet" role="status">
        {glyph("working")}
        {words.checkingLine(bot)}
      </p>
    );
  if (control.status === "ended" && !(pane.view && pane.view.status !== "ended"))
    return (
      <p className="files-alert computer-held" data-tone="quiet" role="status">
        {words.controlEndedLine(control.endCause)}
      </p>
    );
  return null;
}

function ReleaseAgain() {
  const bridge = useBridge();
  return (
    <button
      type="button"
      className="button"
      data-size="sm"
      onClick={() => void bridge.send({ type: "computerRelease", answer: null }).catch(() => {})}
    >
      Give it back
    </button>
  );
}

function StuckLine({
  name,
  stopped,
  onStop,
}: {
  name: string;
  stopped: boolean;
  onStop: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);
  if (stopped)
    return (
      <p className="files-alert" data-tone="quiet" role="status" data-testid="computer-stopped">
        {words.stoppedLine(name)}
      </p>
    );
  return (
    <>
      <p className="files-alert" role="alert" data-testid="computer-stuck">
        {words.stuckLine(name)}
        <button
          ref={openerRef}
          type="button"
          className="button"
          data-size="sm"
          onClick={() => setConfirming(true)}
        >
          Stop {name} in this task
        </button>
      </p>
      {confirming && (
        <div
          className="menu stop-confirm"
          role="alertdialog"
          aria-label={`Stop ${name} in this task?`}
        >
          <p>
            <strong>Stop {name}'s runs in this task?</strong> Steps already done stay done. {name}'s
            other tasks and other bots keep going.
          </p>
          <div className="stop-actions">
            <button
              ref={cancelRef}
              type="button"
              className="button"
              data-size="sm"
              onClick={() => {
                setConfirming(false);
                openerRef.current?.focus();
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button"
              data-size="sm"
              data-tone="danger"
              onClick={() => {
                setConfirming(false);
                onStop();
              }}
            >
              Stop
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// The screen section ---------------------------------------------------------------------------

type ScreenProps = {
  name: string;
  pane: ComputerPane | null;
  computer: ComputerState | undefined;
  used: boolean;
  interactive: boolean;
  online: boolean;
  frames: FrameCanvases;
  picture: Picture;
  noteSeen: boolean;
  showLive: boolean;
  full: boolean;
  onOpenButton: (element: HTMLButtonElement | null) => void;
  onNoteSeen: () => void;
  onShowLive: (on: boolean) => void;
  onWatch: () => void;
  onStop: () => void;
  onOpen: () => void;
  onChoose: (targetId: string) => void;
  onRelease: () => void;
  onCheck: () => void;
  onRetry: () => void;
  /** Absent on a host pinned to the read tier: it never asks for more access. */
  onRequestAccess: (() => void) | null;
};

/** "What the plugin adds": the plugin's page is not published yet, so its summary opens here. */
function PluginNote() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="link-button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        What the plugin adds
      </button>
      {open && (
        <p className="computer-plugin-note">
          Clawtrate's computer plugin gives each bot the gateway's owner chooses a browser of its
          own on the gateway's machine, lets the people who can use that bot watch it live, and lets
          one of them take control of a tab and hand it back. It needs no admin access for this
          device.
        </p>
      )}
    </>
  );
}

function Empty({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="work-empty computer-empty">
      <span className="empty-mark">{icon}</span>
      <h4>{title}</h4>
      {children}
    </div>
  );
}

/** Someone holds the bot's browser: every reader sees the gateway's control events. */
function elsewhereOf(
  name: string,
  pane: ComputerPane | null,
  computer: ComputerState | undefined,
  botId: string | null,
): string | null {
  const tab = pane?.tabs.find((each) => each.targetId === pane.shown);
  if (tab?.lease) {
    // A take still draining is not control: nobody holds it yet.
    const taking = tab.lease.state === "draining";
    if (tab.lease.holder === "elsewhere")
      return taking ? words.takingElsewhereLine(name) : words.elsewhereLine(name);
    if (tab.lease.holder === "this-device")
      return taking ? words.takingOtherWindowLine(name) : words.otherWindowLine(name);
    return null;
  }
  if (pane?.availability === "ready") return null;
  const record = computer?.control.find(
    (each) => each.agentId === botId && (each.state === "granted" || each.state === "draining"),
  );
  return record
    ? record.state === "draining"
      ? words.takingElsewhereLine(name)
      : words.elsewhereLine(name)
    : null;
}

function ScreenSection(props: ScreenProps) {
  const { name, pane, computer, used } = props;
  const botId = pane?.botId ?? null;
  if (computer?.plugin === false || pane?.availability === "absent")
    return (
      <div data-testid="computer-noplugin">
        <Empty icon={<PluginIcon />} title={words.noPluginTitle}>
          <p>{words.noPluginBody(name)}</p>
          <PluginNote />
        </Empty>
        <p className="computer-shared">{words.noPluginShared(name)}</p>
      </div>
    );
  if (pane?.availability === "not-configured")
    return (
      <div data-testid="computer-unconfigured">
        <Empty icon={<ScreenIcon />} title={words.unconfiguredTitle(name)}>
          <p>{words.unconfiguredBody(name)}</p>
        </Empty>
        <p className="computer-shared">{words.unconfiguredShared(name)}</p>
      </div>
    );
  if (!used)
    return (
      <div data-testid="computer-unused">
        <Empty icon={<ScreenIcon />} title={words.unusedTitle}>
          <p>{words.unusedBody(name)}</p>
        </Empty>
      </div>
    );
  if (pane?.availability === "not-allowed")
    return (
      <div data-testid="computer-not-allowed">
        <Empty icon={<ScreenIcon />} title={words.notAllowedTitle(name)}>
          <p>{words.notAllowedBody}</p>
        </Empty>
      </div>
    );
  if (!props.interactive || pane?.availability === "read-only") {
    const elsewhere = elsewhereOf(name, pane, computer, botId);
    return (
      <div data-testid="computer-readonly">
        <div className="screen computer-dark" data-state="blocked">
          <div className="screen-blank">
            <EyeIcon />
            <p>{words.readOnlyLine}</p>
            {props.onRequestAccess && (
              <button
                type="button"
                className="button"
                data-size="sm"
                onClick={props.onRequestAccess}
              >
                Request access
              </button>
            )}
          </div>
        </div>
        {elsewhere && (
          <p className="screen-caption" role="status">
            {elsewhere}
          </p>
        )}
      </div>
    );
  }
  if (pane?.availability === "error")
    return (
      <p className="files-alert" role="alert" data-testid="computer-ask-failed">
        {words.askFailedLine(name)} {pane.error}
        <button type="button" className="button" data-size="sm" onClick={props.onRetry}>
          Try again
        </button>
      </p>
    );
  if (!pane || pane.availability === "unknown" || pane.availability === "checking")
    return (
      <div className="screen computer-dark" data-state="checking" aria-busy="true">
        <div className="screen-blank">{glyph("working")}</div>
      </div>
    );
  if (pane.tabs.length === 0)
    return (
      <div className="screen computer-dark" data-state="closed" data-testid="computer-no-tabs">
        <div className="screen-blank">
          <ScreenIcon />
          <p>{words.noTabsLine(name)}</p>
        </div>
      </div>
    );
  return <Tile {...props} pane={pane} />;
}

function Tile({
  name,
  pane,
  frames,
  picture,
  computer,
  full,
  noteSeen,
  showLive,
  onOpenButton,
  onOpen,
  onStop,
  onWatch,
  onNoteSeen,
  onRelease,
  onCheck,
  onChoose,
  onShowLive,
}: ScreenProps & { pane: ComputerPane }) {
  const view = pane.view;
  const tab = pane.tabs.find((each) => each.targetId === pane.shown) ?? pane.tabs[0]!;
  const title = view?.title || tab.title;
  const url = view?.url || tab.url;
  const control = pane.control;
  const elsewhere = elsewhereOf(name, pane, computer, pane.botId);
  const showOn = useCallback(
    (canvas: HTMLCanvasElement | null) => (canvas ? frames.attach(canvas) : undefined),
    [frames],
  );

  let tile: ReactNode;
  if (view && view.status === "live") {
    tile = (
      <div
        className="screen computer-dark"
        data-state="live"
        data-picture={picture.kind}
        role="img"
        aria-label={`${name}'s browser, ${pictureWords(picture).toLowerCase()}: ${title}`}
        data-testid="computer-tile"
      >
        <canvas ref={showOn} className="screen-canvas" data-frame={view.frame} />
        <span className="screen-live" data-picture={picture.kind}>
          {pictureWords(picture)}
        </span>
        {!full && (
          <span className="screen-actions">
            <button
              ref={onOpenButton}
              type="button"
              className="icon-button"
              aria-label={`Open ${name}'s browser full window`}
              title="Open"
              onClick={onOpen}
            >
              <ExpandIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Stop watching"
              title="Stop watching"
              onClick={onStop}
            >
              <EyeOffIcon />
            </button>
          </span>
        )}
      </div>
    );
  } else if (view && view.status === "connecting") {
    tile = (
      <div
        className="screen computer-dark"
        data-state="connecting"
        aria-busy="true"
        data-testid="computer-tile"
      >
        <div className="screen-blank">
          {glyph("working")}
          <p>{words.connectingLine(name)}</p>
        </div>
      </div>
    );
  } else if (view && view.status === "ended") {
    tile = (
      <div className="screen computer-dark" data-state="ended" data-testid="computer-tile">
        <div className="screen-blank">
          <p role="status">{words.viewEndLine(name, view.end ?? "gateway-ended", view.error)}</p>
          <button type="button" className="screen-watch" onClick={onWatch}>
            <EyeIcon />
            Watch again
          </button>
        </div>
      </div>
    );
  } else {
    tile = (
      <div className="screen computer-dark" data-state="idle" data-testid="computer-tile">
        <div className="screen-blank">
          <ScreenIcon />
          <button
            type="button"
            className="screen-watch"
            aria-label={`Watch ${name}'s browser`}
            onClick={onWatch}
          >
            <EyeIcon />
            Watch
          </button>
        </div>
      </div>
    );
  }
  return (
    <>
      {!noteSeen && !view && (
        <p className="files-alert" data-tone="quiet" role="note" data-testid="computer-first-watch">
          {words.firstWatchLine(name)}
          <button type="button" className="button" data-size="sm" onClick={onNoteSeen}>
            Got it
          </button>
        </p>
      )}
      {tile}
      <p className="screen-caption" data-testid="computer-caption">
        {words.captionLine(name)}
        <br />
        <span>
          {title || "Untitled"}
          {url ? ` · ${domainOf(url)}` : ""}
        </span>
      </p>
      {control.status === "granted" && !full && (
        <p className="screen-caption" data-testid="computer-tile-control">
          <strong>You have control.</strong>{" "}
          <span className="control-paused">{words.pausedLine(name)}</span>{" "}
          <button type="button" className="link-button" onClick={onRelease}>
            Give back control
          </button>
        </p>
      )}
      {control.status === "unverified" && !full && (
        <p className="screen-caption" role="alert" data-testid="computer-tile-control">
          {words.unverifiedLine(name)}{" "}
          <button type="button" className="link-button" onClick={onCheck}>
            Check
          </button>
        </p>
      )}
      {elsewhere && control.status !== "granted" && control.status !== "unverified" && (
        <p className="screen-caption" role="status" data-testid="computer-elsewhere">
          {elsewhere}
        </p>
      )}
      {pane.tabs.length > 1 && (
        <ul className="screen-tabs" aria-label={`${name}'s tabs`}>
          {pane.tabs.map((each) => (
            <li key={each.targetId}>
              <button
                type="button"
                className="screen-tab"
                aria-current={each.targetId === pane.shown}
                onClick={() => onChoose(each.targetId)}
              >
                <span>{each.title || "Untitled"}</span>
                <span>{domainOf(each.url)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="screen-auto">
        <input
          type="checkbox"
          checked={showLive}
          onChange={(event) => onShowLive(event.target.checked)}
        />{" "}
        Show live when I open Computer
      </label>
    </>
  );
}

// The machine ------------------------------------------------------------------------------------

const GB = 1024 ** 3;
const size = (bytes: number) =>
  bytes >= 1024 * GB
    ? `${Math.round((bytes / (1024 * GB)) * 10) / 10} TB`
    : `${Math.round((bytes / GB) * 10) / 10} GB`;
const ago = (at: number, now: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 90 ? `${s} s ago` : clockTime(at);
};

function MachineSection({
  bridge,
  name,
  taskKey,
  transcript,
  online,
  browser,
}: {
  bridge: ClawtrateBridge;
  name: string;
  taskKey: string;
  transcript: Transcript | undefined;
  online: boolean;
  browser: string | null;
}) {
  const target = transcript ? approvalTarget(transcript) : null;
  const ran = transcript ? commandsRanOn(transcript) : null;
  const named = [target?.nodeId, ran?.nodeId].filter((each): each is string => !!each);
  const namedKey = named.join(",");
  const [facts, setFacts] = useState<MachineFacts | null>(null);
  const [lastGood, setLastGood] = useState<Record<string, { record: NodeRecord; at: number }>>({});
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<number | null>(null);
  const ask = useCallback(
    (probe: boolean) =>
      bridge.invoke({
        type: "readMachine",
        key: taskKey,
        nodes: namedKey ? namedKey.split(",") : [],
        probe,
      }),
    [bridge, taskKey, namedKey],
  );
  const keep = useCallback((answer: MachineFacts) => {
    setFacts(answer);
    setLastGood((before) => {
      const next = { ...before };
      for (const [id, record] of Object.entries(answer.nodes))
        if (typeof record === "object") next[id] = { record, at: answer.readAt };
      return next;
    });
  }, []);
  // "Check again" and "Prepare it again": the same read, and when it was made.
  const read = (manual: boolean, probe = false) => {
    if (!online) return;
    if (manual) setChecking(true);
    ask(probe).then(
      (answer) => {
        keep(answer);
        if (manual) setChecked(answer.readAt);
        setChecking(false);
      },
      // Kept as it was: a failed read is never shown as "not connected".
      () => setChecking(false),
    );
  };
  useEffect(() => {
    if (!online) return;
    let gone = false;
    ask(false).then(
      (answer) => {
        if (!gone) keep(answer);
      },
      () => {},
    );
    return () => {
      gone = true;
    };
  }, [ask, keep, online]);
  // Times are read against when the facts were read.
  const now = facts?.readAt ?? 0;
  const setting = facts?.setting;
  const settingWords = setting
    ? `Commands: ${setting.node ?? (setting.host === "sandbox" ? "a sandbox" : "the gateway's machine")}`
    : null;
  const nodeIds = [...new Set([...named, ...(setting?.node ? [setting.node] : [])])];
  return (
    <div data-testid="computer-machine">
      {nodeIds.map((id) => {
        const got = facts?.nodes[id];
        if (typeof got !== "object" || got.connected) return null;
        // Above the machine: the node is not connected, and the one thing to do about it.
        return (
          <p key={id} className="files-alert" role="alert" data-testid="computer-node-offline">
            {id} isn't connected to the gateway. Nodes reconnect by themselves when they can; check
            that it's on and online.
            <button type="button" className="button" data-size="sm" onClick={() => read(true)}>
              {checking ? "Checking…" : "Check again"}
            </button>
            {checked && <span className="machine-sub">Checked {clockTime(checked)}</span>}
          </p>
        );
      })}
      <dl className="facts">
        <div>
          <dt>Command approval target</dt>
          <dd>
            {target ? (
              <>
                {target.nodeId ??
                  (target.host === "node"
                    ? "a node"
                    : target.host === "sandbox"
                      ? "a sandbox"
                      : "the gateway's machine")}
                <span className="machine-sub">
                  Requested {target.requestedAt ? clockTime(target.requestedAt) : "earlier"} ·{" "}
                  {target.status === "pending" ? "waiting for you" : target.status}
                </span>
              </>
            ) : (
              "Not reported in this task."
            )}
          </dd>
        </div>
        {ran && (
          <div>
            <dt>Commands ran on</dt>
            <dd>
              {ran.nodeId}
              <span className="machine-sub">
                By the command at {ran.at ? clockTime(ran.at) : "an earlier time"}, from its result
              </span>
            </dd>
          </div>
        )}
        {settingWords && (
          <div>
            <dt>Set for {name}</dt>
            <dd className="machine-setting">
              {settingWords}
              <span className="machine-sub">
                A setting for {name}. A task can run somewhere else.
              </span>
            </dd>
          </div>
        )}
        <div>
          <dt>Browser</dt>
          <dd>{browser ?? "Not reported."}</dd>
        </div>
      </dl>
      {facts?.desktop && !facts.desktop.available && (
        <p className="files-alert" role="alert">
          The gateway's desktop isn't available. {facts.desktop.error}
          <button type="button" className="button" data-size="sm" onClick={() => read(true, true)}>
            {checking ? "Preparing…" : "Prepare it again"}
          </button>
        </p>
      )}
      {nodeIds.map((id) => {
        const got = facts?.nodes[id];
        const record = typeof got === "object" ? got : null;
        const unknown = got === "unknown";
        const last = lastGood[id];
        const stats = record?.stats;
        const statsAt = stats?.updatedAtMs ?? null;
        return (
          <div key={id} data-testid="computer-node">
            <p className="machine-name">
              <MachineIcon />
              {record?.name ?? id}
            </p>
            <dl className="facts">
              <div>
                <dt>State</dt>
                <dd className="machine-state">
                  {unknown || !got ? (
                    <>
                      {glyph("queued")}Unknown
                      {last && (
                        <span className="machine-sub">
                          {last.record.connected ? "Connected" : "Not connected"} when last read,{" "}
                          {clockTime(last.at)}
                        </span>
                      )}
                    </>
                  ) : got === "not-listed" ? (
                    <>{glyph("queued")}Not listed by the gateway</>
                  ) : record!.connected ? (
                    <>{glyph("done")}Connected</>
                  ) : (
                    <>{glyph("failed")}Not connected</>
                  )}
                </dd>
              </div>
              {record?.lastSeenAtMs != null && (
                <div>
                  <dt>Last seen</dt>
                  <dd>
                    {ago(record.lastSeenAtMs, now)}
                    {record.lastSeenReason ? `, ${record.lastSeenReason}` : ""}
                  </dd>
                </div>
              )}
              {stats && stats.cpuCount !== null && stats.loadAverage !== null && (
                <div>
                  <dt>Load</dt>
                  <dd>
                    {stats.cpuCount} cores, {stats.loadAverage.toFixed(1)} average
                  </dd>
                </div>
              )}
              {stats && stats.memoryFreeBytes !== null && stats.memoryTotalBytes !== null && (
                <div>
                  <dt>Memory</dt>
                  <dd>
                    {size(stats.memoryFreeBytes)} of {size(stats.memoryTotalBytes)} free
                  </dd>
                </div>
              )}
              {stats && stats.diskAvailableBytes !== null && stats.diskTotalBytes !== null && (
                <div>
                  <dt>Disk</dt>
                  <dd>
                    {size(stats.diskAvailableBytes)} of {size(stats.diskTotalBytes)} free
                  </dd>
                </div>
              )}
            </dl>
            {record && !stats && <p className="machine-asof">{id} doesn't report its load.</p>}
            {statsAt !== null && (
              <p className="machine-asof">
                As of {clockTime(statsAt)}
                {now - statsAt > 180_000 ? ". The node hasn't sent newer figures." : ""}
              </p>
            )}
            <p className="machine-foot">
              {(facts?.sharedWith[id] ?? []).length > 0 && (
                <span>
                  {facts!.sharedWith[id]!.join(" and ")}{" "}
                  {facts!.sharedWith[id]!.length > 1 ? "are" : "is"} also set to run commands here.
                </span>
              )}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// Recent actions and commands -----------------------------------------------------------------

function RecentSections({
  transcript,
  steps,
  onShowInChat,
}: {
  transcript: Transcript | undefined;
  steps: number;
  onShowInChat: (stepId: string) => void;
}) {
  const [all, setAll] = useState(false);
  const actions = useMemo(
    () =>
      transcript
        ? recentActions(transcript, (step, run) => {
            const line = lineOf(callFromStep(step, run));
            return `${line.verb} ${line.object}`.trim();
          })
        : [],
    // Steps change with every event; their count and the transcript are enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transcript, steps],
  );
  const commands = useMemo(() => (transcript ? commandRows(transcript) : []), [transcript]);
  const shown = all ? actions : actions.slice(0, 8);
  return (
    <>
      {actions.length > 0 && (
        <section className="work-section computer-section" aria-labelledby="computer-actions">
          <h3 id="computer-actions">Recent actions</h3>
          <ul className="action-list" data-testid="computer-actions">
            {shown.map((action) => {
              const trigger =
                action.trigger?.kind === "routine"
                  ? "Routine"
                  : action.trigger?.kind === "bot"
                    ? `Message from ${action.trigger.name}`
                    : null;
              const time = action.at ? clockTime(action.at) : "";
              return (
                <li key={action.stepId}>
                  <button
                    type="button"
                    className="action-row"
                    aria-label={`${action.title}${time ? `, ${time}` : ""}${trigger ? `, ${trigger}` : ""}. Show in chat`}
                    onClick={() => onShowInChat(action.stepId)}
                  >
                    <time>{time}</time>
                    <KindIcon icon={action.kind === "web" ? "web" : "command"} />
                    <span>{action.title}</span>
                    {action.running && glyph("working")}
                    {trigger && <em>{trigger}</em>}
                  </button>
                </li>
              );
            })}
          </ul>
          {!all && actions.length > 8 && (
            <button type="button" className="link-button" onClick={() => setAll(true)}>
              Show all {actions.length}
            </button>
          )}
        </section>
      )}
      {commands.length > 0 && (
        <section className="work-section computer-section" aria-labelledby="computer-commands">
          <h3 id="computer-commands">Commands</h3>
          <ul className="command-list" data-testid="computer-commands">
            {commands.map((row) => (
              <li key={row.stepId} className="command-row">
                <code>{row.command}</code>
                <span>
                  {row.running ? (
                    <>{glyph("working")}Running</>
                  ) : (
                    <>
                      {row.end?.kind === "timed-out"
                        ? "Timed out"
                        : row.end
                          ? `exit ${row.end.code}`
                          : "Ended"}
                      {row.durationMs !== null ? ` · ${(row.durationMs / 1000).toFixed(1)}s` : ""}
                    </>
                  )}
                </span>
                <button
                  type="button"
                  className="link-button"
                  data-tone="muted"
                  aria-label={`Show ${row.command} in the chat`}
                  onClick={() => onShowInChat(row.stepId)}
                >
                  Show in chat
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
