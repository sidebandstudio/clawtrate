import {
  browserUse,
  gatewayStamp,
  type AccountsState,
  type Bot,
  type ComputerState,
  type ConnectionState,
  type HostInfo,
  type Task,
  type Transcript,
} from "@clawtrate/core";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Avatar } from "./Avatar.tsx";
import { EditPicture } from "./bots/EditPicture.tsx";
import { useBridge } from "./bridge.tsx";
import { stampTime } from "./format.ts";
import { CloseIcon } from "./icons.tsx";
import { BotSettingsWithUsage } from "./usage/BotUsage.tsx";
import { ComputerTab } from "./work/ComputerTab.tsx";
import { FilesTab } from "./work/FilesTab.tsx";
import type { FileRequest } from "./work/links.tsx";
import { TabBar } from "./work/TabBar.tsx";
import "./work/files.css";

/** One opening of Edit picture, and what it is bound to. */
type PictureSession = {
  token: number;
  botId: string;
  gateway: string | null;
  connectedAt: number | null;
};

/** The pane's tabs, in the order the designs give (work-pane.md §1, bots.md §8). */
export const WORK_TABS = [
  { id: "details", label: "Details" },
  { id: "files", label: "Files" },
  { id: "computer", label: "Computer" },
  { id: "settings", label: "Settings" },
] as const;

export type WorkTab = (typeof WORK_TABS)[number]["id"];

export function isWorkTab(value: string | null): value is WorkTab {
  return WORK_TABS.some((tab) => tab.id === value);
}

/**
 * The bot's work beside the conversation: who, then four tabs. A drawer and
 * modal below the docking width, an ordinary part of the page above it.
 */
