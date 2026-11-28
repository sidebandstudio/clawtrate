// Settings → Skills state transitions and notices: unidentified gateway handling, truncation and
// default-selection notices, file-picker read invalidation, and draft-scoped save completions.

import {
  parseSkillMarkdown,
  utf8Bytes,
  type BridgeCommand,
  type ClawtrateBridge,
  type GatewayStamp,
  type SkillLibraryList,
  type SkillLibrarySaveResult,
} from "@clawtrate/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  applyDraftSaveConflict,
  applyDraftSaveError,
  applyDraftSaveStart,
  applyDraftSaveSuccess,
  importSkillDraft,
  readPickedSkillFile,
  SkillLibraryView,
  skillsLoadView,
  type ImportDraft,
} from "../src/skills/SkillsSection.tsx";

const VALID_A = "---\nname: Skill A\ndescription: First skill.\n---\n\nBody A.\n";
const VALID_B = "---\nname: Skill B\ndescription: Second skill.\n---\n\nBody B.\n";

function toArrayBuffer(text: string): ArrayBuffer {
  const bytes = utf8Bytes(text);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function draftOf(id: number, content: string, stamp: GatewayStamp): ImportDraft {
  const bytes = utf8Bytes(content);
  const parsed = parseSkillMarkdown(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    id,
    fileName: `skill-${id}.md`,
    bytes,
    preview: parsed.preview,
    slug: parsed.preview.slug,
    stamp,
    saving: false,
    conflict: null,
    error: null,
  };
}

function listOf(overrides: Partial<SkillLibraryList> = {}): SkillLibraryList {
  return {
    entries: [
      {
        skillId: "11111111-2222-3333-4444-555555555555",
        slug: "deploy-checklist",
        name: "s_deploy_ch_11111111222233334444",
        description: "Checks release steps.",
        ownerProfileId: "gateway-owner",
        ownerLabel: "Rowan Example",
        shared: false,
        enabled: true,
        revision: "a".repeat(64),
        updatedAt: 1,
        canEdit: true,
      },
    ],
    profileId: "gateway-owner",
    multipleProfiles: false,
    truncated: false,
    defaultSelectionNotice: null,
    stamp: { gatewayId: "gw-one", target: 1 },
    ...overrides,
  };
}

describe("Settings → Skills load states and notices", () => {
  it("F-361: explains when the skill library cannot be tied to a gateway identity instead of loading forever", () => {
    const nullStamp: GatewayStamp = { gatewayId: null, target: 1 };
    const readKey = ":1:100:0";
    const view = skillsLoadView(
      { status: "ready", list: listOf({ stamp: nullStamp }), key: readKey },
      nullStamp,
      readKey,
      true,
      true,
    );
    expect(view.list).toBeNull();
    expect(view.loading).toBe(false);
    expect(view.unidentified).toBe(true);

    const html = renderToStaticMarkup(
      createElement(SkillLibraryView, {
        list: view.list,
        loadError: view.error,
        loading: view.loading,
        unidentified: view.unidentified,
        onRetry: () => {},
      }),
    );
    expect(html).toContain('data-testid="skills-unidentified"');
    expect(html).not.toContain('data-testid="skills-loading"');

    // Identified gateways still enforce sameStamp matching.
    const identified = skillsLoadView(
      {
        status: "ready",
        list: listOf({ stamp: { gatewayId: "gw-one", target: 1 } }),
        key: "gw-one:1:100:0",
      },
      { gatewayId: "gw-two", target: 1 },
      "gw-two:1:200:0",
      true,
      true,
    );
    expect(identified.list).toBeNull();
    expect(identified.unidentified).toBe(false);
    expect(identified.loading).toBe(true);
  });

  it("F-361: renders separate notices for truncated lists and the gateway default-selection limit", () => {
    const notice = "New sessions select up to 64 enabled skills, personal skills first.";
    const html = renderToStaticMarkup(
      createElement(SkillLibraryView, {
        list: listOf({ truncated: true, defaultSelectionNotice: notice }),
        loadError: null,
        loading: false,
        unidentified: false,
        onRetry: () => {},
      }),
    );
    expect(html).toContain('data-testid="skills-truncated"');
    expect(html).toContain("Other skills may still be in your library.");
    expect(html).toContain('data-testid="skills-selection-notice"');
    expect(html).toContain(notice);

    // An empty list that was truncated must not claim the library has no skills yet.
    const emptyTruncated = renderToStaticMarkup(
      createElement(SkillLibraryView, {
        list: listOf({ entries: [], truncated: true }),
        loadError: null,
        loading: false,
        unidentified: false,
        onRetry: () => {},
      }),
    );
    expect(emptyTruncated).toContain('data-testid="skills-truncated"');
    expect(emptyTruncated).not.toContain('data-testid="skills-empty"');
  });

  it("F-361: does not label another profile's private skill as a team skill", () => {
    const baseEntry = listOf().entries[0]!;
    const html = renderToStaticMarkup(
      createElement(SkillLibraryView, {
        list: listOf({
          profileId: "gateway-owner",
          entries: [
            {
              ...baseEntry,
              skillId: "own-1",
              slug: "own-private",
              ownerProfileId: "gateway-owner",
              shared: false,
            },
            {
              ...baseEntry,
              skillId: "team-1",
              slug: "shared-team",
              ownerProfileId: "profile-kit",
              shared: true,
            },
            {
              ...baseEntry,
              skillId: "ws-1",
              slug: "workspace-skill",
              ownerProfileId: null,
              shared: false,
            },
            {
              ...baseEntry,
              skillId: "other-1",
              slug: "other-private",
              ownerProfileId: "profile-sam",
              shared: false,
            },
          ],
        }),
        loadError: null,
        loading: false,
        unidentified: false,
        onRetry: () => {},
      }),
    );

    const rows = html.split('<li class="sk-row"').slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("own-private");
    expect(rows[0]).toContain('<span class="sk-tag">Your skill</span>');
    expect(rows[1]).toContain("shared-team");
    expect(rows[1]).toContain('<span class="sk-tag">Team skill</span>');
    expect(rows[2]).toContain("workspace-skill");
    expect(rows[2]).toContain('<span class="sk-tag">Team skill</span>');
    expect(rows[3]).toContain("other-private");
    expect(rows[3]).not.toContain("Team skill");
    expect(rows[3]).not.toContain("Your skill");
    expect(rows[3]).not.toContain("sk-tag");

    // Without a caller profileId, an unshared profile-owned skill still must not claim Team skill.
    const noProfile = renderToStaticMarkup(
      createElement(SkillLibraryView, {
        list: listOf({
          profileId: null,
          entries: [
            {
              ...baseEntry,
              skillId: "other-2",
              slug: "unowned-view",
              ownerProfileId: "profile-sam",
              shared: false,
            },
          ],
        }),
        loadError: null,
        loading: false,
        unidentified: false,
        onRetry: () => {},
      }),
    );
    expect(noProfile).toContain("unowned-view");
    expect(noProfile).not.toContain("Team skill");
    expect(noProfile).not.toContain("Your skill");
  });
});

describe("Settings → Skills picker and save concurrency", () => {
  it("F-361: invalidates earlier file reads when another file is picked or Cancel runs", async () => {
    const stamp: GatewayStamp = { gatewayId: "gw-one", target: 1 };
    let seq = 0;

    let resolveA!: (buf: ArrayBuffer) => void;
    let rejectErr!: (err: Error) => void;
    const fileA = {
      name: "a.md",
      size: VALID_A.length,
      arrayBuffer: () =>
        new Promise<ArrayBuffer>((resolve) => {
          resolveA = resolve;
        }),
    };
    const fileB = {
      name: "b.md",
      size: VALID_B.length,
      arrayBuffer: async () => toArrayBuffer(VALID_B),
    };
    const failingFile = {
      name: "broken.md",
      size: 12,
      arrayBuffer: () =>
        new Promise<ArrayBuffer>((_resolve, reject) => {
          rejectErr = reject;
        }),
    };

    const seqA = ++seq;
    const readA = readPickedSkillFile(fileA, seqA, stamp, () => seq === seqA);

    const seqB = ++seq;
    const readB = await readPickedSkillFile(fileB, seqB, stamp, () => seq === seqB);
    expect(readB).toMatchObject({ status: "ready", draft: { id: seqB, slug: "skill-b" } });

    // A resolves after B: must be treated as stale so it cannot overwrite B's preview.
    resolveA(toArrayBuffer(VALID_A));
    expect(await readA).toEqual({ status: "stale" });

    // A pending failing read canceled before rejection must not report a stale error.
    const seqErr = ++seq;
    const readErr = readPickedSkillFile(failingFile, seqErr, stamp, () => seq === seqErr);
    seq += 1; // Cancel invalidates the active operation.
    rejectErr(new Error("read failed"));
    expect(await readErr).toEqual({ status: "stale" });
  });

  it("F-361: applies save completions only to the draft that started them", () => {
    const draftA = applyDraftSaveStart(draftOf(1, VALID_A, { gatewayId: "gw-one", target: 1 }), 1)!;
    const draftB = draftOf(2, VALID_B, { gatewayId: "gw-two", target: 2 });
    const draftBSaving = applyDraftSaveStart(draftB, 2)!;

    // Stale success, conflict and error from draft A must leave draft B untouched.
    expect(applyDraftSaveSuccess(draftB, draftA.id)).toBe(draftB);
    expect(applyDraftSaveConflict(draftBSaving, draftA.id, "exists")).toBe(draftBSaving);
    expect(applyDraftSaveError(draftBSaving, draftA.id, "failed")).toBe(draftBSaving);

    // Completions for draft B still apply to draft B.
    expect(applyDraftSaveConflict(draftBSaving, draftB.id, "exists")).toMatchObject({
      id: 2,
      saving: false,
      conflict: "exists",
    });
    expect(applyDraftSaveError(draftBSaving, draftB.id, "failed")).toMatchObject({
      id: 2,
      saving: false,
      error: "failed",
    });
    expect(applyDraftSaveSuccess(draftBSaving, draftB.id)).toBeNull();
  });

  it("F-361: releases the uploaded attachment when importLibrarySkill fails before dispatch", async () => {
    const stamp: GatewayStamp = { gatewayId: "gw-one", target: 1 };
    const sent: BridgeCommand[] = [];
    const busy = "Too many requests are waiting; try again when they finish.";
    const failingBridge: Pick<ClawtrateBridge, "attach" | "invoke" | "send"> = {
      attach: async (file) => ({
        id: "att-1",
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.data.byteLength,
      }),
      invoke: async () => {
        throw new Error(busy);
      },
      send: async (command) => {
        sent.push(command);
      },
    };

    await expect(
      importSkillDraft(failingBridge, {
        bytes: utf8Bytes(VALID_A),
        fileName: "SKILL.md",
        slug: "skill-a",
        stamp,
      }),
    ).rejects.toThrow(busy);
    expect(sent).toEqual([{ type: "releaseAttachments", attachmentIds: ["att-1"] }]);

    // A failing release must not mask the original import error.
    const releaseFailsBridge: Pick<ClawtrateBridge, "attach" | "invoke" | "send"> = {
      ...failingBridge,
      send: async () => {
        throw new Error("queue still full");
      },
    };
    await expect(
      importSkillDraft(releaseFailsBridge, {
        bytes: utf8Bytes(VALID_A),
        fileName: "SKILL.md",
        slug: "skill-a",
        stamp,
      }),
    ).rejects.toThrow(busy);

    // When attach itself fails, nothing was uploaded to release.
    const attachFailedSent: BridgeCommand[] = [];
    const attachFailsBridge: Pick<ClawtrateBridge, "attach" | "invoke" | "send"> = {
      attach: async () => {
        throw new Error("upload failed");
      },
      invoke: async () => {
        throw new Error("unexpected");
      },
      send: async (command) => {
        attachFailedSent.push(command);
      },
    };
    await expect(
      importSkillDraft(attachFailsBridge, {
        bytes: utf8Bytes(VALID_A),
        fileName: "SKILL.md",
        slug: "skill-a",
        stamp,
      }),
    ).rejects.toThrow("upload failed");
    expect(attachFailedSent).toEqual([]);

    // When invoke succeeds, the host already consumed the upload.
    const savedSent: BridgeCommand[] = [];
    const savedResult: SkillLibrarySaveResult = {
      outcome: "conflict",
      message: "exists",
      stamp,
    };
    const okBridge: Pick<ClawtrateBridge, "attach" | "invoke" | "send"> = {
      attach: failingBridge.attach,
      invoke: (async () => savedResult) as ClawtrateBridge["invoke"],
      send: async (command) => {
        savedSent.push(command);
      },
    };
    expect(
      await importSkillDraft(okBridge, {
        bytes: utf8Bytes(VALID_A),
        fileName: "SKILL.md",
        slug: "skill-a",
        stamp,
      }),
    ).toEqual(savedResult);
    expect(savedSent).toEqual([]);
  });
});
