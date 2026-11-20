// Setting up on this computer, on fixed state (docs/design/setup.md §3, §6,
// §7, §16): what the first screen asks, where each answer leads, the
// keyboard and the screen reader. The same walk runs against a real
// development gateway in e2e/setup.spec.ts.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, SIZES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
test.use(contextFor(WIDE, "light"));

const sent = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: Array<{ type: string }> } }
    ).clawtrateFixture.sent.map((command) => command.type),
  );

const rows = (page: Page) =>
  page.getByRole("list", { name: "Where does OpenClaw run?" }).getByRole("button");

test("F-491: the first screen asks where OpenClaw runs, with two answers and Advanced, and no form", async ({
  page,
}) => {
  await openFixture(page, "setup=first", "light");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Clawtrate");
  await expect(page.getByText("Your OpenClaw agents, orchestrated.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Where does OpenClaw run?" })).toBeVisible();
  await expect(rows(page)).toHaveText([
    "This computerClawtrate looks for OpenClaw here.",
    "Another computerA computer you reach with SSH, such as a server or a desktop at home.",
  ]);
  await expect(page.getByRole("button", { name: "Advanced" })).toBeVisible();
  await expect(page.getByPlaceholder("Gateway address")).toHaveCount(0);
  await expect(page.getByPlaceholder("Token, for the first pairing only")).toHaveCount(0);
});

