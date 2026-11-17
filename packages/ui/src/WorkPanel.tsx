import type { Bot, Task } from "@clawtrate/core";
import { useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Avatar } from "./Avatar.tsx";
import { stampTime } from "./format.ts";
import { CloseIcon, FileIcon, ScreenIcon } from "./icons.tsx";

const TABS = [
  { id: "details", label: "Details" },
  { id: "files", label: "Files" },
  { id: "computer", label: "Computer" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function EmptyTab({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="work-empty">
      <span className="empty-mark">{icon}</span>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

/**
 * The bot's work beside the conversation: who, then three tabs. A drawer and
 * modal below the docking width, an ordinary part of the page above it.
 */
export function WorkPanel({
  bot,
  task,
  drawer,
  onClose,
  closeRef,
  panelRef,
}: {
  bot: Bot | undefined;
  task: Task | null;
  /** True while it is a drawer: a modal dialog over the rest. */
  drawer: boolean;
  onClose: () => void;
  closeRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLElement | null>;
}) {
  const [tab, setTab] = useState<TabId>("details");

  // One tab stop; Left and Right move and select, wrapping; Home and End go to the ends.
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((t) => t.id === tab);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    const id = TABS[next]!.id;
    setTab(id);
    event.currentTarget.querySelector<HTMLElement>(`#work-tab-${id}`)?.focus();
  };

  const name = bot?.name ?? "This bot";

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
          <Avatar bot={bot} />
          <h2>{bot.name}</h2>
          {bot.theme && <p>{bot.theme}</p>}
        </div>
      )}
      <div className="tabs" role="tablist" aria-label="Work" onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="tab"
            role="tab"
            id={`work-tab-${t.id}`}
            aria-controls={`work-tabpanel-${t.id}`}
            aria-selected={tab === t.id}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
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
          tabIndex={0}
          hidden={tab !== "files"}
        >
          <EmptyTab
            icon={<FileIcon />}
            title="No files yet"
            body={`Files ${name} reads or writes in this task appear here.`}
          />
        </div>
        <div
          role="tabpanel"
          id="work-tabpanel-computer"
          aria-labelledby="work-tab-computer"
          tabIndex={0}
          hidden={tab !== "computer"}
        >
          <EmptyTab
            icon={<ScreenIcon />}
            title="No screen to show"
            body={`When ${name} uses a browser or a desktop, you can watch it here.`}
          />
        </div>
      </div>
    </aside>
  );
}
