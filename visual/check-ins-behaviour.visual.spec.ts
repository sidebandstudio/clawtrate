// How a bot's check-ins behave in the fixture (docs/design/automation.md
// section 13): the dialog's choices and the one command each save sends, the
// default bot's note, what Off does not stop, the admin guard on every way
// in, a draft kept across admin and a conflict and bound to its gateway's
// identity, a save's outcome kept with its own draft, and a check after an
// outcome that is not known. The Routines view shows the chosen bot's block
// above its routines and each group head's cadence in the list across bots.
// The fixture plans each save with the core's own planner; that one patch is
// written and confirmed is checked against the engine in
// packages/core/test/check-ins.test.ts, and against a gateway in
// e2e/check-ins.spec.ts.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, SIZES } from "./fixture.ts";
import { checkIns } from "./check-ins-helpers.ts";
import type { ClawtrateState } from "../packages/core/src/types.ts";
import type {
  BridgeCommand,
  BridgeResultFor,
  ClawtrateBridge,
} from "../packages/core/src/bridge.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const ADMIN = `scene=main&${OTTO_DISK}&access=admin`;

test.use(contextFor(WIDE, "light"));

const sent = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: Array<Record<string, unknown>> } }
    ).clawtrateFixture.sent.map((each) => ({ ...each })),
  );
const saves = async (page: Page) =>
  (await sent(page))
    .filter((each) => each.type === "saveCheckIn")
    .map(({ botId, every, prompt, was, kept }) => ({ botId, every, prompt, was, kept }));
const NOTHING = { every: null, prompt: null };
/** The prompt another client writes in the fixture's conflict. */
const THEIRS = "Theirs. If nothing needs attention, reply NO_REPLY.";
const block = (page: Page, bot: string) =>
  page.locator(`[data-testid="check-in"][data-bot="${bot}"]`);
const dialog = (page: Page, name: string) =>
  page.getByRole("dialog", { name: `${name}'s check-ins` });
const change = (page: Page, run: string) =>
  page.evaluate((body) => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState: (change: (state: unknown) => unknown) => void };
      }
    ).clawtrateFixture;
    fixture.setState(new Function("state", body) as (state: unknown) => unknown);
  }, run);

