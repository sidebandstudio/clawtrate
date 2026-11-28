// Settings → Skills (F-361): importing a local SKILL.md into the gateway skill library.
// Visual baselines for the bounded plain-text preview and the slug conflict in the gateway's
// exact words at desktop (1440 px) and phone (390 px) widths, plus behavioural checks for
// plain-text rendering, invalid files, gateway refusals and saving.

import { test, type Page } from "@playwright/test";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.name === "phone")!;

const NEW_SKILL = [
  "---",
  "name: Harbour Tide Check",
  "description: Use when checking high and low water before leaving harbour.",
  "---",
  "",
  "# Harbour Tide Check",
  "",
  "1. Read the harbour tide table for the requested day.",
  "2. Report high and low water with <strong>exact</strong> local times.",
  "",
].join("\n");

const CONFLICT_SKILL = [
  "---",
  "name: Deploy Checklist",
  "description: Checks release readiness before deploying a build.",
  "---",
  "",
  "Run tests and check logs before deploying.",
  "",
].join("\n");

async function openSkills(page: Page, query: string, theme: "light" | "dark") {
  await openFixture(page, `scene=main&${OTTO_DISK}${query}`, theme);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Skills", level: 3 })).toBeVisible();
  await expect(settings.getByTestId("skills-list")).toBeVisible();
  return settings;
}

async function pickSkillFile(page: Page, content: string, name = "SKILL.md") {
  await page.getByTestId("skills-file-input").setInputFiles({
    name,
    mimeType: "text/markdown",
    buffer: Buffer.from(content, "utf8"),
  });
}

for (const size of [WIDE, PHONE]) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));

      test("F-361: skills-import-preview shows bounded name and instructions as plain text", async ({
        page,
      }) => {
        const settings = await openSkills(page, "&access=write", theme);
        await pickSkillFile(page, NEW_SKILL);
        await expect(settings.getByTestId("skill-import-preview")).toBeVisible();
        await expect(settings.getByTestId("skill-preview-name")).toHaveText("Harbour Tide Check");
        // HTML tags in instructions stay literal plain text, never parsed as markup.
        await expect(settings.getByTestId("skill-preview-instructions")).toContainText(
          "<strong>exact</strong>",
        );
        await expect(
          settings.getByTestId("skill-preview-instructions").locator("strong"),
        ).toHaveCount(0);
        await settle(page);
        await expect(page).toHaveScreenshot(`skills-import-preview-${theme}-${size.name}.png`);
      });

      test("F-361: skills-import-conflict shows the gateway conflict words and keeps the slug editable", async ({
        page,
      }) => {
        const settings = await openSkills(page, "&access=write", theme);
        await pickSkillFile(page, CONFLICT_SKILL);
        await expect(settings.getByTestId("skill-import-slug")).toHaveValue("deploy-checklist");
        await settings.getByTestId("skill-import-save").click();
        await expect(settings.getByTestId("skill-import-conflict")).toContainText(
          'A skill named "deploy-checklist" already exists in this library. Choose a different slug; existing skills were preserved.',
        );
        await settle(page);
        await expect(page).toHaveScreenshot(`skills-import-conflict-${theme}-${size.name}.png`);
      });
    });
  }
}