export function WorkPanel({
  bot,
  task,
  transcript,
  drawer,
  onClose,
  closeRef,
  panelRef,
  tab,
  onTab,
  online,
  connectedAt,
  fileRequest,
  onShowInChat,
  onFilePath,
  computer,
  connection,
  interactive,
  onShowStep,
  onShowQuestion,
  onRequestAccess,
  onOpenMachines,
  accounts,
  bots,
  tasks,
  transcripts,
  info,
}: {
  bot: Bot | undefined;
  task: Task | null;
  transcript: Transcript | undefined;
  /** True while it is a drawer: a modal dialog over the rest. */
  drawer: boolean;
  onClose: () => void;
  closeRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  /** The chosen tab belongs to the pane: the shell keeps it across tasks and bots. */
  tab: WorkTab;
  onTab: (tab: WorkTab) => void;
  online: boolean;
  connectedAt: number | null;
  fileRequest: FileRequest | null;
  onShowInChat: (stepId: string, from: { path: string }) => void;
  onFilePath: (path: string | null) => void;
  computer: ComputerState | undefined;
  connection: ConnectionState;
  interactive: boolean;
  onShowStep: (stepId: string) => void;
  onShowQuestion: (questionId?: string) => void;
  onRequestAccess: (() => void) | null;
  /** Settings, on Machines: where a node's settings are. */
  onOpenMachines?: (() => void) | undefined;
  accounts: AccountsState;
  bots: readonly Bot[];
  /** The bot's tasks, for a run in progress when its account changes. */
  tasks: readonly Task[];
  transcripts: Record<string, Transcript>;
  info: HostInfo;
}) {
  const bridge = useBridge();
  // Row times are relative to when the pane opened.
  const [now] = useState(() => Date.now());
  const name = bot?.name ?? "This bot";
  // The pane's announcements, polite, as the conversation's live region speaks.
  const [announcement, setAnnouncement] = useState("");
  // Each opening of Edit picture is a session with its own token, bound to the bot, the gateway
  // and the connection it was opened on. It ends when any of them, or admin access, changes.
  const [pictureSession, setPictureSession] = useState<PictureSession | null>(null);
  const tokens = useRef(0);
  const current = useRef<number | null>(null);
  const canEditPicture = connection.canAdmin && online;
  const gatewayKey = connection.gatewayUrl;
  const editing =
    pictureSession !== null &&
    canEditPicture &&
    pictureSession.botId === bot?.id &&
    pictureSession.gateway === gatewayKey &&
    pictureSession.connectedAt === connectedAt;
  // Settled while rendering, so an ended session is gone before anything can reopen it.
  if (pictureSession !== null && !editing) setPictureSession(null);
  const liveToken = editing ? pictureSession.token : null;
  useEffect(() => {
    current.current = liveToken;
  }, [liveToken]);
  const announce = useCallback((text: string) => {
    setAnnouncement("");
    requestAnimationFrame(() => setAnnouncement(text));
  }, []);
  // The Computer tab's mark: a browser call is running in the task (F-139).
  const active = browserUse(transcript).active;

  return (
    <aside
      className="work-panel"
      aria-label="Work"
      data-testid="work-panel"
      ref={panelRef}
      role={drawer ? "dialog" : undefined}
      aria-modal={drawer ? true : undefined}
    >
      <button
        type="button"
        className="icon-button work-close"
        ref={closeRef}
        onClick={onClose}
        aria-label="Close work panel"
        title="Close (Esc)"
      >
        <CloseIcon />
      </button>
      {bot && (
        <div className="work-hero">
          {canEditPicture ? (
            <button
              type="button"
              className="work-picture"
              aria-label={`Change ${bot.name}'s picture`}
              title="Change picture"
              onClick={() =>
                setPictureSession({
                  token: ++tokens.current,
                  botId: bot.id,
                  gateway: gatewayKey,
                  connectedAt,
                })
              }
            >
              <Avatar bot={bot} />
            </button>
          ) : (
            <Avatar bot={bot} />
          )}
          {editing && (
            <EditPicture
              key={pictureSession.token}
              bot={bot}
              stamp={gatewayStamp(connection)}
              canSave={canEditPicture}
              onClose={() => {
                const token = pictureSession.token;
                setPictureSession((open) => (open?.token === token ? null : open));
              }}
              onSaved={() => {
                if (current.current === pictureSession.token) announce("Picture saved");
              }}
            />
          )}
          <h2>{bot.name}</h2>
          {bot.theme && <p>{bot.theme}</p>}
        </div>
      )}
      <TabBar
        tabs={WORK_TABS.map((each) =>
          each.id === "computer" && active ? { ...each, mark: "Computer, in use" } : each,
        )}
        selected={tab}
        onSelect={onTab}
        idPrefix="work-tab"
        label="Work"
      />
      <div className="work-sections">
        <div
          role="tabpanel"
          id="work-tabpanel-details"
          aria-labelledby="work-tab-details"
          tabIndex={0}
          hidden={tab !== "details"}
        >
          {task ? (
            <>
              <p className="work-task">{task.title}</p>
              <dl className="facts">
                {bot?.model && (
                  <div>
                    <dt>Model</dt>
                    <dd>{bot.model}</dd>
                  </div>
                )}
                <div>
                  <dt>Last activity</dt>
                  <dd>{task.updatedAt === null ? "Unknown" : stampTime(task.updatedAt)}</dd>
                </div>
              </dl>
            </>
          ) : (
            <p className="work-note">
              No task is open. Pick one of {name}'s tasks to see its details.
            </p>
          )}
        </div>
        <div
          role="tabpanel"
          id="work-tabpanel-files"
          aria-labelledby="work-tab-files"
          tabIndex={-1}
          hidden={tab !== "files"}
        >
          {task && bot ? (
            <FilesTab
              key={task.key}
              bridge={bridge}
              botId={bot.id}
              bot={name}
              taskKey={task.key}
              transcript={transcript}
              visible={tab === "files"}
              online={online}
              connectedAt={connectedAt}
              request={fileRequest}
              drawer={drawer}
              now={now}
              announce={announce}
              onShowInChat={onShowInChat}
              onPathChange={onFilePath}
            />
          ) : (
            <p className="work-note">Pick one of {name}'s tasks to see its files.</p>
          )}
        </div>
        <div
          role="tabpanel"
          id="work-tabpanel-computer"
          aria-labelledby="work-tab-computer"
          tabIndex={0}
          hidden={tab !== "computer"}
        >
          {task && bot ? (
            <ComputerTab
              key={task.key}
              bridge={bridge}
              bot={bot}
              bots={bots}
              taskKey={task.key}
              transcript={transcript}
              computer={computer}
              connection={connection}
              interactive={interactive}
              visible={tab === "computer"}
              announce={announce}
              onShowInChat={onShowStep}
              onShowQuestion={onShowQuestion}
              onRequestAccess={onRequestAccess}
              onOpenMachines={onOpenMachines}
            />
          ) : (
            <p className="work-note">Pick one of {name}'s tasks to see its computer.</p>
          )}
        </div>
        <div
          role="tabpanel"
          id="work-tabpanel-settings"
          aria-labelledby="work-tab-settings"
          tabIndex={0}
          hidden={tab !== "settings"}
        >
          {bot ? (
            <BotSettingsWithUsage
              bot={bot}
              task={task}
              accounts={accounts}
              bots={bots}
              tasks={tasks}
              transcripts={transcripts}
              connection={connection}
              info={info}
              visible={tab === "settings"}
              announce={announce}
            />
          ) : (
            <p className="work-note">Pick a bot to see its settings.</p>
          )}
        </div>
      </div>
      <p className="visually-hidden" role="status" aria-live="polite" data-testid="work-announcer">
        {announcement}
      </p>
    </aside>
  );
}
