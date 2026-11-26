// A bot's settings, in the Work pane's Settings tab (bots.md sections 8 to
// 11): its account and the word for it, model and effort, and the Account
// page: bound, locked or the gateway choosing, each with its sentence; the
// lock command for the gateway's owner, which Clawtrate never runs; the
// evidence read from the gateway's order; and changing the account.

import {
  accountWord,
  lockCommand,
  orderNeedsStoppedGateway,
  retainedOrder,
  stoppedGatewaySteps,
  unlockCommand,
  type AccountsState,
  type Bot,
  type ConnectionState,
  type HostInfo,
  type Task,
  type Transcript,
} from "@clawtrate/core";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useBridge } from "../bridge.tsx";
import { screenStamp, shownStamp, type ShownStamp } from "../stamp.ts";
import {
  BackIcon,
  CheckIcon,
  ChevronIcon,
  ClockIcon,
  LockIcon,
  PlusIcon,
  ShieldIcon,
  WarnIcon,
} from "../icons.tsx";
import { AccountChoices, GATEWAY_CHOICE, gatewayLine } from "./AccountChoices.tsx";
import { ClearOrderConfirm, ClearOutcome, type ClearAsk } from "./ClearOrder.tsx";
import { Connect } from "./Connect.tsx";
import { ModelPair, rowFor, useModelList } from "./ModelPair.tsx";
import { UpdateOpenClawNote } from "./UpdateOpenClaw.tsx";
import { ManageGroup } from "./DeleteBot.tsx";
import { connectionKey, RunsOnPage, RunsOnRow, usePlacement } from "../machines/RunsOn.tsx";
import { BotMemory, MemoryRow } from "../memory/BotMemory.tsx";
import { StartTasksRow } from "./StartTasks.tsx";
import { AdminBar, CommandBlock, GrantedBar, Note, useGranted, Wait } from "./parts.tsx";
import {
  accountName,
  bindingWord,
  clock,
  defaultRef,
  effortFor,
  firstModel,
  gatewayCli,
  kindWord,
  levelWord,
  LOCK_OLD_MS,
  lockClaim,
  lockText,
  providerName,
  stateWord,
} from "./words.ts";

/** How often the Account page reads the order: 4 s after the lock command was copied, else 30 s. */
export const WATCH_MS = 4_000;
export const CHECK_MS = 30_000;

/** Why a gateway's order changes need it stopped (OpenClaw 2026.10.10 on), and what that means. */
const STOPPED_WHY =
  "This version of OpenClaw changes a bot's account order only while the gateway is stopped. Stopping it gives work under way up to about five minutes to finish, then stops what is left. Until it starts again, none of your bots runs and Clawtrate can't reach the gateway.";

/**
 * An order command as such a gateway needs it, in its own steps: stop it, run the command, start
 * it. `gateway stop` and `start` act on the gateway's service: with none installed, stop does
 * nothing and says it succeeded, and start fails (OpenClaw's `docs/cli/gateway/service.md`), so
 * the line for a gateway run by hand comes before the steps. Step 3 is needed whatever step 2
 * did, or the gateway stays stopped.
 */
function StoppedSteps({
  cli,
  command,
  label,
  onCopied,
}: {
  cli: string;
  command: string;
  label: string;
  onCopied?: () => void;
}) {
  const [stop, run, start] = stoppedGatewaySteps(cli, command);
  return (
    <>
      <p className="b-hint" data-testid="unmanaged-hint">
        These steps stop and start the gateway's service. If you run the gateway yourself, with{" "}
        <code>openclaw gateway run</code>, stop it and start it again where it runs instead.
      </p>
      <ol className="b-steps" data-testid="stopped-steps">
        <li>
          <p>Stop the gateway, and wait until it has stopped; this can take a few minutes:</p>
          <CommandBlock command={stop} label="Copy stop command" />
        </li>
        <li>
          <p>Then run:</p>
          <CommandBlock command={run} label={label} {...(onCopied ? { onCopied } : {})} />
        </li>
        <li>
          <p>Start the gateway again, even if the command above failed:</p>
          <CommandBlock command={start} label="Copy start command" />
        </li>
      </ol>
    </>
  );
}

type View = "main" | "account" | "change" | "connect" | "runs" | "memory";

