// The picture picker (docs/design/bots.md, sections 3 and 8): New bot sends
// the chosen creature inside its picture and the new bot is drawn as it; the
// person's own picture instead; and Edit picture from the Work pane on admin.
import { AVATAR_COLORS, choiceFromPicture, defaultAvatar } from "../packages/core/src/avatar.ts";
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, SIZES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const ADMIN = `scene=main&${OTTO_DISK}&access=admin`;

test.use(contextFor(WIDE, "dark"));

const sent = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: Array<Record<string, unknown>> } }
    ).clawtrateFixture.sent.map((each) => ({ ...each })),
  );
/**
 * Let what a released gate starts finish: its promise settles in microtasks, then a task and two
 * frames pass, so its callbacks and the renders they cause are done before the check looks.
 */
const settled = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) =>
        setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => done())), 0),
      ),
  );
const row = (page: Page, name: string) =>
  page.getByTestId("bot").filter({ has: page.getByText(name, { exact: true }) });

/** A small PNG, drawn in the page. */
const pngFile = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 200;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#3f6f8f";
    ctx.fillRect(0, 0, 300, 200);
    ctx.fillStyle = "#f3d9a4";
    ctx.fillRect(100, 50, 100, 100);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });

test("F-035: New bot picks a family, its parts and a colour, and the new bot is drawn as that creature", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "dark");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill("Viral");
  // Each family offers its own parts.
  await expect(page.getByRole("radiogroup", { name: "Claws" })).toBeVisible();
  await page.getByRole("radio", { name: "Lanterns" }).click();
  await expect(page.getByRole("radiogroup", { name: "Claws" })).toHaveCount(0);
  for (const group of ["Body", "Lure", "Eyes", "Colour"])
    await expect(page.getByRole("radiogroup", { name: group })).toBeVisible();
  await page.getByRole("radio", { name: "Wave" }).click();
  await page.getByRole("radio", { name: "One eye" }).click();
  await page.getByRole("radio", { name: "Lime" }).click();
  // The live picture follows every choice.
  const preview = page.getByRole("img", { name: "Viral's picture" });
  await expect(preview.locator("svg")).toHaveAttribute("data-family", "lantern");
  await expect(preview.locator('[data-part="body"]')).toHaveAttribute("fill", "#a5d955");
  await expect(preview.locator('[data-part="eye"]')).toHaveCount(1);
  await page
    .getByTestId("new-bot")
    .locator(".b-body")
    .evaluate((body) => (body.scrollTop = 0));
  await expect(page).toHaveScreenshot("avatar-picker-new-bot-dark.png");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Work/ }).click();
  await page.getByTestId("create").click();
  await expect(page.getByTestId("new-bot")).toHaveCount(0);
  // The picture sent carries the choice, and the bot comes back drawn as that creature.
  const create = (await sent(page)).find((each) => each.type === "createBot")!;
  expect(String(create.avatar)).toMatch(/^data:image\/png;base64,/);
  expect(choiceFromPicture(String(create.avatar))).toEqual({
    family: "lantern",
    body: "round",
    lure: "wave",
    eyes: "one",
    color: "lime",
  });
  await expect(row(page, "Viral").locator('svg.creature[data-family="lantern"]')).toBeVisible();
  await expect(row(page, "Viral").locator("img")).toHaveCount(0);
});

test("F-035: left untouched, New bot sends no picture and the new bot gets the Clawling its id gives", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "dark");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill("Viral");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Work/ }).click();
  await page.getByTestId("create").click();
  await expect(page.getByTestId("new-bot")).toHaveCount(0);
  const create = (await sent(page)).find((each) => each.type === "createBot")!;
  expect(create.avatar).toBeNull();
  // The fixture makes the bot "viral"; its Clawling comes from that id, not from the example shown.
  const own = defaultAvatar("viral");
  const creature = row(page, "Viral").locator("svg.creature");
  await expect(creature).toHaveAttribute("data-family", "clawling");
  await expect(creature.locator('[data-part="body"]')).toHaveAttribute(
    "fill",
    AVATAR_COLORS[own.color],
  );
  await expect(creature.locator('[data-part="eye"]')).toHaveCount(
    own.family === "clawling" && own.eyes === "single" ? 1 : 2,
  );
});

