// Shared by the Files tab's visual and behaviour checks.
import { expect, type Page } from "@playwright/test";
import { OTTO_DISK } from "./fixture.ts";

/** Otto's disk task with the Work pane open on Files. */
export const FILES = `scene=main&${OTTO_DISK}&panel=open&tab=files`;

/** The Files tab's panel. */
export const filesPanel = (page: Page) => page.locator("#work-tabpanel-files");

/** A row of the task's list, by its file name. */
export const row = (page: Page, name: string) =>
  filesPanel(page).locator(".file-row", { hasText: name }).first();

/** Open a row of the task's list by its file name. */
export async function openRow(page: Page, name: string) {
  await row(page, name).click();
  await expect(page.getByTestId("file-reader")).toBeVisible();
}

/** The task's list has loaded. */
export const listed = (page: Page) =>
  expect(filesPanel(page).getByRole("heading", { name: "Changed" })).toBeVisible();