test.describe("skills import behaviour", () => {
  test.use(contextFor(WIDE, "dark"));

  test("F-361: picking a SKILL.md saves nothing until Save to library is pressed, and changing a conflicted slug saves cleanly", async ({
    page,
  }) => {
    const settings = await openSkills(page, "&access=write", "dark");
    await pickSkillFile(page, CONFLICT_SKILL);
    await expect(settings.getByTestId("skill-import-preview")).toBeVisible();
    // Picking alone sends no import command.
    const sentBefore = await page.evaluate(() => {
      const f = (window as unknown as { clawtrateFixture: { sent: Array<{ type: string }> } })
        .clawtrateFixture;
      return f.sent.filter((c) => c.type === "importLibrarySkill").length;
    });
    expect(sentBefore).toBe(0);

    await settings.getByTestId("skill-import-save").click();
    await expect(settings.getByTestId("skill-import-conflict")).toBeVisible();

    await settings.getByTestId("skill-import-slug").fill("deploy-checklist-v2");
    await settings.getByTestId("skill-import-save").click();
    await expect(settings.getByTestId("skill-import-saved")).toContainText(
      "Saved deploy-checklist-v2",
    );
    await expect(settings.getByTestId("skills-list")).toContainText("deploy-checklist-v2");
  });

  test("F-361: invalid files are refused before reaching the gateway and gateway refusals show in its words", async ({
    page,
  }) => {
    const settings = await openSkills(page, "&access=write&skills=refused", "dark");
    await pickSkillFile(page, "# Missing front matter\nJust text.");
    await expect(settings.getByTestId("skill-import-error")).toContainText(/front matter/i);
    await expect(settings.getByTestId("skill-import-preview")).toHaveCount(0);

    await pickSkillFile(page, NEW_SKILL);
    await settings.getByTestId("skill-import-save").click();
    await expect(settings.getByTestId("skill-import-error")).toContainText(
      "Skill security scan found critical issues.",
    );
  });

  test("F-361: read-only connections list skills without offering import", async ({ page }) => {
    const settings = await openSkills(page, "&access=read", "dark");
    await expect(settings.getByTestId("skills-list")).toContainText("deploy-checklist");
    await expect(settings.getByTestId("skills-import-button")).toHaveCount(0);
    await expect(settings.getByTestId("skills-access-bar")).toContainText(/Write access needed/i);
  });

  test("F-361: fixture keeps attachment ids unique after importing an earlier attachment", async ({
    page,
  }) => {
    await openSkills(page, "&access=write", "dark");
    const result = await page.evaluate(async () => {
      const bridge = (
        window as unknown as {
          clawtrateFixture: {
            getState(): { connection: { gatewayId: string | null; target: number } };
            attach(file: {
              name: string;
              type: string;
              data: ArrayBuffer;
            }): Promise<{ id: string }>;
            invoke(cmd: unknown): Promise<{ outcome: string; entry?: { description: string } }>;
          };
        }
      ).clawtrateFixture;
      const enc = new TextEncoder();
      const skill = (name: string, desc: string) =>
        enc.encode(`---\nname: ${name}\ndescription: ${desc}\n---\n\nRun ${name}.\n`).buffer;
      const { gatewayId, target } = bridge.getState().connection;
      const stamp = { gatewayId, target };

      const first = await bridge.attach({
        name: "first.md",
        type: "text/markdown",
        data: skill("Alpha Skill", "First skill description."),
      });
      const second = await bridge.attach({
        name: "second.md",
        type: "text/markdown",
        data: skill("Beta Skill", "Second skill description."),
      });
      const firstSaved = await bridge.invoke({
        type: "importLibrarySkill",
        slug: "alpha-skill",
        attachmentId: first.id,
        stamp,
      });
      const third = await bridge.attach({
        name: "third.md",
        type: "text/markdown",
        data: skill("Gamma Skill", "Third skill description."),
      });
      const secondSaved = await bridge.invoke({
        type: "importLibrarySkill",
        slug: "beta-skill",
        attachmentId: second.id,
        stamp,
      });
      return {
        firstId: first.id,
        secondId: second.id,
        thirdId: third.id,
        firstOutcome: firstSaved.outcome,
        secondOutcome: secondSaved.outcome,
        secondDescription: secondSaved.entry?.description,
      };
    });
    expect(result.firstId).not.toBe(result.secondId);
    expect(result.thirdId).not.toBe(result.secondId);
    expect(result.firstOutcome).toBe("saved");
    expect(result.secondOutcome).toBe("saved");
    expect(result.secondDescription).toBe("Second skill description.");
  });
});