test("F-491: Up, Down, Home and End move between the two answers", async ({ page }) => {
  await openFixture(page, "setup=first", "light");
  await rows(page).first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(rows(page).nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(rows(page).nth(0)).toBeFocused();
  await page.keyboard.press("End");
  await expect(rows(page).nth(1)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(rows(page).nth(0)).toBeFocused();
});

test("F-491 F-492: This computer starts the look at once; the steps run, then the gateway found is named, and its title takes focus", async ({
  page,
}) => {
  await openFixture(page, "setup=first", "light");
  await rows(page).first().click();
  expect(await sent(page)).toContain("setupLook");
  await expect(page.getByRole("heading", { name: "Looking on this computer" })).toBeVisible();
  const steps = page.getByRole("list", { name: "Steps" }).getByRole("listitem");
  await expect(steps).toHaveText([
    "Finding OpenClaw",
    "Checking its version",
    "Asking the gateway",
  ]);
  const title = page.getByRole("heading", { name: "On this computer" });
  await expect(title).toBeFocused();
  await expect(page.getByRole("heading", { name: "OpenClaw is running" })).toBeVisible();
  const facts = page.getByTestId("setup-found").locator("dl > div");
  await expect(facts).toHaveText([
    "Version2026.10.6",
    "Profiledefault",
    "ListensOn this computer only",
    "ServiceLaunchAgent, starts when you log in",
  ]);
  await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();
});

test("F-491: a screen reader hears each step's state, and the running step is the current one", async ({
  page,
}) => {
  await openFixture(page, "setup=looking", "light");
  const steps = page.getByRole("list", { name: "Steps" }).getByRole("listitem");
  await expect(steps.nth(0)).toHaveAttribute("aria-label", "Finding OpenClaw, done");
  await expect(steps.nth(1)).toHaveAttribute("aria-label", "Checking its version, running");
  await expect(steps.nth(1)).toHaveAttribute("aria-current", "step");
  await expect(steps.nth(2)).toHaveAttribute("aria-label", "Asking the gateway, waiting");
  await expect(page.locator("[aria-live=polite]").last()).toHaveText("Looking on this computer");
});

test("F-492: Connect asks the host and shows its steps; nothing in the page takes a token", async ({
  page,
}) => {
  await openFixture(page, "setup=found", "light");
  await expect(
    page.getByText(
      "Clawtrate asks for read access. The gateway may ask its owner to approve this device.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Connect read-only" }).click();
  expect(await sent(page)).toEqual(["setupConnect"]);
  await expect(page.getByRole("heading", { name: "Connecting" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Steps" }).getByRole("listitem")).toHaveText([
    "Making a one-time code",
    "Requesting read access",
    "Loading your bots",
  ]);
  await expect(page.locator("input")).toHaveCount(0);
  // The app opens, read-only.
  await expect(page.getByTestId("bot-list")).toBeVisible();
});

test("F-492: Back during Connect, and Escape, return to what the look found", async ({ page }) => {
  await openFixture(page, "setup=connecting", "light");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "OpenClaw is running" })).toBeVisible();
  expect(await sent(page)).toEqual(["setupCancel"]);
  await openFixture(page, "setup=looking", "light");
  await page.getByRole("heading", { name: "Looking on this computer" }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Where does OpenClaw run?" })).toBeVisible();
  expect(await sent(page)).toEqual(["setupCancel"]);
});

test("F-492: each failure of Connect is its own titled note, with its own next step", async ({
  page,
}) => {
  const cases: Array<[string, RegExp, string]> = [
    ["code-failed", /Couldn't make a one-time code\. OpenClaw exited with code 1\./, "Try again"],
    ["code-refused", /The one-time code didn't work\. Clawtrate makes a new one/, "Try again"],
    [
      "grant",
      /The gateway granted something other than read access, so Clawtrate disconnected\./,
      "Back",
    ],
    [
      "unreachable",
      /Nothing answered on port 18789\. The gateway may have just stopped\./,
      "Look again",
    ],
    ["changed", /This changed since you looked\. Look again\./, "Look again"],
  ];
  for (const [state, text, next] of cases) {
    await openFixture(page, `setup=${state}`, "light");
    const note = page.getByRole("alert");
    await expect(note).toHaveText(text);
    await expect(page.getByRole("button", { name: next, exact: true }).last()).toBeVisible();
  }
});

test("F-515: another version is named, offers Advanced and how to update, and no Connect", async ({
  page,
}) => {
  await openFixture(page, "setup=untested", "light");
  await expect(page.getByRole("status").filter({ hasText: "2026.9.37" })).toHaveText(
    "OpenClaw 2026.9.37 isn't the version this Clawtrate is tested with (2026.10.6). Use Advanced to connect to it.",
  );
  await expect(page.getByRole("button", { name: "Connect" })).toHaveCount(0);
  await page.getByText("How to update").click();
  await expect(page.locator(".command code")).toHaveText("openclaw update");
  await page.getByRole("button", { name: "Use Advanced" }).click();
  await expect(page.getByPlaceholder("Gateway address")).toBeVisible();
  expect(await sent(page)).toEqual(["setupReset"]);
  await openFixture(page, "setup=too-old", "light");
  await expect(
    page.getByRole("heading", { name: "This OpenClaw is too old for Clawtrate" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect" })).toHaveCount(0);
});

test("F-516: other services and profiles are named, and Advanced is offered for them", async ({
  page,
}) => {
  await openFixture(page, "setup=found-others", "light");
  await expect(page.getByRole("status").filter({ hasText: "also saw" })).toHaveText(
    "Clawtrate also saw other OpenClaw services here (service com.example.openclaw-gateway, profile work). It connects only to the default gateway and its own; use Advanced for others.",
  );
  await page.getByRole("button", { name: "Advanced" }).click();
  await expect(page.getByPlaceholder("Gateway address")).toBeVisible();
});

test("F-515: a gateway that refuses the handshake for its protocol is not connected to, and says what to do", async ({
  page,
}) => {
  await openFixture(page, "scene=protocol-mismatch", "light");
  const notice = page.getByTestId("protocol-notice");
  await expect(notice.getByRole("heading")).toHaveText("This gateway speaks another protocol");
  await expect(notice).toContainText("Update the one that is older, then retry.");
  await expect(page.getByTestId("bot-list")).toHaveCount(0);
});

test("F-493: Advanced is the address-and-token form as it was, and Back returns to the question", async ({
  page,
}) => {
  await openFixture(page, "setup=first", "light");
  await page.getByRole("button", { name: "Advanced" }).click();
  await expect(page.getByPlaceholder("Gateway address")).toBeVisible();
  await expect(page.getByPlaceholder("Token, for the first pairing only")).toHaveAttribute(
    "type",
    "password",
  );
  await expect(page.getByRole("button", { name: "Connect a gateway" })).toBeVisible();
  await page.getByPlaceholder("Gateway address").fill("ws://127.0.0.1:18789");
  await page.getByRole("button", { name: "Connect a gateway" }).click();
  expect(await sent(page)).toEqual(["connect"]);
  await openFixture(page, "setup=first", "light");
  await page.getByRole("button", { name: "Advanced" }).click();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "Where does OpenClaw run?" })).toBeVisible();
});

test("Another computer leads to Advanced until reaching it over SSH is built", async ({ page }) => {
  await openFixture(page, "setup=first", "light");
  await rows(page).nth(1).click();
  await expect(page.getByRole("heading", { name: "Another computer" })).toBeFocused();
  await page.getByRole("button", { name: "Use Advanced" }).click();
  await expect(page.getByPlaceholder("Gateway address")).toBeVisible();
});

test("On Windows, This computer leads to the Windows card, which runs nothing and offers Advanced", async ({
  page,
}) => {
  await openFixture(page, "setup=windows", "light");
  await expect(page.getByRole("heading", { name: "Use Advanced on Windows" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use Advanced" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use another computer" })).toBeVisible();
});

test("F-492: a device with a saved pairing is told it has one for this address, and Connect still asks for read", async ({
  page,
}) => {
  await openFixture(page, "setup=found-paired", "light");
  await expect(
    page.getByText(
      "This device has a saved pairing for this address. Clawtrate asks for read access.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect read-only" })).toBeVisible();
  await expect(page.getByText(/can also send|already paired/)).toHaveCount(0);
});

test("F-516: a bind or a service the look didn't establish is not reported", async ({ page }) => {
  await openFixture(page, "setup=found-not-reported", "light");
  const facts = page.getByTestId("setup-found").locator("dl > div");
  await expect(facts.nth(2)).toHaveText("ListensNot reported");
  await expect(facts.nth(3)).toHaveText("ServiceNot reported");
  await openFixture(page, "setup=stopped-by-hand", "light");
  await expect(page.getByTestId("setup-found").locator("dl > div").nth(1)).toHaveText(
    "ServiceNone registered",
  );
  await expect(page.getByText(/started by hand/)).toHaveCount(0);
});

test("a program that couldn't be started has its own card", async ({ page }) => {
  await openFixture(page, "setup=cant-run", "light");
  await expect(
    page.getByRole("heading", { name: "Clawtrate couldn't run OpenClaw here" }),
  ).toBeVisible();
  await expect(page.getByText(/answered in a way/)).toHaveCount(0);
});

test("F-492 F-516: a gateway whose answer Clawtrate couldn't place is not offered, and leads to Advanced", async ({
  page,
}) => {
  await openFixture(page, "setup=endpoint", "light");
  await expect(page.getByText(/couldn't confirm where this gateway answers/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Use Advanced" })).toBeVisible();
});

test("F-515: the too-old card speaks of the version it read, and of no protocol", async ({
  page,
}) => {
  await openFixture(page, "setup=too-old", "light");
  await expect(
    page.getByText(
      /OpenClaw 2026\.6\.2 is older than the oldest version this Clawtrate connects to \(2026\.7\.0\)/,
    ),
  ).toBeVisible();
  await expect(page.getByText(/protocol/)).toHaveCount(0);
});

test("a refused sandbox says why it was refused", async ({ page }) => {
  const lead = "This run can only look in a sandbox. Clawtrate couldn't use this sandbox because";
  for (const [state, why] of [
    [
      "refused",
      "its description isn't in a private run folder of its own, or has the wrong shape.",
    ],
    ["refused-home", "its home and working folder must be outside the account's home."],
    ["refused-state", "its state folder or config didn't pass the run's checks."],
    ["refused-missing", "none was given to this run."],
  ] as const) {
    await openFixture(page, `setup=${state}`, "light");
    await expect(page.getByText(`${lead} ${why} Use Advanced.`)).toBeVisible();
  }
  await expect(page.getByText(/would reach/)).toHaveCount(0);
});

test("connected, with bots that couldn't be read, says so and doesn't open the app", async ({
  page,
}) => {
  await openFixture(page, "setup=bots", "light");
  await expect(page.getByRole("alert")).toHaveText(
    /Connected, but Clawtrate couldn't read your bots\./,
  );
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByTestId("bot-list")).toHaveCount(0);
});
