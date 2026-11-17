// The rail's task actions on fixed state (RailActions.tsx): an interactive
// connection whose rail offers New task, rename, pin, unread, archive, restore,
// delete and sections, and answers them as the engine would, holding
// everything in memory. Scenes:
//
//   rail-write    interactive; the gateway keeps an arrangement for the user but
//                 holds none yet, so the rail shows this device's
//   rail-synced   interactive; the gateway's arrangement: pinned bots, two
//                 sections, and a pinned task under Otto
//   rail-waiting  interactive; tasks waiting for an approval and for an answer,
//                 one stopped and one queued
//   rail-read     the gateway's arrangement on a read-only connection

import {
  applySidebarChange,
  emptyActivity,
  INTERACTIVE_SCOPES,
  parseSidebar,
  type ArchivedTask,
  type BridgeCommand,
  type ClawtrateState,
  type SidebarPrefs,
  type Task,
} from "@clawtrate/core";

export const RAIL_SCENES = ["rail-write", "rail-synced", "rail-waiting", "rail-read"] as const;
export type RailScene = (typeof RAIL_SCENES)[number];

export function isRailScene(name: string | null): name is RailScene {
  return RAIL_SCENES.includes(name as RailScene);
}

const MINUTE = 60_000;

const interactive = (state: ClawtrateState): ClawtrateState => ({
  ...state,
  connection: {
    ...state.connection,
    scopes: [...INTERACTIVE_SCOPES],
    requestedScopes: [...INTERACTIVE_SCOPES],
    canWrite: true,
    canAnswer: true,
    canApprove: true,
  },
});

/** The arrangement the synced scenes' gateway keeps. Invented. */
export const SYNCED_PREFS: SidebarPrefs = {
  pins: ["otto", "pip"],
  sections: [
    { name: "Home", bots: ["marlow"] },
    { name: "Work", bots: ["quartermaster"] },
  ],
  hidden: [],
  order: [],
};

/** Tasks in order, as the engine lists them: pinned first, then newest. */
function sorted(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (a, b) =>
      Number(b.pinned === true) - Number(a.pinned === true) ||
      (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
      a.key.localeCompare(b.key),
  );
}

function changeTask(
  state: ClawtrateState,
  botId: string,
  key: string,
  change: (task: Task) => Task,
): ClawtrateState {
  const tasks = state.tasksByBot[botId] ?? [];
  return {
    ...state,
    tasksByBot: {
      ...state.tasksByBot,
      [botId]: sorted(tasks.map((task) => (task.key === key ? change(task) : task))),
    },
  };
}

export function railScene(name: RailScene, base: ClawtrateState, now: number): ClawtrateState {
  switch (name) {
    case "rail-write":
      return { ...interactive(base), sidebar: { status: "ok", prefs: null } };
    case "rail-synced":
      return changeTask(
        { ...interactive(base), sidebar: { status: "ok", prefs: SYNCED_PREFS } },
        "otto",
        "agent:otto:backup-check",
        (task) => ({ ...task, pinned: true }),
      );
    case "rail-read":
      return { ...base, sidebar: { status: "ok", prefs: SYNCED_PREFS } };
    case "rail-waiting": {
      let state: ClawtrateState = { ...interactive(base), sidebar: { status: "ok", prefs: null } };
      state = changeTask(state, "marlow", "agent:marlow:main", (task) => ({
        ...task,
        status: "waiting",
        waitingFor: "approval",
        waitingSince: now - 6 * MINUTE,
        updatedAt: now - 6 * MINUTE,
      }));
      state = changeTask(state, "pip", "agent:pip:birthday", (task) => ({
        ...task,
        status: "waiting",
        waitingFor: "question",
        waitingSince: now - 12 * MINUTE,
      }));
      state = changeTask(state, "pip", "agent:pip:reading-list", (task) => ({
        ...task,
        status: "stopped",
      }));
      state = changeTask(state, "quartermaster", "agent:quartermaster:errands", (task) => ({
        ...task,
        status: "queued",
      }));
      return state;
    }
  }
}

/** Archived tasks per bot, held for the fixture page's life. */
function initialArchive(now: number): Map<string, ArchivedTask[]> {
  return new Map([
    [
      "otto",
      [
        {
          key: "agent:otto:printer-driver",
          botId: "otto",
          sessionId: "otto-printer-driver",
          title: "Old printer driver",
          preview: "Removed the old driver and its queue.",
          archivedAt: now - 3 * 24 * 60 * MINUTE,
          updatedAt: now - 4 * 24 * 60 * MINUTE,
        },
        {
          key: "agent:otto:dns-cache",
          botId: "otto",
          sessionId: "otto-dns-cache",
          title: "Flush the DNS cache",
          preview: "Flushed it; lookups are fast again.",
          archivedAt: now - 9 * 24 * 60 * MINUTE,
          updatedAt: now - 10 * 24 * 60 * MINUTE,
        },
      ],
    ],
  ]);
}

/** An empty task's transcript, as the engine keeps one it has just created. */
function emptyTranscript(key: string, now: number) {
  return {
    ...emptyActivity,
    linkedRuns: {},
    interSession: [],
    mcpTools: {},
    sessionKey: key,
    status: "ready" as const,
    items: [],
    error: null,
    hasMore: false,
    live: null,
    loadedAt: now,
  };
}

const active = (task: Task) =>
  task.status === "running" || task.status === "waiting" || task.status === "queued";

