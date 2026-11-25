// Settings, opened with Cmd/Ctrl+, from any screen (bots.md section 7). Two
// panes: the list of sections, and the chosen one. Its Gateway pane shows the
// connection as it is (address, state, this device, the scopes the gateway
// granted) and offers Reconnect and Disconnect; Accounts lists the gateway's
// accounts; Check-ins shows each bot's check-ins. A modal dialog: focus stays
// inside it, Escape closes it, and focus returns to where it was.

import {
  INTERACTIVE_SCOPES,
  scopeSatisfied,
  type AccountsState,
  type Bot,
  type BotVoiceAnswer,
  type GatewayStamp,
  type CheckInsState,
  type ConnectionState,
  type HostInfo,
} from "@clawtrate/core";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { useDesktopUpdateSnapshot } from "./update-reading.ts";
import { Updates } from "./Updates.tsx";
import { useBridge, useClawtrateState, useCommand } from "./bridge.tsx";
import { useAccountsSection } from "./bots/AccountsSection.tsx";
import { useCheckInsSection } from "./check-ins/CheckIns.tsx";
import { useUsageSection } from "./usage/UsageSection.tsx";
import { useMachinesSection } from "./machines/Machines.tsx";
import { Dialog } from "./bots/Dialog.tsx";
import { recall, remember } from "./bots/memory.ts";
import { useAnnouncer } from "./bots/parts.tsx";
import "./bots/bots.css";
import { CopyValue } from "./AccessBar.tsx";
import { FullControlAsk, isFullRequest, notGranted } from "./FullControl.tsx";
import { CommandLine, failureTitle } from "./ConnectScreen.tsx";
import { gatewayTitle } from "./format.ts";
import { useShowCommands, useShowThinking } from "./preferences.ts";
import { useForget } from "./forget.ts";
import { BackIcon, ChevronIcon, CloseIcon, ExternalIcon } from "./icons.tsx";

// The width below which a section replaces the list instead of sitting beside it (bots.css).
const NARROW = "(max-width: 687px)";

function onNarrowChange(listener: () => void): () => void {
  const query = globalThis.matchMedia?.(NARROW);
  query?.addEventListener("change", listener);
  return () => query?.removeEventListener("change", listener);
}

const isNarrow = () => globalThis.matchMedia?.(NARROW).matches ?? false;

function useNarrow(): boolean {
  return useSyncExternalStore(onNarrowChange, isNarrow, () => false);
}

/** The connection's state, as the Gateway pane names it. */
export function gatewayState(connection: ConnectionState): string {
  switch (connection.status) {
    case "connected":
      // Re-pairing: the gateway holds this device's new authorization until its owner decides.
      return connection.upgrade.status === "requesting" || connection.upgrade.status === "pending"
        ? "Pairing pending"
        : "Connected";
    case "pairing":
      return "Pairing pending";
    case "disconnected":
      return "Disconnected";
    case "idle":
      return "Not connected";
    case "error":
      return "Offline";
    case "connecting":
    case "reconnecting":
      // An attempt under way is connecting; waiting for the next one is offline.
      return connection.retryAt === null ? "Connecting" : "Offline";
  }
}

/** The pane's error line: pairing rejected or expired, unreachable, protocol incompatible. */
function gatewayProblem(connection: ConnectionState): { title: string; message: string } | null {
  const error = connection.error;
  if (!error) return null;
  if (error.code === "PROTOCOL_MISMATCH") {
    return { title: "This gateway speaks another protocol", message: error.message };
  }
  if (error.code === "PAIRING_ENDED") {
    return { title: failureTitle(error.code), message: error.message };
  }
  if (connection.status === "connected") return null;
  return {
    title: "Can't reach the gateway",
    message: [error.message, error.hint].filter(Boolean).join(" "),
  };
}

export type SettingsSection =
  | "gateway"
  | "accounts"
  | "conversation"
  | "usage"
  | "machines"
  | "checkins"
  | "updates"
  | "advanced";
type Section = SettingsSection;
/** The sections Settings registers, in its order, each with the line search shows for it. */
export const SETTINGS_SECTIONS: Array<[Section, string, string]> = [
  ["gateway", "Gateway", "The gateway, its address and this device"],
  ["accounts", "Accounts", "Provider accounts the bots run on"],
  ["conversation", "Conversation", "How long a bot's turn may run, and how the bots talk"],
  ["usage", "Usage", "Tokens, cost and warning budgets"],
  ["machines", "Machines", "Where the bots run"],
  ["checkins", "Check-ins", "When each bot checks in on its own"],
  ["updates", "Updates", "Clawtrate's own updates"],
  ["advanced", "Advanced", "Showing commands, thinking and external channel chats"],
];

/**
 * A switch kept on this device, off by default, that changes what the
 * conversation shows (conversation.md, 7.11). It applies at once.
 */