test("F-035: the person's own picture replaces the creature; a file of 25 MB or more is refused", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "dark");
  await page.keyboard.press("ControlOrMeta+n");
  const file = page.getByTestId("picture-file");
  await file.setInputFiles({
    name: "huge.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(25 * 1024 * 1024),
  });
  await expect(page.getByRole("alert")).toHaveText("Choose an image under 25 MB.");
  await expect(page.getByTestId("picture-preview").locator("svg")).toBeVisible();
  await file.setInputFiles({
    name: "mine.png",
    mimeType: "image/png",
    buffer: Buffer.from(await pngFile(page), "base64"),
  });
  const picture = page.getByTestId("picture-preview").locator("img");
  await expect(picture).toHaveAttribute("src", /^data:image\/png;base64,/);
  expect(choiceFromPicture(await picture.getAttribute("src"))).toBeNull();
  // Choosing a creature again puts the creature back.
  await page.getByRole("button", { name: "Use the creature" }).click();
  await expect(page.getByTestId("picture-preview").locator("svg")).toBeVisible();
});

test("F-035: a rotated JPEG keeps its orientation in the picture preview", async ({ page }) => {
  await openFixture(page, ADMIN, "dark");
  await page.keyboard.press("ControlOrMeta+n");
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 32;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, 24, 32);
    ctx.fillStyle = "blue";
    ctx.fillRect(24, 0, 24, 32);
    return canvas.toDataURL("image/jpeg").split(",")[1]!;
  });
  const jpeg = Buffer.from(encoded, "base64");
  // EXIF orientation 6 tells the decoder to turn the stored image 90 degrees clockwise.
  const orientation = Buffer.from(
    "ffe100224578696600004d4d002a00000008000101120003000000010006000000000000",
    "hex",
  );
  await page.getByTestId("picture-file").setInputFiles({
    name: "portrait.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.concat([jpeg.subarray(0, 2), orientation, jpeg.subarray(2)]),
  });
  const preview = page.getByTestId("picture-preview").locator("img");
  await expect(preview).toBeVisible();
  const colors = await preview.evaluate(async (image: HTMLImageElement) => {
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 2;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0, 1, 2);
    const pixels = ctx.getImageData(0, 0, 1, 2).data;
    return { redOnTop: pixels[0]! > pixels[2]!, blueBelow: pixels[6]! > pixels[4]! };
  });
  expect(colors).toEqual({ redOnTop: true, blueBelow: true });
});

test("F-037: on admin the Work pane's picture opens Edit picture; Save sends it and the bot is drawn anew", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&panel=open`, "dark");
  const change = page.getByRole("button", { name: "Change Otto's picture" });
  await change.click();
  const dialog = page.getByTestId("edit-picture");
  await expect(dialog.getByRole("heading", { name: "Otto's picture" })).toBeFocused();
  // It starts from the bot's picture as it is: its own Clawling.
  await expect(dialog.getByRole("radio", { name: "Clawlings" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await dialog.getByRole("radio", { name: "Shellfolk" }).click();
  await dialog.getByRole("radio", { name: "Turret" }).click();
  await dialog.getByRole("radio", { name: "Pink" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  const saved = (await sent(page)).find((each) => each.type === "setBotPicture")!;
  expect(saved.botId).toBe("otto");
  expect(choiceFromPicture(String(saved.avatar))).toEqual({
    family: "shellfolk",
    shell: "turret",
    color: "pink",
  });
  await expect(row(page, "Otto").locator('svg.creature[data-family="shellfolk"]')).toBeVisible();
  await expect(page.locator('.work-hero svg.creature[data-family="shellfolk"]')).toBeVisible();
  // Escape focus returns to the picture it opened from.
  await change.click();
  await page.keyboard.press("Escape");
  await expect(change).toBeFocused();
});

test("F-037: below admin the Work pane's picture is not a button", async ({ page }) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&panel=open`, "dark");
  await expect(page.locator(".work-hero .avatar")).toBeVisible();
  await expect(page.getByRole("button", { name: /picture/ })).toHaveCount(0);
});

