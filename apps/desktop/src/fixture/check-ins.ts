// The bots' check-ins in the fixture, as the development gateway reports them
// (docs/decisions.md, "Check-ins"), and the save answered the way the gateway
// derives its heartbeat jobs from the config.
//
//   &checkins=off      Juniper has a setting of its own, Off (`every: "0m"`): its job is disabled
//   &checkins=daily    Marlow checks in daily with its own setting; Juniper through the default
//   &checkins=every    Otto every 2 hours with its own setting, and a custom prompt
//   &scheduler=off     the gateway's scheduler is off, as on the development gateway
//   &cisave=fail       a save the gateway refuses; &cisave=unknown, one it may have applied

import {
  checkInPatch,
  everyMs,
  type BridgeCommand,
  type CheckInJob,
  type CheckInSetting,
  type CheckInsState,
  type ClawtrateState,
} from "@clawtrate/core";

export type CheckInParams = {
  checkins: "off" | "daily" | "every" | null;
  scheduler: boolean;
  save: "fail" | "unknown" | null;
};

export function checkInParams(params: URLSearchParams): CheckInParams {
  const checkins = params.get("checkins");
  const save = params.get("cisave");
  return {
    checkins: checkins === "off" || checkins === "daily" || checkins === "every" ? checkins : null,
    scheduler: params.get("scheduler") !== "off",
    save: save === "fail" || save === "unknown" ? save : null,
  };
}

const HOUR = 3_600_000;

/** The jobs the gateway keeps for these settings: the default's owner until any bot has its own. */
function jobsFor(settings: readonly CheckInSetting[], now: number): CheckInJob[] {
  const next = (ms: number) => now - (now % (30 * 60_000)) + Math.min(ms, 30 * 60_000);
  if (settings.length === 0) {
    return [{ botId: "main", enabled: true, everyMs: HOUR / 2, nextRunAtMs: next(HOUR / 2) }];
  }
  return settings.map((setting) => {
    const ms = everyMs(setting.every ?? "30m") ?? HOUR / 2;
    return ms === 0
      ? { botId: setting.botId, enabled: false, everyMs: HOUR / 2, nextRunAtMs: null }
      : { botId: setting.botId, enabled: true, everyMs: ms, nextRunAtMs: next(ms) };
  });
}

const own = (botId: string, every: string, prompt: string | null = null): CheckInSetting => ({
  botId,
  every,
  prompt,
  promptCut: false,
});

export function fixtureCheckIns(now: number, params: CheckInParams): CheckInsState {
  const settings =
    params.checkins === "off"
      ? [own("main", "0m")]
      : params.checkins === "daily"
        ? [own("main", "30m"), own("marlow", "24h")]
        : params.checkins === "every"
          ? [
              own("main", "30m"),
              own(
                "otto",
                "2h",
                "Look at the disk space on the build machine. Tell me if it is low.",
              ),
            ]
          : [];
  return {
    status: "ready",
    error: null,
    scheduler: params.scheduler,
    jobs: jobsFor(settings, now),
    settings,
    save: null,
  };
}

/** The check-in commands, answered on the fixture's state; undefined for any other command. */
export function checkInCommand(
  command: BridgeCommand,
  get: () => ClawtrateState,
  set: (state: ClawtrateState) => void,
  params: CheckInParams,
): Promise<unknown> | undefined {
  const put = (change: (c: CheckInsState) => CheckInsState) => {
    const checkIns = get().checkIns;
    if (checkIns) set({ ...get(), checkIns: change(checkIns) });
  };
  switch (command.type) {
    case "refreshCheckIns":
      return Promise.resolve();
    case "dismissCheckInSave":
      put((c) =>
        c.save?.id === command.saveId && c.save.status !== "saving" ? { ...c, save: null } : c,
      );
      return Promise.resolve();
    case "saveCheckIn": {
      if (!get().connection.canAdmin)
        return Promise.reject(new Error("Changing check-ins needs admin access."));
      const { saveId, botId, every } = command;
      put((c) => ({ ...c, save: { id: saveId, botId, every, status: "saving", error: null } }));
      setTimeout(() => {
        if (params.save) {
          return put((c) => ({
            ...c,
            save: {
              id: saveId,
              botId,
              every,
              status: params.save === "fail" ? "failed" : "unknown",
              error:
                params.save === "fail"
                  ? "invalid config: the gateway refused the change."
                  : "Clawtrate couldn't confirm the change: the check-in job didn't show it.",
            },
          }));
        }
        put((c) => {
          const patch = checkInPatch(botId, command, c.jobs, c.settings ?? []) as {
            agents: {
              entries: Record<string, { heartbeat: { every: string; prompt?: string | null } }>;
            };
          };
          const settings = [...(c.settings ?? [])];
          for (const [id, entry] of Object.entries(patch.agents.entries)) {
            const before = settings.find((each) => each.botId === id);
            const prompt =
              entry.heartbeat.prompt === undefined
                ? (before?.prompt ?? null)
                : entry.heartbeat.prompt;
            const next = own(id, entry.heartbeat.every, prompt);
            if (before) settings[settings.indexOf(before)] = next;
            else settings.push(next);
          }
          return {
            ...c,
            settings,
            jobs: jobsFor(settings, Date.now()),
            save: { id: saveId, botId, every, status: "saved", error: null },
          };
        });
      }, 600);
      return Promise.resolve();
    }
  }
  return undefined;
}
