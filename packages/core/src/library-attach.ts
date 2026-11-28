// Adding a skill from the gateway's skill library to an open task, and taking it out again
// (issue #889, parity F-071). A task has the library's skills from when it started; one saved
// since is in `skills.library.list {sessionKey}` `session.attachable`, and only
// `skills.library.activate {sessionKey, action, skillId, revision}` (`operator.write`) gives the
// task it, from its next turn. Both OpenClaw 2026.10.6 and 2026.11.10 have that call, in the same
// form.
//
// The gateway attaches any revision of the skill it still keeps, an older one included, and
// answers the same way, and its detach takes the skill out whatever it is and says the same when
// the task never had it. So each step reads the task's list first and acts only on what that
// read shows: an attach only of the revision the menu showed, still to add; an Undo only while
// the task still has the revision this device added. What a person is told is the outcome as
// established: done (the answer shows it), nothing sent (a read or a check stopped it), refused
// (the gateway's own refusal, in plain words), or not known (the answer was lost).

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { COMMAND_NAME } from "./composer-menus.ts";
import { asRecord } from "./mapping.ts";

/** A library skill as the menu showed it: its entry, the revision shown and its slug. */
export type LibrarySkill = { skillId: string; revision: string; slug: string };

/** What adding a skill did: `added` by this device, or `already` in the task (nothing sent). */
export type AttachOutcome = {
  status: "added" | "already";
  /** The generated command that runs it in this task (`s_tide_tabl_…`). */
  command: string;
  /** The revision the task has now. */
  revision: string;
};

/** What Undo did, in words that say it. */
export type DetachOutcome = { undone: boolean; words: string };

/** A request the client never sent (the client's `NotSentError`): the connection moved on. */
const notSent = (error: unknown) => error instanceof Error && error.name === "NotSentError";

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
type Selection = { skillId: string; revision: string; name: string | null };

/** Library skills as an answer lists them, or null when it lists none in that form. */
const skillsOf = (rows: unknown): Selection[] | null =>
  Array.isArray(rows)
    ? rows.flatMap((row) => {
        const each = asRecord(row);
        if (typeof each?.skillId !== "string" || typeof each.revision !== "string") return [];
        const name =
          typeof each.name === "string" && COMMAND_NAME.test(each.name) ? each.name : null;
        return [{ skillId: each.skillId, revision: each.revision, name }];
      })
    : null;

/** The task's list (`skills.library.list {sessionKey}`): what it has and what it can be given. */
async function readTask(
  request: Request,
  sessionKey: string,
  failed: string,
): Promise<{ selected: Selection[]; attachable: Selection[] }> {
  let answer: unknown;
  try {
    answer = await request("skills.library.list", { sessionKey });
  } catch (error) {
    throw new Error(notSent(error) ? "The connection changed, so nothing was sent." : failed, {
      cause: error,
    });
  }
  const session = asRecord(asRecord(answer)?.session);
  const selected = skillsOf(session?.selections);
  const attachable = skillsOf(session?.attachable);
  if (!selected || !attachable) throw new Error(failed);
  return { selected, attachable };
}

/** A refusal's reason, in plain words: the gateway's own text never goes in a sentence. */
function refusalReason(error: GatewayProtocolRequestError, slug: string): string {
  const details = asRecord(error.details);
  if (details?.code === "MISSING_SCOPE") return "this connection can't change the task's skills.";
  switch (details?.code) {
    case "SKILL_LIBRARY_NOT_FOUND":
      return `the gateway couldn't find ${slug} in your library, or this task.`;
    case "SKILL_LIBRARY_LIMIT":
      return "a task can have at most 64 library skills.";
    case "SKILL_LIBRARY_CONFLICT":
      return "the task's skills changed at the same moment. Try again.";
    case "SKILL_LIBRARY_FORBIDDEN":
      return "the gateway doesn't let this connection change the task's skills.";
    case "SKILL_LIBRARY_IDENTITY_REQUIRED":
    case "SKILL_LIBRARY_AUTHORITY_EXPIRED":
      return "the gateway no longer knows whose library this connection uses. Reconnect, then try again.";
    default:
      return "the gateway refused.";
  }
}