test("a picture the browser can't decode shows the bot's own Clawling instead", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "dark");
  await page.evaluate(() =>
    (
      window as unknown as {
        clawtrateFixture: {
          setState(
            f: (s: { bots: Array<{ id: string; avatarUrl: string | null }> }) => unknown,
          ): void;
        };
      }
    ).clawtrateFixture.setState((state) => ({
      ...state,
      // A JPEG label on bytes that are not one: shown as a picture until the browser fails it.
      bots: state.bots.map((bot) =>
        bot.id === "marlow" ? { ...bot, avatarUrl: "data:image/jpeg;base64,AAAA" } : bot,
      ),
    })),
  );
  await expect(row(page, "Marlow").locator("img")).toHaveCount(0);
  await expect(row(page, "Marlow").locator('svg.creature[data-family="clawling"]')).toBeVisible();
});

type Fixture = { clawtrateFixture: { setState(f: (s: Record<string, unknown>) => unknown): void } };
/** Take admin away, as a revoked grant does, while the page is open. */
const dropAdmin = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as Fixture).clawtrateFixture.setState((state) => ({
      ...state,
      connection: { ...(state.connection as object), canAdmin: false },
    })),
  );
const openEdit = async (page: Page, query: string) => {
  await openFixture(page, `${ADMIN}&panel=open${query}`, "dark");
  await page.getByRole("button", { name: "Change Otto's picture" }).click();
  return page.getByTestId("edit-picture");
};

