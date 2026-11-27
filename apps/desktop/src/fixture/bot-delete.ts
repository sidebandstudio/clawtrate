// The fixture's Delete bot… (docs/parity.md F-050, F-276, F-464): the bot list
// with each bot's workspace folder, and `agents.delete` answered as the
// gateway answers it, closely enough for interface checks. A bot the answer
// removed leaves the fixture's bot list, as it leaves the gateway's. Every
// folder and reason is made up.
//
// Address parameters:
//   delshared=1        Pip's workspace folder is also Marlow's
//   delrecord=none     the gateway keeps no creation record for any bot
//   delnoname=1        Pip has no name, so the gateway's list names it by its id
//   delname=<name>     the gateway names Pip this instead
//   delread=loading|failed   the dialog's read never answers, or fails
//   delresult=partial|purge|refused|unconfirmed|replaced|failed   how the delete goes:
//            partial: the bot is removed and one folder couldn't be moved; purge: the task records
//            couldn't be cleared, so no folder moved; refused: the gateway refuses, in its own
//            words, which confirms nothing; unconfirmed:
//            the answer is lost after the bot was removed; failed: the request can't be sent;
//            lost: the reply is lost between the host and the window (the promise rejects);
//            stale: a newer bot list came in while the one before the delete was read.
//            unread: as partial, but the bot list read after it fails;
//            noanswer: the answer is lost and the gateway still lists Pip.
//            Once, before the first delete, the gateway's Pip changes and nothing is sent; it
//            stays changed, and a confirmation of the bot as it is now goes on:
//            replaced: another bot (Quill) has Pip's id; recreated: another bot with Pip's id
//            and name; renamed: Pip is "Pip II"; moved: Pip's workspace folder moved.
//            A confirmation whose review isn't the bot as the gateway has it sends nothing.
//            kept-moved: asked to keep the folders, the gateway moves one anyway, as it does
//            when it finishes an earlier delete's journal. Nothing is ever sent again.

import {
  confirmMatches,
  confirmTargetOf,
  nameDigestOf,
  sameStamp,
  type BotDeleteOutcome,
  type BotDeleteRead,
  type BridgeCommand,
  type ChangedReason,
  type ClawtrateState,
} from "@clawtrate/core";

export type BotDeleteParams = {
  shared: boolean;
  noRecord?: boolean;
  noName?: boolean;
  name?: string | null;
  read: string | null;
  result: string | null;
};

export function botDeleteParams(params: URLSearchParams): BotDeleteParams {
  return {
    shared: params.get("delshared") === "1",
    noRecord: params.get("delrecord") === "none",
    noName: params.get("delnoname") === "1",
    name: params.get("delname"),
    read: params.get("delread"),
    result: params.get("delresult"),
  };
}

export const NO_BOT_DELETE_PARAMS: BotDeleteParams = { shared: false, read: null, result: null };

const ROOT = "/srv/clawtrate";
/** The fixture gateway's identity, where its connection names none. */
const FIXTURE_GATEWAY = "fixture-gateway";
/** How long the fixture's gateway takes to answer a delete, so its busy state can be seen. */
const DELETE_MS = 400;

