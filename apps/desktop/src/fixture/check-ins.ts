// The bots' check-ins in the fixture: a gateway config and the heartbeat jobs
// the gateway derives from it by its enrollment rules (docs/decisions.md,
// "Check-ins"), read and planned by the same core functions a real save uses.
//
//   &checkins=off      Juniper has a setting of its own, Off (`every: "0m"`): its job is disabled
//   &checkins=daily    Marlow checks in daily with its own setting; Juniper with one at 30m
//   &checkins=every    Otto every 2 hours with its own setting, and a custom prompt
//   &checkins=routines a gateway that keeps check-ins as routines (OpenClaw 2026.11.10): nothing to read or set
//   &checkins=updated  the gateway is updated to one that keeps them as routines after the first read
//   &cidefault=prompt  the gateway's default carries a custom prompt without NO_REPLY
//   &scheduler=off     the gateway's scheduler is off, as on the development gateway
//   &cisave=fail       a save the gateway refuses; &cisave=unknown, one it may have applied;
//   &cisave=conflict   another client changes Juniper's cadence and prompt while a dialog is open

import {
  CHECKINS_AS_ROUTINES,
  durationMs,
  planCheckIn,
  gatewayStamp,
  readDefaults,
  readSettings,
  sameStamp,
  type BridgeCommand,
  type CheckInJob,
  type CheckInsState,
  type ClawtrateState,
  type GatewayStamp,
} from "@clawtrate/core";

export type CheckInParams = {
  checkins: "off" | "daily" | "every" | "routines" | "updated" | null;
  defaultPrompt: boolean;
  scheduler: boolean;
  save: "fail" | "unknown" | "conflict" | null;
};

export function checkInParams(params: URLSearchParams): CheckInParams {
  const checkins = params.get("checkins");
  const save = params.get("cisave");
  return {
    checkins:
      checkins === "off" ||
      checkins === "daily" ||
      checkins === "every" ||
      checkins === "routines" ||
      checkins === "updated"
        ? checkins
        : null,
    defaultPrompt: params.get("cidefault") === "prompt",
    scheduler: params.get("scheduler") !== "off",
    save: save === "fail" || save === "unknown" || save === "conflict" ? save : null,
  };
}

type Heartbeat = { every?: string; prompt?: string };
type Config = {
  agents: {
    defaults: { heartbeat: Heartbeat & { agentId?: string } };
    entries: Record<string, { heartbeat?: Heartbeat }>;
  };
};

const BOTS = ["main", "marlow", "otto", "pip", "quartermaster"];

function configFor(params: CheckInParams): Config {
  const own: Record<string, Heartbeat> =
    params.checkins === "off"
      ? { main: { every: "0m" } }
      : params.checkins === "daily"
        ? { main: { every: "30m" }, marlow: { every: "24h" } }
        : params.checkins === "every"
          ? {
              main: { every: "30m" },
              otto: {
                every: "2h",
                prompt: "Look at the disk space on the build machine. Tell me if it is low.",
              },
            }
          : {};
  return {
    agents: {
      defaults: {
        heartbeat: {
          agentId: "main",
          ...(params.defaultPrompt ? { prompt: "Look over my inbox and tell me what's new." } : {}),
        },
      },
      entries: Object.fromEntries(BOTS.map((id) => [id, own[id] ? { heartbeat: own[id] } : {}])),
    },
  };
}

/** The jobs the gateway keeps for this config. */
function jobsFor(config: Config, now: number): CheckInJob[] {
  const { defaults, entries } = config.agents;
  const own = BOTS.filter((id) => entries[id]?.heartbeat);
  const enrolled = own.length > 0 ? own : [defaults.heartbeat.agentId ?? "main"];
  return enrolled.map((botId) => {
    const ms = durationMs(entries[botId]?.heartbeat?.every ?? defaults.heartbeat.every ?? "30m")!;
    if (ms === 0) return { botId, enabled: false, everyMs: 30 * 60_000, nextRunAtMs: null };
    const interval = Math.min(ms, 30 * 60_000);
    return { botId, enabled: true, everyMs: ms, nextRunAtMs: now - (now % interval) + interval };
  });
}

function shown(
  routines: boolean,
  config: Config,
  now: number,
  readBotIds: string[] = BOTS,
): Pick<CheckInsState, "model" | "readBotIds" | "jobs" | "settings" | "defaults"> {
  if (routines) return { model: "routines", readBotIds, jobs: [], settings: null, defaults: null };
  const answer = { config };
  const jobs = jobsFor(config, now).filter((job) => readBotIds.includes(job.botId));
  return {
    model: "heartbeat",
    readBotIds,
    jobs,
    settings: readSettings(answer, readBotIds),
    defaults: readDefaults(answer),
  };
}

