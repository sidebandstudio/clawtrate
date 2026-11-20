import { newRun, type ClawtrateState } from "../packages/core/src/index.ts";
import { expect, test } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

for (const size of SIZES.filter((each) => each.name === "1440" || each.phone)) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const scene of ["browser", "cli", "success", "failure", "about"]) {
        test(`star invitation ${scene}`, async ({ page }) => {
          await openFixture(
            page,
            `scene=main&${OTTO_DISK}&panel=closed&access=write&star=${scene}`,
            theme,
          );
          if (scene === "about") {
            await page.keyboard.press("ControlOrMeta+,");
            await page.getByRole("button", { name: "About", exact: true }).click();
            await expect(
              page.getByRole("link", { name: "Star Clawtrate on GitHub" }),
            ).toBeVisible();
          } else {
            const notice = page.getByRole("region", { name: "GitHub invitation" });
            await expect(notice).toBeVisible();
            await expect(notice.getByRole("button", { name: "Star with GitHub CLI" })).toHaveCount(
              scene === "cli" ? 1 : 0,
            );
            await expect(notice).toContainText(
              scene === "success"
                ? "Starred. Thank you."
                : scene === "failure"
                  ? "Couldn't star with the GitHub CLI."
                  : "Enjoying Clawtrate?",
            );
          }
          await settle(page);
          await expect(page).toHaveScreenshot(`star-${scene}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}

for (const works of [true, false]) {
  test(`F-521: the CLI button ${works ? "thanks on success" : "keeps the browser choice on failure"}`, async ({
    page,
  }) => {
    await openFixture(
      page,
      `scene=main&${OTTO_DISK}&access=write&star=${works ? "cli" : "cli-fails"}`,
      "light",
    );
    const notice = page.getByRole("region", { name: "GitHub invitation" });
    await notice.getByRole("button", { name: "Star with GitHub CLI" }).click();
    await expect(notice).toContainText(
      works ? "Starred. Thank you." : "Couldn't star with the GitHub CLI.",
    );
    await expect(notice.getByRole("link", { name: "Open GitHub to star Clawtrate" })).toHaveCount(
      works ? 0 : 1,
    );
    await expect(page.getByTestId("composer-input")).toBeFocused();
  });
}

test("F-520: a reported browser failure leaves the repository available in About", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write&star=open-fails`, "light");
  const link = page.getByRole("link", { name: "Open GitHub to star Clawtrate" });
  await link.click();
  const notice = page.getByRole("region", { name: "GitHub invitation" });
  await expect(notice).toContainText("Couldn't open GitHub. Try again from About.");
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("button", { name: "About", exact: true }).click();
  const about = page.getByRole("link", { name: "Star Clawtrate on GitHub" });
  await about.click();
  await expect(page.getByRole("dialog")).toContainText(
    "Couldn't open GitHub. Try again from About.",
  );
  await expect(about).toBeVisible();
});

for (const size of SIZES.filter((s) => s.phone || s.width === 1440)) {
  test.describe("invitation controls at " + size.width, () => {
    test.use(contextFor(size, "light"));
    test("F-519 F-520 F-521: one action row leaves the composer pinned and restores keyboard focus", async ({
      page,
    }) => {
      const query = `scene=main&${OTTO_DISK}&panel=closed&access=write`;
      await openFixture(page, query, "light");
      const field = page.getByTestId("composer-input");
      const before = (await field.boundingBox())!;
      await openFixture(page, query + "&star=cli", "light");
      const panel = page.getByRole("region", { name: "GitHub invitation" });
      const cli = panel.getByRole("button", { name: "Star with GitHub CLI" });
      const browser = panel.getByRole("link");
      const dismiss = panel.getByRole("button", { name: "Dismiss" });
      const buttons = await Promise.all([cli, browser, dismiss].map((x) => x.boundingBox()));
      expect((await field.boundingBox())!.y).toBe(before.y);
      expect(
        buttons.every(
          (b) => b && Math.abs(b.y + b.height / 2 - (buttons[0]!.y + buttons[0]!.height / 2)) <= 1,
        ),
      ).toBe(true);
      if (size.phone) expect(buttons.every((b) => b!.height >= 44 && b!.width >= 44)).toBe(true);
      await expect(cli).toHaveAccessibleDescription(
        "Stars sidebandstudio/clawtrate as the account the GitHub CLI is signed in to on this computer.",
      );
      await browser.focus();
      for (const control of [cli, browser, dismiss]) {
        await page.keyboard.press(control === cli ? "Shift+Tab" : "Tab");
        await expect(control).toBeFocused();
        await expect(control).toHaveCSS("outline-width", "2px");
        await expect(control).toHaveCSS("outline-offset", "2px");
      }
      await page.keyboard.press("Escape");
      await expect(field).toBeFocused();
      await expect(panel).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+,");
      await page.getByRole("button", { name: "About", exact: true }).click();
      const about = page.getByRole("link", { name: "Star Clawtrate on GitHub" });
      const rect = (await about.boundingBox())!;
      expect(rect.height).toBeGreaterThanOrEqual(44);
      if (size.phone) expect(rect.width).toBeGreaterThanOrEqual(size.width - 40);
    });
  });
}

for (const activation of ["primary", "keyboard", "middle"]) {
  test(`F-519: ${activation} activation hands the browser the repository once and consumes the notice`, async ({
    page,
    context,
  }) => {
    const requests: string[] = [];
    await context.route("https://github.com/**", (route) => {
      requests.push(route.request().url());
      return route.abort();
    });
    await openFixture(page, `scene=main&${OTTO_DISK}&access=write&star=browser`, "light");
    await page.evaluate(() => {
      window.open = (url, target, features) => {
        document.body.dataset.opens =
          (document.body.dataset.opens ?? "") + JSON.stringify([url, target, features]);
        return null;
      };
    });
    const notice = page.getByRole("region", { name: "GitHub invitation" });
    const link = notice.getByRole("link");
    await link.focus();
    if (activation === "keyboard") await link.press("Enter");
    else await link.click({ button: activation === "middle" ? "middle" : "left" });
    await expect(notice).toHaveCount(0);
    await expect(page.getByTestId("composer-input")).toBeFocused();
    await expect(page.locator("body")).toHaveAttribute(
      "data-opens",
      JSON.stringify([
        "https://github.com/sidebandstudio/clawtrate",
        "_blank",
        "noopener,noreferrer",
      ]),
    );
    expect(requests).toEqual([]);
  });
}

test("F-521: a second dispatch in the same click cannot start the CLI twice", async ({ page }) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write&star=cli`, "light");
  await page.evaluate(() => {
    const bridge = (window as unknown as { clawtrateFixture: { starWithCli(): Promise<boolean> } })
      .clawtrateFixture;
    let calls = 0;
    bridge.starWithCli = async () => {
      document.body.dataset.cliCalls = String(++calls);
      if (calls === 1) document.querySelector<HTMLButtonElement>(".star-actions button")!.click();
      return true;
    };
  });
  await page.getByRole("button", { name: "Star with GitHub CLI" }).click();
  await expect(page.getByRole("region", { name: "GitHub invitation" })).toHaveText(
    "Starred. Thank you.",
  );
  await expect(page.locator("body")).toHaveAttribute("data-cli-calls", "1");
});

for (const change of ["gateway", "task", "unfocused", "foreground"]) {
  test(`F-519: an acknowledged send finishes with the ${change} view`, async ({ page }) => {
    const key = "agent:otto:disk-space";
    await openFixture(page, `scene=main&${OTTO_DISK}&access=write`, "light");
    await page.evaluate(() => {
      const bridge = (
        window as unknown as {
          clawtrateFixture: { invoke(command: { type: string }): Promise<unknown> };
        }
      ).clawtrateFixture;
      localStorage.setItem("clawtrate.star-invitation", "5");
      const invoke = bridge.invoke;
      bridge.invoke = (command) =>
        command.type === "sendMessage"
          ? Promise.resolve({ messageId: "local-message" })
          : invoke(command);
    });
    const field = page.getByTestId("composer-input");
    await field.fill("One local turn");
    await field.press("Enter");
    const update = async (completed: boolean) => {
      const run = newRun(
        "local-run",
        {
          origin: "local",
          state: completed ? "completed" : "running",
          bound: true,
          messageId: "local-message",
          text: "This reply belongs to the test turn.",
          textComplete: completed,
        },
        Date.now(),
      );
      await page.evaluate(
        ({ key, run }) => {
          const bridge = (
            window as unknown as {
              clawtrateFixture: { setState(f: (s: ClawtrateState) => ClawtrateState): void };
            }
          ).clawtrateFixture;
          bridge.setState((s) => {
            const t = s.transcripts[key]!;
            return {
              ...s,
              transcripts: {
                ...s.transcripts,
                [key]: { ...t, runs: [...t.runs.filter((r) => r.id !== run.id), run] },
              },
            };
          });
        },
        { key, run },
      );
      await settle(page);
    };
    await update(false);
    await expect(
      page.getByText("This reply belongs to the test turn.", { exact: true }),
    ).toBeVisible();
    const other = page.getByRole("button", { name: /Weekly backup check/ });
    const original = page.getByRole("button", { name: /Disk almost full/ });
    if (change === "gateway") {
      await page.evaluate(() => {
        const bridge = (
          window as unknown as {
            clawtrateFixture: { setState(f: (s: ClawtrateState) => ClawtrateState): void };
          }
        ).clawtrateFixture;
        bridge.setState((s) => ({
          ...s,
          connection: { ...s.connection, gatewayId: "other-gateway" },
        }));
      });
      await settle(page);
    }
    if (change === "task") await other.click();
    if (change === "unfocused")
      await page.evaluate(() =>
        Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false }),
      );
    await update(true);
    if (change === "unfocused")
      await page.evaluate(() => Reflect.deleteProperty(document, "hasFocus"));
    if (change === "task") await original.click();
    const notice = page.getByRole("region", { name: "GitHub invitation" });
    if (change === "foreground") {
      await expect(notice).toBeVisible();
      await expect(field).toBeFocused();
      await other.click();
      await original.click();
    }
    await expect(notice).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("clawtrate.star-invitation"))).toBe(
      change === "foreground" ? "6" : "5",
    );
  });
}
