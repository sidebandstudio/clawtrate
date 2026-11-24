import { expect, test, type Page } from "@playwright/test";
import type { BridgeCommand, ClawtrateBridge } from "../packages/core/src/bridge.ts";
import type { ClawtrateState } from "../packages/core/src/types.ts";
import { openFixture, OTTO_DISK } from "./fixture.ts";

type Attempt = Extract<BridgeCommand, { type: "sendMessage" | "createTask" }>;
type Controls = {
  clawtrateFixture: {
    invoke(command: BridgeCommand): Promise<unknown>;
    attach: ClawtrateBridge["attach"];
    setState(change: (state: ClawtrateState) => ClawtrateState): void;
  };
  attempts: Attempt[];
  uploaded: string[];
  finish: () => void;
  finishUpload: () => void;
};

const field = (page: Page) => page.getByTestId("composer-input");
const chipNames = (page: Page) => page.locator(".composer .attachments .chip b");
const attempts = (page: Page) => page.evaluate(() => (window as unknown as Controls).attempts);
const finish = (page: Page) => page.evaluate(() => (window as unknown as Controls).finish());

async function open(page: Page) {
  await openFixture(page, `scene=composer&${OTTO_DISK}&panel=closed`, "light");
  await page.evaluate(() => {
    const controls = window as unknown as Controls;
    const fixture = controls.clawtrateFixture;
    const invoke = fixture.invoke.bind(fixture);
    const attach = fixture.attach.bind(fixture);
    controls.attempts = [];
    controls.uploaded = [];
    fixture.attach = async (file) => {
      const info = await attach(file);
      controls.uploaded.push(info.id);
      return info;
    };
    fixture.invoke = (command) => {
      if (command.type !== "sendMessage" && command.type !== "createTask") return invoke(command);
      controls.attempts.push(command);
      if (controls.attempts.length !== 1) return invoke(command);
      return new Promise((resolve, reject) => {
        controls.finish = () =>
          command.type === "sendMessage"
            ? reject(new Error("Host refused before enqueue."))
            : resolve(invoke(command));
      });
    };
  });
}

async function switchTask(page: Page, name: "Disk almost full" | "Weekly backup check") {
  await page.getByTestId("task").filter({ hasText: name }).first().click();
  await expect(page.locator(".conversation-header")).toContainText(name);
}

async function session(page: Page, sessionId: string) {
  await page.evaluate((id) => {
    const key = "agent:otto:disk-space";
    (window as unknown as Controls).clawtrateFixture.setState((state) => ({
      ...state,
      transcripts: { ...state.transcripts, [key]: { ...state.transcripts[key]!, sessionId: id } },
    }));
  }, sessionId);
}

function pickFile(page: Page, name: string) {
  return page.locator('.composer input[type="file"]').setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from(name),
  });
}

test("F-278: a file-only refusal while away retries with the same host ID, only in its original session", async ({
  page,
}) => {
  await open(page);
  await pickFile(page, "original.txt");
  await expect(page.getByTestId("send")).toBeEnabled();
  await field(page).press("Enter");
  await expect(chipNames(page)).toHaveCount(0);
  await switchTask(page, "Weekly backup check");
  await finish(page);
  await expect(chipNames(page)).toHaveCount(0);
  await switchTask(page, "Disk almost full");
  await expect(chipNames(page)).toHaveText(["original.txt"]);
  await switchTask(page, "Weekly backup check");
  await expect(chipNames(page)).toHaveCount(0);
  await switchTask(page, "Disk almost full");
  await expect(chipNames(page)).toHaveText(["original.txt"]);
  await expect(field(page)).toHaveValue("");
  await session(page, "replacement");
  await expect(page.getByTestId("send")).toBeDisabled();
  await field(page).press("Enter");
  await page.getByRole("button", { name: "Start a new task with this message" }).click();
  expect(await attempts(page)).toHaveLength(1);
  await session(page, "otto-disk-space");
  await page.getByTestId("send").click();
  const uploaded = await page.evaluate(() => (window as unknown as Controls).uploaded);
  expect(uploaded).toHaveLength(1);
  const sent = await attempts(page);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[1]).toMatchObject({
    type: "sendMessage",
    key: "agent:otto:disk-space",
    text: "",
    attachmentIds: uploaded,
    sessionId: "otto-disk-space",
  });
  await expect(chipNames(page)).toHaveCount(0);
  await expect(page.getByTestId("outgoing")).toContainText("original.txt");
  await switchTask(page, "Weekly backup check");
  await switchTask(page, "Disk almost full");
  await expect(chipNames(page)).toHaveCount(0);
});

