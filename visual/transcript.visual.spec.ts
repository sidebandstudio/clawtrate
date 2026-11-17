// Parity rows for reading a transcript: the task's header, stamps, bubbles,
// markdown and wide tables, progress narration, and find.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PIP_WEEK = "bot=pip&task=agent:pip:week";
const JUNIPER_EBOOKS = "bot=main&task=agent:main:ebook-apps";

const rect = async (locator: Locator) => (await locator.boundingBox())!;
const style = (locator: Locator, property: string) =>
  locator.evaluate((el, name) => getComputedStyle(el).getPropertyValue(name), property);

/** A colour token, resolved the way the browser resolves a colour. */
const tokenColor = (page: Page, token: string) =>
  page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.querySelector(".transcript")!.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);

const atTop = (page: Page) =>
  page.locator(".transcript").evaluate((el) => {
    el.scrollTop = 0;
  });

test.use(contextFor(WIDE, "light"));

test("F-059: the task's header shows context use as tokens used out of the window, or Context: unavailable", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
  await atTop(page);
  const context = page.getByTestId("task-context");
  await expect(context).toHaveText("Context: 18,432 of 128,000 tokens");
  // It sits right under the task's name, at the top of the conversation.
  const title = await rect(page.getByRole("heading", { level: 1 }));
  const line = await rect(context);
  expect(line.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
  expect(line.y - (title.y + title.height)).toBeLessThan(8);
  // After a run the gateway reports a new count, and the header follows it.
  await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: {
          setState(
            f: (s: {
              tasksByBot: Record<string, Array<{ key: string; context?: unknown }>>;
            }) => unknown,
          ): void;
        };
      }
    ).clawtrateFixture;
    fixture.setState((state) => ({
      ...state,
      tasksByBot: {
        ...state.tasksByBot,
        otto: state.tasksByBot.otto!.map((t) =>
          t.key === "agent:otto:disk-space"
            ? { ...t, context: { used: 21_050, window: 128_000, fresh: true } }
            : t,
        ),
      },
    }));
  });
  await expect(context).toHaveText("Context: 21,050 of 128,000 tokens");
  // Marlow's gateway reports none.
  await page
    .getByTestId("bot-list")
    .getByRole("button", { name: /^Marlow\b/ })
    .click();
  await expect(page.getByTestId("task-context")).toHaveText("Context: unavailable");
});

test("F-063: centred grey stamps separate blocks: before the first message and after ten quiet minutes or a new day", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
  const stamps = page.locator(".transcript .stamp");
  // Yesterday's exchange, then today's, then a message more than ten minutes later.
  await expect(stamps).toHaveText(["Yesterday 2:40 PM", "Today 5:31 PM"]);
  const column = await rect(page.locator(".transcript-inner"));
  for (const stamp of await stamps.all()) {
    const box = await rect(stamp);
    expect(await style(stamp, "text-align")).toBe("center");
    expect(await style(stamp, "font-size")).toBe("12px");
    expect(await style(stamp, "color")).toBe(await tokenColor(page, "--text-faint"));
    expect(Math.abs(box.x + box.width / 2 - (column.x + column.width / 2))).toBeLessThanOrEqual(1);
  }
  // No time beside a message; its exact time is its tooltip.
  await expect(page.locator(".turn time")).toHaveCount(0);
  await expect(page.locator(".msg .bubble").first()).toHaveAttribute("title", /\d:\d\d/);
});

test("F-064: your messages are right-aligned round bubbles in the accent, and the appearance choice turns them neutral", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
  const bubble = page.locator('.msg[data-role="user"] .bubble').last();
  const column = await rect(page.locator(".transcript-inner"));
  const box = await rect(bubble);
  // Right-aligned with the column's padding, and rounded on every corner.
  expect(Math.abs(column.x + column.width - 20 - (box.x + box.width))).toBeLessThanOrEqual(1);
  expect(await style(bubble, "border-radius")).toBe("18px");
  const fill = () => style(bubble, "background-color");
  expect(await fill()).toBe(
    await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--accent)";
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    }),
  );
  await page
    .getByRole("button", { name: /Open the gateway menu\.$/ })
    .last()
    .click();
  await expect(page.getByRole("menu", { name: "Gateway" })).toContainText("Your messages");
  await page.getByRole("menuitemradio", { name: "Neutral" }).click();
  // Neutral is the inverse fill: black with white text in the light theme.
  expect(await fill()).toBe("rgb(17, 18, 19)");
  expect(await style(bubble, "color")).toBe("rgb(255, 255, 255)");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-bubbles", "neutral");
  expect(
    await style(page.locator('.msg[data-role="user"] .bubble').last(), "background-color"),
  ).toBe("rgb(17, 18, 19)");
  await page
    .getByRole("button", { name: /Open the gateway menu\.$/ })
    .last()
    .click();
  await page.getByRole("menuitemradio", { name: "Accent" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-bubbles");
});