function DeviceSwitch({
  id,
  label,
  note,
  said,
  value: [shown, setShown],
  announce,
}: {
  id: string;
  label: string;
  note: string;
  /** What is announced once it is on, and once it is off. */
  said: [string, string];
  value: [boolean, (shown: boolean) => void];
  announce: (text: string) => void;
}) {
  return (
    <div className="b-field device-switch">
      <span className="device-switch-row">
        <span id={`${id}-label`}>{label}</span>
        <button
          type="button"
          className="b-switch"
          role="switch"
          aria-checked={shown}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-note`}
          data-testid={id}
          onClick={() => {
            setShown(!shown);
            announce(shown ? said[1] : said[0]);
          }}
        />
      </span>
      <p className="b-hint" id={`${id}-note`}>
        {note}
      </p>
    </div>
  );
}

/**
 * "Show commands" and "Show thinking", both off by default (conversation.md, 7.11), whether
 * chats from Discord, Telegram and other channels are listed, off by default (F-519), and
 * whether sessions other tools opened are listed, off by default (F-563).
 */
function AdvancedPane({ announce }: { announce: (text: string) => void }) {
  const commands = useShowCommands();
  const thinking = useShowThinking();
  const send = useCommand();
  const state = useClawtrateState();
  const showChannelChats = state.showChannelChats === true;
  const [channelError, setChannelError] = useState<string | null>(null);
  const showOtherTools = state.showOtherToolSessions === true;
  const [otherToolsError, setOtherToolsError] = useState<string | null>(null);
  const toggleOtherTools = () => {
    const on = !showOtherTools;
    setOtherToolsError(null);
    void send({ type: "setShowOtherToolSessions", on }).then(
      () => announce(on ? "Sessions from other tools shown" : "Sessions from other tools hidden"),
      (failure: unknown) =>
        setOtherToolsError(failure instanceof Error ? failure.message : String(failure)),
    );
  };
  const toggleChannelChats = () => {
    const on = !showChannelChats;
    setChannelError(null);
    void send({ type: "setShowChannelChats", on }).then(
      () => announce(on ? "Channel chats shown" : "Channel chats hidden"),
      (failure: unknown) =>
        setChannelError(failure instanceof Error ? failure.message : String(failure)),
    );
  };
  return (
    <>
      <DeviceSwitch
        id="show-commands"
        label="Show commands"
        note="Shows each action as its own card with its command or call, in the conversation and the Computer tab."
        said={["Commands shown", "Commands hidden"]}
        value={commands}
        announce={announce}
      />
      <DeviceSwitch
        id="show-thinking"
        label="Show thinking"
        note="Shows a bot's reasoning: Thought lines in the conversation, and its thinking while it works."
        said={["Thinking shown", "Thinking hidden"]}
        value={thinking}
        announce={announce}
      />
      <div className="b-field channel-chats-field">
        <span id="channel-chats-label">Show external channel chats</span>
        <button
          type="button"
          className="b-switch"
          role="switch"
          aria-checked={showChannelChats}
          aria-labelledby="channel-chats-label"
          aria-describedby="channel-chats-note"
          data-testid="channel-chats"
          onClick={toggleChannelChats}
        />
      </div>
      <p className="b-hint" id="channel-chats-note">
        Off by default. Chats that reach a bot through Discord, Telegram, Slack, iMessage, WhatsApp,
        Signal or another channel stay out of the task list, its previews and its unread marks. A
        bot's main conversation always shows. If the gateway sends a channel's direct messages to
        it, which it does unless its <code>session.dmScope</code> setting gives each channel
        conversation its own session, those messages still appear there.
      </p>
      {channelError && (
        <div className="form-error" role="alert">
          {channelError}
        </div>
      )}
      <div className="b-field channel-chats-field">
        <span id="other-tools-label">Show sessions from other tools</span>
        <button
          type="button"
          className="b-switch"
          role="switch"
          aria-checked={showOtherTools}
          aria-labelledby="other-tools-label"
          aria-describedby="other-tools-note"
          data-testid="other-tool-sessions"
          onClick={toggleOtherTools}
        />
      </div>
      <p className="b-hint" id="other-tools-note">
        Off by default. Sessions that an API client, a scheduled routine or another tool started
        with a bot stay out of the task list, its previews and its unread marks. A routine&apos;s
        runs open from Routines. One that is waiting for your approval or answer always shows.
      </p>
      {otherToolsError && (
        <div className="form-error" role="alert">
          {otherToolsError}
        </div>
      )}
    </>
  );
}

/**
 * How long a bot's turn may run before Clawtrate stops it, in minutes; 50 by default (F-100).
 * How the bots talk (F-527).
 */
function ConversationPane({
  announce,
  canWrite,
}: {
  announce: (text: string) => void;
  canWrite: boolean;
}) {
  const send = useCommand();
  const state = useClawtrateState();
  const minutes = state.turnLimitMinutes ?? 50;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const next = Number(draft);
    if (!Number.isInteger(next) || next < 1 || next > 1440) {
      setError("A turn time limit is a whole number of minutes from 1 to 1440.");
      return;
    }
    setError(null);
    setDraft(null);
    if (next === minutes) return;
    void send({ type: "setTurnLimit", minutes: next }).then(
      () => announce(`Turn time limit set to ${next} minutes`),
      (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)),
    );
  };
  return (
    <>
      <label className="b-field">
        <span>Turn time limit</span>
        <span className="turn-limit-field">
          <input
            className="input"
            type="number"
            inputMode="numeric"
            min={1}
            max={1440}
            step={1}
            value={draft ?? String(minutes)}
            data-testid="turn-limit"
            aria-describedby="turn-limit-note"
            aria-invalid={error ? true : undefined}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
            }}
          />
          <span aria-hidden="true">minutes</span>
        </span>
      </label>
      <p className="b-hint" id="turn-limit-note">
        Minutes. 50 by default. At the limit Clawtrate asks the gateway to stop the turn so it does
        not hang, and once the gateway confirms, the turn ends with a note naming the limit. Send a
        message to pick up where it left off. It applies to turns this device starts.
      </p>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <BotVoicePane canWrite={canWrite} announce={announce} />
    </>
  );
}

/** The voice plugin's page in Clawtrate's own repository: how to set it up, and what it covers. */
const VOICE_README =
  "https://github.com/sidebandstudio/clawtrate/blob/main/plugins/clawtrate-voice/README.md";
const VOICE_SETUP = `${VOICE_README}#turning-it-on-for-a-gateway`;
const VOICE_LIMITS = `${VOICE_README}#where-the-guide-doesnt-reach`;
const VOICE_UPDATE = `${VOICE_README}#updating-it`;

function VoiceLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="button"
      data-variant="quiet"
      data-size="sm"
      href={href}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children} <ExternalIcon />
    </a>
  );
}

