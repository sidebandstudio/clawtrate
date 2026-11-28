// Fixture state for Settings → Skills (F-361): library listing, SKILL.md import preview,
// slug conflict in the gateway's exact words, and gateway refusals.
//
// URL params:
//   &skills=empty     start with an empty skill library
//   &skills=conflict  every import returns SKILL_LIBRARY_NAME_CONFLICT
//   &skills=refused   every import refuses with a policy-blocked message
//   &skills=failed    listing the library fails

import {
  parseSkillMarkdown,
  skillSlugProblem,
  type BridgeCommand,
  type GatewayStamp,
  type SkillLibraryEntry,
  type SkillLibraryList,
  type SkillLibrarySaveResult,
} from "@clawtrate/core";

export type SkillsParams = {
  mode: "default" | "empty" | "conflict" | "refused" | "failed";
};

export const NO_SKILLS_PARAMS: SkillsParams = { mode: "default" };

export function skillsParams(params: URLSearchParams): SkillsParams {
  const mode = params.get("skills");
  if (mode === "empty" || mode === "conflict" || mode === "refused" || mode === "failed")
    return { mode };
  return NO_SKILLS_PARAMS;
}

const REV_1 = "5e82a5f408dd20b3299df917629751023ab1169ef45707c8a9d00ccaaf22611f";
const REV_2 = "f85e0cdc03b4645022262dacdd2e3e3b9b23fa76f132065476c2c9d14db9bdab";

function initialEntries(now: number): SkillLibraryEntry[] {
  return [
    {
      skillId: "e86150d3-50aa-4b29-b6a7-0b8566c61f8f",
      slug: "deploy-checklist",
      name: "s_deploy_ch_e86150d350aa4b29b6a7",
      description: "Checks release notes, tests and logs before deploying a build.",
      ownerProfileId: "gateway-owner",
      ownerLabel: "Rowan Example",
      shared: false,
      enabled: true,
      revision: REV_1,
      updatedAt: now - 3_600_000,
      canEdit: true,
    },
    {
      skillId: "8e7f5f9d-4d47-4772-9d35-62f00fdb91fc",
      slug: "incident-handoff",
      name: "s_incident_8e7f5f9d4d4747729d35",
      description: "Summarises open incidents and next steps at shift handoff.",
      ownerProfileId: "profile-kit",
      ownerLabel: "Kit Example",
      shared: true,
      enabled: true,
      revision: REV_2,
      updatedAt: now - 86_400_000,
      canEdit: false,
    },
  ];
}

export function skillsCommands(
  now: number,
  params: SkillsParams,
  stampOf: () => GatewayStamp,
  takeFile: (id: string) => Uint8Array | null,
  canWrite: () => boolean,
) {
  const entries: SkillLibraryEntry[] = params.mode === "empty" ? [] : initialEntries(now);
  let nextSerial = 1;

  return async (
    command: Extract<
      BridgeCommand,
      { type: "listSkillLibrary" | "importLibrarySkill" | "activateSkillLibrary" }
    >,
  ): Promise<SkillLibraryList | SkillLibrarySaveResult | unknown> => {
    const stamp = stampOf();
    if (command.type === "listSkillLibrary") {
      if (params.mode === "failed") throw new Error("Gateway unavailable.");
      return {
        entries: entries.map((each) => ({ ...each })),
        profileId: "gateway-owner",
        multipleProfiles: true,
        truncated: false,
        defaultSelectionNotice: null,
        stamp,
      };
    }

    if (command.type === "activateSkillLibrary") {
      if (!canWrite())
        throw new Error("Updating a task's skills needs write access to the gateway.");
      return {
        sessionKey: command.key,
        sessionActivation: "next-turn",
        selectionCount: entries.length,
      };
    }

    if (!canWrite()) throw new Error("Importing a skill needs write access to the gateway.");
    const slugProblem = skillSlugProblem(command.slug);
    if (slugProblem) throw new Error(slugProblem);
    const bytes = takeFile(command.attachmentId);
    if (!bytes) throw new Error("A file is no longer available; add it again.");
    const parsed = parseSkillMarkdown(bytes);
    if (!parsed.ok) throw new Error(parsed.error);

    if (params.mode === "refused") {
      throw new Error(
        "Skill security scan found critical issues. Review the instructions and support files before publishing.",
      );
    }

    const exists = entries.some(
      (each) => each.ownerProfileId === "gateway-owner" && each.slug === command.slug,
    );
    if (params.mode === "conflict" || exists) {
      return {
        outcome: "conflict",
        message: `A skill named "${command.slug}" already exists in this library. Choose a different slug; existing skills were preserved.`,
        stamp,
      };
    }

    const serial = nextSerial++;
    const hex = String(serial).padStart(12, "0");
    const entry: SkillLibraryEntry = {
      skillId: `00000000-0000-4000-8000-${hex}`,
      slug: command.slug,
      name: `s_${command.slug.replace(/-/g, "_").slice(0, 9)}_${hex.repeat(2).slice(0, 20)}`,
      description: parsed.preview.description,
      ownerProfileId: "gateway-owner",
      ownerLabel: "Rowan Example",
      shared: false,
      enabled: true,
      revision: `${serial}`.padStart(64, "a"),
      updatedAt: now,
      canEdit: true,
    };
    entries.push(entry);
    entries.sort((a, b) => a.slug.localeCompare(b.slug));
    return {
      outcome: "saved",
      state: "published",
      target: "personal",
      nextAction:
        "Enabled for your new sessions, subject to agent policy and prerequisites. Existing session pins remain. Use skills.library.activate to attach or refresh it.",
      entry,
      stamp,
    };
  };
}