export function fixtureCheckIns(
  now: number,
  params: CheckInParams,
  stamp: GatewayStamp | null,
): CheckInsState {
  return {
    status: "ready",
    error: null,
    stamp,
    scheduler: params.checkins === "routines" ? null : params.scheduler,
    ...shown(params.checkins === "routines", configFor(params), now),
    save: null,
  };
}

/** The check-in commands, answered on the fixture's state; undefined for any other command. */
export function checkInCommands(params: CheckInParams) {
  const config = configFor(params);
  // With `updated`, the first read is answered before the update and every later one after it.
  let routines = params.checkins === "routines";
  return (
    command: BridgeCommand,
    get: () => ClawtrateState,
    set: (state: ClawtrateState) => void,
  ): Promise<unknown> | undefined => {
    const put = (change: (c: CheckInsState) => CheckInsState) => {
      const checkIns = get().checkIns;
      if (checkIns) set({ ...get(), checkIns: change(checkIns) });
    };
    switch (command.type) {
      case "refreshCheckIns": {
        const snapshot = shown(
          routines,
          config,
          Date.now(),
          get().bots.map((bot) => bot.id),
        );
        if (params.checkins === "updated") routines = true;
        const stamp = gatewayStamp(get().connection);
        set({
          ...get(),
          checkIns: {
            ...(get().checkIns ?? fixtureCheckIns(Date.now(), params, null)),
            ...snapshot,
            stamp,
          },
        });
        return Promise.resolve(
          command.botId && snapshot.settings
            ? {
                stamp,
                jobs: snapshot.jobs.filter((job) => job.botId === command.botId),
                settings: snapshot.settings.filter((setting) => setting.botId === command.botId),
                defaults: snapshot.defaults,
              }
            : null,
        );
      }
      case "dismissCheckInSave":
        put((c) =>
          c.save?.id === command.saveId && c.save.status !== "saving" ? { ...c, save: null } : c,
        );
        return Promise.resolve();
      case "saveCheckIn": {
        if (!get().connection.canAdmin)
          return Promise.reject(new Error("Changing check-ins needs admin access."));
        if (!sameStamp(command.stamp, gatewayStamp(get().connection)))
          return Promise.reject(
            new Error("This change was made for another gateway, so nothing was sent."),
          );
        const { saveId, botId } = command;
        const settle = (
          status: "saved" | "failed" | "unknown" | "conflict",
          error: string | null,
        ) =>
          put((c) => ({
            ...c,
            ...shown(
              routines,
              config,
              Date.now(),
              get().bots.map((bot) => bot.id),
            ),
            save: { id: saveId, botId, status, error },
          }));
        put((c) => ({ ...c, save: { id: saveId, botId, status: "saving", error: null } }));
        // Another client, between the dialog opening and this save.
        if (params.save === "conflict")
          config.agents.entries.main = {
            heartbeat: {
              every: "24h",
              prompt: "Theirs. If nothing needs attention, reply NO_REPLY.",
            },
          };
        setTimeout(() => {
          if (routines) return settle("failed", CHECKINS_AS_ROUTINES);
          if (params.save === "fail")
            return settle("failed", "invalid config: the gateway refused the change.");
          if (params.save === "unknown")
            return settle(
              "unknown",
              "Clawtrate couldn't confirm the change: the gateway's config and check-in jobs didn't both show it.",
            );
          const plan = planCheckIn(botId, command, { config });
          if ("conflict" in plan) return settle("conflict", plan.conflict);
          if ("refused" in plan) return settle("failed", plan.refused);
          const entries = (
            plan.patch?.agents as { entries?: Record<string, { heartbeat: Heartbeat }> }
          )?.entries;
          for (const [id, entry] of Object.entries(entries ?? {})) {
            const heartbeat: Record<string, unknown> = { ...config.agents.entries[id]?.heartbeat };
            for (const [key, value] of Object.entries(entry.heartbeat))
              if (value === null) delete heartbeat[key];
              else heartbeat[key] = value;
            config.agents.entries[id] = { heartbeat: heartbeat as Heartbeat };
          }
          settle("saved", null);
        }, 600);
        return Promise.resolve();
      }
    }
    return undefined;
  };
}
