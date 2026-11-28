// Importing a local SKILL.md into the gateway skill library (F-361) against a real development
// gateway (works on both OpenClaw 2026.10.6 and 2026.11.10):
// 1. Opens Settings → Skills and picks a local SKILL.md file, verifying the plain-text preview
//    without sending anything yet.
// 2. Explicitly saves a copy to the gateway library (`skills.library.save`, `operator.write`) and
//    verifies it appears in Settings → Skills and in `skills.library.list`.
// 3. Re-importing the same slug shows the gateway's own conflict words and preserves the existing
//    skill without overwriting.
// 4. A task started before the import keeps its pinned skills unchanged; a task started after sees
//    the imported skill in the composer's "/" menu.

import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import { devGateway } from "./global-setup.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;

async function approve() {
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000 })
    .toMatch(/^Approved /m);
}

async function openShell(page: Page) {
  await page.goto(process.env.CLAWTRATE_E2E_URL!);
  const connect = page.getByRole("button", { name: "Use the development gateway" });
  const bots = page.getByTestId("bot");
  await expect
    .poll(async () => (await connect.isVisible()) || (await bots.count()) >= 4, { timeout: 20_000 })
    .toBe(true);
  if (await connect.isVisible()) {
    await connect.click();
    await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible();
    await approve();
  }
  await expect(bots.first()).toBeVisible({ timeout: 20_000 });
}

