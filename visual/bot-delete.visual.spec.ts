// Delete bot… (docs/parity.md F-050, F-276, F-464) in the fixture mode: the
// dialog's list of what goes and what stays, the workspace folder box and its
// shared-folder rule, a read-only connection, a partial cleanup that sends nothing more,
// and the Main Bot, which has no Delete. The fixture's gateway answers the
// delete; bot-delete.ts in the fixture lists its states.
import { test, type Page } from "@playwright/test";
import { contextFor, expect, hold, openFixture, release, settle, SIZES } from "./fixture.ts";

const PIP = "scene=main&bot=pip&panel=open&tab=settings";

const sentDeletes = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: Array<{ type: string }> } }
    ).clawtrateFixture.sent.filter((command) => command.type === "deleteBot"),
  );

/** Change the fixture's connection, as another gateway or access would. */
const setConnection = (page: Page, change: Record<string, unknown>) =>
  page.evaluate(
    (patch) =>
      (
        window as unknown as {
          clawtrateFixture: {
            setState(next: (state: { connection: Record<string, unknown> }) => unknown): void;
          };
        }
      ).clawtrateFixture.setState((state) => ({
        ...state,
        connection: { ...state.connection, ...patch },
      })),
    change,
  );

async function openDelete(page: Page, query: string) {
  await openFixture(page, `${PIP}&${query}`, "light");
  await page.getByRole("button", { name: "Delete bot…" }).click();
  const dialog = page.getByTestId("delete-bot");
  await expect(dialog.getByRole("heading", { name: "Delete Pip?" })).toBeVisible();
  return dialog;
}

for (const size of SIZES) {
  const wide = size.name === "1440" || size.phone === true;
  test.describe(size.name, () => {
    test.use(contextFor(size, "light"));

    test("F-050: the delete dialog names the bot, lists what goes and what stays, and asks first", async ({
      page,
    }) => {
      const dialog = await openDelete(page, "access=admin");
      await expect(page.getByRole("alertdialog", { name: "Delete Pip?" })).toBeVisible();
      await expect(dialog.getByText("Deleting Pip can't be undone.")).toBeVisible();
      await expect(dialog.getByTestId("delete-goes")).toContainText(
        "Pip, with its settings and its place in your sidebar",
      );
      await expect(dialog.getByTestId("delete-stays")).toContainText(
        "Its workspace folder, with its files and memory",
      );
      const box = dialog.getByRole("checkbox", { name: "Also remove this bot's workspace folder" });
      await expect(box).not.toBeChecked();
      // The name to type is the first thing focused; Delete waits for it.
      await expect(dialog.getByTestId("delete-type")).toBeFocused();
      await expect(dialog.getByRole("button", { name: "Delete Pip" })).toBeDisabled();
      await expect(dialog.getByTestId("delete-final")).toHaveText(
        "This can't be undone. Pip and its tasks won't come back.",
      );
      await settle(page);
      await expect(page).toHaveScreenshot(`delete-bot-confirm-${size.name}.png`);
    });

    test("F-050: a partial cleanup says what is left, that the gateway's machine is where it is handled, and offers nothing that sends", async ({
      page,
    }) => {
      const dialog = await openDelete(page, "access=admin&delresult=partial");
      await dialog
        .getByRole("checkbox", { name: "Also remove this bot's workspace folder" })
        .check();
      await dialog.getByTestId("delete-type").fill("Pip");
      await dialog.getByRole("button", { name: "Delete Pip" }).click();
      await expect(
        dialog.getByRole("heading", { name: "Pip was deleted, but some of it is left" }),
      ).toBeVisible();
      await expect(dialog.getByTestId("delete-result")).toContainText(
        "Couldn't move to the Trash: /srv/clawtrate/agents/pip. Operation not permitted",
      );
      await expect(dialog.getByTestId("delete-result")).toContainText(
        "What is left has to be handled on the gateway's machine.",
      );
      // The dialog's own close and Close: nothing that sends.
      await expect(dialog.getByRole("button", { name: "Try again" })).toHaveCount(0);
      await expect(dialog.getByRole("button")).toHaveCount(2);
      await settle(page);
      await expect(page).toHaveScreenshot(`delete-bot-partial-${size.name}.png`);
    });

    if (!wide) return;

    test("F-276: ticked, the workspace folder moves to what goes, with its path, if no other bot uses it", async ({
      page,
    }) => {
      const dialog = await openDelete(page, "access=admin");
      await dialog
        .getByRole("checkbox", { name: "Also remove this bot's workspace folder" })
        .check();
      await expect(dialog.getByTestId("delete-goes")).toContainText(
        "Its workspace folder, with its files and memory, if no other bot uses it: /srv/clawtrate/workspaces/pip",
      );
      await expect(dialog.getByTestId("delete-stays")).not.toContainText("Its workspace folder");
      await settle(page);
      await expect(page).toHaveScreenshot(`delete-bot-folder-${size.name}.png`);
    });

    test("F-464: a folder another bot uses can't be removed, and says who uses it", async ({
      page,
    }) => {
      const dialog = await openDelete(page, "access=admin&delshared=1");
      const box = dialog.getByRole("checkbox", { name: "Also remove this bot's workspace folder" });
      await expect(box).toBeDisabled();
      await expect(box).not.toBeChecked();
      await expect(dialog.getByText("Also used by Marlow", { exact: true })).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`delete-bot-shared-${size.name}.png`);
    });

    test("F-050: a read-only connection sees the list and why it can't delete", async ({
      page,
    }) => {
      const dialog = await openDelete(page, "access=read");
      await expect(dialog.getByTestId("delete-goes")).toBeVisible();
      await expect(dialog.getByTestId("admin-bar")).toContainText(
        "Deleting Pip needs admin access.",
      );
      await expect(dialog.getByRole("button", { name: "Delete Pip" })).toHaveCount(0);
      await settle(page);
      await expect(page).toHaveScreenshot(`delete-bot-read-only-${size.name}.png`);
    });
  });
}