test("F-201: Daily for one bot sends one save that names the default bot it keeps, and says so first", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await expect(block(page, "main")).toContainText("Checks in every 30 minutes");
  await expect(block(page, "marlow")).toContainText("No check-ins");
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  const marlow = dialog(page, "Marlow");
  await expect(marlow.getByRole("radio")).toHaveText([
    /^Off/,
    /^Daily/,
    /^As needed.*stay quiet when nothing does\.$/,
    /^Every…/,
  ]);
  await expect(marlow.getByRole("radio", { name: /^Off/ })).toHaveAttribute("aria-checked", "true");
  await expect(marlow.getByRole("radio", { name: /^Off/ })).toBeFocused();
  // One tab stop; arrows move and choose.
  await page.keyboard.press("ArrowDown");
  await expect(marlow.getByRole("radio", { name: /^Daily/ })).toBeFocused();
  await expect(marlow.getByRole("radio", { name: /^Daily/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(marlow.getByTestId("catch-note")).toContainText(
    "main checks in now through the gateway's default.",
  );
  await marlow.getByRole("button", { name: "Save", exact: true }).click();
  await expect(marlow).toHaveCount(0);
  expect(await saves(page)).toEqual([
    {
      botId: "marlow",
      every: "24h",
      prompt: null,
      was: NOTHING,
      kept: [{ botId: "main", every: "30m" }],
    },
  ]);
  await expect(page.getByTestId("b-announcer")).toHaveText("Check-ins saved");
  await expect(block(page, "marlow")).toContainText("Checks in daily");
  await expect(block(page, "marlow")).toContainText("Once a day, Marlow looks for anything");
  await expect(block(page, "main")).toContainText("Checks in every 30 minutes");
});

test("F-201: Every… sends the cadence chosen and the prompt that was edited, in one save", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Pip's check-ins" }).click();
  const pip = dialog(page, "Pip");
  await pip.getByRole("radio", { name: /^Every…/ }).click();
  await pip.getByTestId("ci-every").click();
  await page.getByRole("menuitemradio", { name: "4 hours" }).click();
  await pip.getByText("What to check").click();
  await pip.getByRole("textbox", { name: "Prompt" }).fill("Look at the calendar for tomorrow.");
  const note = pip.getByTestId("prompt-note");
  await expect(note).toContainText("Whether Pip stays quiet depends on what this prompt asks.");
  // Naming NO_REPLY is not asking for quiet: any prompt typed gets the same note.
  await pip
    .getByRole("textbox", { name: "Prompt" })
    .fill("Look at the calendar. If nothing needs attention, reply NO_REPLY.");
  await expect(note).toContainText("Whether Pip stays quiet depends on what this prompt asks.");
  await expect(pip.getByRole("radio", { name: /^Every…/ })).toContainText(
    "As often as you choose, Pip checks in with a prompt of its own.",
  );
  await pip.getByRole("button", { name: "Save", exact: true }).click();
  await expect(pip).toHaveCount(0);
  expect(await saves(page)).toEqual([
    {
      botId: "pip",
      every: "4h",
      prompt: "Look at the calendar. If nothing needs attention, reply NO_REPLY.",
      was: NOTHING,
      kept: [{ botId: "main", every: "30m" }],
    },
  ]);
  await expect(block(page, "pip")).toContainText("Checks in every 4 hours");
});

test("F-366: Off says what it does not stop, sends every 0m, and the bot is then shown with no scheduled check-ins", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change main's check-ins" }).click();
  const own = dialog(page, "main");
  await expect(own.getByRole("radio", { name: /^As needed/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(own.getByTestId("catch-self")).toBeVisible();
  await own.getByRole("radio", { name: /^Off/ }).click();
  await expect(own.getByTestId("off-note")).toHaveText(
    "main still reports when a command it started in the background finishes: Off stops only the schedule, and the gateway starts that turn.",
  );
  await own.getByRole("button", { name: "Save", exact: true }).click();
  await expect(own).toHaveCount(0);
  expect(await saves(page)).toEqual([
    { botId: "main", every: "0m", prompt: null, was: NOTHING, kept: [] },
  ]);
  await expect(block(page, "main")).toContainText("No check-ins");
  await expect(block(page, "main")).toContainText("main doesn't check in on a schedule.");
  await expect(block(page, "main")).toContainText(
    "It still reports when a command it started in the background finishes.",
  );
  await expect(block(page, "main")).not.toContainText("Next scheduled attempt");
});

test("F-201: below admin nothing can change check-ins, on any way in, and admin is asked for only by the bar's button", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=read`, "light");
  await checkIns(page);
  await expect(page.getByRole("button", { name: /^Change .*'s check-ins$/ })).toHaveCount(0);
  await expect(page.getByTestId("admin-bar")).toContainText(
    "Read-only. Changing check-ins needs admin access.",
  );
  expect((await sent(page)).map((each) => each.type)).not.toContain("requestAccess");
  await page.getByRole("button", { name: "Request admin access" }).click();
  expect((await sent(page)).filter((each) => each.type === "requestAccess")).toEqual([
    { type: "requestAccess", tier: "admin" },
  ]);
  await expect(page.getByTestId("check-ins-dialog")).toHaveCount(0);
});

test("F-201: the dialog closes when admin access goes, and no control to change check-ins is left", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  await expect(dialog(page, "Marlow")).toBeVisible();
  await change(page, "return { ...state, connection: { ...state.connection, canAdmin: false } };");
  await expect(page.getByTestId("check-ins-dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Change .*'s check-ins$/ })).toHaveCount(0);
  expect(await saves(page)).toEqual([]);
});

test("F-201: a save that could not be confirmed says so in its own dialog only, and is not shown as saved", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&cisave=unknown`, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  const marlow = dialog(page, "Marlow");
  await marlow.getByRole("radio", { name: /^Daily/ }).click();
  await marlow.getByRole("button", { name: "Save", exact: true }).click();
  await expect(marlow.getByTestId("save-unknown")).toContainText("Not confirmed.");
  await expect(marlow.getByTestId("save-unknown")).toContainText("Check reads what it has now");
  await expect(page.getByTestId("b-announcer")).not.toHaveText("Check-ins saved");
  await expect(block(page, "marlow")).toContainText("No check-ins");
  // Check only reads; saving again stays the person's own act.
  const refreshes = async () =>
    (await sent(page)).filter((each) => each.type === "refreshCheckIns").length;
  const before = await refreshes();
  await marlow.getByRole("button", { name: "Check", exact: true }).click();
  await expect(marlow.getByTestId("save-checked")).toContainText("Checked.");
  expect(await refreshes()).toBe(before + 1);
  expect(await saves(page)).toHaveLength(1);
  await expect(marlow.getByRole("radio", { name: /^Daily/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await marlow.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  await expect(dialog(page, "Marlow").getByTestId("save-unknown")).toHaveCount(0);
});

test("F-201: a failed Check stays retryable and does not rebase onto an older ready snapshot", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&cisave=unknown`, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  const marlow = dialog(page, "Marlow");
  await marlow.getByRole("radio", { name: /^Daily/ }).click();
  await marlow.getByRole("button", { name: "Save", exact: true }).click();
  const check = marlow.getByRole("button", { name: "Check", exact: true });
  await expect(check).toBeEnabled();
  await change(
    page,
    "return { ...state, checkIns: { ...state.checkIns, settings: [...state.checkIns.settings, { botId: 'marlow', every: '30m', prompt: 'Old snapshot', promptCut: false }] } };",
  );
  await page.evaluate(() => {
    const bridge = (window as unknown as { clawtrateFixture: ClawtrateBridge }).clawtrateFixture;
    const { invoke, send } = bridge;
    let failed = false;
    bridge.invoke = async <C extends BridgeCommand>(command: C): Promise<BridgeResultFor<C>> => {
      if (command.type !== "refreshCheckIns") return invoke(command);
      if (!failed) {
        failed = true;
        throw new Error("The read could not be sent.");
      }
      const { stamp, jobs, defaults } = bridge.getState().checkIns!;
      return {
        stamp,
        jobs,
        defaults,
        settings: [
          { botId: "marlow", every: "30m", prompt: "Read from gateway", promptCut: false },
        ],
      } as BridgeResultFor<C>;
    };
    bridge.send = (command) =>
      command.type === "refreshCheckIns"
        ? Promise.reject(new Error("The read could not be sent."))
        : send(command);
  });
  await check.click();
  await expect(check).toBeEnabled();
  await expect(marlow.getByTestId("save-unknown")).toBeVisible();
  await marlow.getByText("What to check").click();
  const prompt = marlow.getByRole("textbox", { name: "Prompt" });
  await expect(prompt).toHaveValue("");
  // The command can answer before the host publishes the corresponding snapshot.
  await check.click();
  await expect(marlow.getByTestId("save-checked")).toBeVisible();
  await expect(prompt).toHaveValue("Read from gateway");
});

test("F-201: sending a save locks draft controls before the host publishes saving", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  const marlow = dialog(page, "Marlow");
  await marlow.getByRole("radio", { name: /^Every…/ }).click();
  await marlow.getByText("What to check").click();
  await page.evaluate(() => {
    const bridge = (window as unknown as { clawtrateFixture: ClawtrateBridge }).clawtrateFixture;
    const send = bridge.send;
    bridge.send = (command) =>
      command.type === "saveCheckIn" ? new Promise<void>(() => {}) : send(command);
  });
  await marlow.getByRole("button", { name: "Save", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(marlow.getByRole("button", { name: "Saving…" })).toBeVisible();
  await expect(marlow.getByRole("radio", { name: /^Off/ })).toBeDisabled();
  await expect(marlow.getByTestId("ci-every")).toBeDisabled();
  await expect(marlow.getByRole("textbox", { name: "Prompt" })).not.toBeEditable();
});

test("F-201: a save the host reports as not confirmed ends Saving before its command settles", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  const marlow = dialog(page, "Marlow");
  await marlow.getByRole("radio", { name: /^Every…/ }).click();
  await page.evaluate(() => {
    const w = window as unknown as { clawtrateFixture: ClawtrateBridge; heldSaveId?: string };
    const send = w.clawtrateFixture.send;
    w.clawtrateFixture.send = (command) => {
      if (command.type !== "saveCheckIn") return send(command);
      w.heldSaveId = command.saveId;
      return new Promise<void>(() => {});
    };
  });
  await marlow.getByRole("button", { name: "Save", exact: true }).click();
  await expect(marlow.getByRole("button", { name: "Saving…" })).toBeVisible();
  const id = await page.evaluate(() => (window as unknown as { heldSaveId: string }).heldSaveId);
  await change(
    page,
    `return { ...state, checkIns: { ...state.checkIns, save: { id: ${JSON.stringify(id)}, botId: "marlow", status: "unknown", error: null } } };`,
  );
  await expect(marlow.getByTestId("save-unknown")).toBeVisible();
  await expect(marlow.getByRole("button", { name: "Saving…" })).toHaveCount(0);
  await expect(marlow.getByRole("radio", { name: /^Off/ })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(marlow).toHaveCount(0);
});

test("F-201: an earlier save's late answer does not unlock a later save the host has not published", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  const marlow = dialog(page, "Marlow");
  await marlow.getByRole("radio", { name: /^Every…/ }).click();
  await page.evaluate(() => {
    const w = window as unknown as {
      clawtrateFixture: ClawtrateBridge;
      held: Array<{ saveId: string; disconnect: () => void }>;
    };
    w.held = [];
    const send = w.clawtrateFixture.send;
    w.clawtrateFixture.send = (command) =>
      command.type === "saveCheckIn"
        ? new Promise<void>((_, reject) =>
            w.held.push({
              saveId: command.saveId,
              disconnect: () => reject(new Error("Connection closed")),
            }),
          )
        : send(command);
  });
  const held = () =>
    page.evaluate(() =>
      (window as unknown as { held: Array<{ saveId: string }> }).held.map((each) => each.saveId),
    );
  const publish = (id: string) =>
    change(
      page,
      `return { ...state, checkIns: { ...state.checkIns, save: { id: ${JSON.stringify(id)}, botId: "marlow", status: "unknown", error: null } } };`,
    );
  await marlow.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(held).toHaveLength(1);
  await publish((await held())[0]!);
  await expect(marlow.getByTestId("save-unknown")).toBeVisible();
  await marlow.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(held).toHaveLength(2);
  await page.evaluate(() =>
    (window as unknown as { held: Array<{ disconnect: () => void }> }).held[0]!.disconnect(),
  );
  await expect(marlow.getByRole("button", { name: "Saving…" })).toBeVisible();
  await expect(marlow.getByRole("radio", { name: /^Off/ })).toBeDisabled();
  await publish((await held())[1]!);
  await expect(marlow.getByTestId("save-unknown")).toBeVisible();
  await expect(marlow.getByTestId("save-failed")).toHaveCount(0);
});

test("F-201: As needed sends every 30m, and the bot is then shown checking in every 30 minutes", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Otto's check-ins" }).click();
  const otto = dialog(page, "Otto");
  await otto.getByRole("radio", { name: /^As needed/ }).click();
  await otto.getByRole("button", { name: "Save", exact: true }).click();
  await expect(otto).toHaveCount(0);
  expect(await saves(page)).toEqual([
    {
      botId: "otto",
      every: "30m",
      prompt: null,
      was: NOTHING,
      kept: [{ botId: "main", every: "30m" }],
    },
  ]);
  await expect(block(page, "otto")).toContainText("Checks in every 30 minutes");
  await expect(block(page, "main")).toContainText("Checks in every 30 minutes");
});

test("F-201: a prompt edited alone sends the prompt and no cadence", async ({ page }) => {
  await openFixture(page, `${ADMIN}&checkins=daily`, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  const marlow = dialog(page, "Marlow");
  await marlow.getByText("What to check").click();
  await marlow.getByRole("textbox", { name: "Prompt" }).fill("Look at the news. Else NO_REPLY.");
  await marlow.getByRole("button", { name: "Save", exact: true }).click();
  await expect(marlow).toHaveCount(0);
  expect(await saves(page)).toEqual([
    {
      botId: "marlow",
      every: null,
      prompt: "Look at the news. Else NO_REPLY.",
      was: { every: "24h", prompt: null },
      kept: [],
    },
  ]);
  await expect(block(page, "marlow")).toContainText("Checks in daily");
});

test("F-201: a cadence changed elsewhere while the dialog is open is a conflict that keeps the draft, and saving again applies it", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&checkins=daily&cisave=conflict`, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Juniper's check-ins" }).click();
  const juniper = dialog(page, "Juniper");
  await juniper.getByRole("radio", { name: /^Off/ }).click();
  await juniper.getByText("What to check").click();
  await juniper.getByRole("textbox", { name: "Prompt" }).fill("Mine. NO_REPLY");
  await juniper.getByRole("button", { name: "Save", exact: true }).click();
  await expect(juniper.getByTestId("save-conflict")).toContainText("Its cadence was changed.");
  await expect(page.getByTestId("b-announcer")).not.toHaveText("Check-ins saved");
  await expect(block(page, "clawtrate-main-bot")).toContainText("Checks in daily");
  await expect(juniper.getByRole("radio", { name: /^Off/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(juniper.getByRole("textbox", { name: "Prompt" })).toHaveValue("Mine. NO_REPLY");
  await juniper.getByRole("button", { name: "Save", exact: true }).click();
  await expect(juniper).toHaveCount(0);
  const [first, second] = await saves(page);
  expect(first!.was).toEqual({ every: "30m", prompt: null });
  expect(second).toMatchObject({
    every: "0m",
    prompt: "Mine. NO_REPLY",
    was: { every: "24h", prompt: THEIRS },
  });
  await expect(block(page, "clawtrate-main-bot")).toContainText("No check-ins");
});

test("F-201: after a conflict on the cadence alone, saving again never sends the prompt the person left, and the dialog shows the gateway's", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&checkins=daily&cisave=conflict`, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Juniper's check-ins" }).click();
  const juniper = dialog(page, "Juniper");
  await juniper.getByRole("radio", { name: /^Off/ }).click();
  await juniper.getByRole("button", { name: "Save", exact: true }).click();
  await expect(juniper.getByTestId("save-conflict")).toContainText("Its cadence was changed.");
  await expect(juniper.getByRole("textbox", { name: "Prompt" })).toHaveValue(THEIRS);
  await juniper.getByRole("button", { name: "Save", exact: true }).click();
  await expect(juniper).toHaveCount(0);
  const [, second] = await saves(page);
  expect(second).toEqual({
    botId: "clawtrate-main-bot",
    every: "0m",
    prompt: null,
    was: { every: "24h", prompt: THEIRS },
    kept: [],
  });
});

test("F-201: the bots a dialog named are what its save sends, though the list behind it changed", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  const marlow = dialog(page, "Marlow");
  await expect(marlow.getByTestId("catch-note")).toContainText("main checks in now");
  await change(
    page,
    "return { ...state, checkIns: { ...state.checkIns, defaults: { ...state.checkIns.defaults, inherited: ['main', 'otto'] } } };",
  );
  await expect(marlow.getByTestId("catch-note")).toContainText("main checks in now");
  await marlow.getByRole("radio", { name: /^Daily/ }).click();
  await marlow.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saves(page))[0]!.kept).toEqual([{ botId: "main", every: "30m" }]);
});

test("F-201: when the bots to keep are more than one change can write, the dialog says so before Save, and Save is off", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await change(
    page,
    "return { ...state, checkIns: { ...state.checkIns, defaults: { ...state.checkIns.defaults, inherited: Array.from({ length: 33 }, (_, i) => 'b' + i), inheritedCut: true } } };",
  );
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  const marlow = dialog(page, "Marlow");
  await expect(marlow.getByTestId("catch-blocked")).toContainText("at most 32");
  await expect(marlow.getByTestId("save-conflict")).toHaveCount(0);
  await expect(marlow.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  expect(await saves(page)).toEqual([]);
});

test("F-201: a draft survives admin going and coming back, and is not shown for another gateway", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  const marlow = dialog(page, "Marlow");
  await marlow.getByRole("radio", { name: /^Daily/ }).click();
  await marlow.getByText("What to check").click();
  await marlow.getByRole("textbox", { name: "Prompt" }).fill("Kept. NO_REPLY");
  await change(page, "return { ...state, connection: { ...state.connection, canAdmin: false } };");
  await expect(marlow).toHaveCount(0);
  await change(page, "return { ...state, connection: { ...state.connection, canAdmin: true } };");
  await expect(marlow.getByRole("radio", { name: /^Daily/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(marlow.getByRole("textbox", { name: "Prompt" })).toHaveValue("Kept. NO_REPLY");
  // Another gateway now answers at the same address: its identity is not the draft's.
  await change(
    page,
    "return { ...state, connection: { ...state.connection, gatewayId: 'another' }, checkIns: { ...state.checkIns, stamp: { ...state.checkIns.stamp, gatewayId: 'another' } } };",
  );
  await expect(page.getByTestId("check-ins-dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  // A new draft, from what this gateway has.
  await expect(dialog(page, "Marlow").getByRole("radio", { name: /^Off/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(await saves(page)).toEqual([]);
});

test("F-201: check-ins read while disconnected are read again when the connection comes back, and on Refresh", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await change(
    page,
    "const { checkIns, ...rest } = state; return { ...rest, connection: { ...state.connection, status: 'reconnecting' } };",
  );
  await page.keyboard.press("ControlOrMeta+,");
  await page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("button", { name: "Check-ins", exact: true })
    .click();
  await expect(page.getByText("Reading check-ins…")).toBeVisible();
  const refreshes = async () =>
    (await sent(page)).filter((each) => each.type === "refreshCheckIns").length;
  const before = await refreshes();
  await change(
    page,
    "return { ...state, connection: { ...state.connection, status: 'connected' } };",
  );
  await expect(page.getByTestId("check-in")).toHaveCount(6);
  expect(await refreshes()).toBe(before + 1);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(refreshes).toBe(before + 2);
  // The bots arrive after the connection does: their arrival reads again.
  await change(page, "return { ...state, bots: state.bots.slice(1) };");
  await expect.poll(refreshes).toBe(before + 3);
  // A read that failed keeps the way to read again.
  await change(
    page,
    "return { ...state, checkIns: { ...state.checkIns, status: 'error', error: 'timeout' } };",
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(refreshes).toBe(before + 4);
});

test("F-201: a cadence that is not whole minutes is shown exactly", async ({ page }) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await change(
    page,
    "return { ...state, checkIns: { ...state.checkIns, jobs: state.checkIns.jobs.map((job) => ({ ...job, everyMs: 90000 })) } };",
  );
  await expect(block(page, "main")).toContainText("Checks in every 90 seconds");
  await expect(block(page, "main")).toContainText("Every 90 seconds, main looks");
});

test("F-201: an inherited custom prompt is what an empty prompt means, and no words say the bot stays quiet", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&cidefault=prompt`, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change main's check-ins" }).click();
  const own = dialog(page, "main");
  await expect(own.getByRole("radio", { name: /^As needed/ })).toContainText(
    "Every 30 minutes, main checks in with the prompt the gateway sets for every bot.",
  );
  await own.getByText("What to check").click();
  await expect(own.getByRole("textbox", { name: "Prompt" })).toHaveAttribute(
    "placeholder",
    "Look over my inbox and tell me what's new.",
  );
  // Behind the prompt's "i", and its description (#798).
  await expect(own.getByRole("textbox", { name: "Prompt" })).toHaveAccessibleDescription(
    "Empty uses the prompt the gateway sets for every bot. Up to 4,000 characters.",
  );
  await expect(own.getByTestId("prompt-note")).toHaveCount(0);
  // The built-in prompt's words are not said of a custom default.
  await own.getByRole("textbox", { name: "Prompt" }).fill("Look at the calendar.");
  await expect(own.getByTestId("prompt-note")).toHaveText(
    "This prompt replaces the gateway's default for this bot. Whether main stays quiet depends on what this prompt asks.",
  );
  await own.getByRole("textbox", { name: "Prompt" }).fill("");
  await expect(block(page, "main")).toContainText(
    "Every 30 minutes, main checks in with the prompt the gateway sets for every bot.",
  );
});

test("F-201: with the gateway's config unread, the prompt field names no prompt as the gateway's", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  // What a failed config read leaves: no settings and no defaults, the jobs still read.
  await change(
    page,
    "return { ...state, checkIns: { ...state.checkIns, settings: null, defaults: null } };",
  );
  await page.getByRole("button", { name: "Change Pip's check-ins" }).click();
  const pip = dialog(page, "Pip");
  await expect(pip.getByRole("radio", { name: /^As needed/ })).toContainText(
    "Clawtrate can't read its prompt.",
  );
  await pip.getByText("What to check").click();
  const prompt = pip.getByRole("textbox", { name: "Prompt" });
  await expect(prompt).not.toHaveAttribute("placeholder");
  await expect(prompt).toHaveAccessibleDescription(
    "Empty uses the gateway's own prompt. Up to 4,000 characters.",
  );
  await prompt.fill("Look at the calendar.");
  await expect(pip.getByTestId("prompt-note")).toHaveText(
    "This prompt replaces the gateway's default for this bot. Whether Pip stays quiet depends on what this prompt asks.",
  );
});

test("F-201: As needed says the prompt asks for quiet only for the gateway's own prompt, not for a custom one that names NO_REPLY", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Pip's check-ins" }).click();
  const pip = dialog(page, "Pip");
  const asNeeded = pip.getByRole("radio", { name: /^As needed/ });
  await expect(asNeeded).toContainText("stay quiet");
  await pip.getByText("What to check").click();
  await pip.getByRole("textbox", { name: "Prompt" }).fill("Always answer; never reply NO_REPLY.");
  await expect(asNeeded).toHaveText(/Every 30 minutes, Pip checks in with a prompt of its own\.$/);
});

const ROUTINES = "scene=main&routines=on&access=admin";
const routinesView = (page: Page) => page.getByTestId("routines-view");

async function openRoutines(page: Page, query: string) {
  await openFixture(page, query, "light");
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(routinesView(page).getByTestId("routine-row").first()).toBeVisible();
}

const group = (page: Page, name: string) =>
  routinesView(page)
    .locator(".r-group")
    .filter({ has: page.getByRole("heading", { name }) })
    .getByTestId("check-in-summary");

test("F-201: in the list across bots, each group head says the bot's check-ins", async ({
  page,
}) => {
  await openRoutines(page, `${ROUTINES}&checkins=daily`);
  await expect(group(page, "Juniper")).toHaveText("Checks in every 30 minutes");
  await expect(group(page, "Marlow")).toHaveText("Checks in daily");
  await expect(group(page, "Otto")).toHaveText("No check-ins");
  await expect(group(page, "Pip")).toHaveText("No check-ins");
  // A bot the client does not hold is named by id, and its check-ins are not claimed.
  await expect(
    routinesView(page)
      .locator(".r-group", { hasText: "ledger" })
      .locator('[data-testid="check-in-summary"]'),
  ).toHaveCount(0);
});

test("F-201: All bots reads a newly discovered bot's check-ins before showing its cadence", async ({
  page,
}) => {
  await openFixture(page, `${ROUTINES}&checkins=daily`, "light");
  type Fixture = {
    clawtrateFixture: ClawtrateBridge & {
      setState(change: (state: ClawtrateState) => ClawtrateState): void;
    };
  };
  const marlow = await page.evaluate(() => {
    const { clawtrateFixture } = window as unknown as Fixture;
    const bot = clawtrateFixture.getState().bots.find((bot) => bot.id === "marlow")!;
    clawtrateFixture.setState((state) => ({
      ...state,
      bots: state.bots.filter((each) => each.id !== bot.id),
    }));
    return bot;
  });
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(group(page, "Juniper")).toHaveText("Checks in every 30 minutes");

  const read = Promise.withResolvers<void>();
  await page.exposeFunction("waitForCheckInRead", () => read.promise);
  await page.evaluate((bot) => {
    const { clawtrateFixture, waitForCheckInRead } = window as unknown as Fixture & {
      waitForCheckInRead: () => Promise<void>;
    };
    const { send } = clawtrateFixture;
    clawtrateFixture.send = async (command) => {
      if (command.type === "refreshCheckIns") await waitForCheckInRead();
      return send(command);
    };
    clawtrateFixture.setState((state) => ({ ...state, bots: [...state.bots, bot] }));
  }, marlow);
  await expect(routinesView(page).getByRole("heading", { name: "Marlow" })).toBeVisible();
  await expect(group(page, "Marlow")).toHaveCount(0);
  read.resolve();
  await expect(group(page, "Marlow")).toHaveText("Checks in daily");
});

test("F-201: one bot's routines show its check-ins block first, and with admin Change opens the dialog from Routines", async ({
  page,
}) => {
  await openRoutines(page, `${ROUTINES}&checkins=daily`);
  await routinesView(page).getByRole("combobox", { name: "Bots" }).selectOption({
    label: "Marlow",
  });
  const section = routinesView(page).getByTestId("routines-check-ins");
  // The block above the routines, from the confirmed heartbeat job, read-only.
  const block = section.getByTestId("check-in").filter({ hasText: "Marlow" });
  await expect(block.getByTestId("check-in-text")).toContainText(
    "Once a day, Marlow looks for anything that needs you.",
  );
  // Nothing here changes anything: the cadence is the gateway's job, shown read-only.
  await expect(section.locator("input, textarea, [role='switch']")).toHaveCount(0);
  await section.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  const dialog = page.getByRole("dialog", { name: "Marlow's check-ins" });
  await expect(dialog.getByRole("radio", { name: /^Daily/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("F-201: below admin, one bot's check-ins in Routines are read-only, with no Change", async ({
  page,
}) => {
  await openRoutines(page, "scene=main&routines=on&checkins=daily");
  await routinesView(page).getByRole("combobox", { name: "Bots" }).selectOption({
    label: "Marlow",
  });
  const section = routinesView(page).getByTestId("routines-check-ins");
  await expect(
    section.getByTestId("check-in").filter({ hasText: "Marlow" }).getByTestId("check-in-text"),
  ).toContainText("Once a day, Marlow");
  await expect(section.getByRole("button", { name: "Change Marlow's check-ins" })).toHaveCount(0);
});

test("F-201: on an OpenClaw that keeps check-ins as routines, Check-ins say so, change nothing, and lead to the bot's routines", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&routines=on&checkins=routines`, "light");
  await checkIns(page);
  const marlow = block(page, "marlow");
  await expect(marlow.getByTestId("check-in-text")).toHaveText(
    "This OpenClaw keeps check-ins as routines. Marlow's routines",
  );
  // No setting is read, so none is shown as Off, and nothing offers a change.
  await expect(page.getByText("No check-ins")).toHaveCount(0);
  await expect(page.getByText(/doesn't check in/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Change .*'s check-ins$/ })).toHaveCount(0);
  await marlow.getByRole("button", { name: "Marlow's routines" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
  await expect(routinesView(page).getByRole("combobox", { name: "Bots" })).toHaveValue("marlow");
  // There, the block above Marlow's routines says the same, with no link to where it is.
  const section = routinesView(page).getByTestId("routines-check-ins");
  await expect(section.getByTestId("check-in-text")).toHaveText(
    "This OpenClaw keeps check-ins as routines.",
  );
  await expect(section.getByRole("button")).toHaveCount(1);
  await expect(section.getByRole("button", { name: "Refresh" })).toBeVisible();
  expect((await sent(page)).filter((each) => each.type === "saveCheckIn")).toEqual([]);
});

test("F-201: leaving a bot's routines opened from Settings' Check-ins puts focus on the rail's Routines button", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&routines=on&checkins=routines`, "light");
  await checkIns(page);
  // By keyboard, as a person who can't use a pointer would.
  await block(page, "marlow").getByRole("button", { name: "Marlow's routines" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
  await routinesView(page).getByRole("button", { name: "Back to conversation" }).click();
  await expect(routinesView(page)).toHaveCount(0);
  // The link that opened Routines closed with Settings: focus goes to a live control, not the page.
  await expect(page.locator(".rail").getByRole("button", { name: "Routines" })).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("F-201: an open dialog closes when the gateway, updated while it was open, keeps check-ins as routines, and nothing is saved", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&checkins=updated`, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  const marlow = dialog(page, "Marlow");
  await marlow.getByRole("radio", { name: /^Daily/ }).click();
  // The gateway restarts on its new version: the connection drops and comes back, and is read again.
  await change(
    page,
    "return { ...state, connection: { ...state.connection, status: 'reconnecting' } };",
  );
  await change(
    page,
    "return { ...state, connection: { ...state.connection, status: 'connected' } };",
  );
  await expect(block(page, "marlow").getByTestId("check-in-text")).toHaveText(
    "This OpenClaw keeps check-ins as routines. Marlow's routines",
  );
  await expect(page.getByTestId("check-ins-dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Change .*'s check-ins$/ })).toHaveCount(0);
  expect(await saves(page)).toEqual([]);
});

test("F-201: below admin, on an OpenClaw that keeps check-ins as routines, nothing asks for admin to change them", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=read&checkins=routines`, "light");
  await checkIns(page);
  await expect(block(page, "marlow").getByTestId("check-in-text")).toContainText(
    "This OpenClaw keeps check-ins as routines.",
  );
  await expect(page.getByTestId("admin-bar")).toHaveCount(0);
  await expect(page.getByText("Changing check-ins needs admin access.")).toHaveCount(0);
});

test("F-201: on an OpenClaw that keeps check-ins as routines, no group head claims a bot's check-ins", async ({
  page,
}) => {
  await openRoutines(page, `${ROUTINES}&checkins=routines`);
  await expect(routinesView(page).getByRole("heading", { name: "Marlow" })).toBeVisible();
  await expect(routinesView(page).locator('[data-testid="check-in-summary"]')).toHaveCount(0);
});

test("F-201: in the list across bots, a group head claims no check-ins before they are read", async ({
  page,
}) => {
  await openRoutines(page, `${ROUTINES}&checkins=daily`);
  await expect(group(page, "Marlow")).toHaveText("Checks in daily");
  await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState: (f: (s: Record<string, unknown>) => unknown) => void };
      }
    ).clawtrateFixture;
    fixture.setState((state) => ({
      ...state,
      checkIns: { ...(state.checkIns as object), status: "loading" },
    }));
  });
  await expect(routinesView(page).locator('[data-testid="check-in-summary"]')).toHaveCount(0);
});