test("F-037: Save waits for a change, says Saving… while the gateway hasn't answered, and the editor closes when admin goes", async ({
  page,
}) => {
  const dialog = await openEdit(page, "&picturesave=hold");
  const save = dialog.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  await dialog.getByRole("radio", { name: "Lanterns" }).click();
  await save.click();
  await expect(dialog.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await dropAdmin(page);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Change Otto's picture" })).toHaveCount(0);
  // Admin granted again does not bring back the editor that was closed, or its unsaved draft.
  await page.evaluate(() =>
    (window as unknown as Fixture).clawtrateFixture.setState((state) => ({
      ...state,
      connection: { ...(state.connection as object), canAdmin: true },
    })),
  );
  await expect(page.getByRole("button", { name: "Change Otto's picture" })).toBeVisible();
  await expect(dialog).toHaveCount(0);
});

test("F-037: a refused save says so in fixed words and keeps the changes; an unconfirmed one says the gateway hasn't confirmed it", async ({
  page,
}) => {
  let dialog = await openEdit(page, "&picturesave=refused");
  await dialog.getByRole("radio", { name: "Shellfolk" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Couldn't save the picture. Your changes are still here.",
  );
  await expect(dialog.getByRole("radio", { name: "Shellfolk" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(dialog).not.toContainText("INVALID_REQUEST");
  dialog = await openEdit(page, "&picturesave=unconfirmed");
  await dialog.getByRole("radio", { name: "Shellfolk" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "The gateway hasn't confirmed this picture yet.",
  );
  await expect(dialog).toBeVisible();
});

test("F-037: a saved picture is announced by the Work pane after the editor closes", async ({
  page,
}) => {
  const dialog = await openEdit(page, "");
  await dialog.getByRole("radio", { name: "Lanterns" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("work-announcer")).toHaveText("Picture saved");
});

/** Bytes that begin like a PNG of the size given, and nothing more. */
const pngHeader = (width: number, height: number) => {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]).copy(bytes, 0);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};

test("F-035: an upload is checked before it is decoded: its real format, then its size in pixels", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "dark");
  await page.keyboard.press("ControlOrMeta+n");
  // Decoding is watched: nothing refused here may reach it.
  await page.evaluate(() => {
    const w = window as unknown as { decoded: number; createImageBitmap: typeof createImageBitmap };
    w.decoded = 0;
    const real = w.createImageBitmap.bind(window);
    w.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => {
      w.decoded += 1;
      return real(...args);
    }) as typeof createImageBitmap;
  });
  const file = page.getByTestId("picture-file");
  await file.setInputFiles({
    name: "notes.png",
    mimeType: "image/png",
    buffer: Buffer.from("plain text"),
  });
  await expect(page.getByRole("alert")).toHaveText("Choose a PNG, JPEG, WebP or GIF image.");
  await file.setInputFiles({
    name: "huge.png",
    mimeType: "image/png",
    buffer: pngHeader(9000, 100),
  });
  await expect(page.getByRole("alert")).toHaveText(
    "Choose an image no wider or taller than 8,192 pixels and under 16 million pixels.",
  );
  await file.setInputFiles({
    name: "wide.png",
    mimeType: "image/png",
    buffer: pngHeader(5000, 5000),
  });
  await expect(page.getByRole("alert")).toHaveText(
    "Choose an image no wider or taller than 8,192 pixels and under 16 million pixels.",
  );
  // A GIF whose logical screen says 1×1 but whose frame is 4×4: its frames are read first.
  const le16 = (n: number) => [n & 255, (n >> 8) & 255];
  const gif = Buffer.from([
    ...Buffer.from("GIF89a"),
    ...le16(1),
    ...le16(1),
    0x80,
    0,
    0,
    0,
    0,
    0,
    255,
    255,
    255,
    0x2c,
    ...le16(0),
    ...le16(0),
    ...le16(4),
    ...le16(4),
    0,
    2,
    2,
    0x44,
    0x01,
    0,
    0x3b,
  ]);
  await file.setInputFiles({ name: "frame.gif", mimeType: "image/gif", buffer: gif });
  await expect(page.getByRole("alert")).toHaveText("That image couldn't be read.");
  expect(await page.evaluate(() => (window as unknown as { decoded: number }).decoded)).toBe(0);
});

test("F-035: Next waits while a picture is read, and a creature chosen meanwhile wins over the late picture", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "dark");
  await page.keyboard.press("ControlOrMeta+n");
  // The next decode is held until the check lets it finish.
  await page.evaluate(() => {
    const w = window as unknown as {
      release: () => void;
      createImageBitmap: typeof createImageBitmap;
    };
    const real = w.createImageBitmap.bind(window);
    w.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) =>
      new Promise((resolve) => {
        // Returns once the real decode has settled, so the check can wait for it.
        w.release = () => {
          const decoded = real(...args);
          resolve(decoded);
          return decoded.then(
            () => undefined,
            () => undefined,
          );
        };
      })) as typeof createImageBitmap;
  });
  await page.getByTestId("picture-file").setInputFiles({
    name: "mine.png",
    mimeType: "image/png",
    buffer: Buffer.from(await pngFile(page), "base64"),
  });
  const next = page.getByRole("button", { name: "Reading the picture…" });
  await expect(next).toBeDisabled();
  // The decode has begun and is held: what follows happens while it is pending.
  await page.waitForFunction(
    () => typeof (window as unknown as { release?: unknown }).release === "function",
  );
  await page.getByRole("textbox", { name: "Name" }).press("Enter");
  await expect(page.getByRole("heading", { name: "New bot", level: 2 })).toBeVisible();
  await page.getByRole("radio", { name: "Shellfolk" }).click();
  await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();
  await page.evaluate(() => (window as unknown as { release: () => Promise<void> }).release());
  await settled(page);
  await expect(page.getByTestId("picture-preview").locator("img")).toHaveCount(0);
  await expect(page.getByTestId("picture-preview").locator("svg")).toHaveAttribute(
    "data-family",
    "shellfolk",
  );
});

