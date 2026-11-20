// How what a bot hands over behaves (work-pane.md, sections 11 to 14), in the
// fixture: a card opens its item in the pane and Back returns to "Sent in
// chat"; the viewer's keys, focus and sequence; the card's menu and its ways
// in; downloads with identical bytes; the clipboard; the states of an item
// that cannot be opened; and that nothing is fetched from any address but the
// app's own until the person acts.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, SIZES } from "./fixture.ts";
import { ARTIFACTS, card, cardsDrawn, cell, openCard, sent } from "./artifacts-helpers.ts";

test.use(contextFor(SIZES[0]!, "light"));

/**
 * The person's choice to open an address: the system browser in the app, a
 * new tab here. The reserved domains resolve nowhere, so the tab is answered
 * locally, only so its address can be read.
 */
async function answerAway(page: Page) {
  await page
    .context()
    .route(/^https:\/\/(help\.)?library\.example\//, (route) =>
      route.fulfill({ contentType: "text/plain", body: "elsewhere" }),
    );
}

/**
 * Requests to anything but the fixture's own server that left the page: a
 * route sees only what passed the page's own policies. Each is refused, so
 * nothing reaches the network; the reserved domains `answerAway` answers are
 * the person's own choice.
 */
function offsite(page: Page): string[] {
  const seen: string[] = [];
  void page.context().route(
    (url) => url.hostname !== "127.0.0.1" && !/(^|\.)library\.example$/.test(url.hostname),
    (route) => {
      seen.push(route.request().url());
      return route.abort();
    },
  );
  return seen;
}

const announcer = (page: Page) => page.getByTestId("artifact-announcer");
const viewer = (page: Page) => page.getByTestId("media-viewer");