/**
 * Add `skill` to the task, the revision the menu showed, then say what the task has: `added`, or
 * `already` when the task had the skill before this device asked (nothing is sent then). Throws
 * with words that say the outcome: nothing sent, refused, or not known.
 */
export async function attachLibrarySkill(
  request: Request,
  sessionKey: string,
  skill: LibrarySkill,
): Promise<AttachOutcome> {
  const { skillId, revision, slug } = skill;
  const unread = `Couldn't read this task's skills, so ${slug} wasn't added. Try again.`;
  const now = await readTask(request, sessionKey, unread);
  const had = now.selected.find((each) => each.skillId === skillId);
  if (had) {
    if (!had.name) throw new Error(unread);
    return { status: "already", command: had.name, revision: had.revision };
  }
  const offered = now.attachable.find((each) => each.skillId === skillId);
  if (!offered) throw new Error(`${slug} is no longer in your library, so it wasn't added.`);
  // The gateway would attach the revision shown even after an edit, as if it were the latest.
  if (offered.revision !== revision)
    throw new Error(
      `${slug} changed since this list was read, so it wasn't added. Choose it again.`,
    );
  let answer: unknown;
  try {
    answer = await request("skills.library.activate", {
      sessionKey,
      action: "attach",
      skillId,
      revision,
    });
  } catch (error) {
    if (notSent(error))
      throw new Error(`The connection changed, so ${slug} wasn't added.`, { cause: error });
    if (error instanceof GatewayProtocolRequestError)
      throw new Error(`Couldn't add ${slug} to this task: ${refusalReason(error, slug)}`, {
        cause: error,
      });
    throw new Error(
      `It isn't known whether ${slug} was added to this task: the gateway's answer didn't arrive. Type / to see.`,
      { cause: error },
    );
  }
  const added = skillsOf(asRecord(answer)?.selections)?.find(
    (each) => each.skillId === skillId && each.revision === revision,
  );
  if (!added?.name)
    throw new Error(
      `It isn't known whether ${slug} was added to this task: the gateway's answer didn't show it. Type / to see.`,
    );
  return { status: "added", command: added.name, revision };
}

/**
 * Undo an add this device made: take `skill` out of the task, only while the task still has the
 * revision that was added (`skill.revision`). Answers what happened in words; throws with words
 * when the outcome isn't known or the gateway refused.
 */
export async function detachLibrarySkill(
  request: Request,
  sessionKey: string,
  skill: LibrarySkill,
): Promise<DetachOutcome> {
  const { skillId, revision, slug } = skill;
  const now = await readTask(
    request,
    sessionKey,
    `Couldn't read this task's skills, so nothing was sent. ${slug} may still be in this task.`,
  );
  const held = now.selected.find((each) => each.skillId === skillId);
  if (!held) return { undone: false, words: `${slug} is already out of this task.` };
  if (held.revision !== revision)
    return {
      undone: false,
      words: `${slug} was changed in this task since it was added here, so it was left in.`,
    };
  let answer: unknown;
  try {
    answer = await request("skills.library.activate", { sessionKey, action: "detach", skillId });
  } catch (error) {
    if (notSent(error))
      throw new Error("The connection changed, so nothing was sent.", { cause: error });
    if (error instanceof GatewayProtocolRequestError)
      throw new Error(`Couldn't undo: ${refusalReason(error, slug)}`, { cause: error });
    throw new Error(
      `It isn't known whether ${slug} was taken out: the gateway's answer didn't arrive. Type / to see.`,
      { cause: error },
    );
  }
  const left = skillsOf(asRecord(answer)?.selections);
  if (!left)
    throw new Error(
      `It isn't known whether ${slug} was taken out: the gateway's answer didn't show the task's skills. Type / to see.`,
    );
  if (left.some((each) => each.skillId === skillId))
    throw new Error(`The gateway still lists ${slug} in this task.`);
  return { undone: true, words: `Undone. ${slug} is out of this task.` };
}
