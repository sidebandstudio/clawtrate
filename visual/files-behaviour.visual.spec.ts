// The Files tab's behaviour on fixed state (work-pane.md, Part 1; bots.md,
// section 19). Test names carry the parity rows they prove.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES } from "./fixture.ts";
import { FILES, filesPanel, listed, openRow, row } from "./files-helpers.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const DRAWER = SIZES.find((size) => size.name === "1100")!;
const PHONE = SIZES.find((size) => size.phone)!;

type Sent = { type: string; [key: string]: unknown };
const sent = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { clawtrateFixture: { sent: Sent[] } }).clawtrateFixture.sent,
  );

test.describe("the pane's tab bar", () => {
  test.use(contextFor(DRAWER, "light"));

  const bar = (page: Page) => page.getByTestId("work-tabs");
  const tabs = (page: Page) => bar(page).getByRole("tab");

  test("F-152: four tabs that fit the drawer keep their padding, and nothing fades", async ({
    page,
  }) => {
    await openFixture(page, `${FILES}&files=loaded`, "light");
    await expect(tabs(page)).toHaveText(["Details", "Files", "Computer", "Settings"]);
    await expect(bar(page)).toHaveAttribute("data-fit", "normal");
    await expect(bar(page)).not.toHaveAttribute("data-clip", /.*/);
    expect(
      await tabs(page)
        .first()
        .evaluate((tab) => getComputedStyle(tab).paddingLeft),
    ).toBe("14px");
  });

  test("F-152: tabs never wrap or shorten; padding narrows first, then the row scrolls with the chosen tab in view and a fade only at a clipped edge", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}&panel=open&tab=details`, "light");
    const heights = async () => tabs(page).evaluateAll((all) => all.map((tab) => tab.clientHeight));
    const before = await heights();
    // A text size at which narrower padding is enough.
    await page.addStyleTag({ content: ".work-panel .tab { font-size: 17px; }" });
    await expect(bar(page)).toHaveAttribute("data-fit", "narrow");
    expect(
      await tabs(page)
        .first()
        .evaluate((tab) => getComputedStyle(tab).paddingLeft),
    ).toBe("10px");
    await expect(bar(page)).not.toHaveAttribute("data-clip", /.*/);
    // Larger still: the row scrolls; the chosen tab, at the start, leaves only the end clipped.
    await page.addStyleTag({ content: ".work-panel .tab { font-size: 24px; }" });
    await expect(bar(page)).toHaveAttribute("data-fit", "scroll");
    await expect(bar(page)).toHaveAttribute("data-clip", "end");
    // Every word whole and on one line.
    for (const tab of await tabs(page).all()) {
      expect(await tab.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(await tab.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("nowrap");
    }
    expect((await heights()).every((height) => height === before[0])).toBe(true);
    // End moves to Settings and scrolls it into view: only the start is clipped now.
    await tabs(page).first().focus();
    await page.keyboard.press("End");
    await expect(page.getByRole("tab", { name: "Settings" })).toBeFocused();
    await expect(page.getByRole("tab", { name: "Settings" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(bar(page)).toHaveAttribute("data-clip", "start");
    const inView = (name: string) =>
      page.getByRole("tab", { name }).evaluate((tab) => {
        const row = tab.parentElement!.getBoundingClientRect();
        const box = tab.getBoundingClientRect();
        return box.left >= row.left - 1 && box.right <= row.right + 1;
      });
    expect(await inView("Settings")).toBe(true);
    // Left moves back across all four, each kept in view; Home goes to the start.
    for (const name of ["Computer", "Files", "Details"]) {
      await page.keyboard.press("ArrowLeft");
      await expect(page.getByRole("tab", { name })).toBeFocused();
      expect(await inView(name)).toBe(true);
    }
    await page.keyboard.press("End");
    await page.keyboard.press("Home");
    await expect(page.getByRole("tab", { name: "Details" })).toBeFocused();
    await expect(bar(page)).toHaveAttribute("data-clip", "end");
  });

  test("F-152: the chosen tab belongs to the pane: it stays when the task changes and when the pane reopens", async ({
    page,
  }) => {
    await openFixture(page, `${FILES}&files=loaded`, "light");
    await expect(page.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Close work panel" }).last().click();
    await page.getByRole("button", { name: "Show work panel" }).click();
    await expect(page.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("the Files tab", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-152: the task's changed and read files, newest first, then the workspace", async ({
    page,
  }) => {
    await openFixture(page, `${FILES}&files=loaded`, "light");
    await listed(page);
    const changed = filesPanel(page).getByRole("list", { name: "Changed" }).locator(".file-name");
    await expect(changed).toHaveText(["usage.png", "disk-2026-11-16.md", "media-box.md"]);
    const read = filesPanel(page).getByRole("list", { name: "Read" }).locator(".file-name");
    await expect(read.first()).toHaveText("transcode.log");
    await expect(filesPanel(page).locator(".file-row").last()).toContainText("Otto's workspace");
    await expect(row(page, "disk-2026-11-16.md")).toHaveAccessibleName(
      /^disk-2026-11-16\.md, in notes, 293 B, changed .+, changed last run$/,
    );
  });

  test("F-152: past 12 files a filter narrows the files listed, and says it cannot reach those that didn't fit", async ({
    page,
  }) => {
    await openFixture(page, `${FILES}&files=many`, "light");
    await listed(page);
    const note = filesPanel(page).locator(".files-note");
    await expect(note).toHaveText(
      "7 more of this task's files didn't fit here. The filter searches only the files listed above.",
    );
    await filesPanel(page)
      .getByRole("searchbox", { name: "Filter this task's files by name" })
      .fill("rotate-0");
    await expect(
      filesPanel(page).getByRole("list", { name: "Read" }).locator(".file-name"),
    ).toHaveCount(9);
  });

  test("F-321: changed last run on what the run's file tools changed, writing while a write runs, and nothing on a read", async ({
    page,
  }) => {
    await openFixture(page, `${FILES}&files=loaded`, "light");
    await expect(row(page, "disk-2026-11-16.md").locator('[data-mark="last-run"]')).toHaveText(
      / · Changed last run$/,
    );
    await expect(row(page, "AGENTS.md").locator("[data-mark]")).toHaveCount(0);
    await expect(row(page, "media-box.md").locator("[data-mark]")).toHaveCount(0);
    await openFixture(page, `${FILES}&files=writing`, "light");
    await expect(row(page, "disk-2026-11-16.md")).toHaveAccessibleName(
      "disk-2026-11-16.md, Otto is writing it",
    );
    // A file that does not exist yet is at the top of Changed while it is written.
    await expect(
      filesPanel(page).getByRole("list", { name: "Changed" }).locator(".file-name").first(),
    ).toHaveText("cleanup-plan.md");
  });

  test("F-448: a file tool's result fetches the list again, once, 600 ms after the last; an open file says it is being written", async ({
    page,
  }) => {
    await openFixture(page, `${FILES}&files=writing`, "light");
    await listed(page);
    await openRow(page, "disk-2026-11-16.md");
    await expect(page.getByTestId("reader-writing")).toContainText(
      "Otto is writing this file. It updates when the write finishes.",
    );
    const lists = async () => (await sent(page)).filter((c) => c.type === "listTaskFiles").length;
    const reads = async () => (await sent(page)).filter((c) => c.type === "readTaskFile").length;
    const listsBefore = await lists();
    const readsBefore = await reads();
    // Both running writes finish at once.
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState(change: (state: never) => unknown): void };
        }
      ).clawtrateFixture;
      fixture.setState(((state: {
        transcripts: Record<string, { runs: { steps: { status: string; endedAt: number }[] }[] }>;
      }) => {
        const key = "agent:otto:disk-space";
        const transcript = state.transcripts[key]!;
        return {
          ...state,
          transcripts: {
            ...state.transcripts,
            [key]: {
              ...transcript,
              runs: transcript.runs.map((run) => ({
                ...run,
                steps: run.steps.map((step) =>
                  step.status === "running"
                    ? {
                        ...step,
                        status: "done",
                        endedAt: Date.now(),
                        files: { ...(step as never as { files: object }).files, changed: true },
                      }
                    : step,
                ),
              })),
            },
          },
        };
      }) as never);
    });
    await expect(page.getByTestId("reader-writing")).toHaveCount(0);
    // The open file is read again when its write lands.
    await expect.poll(reads).toBe(readsBefore + 1);
    // What the write made replaces the open preview in place, and says so.
    await expect(page.locator(".reader-preview")).toContainText(
      "Checked again at 5:39 PM: still 61%.",
    );
    await expect(page.getByTestId("reader-note")).toHaveText("Updated just now");
    await expect(page.getByTestId("work-announcer")).toHaveText("disk-2026-11-16.md updated");
    // The list is fetched once, after the burst.
    await page.getByRole("button", { name: "Back to this task's files" }).click();
    await expect.poll(lists, { timeout: 3000 }).toBeGreaterThan(listsBefore);
    await page.waitForTimeout(800);
    expect((await lists()) - listsBefore).toBeLessThanOrEqual(2);
  });

  test("F-448: a write the list does not have yet is fetched again after each history read, until the list shows it", async ({
    page,
  }) => {
    await openFixture(page, `${FILES}&files=loaded`, "light");
    await listed(page);
    // The gateway lists a file from its stored transcript: until it has stored the write, its
    // list does not name the file.
    await page.evaluate(() => {
      type Fixture = { invoke: (command: { type: string }) => Promise<unknown> };
      const w = window as unknown as { clawtrateFixture: Fixture; stored: boolean };
      w.stored = false;
      const invoke = w.clawtrateFixture.invoke.bind(w.clawtrateFixture);
      w.clawtrateFixture.invoke = async (command) => {
        const answer = await invoke(command);
        if (command.type !== "listTaskFiles" || !w.stored) return answer;
        const list = answer as { files: Array<Record<string, unknown>> };
        const file = {
          path: "notes/new-plan.md",
          workspacePath: "notes/new-plan.md",
          name: "new-plan.md",
          kind: "modified",
          missing: false,
          size: 120,
          updatedAt: Date.now(),
        };
        return { ...list, files: [file, ...list.files] };
      };
    });
    const lists = async () => (await sent(page)).filter((c) => c.type === "listTaskFiles").length;
    type State = {
      transcripts: Record<
        string,
        { loadedAt: number | null; runs: Array<{ steps: Array<Record<string, unknown>> }> }
      >;
    };
    const change = (fn: (state: State) => State) =>
      page.evaluate((source) => {
        const fixture = (
          window as unknown as {
            clawtrateFixture: { setState(change: (state: never) => unknown): void };
          }
        ).clawtrateFixture;
        fixture.setState(new Function("state", `return (${source})(state)`) as never);
      }, fn.toString());
    // A write lands in the open task.
    const before = await lists();
    await change((state) => {
      const key = "agent:otto:disk-space";
      const transcript = state.transcripts[key]!;
      const runs = transcript.runs.map((run, index) => {
        if (index !== transcript.runs.length - 1) return run;
        const model = transcript.runs.flatMap((each) => each.steps).find((each) => each.files)!;
        const written = {
          ...model,
          id: "tool:new-plan",
          toolCallId: "new-plan",
          toolName: "write",
          status: "done",
          endedAt: Date.now(),
          files: { paths: ["notes/new-plan.md"], changed: true, created: true },
        };
        return { ...run, steps: [...run.steps, written] };
      });
      return { ...state, transcripts: { ...state.transcripts, [key]: { ...transcript, runs } } };
    });
    // Fetched once after the result, before the gateway stored it: not listed.
    await expect.poll(lists).toBe(before + 1);
    await page.waitForTimeout(800);
    await expect(row(page, "new-plan.md")).toHaveCount(0);
    // The gateway stores it, and the task's history is read again: the list is fetched again.
    await page.evaluate(() => ((window as unknown as { stored: boolean }).stored = true));
    const bump = () =>
      change((state) => {
        const key = "agent:otto:disk-space";
        const transcript = state.transcripts[key]!;
        return {
          ...state,
          transcripts: {
            ...state.transcripts,
            [key]: { ...transcript, loadedAt: (transcript.loadedAt ?? 0) + 1 },
          },
        };
      });
    await bump();
    await expect(row(page, "new-plan.md")).toBeVisible();
    expect(await lists()).toBe(before + 2);
    // Listed now: a later history read fetches nothing.
    await bump();
    await page.waitForTimeout(800);
    expect(await lists()).toBe(before + 2);
  });

  test("F-448: when commands ran since the list was checked, the tab says so; a refresh shows what they changed", async ({
    page,
  }) => {
    await openFixture(page, `${FILES}&files=commands`, "light");
    const fresh = page.getByTestId("files-fresh");
    await expect(fresh).toContainText(
      "Otto ran commands since then. A refresh shows what they changed in the files listed here; a file only a command created isn't listed here, but is in Otto's workspace.",
    );
    await page.getByRole("button", { name: "Refresh the file list" }).click();
    // What the command did to a listed file, once the list is fetched again.
    await expect(row(page, "media-box.md")).toHaveAccessibleName(/, missing$/);
    await expect(row(page, "media-box.md").locator("em")).toHaveText(" · Missing");
    // The notice goes when the list is fetched.
    await expect(fresh).not.toContainText("ran commands");
  });

  test("F-320: a failed listing shows its reason and Try again; a successful retry shows the list", async ({
    page,
  }) => {
    await openFixture(page, `${FILES}&files=error`, "light");
    const failed = page.getByTestId("files-failed");
    await expect(failed).toContainText("Couldn't load this task's files");
    await expect(failed).toContainText("The gateway did not answer in time.");
    await failed.getByRole("button", { name: "Try again" }).click();
    await listed(page);
    await expect(failed).toHaveCount(0);
  });

  test("F-320: a failed listing is fetched again by itself after the task's history is read again", async ({
    page,
  }) => {
    await openFixture(page, `${FILES}&files=error`, "light");
    await expect(page.getByTestId("files-failed")).toContainText("Couldn't load this task's files");
    // The task's history is read again: the gateway stored more of it.
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState(change: (state: never) => unknown): void };
        }
      ).clawtrateFixture;
      fixture.setState(((state: { transcripts: Record<string, { loadedAt: number | null }> }) => {
        const key = "agent:otto:disk-space";
        const transcript = state.transcripts[key]!;
        return {
          ...state,
          transcripts: {
            ...state.transcripts,
            [key]: { ...transcript, loadedAt: (transcript.loadedAt ?? 0) + 1 },
          },
        };
      }) as never);
    });
    await listed(page);
    await expect(page.getByTestId("files-failed")).toHaveCount(0);
  });

  test("F-320: a failed refresh keeps the list with a line above it", async ({ page }) => {
    await openFixture(page, `${FILES}&files=stale`, "light");
    await listed(page);
    await page.getByRole("button", { name: "Refresh the file list" }).click();
    await expect(page.getByTestId("files-stale")).toContainText(
      /^Couldn't refresh\. Showing the list from .+\.Try again$/,
    );
    await expect(row(page, "usage.png")).toBeVisible();
  });

  test("F-320: a failed preview shows the error and Try again; a successful retry shows the preview", async ({
    page,
  }) => {
    await openFixture(page, `${FILES}&files=loaded&fileload=failed`, "light");
    await listed(page);
    await openRow(page, "media-box.md");
    const failed = page.getByTestId("reader-failed");
    await expect(failed).toContainText(
      "Couldn't open media-box.md. The gateway did not answer in time.",
    );
    await failed.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator(".reader-preview")).toContainText("Watch disk use.");
    await expect(failed).toHaveCount(0);
  });

  test("F-449: a file no reader sends shows its facts and the limit it met, and offers no Download", async ({
    page,
  }) => {
    await openFixture(page, `${FILES}&files=loaded`, "light");
    await openRow(page, "transcode.log");
    const cannot = page.getByTestId("reader-cannot");
    await expect(cannot.locator("dt")).toHaveText(["Name", "Size", "Modified", "Folder"]);
    await expect(cannot.locator("dd").nth(1)).toHaveText("3.4 MB");
    await expect(cannot).toContainText(
      "transcode.log is 3.4 MB. The gateway's file readers send text up to 256 KB, so it can't be shown or downloaded here.",
    );
    await expect(page.getByRole("button", { name: /^Download/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Back to this task's files" }).click();
    await openRow(page, "receipts.pdf");
    await expect(page.getByTestId("reader-cannot")).toContainText("application/pdf");
    await expect(page.getByTestId("reader-cannot")).toContainText(
      "receipts.pdf isn't text or media. None of the gateway's file readers sends files like this, so it can't be shown or downloaded here.",
    );
    await expect(page.getByRole("button", { name: /^Download/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Back to this task's files" }).click();
    await openRow(page, "cache-walkthrough.mp4");
    await expect(page.getByTestId("reader-cannot")).toContainText(
      "cache-walkthrough.mp4 is 14 MB. The gateway sends recordings and videos from a task's folder up to 1 MB, so it can't be played or downloaded here.",
    );
  });

  test("F-449: a picture that arrived but this device can't display says so, apart from what can't be fetched, and keeps Download", async ({
    page,
  }) => {
    await openFixture(page, `${FILES}&files=loaded`, "light");
    await openRow(page, "scan.heic");
    await expect(page.getByTestId("reader-unrendered")).toHaveText(
      "scan.heic arrived from the gateway, but this device can't display this picture. It is image/heic, 2 KB; Download saves it as it is.",
    );
    await expect(page.getByTestId("reader-cannot")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Download scan.heic" })).toBeVisible();
  });

  test("F-449: in a repository-backed task a video says the repository sends only text and pictures", async ({
    page,
  }) => {
    await openFixture(page, `${FILES}&files=repo`, "light");
    await openRow(page, "cache-walkthrough.mp4");
    await expect(page.getByTestId("reader-cannot")).toContainText(
      "This task works in a repository the gateway keeps. The gateway sends only text and pictures from it, so cache-walkthrough.mp4 can't be played or downloaded here.",
    );
  });

  test("F-319: Download saves exactly the bytes the reader supplied, under the file's name", async ({
    page,
  }) => {
    await openFixture(page, `${FILES}&files=loaded`, "light");
    await openRow(page, "usage.png");
    const shown = await page
      .locator(".reader-image img")
      .evaluate((img: HTMLImageElement) => img.src.split(",")[1]!);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download usage.png" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("usage.png");
    const saved = readFileSync((await download.path())!);
    expect(saved.equals(Buffer.from(shown, "base64"))).toBe(true);
    await expect(page.getByTestId("work-announcer")).toHaveText("Downloaded usage.png");

    await page.getByRole("button", { name: "Back to this task's files" }).click();
    await openRow(page, "media-box.md");
    await page.getByRole("tab", { name: "Source" }).click();
    const text = await page.locator(".code-view .lc").allTextContents();
    const [second] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download media-box.md" }).click(),
    ]);
    expect(second.suggestedFilename()).toBe("media-box.md");
    expect(readFileSync((await second.path())!, "utf8")).toBe(`${text.join("\n")}\n`);
  });

  test("F-152: a recording and a video the task's asset reader supplies play in the pane", async ({
    page,
  }) => {
    await openFixture(page, `${FILES}&files=loaded`, "light");
    await openRow(page, "voice-memo.wav");
    const audio = page.locator("audio.reader-audio");
    await expect(audio).toHaveAttribute("controls", "");
    expect(
      await audio.evaluate(
        (el: HTMLAudioElement) =>
          new Promise<number>((resolve, reject) => {
            if (el.readyState >= 1) resolve(el.duration);
            el.addEventListener("loadedmetadata", () => resolve(el.duration), { once: true });
            el.addEventListener("error", () => reject(new Error("the recording did not load")), {
              once: true,
            });
          }),
      ),
    ).toBeCloseTo(0.5, 1);
    await page.getByRole("button", { name: "Back to this task's files" }).click();
    await openRow(page, "rack-clip.webm");
    const video = page.locator("video.reader-video");
    const size = await video.evaluate(
      (el: HTMLVideoElement) =>
        new Promise<[number, number]>((resolve, reject) => {
          const done = () => resolve([el.videoWidth, el.duration]);
          if (el.readyState >= 1) done();
          el.addEventListener("loadedmetadata", done, { once: true });
          el.addEventListener("error", () => reject(new Error("the video did not load")), {
            once: true,
          });
        }),
    );
    expect(size[0]).toBe(64);
    expect(size[1]).toBeGreaterThan(0);
    // Download is offered for content the reader supplied.
    await expect(page.getByRole("button", { name: "Download rack-clip.webm" })).toBeVisible();
  });

  test("F-152: markdown opens on Preview, and the views switch with the arrow keys", async ({
    page,
  }) => {
    await openFixture(page, `${FILES}&files=loaded`, "light");
    await openRow(page, "disk-2026-11-16.md");
    await expect(page.getByRole("tab", { name: "Preview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByRole("tab", { name: "Preview" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Source" })).toBeFocused();
    await expect(page.locator(".code-view .ln").first()).toHaveText("1");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("changes")).toContainText("2 changes in this task");
  });

  test("F-152: the comparison is labelled by what it is compared against", async ({ page }) => {
    await openFixture(page, `${FILES}&files=loaded&checkout=1`, "light");
    await openRow(page, "disk-2026-11-16.md");
    await page.getByRole("tab", { name: "Changes" }).click();
    await expect(page.getByTestId("checkout-label")).toHaveText("Compared with main · +10 −0");
    await expect(page.getByTestId("changes")).toContainText(
      "In this checkout. This can include changes made before this task.",
    );
    await expect(page.getByTestId("changes").locator(".change-group")).toHaveText([
      "This task's changes",
      "In the checkout",
    ]);
    // Each added line carries its sign, so colour is never the only cue.
    await expect(page.locator('.diff-line[data-kind="add"] .sign').first()).toHaveText("+");
  });

  test("F-446: the workspace one folder at a time, folders first, sorted by name or modified time, with more pages", async ({
    page,
  }) => {
    await openFixture(page, `${FILES}&files=loaded`, "light");
    await listed(page);
    await filesPanel(page).locator(".file-row", { hasText: "Otto's workspace" }).click();
    await expect(page.getByRole("heading", { name: "Otto's workspace" })).toBeFocused();
    const names = filesPanel(page).locator(".file-list .file-name");
    await expect(names).toHaveText(["charts", "logs", "notes", "AGENTS.md", "inventory.md"]);
    await page.getByRole("button", { name: /^Sort:/ }).click();
    await page.getByRole("menuitemradio", { name: "Modified, newest first" }).click();
    await expect(names).toHaveText(["charts", "notes", "logs", "AGENTS.md", "inventory.md"]);
    await filesPanel(page).locator(".file-row", { hasText: "logs" }).first().click();
    await expect(page.getByRole("heading", { name: "logs" })).toBeFocused();
    await expect(filesPanel(page).locator(".files-path")).toContainText(
      "300 items · Sorted by modified time among the 250 loaded.",
    );
    const more = filesPanel(page).getByRole("button", { name: "Show 50 more · 250 of 300" });
    await more.click();
    await expect(filesPanel(page).locator(".file-list .file-row:not(.files-more)")).toHaveCount(
      300,
    );
    // Back returns to the folder above with the row that was opened focused.
    await page.getByRole("button", { name: "Back to the workspace" }).click();
    await expect(filesPanel(page).locator('[data-row="folder:logs"]')).toBeFocused();
  });

  test("F-152: rows move with Up, Down, Home and End; Enter opens; Escape goes Back while docked; ⌘[ goes Back", async ({
    page,
  }) => {
    await openFixture(page, `${FILES}&files=loaded`, "light");
    await listed(page);
    await row(page, "usage.png").focus();
    await page.keyboard.press("ArrowDown");
    await expect(row(page, "disk-2026-11-16.md")).toBeFocused();
    await page.keyboard.press("End");
    await expect(row(page, "inventory.md")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(row(page, "usage.png")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "disk-2026-11-16.md" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(row(page, "disk-2026-11-16.md")).toBeFocused();
    await expect(page.getByTestId("work-panel")).toBeVisible();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+BracketLeft");
    await expect(row(page, "disk-2026-11-16.md")).toBeFocused();
  });
});

test.describe("from a step to its file, and back", () => {
  test("F-447: Show in chat, docked: the conversation reaches the step, opens its fold and the step, and focuses it; the pane stays on the file", async ({
    page,
  }) => {
    await page.setViewportSize({ width: WIDE.width, height: WIDE.height });
    await openFixture(page, `${FILES}&files=loaded`, "light");
    await openRow(page, "disk-2026-11-16.md");
    await expect(page.locator(".reader-source")).toContainText("Written by Otto");
    await page.locator(".reader-source").getByRole("button", { name: "Show in chat" }).click();
    const step = page.locator('[data-call-id="c6"]');
    await expect(step).toHaveAttribute("open", "");
    await expect(step.locator("summary")).toBeFocused();
    await expect(step).toBeInViewport();
    await expect(page.getByTestId("file-reader")).toBeVisible();
    await expect(page.getByTestId("chat-link-announcer")).toHaveText(
      "Showing the step in the chat",
    );
  });

  test("F-447: a file with no source in the task says so, with no link", async ({ page }) => {
    await page.setViewportSize({ width: WIDE.width, height: WIDE.height });
    await openFixture(page, `${FILES}&files=loaded`, "light");
    await openRow(page, "usage.png");
    await expect(page.locator('.reader-source[data-none="true"]')).toHaveText(
      "No source in this task",
    );
    await expect(page.locator(".reader-source").getByRole("button")).toHaveCount(0);
  });

  test("F-152: Open file on a write step opens Files on the file's Changes, and focus goes to its name", async ({
    page,
  }) => {
    await page.setViewportSize({ width: WIDE.width, height: WIDE.height });
    await openFixture(
      page,
      `scene=main&${OTTO_DISK}&panel=closed&tab=details&files=loaded`,
      "light",
    );
    const step = page.locator('[data-call-id="c6"]');
    await step
      .locator("xpath=ancestor::details[contains(@class,'steps')]")
      .locator("summary")
      .first()
      .click();
    await step.locator("summary").click();
    await step.getByRole("button", { name: "Open disk-2026-11-16.md in the Work pane" }).click();
    await expect(page.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "disk-2026-11-16.md" })).toBeFocused();
    await expect(page.getByRole("tab", { name: "Changes" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("F-447: Show in chat as a drawer closes the pane, keeps its place, and Back to the file reopens it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: DRAWER.width, height: DRAWER.height });
    await openFixture(page, `${FILES}&files=loaded`, "light");
    await expect(page.getByTestId("work-panel")).toHaveAttribute("role", "dialog");
    await openRow(page, "disk-2026-11-16.md");
    await page.locator(".reader-source").getByRole("button", { name: "Show in chat" }).click();
    await expect(page.locator(".shell")).toHaveAttribute("data-panel", "closed");
    const step = page.locator('[data-call-id="c6"]');
    await expect(step.locator("summary")).toBeFocused();
    await step.getByRole("button", { name: "Back to disk-2026-11-16.md" }).click();
    await expect(page.locator(".shell")).toHaveAttribute("data-panel", "open");
    await expect(page.getByTestId("file-reader")).toContainText("disk-2026-11-16.md");
  });

  test("F-152: the drawer keeps focus inside it and Escape closes it, even from inside Files", async ({
    page,
  }) => {
    await page.setViewportSize({ width: DRAWER.width, height: DRAWER.height });
    await openFixture(page, `${FILES}&files=loaded`, "light");
    await openRow(page, "media-box.md");
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest(".work-panel"))).toBe(
        true,
      );
    }
    await page.keyboard.press("Escape");
    await expect(page.locator(".shell")).toHaveAttribute("data-panel", "closed");
  });
});

test.describe("on a phone", () => {
  test.use(contextFor(PHONE, "light"));

  test("F-152: the pane is a full-width sheet; a file opens in it and Back returns to the list", async ({
    page,
  }) => {
    await openFixture(page, `${FILES}&files=loaded`, "light");
    const work = page.getByTestId("work-panel");
    await expect(work).toHaveAttribute("role", "dialog");
    const box = (await work.boundingBox())!;
    expect(box.width).toBe(PHONE.width);
    await openRow(page, "disk-2026-11-16.md");
    await expect(page.getByRole("heading", { name: "disk-2026-11-16.md" })).toBeFocused();
    await page.getByRole("button", { name: "Back to this task's files" }).click();
    await expect(row(page, "disk-2026-11-16.md")).toBeFocused();
    // The rows take touch sizes.
    expect((await row(page, "usage.png").boundingBox())!.height).toBeGreaterThanOrEqual(56);
    await settle(page);
  });
});