test.describe("cards and the pane", () => {
  test("F-115: a file card names its item, opens it in the pane, and Back returns to Sent in chat", async ({
    page,
  }) => {
    await openFixture(page, ARTIFACTS, "light");
    await cardsDrawn(page);
    await expect(
      card(page, "borrowing-report.md").getByRole("button", {
        name: "borrowing-report.md, Markdown, 142 B. Open in the Work pane.",
      }),
    ).toBeVisible();
    await openCard(page, "borrowing-report.md");
    await expect(
      page.getByTestId("artifact-reader").getByRole("heading", { name: "borrowing-report.md" }),
    ).toBeFocused();
    await expect(page.locator(".reader-meta")).toHaveText("Markdown · 142 B");
    await expect(page.locator(".reader-source")).toContainText("Sent by Juniper at");
    await page.getByRole("tab", { name: "Source" }).click();
    await expect(page.locator(".code-view .lc").first()).toHaveText("# Borrowing e-books");
    // Raw is the record artifacts.get returns: no data, no address.
    await page.getByRole("button", { name: "Raw" }).click();
    const raw = page.getByTestId("artifact-raw");
    await expect(raw).toContainText('"title": "borrowing-report.md"');
    await expect(raw).not.toContainText('"url":');
    await expect(raw).not.toContainText('"data":');
    await page.getByRole("button", { name: "Back to this task's files" }).click();
    const sentIn = page.getByTestId("sent-in-chat");
    await expect(sentIn.getByRole("heading", { name: "Sent in chat" })).toBeVisible();
    // Newest first, from the same list as the cards.
    await expect(sentIn.locator(".file-row").first()).toContainText("voice-note.wav");
    await expect(sentIn.locator(".file-row").last()).toContainText("borrowing-report.md");
    await expect(sentIn.locator('[data-row^="artifact:3:0:"]')).toBeFocused();
  });

  test("F-115: Show in chat closes nothing docked, scrolls to the card and fills it", async ({
    page,
  }) => {
    await openFixture(page, ARTIFACTS, "light");
    await openCard(page, "lending-terms.pdf");
    await page.getByRole("button", { name: "Show lending-terms.pdf in the chat" }).click();
    const target = card(page, "lending-terms.pdf");
    await expect(target).toHaveAttribute("data-flash", "true");
    await expect(target).toBeInViewport();
    await expect(announcer(page)).toHaveText("Showing the item in the chat");
  });

  test("F-307: an item elsewhere is described with Open in your browser and no Download; nothing is fetched from it", async ({
    page,
  }) => {
    const away = offsite(page);
    await answerAway(page);
    await openFixture(page, ARTIFACTS, "light");
    await openCard(page, "lending-faq.pdf");
    await expect(page.getByTestId("artifact-why")).toHaveText(
      "The message names this file by its address. Clawtrate doesn't fetch it; opening it leaves the app, and what is there may have changed since it was sent.",
    );
    // The whole address, before the choice.
    await expect(page.getByTestId("artifact-address")).toHaveText(
      "https://help.library.example/lending-faq.pdf",
    );
    await expect(page.getByRole("button", { name: /^Download/ })).toHaveCount(0);
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      page
        .getByRole("button", {
          name: "Open https://help.library.example/lending-faq.pdf in your browser",
        })
        .click(),
    ]);
    expect(popup.url()).toBe("https://help.library.example/lending-faq.pdf");
    await popup.close();
    // Only the person's own choice went there: nothing before it.
    expect(away).toEqual([]);
  });

  test("F-307: an item with no content says so with no Download; one the device can't draw offers Download", async ({
    page,
  }) => {
    await openFixture(page, ARTIFACTS, "light");
    await openCard(page, "library-card.pkpass");
    await expect(page.getByTestId("artifact-why")).toHaveText(
      "The gateway lists this item, but not its content, so it can't be opened or downloaded here.",
    );
    await expect(page.getByRole("button", { name: /^Download/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Back to this task's files" }).click();
    await page
      .getByTestId("sent-in-chat")
      .getByRole("button", { name: /^lending-terms\.pdf/ })
      .click();
    await expect(page.getByTestId("artifact-why")).toHaveText(
      "There's no preview for this kind of file.",
    );
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download", exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("lending-terms.pdf");
    expect(readFileSync((await download.path())!, "utf8")).toBe(
      "%PDF-1.4\n% A made-up lending terms document\n",
    );
  });

  test("F-307: an item over Clawtrate's limit names that limit as Clawtrate's", async ({
    page,
  }) => {
    await openFixture(page, ARTIFACTS, "light");
    await openCard(page, "app-screens.zip");
    await expect(page.getByTestId("artifact-why")).toHaveText(
      "app-screens.zip is 8.4 MB. Clawtrate opens and saves items up to 5 MB (Clawtrate's limit), so it can't be opened here.",
    );
  });

  test("F-307: a failed load says so with Try again, and a successful retry shows the preview", async ({
    page,
  }) => {
    await openFixture(page, `${ARTIFACTS}&artifactload=failed`, "light");
    await openCard(page, "borrowing-report.md");
    await expect(page.getByTestId("artifact-failed")).toContainText(
      "Couldn't open borrowing-report.md. The gateway's download link expired before it was used.",
    );
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator(".reader-preview")).toContainText("Holds take about nine days.");
    await expect(page.getByTestId("artifact-failed")).toHaveCount(0);
  });

  test("F-115: the gateway's refusal to attach a file is said in the conversation, never offered", async ({
    page,
  }) => {
    await openFixture(page, ARTIFACTS, "light");
    const refused = page.getByTestId("refused-card");
    await expect(refused.getByRole("group")).toHaveAccessibleName(
      "reading-list.csv, not attached. The gateway couldn't attach it.",
    );
    await expect(refused.getByRole("button")).toHaveCount(0);
  });
});