const VoiceSetupLink = () => <VoiceLink href={VOICE_SETUP}>How to set it up</VoiceLink>;

/** One of the two hook settings, what it must be, and whether it blocks the hook now. */
function HookSetting({
  name,
  rule,
  permits,
}: {
  name: string;
  rule: string;
  permits: boolean | undefined;
}) {
  return (
    <li data-testid={`bot-voice-${name}`}>
      <code>{name}</code> {rule}
      {permits === undefined ? "" : permits ? " It does." : " It doesn't, so it blocks the hook."}
    </li>
  );
}

/**
 * F-527: the voice plugin's setting, as the gateway reads it back, and whether the gateway
 * permits its prompt hook. Those are separate facts, and neither says that every run got the
 * guide: the gateway doesn't build a system prompt for every run (VOICE_LIMITS). The plugin
 * changes what the bots are asked to do; nothing here rewrites what a bot wrote. The value is
 * read again after every new hello, after the gateway reports a change (the plugin's event, or
 * its plugins changing), and after a save that failed. Until then whatever was read last, a
 * missing plugin and a refusal included, is shown as unconfirmed.
 */
function BotVoicePane({
  canWrite,
  announce,
}: {
  canWrite: boolean;
  announce: (text: string) => void;
}) {
  const bridge = useBridge();
  const { connection, voiceChanges } = useClawtrateState();
  const connected = connection.status === "connected";
  const [stored, setVoice] = useState<BotVoiceAnswer | null>(null);
  // Only the connected gateway's own answer is shown: after a switch, the last one's is dropped.
  // Same identity and same host target, or not this connection's at all (`GatewayStamp`).
  const here = (stamp: GatewayStamp | undefined) =>
    stamp?.gatewayId === connection.gatewayId && stamp.target === connection.target;
  const voice = here(stored?.stamp) ? stored : null;
  // Which read the value shown answers: a new hello, a reported change or a retry asks for another.
  const [readsDone, setReadsDone] = useState<string | null>(null);
  // A failed read, with the read it answered: a newer read, a retry or a switch, hides it.
  const [failedRead, setReadError] = useState<{ message: string; key: string } | null>(null);
  // A refused or lost save, with where its setting was read: shown only on that same connection.
  const [failedSave, setSaveError] = useState<{ message: string; stamp: GatewayStamp } | null>(
    null,
  );
  const saveError = failedSave !== null && here(failedSave.stamp) ? failedSave.message : null;
  // The save on its way, with where its setting was read: it holds back only that same
  // connection's switch, and only its own answer clears it.
  const [pending, setPending] = useState<{ stamp: GatewayStamp } | null>(null);
  const saving = pending !== null && here(pending.stamp);
  // The latest save asked for, and the connection on screen now, for a save's late answer.
  const lastSave = useRef<object | null>(null);
  const shownOn = useRef({ gatewayId: connection.gatewayId, target: connection.target });
  useEffect(() => {
    shownOn.current = { gatewayId: connection.gatewayId, target: connection.target };
  }, [connection.gatewayId, connection.target]);
  const [reads, setReads] = useState(0);
  // Each time the link comes back, the browser's to the host or the host's to the gateway, the
  // read after it is a new one: an answer from before never confirms it.
  const [link, setLink] = useState({ connected, n: 0 });
  if (link.connected !== connected) setLink({ connected, n: link.n + (connected ? 1 : 0) });
  // A new hello, a reported change, a retry, a reconnect or the gateway naming itself: another read.
  const readKey = [
    reads,
    link.n,
    connection.connectedAt ?? "",
    voiceChanges ?? 0,
    connection.gatewayId ?? "",
    connection.target,
  ].join(":");
  const error = failedRead?.key === readKey ? failedRead.message : null;
  // The key now, for a save's answer that arrives after a newer read was asked for.
  const keyNow = useRef(readKey);
  useEffect(() => {
    keyNow.current = readKey;
  }, [readKey]);
  // A save's answer that arrives after the pane closed belongs to no screen: it is dropped.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!connected) return;
    let live = true;
    bridge.invoke({ type: "readBotVoice" }).then(
      (read) => {
        if (!live) return;
        setVoice(read);
        setReadsDone(readKey);
        setReadError(null);
      },
      (failure: unknown) =>
        live &&
        setReadError({
          message: failure instanceof Error ? failure.message : String(failure),
          key: readKey,
        }),
    );
    return () => {
      live = false;
    };
  }, [bridge, readKey, connected]);
  // True while the value shown is the gateway's latest answer to this connection.
  const fresh = readsDone === readKey;
  const confirmed = connected && fresh;
  const retry = (
    <div className="b-actions">
      <button type="button" className="button" onClick={() => setReads((n) => n + 1)}>
        Try again
      </button>
    </div>
  );

  if (!voice)
    return error ? (
      <div className="b-note" data-tone="danger" role="alert" data-testid="bot-voice">
        <div>
          <p>Couldn't read the bots' voice setting. {error}</p>
          {retry}
        </div>
      </div>
    ) : (
      <p className="b-hint" data-testid="bot-voice">
        {connected
          ? "Reading the bots' voice setting from the gateway…"
          : "The bots' voice setting is read once Clawtrate is connected."}
      </p>
    );

  // A gateway that doesn't say which gateway it is: a change can't be tied to it, so none is offered.
  if (stored?.stamp.gatewayId === null && connected && fresh)
    return (
      <div className="b-note" data-tone="warn" data-testid="bot-voice">
        <div>
          <p data-testid="bot-voice-unidentified">
            The gateway didn't say which gateway it is, so Clawtrate can't tie a change to it. Bot
            voice isn't available on this connection.
          </p>
          {retry}
        </div>
      </div>
    );

  // Whether what follows is the gateway's latest answer, for every kind of answer.
  const freshness = confirmed ? null : (
    <div data-testid="bot-voice-freshness">
      {!connected ? (
        <p className="b-hint">Not connected. This is what the gateway said when last read.</p>
      ) : error ? (
        <>
          <div className="form-error" role="alert">
            Couldn't read the setting again. {error} This is what the gateway said when last read.
          </div>
          {retry}
        </>
      ) : (
        <p className="b-hint">Checking with the gateway. This is what it said when last read.</p>
      )}
    </div>
  );

  if (voice.status === "missing")
    return (
      <div className="bot-voice" data-testid="bot-voice" data-confirmed={confirmed}>
        {freshness}
        <div className="b-note">
          <div>
            <p>
              Bot voice needs Clawtrate's voice plugin, <code>clawtrate-voice</code>, on the
              gateway. Without it the bots talk the way their own instructions say.
            </p>
            <div className="b-actions">
              <VoiceSetupLink />
            </div>
          </div>
        </div>
      </div>
    );
  if (voice.status === "refused")
    return (
      <div className="bot-voice" data-testid="bot-voice" data-confirmed={confirmed}>
        {freshness}
        <div className="b-note" data-tone="warn">
          <div>
            <p data-testid="bot-voice-refused">
              {voice.advertised
                ? "The gateway has Clawtrate's voice plugin, but it won't show this connection the setting. The plugin on the gateway may be a different version from the one this Clawtrate works with."
                : "Clawtrate can't tell whether the gateway has its voice plugin. The gateway refused to show the setting, which it also does when the plugin isn't there."}{" "}
              The gateway said: {voice.message}
            </p>
            <div className="b-actions">
              <VoiceSetupLink />
            </div>
          </div>
        </div>
      </div>
    );
  const change = (on: boolean, section: "voice" | "where" = "voice") => {
    // Bound to the gateway whose setting is on screen: the host refuses it for any other.
    const asked = { key: readKey, stamp: voice.stamp };
    setPending(asked);
    lastSave.current = asked;
    setSaveError(null);
    // Superseded once the pane closes or a newer read is asked for: its answer then neither
    // replaces that read nor is announced.
    const current = () => mounted.current && keyNow.current === asked.key;
    void bridge.invoke({ type: "setBotVoice", on, stamp: asked.stamp, section }).then(
      (read) => {
        if (!mounted.current) return;
        setPending((now) => (now === asked ? null : now));
        if (!current()) return;
        setVoice(read);
        setReadsDone(asked.key);
        if (read.status !== "read") return;
        if (section === "voice") announce(`Bot voice ${read.on ? "on" : "off"}`);
        else if (read.where) announce(`Task guide ${read.where.on ? "on" : "off"}`);
      },
      (failure: unknown) => {
        if (!mounted.current) return;
        setPending((now) => (now === asked ? null : now));
        // A failure is this screen's while it is the latest save on the connection it was made
        // on, even after a newer read: that read may predate what the gateway stored.
        const on = shownOn.current;
        if (
          lastSave.current !== asked ||
          on.gatewayId !== asked.stamp.gatewayId ||
          on.target !== asked.stamp.target
        )
          return;
        // Refused, or the answer was lost: either way, what the gateway holds is read back.
        setSaveError({
          message: failure instanceof Error ? failure.message : String(failure),
          stamp: asked.stamp,
        });
        setReads((n) => n + 1);
      },
    );
  };
  const settings = voice.hookSettings;
  const where = voice.where;
  const stateLine = (on: boolean, changedAt: number | null) =>
    confirmed
      ? `${on ? "On" : "Off"}, as the gateway reads it${changedAt === null ? ", by default" : ""}.`
      : connected
        ? `${on ? "On" : "Off"} when last read. Checking with the gateway…`
        : `${on ? "On" : "Off"} when last read. Not connected, so it isn't confirmed.`;
  return (
    <div className="bot-voice" data-testid="bot-voice" data-confirmed={confirmed}>
      <div className="facts">
        <div className="b-row">
          <span className="b-row-main">
            <span id="bot-voice-label">Bot voice</span>
            <small data-testid="bot-voice-state">{stateLine(voice.on, voice.changedAt)}</small>
          </span>
          <button
            type="button"
            className="b-switch"
            role="switch"
            aria-checked={voice.on}
            aria-labelledby="bot-voice-label"
            aria-describedby="bot-voice-note"
            aria-busy={saving || undefined}
            // Unavailable while its own save is on its way, and still focused.
            aria-disabled={saving || undefined}
            disabled={!canWrite || !confirmed}
            data-testid="bot-voice-switch"
            onClick={() => {
              if (!saving) change(!voice.on);
            }}
          />
        </div>
      </div>
      <p className="b-hint" id="bot-voice-note">
        While it's on, a voice guide is added to a bot's system prompt each time the gateway runs
        the plugin's hook, if its config permits the hook. The guide asks the bots to talk plainly
        and kindly, with no em dashes. Turned off, each bot talks the way its own instructions say.
        {!canWrite && " Changing it needs write access."}
      </p>
      {where ? (
        <>
          <div className="facts">
            <div className="b-row">
              <span className="b-row-main">
                <span id="bot-where-label">Task guide</span>
                <small data-testid="bot-where-state">{stateLine(where.on, where.changedAt)}</small>
              </span>
              <button
                type="button"
                className="b-switch"
                role="switch"
                aria-checked={where.on}
                aria-labelledby="bot-where-label"
                aria-describedby="bot-where-note"
                aria-busy={saving || undefined}
                aria-disabled={saving || undefined}
                disabled={!canWrite || !confirmed}
                data-testid="bot-where-switch"
                onClick={() => {
                  if (!saving) change(!where.on, "where");
                }}
              />
            </div>
          </div>
          <p className="b-hint" id="bot-where-note">
            While it's on, a short guide in the same place tells each bot what Clawtrate's words
            mean, and that "put this in a task" means starting a task of its own, listed under its
            name. Turned off, the bots aren't told.
          </p>
        </>
      ) : (
        <div className="b-note" data-tone="warn" data-testid="bot-where-old">
          <div>
            <p>
              The gateway's voice plugin is{" "}
              {voice.version ? `version ${voice.version}` : "an older version"}, from before the
              task guide, so the bots aren't told what a task is.{" "}
              {connection.canAdmin
                ? "Clawtrate loads a newer copy by itself when the plugin's files on the gateway have one, and these are still that version. Once they are updated, it loads them the next time it connects."
                : "With admin access, Clawtrate loads a newer copy by itself when the plugin's files on the gateway have one. This connection doesn't have admin access."}
            </p>
            <div className="b-actions">
              <VoiceLink href={VOICE_UPDATE}>How to update it</VoiceLink>
            </div>
          </div>
        </div>
      )}
      <dl className="facts bot-voice-hook">
        <div>
          <dt>Prompt hook permitted</dt>
          <dd data-testid="bot-voice-hook" className="b-wrap-value">
            {!confirmed ? "Not confirmed yet." : voice.hook === "allowed" ? "Yes" : "No"}
          </dd>
        </div>
      </dl>
      <div className="b-actions bot-voice-limits">
        <VoiceLink href={VOICE_LIMITS}>Where the guide doesn't reach</VoiceLink>
      </div>
      {confirmed && voice.hook !== "allowed" && (
        <div className="b-note" data-tone="warn" data-testid="bot-voice-blocked">
          <div>
            <p>
              The gateway's config doesn't permit the voice plugin's prompt hook, so no bot gets the
              guide. Under <code>plugins.entries.clawtrate-voice.hooks</code> both of these must
              permit it:
            </p>
            <ul>
              <HookSetting
                name="allowConversationAccess"
                rule="must be true."
                permits={settings?.allowConversationAccess}
              />
              <HookSetting
                name="allowPromptInjection"
                rule="must not be false."
                permits={settings?.allowPromptInjection}
              />
            </ul>
            <p>Then restart the gateway. Clawtrate doesn't change the gateway's config.</p>
            <div className="b-actions">
              <VoiceSetupLink />
            </div>
          </div>
        </div>
      )}
      {saveError !== null && (
        <div className="form-error" role="alert">
          {saveError}
        </div>
      )}
      {freshness}
      <details className="b-disclosure" data-testid="bot-voice-guide">
        <summary>
          <ChevronIcon />
          What the guide asks the bots to do
        </summary>
        <div className="b-disclosure-body">
          <pre className="bot-voice-guide">{voice.guide}</pre>
        </div>
      </details>
      {where && (
        <details className="b-disclosure" data-testid="bot-where-guide">
          <summary>
            <ChevronIcon />
            What the task guide tells the bots
          </summary>
          <div className="b-disclosure-body">
            <pre className="bot-voice-guide">{where.guide}</pre>
          </div>
        </details>
      )}
    </div>
  );
}