/**
 * Answer the rail's commands. Returns undefined for any other command. A
 * rename to "Taken" is refused as the gateway refuses a label in use.
 */
export function railCommands(now: number) {
  const archive = initialArchive(now);
  let created = 0;
  return (
    command: BridgeCommand,
    get: () => ClawtrateState,
    set: (state: ClawtrateState) => void,
  ): Promise<unknown> | undefined => {
    const find = (key: string) => {
      for (const [botId, tasks] of Object.entries(get().tasksByBot)) {
        const task = tasks.find((each) => each.key === key);
        if (task) return { botId, task };
      }
      return null;
    };
    const create = (botId: string, title: string) => {
      created += 1;
      const key = `agent:${botId}:dashboard:${String(created).padStart(8, "0")}-0000-4000-8000-000000000000`;
      const state = get();
      const task: Task = {
        key,
        botId,
        sessionId: `new-${created}`,
        title,
        preview: null,
        updatedAt: Date.now(),
        status: "idle",
        unread: false,
      };
      set({
        ...state,
        tasksByBot: {
          ...state.tasksByBot,
          [botId]: sorted([task, ...(state.tasksByBot[botId] ?? [])]),
        },
        transcripts: { ...state.transcripts, [key]: emptyTranscript(key, Date.now()) },
      });
      return { key };
    };
    const later = <T>(value: () => T) =>
      new Promise<T>((resolve, reject) =>
        setTimeout(() => {
          try {
            resolve(value());
          } catch (error) {
            reject(error as Error);
          }
        }, 120),
      );
    switch (command.type) {
      case "newTask":
        return later(() => create(command.botId, command.label ?? "New task"));
      case "newMainTask":
        return later(() => create(command.botId, "Main"));
      case "renameTask":
        return later(() => {
          const found = find(command.key);
          if (!found) throw new Error(`The gateway has no task ${command.key}.`);
          const label = command.label.replace(/\s+/g, " ").trim();
          const taken = (get().tasksByBot[found.botId] ?? []).some(
            (each) => each.key !== command.key && each.title === label,
          );
          if (label === "Taken" || taken)
            throw new Error(`Another task of this bot is already called "${label}".`);
          set(changeTask(get(), found.botId, command.key, (task) => ({ ...task, title: label })));
        });
      case "pinTask":
        return later(() => {
          const found = find(command.key);
          if (found)
            set(
              changeTask(get(), found.botId, command.key, (task) => ({
                ...task,
                pinned: command.pinned,
              })),
            );
        });
      case "markTask":
        return later(() => {
          const found = find(command.key);
          if (!found || (command.opened && !found.task.unread)) return;
          set(
            changeTask(get(), found.botId, command.key, (task) => ({
              ...task,
              unread: command.unread,
              updatedAt: command.unread ? Date.now() : task.updatedAt,
            })),
          );
        });
      case "archiveTask":
        return later(() => {
          const found = find(command.key);
          if (!found) return;
          if (active(found.task) && !command.stop)
            throw new Error("This task is still working. Stop it first.");
          const state = get();
          archive.set(found.botId, [
            {
              key: found.task.key,
              botId: found.botId,
              sessionId: found.task.sessionId,
              title: found.task.title,
              preview: found.task.preview,
              archivedAt: Date.now(),
              updatedAt: found.task.updatedAt,
            },
            ...(archive.get(found.botId) ?? []),
          ]);
          set({
            ...state,
            tasksByBot: {
              ...state.tasksByBot,
              [found.botId]: (state.tasksByBot[found.botId] ?? []).filter(
                (each) => each.key !== command.key,
              ),
            },
          });
        });
      case "restoreTask":
        return later(() => {
          for (const [botId, tasks] of archive) {
            const restored = tasks.find((each) => each.key === command.key);
            if (!restored) continue;
            archive.set(
              botId,
              tasks.filter((each) => each !== restored),
            );
            const state = get();
            const task: Task = {
              key: restored.key,
              botId,
              sessionId: restored.sessionId,
              title: restored.title,
              preview: restored.preview,
              updatedAt: restored.updatedAt,
              status: "done",
              unread: false,
            };
            set({
              ...state,
              tasksByBot: {
                ...state.tasksByBot,
                [botId]: sorted([...(state.tasksByBot[botId] ?? []), task]),
              },
              transcripts: {
                ...state.transcripts,
                [task.key]: emptyTranscript(task.key, Date.now()),
              },
            });
          }
        });
      case "deleteTask":
        return later(() => {
          for (const [botId, tasks] of archive)
            archive.set(
              botId,
              tasks.filter((each) => each.key !== command.key),
            );
          const state = get();
          const found = find(command.key);
          if (!found) return;
          set({
            ...state,
            tasksByBot: {
              ...state.tasksByBot,
              [found.botId]: (state.tasksByBot[found.botId] ?? []).filter(
                (each) => each.key !== command.key,
              ),
            },
          });
        });
      case "listArchived":
        return later(() => ({ tasks: archive.get(command.botId) ?? [], more: false }));
      case "changeSidebar":
        return later(() => {
          const state = get();
          const from = state.sidebar?.prefs ?? parseSidebar(command.base ?? {});
          set({
            ...state,
            sidebar: { status: "ok", prefs: applySidebarChange(from, command.change) },
          });
        });
      default:
        return undefined;
    }
  };
}