test("F-278 F-071: a recovered command survives task switches until it is removed", async ({
  page,
}) => {
  await open(page);
  await field(page).fill("/status");
  await page.getByRole("option", { name: /\/status/ }).click();
  await field(page).press("Enter");
  await expect(page.getByTestId("token-chip")).toHaveCount(0);
  await finish(page);
  await expect(page.getByTestId("token-chip")).toHaveText(/\/status/);
  await switchTask(page, "Weekly backup check");
  await expect(page.getByTestId("token-chip")).toHaveCount(0);
  await switchTask(page, "Disk almost full");
  const chip = page.getByTestId("token-chip");
  await expect(chip).toHaveText(/\/status/);
  await chip.getByRole("button").click();
  await switchTask(page, "Weekly backup check");
  await switchTask(page, "Disk almost full");
  await expect(chip).toHaveCount(0);
  expect(await attempts(page)).toHaveLength(1);
});

test("F-278 F-071: the remounted composer restores refused chips and files ahead of newer edits", async ({
  page,
}) => {
  await open(page);
  await field(page).fill("/status");
  await page.getByRole("option", { name: /\/status/ }).click();
  await pickFile(page, "first.txt");
  await expect(page.getByTestId("send")).toBeEnabled();
  await field(page).fill("First words.");
  await field(page).press("Enter");
  await expect(field(page)).toHaveValue("");
  await switchTask(page, "Weekly backup check");
  await expect(page.getByTestId("token-chip")).toHaveCount(0);
  await switchTask(page, "Disk almost full");
  await field(page).fill("/weather");
  await page.getByRole("option", { name: /\/weather/ }).click();
  await pickFile(page, "second.txt");
  await field(page).fill("Later words.");
  await finish(page);
  await expect(field(page)).toHaveValue("First words.\nLater words.");
  await expect(chipNames(page)).toHaveText(["first.txt", "second.txt"]);
  await expect(page.getByTestId("token-chip").locator("b")).toHaveText(["/status", "/weather"]);
  const stored = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) => key.startsWith("clawtrate.composerDraft."));
    return key ? JSON.parse(localStorage.getItem(key)!) : null;
  });
  expect(stored).toEqual({ text: "First words.\nLater words.", sessionId: "otto-disk-space" });
  await field(page).press("Enter");
  const uploaded = await page.evaluate(() => (window as unknown as Controls).uploaded);
  expect(uploaded).toHaveLength(2);
  expect(await attempts(page)).toMatchObject([
    { text: "/status First words.", attachmentIds: [uploaded[0]] },
    { text: "/status /weather First words.\nLater words.", attachmentIds: uploaded },
  ]);
});

test("F-278 F-071: reopening during a handoff does not duplicate a reselected skill or a pending upload", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    const controls = window as unknown as Controls;
    const fixture = controls.clawtrateFixture;
    const attach = fixture.attach.bind(fixture);
    const gate = new Promise<void>((resolve) => {
      controls.finishUpload = resolve;
    });
    fixture.attach = (file) => gate.then(() => attach(file));
  });
  const chooseSkill = async () => {
    await field(page).fill("/weather");
    await page.getByRole("option", { name: /\/weather/ }).click();
  };
  await chooseSkill();
  await field(page).press("Enter");
  await expect(page.getByTestId("token-chip")).toHaveCount(0);
  await chooseSkill();
  await pickFile(page, "later.txt");
  await expect(page.locator('.attachments [aria-busy="true"]')).toHaveCount(1);
  await switchTask(page, "Weekly backup check");
  await finish(page);
  await switchTask(page, "Disk almost full");
  await expect(page.getByTestId("token-chip").locator("b")).toHaveText(["/weather"]);
  await page.evaluate(() => (window as unknown as Controls).finishUpload());
  await page.getByTestId("send").click();
  const uploaded = await page.evaluate(() => (window as unknown as Controls).uploaded);
  expect(uploaded).toHaveLength(1);
  expect(await attempts(page)).toMatchObject([
    { text: "/weather", attachmentIds: [] },
    { text: "/weather", attachmentIds: uploaded },
  ]);
});

test("F-278: late new-task success leaves identical words retyped for the replacement session", async ({
  page,
}) => {
  await open(page);
  await field(page).fill("Same words.");
  await session(page, "replacement");
  await page.getByRole("button", { name: "Start a new task with this message" }).click();
  await expect
    .poll(() => attempts(page))
    .toMatchObject([{ type: "createTask", text: "Same words." }]);
  await switchTask(page, "Weekly backup check");
  await switchTask(page, "Disk almost full");
  await field(page).fill("");
  await field(page).fill("Same words.");
  await finish(page);
  await expect(page.getByTestId("announcer")).toContainText("Started as a new task");
  await expect(field(page)).toHaveValue("Same words.");
  await page.getByTestId("send").click();
  expect(await attempts(page)).toMatchObject([
    { type: "createTask" },
    { type: "sendMessage", text: "Same words.", sessionId: "replacement" },
  ]);
});