/** ⌘, opens on the section last shown, Gateway the first time. */
const SHOWN_LAST = "settings-section";

function GatewayConnectionButton({ action }: { action: "retry" | "suspend" }) {
  const send = useCommand();
  const [failed, setFailed] = useState(false);
  const reconnect = action === "retry";
  const apply = () => {
    setFailed(false);
    void send({ type: action }).then(
      () => setFailed(false),
      () => setFailed(true),
    );
  };
  return (
    <>
      <button
        type="button"
        className="button"
        data-variant={reconnect ? "primary" : undefined}
        onClick={apply}
      >
        {reconnect ? "Reconnect" : "Disconnect"}
      </button>
      {failed && (
        <div className="form-error" role="alert">
          {reconnect
            ? "Could not reconnect to this gateway."
            : "Could not disconnect from this gateway."}
        </div>
      )}
    </>
  );
}

export function Settings({
  connection,
  info,
  accounts,
  checkIns,
  bots,
  waitingMessages,
  initialSection,
  updateReading,
  onClose,
}: {
  connection: ConnectionState;
  info: HostInfo;
  accounts: AccountsState;
  checkIns: CheckInsState | undefined;
  bots: readonly Bot[];
  waitingMessages: string;
  /** The section to open on; otherwise the one shown last. */
  initialSection: Section | null;
  updateReading: ReturnType<typeof useDesktopUpdateSnapshot>;
  onClose: () => void;
}) {
  const send = useCommand();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [section, setSectionState] = useState<Section>(
    () => initialSection ?? recall<Section>(SHOWN_LAST) ?? "gateway",
  );
  // On a phone the list comes first; a section replaces it.
  const [pane, setPane] = useState<"nav" | "section">(initialSection ? "section" : "nav");
  const narrow = useNarrow();
  const sectionShown = pane === "section" || !narrow;
  const [announcer, announce] = useAnnouncer();
  const setSection = (next: Section) => {
    remember(SHOWN_LAST, next);
    // Focus the mounted heading during navigation, before the next key can reach a control.
    flushSync(() => {
      setSectionState(next);
      setPane("section");
    });
    dialogRef.current?.querySelector<HTMLElement>("#b-section-title")?.focus();
  };
  const { forget, failure: forgetProblem } = useForget();
  const gatewayUrl = connection.gatewayUrl;
  const state = gatewayState(connection);
  const problem = gatewayProblem(connection);
  const canReconnect = state === "Offline" || state === "Disconnected";
  const canDisconnect =
    connection.status === "connected" ||
    connection.status === "connecting" ||
    connection.status === "reconnecting";
  const deviceName =
    info.deviceName ?? (info.kind === "desktop" ? "Clawtrate Desktop" : "Clawtrate Web");
  // Re-pair (F-456): ask the gateway's owner for this device's interactive access. The old
  // authorization keeps working until they approve; then the new one replaces it.
  const upgrade = connection.upgrade;
  const holdsAll =
    connection.status === "connected" &&
    INTERACTIVE_SCOPES.every((scope) => scopeSatisfied(connection.scopes, scope));
  const rePairing = upgrade.status === "requesting" || upgrade.status === "pending";
  // A full pairing's grant is the gateway's limit: nothing asks for more (setup-effortless.md §2).
  const canRePair =
    !info.readOnly &&
    connection.status === "connected" &&
    !holdsAll &&
    !rePairing &&
    !connection.fullPairing;
  const missing = notGranted(connection);
  const narrower =
    missing.length > 0
      ? `OpenClaw granted less than full control. Not granted: ${missing.join(", ")}. This device keeps what was granted.`
      : null;
  const access =
    connection.status === "connected" && (connection.fullPairing || connection.fullOffer !== null)
      ? connection.fullPairing && missing.length === 0
        ? "Full control"
        : "Less than full control"
      : null;
  // Said once when a reconnect changes the access shown, not each render nor when Settings opens.
  // What a connected gateway showed is kept across a disconnect, so the same grant after
  // Reconnect says nothing; another gateway, or one that shows no access, clears what was said.
  const accessSaid = [access && `Access: ${access}.`, narrower].filter(Boolean).join(" ");
  const gateway = connection.gatewayUrl;
  const accessShown = useRef({ gateway, said: accessSaid });
  useEffect(() => {
    const shown = accessShown.current;
    if (shown.gateway !== gateway) {
      accessShown.current = { gateway, said: accessSaid };
      announce("");
      return;
    }
    if (connection.status !== "connected" || shown.said === accessSaid) return;
    accessShown.current = { gateway, said: accessSaid };
    announce(accessSaid);
  }, [gateway, connection.status, accessSaid, announce]);
  const rePairProblem =
    upgrade.status === "rejected"
      ? "The gateway's owner rejected the new pairing. This device keeps its earlier access."
      : upgrade.status === "expired"
        ? "The pairing request expired before it was approved. This device keeps its earlier access."
        : upgrade.status === "error"
          ? `Couldn't re-pair. ${upgrade.error ?? ""}`.trim()
          : null;

  useEffect(() => {
    const dialog = dialogRef.current;
    const close = [...(dialog?.querySelectorAll<HTMLElement>(".settings-close") ?? [])].find(
      (each) => each.getClientRects().length > 0,
    );
    close?.focus();
  }, []);

  // An action replaces its own button (Disconnect gives way to Reconnect, and
  // back), which drops focus out of the dialog. Put it on the action that took
  // its place, or on Close, so focus and Escape stay in the dialog.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.contains(document.activeElement)) return;
    (
      dialog.querySelector<HTMLElement>(".settings-actions .button") ??
      dialog.querySelector<HTMLElement>(".settings-close")
    )?.focus();
  });

  const dot =
    state === "Connected"
      ? "connected"
      : state === "Connecting" || state === "Pairing pending"
        ? "connecting"
        : state === "Offline"
          ? "error"
          : "disconnected";

  const toNav = (
    <button
      type="button"
      className="icon-button b-back"
      data-variant="quiet"
      data-b="to-nav"
      aria-label="Back to settings"
      onClick={() => {
        setPane("nav");
        requestAnimationFrame(() =>
          dialogRef.current
            ?.querySelector<HTMLElement>('.b-nav-item[aria-current="page"]')
            ?.focus(),
        );
      }}
    >
      <BackIcon />
    </button>
  );
  const closeButton = (
    <button
      type="button"
      className="icon-button b-close settings-close"
      aria-label="Close settings"
      title="Close (Esc)"
      onClick={onClose}
    >
      <CloseIcon />
    </button>
  );

  const accountsSection = useAccountsSection({
    refreshOnOpen: section !== "updates",
    accounts,
    bots,
    connection,
    info,
    announce,
    toNav,
  });
  const usageSection = useUsageSection({
    bots,
    connection,
    info,
    announce,
    toNav,
    shown: sectionShown,
  });
  const machinesSection = useMachinesSection({
    active: section === "machines",
    connection,
    info,
    bots,
    announce,
    toNav,
  });
  const checkInsSection = useCheckInsSection({
    active: section === "checkins",
    checkIns,
    bots,
    connection,
    info,
    announce,
    toNav,
  });

  const gatewayPane = (
    <>
      <dl className="facts" data-testid="gateway-facts">
        <div>
          <dt>Address</dt>
          <dd title={connection.gatewayUrl ?? undefined}>{connection.gatewayUrl ?? "None yet"}</dd>
        </div>
        <div>
          <dt>State</dt>
          <dd className="settings-state" data-testid="gateway-state">
            <span className="status-dot" data-status={dot} aria-hidden="true" />
            {state}
          </dd>
        </div>
        <div>
          <dt>This device</dt>
          <dd>
            {deviceName}
            {connection.deviceId ? ` · ${connection.deviceId.slice(0, 8)}` : ""}
          </dd>
        </div>
        <div>
          <dt>Granted scopes</dt>
          <dd data-testid="granted-scopes" className="b-wrap-value">
            {connection.status === "connected" && connection.scopes.length > 0
              ? connection.scopes.join(", ")
              : "None while not connected"}
          </dd>
        </div>
        {connection.status === "connected" &&
          (connection.fullPairing || connection.fullOffer !== null) && (
            <div>
              <dt>Access</dt>
              <dd data-testid="gateway-access">{access}</dd>
            </div>
          )}
        {connection.serverVersion && (
          <div>
            <dt>Gateway</dt>
            <dd>
              OpenClaw {connection.serverVersion}
              {connection.protocol !== null ? ` · protocol ${connection.protocol}` : ""}
            </dd>
          </div>
        )}
      </dl>
      {missing.length > 0 && (
        <p className="settings-note" data-testid="narrower-grant">
          {narrower}
        </p>
      )}
      {/* The one-time offer stays here once answered (setup-effortless.md §6). */}
      {!info.readOnly &&
        connection.status === "connected" &&
        connection.fullOffer !== null &&
        connection.gatewayId !== null && <FullControlAsk connection={connection} />}
      {problem && (
        <div className="form-error" role="alert" data-testid="gateway-problem">
          <strong>{problem.title}</strong>
          {problem.message}
        </div>
      )}
      {/* The owner's decision on the full-control request shows whatever this device holds. */}
      {!info.readOnly && rePairProblem && (!holdsAll || isFullRequest(connection)) && (
        <div className="form-error" role="alert" data-testid="repair-problem">
          {rePairProblem}
        </div>
      )}
      {!info.readOnly && connection.status === "connected" && rePairing && (
        <div className="settings-repair" data-testid="repair-pending">
          <p>
            Waiting for the gateway's owner to approve this device's new pairing. It changes by
            itself once they approve or reject it; until then this device keeps its earlier access.
          </p>
          {upgrade.approveCommand && (
            <CommandLine command={upgrade.approveCommand} label="Copy approve command" />
          )}
          {upgrade.requestId && (
            <div className="access-id">
              <span className="mono">Request {upgrade.requestId.slice(0, 8)}</span>
              <CopyValue value={upgrade.requestId} label="Copy request id" />
            </div>
          )}
        </div>
      )}
      <div className="settings-actions">
        {canReconnect && <GatewayConnectionButton key={`retry:${gatewayUrl}`} action="retry" />}
        {canDisconnect && (
          <GatewayConnectionButton key={`suspend:${gatewayUrl}`} action="suspend" />
        )}
        {gatewayUrl && (
          <button
            type="button"
            className="button"
            data-variant="quiet"
            onClick={() => {
              // Settings stays open until the gateway is forgotten, to say if it was not.
              void forget(gatewayUrl).then((forgotten) => {
                if (forgotten) onClose();
              });
            }}
          >
            Use another gateway
          </button>
        )}
      </div>
      {forgetProblem && (
        <div className="form-error" role="alert" data-testid="forget-problem">
          {forgetProblem}
        </div>
      )}
      {canRePair && (
        <div className="settings-repair-actions">
          <button
            type="button"
            className="button"
            data-size="sm"
            onClick={() => void send({ type: "requestAccess" }).catch(() => {})}
          >
            Re-pair
          </button>
        </div>
      )}
      {connection.gatewayUrl && (
        <p className="settings-note">
          {gatewayTitle(connection)} keeps this device's pairing while it is disconnected.{" "}
          {connection.fullPairing
            ? ""
            : connection.canAdmin
              ? "This device holds admin access, which it asked for to change bots and accounts."
              : holdsAll
                ? "This device can send, stop and answer."
                : info.readOnly
                  ? "This device asks for read access only."
                  : "This device reads. Re-pair to ask for sending, stopping and answering."}
        </p>
      )}
    </>
  );

  let content: ReactNode;
  if (section === "accounts" && accountsSection.connect) content = accountsSection.connect;
  else {
    const view =
      section === "accounts" && accountsSection.view
        ? accountsSection.view
        : section === "checkins"
          ? checkInsSection
          : section === "conversation"
            ? {
                title: "Conversation",
                back: toNav,
                body: (
                  <ConversationPane
                    announce={announce}
                    canWrite={connection.canWrite && !info.readOnly}
                  />
                ),
                foot: null,
              }
            : section === "usage"
              ? usageSection
              : section === "machines"
                ? machinesSection
                : section === "updates"
                  ? {
                      title: "Updates",
                      back: toNav,
                      foot: null,
                      body: <Updates waitingMessages={waitingMessages} {...updateReading} />,
                    }
                  : section === "advanced"
                    ? {
                        title: "Advanced",
                        back: toNav,
                        foot: null,
                        body: <AdvancedPane announce={announce} />,
                      }
                    : { title: "Gateway", back: toNav, body: gatewayPane, foot: null };
    content = (
      <>
        <header className="b-section-head">
          {view.back}
          <h3 id="b-section-title" tabIndex={-1}>
            {view.title}
          </h3>
        </header>
        <div className="b-section-body">{view.body}</div>
        {view.foot && <footer className="b-section-foot">{view.foot}</footer>}
      </>
    );
  }

  return (
    <Dialog kind="settings" labelledBy="settings-title" onClose={onClose} testId="settings">
      <div className="b-settings" data-pane={pane} ref={dialogRef}>
        <nav className="b-nav" aria-label="Settings">
          <div className="b-nav-head">
            <h2 id="settings-title">Settings</h2>
            {closeButton}
          </div>
          {SETTINGS_SECTIONS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="b-nav-item"
              aria-current={id === section ? "page" : undefined}
              onClick={() => setSection(id)}
            >
              {label}
              <ChevronIcon />
            </button>
          ))}
        </nav>
        <section className="b-section" aria-labelledby="b-section-title">
          {closeButton}
          {content}
        </section>
        {section !== "updates" && announcer}
      </div>
    </Dialog>
  );
}