export function botDeleteCommands(params: BotDeleteParams) {
  const workspace = (id: string) =>
    id === "main"
      ? `${ROOT}/workspace`
      : params.shared && id === "pip"
        ? `${ROOT}/workspaces/marlow`
        : `${ROOT}/workspaces/${id}`;
  const created = (id: string) => 1_700_000_000_000 + id.length;
  /** What the gateway has now for a bot, after a replacement, a rename or a moved folder. */
  const changes = new Map<string, { name?: string; createdAt?: number; workspace?: string }>();
  /** The name facts of a bot the gateway names `given` (null: no name). */
  const named = (botId: string, given: string | null) => ({
    name: given ?? botId,
    nameDigest: nameDigestOf(given),
    confirm: confirmTargetOf(given, botId),
  });
  const stampOf = (state: ClawtrateState) => ({
    gatewayId: state.connection.gatewayId ?? FIXTURE_GATEWAY,
    target: state.connection.target,
  });
  const facts = (state: ClawtrateState, botId: string): BotDeleteRead => {
    const self = state.bots.find((bot) => bot.id === botId);
    const now = changes.get(botId) ?? {};
    const folder = self ? (now.workspace ?? workspace(botId)) : null;
    const sharedWith = state.bots
      .filter((bot) => bot.id !== botId && folder !== null && workspace(bot.id) === folder)
      .map((bot) => bot.name);
    return {
      stamp: stampOf(state),
      botId,
      listed: self !== undefined,
      main: self?.isDefault === true,
      ...(self
        ? named(
            botId,
            params.noName
              ? null
              : (now.name ?? (botId === "pip" ? params.name : null) ?? self.name),
          )
        : { name: null, nameDigest: null, confirm: confirmTargetOf(null, botId) }),
      createdAt: self && !params.noRecord ? (now.createdAt ?? created(botId)) : null,
      workspace: folder,
      folder: sharedWith.length > 0 ? "shared" : "own",
      sharedWith,
      sharedOmitted: 0,
    };
  };
  /** A replacement or rename shown once: the second confirmation goes. */
  let changedOnce = false;

  return (
    command: BridgeCommand,
    get: () => ClawtrateState,
    set: (state: ClawtrateState) => void,
    deferred: (run: () => void, ms: number) => void,
  ): Promise<unknown> | null => {
    const later = <T>(value: () => T, ms = DELETE_MS) =>
      new Promise<T>((resolve, reject) =>
        deferred(() => {
          try {
            resolve(value());
          } catch (error) {
            reject(error);
          }
        }, ms),
      );
    const remove = (botId: string) => {
      const state = get();
      set({ ...state, bots: state.bots.filter((bot) => bot.id !== botId) });
    };
    if (command.type === "readBotDelete") {
      if (params.read === "loading") return new Promise(() => {});
      if (params.read === "failed")
        return Promise.reject(new Error("The gateway didn't answer in time."));
      return Promise.resolve(facts(get(), command.botId));
    }
    if (command.type !== "deleteBot") return null;
    const state = get();
    if (!state.connection.canAdmin)
      return Promise.resolve({ kind: "not-sent", message: "Deleting a bot needs admin access." });
    if (!sameStamp(command.stamp, stampOf(state)))
      return Promise.resolve({
        kind: "not-sent",
        message: "This change was made for another gateway, so nothing was sent.",
      });
    const accepted = stampOf(state);
    return later((): BotDeleteOutcome => {
      const deleteFiles = command.deleteFiles;
      // Another gateway connected while this one held the delete: its list is never touched.
      if (!sameStamp(accepted, stampOf(get())))
        return {
          kind: "unconfirmed",
          message: "the connection changed before the gateway answered",
          deleteFiles,
          listed: null,
        };
      // The list as it is when the gateway handles the delete.
      let read = facts(get(), command.botId);
      const folder = read.workspace ?? `${ROOT}/workspaces/${command.botId}`;
      if (read.main) return { kind: "changed", reason: "main", read };
      if (!read.listed) return { kind: "changed", reason: "gone", read };
      // Once, the gateway's bot changes before the delete; what it has stays changed after.
      const once: Record<
        string,
        [ChangedReason, { name?: string; createdAt?: number; workspace?: string }]
      > = {
        replaced: ["replaced", { name: "Quill", createdAt: read.createdAt! + 1 }],
        recreated: ["replaced", { createdAt: read.createdAt! + 1 }],
        renamed: ["changed", { name: "Pip II" }],
        moved: ["moved", { workspace: `${ROOT}/moved/${command.botId}` }],
      };
      const scripted = params.result ? once[params.result] : undefined;
      if (scripted && !changedOnce) {
        changedOnce = true;
        changes.set(command.botId, { ...changes.get(command.botId), ...scripted[1] });
        read = facts(get(), command.botId);
        return { kind: "changed", reason: scripted[0], read };
      }
      if (params.result === "stale")
        return {
          kind: "unread",
          message: "The bot list changed while Clawtrate read it. Nothing was sent.",
        };
      // The review sent must be the bot as the gateway has it now, as the host requires.
      if (command.reviewed.createdAt !== read.createdAt)
        return { kind: "changed", reason: "replaced", read };
      if (command.reviewed.workspace !== read.workspace)
        return { kind: "changed", reason: "moved", read };
      if (command.reviewed.nameDigest !== read.nameDigest)
        return { kind: "changed", reason: "changed", read };
      if (deleteFiles && (read.folder !== "own" || read.createdAt === null))
        return { kind: "changed", reason: "files", read };
      if (!confirmMatches(command.typed, read.confirm))
        return {
          kind: "not-sent",
          message: "What was typed isn't what the dialog asks for, so nothing was sent.",
        };
      if (params.result === "failed")
        return { kind: "not-sent", message: "Not connected to the gateway." };
      if (params.result === "refused")
        return {
          kind: "unconfirmed",
          message: `Agent "${command.botId}" owns the sign-ins other bots share and cannot be deleted.`,
          deleteFiles,
          listed: true,
        };
      if (params.result === "lost") {
        remove(command.botId);
        throw new Error("Lost the preview host");
      }
      if (params.result === "noanswer")
        return {
          kind: "unconfirmed",
          message: "it didn't answer in time",
          deleteFiles,
          listed: true,
        };
      remove(command.botId);
      if (params.result === "unconfirmed") {
        return {
          kind: "unconfirmed",
          message: "it didn't answer in time",
          deleteFiles,
          listed: false,
        };
      }
      const base = {
        kind: "answered" as const,
        deleteFiles,
        removedBindings: 1,
        removedOmitted: 0,
        missingOmitted: 0,
        failedOmitted: 0,
        listed: false,
      };
      if (params.result === "purge") {
        return { ...base, removed: [], failed: [], purgeFailed: true };
      }
      if ((params.result === "partial" || params.result === "unread") && deleteFiles) {
        return {
          ...base,
          listed: params.result === "unread" ? null : false,
          removed: [{ path: folder, method: "trash" }],
          failed: [{ path: `${ROOT}/agents/${command.botId}`, reason: "Operation not permitted" }],
          purgeFailed: false,
        };
      }
      if (params.result === "kept-moved")
        return {
          ...base,
          removed: [{ path: folder, method: "trash" }],
          failed: [],
          purgeFailed: false,
        };
      return {
        ...base,
        removed: deleteFiles
          ? [
              { path: folder, method: "trash" },
              { path: `${ROOT}/agents/${command.botId}`, method: "trash" },
            ]
          : [],
        failed: [],
        purgeFailed: false,
      };
    });
  };
}