test("F-361: importing a local SKILL.md previews it, saves a copy to the gateway library, reports a name conflict, and leaves existing task pins unchanged", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const person = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate skill import check",
    ["operator.read", "operator.write"],
    [],
  );
  const tag = randomBytes(3).toString("hex");
  const existingSlug = `existing-pin-${tag}`;
  const existingFile = `---\nname: Existing Pin ${tag}\ndescription: Existing skill pinned before import.\n---\n\nKeep this pinned revision unchanged.\n`;
  const slug = `git-import-${tag}`;
  const skillTitle = `Git Import ${tag}`;
  const description = `Checks release steps for imported skill ${tag}.`;
  const body = `# ${skillTitle}\n\nVerify <b>plain text</b> instructions for ${tag}.\n`;
  const skillFile = `---\nname: ${skillTitle}\ndescription: ${description}\n---\n\n${body}`;

  const cleanupSkills: Array<{ skillId: string; revision: string }> = [];
  try {
    // Seed an existing skill so the task started before the import has a pinned revision to check.
    const existingSaved = await person.request<{
      entry: { skillId: string; slug: string; revision: string };
    }>("skills.library.save", {
      expectedRevision: null,
      slug: existingSlug,
      content: existingFile,
    });
    cleanupSkills.push({
      skillId: existingSaved.entry.skillId,
      revision: existingSaved.entry.revision,
    });

    // A task started before the import must keep its pinned skills and revisions unchanged.
    const beforeTask = await person.request<{ key: string }>("sessions.create", {
      agentId: "otto",
      label: `Before import ${tag}`,
    });
    const beforePins = await person.request<{
      session?: { selections: Array<{ skillId: string; slug?: string; revision: string }> };
    }>("skills.library.list", { sessionKey: beforeTask.key });
    const beforeSelections = (beforePins.session?.selections ?? []).map((s) => ({
      skillId: s.skillId,
      slug: s.slug,
      revision: s.revision,
    }));
    expect(
      beforeSelections.some(
        (s) =>
          s.skillId === existingSaved.entry.skillId && s.revision === existingSaved.entry.revision,
      ),
    ).toBe(true);
    expect(beforeSelections.some((s) => s.slug === slug)).toBe(false);

    await openShell(page);
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("button", { name: "Skills", exact: true }).click();
    await expect(settings.getByRole("heading", { name: "Skills", level: 3 })).toBeVisible();

    // Ensure this connection holds write access (the shared preview host pairs read-only first).
    const requestAccess = settings
      .getByTestId("skills-access-bar")
      .getByRole("button", { name: "Request access" });
    if (await requestAccess.isVisible().catch(() => false)) {
      await requestAccess.click();
      await approve();
      await expect(settings.getByTestId("skills-import-button")).toBeVisible({ timeout: 30_000 });
    }

    await settings.getByTestId("skills-file-input").setInputFiles({
      name: "SKILL.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(skillFile, "utf8"),
    });

    await expect(settings.getByTestId("skill-import-preview")).toBeVisible();
    await expect(settings.getByTestId("skill-preview-name")).toHaveText(skillTitle);
    await expect(settings.getByTestId("skill-preview-description")).toHaveText(description);
    await expect(settings.getByTestId("skill-import-slug")).toHaveValue(slug);
    await expect(settings.getByTestId("skill-preview-instructions")).toContainText(
      "<b>plain text</b>",
    );
    await expect(settings.getByTestId("skill-preview-instructions").locator("b")).toHaveCount(0);

    // Nothing was saved before the explicit save press.
    const beforeSaveList = await person.request<{ entries: Array<{ slug: string }> }>(
      "skills.library.list",
      { scope: "mine" },
    );
    expect(beforeSaveList.entries.some((e) => e.slug === slug)).toBe(false);

    // Explicit save: confirmed by the gateway and listed in the library.
    await settings.getByTestId("skill-import-save").click();
    await expect(settings.getByTestId("skill-import-saved")).toContainText(`Saved ${slug}`, {
      timeout: 15_000,
    });
    await expect(settings.getByTestId("skills-list")).toContainText(slug, { timeout: 15_000 });

    const afterSaveList = await person.request<{
      entries: Array<{ skillId: string; slug: string; revision: string; description: string }>;
    }>("skills.library.list", { scope: "mine" });
    const found = afterSaveList.entries.find((e) => e.slug === slug);
    expect(found).toBeDefined();
    expect(found!.description).toBe(description);
    cleanupSkills.push({ skillId: found!.skillId, revision: found!.revision });

    // Existing task's pinned selections and revisions are untouched by the import.
    const afterPins = await person.request<{
      session?: {
        selections: Array<{ skillId: string; slug?: string; revision: string }>;
        attachable: Array<{ skillId: string; slug: string }>;
      };
    }>("skills.library.list", { sessionKey: beforeTask.key });
    const afterSelections = (afterPins.session?.selections ?? []).map((s) => ({
      skillId: s.skillId,
      slug: s.slug,
      revision: s.revision,
    }));
    expect(afterSelections).toEqual(beforeSelections);
    expect(afterPins.session?.attachable.some((s) => s.skillId === found!.skillId)).toBe(true);

    // A task started after the import receives the skill automatically.
    const afterTask = await person.request<{ key: string }>("sessions.create", {
      agentId: "otto",
      label: `After import ${tag}`,
    });
    const newPins = await person.request<{
      session?: { selections: Array<{ skillId: string; revision: string }> };
    }>("skills.library.list", { sessionKey: afterTask.key });
    expect(
      newPins.session?.selections.some(
        (s) => s.skillId === found!.skillId && s.revision === found!.revision,
      ),
    ).toBe(true);

    // Re-importing the same slug shows the gateway's conflict words and preserves the existing skill.
    await settings.getByTestId("skills-file-input").setInputFiles({
      name: "SKILL.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(skillFile + "\nExtra line.\n", "utf8"),
    });
    await expect(settings.getByTestId("skill-import-preview")).toBeVisible();
    await settings.getByTestId("skill-import-save").click();
    await expect(settings.getByTestId("skill-import-conflict")).toContainText(
      `A skill named "${slug}" already exists in this library.`,
      { timeout: 15_000 },
    );
    const stillSame = await person.request<{
      entries: Array<{ skillId: string; revision: string }>;
    }>("skills.library.list", { scope: "mine" });
    expect(stillSame.entries.find((e) => e.skillId === found!.skillId)?.revision).toBe(
      found!.revision,
    );
  } finally {
    try {
      for (const skill of cleanupSkills) {
        await person
          .request("skills.library.mutate", {
            skillId: skill.skillId,
            expectedRevision: skill.revision,
            action: "remove",
          })
          .catch(() => {});
      }
    } finally {
      await person.close();
    }
  }
});