test("F-065: the bot's messages are left grey bubbles stacked with small gaps, no avatar, markdown with tables, and a wide table extends beside the message", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${PIP_WEEK}`, "light");
  await atTop(page);
  const column = await rect(page.locator(".transcript-inner"));
  const bubbles = page.locator('.msg[data-role="assistant"] .bubble');
  await expect(bubbles).toHaveCount(4);
  for (const bubble of await bubbles.all()) {
    const box = await rect(bubble);
    expect(Math.abs(box.x - (column.x + 20))).toBeLessThanOrEqual(1);
    expect(await style(bubble, "background-color")).toBe(
      await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--bg-bubble)";
        document.body.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      }),
    );
  }
  // Two messages in a row from the bot: a small gap, 4 px.
  const third = await rect(bubbles.nth(2));
  const fourth = await rect(bubbles.nth(3));
  expect(Math.round(fourth.y - (third.y + third.height))).toBe(4);
  // No avatar or name beside a message in a one-to-one conversation.
  await expect(page.locator(".transcript .avatar")).toHaveCount(0);
  await expect(page.locator(".transcript")).not.toContainText("Pip:");
  // Markdown tables render, with header cells.
  const table = bubbles.nth(3).locator("table");
  await expect(table.locator("th")).toHaveCount(8);
  await expect(table.locator("tbody tr")).toHaveCount(3);
  // The wide table takes the room beside the message: its bubble is wider
  // than a bubble of text may be, up to the column, and the text keeps its measure.
  const wide = await rect(bubbles.nth(3));
  expect(wide.width).toBeGreaterThan(640);
  expect(wide.x + wide.width).toBeLessThanOrEqual(column.x + column.width - 20 + 1);
  const paragraph = await rect(bubbles.nth(3).locator("p"));
  expect(paragraph.width).toBeLessThanOrEqual(612);
  // A table of three short columns stays within an ordinary bubble.
  await page
    .getByTestId("bot-list")
    .getByRole("button", { name: /^Otto\b/ })
    .click();
  await page.getByRole("list", { name: "Otto's tasks" }).getByText("Disk almost full").click();
  const disk = page
    .locator('.msg[data-role="assistant"] .bubble')
    .filter({ has: page.locator("table") });
  expect((await rect(disk)).width).toBeLessThanOrEqual(640);
});

test("F-065: markdown renders inside the bot's bubble: bold, emphasis, links, inline code, headings, lists and code blocks", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${JUNIPER_EBOOKS}`, "light");
  const reply = page.locator('.msg[data-role="assistant"] .bubble').last();
  await expect(reply.locator("strong")).toHaveText("Libby by OverDrive");
  expect(Number(await style(reply.locator("strong"), "font-weight"))).toBeGreaterThan(
    Number(await style(reply.locator("p").first(), "font-weight")),
  );
  await expect(reply.locator("em")).toHaveText("the easiest of the three");
  expect(await style(reply.locator("em"), "font-style")).toBe("italic");
  const link = reply.getByRole("link", { name: "the library's help page" });
  await expect(link).toHaveAttribute("href", "https://example.org/library/help");
  // Links leave the app.
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(reply.locator("code")).toHaveText("Add a library");
  expect(await style(reply.locator("code"), "font-family")).toMatch(/mono/i);
  // No markdown syntax is left showing.
  await expect(reply).not.toContainText("**");
  await expect(reply).not.toContainText("](");
  await expect(reply).not.toContainText("`");

  // Otto's report: headings, a numbered and a bulleted list, and a code block.
  await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
  const bubbles = page.locator('.msg[data-role="assistant"] .bubble');
  await expect(bubbles.locator("h3")).toHaveText(["Found", "Changed", "Left"]);
  await expect(bubbles.locator("ol > li")).toHaveCount(3);
  await expect(bubbles.locator("ul > li")).toHaveCount(2);
  await expect(bubbles.locator("pre code")).toHaveText(
    "mv /var/lib/transcode-cache.old /var/lib/transcode-cache",
  );
});

test("F-065: on a narrow column a wide table scrolls inside its bubble", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixture(page, `scene=main&${PIP_WEEK}`, "light");
  const wrap = page.locator(".table-wrap");
  const sizes = await wrap.evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(sizes[0]).toBeGreaterThan(sizes[1]!);
  const bubble = await rect(page.locator(".bubble").filter({ has: wrap }));
  expect(bubble.x + bubble.width).toBeLessThanOrEqual(390);
});