export function BotSettings({
  bot,
  accounts,
  bots,
  tasks,
  transcripts,
  connection,
  info,
  visible,
  announce,
  usagePage = null,
  extraGroups = null,
  onDeleteBot = null,
}: {
  bot: Bot;
  accounts: AccountsState;
  bots: readonly Bot[];
  tasks: readonly Task[];
  transcripts: Record<string, Transcript>;
  connection: ConnectionState;
  info: HostInfo;
  visible: boolean;
  announce: (text: string) => void;
  /** A page that replaces the tab's content while it is open (the Usage page). */
  usagePage?: ReactNode;
  /** Groups after the Model group on the tab's first page (Usage). */
  extraGroups?: ReactNode;
  /** Opens Delete bot… for this bot; absent where the host offers no delete. */
  onDeleteBot?: (() => void) | null;
}) {
  const bridge = useBridge();
  const [view, setView] = useState<View>("main");
  const [watching, setWatching] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const [pickModel, setPickModel] = useState<string | null>(null);
  const [pickEffort, setPickEffort] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [effortNote, setEffortNote] = useState<string | null>(null);
  // Unlock and Clear (#660): the confirmation open, where its page was read, and since when the
  // Account page has been open (a press before that isn't this visit's to report).
  const [ask, setAsk] = useState<ClearAsk | null>(null);
  const [asking, setAsking] = useState(false);
  const askedOn = useRef<ShownStamp | null>(null);
  const [pageSince, setPageSince] = useState(0);
  // The page's clock: evidence ages while the page stays open, and with every change of the connection.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const frame = requestAnimationFrame(() => setNow(Date.now()));
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
    };
  }, [connection.status, connection.connectedAt]);
  const rootRef = useRef<HTMLDivElement>(null);
  const granted = useGranted(connection);
  const admin = connection.canAdmin;
  const binding = accounts.bindings.find((each) => each.botId === bot.id) ?? null;
  // "View more" for the bot's model, and for Change account's provider: each read when opened
  // and held by this screen only.
  const mainProvider = binding?.provider ?? defaultRef(accounts)?.provider ?? null;
  const changeChosen =
    pick ?? (binding?.mode === "gateway" ? GATEWAY_CHOICE : (binding?.account ?? null));
  const changeProvider =
    changeChosen === GATEWAY_CHOICE
      ? mainProvider
      : (accounts.accounts.find((a) => a.id === changeChosen)?.provider ?? null);
  // Each pair counts as shown only while its page is on screen: Settings is the tab in view, and
  // Usage isn't standing in for the page.
  const onScreen = visible && usagePage === null;
  const mainModels = useModelList(mainProvider ?? "", connection, onScreen && view === "main");
  const changeModels = useModelList(
    changeProvider ?? "",
    connection,
    onScreen && view === "change",
  );
  const account = binding?.account
    ? (accounts.accounts.find((a) => a.id === binding.account) ?? null)
    : null;
  const word = binding ? accountWord(binding) : null;
  const name = bot.name;
  // Where the bot runs (controls.md section 14): read while the tab shows its first page or that page.
  const placement = usePlacement(
    bot.id,
    connection,
    visible && (view === "main" || view === "runs"),
  );
  const nameOf = (id: string) => bots.find((each) => each.id === id)?.name ?? id;

  // The tab reads the accounts when it is first shown, and again, once, for a bot the
  // last read did not have (one another client made since).
  const shown = visible;
  const unread = accounts.status === "ready" && !accounts.bindings.some((b) => b.botId === bot.id);
  useEffect(() => {
    if (shown && (accounts.status === "idle" || unread))
      void bridge.send({ type: "refreshAccounts" }).catch(() => {});
  }, [shown, accounts.status, unread, bot.id, bridge]);

  // Another bot: back to the tab's first page.
  const [forBot, setForBot] = useState(bot.id);
  if (forBot !== bot.id) {
    setForBot(bot.id);
    setView("main");
    setWatching(false);
    setPick(null);
    setAsk(null);
  }

  // Every connect clears the gateway's id until its identity read answers, the reconnect that
  // brings an access grant too. The memory page stays through that; only another gateway replaces it.
  const [memoryGateway, setMemoryGateway] = useState(connection.gatewayId);
  if (connection.gatewayId !== null && connection.gatewayId !== memoryGateway)
    setMemoryGateway(connection.gatewayId);

  const focusIn = useCallback((selector: string) => {
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(selector)?.focus());
  }, []);
  // Where the accounts Change account offers were read (`AccountsState.readOn`): its choices come
  // from that read and go with its stamp. After a reconnect the accounts stay until read again, and
  // the identity that answered can be known first. When they are read on another connection, a
  // choice made from the earlier read is let go, and the new read's stamp goes with the next one.
  const [choicesRead, setChoicesRead] = useState(() => accounts.readOn ?? shownStamp(connection));
  const readKey = accounts.readOn
    ? `${accounts.readOn.gatewayId}\n${accounts.readOn.target}\n${accounts.readOn.connectedAt}`
    : null;
  const [choicesFrom, setChoicesFrom] = useState(readKey);
  if (choicesFrom !== readKey) {
    setChoicesFrom(readKey);
    setPick(null);
    setPickModel(null);
    setPickEffort(null);
    setChoicesRead(accounts.readOn ?? shownStamp(connection));
  }
  const go = (next: View, focus: string = "[data-bs-focus]") => {
    setView(next);
    setError(null);
    if (next === "account" && view !== "account") setPageSince(Date.now());
    if (next === "change" && view !== "change")
      setChoicesRead(accounts.readOn ?? shownStamp(connection));
    if (next !== "change") setPick(null);
    focusIn(focus);
  };

  // The evidence: read when the Account page opens, every 4 seconds while it
  // is open after the lock command was copied, every 30 seconds otherwise.
  const onAccountPage = visible && view === "account";
  const connected = connection.status === "connected";
  useEffect(() => {
    if (!onAccountPage || !connected) return;
    void bridge.send({ type: "checkLock", botId: bot.id }).catch(() => {});
    const timer = setInterval(
      () => void bridge.send({ type: "checkLock", botId: bot.id }).catch(() => {}),
      watching && word !== "locked" ? WATCH_MS : CHECK_MS,
    );
    return () => clearInterval(timer);
  }, [onAccountPage, connected, watching, word, bot.id, bridge]);

  // A change of lock state is announced once; a background read never moves focus.
  const lastWord = useRef(word);
  useEffect(() => {
    if (lastWord.current === word) return;
    if (word === "locked" && lastWord.current !== null) {
      announce("Locked. The gateway confirmed it.");
      setWatching(false);
      if (document.activeElement?.closest("[data-bs='lock-check']")) focusIn("[data-bs-focus]");
    } else if (
      lastWord.current === "locked" &&
      word === "bound" &&
      // An Unlock pressed here says so in its own line.
      !(accounts.clear?.botId === bot.id && accounts.clear.status === "cleared")
    )
      announce(`${name} is no longer locked`);
    lastWord.current = word;
  }, [word, announce, name, focusIn, accounts.clear, bot.id]);

  const cli = gatewayCli(info, connection);
  const stopped = orderNeedsStoppedGateway(connection.serverVersion);
  const foot = granted ? (
    <GrantedBar />
  ) : !admin ? (
    <div className="b-panel-foot">
      <AdminBar
        connection={connection}
        info={info}
        need={`Changing ${name}'s settings needs admin access.`}
      />
    </div>
  ) : null;

  if (usagePage)
    return (
      <div ref={rootRef} className="b-tab" data-testid="bot-settings">
        {usagePage}
      </div>
    );
  // --- Where the bot runs (controls.md section 14): its own read, whatever the accounts do --
  if (view === "runs") {
    return (
      <div ref={rootRef}>
        <RunsOnPage
          // Another bot, connection or access: the old page and any form on it go.
          key={`${bot.id}\n${connectionKey(connection)}`}
          botId={bot.id}
          botName={name}
          read={placement.read}
          reload={placement.reload}
          begin={placement.begin}
          beginWorkspace={placement.beginWorkspace}
          commandsCurrent={placement.commandsCurrent}
          nameOf={nameOf}
          connection={connection}
          info={info}
          // The grant is detected here, where a reconnect's new scopes and connect time don't
          // remount the detector, not inside the page that this key does remount.
          granted={granted}
          announce={announce}
          onBack={() => go("main", "[data-bs='runs-on']")}
        />
      </div>
    );
  }

  if (view === "memory") {
    return (
      <div ref={rootRef} className="b-tab" data-testid="bot-settings">
        <BotMemory
          key={`${bot.id}\n${connection.gatewayUrl ?? ""}\n${connection.deviceId ?? ""}\n${memoryGateway ?? ""}\n${connection.target}`}
          botId={bot.id}
          visible={visible}
          name={name}
          connection={connection}
          info={info}
          announce={announce}
          onBack={() => go("main", "[data-bs='memory']")}
        />
      </div>
    );
  }

  const runsOnRow = (
    <RunsOnRow
      botName={name}
      read={placement.read}
      nameOf={nameOf}
      onOpen={() => {
        // The page reads the gateway each time it opens.
        placement.reload();
        go("runs");
      }}
    />
  );

  if (!binding) {
    const failed = accounts.status === "error";
    return (
      <div ref={rootRef} className="b-tab" data-testid="bot-settings">
        {failed ? (
          <div className="work-empty">
            <span className="empty-mark">
              <WarnIcon />
            </span>
            <h4>Couldn't load {name}'s settings</h4>
            <p>The gateway did not answer.</p>
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                className="button"
                data-size="sm"
                onClick={() => void bridge.send({ type: "refreshAccounts" })}
              >
                Try again
              </button>
            </div>
          </div>
        ) : (
          <div aria-busy="true" aria-label="Loading settings" data-testid="settings-loading">
            <div className="skeleton" style={{ height: 42, width: "100%", marginTop: 18 }} />
            <div className="skeleton" style={{ height: 96, width: "100%" }} />
            <div className="skeleton" style={{ height: 52, width: "100%" }} />
          </div>
        )}
        <MemoryRow onOpen={() => go("memory")} />
        <StartTasksRow name={name} botId={bot.id} transcripts={transcripts} />
        {extraGroups}
        {runsOnRow}
        <ManageGroup bot={bot} onDelete={onDeleteBot} />
      </div>
    );
  }

  const provider = binding.provider ?? defaultRef(accounts)?.provider ?? null;
  const who = provider ? providerName(provider) : "the provider";
  const sub = (title: string, back: View, from: string) => (
    <div className="b-subhead">
      <button
        type="button"
        className="icon-button"
        data-variant="quiet"
        aria-label={back === "main" ? "Back to settings" : "Back to account"}
        onClick={() => go(back, from)}
      >
        <BackIcon />
      </button>
      <h3 tabIndex={-1} data-bs-focus="">
        {title}
      </h3>
    </div>
  );
  // Evidence that is not a reading of the gateway as it is now: read while the connection is down,
  // or before the present connection was made. Either is shown as what it is, with its time.
  const checkedAt = binding.evidence.checkedAt;
  const offline = connection.status !== "connected";
  const beforeConnection =
    !offline &&
    checkedAt !== null &&
    connection.connectedAt !== null &&
    checkedAt < connection.connectedAt;
  const evidenceOld =
    checkedAt !== null && (offline || beforeConnection || now - checkedAt > LOCK_OLD_MS);
  // Every lock this tab names is worded from its evidence and that evidence's age.
  const age = { now, connected: !offline, connectedAt: connection.connectedAt };
  const lock = lockClaim(binding, age);

  // --- The tab's first page --------------------------------------------------------------
  if (view === "main") {
    const label =
      binding.mode === "account"
        ? account
          ? accountName(account, accounts)
          : (binding.account ?? "")
        : binding.mode === "gateway"
          ? who
          : "";
    const wordText = bindingWord(binding, age);
    const model = binding.model ?? defaultRef(accounts)?.model ?? null;
    // Where the page shown was read: a restored copy has the same bot ids.
    const shownOn = accounts.readOn ?? shownStamp(connection);
    const saveModel = async (nextModel: string, nextEffort: string | null) => {
      setError(null);
      try {
        await bridge.invoke({
          type: "setBotModel",
          botId: bot.id,
          model: nextModel,
          effort: nextEffort,
          stamp: await screenStamp(bridge, shownOn),
        });
        announce(nextModel !== model ? "Model saved" : "Effort saved");
      } catch (failure) {
        setError(
          `Couldn't save the model: ${failure instanceof Error ? failure.message : String(failure)}`,
        );
      }
    };
    return (
      <div ref={rootRef} className="b-tab" data-testid="bot-settings">
        <h3 className="b-tabgroup">Model</h3>
        <dl className="facts">
          <div>
            <button
              type="button"
              className="b-open"
              data-bs="account"
              aria-label={`Account: ${label ? `${label}, ` : ""}${wordText}. Open.`}
              onClick={() => go("account")}
            >
              <span>Account</span>
              <span className="b-open-value">
                {label && (
                  <span className="b-ellipsis" title={label}>
                    {label}
                  </span>
                )}
                <span
                  className="b-state"
                  data-tone={word === "stale" || word === "no-account" ? "warn" : undefined}
                  data-testid="account-word"
                >
                  {word === "locked" && <LockIcon />}
                  {(word === "stale" || word === "no-account") && <WarnIcon />}
                  {wordText}
                </span>
              </span>
              <ChevronIcon />
            </button>
          </div>
        </dl>
        {provider && model && binding.mode !== "default-model" && (
          <>
            <div style={{ marginTop: 8 }}>
              <ModelPair
                accounts={accounts}
                provider={provider}
                anyAccount={binding.mode !== "account"}
                update={connection.openclawUpdate}
                model={model}
                list={mainModels}
                effort={effortFor(rowFor(accounts, provider, model, mainModels), binding.effort)}
                disabled={!admin}
                onModel={(next, row) => {
                  const levels = row?.levels ?? [];
                  const was = binding.effort;
                  const effort = effortFor(row, was);
                  if (was && levels.length > 0 && !levels.includes(was) && effort) {
                    setEffortNote(
                      `Effort is now ${levelWord(effort)}: ${next} doesn't offer ${levelWord(was)}.`,
                    );
                    setTimeout(() => setEffortNote(null), 4000);
                  }
                  void saveModel(next, effort);
                }}
                onEffort={(effort) => void saveModel(model, effort)}
              />
            </div>
            <p className="b-hint" id="b-model-line">
              {error ??
                effortNote ??
                `${who}'s models, as the gateway lists them. Which ones ${binding.mode === "account" ? "this account" : "an account"} may use is ${who}'s decision.`}
            </p>
          </>
        )}
        {binding.mode === "default-model" && (
          <>
            <p className="b-hint">
              The gateway's default model. Choose an account to pick another.
            </p>
            {/* With no Model menu, the update line stands here (#590). */}
            <UpdateOpenClawNote />
          </>
        )}
        <MemoryRow onOpen={() => go("memory")} />
        <StartTasksRow name={name} botId={bot.id} transcripts={transcripts} />
        {extraGroups}
        {runsOnRow}
        <ManageGroup bot={bot} onDelete={onDeleteBot} />
        {foot}
      </div>
    );
  }

  // --- Connecting an account, for this bot (bots.md section 5) ---------------------------------
  if (view === "connect") {
    return (
      <div ref={rootRef} className="b-tab" data-testid="bot-settings">
        <Connect
          from="settings"
          draftName={null}
          forBot={bot.id}
          accounts={accounts}
          bots={bots}
          connection={connection}
          info={info}
          announce={announce}
          onDone={(added) => {
            // Back to the choice, with the new account chosen; Save takes it once it is listed.
            setPick(added);
            setPickModel(null);
            setPickEffort(null);
            setView("change");
            focusIn("[data-bs-focus]");
          }}
          onLeave={() => go("change", "[data-bs='connect']")}
        >
          {(page) => (
            <>
              <div className="b-subhead">
                <button
                  type="button"
                  className="icon-button"
                  data-variant="quiet"
                  aria-label={page.backLabel}
                  onClick={page.onBack}
                >
                  <BackIcon />
                </button>
                <h3 tabIndex={-1} data-bs-focus="">
                  {page.title}
                </h3>
              </div>
              {page.body}
              {page.foot && <div className="b-actions b-connect-foot">{page.foot}</div>}
            </>
          )}
        </Connect>
      </div>
    );
  }

  // --- Change account ----------------------------------------------------------------------
  if (view === "change") {
    const list = accounts.accounts.filter((a) => a.keptBy === null || a.keptBy === bot.id);
    const current = binding.mode === "gateway" ? GATEWAY_CHOICE : binding.account;
    const chosen = pick ?? current;
    const toGateway = chosen === GATEWAY_CHOICE;
    const target = toGateway ? null : (accounts.accounts.find((a) => a.id === chosen) ?? null);
    const targetProvider = toGateway
      ? (binding.provider ?? defaultRef(accounts)?.provider ?? null)
      : (target?.provider ?? null);
    const changed = chosen !== current && chosen !== null;
    // Another account of the same provider keeps the model, one chosen through "View more"
    // included. Another provider's never keeps or infers one: the person chooses one of its models.
    const sameProvider = targetProvider !== null && targetProvider === binding.provider;
    const needModel = changed && !toGateway && targetProvider !== null && !sameProvider;
    const model = needModel
      ? pickModel
      : (binding.model ?? (targetProvider ? firstModel(accounts, targetProvider) : null));
    const effort =
      targetProvider && model
        ? effortFor(
            rowFor(accounts, targetProvider, model, changeModels),
            pickEffort ?? binding.effort,
          )
        : null;
    const running = tasks.some((task) =>
      transcripts[task.key]?.runs.some((run) => run.state === "running" || run.state === "waiting"),
    );
    // Only a choice in the list as it stands now: an account the last read lost cannot be saved.
    const listedNow =
      toGateway || (accounts.status === "ready" && list.some((each) => each.id === chosen));
    const ready = changed && listedNow && targetProvider !== null && model !== null;
    const save = async () => {
      if (!ready || !targetProvider || !model) return;
      setSaving(true);
      setError(null);
      try {
        await bridge.invoke({
          type: "changeBotAccount",
          botId: bot.id,
          account: toGateway ? null : chosen,
          provider: targetProvider,
          model,
          effort,
          stamp: await screenStamp(bridge, choicesRead),
        });
        announce(
          toGateway
            ? `${name} now has no fixed account`
            : `${name} now runs on ${target ? accountName(target, accounts) : chosen}`,
        );
        setPick(null);
        setPickModel(null);
        setPickEffort(null);
        go("account");
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        setSaving(false);
      }
    };
    const was = account;
    return (
      <div ref={rootRef} className="b-tab" data-testid="bot-settings">
        {sub("Change account", "account", "[data-bs='change']")}
        <p className="b-lead" style={{ textAlign: "left" }}>
          Choose the account {name} runs on.
        </p>
        <AccountChoices
          label={`Accounts for ${name}`}
          list={list}
          accounts={accounts}
          bots={bots}
          chosen={chosen}
          onChoose={(value) => {
            setPick(value);
            setPickModel(null);
            setPickEffort(null);
          }}
          disabled={!admin}
          gatewayLine={gatewayLine(accounts, binding.provider, binding.model, { bot: name })}
          now={now}
          keptToo
        />
        {admin && (
          <ul className="b-choices" style={{ marginTop: 12 }}>
            <li>
              <button
                type="button"
                className="b-choice"
                data-kind="add"
                data-bs="connect"
                onClick={() => go("connect")}
              >
                <PlusIcon />
                <span className="b-choice-text">
                  <span className="b-choice-title">Connect an account</span>
                  <span className="b-choice-sub">
                    {accounts.mainShared
                      ? "A sign-in here is shared with every bot."
                      : `A sign-in here is kept for ${name}.`}
                  </span>
                </span>
              </button>
            </li>
          </ul>
        )}
        {needModel && targetProvider && (
          <>
            <h4 className="b-group">Model</h4>
            <ModelPair
              accounts={accounts}
              provider={targetProvider}
              update={connection.openclawUpdate}
              model={pickModel}
              list={changeModels}
              effort={effort}
              disabled={!admin}
              placeholder="Choose"
              onModel={(next, row) => {
                setPickModel(next);
                setPickEffort(effortFor(row, binding.effort));
              }}
              onEffort={setPickEffort}
            />
            <p className="b-hint">
              Choose one of {providerName(targetProvider)}'s models for {name}.
            </p>
          </>
        )}
        {changed && running && (
          <Note icon={<ClockIcon />}>
            <p>
              {toGateway
                ? `A run in progress finishes on ${was ? accountName(was, accounts) : "its account"}. From the next run ${name} has no fixed account.`
                : `A run in progress finishes on ${was ? accountName(was, accounts) : "its account"}. The next run uses ${target ? accountName(target, accounts) : chosen}.`}
            </p>
          </Note>
        )}
        {changed && lock && was && (toGateway || target?.provider === was.provider) && (
          <Note tone="warn" testId="locked-change-note">
            <p>
              {lock.asOf === null
                ? `${name} is locked to ${accountName(was, accounts)}.`
                : `${name} was locked to ${accountName(was, accounts)} when Clawtrate last checked, at ${clock(lock.asOf)}.`}{" "}
              {toGateway
                ? `${lock.asOf === null ? "The gateway keeps" : "If it still does, the gateway keeps"} an order for ${name} that names only ${accountName(was, accounts)}, and goes on using that account alone ${admin ? "until the order is cleared. Account then has Clear order." : "until its owner clears the order on the gateway's machine. Account shows the command."}`
                : `${lock.asOf === null ? "After saving" : "If it still is, after saving"}, ${name} runs on ${accountName(target!, accounts)} first, and the gateway still tries ${accountName(was, accounts)} when ${accountName(target!, accounts)} fails, until you lock to ${accountName(target!, accounts)} or unlock. ${admin ? "Account then shows the lock command, and Unlock." : "Account then shows both commands."}`}
            </p>
          </Note>
        )}
        {error && (
          <p className="b-field-error" role="alert">
            {error}
          </p>
        )}
        <div className="b-actions" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="button"
            data-variant="primary"
            data-size="sm"
            disabled={!ready || saving || !admin}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="button"
            data-variant="quiet"
            data-size="sm"
            onClick={() => go("account", "[data-bs='change']")}
          >
            Cancel
          </button>
        </div>
        {foot}
      </div>
    );
  }

  // --- The Account page --------------------------------------------------------------------
  const page: ReactNode[] = [];
  // Where the page shown was read; a refusal is said under the page.
  const shownOn = accounts.readOn ?? shownStamp(connection);
  const removeFallbacks = async () => {
    setError(null);
    try {
      await bridge.invoke({
        type: "removeBotFallbacks",
        botId: bot.id,
        stamp: await screenStamp(bridge, shownOn),
      });
      return true;
    } catch (failure) {
      setError(
        `Couldn't remove the fallbacks: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
      return false;
    }
  };
  // Unlock and Clear (#660): the one account the bot's own stored order names, which they clear.
  const held =
    binding.order?.stored && binding.order.ids.length === 1 ? binding.order.ids[0]! : null;
  const nameOfAccount = (id: string) => {
    const listed = accounts.accounts.find((a) => a.id === id);
    return listed ? accountName(listed, accounts) : id;
  };
  const clear =
    accounts.clear?.botId === bot.id && accounts.clear.at >= pageSince ? accounts.clear : null;
  const clearing = clear?.status === "sending";
  const openClear = (kind: ClearAsk["kind"]) => {
    if (!held || !binding.provider) return;
    askedOn.current = shownOn;
    setError(null);
    setAsk({ kind, provider: binding.provider, account: held });
  };
  const pressClear = async (asked: ClearAsk) => {
    setAsking(true);
    try {
      await bridge.invoke({
        type: "clearBotOrder",
        botId: bot.id,
        provider: asked.provider,
        account: asked.account,
        kind: asked.kind,
        stamp: await screenStamp(bridge, askedOn.current ?? shownOn),
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setAsking(false);
      setAsk(null);
      // The button that opened it may be gone with the order: the line that says how it went.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!rootRef.current?.contains(document.activeElement))
            focusIn("[data-bs='clear-outcome'], [data-bs-focus]");
        }),
      );
    }
  };
  const clearButton = (kind: ClearAsk["kind"]) => (
    <button
      type="button"
      className="button"
      data-size="sm"
      data-bs={kind === "unlock" ? "unlock" : "clear-order"}
      disabled={!connected || clearing}
      onClick={() => openClear(kind)}
    >
      {kind === "unlock" ? "Unlock…" : "Clear order…"}
    </button>
  );
  // Below admin, the commands stay: this is what admin access would add (bots.md section 2).
  const adminWould = (what: string) => (
    <p className="b-hint" data-testid="clear-needs-admin">
      With admin access, Clawtrate {what} from here, with the gateway running.
    </p>
  );
  const changeButton = (label: string, primary: boolean) =>
    admin && (
      <div className="b-actions" style={{ marginTop: 14 }} key="change">
        <button
          type="button"
          className="button"
          data-variant={primary ? "primary" : undefined}
          data-size="sm"
          data-bs="change"
          onClick={() => go("change")}
        >
          {label}
        </button>
      </div>
    );

  if (binding.mode === "default-model") {
    page.push(
      <Note key="s" icon={<ShieldIcon />}>
        <p>
          <b>The gateway's default model.</b> {name} has no model of its own. It uses the gateway's
          default model and that model's fallbacks, and for each run the gateway picks one of that
          provider's accounts that its account order allows.
        </p>
      </Note>,
      changeButton("Choose an account", true),
    );
  } else if (binding.mode === "gateway") {
    const kept = retainedOrder(binding);
    const keptAccount = kept ? accounts.accounts.find((a) => a.id === kept) : null;
    page.push(
      <Note key="s" icon={<ShieldIcon />} testId="gateway-note">
        <p>
          <b>The gateway chooses.</b> {name} has no fixed account: for each run the gateway picks
          one of {who}'s accounts that its account order allows. {name} keeps its own model and no
          fallbacks.
        </p>
      </Note>,
    );
    if (binding.suffixLost)
      page.push(
        <Note key="lost" tone="warn">
          <p>
            The gateway's model for {name} has no account. It now uses the gateway's choice of {who}{" "}
            account.
          </p>
        </Note>,
      );
    if (kept && provider && admin)
      page.push(
        <Note key="kept" tone="warn" testId="retained-order">
          <p>
            The gateway still has an order for {name} that names only{" "}
            {keptAccount ? accountName(keptAccount, accounts) : kept}, so it keeps using that
            account alone. Clear it to let the gateway choose among {who}'s accounts.
          </p>
          <div className="b-actions">{clearButton("clear")}</div>
        </Note>,
      );
    else if (kept && provider)
      page.push(
        <Note key="kept" tone="warn" testId="retained-order">
          <p>
            The gateway still has an order for {name} that names only{" "}
            {keptAccount ? accountName(keptAccount, accounts) : kept}, so it keeps using that
            account alone. To let the gateway choose among {who}'s accounts, the gateway's owner can
            clear it on the gateway's machine{stopped ? `. ${STOPPED_WHY}` : ":"}
          </p>
          {stopped ? (
            <StoppedSteps
              cli={cli}
              command={unlockCommand(cli, bot.id, provider)}
              label="Copy clear command"
            />
          ) : (
            <CommandBlock
              command={unlockCommand(cli, bot.id, provider)}
              label="Copy clear command"
            />
          )}
          {adminWould("clears it")}
        </Note>,
      );
    page.push(changeButton(binding.suffixLost ? "Choose an account" : "Bind to an account", true));
  } else if (word === "no-account") {
    // An account still on the gateway, but in another bot's own store, is that bot's.
    const kept = accounts.accounts.find((each) => each.id === binding.account);
    const keeper =
      kept?.keptBy && kept.keptBy !== bot.id
        ? (bots.find((each) => each.id === kept.keptBy)?.name ?? kept.keptBy)
        : null;
    page.push(
      <Note key="s" tone="warn">
        <p>
          <b>No account.</b>{" "}
          {keeper
            ? `${name}'s account, ${accountName(kept!, accounts)}, is kept by ${keeper} only, so ${name} can't use it.`
            : `${name}'s account was disconnected.`}{" "}
          Clawtrate won't start {name} until you choose one.
        </p>
      </Note>,
      changeButton("Choose an account", true),
    );
  } else if (account) {
    const { tone, word: state } = stateWord(account, now);
    page.push(
      <dl className="facts" key="facts">
        <div>
          <dt>Account</dt>
          <dd className="b-wrap-value">{accountName(account, accounts)}</dd>
        </div>
        <div>
          <dt>Kind</dt>
          <dd>{kindWord(account)}</dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>
            <span className="b-state" data-tone={tone ?? "ok"}>
              {tone ? <WarnIcon /> : <CheckIcon />}
              {state}
            </span>
          </dd>
        </div>
      </dl>,
    );
    const others = accounts.accounts.filter(
      (a) =>
        a.provider === account.provider &&
        a.id !== account.id &&
        (a.keptBy === null || a.keptBy === bot.id),
    );
    const me = accountName(account, accounts);
    const e = binding.evidence;
    const checkNow = (
      <button
        type="button"
        className="button"
        data-size="sm"
        data-bs="lock-check"
        disabled={!connected}
        onClick={() => {
          announce("Checking the lock");
          void bridge.send({ type: "checkLock", botId: bot.id }).then(
            () => announce("Lock checked"),
            () => {},
          );
        }}
      >
        Check now
      </button>
    );
    let line: ReactNode;
    // A read that failed, or a gateway that says status is unavailable: its note says so, alone.
    if (e.status === "failed" || e.status === "unavailable") line = null;
    else if (evidenceOld)
      line = (
        <p className="b-hint" role="status" style={{ margin: 0 }} data-testid="evidence">
          {offline
            ? `Last checked at ${clock(e.checkedAt!)}. Clawtrate checks again when it reconnects.`
            : beforeConnection
              ? `Last checked at ${clock(e.checkedAt!)}, before the connection was made again. Checking again…`
              : `Last checked at ${clock(e.checkedAt!)}. Check now to read the gateway's order again.`}
        </p>
      );
    else if (e.status === "unread" || (e.status === "reading" && e.checkedAt === null))
      line = <Wait>Checking the gateway's order for {name}…</Wait>;
    else if (e.status === "matched" || (word === "stale" && e.checkedAt))
      line = (
        <p className="b-hint" role="status" style={{ margin: 0 }} data-testid="evidence">
          Checked with the gateway at {clock(e.checkedAt!)}.
        </p>
      );
    else if (e.status === "multi")
      line = (
        <p className="b-hint" role="status" style={{ margin: 0 }} data-testid="evidence">
          The gateway's order for {name} lists {me} and {binding.order!.ids.length - 1} more account
          {binding.order!.ids.length - 1 === 1 ? "" : "s"}, so it is not a lock.
        </p>
      );
    else if (e.status === "configured")
      line = (
        <p className="b-hint" role="status" style={{ margin: 0 }} data-testid="evidence">
          The gateway's settings order {who}'s accounts as{" "}
          {(binding.order?.ids ?? [])
            .map((id) => {
              const listed = accounts.accounts.find((a) => a.id === id);
              return listed ? accountName(listed, accounts) : id;
            })
            .join(", ")}
          . That order is the gateway's, not {name}'s own, so it is not a lock. Checked at{" "}
          {e.checkedAt ? clock(e.checkedAt) : "—"}.
        </p>
      );
    else if (watching)
      line = <Wait>Checking the gateway for the lock, again in {WATCH_MS / 1000}s</Wait>;
    else
      line = (
        <p className="b-hint" role="status" style={{ margin: 0 }} data-testid="evidence">
          Not locked. Checked at {e.checkedAt ? clock(e.checkedAt) : "—"}.
        </p>
      );
    const evidenceRow = (
      <div className="b-actions b-lockwait" key="evidence">
        {line}
        {checkNow}
      </div>
    );
    const warnings: ReactNode[] = [];
    if (
      e.lostAt !== null &&
      e.status !== "matched" &&
      e.status !== "failed" &&
      e.status !== "unavailable"
    )
      warnings.push(
        <Note key="gone" tone="warn">
          <p>
            The lock is gone: the gateway's order for {name} changed at or before {clock(e.lostAt)}.
          </p>
        </Note>,
      );
    if (e.status === "unavailable")
      warnings.push(
        <Note key="unavailable" tone="warn" testId="evidence-unavailable">
          <p>
            The gateway says its account status is unavailable ({e.error}), so Clawtrate can't read{" "}
            {name}'s order now.{" "}
            {e.lastMatchAt !== null && e.lostAt === null
              ? `Last confirmed locked at ${clock(e.lastMatchAt)}.`
              : "Never confirmed."}
          </p>
          <div className="b-actions">
            <button
              type="button"
              className="button"
              data-size="sm"
              onClick={() => void bridge.send({ type: "checkLock", botId: bot.id })}
            >
              Try again
            </button>
          </div>
        </Note>,
      );
    if (e.status === "failed")
      warnings.push(
        <Note key="failed" tone="warn" testId="evidence-failed">
          <p>
            Couldn't read the gateway's order for {name}.{" "}
            {e.lastMatchAt !== null && e.lostAt === null
              ? `Last confirmed locked at ${clock(e.lastMatchAt)}.`
              : "Never confirmed."}
          </p>
          <div className="b-actions">
            <button
              type="button"
              className="button"
              data-size="sm"
              onClick={() => void bridge.send({ type: "checkLock", botId: bot.id })}
            >
              Try again
            </button>
          </div>
        </Note>,
      );
    if (binding.order?.configured)
      warnings.push(
        <p className="b-hint" key="configured">
          The gateway's settings also set an order for {who} accounts. {name}'s own order, when it
          has one, comes first.
        </p>,
      );
    const unlock =
      admin && held ? (
        <div className="b-actions" style={{ marginTop: 14 }} key="unlock">
          {clearButton("unlock")}
        </div>
      ) : (
        <details className="b-disclosure" key="unlock">
          <summary>
            <ChevronIcon />
            Unlock
          </summary>
          <div className="b-disclosure-body">
            {stopped ? (
              <>
                <p className="b-hint" style={{ marginTop: 4 }}>
                  {STOPPED_WHY} On the gateway's machine:
                </p>
                <StoppedSteps
                  cli={cli}
                  command={unlockCommand(cli, bot.id, account.provider)}
                  label="Copy unlock command"
                />
                <p className="b-hint">
                  Clawtrate sees the change when the gateway is back. {name} then follows the
                  gateway's other orders.
                </p>
              </>
            ) : (
              <>
                <p className="b-hint" style={{ marginTop: 4 }}>
                  Run this on the gateway's machine. Clawtrate sees the change by itself. {name}{" "}
                  then follows the gateway's other orders.
                </p>
                <CommandBlock
                  command={unlockCommand(cli, bot.id, account.provider)}
                  label="Copy unlock command"
                />
              </>
            )}
            {!admin && adminWould(`unlocks ${name}`)}
          </div>
        </details>
      );
    if (word === "locked") {
      page.push(
        <Note key="s" icon={<LockIcon />} testId="locked-note">
          <p>
            <b>{lockText(lock!)}.</b> {name}'s ordinary runs use {me} only: if it fails, the run
            fails and says why, and the gateway doesn't try another account. A run started with
            another account named still goes round it.
          </p>
        </Note>,
        ...warnings,
        evidenceRow,
        unlock,
      );
    } else if (word === "stale") {
      const old = binding.order?.ids[0] ?? null;
      const oldAccount = old ? accounts.accounts.find((a) => a.id === old) : null;
      const oldName = oldAccount ? accountName(oldAccount, accounts) : (old ?? "");
      page.push(
        <Note key="s" tone="warn" testId="stale-note">
          <p>
            <b>The lock is out of date.</b> {name} runs on {me} first, but the gateway's order for{" "}
            {name} still lists only {oldName}, so when {me} fails the gateway tries {oldName}.
          </p>
        </Note>,
        <h4 className="b-group" key="h">
          Lock to {me}
        </h4>,
        ...(stopped
          ? [
              <p className="b-step" key="p">
                {STOPPED_WHY} On the gateway's machine:
              </p>,
              <StoppedSteps
                key="c"
                cli={cli}
                command={lockCommand(cli, binding, account.id)}
                label="Copy lock command"
                onCopied={() => setWatching(true)}
              />,
              <p className="b-hint" key="back">
                Clawtrate reads the lock from the gateway when it is back.
              </p>,
            ]
          : [
              <p className="b-step" key="p">
                Run this on the gateway's machine:
              </p>,
              <CommandBlock
                key="c"
                command={lockCommand(cli, binding, account.id)}
                label="Copy lock command"
                onCopied={() => setWatching(true)}
              />,
            ]),
        evidenceRow,
        unlock,
      );
    } else {
      page.push(
        <Note key="s" icon={<ShieldIcon />} testId="bound-note">
          <p>
            <b>Bound.</b> {name} runs on {me}. If that account fails, the gateway may use{" "}
            {others.length > 0
              ? `another ${who} account, such as ${accountName(others[0]!, accounts)},`
              : `another ${who} account, if one is added,`}{" "}
            for that run.
          </p>
        </Note>,
        ...warnings,
        <h4 className="b-group" key="h">
          Lock to this account
        </h4>,
        ...(stopped
          ? [
              <p className="b-step" key="p">
                To keep this bot on this account alone, change its order on the gateway's machine. A
                sign-in can also leave a bot limited to one account; Clawtrate shows the limit it
                finds, however it was made. {STOPPED_WHY} On the gateway's machine:
              </p>,
              <StoppedSteps
                key="c"
                cli={cli}
                command={lockCommand(cli, binding, account.id)}
                label="Copy lock command"
                onCopied={() => setWatching(true)}
              />,
              <p className="b-hint" key="back">
                Clawtrate reads the lock from the gateway when it is back.
              </p>,
            ]
          : [
              <p className="b-step" key="p">
                To keep this bot on this account alone, run this on the gateway's machine. A sign-in
                can also leave a bot limited to one account; Clawtrate shows the limit it finds,
                however it was made:
              </p>,
              <CommandBlock
                key="c"
                command={lockCommand(cli, binding, account.id)}
                label="Copy lock command"
                onCopied={() => setWatching(true)}
              />,
            ]),
        evidenceRow,
        <p className="b-hint" key="cannot">
          What this cannot see: if {me} is pausing after a failure, a run can start on another {who}{" "}
          account without leaving a record Clawtrate can read.
        </p>,
      );
    }
    page.push(
      <details className="b-disclosure" key="ways">
        <summary>
          <ChevronIcon />
          What a lock doesn't cover
        </summary>
        <div className="b-disclosure-body">
          <ul className="b-list">
            <li>
              A task or conversation set to another account, by another app or with the model
              command in chat. Clawtrate never does this.
            </li>
            <li>A routine, or a helper bot, whose model names another account.</li>
            <li>
              A message from another bot into a conversation that already uses another account.
            </li>
            <li>
              A run that uses another model than {name}'s own, set in a task or a routine: it
              doesn't carry {name}'s account, so the gateway's own provider settings or order choose
              one.
            </li>
            <li>
              A new {who} sign-in on the gateway can add itself to the order. Clawtrate checks after
              every sign-in it starts.
            </li>
            <li>
              Removing {me}: the gateway then repairs the order to {who}'s other accounts.
            </li>
            <li>Commands run on the gateway's machine itself.</li>
            <li>
              A lock is about accounts. An empty fallback list keeps {name} off other models in the
              gateway's fallback list, but some providers can still switch the model inside a
              request.
            </li>
          </ul>
        </div>
      </details>,
    );
    if (binding.fallbacksUnwritten)
      page.push(
        <Note key="unwritten">
          <p>
            Clawtrate couldn't write {name}'s empty fallback list. {name} has no fallback models
            set, so the gateway's fallback list doesn't apply to it; the empty list only makes that
            explicit. A provider can still switch the model inside a request.
          </p>
          {admin && (
            <div className="b-actions">
              <button type="button" className="button" data-size="sm" onClick={removeFallbacks}>
                Try again
              </button>
            </div>
          )}
        </Note>,
      );
    if (binding.fallbacks && binding.fallbacks.length > 0)
      page.push(
        <Note key="fallbacks" tone="warn" testId="fallbacks-note">
          <p>
            <b>{name} can move to another model.</b> Its model on the gateway lists fallbacks (
            {binding.fallbacks.join(", ")}), so the gateway can move a run to them when this one
            fails.
          </p>
          {admin && (
            <div className="b-actions">
              <button
                type="button"
                className="button"
                data-size="sm"
                onClick={() =>
                  removeFallbacks().then((done) => done && announce("Fallbacks removed"))
                }
              >
                Remove fallbacks
              </button>
            </div>
          )}
        </Note>,
      );
    page.push(changeButton("Change account", false));
  }

  return (
    <div ref={rootRef} className="b-tab" data-testid="bot-settings" data-word={word ?? undefined}>
      {sub("Account", "main", "[data-bs='account']")}
      {clear && (
        <ClearOutcome
          clear={clear}
          binding={binding}
          name={name}
          who={who}
          named={nameOfAccount(clear.account)}
        />
      )}
      {page}
      {ask && (
        <ClearOrderConfirm
          ask={ask}
          name={name}
          who={providerName(ask.provider)}
          named={nameOfAccount(ask.account)}
          bound={binding.mode === "account" && account ? accountName(account, accounts) : null}
          stopped={stopped}
          busy={asking}
          onAction={() => void pressClear(ask)}
          onCancel={() => setAsk(null)}
        />
      )}
      {error && (
        <p className="b-field-error" role="alert">
          {error}
        </p>
      )}
      {foot}
    </div>
  );
}