test("F-035: a creature that can't be drawn is not sent: Create keeps the draft open, and Edit picture sends nothing", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&panel=open`, "dark");
  // The page's canvases give no 2D context from here on.
  await page.evaluate(() => {
    const real = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      ...rest: unknown[]
    ) {
      return kind === "2d"
        ? null
        : (real as (...a: unknown[]) => unknown).call(this, kind, ...rest);
    } as typeof real;
  });
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("radio", { name: "Shellfolk" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Work/ }).click();
  await page.getByTestId("create").click();
  await expect(page.getByRole("alert")).toHaveText(
    "Couldn't draw that picture. Choose it again, or choose another.",
  );
  await expect(page.getByTestId("new-bot")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Change Otto's picture" }).click();
  const dialog = page.getByTestId("edit-picture");
  await dialog.getByRole("radio", { name: "Lanterns" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Couldn't save the picture. Your changes are still here.",
  );
  const commands = (await sent(page)).map((each) => each.type);
  expect(commands).not.toContain("createBot");
  expect(commands).not.toContain("setBotPicture");
});

test("F-037: a save answered after its editor closed does nothing to the editor opened since", async ({
  page,
}) => {
  let dialog = await openEdit(page, "&picturesave=release");
  await dialog.getByRole("radio", { name: "Lanterns" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("button", { name: "Saving…" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Change Otto's picture" }).click();
  dialog = page.getByTestId("edit-picture");
  await dialog.getByRole("radio", { name: "Shellfolk" }).click();
  await page.evaluate(() =>
    (window as unknown as { releasePictureSave: () => void }).releasePictureSave(),
  );
  // The old save lands on the gateway, but the new editor and its draft stay, and nothing is announced.
  await expect(row(page, "Otto").locator('svg.creature[data-family="lantern"]')).toBeVisible();
  // The old reply's handling runs after the list shows the picture: let it run first.
  await settled(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Shellfolk" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByTestId("work-announcer")).not.toHaveText("Picture saved");
});

test("F-037: a picture still being drawn when admin goes is never sent", async ({ page }) => {
  const dialog = await openEdit(page, "");
  // Drawing the picture waits until the check lets it finish.
  await page.evaluate(() => {
    const w = window as unknown as { releaseDecode: () => void };
    const real = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function (this: HTMLImageElement) {
      return new Promise<void>((resolve, reject) => {
        w.releaseDecode = () => real.call(this).then(resolve, reject);
      });
    };
  });
  await dialog.getByRole("radio", { name: "Lanterns" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await dropAdmin(page);
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { releaseDecode: () => Promise<void> }).releaseDecode(),
  );
  await settled(page);
  expect((await sent(page)).map((each) => each.type)).not.toContain("setBotPicture");
});

test("F-037: a new connection to the gateway, still connected, closes the editor", async ({
  page,
}) => {
  const dialog = await openEdit(page, "");
  await dialog.getByRole("radio", { name: "Lanterns" }).click();
  await page.evaluate(() =>
    (window as unknown as Fixture).clawtrateFixture.setState((state) => ({
      ...state,
      connection: { ...(state.connection as object), connectedAt: Date.now() + 60_000 },
    })),
  );
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Change Otto's picture" })).toBeVisible();
});

test("F-034: a New bot draft closed while its picture was being drawn is never created, and Create waits", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "dark");
  await page.evaluate(() => {
    const w = window as unknown as { releaseDecode: () => void };
    const real = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function (this: HTMLImageElement) {
      return new Promise<void>((resolve, reject) => {
        w.releaseDecode = () => real.call(this).then(resolve, reject);
      });
    };
  });
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("radio", { name: "Shellfolk" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Work/ }).click();
  await page.getByTestId("create").click();
  // While the picture is drawn, one Create at a time.
  await expect(page.getByTestId("create")).toBeDisabled();
  await expect(page.getByTestId("create")).toHaveText("Creating…");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("new-bot")).toHaveCount(0);
  // Opened again while the old draw is still pending: the old one sends nothing and leaves this one be.
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByTestId("new-bot")).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { releaseDecode: () => Promise<void> }).releaseDecode(),
  );
  await settled(page);
  expect((await sent(page)).map((each) => each.type)).not.toContain("createBot");
  await expect(page.getByTestId("new-bot")).toBeVisible();
  await expect(page.getByTestId("create")).toHaveText("Create");
});

test("F-034: a Create answered after its dialog closed doesn't close or clear the draft opened since", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&create=release`, "dark");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill("First");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Work/ }).click();
  await page.getByTestId("create").click();
  await expect
    .poll(async () => (await sent(page)).filter((each) => each.type === "createBot").length)
    .toBe(1);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Back to the picture" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Newer");
  await page.evaluate(() => (window as unknown as { releaseCreate: () => void }).releaseCreate());
  await settled(page);
  await expect(row(page, "First").first()).toBeVisible();
  await expect(page.getByTestId("new-bot")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Newer");
});