test.describe("the card's menu", () => {
  test("F-118: More, right-click and Shift+F10 open one menu; Download saves the item's bytes under its title", async ({
    page,
  }) => {
    await openFixture(page, ARTIFACTS, "light");
    await cardsDrawn(page);
    const report = card(page, "borrowing-report.md");
    await report.scrollIntoViewIfNeeded();
    await report.getByRole("button", { name: /^borrowing-report/ }).click({ button: "right" });
    const menu = page.getByRole("menu", { name: "borrowing-report.md" });
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Open",
      "Download",
      "Copy text",
      "Show in Files",
      "Download 2 of 5",
    ]);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await report.getByRole("button", { name: /^borrowing-report/ }).focus();
    await page.keyboard.press("Shift+F10");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Open" })).toBeFocused();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      menu.getByRole("menuitem", { name: "Download", exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("borrowing-report.md");
    expect(readFileSync((await download.path())!, "utf8")).toBe(
      "# Borrowing e-books\n\n## Found\n\n- Your library lends through Shelfwise.\n- Holds take about nine days.\n\n## Left\n\n- Renew the card before March.\n",
    );
    await expect(announcer(page)).toHaveText("Downloaded borrowing-report.md");
  });

  test("F-304: Download all saves every on-gateway item of the message and names what it left out", async ({
    page,
  }) => {
    await openFixture(page, ARTIFACTS, "light");
    await cardsDrawn(page);
    await cell(page, "apps-compared.png").click({ button: "right" });
    const menu = page.getByRole("menu", { name: "apps-compared.png" });
    const names: string[] = [];
    page.on("download", (download) => names.push(download.suggestedFilename()));
    await menu.getByRole("menuitem", { name: "Download 5 of 6" }).click();
    await expect(announcer(page)).toHaveText("Downloaded 5 of 6. Not downloaded: cover.jpg");
    expect(names.sort()).toEqual(
      [
        "apps-compared.png",
        "borrowing-walkthrough.webm",
        "cache-growth.png",
        "usage.png",
        "voice-note.wav",
      ].sort(),
    );
  });

  test("F-305 F-306: a picture's menu copies the image to the clipboard and saves it; a video's saves it", async ({
    page,
  }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await openFixture(page, ARTIFACTS, "light");
    await cardsDrawn(page);
    await cell(page, "apps-compared.png").click({ button: "right" });
    let menu = page.getByRole("menu", { name: "apps-compared.png" });
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Open",
      "Download",
      "Copy image",
      "Save image…",
      "Show in Files",
      "Download 5 of 6",
    ]);
    await menu.getByRole("menuitem", { name: "Copy image" }).click();
    await expect(announcer(page)).toHaveText("Copied the image");
    const types = await page.evaluate(async () =>
      (await navigator.clipboard.read()).flatMap((item) => item.types),
    );
    expect(types).toContain("image/png");

    await cell(page, "apps-compared.png").click({ button: "right" });
    menu = page.getByRole("menu", { name: "apps-compared.png" });
    const [picture] = await Promise.all([
      page.waitForEvent("download"),
      menu.getByRole("menuitem", { name: "Save image…" }).click(),
    ]);
    expect(picture.suggestedFilename()).toBe("apps-compared.png");
    const pictureBytes = readFileSync((await picture.path())!);
    expect([...pictureBytes.subarray(0, 4)]).toEqual([137, 80, 78, 71]);

    // The video sits under "+2"; the viewer's right-click offers Save video….
    await cell(page, "usage.png").click();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("viewer-video")).toBeVisible();
    await page.getByTestId("viewer-video").click({ button: "right" });
    const [video] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("menuitem", { name: "Save video…" }).click(),
    ]);
    expect(video.suggestedFilename()).toBe("borrowing-walkthrough.webm");
    const shown = await page
      .getByTestId("viewer-video")
      .evaluate((v: HTMLVideoElement) => v.src.split(",")[1]!);
    expect(readFileSync((await video.path())!).equals(Buffer.from(shown, "base64"))).toBe(true);
  });
});