test("F-088: the bot's progress narration shows as short separate bubbles, in order, with its tool calls folded between", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${PIP_WEEK}`, "light");
  await atTop(page);
  const turn = page.getByTestId("transcript-turn").nth(1);
  const parts = await turn
    .locator(":scope > .msg, :scope > .steps")
    .evaluateAll((nodes) =>
      nodes.map((node) =>
        node.classList.contains("steps")
          ? `[${node.querySelector("summary")!.textContent!.trim()}]`
          : node.textContent!.trim().slice(0, 30),
      ),
    );
  expect(parts).toEqual([
    "On it. Checking your calendar ",
    "[Used 1 tool]",
    "Reading Thursday's notes now. ",
    "[Used 1 tool]",
    "Thursday is empty, so I kept i",
    "Here is the week, with Thursda",
  ]);
  // Each one is its own bubble.
  await expect(turn.locator(".bubble")).toHaveCount(4);
});

test("F-076: Cmd/Ctrl+F finds text in the open conversation", async ({ page }) => {
  await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
  await settle(page);
  const transcript = page.locator(".transcript");
  await transcript.focus();
  await page.keyboard.press("ControlOrMeta+F");
  const field = page.getByRole("textbox", { name: "Find in conversation" });
  await expect(field).toBeFocused();
  // It takes the title pill's place in the header.
  await expect(page.locator(".title-pill")).toHaveCount(0);
  await field.fill("transcode cache");
  const count = page.getByTestId("find-bar").getByRole("status");
  const total = await page.evaluate(
    () =>
      (
        document
          .querySelector(".transcript-inner")!
          .textContent!.toLowerCase()
          .match(/transcode cache/g) ?? []
      ).length,
  );
  expect(total).toBeGreaterThan(2);
  await expect(count).toHaveText(`1 of ${total}`);
  const highlighted = () =>
    page.evaluate(() => {
      const registry = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights;
      const current = [...(registry.get("clawtrate-find-current") ?? [])][0];
      return {
        all: registry.get("clawtrate-find")?.size ?? 0,
        current: current?.toString() ?? null,
        top: current?.getBoundingClientRect().top ?? null,
      };
    });
  expect(await highlighted()).toMatchObject({ all: total, current: "transcode cache" });
  // Enter and Shift+Enter step through the matches, and wrap.
  await page.keyboard.press("Enter");
  await expect(count).toHaveText(`2 of ${total}`);
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Shift+Enter");
  await expect(count).toHaveText(`${total} of ${total}`);
  // The current match is scrolled into view, below the header band.
  const box = await rect(transcript);
  const { top } = await highlighted();
  expect(top!).toBeGreaterThan(box.y + 98 - 1);
  expect(top!).toBeLessThan(box.y + box.height);
  // A match inside folded tool calls opens its group.
  await field.fill("Permission denied");
  await expect(count).toHaveText("1 of 1");
  await expect(page.locator("details.steps[open]")).toHaveCount(1);
  await field.fill("no such words here");
  await expect(count).toHaveText("No matches");
  await expect(page.getByRole("button", { name: "Next match" })).toBeDisabled();
  // Escape closes it, clears the highlights and gives focus back.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("find-bar")).toHaveCount(0);
  await expect(page.locator(".title-pill")).toBeVisible();
  await expect(transcript).toBeFocused();
  expect((await highlighted()).all).toBe(0);
});

test("F-076: find reads text as it is rendered, across bold, emphasis, links and inline code, but not from one block into the next", async ({
  page,
}) => {
  const find = async (query: string) => {
    const field = page.getByRole("textbox", { name: "Find in conversation" });
    if (!(await field.isVisible())) {
      await page.locator(".transcript").focus();
      await page.keyboard.press("ControlOrMeta+F");
    }
    await field.fill(query);
    const status = await page.getByTestId("find-bar").getByRole("status").textContent();
    const current = await page.evaluate(() => {
      const registry = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights;
      return [...(registry.get("clawtrate-find-current") ?? [])][0]?.toString() ?? null;
    });
    return { status, current };
  };

  await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
  await settle(page);
  // Inline code inside a sentence.
  expect(await find("transcode-cache.old instead of deleting")).toEqual({
    status: "1 of 1",
    current: "transcode-cache.old instead of deleting",
  });
  // The end of one paragraph and the code block after it are separate blocks,
  // and so are two cells of a table.
  expect(await find("to undo:mv")).toEqual({ status: "No matches", current: null });
  expect(await find("94%61%")).toEqual({ status: "No matches", current: null });
  await page.keyboard.press("Escape");

  await openFixture(page, `scene=main&${JUNIPER_EBOOKS}`, "light");
  await settle(page);
  const reply = page.locator('.msg[data-role="assistant"] .bubble').last();
  await expect(reply.locator("strong")).toHaveText("Libby by OverDrive");
  // Bold, then emphasis, then a link and inline code, each inside a longer phrase.
  for (const phrase of [
    "lists Libby by OverDrive on its",
    "it is the easiest of the three to start",
    "number on the library's help page, then choose Add a library if",
  ]) {
    expect(await find(phrase.toUpperCase())).toEqual({ status: "1 of 1", current: phrase });
  }
  // The highlighted range is the one in the page, and takes in the link and the code.
  const covered = await page.evaluate(() => {
    const registry = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights;
    const contents = [...(registry.get("clawtrate-find-current") ?? [])][0]!.cloneContents();
    return [contents.querySelector("a")?.textContent, contents.querySelector("code")?.textContent];
  });
  expect(covered).toEqual(["the library's help page", "Add a library"]);
});