test("F-037: while a picture is being saved its choices are frozen, so what is saved is what was shown", async ({
  page,
}) => {
  const dialog = await openEdit(page, "&picturesave=release");
  await dialog.getByRole("radio", { name: "Lanterns" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("radio", { name: "Shellfolk" })).toBeDisabled();
  await dialog.getByRole("radio", { name: "Shellfolk" }).click({ force: true });
  await expect(dialog.getByRole("radio", { name: "Lanterns" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.evaluate(() =>
    (window as unknown as { releasePictureSave: () => void }).releasePictureSave(),
  );
  await expect(dialog).toHaveCount(0);
  await expect(row(page, "Otto").locator('svg.creature[data-family="lantern"]')).toBeVisible();
});

test("F-035: a JPEG whose frame header comes after more than 256 KiB of metadata is still checked and taken", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "dark");
  await page.keyboard.press("ControlOrMeta+n");
  const small = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 48;
      canvas.height = 32;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#3f6f8f";
      ctx.fillRect(0, 0, 48, 32);
      return canvas.toDataURL("image/jpeg").split(",")[1]!;
    }),
    "base64",
  );
  // Five APP1 blocks of metadata, about 320 KiB, between the start and the rest of the file.
  const block = Buffer.concat([Buffer.from([0xff, 0xe1, 0xff, 0xff]), Buffer.alloc(0xfffd)]);
  const padded = Buffer.concat([
    small.subarray(0, 2),
    ...new Array(5).fill(block),
    small.subarray(2),
  ]);
  await page
    .getByTestId("picture-file")
    .setInputFiles({ name: "big-metadata.jpg", mimeType: "image/jpeg", buffer: padded });
  await expect(page.getByTestId("picture-preview").locator("img")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("F-035: after a picture can't be drawn, Use the default picture creates the bot with its own Clawling", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "dark");
  await page.evaluate(() => {
    const real = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      ...rest: unknown[]
    ) {
      return kind === "2d"
        ? null
        : (real as (...a: unknown[]) => unknown).call(this, kind, ...rest);
    } as typeof real;
  });
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill("Viral");
  await page.getByRole("radio", { name: "Shellfolk" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Work/ }).click();
  await page.getByTestId("create").click();
  await expect(page.getByRole("alert")).toHaveText(
    "Couldn't draw that picture. Choose it again, or choose another.",
  );
  await page.getByRole("button", { name: "Use the default picture" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByTestId("create").click();
  await expect(page.getByTestId("new-bot")).toHaveCount(0);
  const create = (await sent(page)).find((each) => each.type === "createBot")!;
  expect(create).toMatchObject({ name: "Viral", avatar: null });
});

/** Connect to another gateway, as switching gateways does, while the page stays open. */
const switchGateway = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as Fixture).clawtrateFixture.setState((state) => ({
      ...state,
      connection: {
        ...(state.connection as object),
        gatewayUrl: "ws://127.0.0.1:19777",
        gatewayId: "a-different-gateway",
        connectedAt: Date.now() + 60_000,
      },
    })),
  );

