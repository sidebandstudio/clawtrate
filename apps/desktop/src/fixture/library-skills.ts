// A library skill saved after Otto's task started, in the fixture (#889, F-071): the "/" menu
// offers it to add, and adding it or its Undo runs the engine's own steps against answers shaped
// as the gateway's (`skills.library.list {sessionKey}`, `skills.library.activate`). Made-up names.

import {
  attachLibrarySkill,
  detachLibrarySkill,
  type BridgeCommand,
  type MenuRow,
} from "@clawtrate/core";

const MOON = {
  skillId: "e65dd9b1-0271-4cd6-a01b-ca53f774a07a",
  revision: "0123456789abcdef".repeat(4),
  slug: "moon-phase",
  name: "s_moon_phas_e65dd9b102714cd6a01b",
  description: "Use when someone asks for the moon's phase tonight.",
};

/** The menu's row for it: to add while the task doesn't have it, the person's own once it does. */
export function moonRow(inTask: boolean): MenuRow {
  const row: MenuRow = {
    kind: inTask ? "your-skill" : "your-skill-to-add",
    name: MOON.slug,
    description: MOON.description,
    insert: `/skill ${MOON.name}`,
  };
  return inTask ? row : { ...row, attach: { skillId: MOON.skillId, revision: MOON.revision } };
}

/** Whether the fixture's task has the skill, and its answers to an add and an Undo. */
export function librarySkillCommands() {
  let inTask = false;
  const pin = { skillId: MOON.skillId, revision: MOON.revision, name: MOON.name };
  const request = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === "skills.library.list")
      return Promise.resolve({
        profileId: "fixture-owner",
        session: {
          selections: inTask ? [pin] : [],
          attachable: inTask ? [] : [{ ...pin, slug: MOON.slug, enabled: true }],
        },
      });
    inTask = params.action === "attach";
    return Promise.resolve({ selections: inTask ? [pin] : [], sessionActivation: "next-turn" });
  };
  return {
    inTask: () => inTask,
    answer(command: BridgeCommand): Promise<unknown> | null {
      if (command.type === "attachLibrarySkill")
        return attachLibrarySkill(request, command.key, command.skill);
      if (command.type === "detachLibrarySkill")
        return detachLibrarySkill(request, command.key, command.skill);
      return null;
    },
  };
}