test.describe("the media viewer", () => {
  test("F-117: it opens on Close, moves with the arrow keys through the message's pictures and video, and Escape returns focus to the picture", async ({
    page,
  }) => {
    await openFixture(page, ARTIFACTS, "light");
    await cardsDrawn(page);
    const opener = cell(page, "apps-compared.png");
    await opener.click();
    await expect(viewer(page)).toHaveAccessibleName("apps-compared.png, 1 of 4");
    await expect(page.getByRole("button", { name: "Close the viewer" })).toBeFocused();
    // The shell beneath is inert while the viewer is open.
    await expect(page.locator(".shell")).toHaveAttribute("inert", "");
    // An item with no content (cover.jpg) is not in the sequence.
    const strip = viewer(page).getByRole("group", { name: "Items" }).getByRole("button");
    await expect(strip).toHaveText(["", "", "", ""]);
    await expect(strip.nth(0)).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("ArrowRight");
    await expect(viewer(page)).toHaveAccessibleName("cache-growth.png, 2 of 4");
    await expect(strip.nth(1)).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(viewer(page)).toHaveAccessibleName("borrowing-walkthrough.webm, 4 of 4");
    await expect(page.getByTestId("viewer-video")).toBeVisible();
    // Tab stays inside.
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press("Tab");
      expect(
        await viewer(page).evaluate((element) => element.contains(document.activeElement)),
      ).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(viewer(page)).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(page.locator(".shell")).not.toHaveAttribute("inert", "");
  });

  test("F-117: a picture switches between fitted and actual size, Download saves it, and the video's speed is kept for the session", async ({
    page,
  }) => {
    await openFixture(page, ARTIFACTS, "light");
    await cardsDrawn(page);
    await cell(page, "usage.png").click();
    const stage = page.locator(".viewer-image");
    await expect(stage).toHaveAttribute("data-zoom", "fit");
    await stage.click();
    await expect(stage).toHaveAttribute("data-zoom", "actual");
    const shown = await page
      .getByTestId("viewer-image")
      .evaluate((img: HTMLImageElement) => img.src.split(",")[1]!);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.keyboard.press("ControlOrMeta+s"),
    ]);
    expect(download.suggestedFilename()).toBe("usage.png");
    expect(readFileSync((await download.path())!).equals(Buffer.from(shown, "base64"))).toBe(true);
    await page.keyboard.press("ArrowRight");
    await page.getByRole("button", { name: "Speed: 1×" }).click();
    const speeds = page.getByRole("menu", { name: "Speed" }).getByRole("menuitemradio");
    await expect(speeds).toHaveText(["0.5×", "1×", "1.5×", "2×"]);
    await page.getByRole("menuitemradio", { name: "1.5×" }).click();
    expect(
      await page.getByTestId("viewer-video").evaluate((v: HTMLVideoElement) => v.playbackRate),
    ).toBe(1.5);
    await page.keyboard.press("Escape");
    await cell(page, "usage.png").click();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("button", { name: "Speed: 1.5×" })).toBeVisible();
  });
});