test.describe("dark", () => {
  test.use(contextFor(SIZES[0]!, "dark"));

  test("F-050: the delete dialog in the dark theme", async ({ page }) => {
    await openFixture(page, `${PIP}&access=admin`, "dark");
    await page.getByRole("button", { name: "Delete bot…" }).click();
    await expect(page.getByRole("heading", { name: "Delete Pip?" })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot("delete-bot-confirm-dark-1440.png");
  });
});

test.describe("behaviour", () => {
  test.use(contextFor(SIZES[0]!, "light"));

  test("F-050: the Main Bot's settings offer no Delete and say why", async ({ page }) => {
    await openFixture(page, "scene=main&bot=main&panel=open&tab=settings&access=admin", "light");
    await expect(page.getByTestId("delete-main-note")).toHaveText(
      "Juniper is your Main Bot, so it can't be deleted.",
    );
    await expect(page.getByRole("button", { name: "Delete bot…" })).toHaveCount(0);
  });

  test("F-050: deleting waits for the gateway, then the bot leaves the sidebar and the app lands on the Main Bot", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin");
    await hold(page);
    await dialog.getByTestId("delete-type").fill("Pip");
    await dialog.getByRole("button", { name: "Delete Pip" }).click();
    // Busy: Escape and Close do nothing until the gateway answers.
    await expect(dialog.getByRole("button", { name: "Deleting Pip…" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await release(page);
    await expect(dialog.getByRole("heading", { name: "Pip was deleted" })).toBeVisible();
    await expect(dialog.getByTestId("delete-result")).toContainText(
      "Clawtrate asked the gateway to keep its folders.",
    );
    await expect(page.locator('button.bot[data-bot="pip"]')).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close" }).last().click();
    await expect(dialog).toHaveCount(0);
    // The Main Bot's task is the one open.
    await expect(page.locator('[data-testid="task"][aria-current="true"]')).toHaveAttribute(
      "data-key",
      /^agent:main:/,
    );
    const sent = await page.evaluate(() =>
      (
        window as unknown as { clawtrateFixture: { sent: Array<{ type: string }> } }
      ).clawtrateFixture.sent.filter((command) => command.type === "deleteBot"),
    );
    expect(sent).toEqual([
      {
        type: "deleteBot",
        botId: "pip",
        stamp: { gatewayId: expect.any(String), target: expect.any(Number) },
        deleteFiles: false,
        typed: "Pip",
        reviewed: {
          nameDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          createdAt: expect.any(Number),
          workspace: "/srv/clawtrate/workspaces/pip",
          folder: "own",
          sharedWith: [],
          sharedOmitted: 0,
        },
      },
    ]);
  });

  test("F-050: a bot replaced since the dialog opened is not sent for deletion", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin&delresult=replaced");
    await dialog.getByTestId("delete-type").fill("Pip");
    await dialog.getByRole("button", { name: "Delete Pip" }).click();
    await expect(dialog.getByTestId("delete-note")).toContainText(
      "The bot you reviewed has changed on the gateway. Nothing was sent.",
    );
    await expect(page.locator('button.bot[data-bot="pip"]')).toHaveCount(1);
  });

  test("F-276: a bot with no creation record has no folder box, says why, and is deleted with its folder kept", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin&delrecord=none");
    await expect(
      dialog.getByRole("checkbox", { name: "Also remove this bot's workspace folder" }),
    ).toHaveCount(0);
    await expect(dialog.getByText(/keeps no creation record for Pip/)).toBeVisible();
    await dialog.getByTestId("delete-type").fill("Pip");
    await dialog.getByRole("button", { name: "Delete Pip" }).click();
    await expect(dialog.getByRole("heading", { name: "Pip was deleted" })).toBeVisible();
    const sent = await page.evaluate(() =>
      (
        window as unknown as { clawtrateFixture: { sent: Array<{ type: string }> } }
      ).clawtrateFixture.sent.filter((command) => command.type === "deleteBot"),
    );
    expect(sent).toMatchObject([{ deleteFiles: false, reviewed: { createdAt: null } }]);
  });

  test("F-276: a folder moved since the dialog opened sends nothing and clears the box; the new folder can then be removed", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin&delresult=moved");
    const box = dialog.getByRole("checkbox", { name: "Also remove this bot's workspace folder" });
    await box.check();
    await dialog.getByTestId("delete-type").fill("Pip");
    await dialog.getByRole("button", { name: "Delete Pip" }).click();
    await expect(dialog.getByTestId("delete-note")).toContainText(
      "Pip's workspace folder has changed on the gateway. Nothing was sent, and the folder box is cleared.",
    );
    await expect(box).not.toBeChecked();
    await expect(dialog.getByTestId("delete-stays")).toContainText("Its workspace folder");
    // A fresh confirmation of the folder as it is now goes on.
    await box.check();
    await expect(dialog.getByTestId("delete-goes")).toContainText("/srv/clawtrate/moved/pip");
    await dialog.getByTestId("delete-type").fill("Pip");
    await dialog.getByRole("button", { name: "Delete Pip" }).click();
    await expect(dialog.getByRole("heading", { name: "Pip was deleted" })).toBeVisible();
    const sent = await sentDeletes(page);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      deleteFiles: true,
      reviewed: { workspace: "/srv/clawtrate/moved/pip" },
    });
  });

  test("F-276: the folder box is asked for again after a read before the delete that decided nothing", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin&delresult=stale");
    const box = dialog.getByRole("checkbox", { name: "Also remove this bot's workspace folder" });
    await box.check();
    await dialog.getByTestId("delete-type").fill("Pip");
    await dialog.getByRole("button", { name: "Delete Pip" }).click();
    await dialog.getByRole("button", { name: "Read again" }).click();
    await expect(dialog.getByTestId("delete-goes")).toBeVisible();
    await expect(box).not.toBeChecked();
  });

  test("F-050: a partial cleanup whose list read failed keeps what is left on Check again, and sends nothing more", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin&delresult=unread");
    await dialog.getByRole("checkbox", { name: "Also remove this bot's workspace folder" }).check();
    await dialog.getByTestId("delete-type").fill("Pip");
    await dialog.getByRole("button", { name: "Delete Pip" }).click();
    const result = dialog.getByTestId("delete-result");
    await expect(result).toContainText("Clawtrate couldn't read the gateway's bot list to check.");
    await expect(dialog.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Check again" }).click();
    await expect(
      dialog.getByRole("heading", { name: "Pip was deleted, but some of it is left" }),
    ).toBeVisible();
    await expect(result).toContainText(
      "Couldn't move to the Trash: /srv/clawtrate/agents/pip. Operation not permitted",
    );
    await expect(dialog.getByRole("button", { name: "Check again" })).toHaveCount(0);
    expect(await sentDeletes(page)).toHaveLength(1);
  });

  test("F-050: the dialog offers nothing more once another gateway is connected", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin");
    await page.evaluate(() =>
      (
        window as unknown as {
          clawtrateFixture: {
            setState(change: (state: { connection: Record<string, unknown> }) => unknown): void;
          };
        }
      ).clawtrateFixture.setState((state) => ({
        ...state,
        connection: { ...state.connection, gatewayId: "another-gateway" },
      })),
    );
    await expect(dialog.getByTestId("delete-elsewhere")).toContainText(
      "Clawtrate is now connected to another gateway",
    );
    await expect(dialog.getByRole("button", { name: "Delete Pip" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close" }).last().click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('button.bot[data-bot="pip"]')).toHaveCount(1);
  });

  test("F-050: the dialog offers nothing more once the host is pointed at the gateway anew", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin");
    await dialog.getByTestId("delete-type").fill("Pip");
    await expect(dialog.getByRole("button", { name: "Delete Pip" })).toBeEnabled();
    await page.evaluate(() =>
      (
        window as unknown as {
          clawtrateFixture: {
            setState(
              change: (state: {
                connection: { target: number } & Record<string, unknown>;
              }) => unknown,
            ): void;
          };
        }
      ).clawtrateFixture.setState((state) => ({
        ...state,
        connection: { ...state.connection, target: state.connection.target + 1 },
      })),
    );
    await expect(dialog.getByTestId("delete-elsewhere")).toContainText(
      "The connection to the gateway changed since this dialog opened",
    );
    await expect(dialog.getByRole("button", { name: "Delete Pip" })).toHaveCount(0);
    expect(await sentDeletes(page)).toEqual([]);
  });

  test("F-050: closing a delete lands on a Main Bot with no tasks at its heading", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin");
    await page.evaluate(() =>
      (
        window as unknown as {
          clawtrateFixture: {
            setState(next: (state: { tasksByBot: Record<string, unknown[]> }) => unknown): void;
          };
        }
      ).clawtrateFixture.setState((state) => ({
        ...state,
        tasksByBot: { ...state.tasksByBot, main: [] },
      })),
    );
    await dialog.getByTestId("delete-type").fill("Pip");
    await dialog.getByRole("button", { name: "Delete Pip" }).click();
    await dialog.getByRole("button", { name: "Close" }).last().click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".conversation h1")).toBeFocused();
  });

  test("F-050: when the connection drops, focus moves to Close as the field goes", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin");
    await expect(dialog.getByTestId("delete-type")).toBeFocused();
    await setConnection(page, { status: "reconnecting" });
    await expect(dialog.getByTestId("delete-type")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Close" }).last()).toBeFocused();
  });

  test("F-050: Check again that finds the bot is now the Main Bot says so, not to delete again", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin&delresult=noanswer");
    await dialog.getByTestId("delete-type").fill("Pip");
    await dialog.getByRole("button", { name: "Delete Pip" }).click();
    await expect(
      dialog.getByRole("heading", { name: "The gateway didn't confirm the delete" }),
    ).toBeVisible();
    // Meanwhile Pip became the gateway's default bot.
    await page.evaluate(() =>
      (
        window as unknown as {
          clawtrateFixture: {
            setState(
              next: (state: { bots: Array<{ id: string; isDefault: boolean }> }) => unknown,
            ): void;
          };
        }
      ).clawtrateFixture.setState((state) => ({
        ...state,
        bots: state.bots.map((bot) => ({ ...bot, isDefault: bot.id === "pip" })),
      })),
    );
    await dialog.getByRole("button", { name: "Check again" }).click();
    const note = dialog.getByTestId("delete-note");
    await expect(note).toContainText("Pip is your Main Bot, so it can't be deleted.");
    await expect(note).not.toContainText("delete again");
    await expect(dialog.getByRole("button", { name: "Delete Pip" })).toHaveCount(0);
  });

  test("F-050: when another gateway connects, focus moves to Close as the field goes", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin");
    await expect(dialog.getByTestId("delete-type")).toBeFocused();
    await setConnection(page, { gatewayId: "another-gateway" });
    await expect(dialog.getByTestId("delete-elsewhere")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close" }).last()).toBeFocused();
  });

  test("F-050: Enter that commits an input method's text sends nothing; Enter after it does", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin");
    const field = dialog.getByTestId("delete-type");
    await field.fill("Pip");
    await field.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
    await page.waitForTimeout(300);
    expect(await sentDeletes(page)).toEqual([]);
    await field.press("Enter");
    await expect(dialog.getByRole("heading", { name: "Pip was deleted" })).toBeVisible();
    expect(await sentDeletes(page)).toHaveLength(1);
  });

  test("F-050: while a delete is under way, a change of access offers nothing on the dialog", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin");
    await dialog.getByTestId("delete-type").fill("Pip");
    // The gateway's answer is held until the checks are done.
    await hold(page);
    await dialog.getByRole("button", { name: "Delete Pip" }).click();
    await expect(dialog.getByRole("button", { name: "Deleting Pip…" })).toBeVisible();
    await setConnection(page, { canAdmin: false });
    // The change is drawn before anything is checked.
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    await expect(dialog.getByRole("button", { name: "Deleting Pip…" })).toBeVisible();
    expect(await dialog.getByRole("button", { name: "Request admin access" }).count()).toBe(0);
    await release(page);
    await expect(dialog.getByRole("heading", { name: "Pip was deleted" })).toBeVisible();
  });

  for (const [result, now] of [
    ["renamed", "Pip II"],
    ["replaced", "Quill"],
  ] as const)
    test(`F-050: after a ${result} bot, the second confirmation names and sends the bot the gateway has now`, async ({
      page,
    }) => {
      const dialog = await openDelete(page, `access=admin&delresult=${result}`);
      await dialog.getByTestId("delete-type").fill("Pip");
      await dialog.getByRole("button", { name: "Delete Pip" }).click();
      await expect(dialog.getByTestId("delete-note")).toContainText("Nothing was sent.");
      // A new name: what was typed is cleared, and the new name is the one to type.
      await expect(dialog.getByTestId("delete-type")).toHaveValue("");
      await expect(dialog.getByRole("button", { name: `Delete ${now}` })).toBeDisabled();
      await dialog.getByTestId("delete-type").fill("Pip");
      await expect(dialog.getByRole("button", { name: `Delete ${now}` })).toBeDisabled();
      await expect(dialog.getByRole("heading", { name: `Delete ${now}?` })).toBeVisible();
      await expect(dialog.getByTestId("delete-goes")).toContainText(
        `${now}, with its settings and its place in your sidebar`,
      );
      await dialog.getByTestId("delete-type").fill(now);
      await dialog.getByRole("button", { name: `Delete ${now}` }).click();
      await expect(dialog.getByTestId("delete-result")).toBeVisible();
      const sent = await sentDeletes(page);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toMatchObject({ typed: now });
      // The second confirmation sends the bot as the gateway has it now, not the first review.
      const reviews = sent.map(
        (each) =>
          (each as unknown as { reviewed: { nameDigest: string; createdAt: number } }).reviewed,
      );
      expect(reviews[1]!.nameDigest).not.toBe(reviews[0]!.nameDigest);
      if (result === "replaced") expect(reviews[1]!.createdAt).not.toBe(reviews[0]!.createdAt);
    });

  test("F-276: the dialog asks the gateway to keep the folder, and says so first when it moved one anyway", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin&delresult=kept-moved");
    await expect(
      dialog.getByRole("heading", { name: "Clawtrate asks the gateway to keep" }),
    ).toBeVisible();
    await dialog.getByTestId("delete-type").fill("Pip");
    await dialog.getByRole("button", { name: "Delete Pip" }).click();
    const first = dialog.getByTestId("delete-result").locator("li").first();
    await expect(first).toHaveText(
      "Clawtrate asked the gateway to keep Pip's folders, but it moved one to the Trash on its machine. It is in the Trash there, not gone.",
    );
    await expect(dialog.getByTestId("delete-result")).toContainText(
      "Moved to the Trash: /srv/clawtrate/workspaces/pip",
    );
  });

  test("F-050: a lost answer with Pip no longer listed never says deleted", async ({ page }) => {
    const dialog = await openDelete(page, "access=admin&delresult=unconfirmed");
    await dialog.getByTestId("delete-type").fill("Pip");
    await dialog.getByRole("button", { name: "Delete Pip" }).click();
    await expect(
      dialog.getByRole("heading", { name: "Pip is no longer listed on this gateway" }),
    ).toBeVisible();
    await expect(dialog.getByTestId("delete-result")).toContainText(
      "What became of Pip's folder is the gateway's to say.",
    );
    await expect(dialog.getByTestId("delete-result")).not.toContainText("deleted");
    // Only reading the list follows, and it can be read again.
    await expect(dialog.getByRole("button", { name: "Check again" })).toBeVisible();
  });

  test("F-050: a lost answer offers Check again, which only reads: while the gateway still lists Pip, a fresh confirmation", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin&delresult=noanswer");
    await dialog.getByTestId("delete-type").fill("Pip");
    await dialog.getByRole("button", { name: "Delete Pip" }).click();
    await expect(
      dialog.getByRole("heading", { name: "The gateway didn't confirm the delete" }),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Check again" }).click();
    await expect(dialog.getByTestId("delete-note")).toContainText(
      "The gateway didn't confirm the last delete, and it still lists Pip.",
    );
    // A fresh confirmation: what was typed before doesn't carry over, though the text is the same.
    await expect(dialog.getByTestId("delete-type")).toHaveValue("");
    await expect(dialog.getByRole("button", { name: "Delete Pip" })).toBeDisabled();
    expect(await sentDeletes(page)).toHaveLength(1);
  });

  test("F-050: a bot replaced by one with the same name asks for the name to be typed again", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin&delresult=recreated");
    await dialog.getByTestId("delete-type").fill("Pip");
    await dialog.getByRole("button", { name: "Delete Pip" }).click();
    await expect(dialog.getByTestId("delete-note")).toContainText("Nothing was sent.");
    await expect(dialog.getByTestId("delete-type")).toHaveValue("");
    await expect(dialog.getByRole("button", { name: "Delete Pip" })).toBeDisabled();
    await dialog.getByTestId("delete-type").fill("Pip");
    await dialog.getByRole("button", { name: "Delete Pip" }).click();
    await expect(dialog.getByTestId("delete-result")).toBeVisible();
    const sent = await sentDeletes(page);
    expect(sent).toHaveLength(2);
    // Same name, another bot: the second review carries the new creation record.
    const reviews = sent.map(
      (each) => (each as unknown as { reviewed: { createdAt: number } }).reviewed,
    );
    expect(reviews[1]!.createdAt).not.toBe(reviews[0]!.createdAt);
  });

  test("F-050: the name to type is shown with its spaces as they are, and typing what is shown matches", async ({
    page,
  }) => {
    await openFixture(
      page,
      `${PIP}&access=admin&delname=${encodeURIComponent("Pip  Smith")}`,
      "light",
    );
    await page.getByRole("button", { name: "Delete bot…" }).click();
    const dialog = page.getByTestId("delete-bot");
    const label = dialog.locator(".b-delete-label");
    await expect(label).toBeVisible();
    // What the page draws, as a person reads it off the screen.
    const shown = (await label.evaluate((element) => (element as HTMLElement).innerText)).split(
      ": ",
    )[1]!;
    expect(shown).toBe("Pip  Smith");
    await dialog.getByTestId("delete-type").fill(shown);
    await expect(dialog.getByRole("button", { name: /^Delete Pip/ })).toBeEnabled();
  });

  test("F-050: a reply lost between the host and this window is unconfirmed, with only Check again", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin&delresult=lost");
    await dialog.getByTestId("delete-type").fill("Pip");
    await dialog.getByRole("button", { name: "Delete Pip" }).click();
    await expect(
      dialog.getByRole("heading", { name: "The gateway didn't confirm the delete" }),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Delete Pip" })).toHaveCount(0);
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Check again" }).click();
    await expect(
      dialog.getByRole("heading", { name: "Pip is no longer listed on this gateway" }),
    ).toBeVisible();
    expect(await sentDeletes(page)).toHaveLength(1);
  });

  test("F-050: a list superseded before the delete hands back no facts: the dialog offers Read again", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin&delresult=stale");
    await dialog.getByTestId("delete-type").fill("Pip");
    await dialog.getByRole("button", { name: "Delete Pip" }).click();
    await expect(dialog).toContainText("The bot list changed while Clawtrate read it.");
    await expect(dialog.getByRole("button", { name: "Delete Pip" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Read again" }).click();
    await expect(dialog.getByRole("button", { name: "Delete Pip" })).toBeVisible();
  });

  test("F-050: Delete waits for the bot's name typed exactly; Enter does nothing until it matches", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin");
    const field = dialog.getByTestId("delete-type");
    const button = dialog.getByRole("button", { name: "Delete Pip" });
    await expect(dialog.getByText("To confirm, type the bot's name: Pip")).toBeVisible();
    await expect(button).toBeDisabled();
    for (const wrong of ["Pi", "pip", "PIP", "Pip!"]) {
      await field.fill(wrong);
      await expect(button).toBeDisabled();
      await field.press("Enter");
    }
    expect(await sentDeletes(page)).toEqual([]);
    // Spaces around it don't count; case does.
    await field.fill("  Pip ");
    await expect(button).toBeEnabled();
    await field.press("Enter");
    await expect(dialog.getByRole("heading", { name: "Pip was deleted" })).toBeVisible();
    expect(await sentDeletes(page)).toHaveLength(1);
  });

  test("F-050: a bot with no name is confirmed by typing its id, and the label says so", async ({
    page,
  }) => {
    await openFixture(page, `${PIP}&access=admin&delnoname=1`, "light");
    await page.getByRole("button", { name: "Delete bot…" }).click();
    const dialog = page.getByTestId("delete-bot");
    await expect(
      dialog.getByText("This bot has no name. To confirm, type its id: pip"),
    ).toBeVisible();
    await dialog.getByTestId("delete-type").fill("pip");
    await expect(dialog.getByRole("button", { name: "Delete pip" })).toBeEnabled();
  });
});

test.describe("Work as a drawer", () => {
  test.use(contextFor(SIZES[2]!, "light"));

  test("F-050: from Cancel, Tab reaches Delete and Shift+Tab the name field: the drawer leaves the dialog's keys alone", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin");
    const field = dialog.getByTestId("delete-type");
    const cancel = dialog.getByRole("button", { name: "Cancel" });
    const button = dialog.getByRole("button", { name: "Delete Pip" });
    await field.fill("Pip");
    await cancel.focus();
    await page.keyboard.press("Tab");
    await expect(button).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(field).toBeFocused();
    // Escape is the dialog's: it closes, and the drawer stays open behind it.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete bot…" })).toBeVisible();
  });

  test("F-050: after a delete from the drawer, the drawer closes and the Main Bot's conversation takes focus", async ({
    page,
  }) => {
    const dialog = await openDelete(page, "access=admin");
    await dialog.getByTestId("delete-type").fill("Pip");
    await dialog.getByRole("button", { name: "Delete Pip" }).click();
    await dialog.getByRole("button", { name: "Close" }).last().click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete bot…" })).toHaveCount(0);
    await expect(page.locator(".composer-input")).toBeFocused();
  });
});