for (const outcome of ["release", "release-failed"] as const)
  test(`F-034: a Create ${outcome === "release" ? "success" : "refusal"} from a gateway since replaced changes nothing visible`, async ({
    page,
  }) => {
    await openFixture(page, `${ADMIN}&create=${outcome}`, "dark");
    await page.keyboard.press("ControlOrMeta+n");
    await page.getByRole("textbox", { name: "Name" }).fill("First");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("radio", { name: /^OpenAI · Work/ }).click();
    await page.getByTestId("create").click();
    await expect
      .poll(async () => (await sent(page)).filter((each) => each.type === "createBot").length)
      .toBe(1);
    // The bot open behind the dialog, by its title pill.
    const pill = page.locator(".title-pill").first();
    const selected = await pill.getAttribute("aria-label");
    await switchGateway(page);
    await page.evaluate(() => (window as unknown as { releaseCreate: () => void }).releaseCreate());
    await settled(page);
    // The draft is still there, nothing new is selected, and nothing is said about the old request.
    await expect(page.getByTestId("new-bot")).toBeVisible();
    await page.getByRole("button", { name: "Back to the picture" }).click();
    await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("First");
    expect(await pill.getAttribute("aria-label")).toBe(selected);
    expect(selected).toMatch(/^Otto/);
    await expect(page.getByTestId("create-failed")).toHaveCount(0);
    await expect(page.getByTestId("new-bot").getByRole("status")).not.toHaveText(
      /Could not create|Created/,
    );
  });

test("F-034: a reconnect to the same gateway, as an access grant makes, doesn't stop a Create", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&create=release`, "dark");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill("First");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Work/ }).click();
  await page.getByTestId("create").click();
  await expect
    .poll(async () => (await sent(page)).filter((each) => each.type === "createBot").length)
    .toBe(1);
  await page.evaluate(() =>
    (window as unknown as Fixture).clawtrateFixture.setState((state) => ({
      ...state,
      connection: { ...(state.connection as object), connectedAt: Date.now() + 60_000 },
    })),
  );
  await page.evaluate(() => (window as unknown as { releaseCreate: () => void }).releaseCreate());
  await expect(page.getByTestId("new-bot")).toHaveCount(0);
  await expect(page.locator(".title-pill").first()).toHaveAttribute("aria-label", /^First/);
});

for (const outcome of ["release", "release-failed"] as const)
  test(`F-034: a Create ${outcome === "release" ? "success" : "refusal"} that lands while the gateway's identity is unknown again changes nothing`, async ({
    page,
  }) => {
    await openFixture(page, `${ADMIN}&create=${outcome}`, "dark");
    await page.keyboard.press("ControlOrMeta+n");
    await page.getByRole("textbox", { name: "Name" }).fill("First");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("radio", { name: /^OpenAI · Work/ }).click();
    await page.getByTestId("create").click();
    await expect
      .poll(async () => (await sent(page)).filter((each) => each.type === "createBot").length)
      .toBe(1);
    // A new connection at the same address, which hasn't said which gateway it is yet.
    await page.evaluate(() =>
      (window as unknown as Fixture).clawtrateFixture.setState((state) => ({
        ...state,
        connection: {
          ...(state.connection as object),
          connectedAt: Date.now() + 60_000,
          gatewayId: null,
        },
      })),
    );
    await page.evaluate(() => (window as unknown as { releaseCreate: () => void }).releaseCreate());
    await settled(page);
    await expect(page.getByTestId("new-bot")).toBeVisible();
    await expect(page.getByTestId("new-bot").getByRole("status")).not.toHaveText(
      /Could not create|Created/,
    );
    await page.getByRole("button", { name: "Back to the picture" }).click();
    await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("First");
  });