test.describe("a Page", () => {
  const reads = async (page: Page) => (await sent(page)).filter((c) => c.type === "readPage");

  test("F-115: a Page's card and its Sent in chat row open the Page view, which says pages aren't shown here and reads, parses and frames nothing", async ({
    page,
  }) => {
    const away = offsite(page);
    await openFixture(page, ARTIFACTS, "light");
    await cardsDrawn(page);
    await page.locator(".transcript").hover();
    await page.mouse.wheel(0, -10000);
    // The same Page in a later message: the earlier card says so, and claims no version.
    const cards = page.getByTestId("page-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0).locator(".artifact-sub")).toHaveText("Page · Shown again below");
    await expect(cards.nth(1).locator(".artifact-sub")).toHaveText("Page");
    await expect(page.getByText(/newer version/i)).toHaveCount(0);
    const opener = cards
      .nth(0)
      .getByRole("button", { name: "E-book apps compared, page. Shown again below. Open" });
    await opener.click();
    const view = page.getByTestId("page-view");
    await expect(view).toHaveAccessibleName("E-book apps compared");
    await expect(view.getByRole("button", { name: "Close the page (Esc)" })).toBeFocused();
    await expect(page.getByTestId("page-unavailable")).toHaveText(
      "Clawtrate can't show pages here yet.You can export this page as a file.",
    );
    // Nothing of the Page was read, and nothing is framed: not in the media viewer either.
    await expect(page.locator("iframe")).toHaveCount(0);
    await expect(viewer(page)).toHaveCount(0);
    expect(await reads(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(view).toHaveCount(0);
    await expect(opener).toBeFocused();

    // Sent in chat lists the Page, and its row opens the same view through the same gate.
    await page.getByRole("button", { name: "Show work panel" }).first().click();
    await page.getByRole("tab", { name: "Files" }).click();
    const rows = page.getByTestId("sent-in-chat").getByTestId("sent-page");
    await expect(rows).toHaveCount(2);
    await rows.first().click();
    await expect(page.getByTestId("page-unavailable")).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(await reads(page)).toEqual([]);
    expect(away).toEqual([]);
  });

  test("F-115: Export reads the Page once, for its occurrence, and saves the Clawtrate version with nothing that runs, navigates or loads, or the original", async ({
    page,
  }) => {
    const away = offsite(page);
    await openFixture(page, ARTIFACTS, "light");
    await cardsDrawn(page);
    await page.locator(".transcript").hover();
    await page.mouse.wheel(0, -10000);
    await page.getByTestId("page-card").nth(0).getByRole("button").click();
    expect(await reads(page)).toEqual([]);
    await page.keyboard.press("ControlOrMeta+e");
    const dialog = page.getByRole("dialog", { name: "Export E-book apps compared" });
    await expect(dialog.getByRole("radio")).toHaveCount(2);
    // One read, for this occurrence: the task, its current session, the message and the Page.
    expect(await reads(page)).toEqual([
      {
        type: "readPage",
        key: "agent:main:library-loans",
        sessionId: "main-library-loans",
        itemId: "loans-2",
        docId: "apps-compared",
      },
    ]);
    await dialog.getByRole("radio", { name: /^Clawtrate version/ }).check();
    const [shown] = await Promise.all([
      page.waitForEvent("download"),
      dialog.getByRole("button", { name: "Save…" }).click(),
    ]);
    expect(shown.suggestedFilename()).toBe("E-book apps compared.html");
    const inert = readFileSync((await shown.path())!, "utf8");
    expect(inert).toMatch(
      /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:;/,
    );
    for (const gone of ["<script", "<form", "<a ", "href=", "action=", "src=", "tracker.example"])
      expect(inert, gone).not.toContain(gone);
    // The link's words and the table stay; the button no longer submits anything.
    expect(inert).toContain("the comparison");
    expect(inert).toContain('<button type="button">Sort</button>');
    await expect(announcer(page)).toHaveText("Download started: E-book apps compared.html");

    await page.keyboard.press("ControlOrMeta+e");
    await dialog.getByRole("radio", { name: /^As Juniper made it/ }).check();
    const [original] = await Promise.all([
      page.waitForEvent("download"),
      dialog.getByRole("button", { name: "Save…" }).click(),
    ]);
    expect(readFileSync((await original.path())!, "utf8")).toContain(
      "<script>document.body.dataset.ran='yes'</script>",
    );
    expect(away).toEqual([]);
  });
});

test.describe("nothing remote loads by itself", () => {
  test("F-116 F-117: drawing the task asks no address but the app's own, and a link's preview only after a 500 ms hover", async ({
    page,
  }) => {
    const away = offsite(page);
    await answerAway(page);
    await openFixture(page, ARTIFACTS, "light");
    await cardsDrawn(page);
    await expect(cell(page, "apps-compared.png").locator("img")).toBeVisible();
    // Previews were asked of the host (the gateway's own), and only for on-gateway pictures.
    const previews = (await sent(page)).filter(
      (c) => c.type === "readArtifact" && c.part === "preview",
    );
    expect(previews.map((c) => c.artifactId)).not.toContain("artifact_cover");
    expect((await sent(page)).filter((c) => c.type === "previewLink")).toEqual([]);
    await page.locator(".transcript").hover();
    await page.mouse.wheel(0, -10000);
    const link = page.getByTestId("link-card");
    await expect(link).toBeInViewport();
    await link.getByRole("button").hover();
    await page.waitForTimeout(200);
    expect((await sent(page)).filter((c) => c.type === "previewLink")).toEqual([]);
    await expect(page.getByTestId("link-preview")).toContainText("Library e-books");
    expect((await sent(page)).filter((c) => c.type === "previewLink")).toEqual([
      { type: "previewLink", url: "https://library.example/ebooks" },
    ]);
    // Choosing the card opens the address in the browser; nothing else went out.
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      link.getByRole("button").click(),
    ]);
    expect(popup.url()).toBe("https://library.example/ebooks");
    await popup.close();
    expect(away).toEqual([]);
  });

  test("F-117: a recording plays only when asked, one at a time", async ({ page }) => {
    await openFixture(page, ARTIFACTS, "light");
    await cardsDrawn(page);
    const full = async () =>
      (await sent(page)).filter((c) => c.type === "readArtifact" && c.part === "full").length;
    expect(await full()).toBe(0);
    const play = page.getByRole("button", { name: "Play voice-note.wav" });
    await play.click();
    await expect(page.getByRole("button", { name: "Pause voice-note.wav" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await full()).toBe(1);
  });
});
