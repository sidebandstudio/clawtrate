// Behaviour checks for lifecycle.html (docs/design/bots-lifecycle.md): the
// primary bot, the picture editor, the name and label in place, instructions,
// a change to the instructions in the conversation, duplicate, export, import
// and delete. Each path is walked to each of its outcomes, and every check
// reads visible words, so a changed label fails.
// Run from the repository root:  node docs/design/prototype/tools/checks/lifecycle.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("lifecycle.html") + "?chrome=0&theme=light";
const b = await chromium.launch();
const out = [];
let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed += 1;
  out.push(`${ok ? "ok  " : "FAIL"} ${name} ${extra}`);
};
const open = async (query = "", viewport = { width: 1440, height: 900 }) => {
  const p = await b.newPage({ viewport });
  p.on("pageerror", (e) => {
    failed += 1;
    out.push("PAGEERROR " + e);
  });
  await p.goto(base + (query ? "&" + query : ""));
  await p.waitForTimeout(250);
  return p;
};
const norm = (s) => (s || "").replace(/\s+/g, " ");
const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.textContent || "", sel).then(norm);
const dlg = (p) => p.evaluate(() => (document.querySelector("#lc-dialog").open ? document.querySelector("#lc-dialog").textContent : "")).then(norm);
const panel = (p) => text(p, "#panel-settings");
const hero = (p) => text(p, "#work-hero");
const has = (t, ...words) => words.every((w) => t.includes(w));
const announced = async (p, ms = 80) => {
  await p.waitForTimeout(ms);
  return p.evaluate(() => document.querySelector("#b-announce").textContent);
};
const click = (p, sel) => p.click(sel);
const clickText = (p, root, words) =>
  p.evaluate(
    ([r, w]) => {
      const el = [...document.querySelectorAll(`${r} button`)].find((x) => x.textContent.trim() === w);
      if (!el) throw new Error(`no button "${w}" in ${r}`);
      el.click();
    },
    [root, words],
  );
const starOn = (p) => p.evaluate(() => [...document.querySelectorAll("#bot-list .bot")].filter((r) => r.querySelector(".lc-star")).map((r) => r.dataset.bot).join(","));
const railMenu = async (p, bot) => {
  await p.click(`#bot-list .bot[data-bot="${bot}"]`, { button: "right" });
  await p.waitForTimeout(60);
  return p.evaluate(() => [...document.querySelectorAll("#rail-menu .menu-item")].map((x) => x.textContent.trim()));
};
const settings = "panel=open&tab=settings";

process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

// The primary bot (section 3) -------------------------------------------------------------------------
let p = await open("lc=intro");
let t = await dlg(p);
check("S3 the introduction says what a primary bot is and isn't", has(t, "Introducing the primary bot", "Your primary bot comes first in your list, with a star, and it's the bot Clawtrate offers when you share something into the app.", "Choosing one changes nothing on the gateway. Juniper has the star until you choose: it's the gateway's default bot."));
check("S3 it says where the choice is kept and who else sees it", t.includes("Kept for you on this gateway, so your other devices show the same star. Other people who use this gateway choose their own."));
check("F-007 it offers an existing bot, a new one, and Not now", has(t, "Use an existing bot", "Create primary bot", "Not now"));
check("S3 before a choice the star is on the gateway's default bot", (await starOn(p)) === "juniper");
await clickText(p, "#lc-dialog", "Not now");
check("S3 Not now keeps the default bot's star and says so", !(await dlg(p)) && (await announced(p)) === "Juniper keeps the star, as the gateway's default bot" && (await starOn(p)) === "juniper");
await p.close();

p = await open("lc=intro");
await clickText(p, "#lc-dialog", "Use an existing bot");
t = await dlg(p);
check("F-007 F-259 Use an existing bot opens the searchable list", has(t, "Choose a primary bot", "Your primary bot · The gateway's default bot", "The gateway's own default bot stays Juniper. Clawtrate doesn't change it: the gateway uses it for messages no route claims."));
check("F-259 Confirm waits for another bot", await p.evaluate(() => document.querySelector('[data-lc="confirm-primary"]').disabled));
await p.fill("#lc-search", "plan");
check("F-007 search narrows the list by name or label", await p.evaluate(() => [...document.querySelectorAll("[data-lc-pick]")].map((x) => x.dataset.lcPick).join(",") === "pip"));
await click(p, '[data-lc-pick="pip"]');
await click(p, '[data-lc="confirm-primary"]');
check("S3 Confirm shows Saving while it writes", (await dlg(p)).includes("Saving…"));
await p.waitForTimeout(650);
check("F-259 the star moves only after the read-back, and it is announced", !(await dlg(p)) && (await starOn(p)) === "pip" && (await announced(p)) === "Pip is your primary bot");
check("F-259 the primary bot's menu offers Replace, not Delete", has((await railMenu(p, "pip")).join("|"), "Replace with different bot") && !(await railMenu(p, "pip")).includes("Delete…"));
check("S10 another bot's menu offers Make primary bot and Delete", has((await railMenu(p, "otto")).join("|"), "Make primary bot", "Delete…", "Duplicate…", "Export…", "Rename"));
await p.close();

p = await open("lc=choose&primfail=1");
await click(p, '[data-lc-pick="marlow"]');
await click(p, '[data-lc="confirm-primary"]');
await p.waitForTimeout(650);
t = await dlg(p);
check("S3 a failed save keeps the old star and says so", t.includes("Couldn't save your choice. The gateway didn't answer. Your primary bot is still Juniper.") && t.includes("Try again") && (await starOn(p)) === "juniper");
await click(p, '[data-lc="confirm-primary"]');
await p.waitForTimeout(650);
check("S3 Try again saves", (await starOn(p)) === "marlow");
await p.close();

p = await open("lc=choose&primconflict=1");
await click(p, '[data-lc-pick="otto"]');
await click(p, '[data-lc="confirm-primary"]');
await p.waitForTimeout(650);
check("S3 a choice that crossed another device shows what the gateway has now", (await dlg(p)).includes("Another of your devices chose Marlow a moment ago. That's what the gateway has now. Confirm to choose Otto instead.") && (await starOn(p)) === "marlow");
await click(p, '[data-lc="confirm-primary"]');
await p.waitForTimeout(650);
check("S3 confirming again chooses Otto", (await starOn(p)) === "otto");
await p.close();

p = await open("lc=choose&prefs=device");
check("S3 without a profile on the gateway the choice is this device's only", (await dlg(p)).includes("This device only: this connection has no profile on the gateway to keep it in, so your other devices won't show it."));
await click(p, '[data-lc-pick="pip"]');
await click(p, '[data-lc="confirm-primary"]');
check("S3 ... and the announcement says so", (await announced(p, 700)) === "Pip is your primary bot on this device");
await p.close();

p = await open("lc=choose&access=read");
t = await dlg(p);
check("S2 S3 a read-only connection asks for the interactive tier, not admin", t.includes("Read-only. Choosing a primary bot needs the interactive tier: it saves a preference for you on the gateway.") && t.includes("Request access") && !t.includes("Confirm"));
await p.click('[data-lc-pick="pip"]', { force: true });
check("S3 ... and cannot choose", await p.evaluate(() => document.querySelector('[data-lc-pick="juniper"]').getAttribute("aria-checked") === "true"));
await p.close();

p = await open("primary=gone");
check("S3 a stored primary bot no longer listed gives the star back to the default", (await starOn(p)) === "juniper");
await p.close();

p = await open(`bot=pip&${settings}`);
const primaryWord = (p) => p.evaluate(() => document.querySelector("#panel-settings .lc-manage dd")?.textContent);
check("S3 Manage says whether the bot is primary", (await primaryWord(p)) === "No");
await clickText(p, "#panel-settings", "Make primary bot");
await p.waitForTimeout(650);
check("S3 Make primary bot in Manage saves and moves the star", (await starOn(p)) === "pip" && (await primaryWord(p)) === "Yes");
check("S3 S10 the primary bot's Delete is disabled with its reason", (await panel(p)).includes("Pip is your primary bot. Choose another primary bot before deleting it.") && (await p.evaluate(() => document.querySelector('#panel-settings [data-lc="open-delete"]').disabled)));
await p.close();

p = await open("lc=intro");
await clickText(p, "#lc-dialog", "Create primary bot");
check("F-007 Create primary bot opens New bot", await p.evaluate(() => document.querySelector("#create-dialog").open));
await p.fill("#b-name", "Wren");
await p.keyboard.press("Enter");
await p.waitForTimeout(150);
await p.evaluate(() => document.querySelector("[data-b-choose]")?.click());
await p.waitForTimeout(80);
await p.evaluate(() => [...document.querySelectorAll("#create-dialog button")].find((x) => x.textContent.trim() === "Create")?.click());
await p.waitForTimeout(1600);
check("F-007 the bot it makes becomes the primary bot once listed", (await starOn(p)) === "wren", await starOn(p));
await p.close();

// The picture (section 4) -----------------------------------------------------------------------------
p = await open(`bot=juniper&${settings}`);
await click(p, '[data-lc="open-picture"]');
t = await dlg(p);
check("F-037 the picture opens the editor with Bot, Generate and Upload", has(t, "Juniper's picture", "Bot", "Generate", "Upload"));
check("S4 the Bot tab says the gateway doesn't keep the shape and colour, and nothing is chosen", t.includes("The gateway keeps Juniper's picture, not the shape and colour it was drawn from. Pick both to draw a new one.") && (await p.evaluate(() => !document.querySelector('[data-lc-body][aria-checked="true"]') && document.querySelector('[data-lc="set-picture"]').disabled)));
await click(p, '[data-lc-body="hex"]');
await click(p, '[data-lc-color="#5b8dff"]');
check("F-037 a shape and a colour enable Set picture", await p.evaluate(() => !document.querySelector('[data-lc="set-picture"]').disabled));
await click(p, '[data-lc="set-picture"]');
check("S4 saving shows Saving", (await dlg(p)).includes("Saving…"));
check("F-037 the picture is saved on the read-back", (await announced(p, 650)) === "Picture saved" && !(await dlg(p)));
check("S2 focus returns to the picture", await p.evaluate(() => document.activeElement?.dataset.lc === "open-picture"));
await p.close();

p = await open(`bot=juniper&${settings}&lc=picture&picfail=1`);
await click(p, '[data-lc-body="gem"]');
await click(p, '[data-lc-color="#ff8552"]');
await click(p, '[data-lc="set-picture"]');
await p.waitForTimeout(650);
check("S4 a refused picture leaves it unchanged and says so", (await dlg(p)).includes("The gateway didn't save the picture: it refused the change. Juniper's picture is unchanged."));
await click(p, '[data-lc="set-picture"]');
check("S4 ... and saving again works", (await announced(p, 650)) === "Picture saved");
await p.close();

p = await open(`bot=juniper&${settings}&lc=picture&picfail=dropped`);
await click(p, '[data-lc-body="gem"]');
await click(p, '[data-lc-color="#ff8552"]');
await click(p, '[data-lc="set-picture"]');
await p.waitForTimeout(650);
check("S4 an ok the read-back contradicts is a failure", (await dlg(p)).includes("The gateway took the picture but doesn't show it. Its list of bots returns no picture for Juniper now, so no device will show this one."));
await p.close();

p = await open(`bot=juniper&${settings}&lc=picture&ptab=generate`);
t = await dlg(p);
check("F-269 with no image tool, Generate is disabled with the row's words and the gateway's reason", t.includes("Image generation isn't available on this gateway") && t.includes("The gateway doesn't offer Juniper its image tool: “Denied by tools.deny”, in the gateway's own words.") && (await p.evaluate(() => [...document.querySelectorAll("#lc-dialog button")].find((x) => x.textContent === "Generate" && !x.dataset.lcTab).disabled)));
await p.close();
p = await open(`bot=juniper&${settings}&lc=picture&ptab=generate&imagetool=1`);
check("S4 with the tool offered, it says generating isn't in this version", (await dlg(p)).includes("Generating a picture isn't available in this version") && (await dlg(p)).includes("The gateway offers Juniper an image tool, but Clawtrate can't use it here yet."));
await p.close();
p = await open(`bot=juniper&${settings}&lc=picture&ptab=generate&imagetool=unknown`);
check("S4 with no task to ask about, it says it can't tell yet", (await dlg(p)).includes("The gateway says which tools Juniper is offered for one of its tasks, and Juniper has none yet. Start a task, then look here again."));
await p.close();

p = await open(`bot=juniper&${settings}&lc=picture&ptab=upload`);
t = await dlg(p);
check("F-270 Upload takes a dropped image or Browse files, under 25 MB", has(t, "Drop an image here", "Browse files", "PNG, JPEG, WebP or GIF, under 25 MB."));
await clickText(p, "#lc-dialog", "Browse files");
check("F-270 a chosen image is cropped, and the saved size is said", (await dlg(p)).includes("trail-sunrise.jpg · 4.2 MB. Drag to move it in the circle. Clawtrate saves the circle's square at 128 by 128 pixels."));
await click(p, '[data-lc="set-picture"]');
check("F-270 Set picture saves it", (await announced(p, 650)) === "Picture saved" && (await p.evaluate(() => document.querySelector('#work-hero .avatar[data-photo="true"]') !== null)));
await p.close();
p = await open(`bot=juniper&${settings}&lc=picture&ptab=upload&upload=toolarge`);
check("F-270 an image of 25 MB or more is rejected and the picture is unchanged", (await dlg(p)).includes("That image is 31.4 MB. Choose one under 25 MB. Juniper's picture is unchanged.") && (await p.evaluate(() => document.querySelector('[data-lc="set-picture"]').disabled)));
await p.close();
p = await open(`bot=juniper&${settings}&lc=picture&ptab=upload&upload=notimage`);
check("S4 a file that isn't an image is refused", (await dlg(p)).includes("notes.pdf isn't an image. Choose a PNG, JPEG, WebP or GIF file."));
await p.close();
p = await open(`bot=juniper&${settings}&access=read`);
check("S2 below admin the picture, name and label are not buttons", await p.evaluate(() => !document.querySelector("#work-hero button")));
await p.close();
p = await open(`bot=juniper&${settings}&lc=picture&access=read`);
check("S2 below admin the editor asks for admin by its bar", (await dlg(p)).includes("Changing Juniper's picture needs admin access."));
await p.close();

// The name and the label (section 5) ------------------------------------------------------------------
p = await open(`bot=juniper&${settings}`);
await click(p, '[data-lc="edit-name"]');
await p.waitForTimeout(60);
check("F-038 the name becomes a field in place", await p.evaluate(() => document.activeElement?.dataset.lcInline === "name"));
await p.keyboard.type("Juniper Lee");
await p.keyboard.press("Enter");
check("F-038 saving shows Saving", (await hero(p)).includes("Saving…"));
check("F-038 the name read back is shown and announced", (await announced(p, 600)) === "Renamed to Juniper Lee" && (await hero(p)).includes("Juniper Lee") && (await text(p, "#bot-list")).includes("Juniper Lee"));
await click(p, '[data-lc="edit-name"]');
await p.waitForTimeout(60);
await p.keyboard.press("Escape");
check("F-038 Escape puts the name back", (await hero(p)).includes("Juniper Lee") && (await p.evaluate(() => document.activeElement?.dataset.lc === "edit-name")));
await click(p, '[data-lc="edit-name"]');
await p.waitForTimeout(60);
await p.keyboard.press("Backspace");
await p.keyboard.press("Enter");
check("F-038 an empty name is not sent", (await hero(p)).includes("A bot needs a name."));
await p.keyboard.press("Escape");
await click(p, '[data-lc="edit-label"]');
await p.waitForTimeout(60);
await p.fill('[data-lc-inline="label"]', "");
await p.keyboard.press("Enter");
check("F-039 an empty label removes it, and the empty state reads Add a label", (await announced(p, 600)) === "Label removed" && (await hero(p)).includes("Add a label"));
await click(p, '[data-lc="edit-label"]');
await p.waitForTimeout(60);
await p.keyboard.type("Reading");
await p.keyboard.press("Enter");
check("F-039 a label is saved in place", (await announced(p, 600)) === "Label saved" && (await hero(p)).includes("Reading"));
await p.close();

p = await open(`bot=otto&${settings}&namefail=1&edit=name`);
await p.waitForTimeout(60);
await p.keyboard.type("Otto Two");
await p.keyboard.press("Enter");
await p.waitForTimeout(600);
check("S5 a refused rename keeps the typed text and the old name", (await hero(p)).includes("Couldn't rename: the gateway refused it. The name is still Otto.") && (await p.evaluate(() => document.querySelector('[data-lc-inline="name"]').value === "Otto Two")));
await p.close();

p = await open("");
await p.dblclick('#bot-list .bot[data-bot="marlow"] .bot-name');
await p.waitForTimeout(120);
check("F-026 double-clicking a name in the rail renames it in place", await p.evaluate(() => document.activeElement?.classList.contains("lc-rail-input")));
await p.keyboard.type("Marlowe");
await p.keyboard.press("Enter");
check("F-026 Enter saves it", (await announced(p, 550)) === "Renamed to Marlowe" && (await text(p, '#bot-list .bot[data-bot="marlow"]')).includes("Marlowe"));
await p.close();

p = await open(`bot=pip&${settings}&width=phone&view=detail`, { width: 390, height: 844 });
check("F-271 on the phone the label is called Title", await p.evaluate(() => document.querySelector('[data-lc="edit-label"]')?.getAttribute("aria-label") === "Title: Planning. Change"));
await p.close();

// Instructions (section 6) ----------------------------------------------------------------------------
const fileRow = (p, key) => text(p, `[data-lc-file-row="${key}"]`);
p = await open(`bot=juniper&${settings}`);
t = await panel(p);
check("F-040 About keeps bots.md's Description row and opens the two files", (await p.evaluate(() => document.querySelector('[data-bs="instructions"] .b-open-value')?.textContent)) === "AGENTS.md, 5 lines · SOUL.md, 1 line" && t.includes("Description"));
await click(p, '[data-bs="instructions"]');
t = await panel(p);
check("F-040 the page names both files", has(t, "Instructions · AGENTS.md", "Personality · SOUL.md"));
check("F-040 it says memory is separate", t.includes("Memory is separate: what Juniper remembers is under Memory, and these files don't change it."));
check("F-040 Save waits for a change", await p.evaluate(() => document.querySelector('[data-lc="instr-save"]').disabled));
await p.fill("#lc-agents", "# Juniper\n\nCite every source.\n");
await click(p, '[data-lc="instr-save"]');
check("F-040 Saving, then a row for the file written, from its own read-back", (await panel(p)).includes("Saving…") && (await announced(p, 550)) === "Instructions saved" && (await fileRow(p, "agents")).includes("AGENTS.md: Written, read back at 5:44 PM") && !(await p.$('[data-lc-file-row="soul"]')));
await p.close();

p = await open(`bot=juniper&${settings}&bview=instructions&instr=conflict`);
await click(p, '[data-lc="instr-save"]');
await p.waitForTimeout(550);
t = await panel(p);
check("S6 two files, two outcomes: one written, one changed on the gateway", (await fileRow(p, "agents")).includes("AGENTS.md: Written") && (await fileRow(p, "soul")).includes("SOUL.md: Changed on the gateway") && (await announced(p)) === "SOUL.md: not saved");
check("F-040 the changed file keeps the person's text and shows the gateway's", has(t, "SOUL.md changed on the gateway while you were editing. Your text is kept here. The gateway now has:", "Curious, careful, plain-spoken. Never guess.") && (await p.evaluate(() => document.querySelector("#lc-soul").value === "Curious, careful, brief.\n")));
await clickText(p, "#panel-settings", "Save mine over it");
await p.waitForTimeout(550);
check("S6 Save mine over it writes only that file, after a fresh read", (await announced(p)) === "SOUL.md saved over the gateway's copy" && (await fileRow(p, "soul")).includes("SOUL.md: Written"));
await p.close();
p = await open(`bot=juniper&${settings}&bview=instructions&instr=conflict`);
await click(p, '[data-lc="instr-save"]');
await p.waitForTimeout(550);
await clickText(p, "#panel-settings", "Use the gateway's");
check("F-040 Use the gateway's shows the gateway's text for that file", (await p.evaluate(() => document.querySelector("#lc-soul").value.includes("Never guess"))) && !(await panel(p)).includes("changed on the gateway while"));
await p.close();
p = await open(`bot=juniper&${settings}&bview=instructions&instrfail=1`);
await p.fill("#lc-agents", "# Juniper\n\nBrisk.\n");
await click(p, '[data-lc="instr-save"]');
await p.waitForTimeout(550);
check("S6 a file that couldn't be read back says so, and keeps the text", (await fileRow(p, "agents")).includes("AGENTS.md: Couldn't check") && (await panel(p)).includes("Clawtrate couldn't read AGENTS.md back: the gateway didn't answer. Your text is kept here") && (await p.evaluate(() => document.querySelector("#lc-agents").value === "# Juniper\n\nBrisk.\n")));
await p.close();
p = await open(`bot=juniper&${settings}&bview=instructions&access=read`);
t = await panel(p);
check("S6 below admin the files are text and the bar asks for admin", (await p.evaluate(() => !document.querySelector("#panel-settings textarea"))) && t.includes("Changing Juniper's instructions needs admin access.") && t.includes("Cite every source you use."));
await p.close();

// A write to the instructions in the conversation (section 7) ---------------------------------------
const role = (p) => text(p, "#lc-role");
p = await open("bot=juniper&task=j1&rolechange=1");
check("F-041 a run's write to the instructions posts an event line naming the file", (await role(p)).startsWith("Juniper wrote to AGENTS.md"));
await click(p, "#lc-role summary");
t = await role(p);
check("F-041 opened, it says what a read established and nothing more", has(t, "Juniper's write tool changed AGENTS.md in its workspace during this run: the gateway says the file was last changed at 5:41 PM, after the call started.", "Clawtrate can't show what changed or undo it here: the gateway keeps no earlier version of the file."));
check("F-041 no difference, no Accept, no Undo in this unit", !(await p.$("#lc-role .lc-diff")) && (await p.evaluate(() => ![...document.querySelectorAll("#lc-role button")].some((x) => ["Accept", "Undo"].includes(x.textContent)))));
await clickText(p, "#lc-role", "Open instructions");
await p.waitForTimeout(100);
check("S7 Open instructions opens the page", (await panel(p)).includes("Personality · SOUL.md"));
t = await panel(p);
check("S6 the editor says the gateway controls loading, with no fixed figure", t.includes("The gateway controls when it loads these files and how much of them it includes.") && !t.includes("20,000") && !t.includes("keeps the copy it started with"));
await p.close();

// Duplicate (section 8) -----------------------------------------------------------------------------
const rowWord = (p, key) => p.evaluate((k) => document.querySelector(`[data-lc-row-key="${k}"] .lc-step-word`)?.textContent, key);
p = await open(`bot=pip&${settings}`);
await clickText(p, "#panel-settings", "Duplicate…");
t = await dlg(p);
check("F-048 Duplicate has a name and a checklist of what is copied", has(t, "Duplicate Pip", "Name of the copy", "Picture and label", "Model, account and effort", "OpenAI · Home, gpt-5.5-mini, effort Low. Written as New bot writes it: the model with its account, then an empty fallback list.", "Instructions and personality", "Tool permissions and skills"));
check("F-048 it lists what is not copied", has(t, "Its memory: MEMORY.md and 3 notes, and About you (USER.md)", "Its tasks and their history", "Its routines: Weekly plan, Sunday reminder. A copy would run them twice.", "The other files in its workspace folder", "Its own sign-ins (Pip's key), which only Pip can use"));
await click(p, '[data-lc-copy="model"]');
check("S8 without its model the copy says which default it takes", (await dlg(p)).includes("Without it the copy uses the gateway's default model, openai/gpt-5.5, and its default effort."));
await click(p, '[data-lc-copy="model"]');
await click(p, '[data-lc-copy="tools"]');
await click(p, '[data-lc="dup-go"]');
check("S8 progress: each write in turn", (await dlg(p)).includes("Duplicating Pip") && (await dlg(p)).includes("Writing"));
await p.waitForTimeout(1800);
t = await dlg(p);
check("S8 every selected write has its own read-back row", has(t, "New bot with the selected settings", "Each row is what the gateway returned when Clawtrate read it back.", "Made Pip copyListed", "PictureWritten", "LabelWritten", "Model and accountWritten", "Fallback list: noneWritten", "EffortWritten", "AGENTS.mdWritten", "SOUL.mdWritten") && !t.includes("Tool permissions"));
check("S8 the result doesn't promise the same behaviour", t.includes("What its tools, skills and models do can still differ from Pip: the gateway decides, with its own defaults."));
await clickText(p, "#lc-dialog", "Open Pip copy");
check("F-048 Open shows the copy in the list", (await text(p, "#bot-list")).includes("Pip copy") && (await p.evaluate(() => app.model.selectedBot)) === "pip-copy");
await p.close();

p = await open("lc=duplicate&delbot=pip&dup=partial");
await click(p, '[data-lc="dup-go"]');
await p.waitForTimeout(2200);
t = await dlg(p);
check("S8 a partial copy names each write that didn't read back as chosen", has(t, "Some settings still need attention", "Pip copy is listed. 2 settings don't read back as chosen.") && (await rowWord(p, "effort")) === "Still has the gateway's default, Medium" && (await rowWord(p, "soul")) === "Couldn't check" && (await rowWord(p, "agents")) === "Written");
check("S8 Try again writes only what is missing, after a fresh read", t.includes("Try again writes only these again, each after reading what the gateway has now, so a newer change on the gateway isn't overwritten."));
await clickText(p, "#lc-dialog", "Try again");
await p.waitForTimeout(300);
check("S8 ... then every row reads Written", (await dlg(p)).includes("New bot with the selected settings") && (await rowWord(p, "soul")) === "Written");
await p.close();

p = await open("lc=duplicate&delbot=pip&dup=nosource");
await click(p, '[data-lc="dup-go"]');
await p.waitForTimeout(2200);
check("S8 a file the source doesn't have leaves the new bot's starting file", (await rowWord(p, "soul")) === "No source file. Left the new bot's starting file" && (await dlg(p)).includes("New bot with the selected settings"));
await p.close();

p = await open("lc=duplicate&delbot=pip&dup=refused");
await click(p, '[data-lc="dup-go"]');
await p.waitForTimeout(500);
check("S8 a refused create makes nothing and says so", (await dlg(p)).includes("The gateway didn't make the copy: “agent \"pip-copy\" already exists”. Nothing was made.") && (await p.evaluate(() => !app.bots.some((x) => x.id === "pip-copy"))));
await p.close();

p = await open("lc=duplicate&delbot=pip&dupacct=own");
t = await dlg(p);
check("S8 an account kept by the bot alone isn't carried; the copy's account is chosen", t.includes("Model and effort, on an account you choose") && t.includes("Pip's key is kept by Pip alone, so the copy can't use it.") && (await p.evaluate(() => document.querySelector('[data-lc="dup-go"]').disabled)));
check("S8 ... including letting the gateway choose, as New bot offers", t.includes("Let the gateway choose") && t.includes("The copy gets gpt-5.5-mini with no account: the gateway picks one of the provider's accounts for each run."));
await click(p, '[data-lc-acct="openai:work"]');
check("S8 ... and Duplicate waits for that choice", await p.evaluate(() => !document.querySelector('[data-lc="dup-go"]').disabled));
await p.close();
p = await open("lc=duplicate&delbot=pip&access=read");
check("S2 below admin Duplicate asks for admin", (await dlg(p)).includes("Duplicating Pip needs admin access."));
await p.close();

// Export and import (section 9) ------------------------------------------------------------------------
p = await open("lc=export&delbot=pip");
t = await dlg(p);
check("F-049 Export says it's Clawtrate's own format", t.includes("A Clawtrate file: this app's own JSON format, for another Clawtrate to read. The gateway doesn't know it."));
check("F-049 it shows exactly what the file will hold, model by name with the account left out", has(t, "The file will hold exactly this", "NamePip", "LabelPlanning", "PictureA PNG of its character, 128 by 128", "Modelopenai/gpt-5.5-mini · its account, OpenAI · Home, left out", "EffortLow"));
check("F-049 the instructions are in only when chosen", t.includes("Instructions, if you choose them") && (await p.evaluate(() => [...document.querySelectorAll("[data-lc-expfile]")].every((x) => !x.checked))) && !(await p.$(".lc-exp-text")));
await click(p, '[data-lc-expfile="agents"]');
check("F-049 a chosen file is shown in full before it's written", (await text(p, ".lc-exp-text")).includes("You help with planning."));
t = await dlg(p);
check("F-049 it says what the file leaves out and what its fields can hold", t.includes("The file leaves out account bindings and sign-in stores. The fields you export can contain private text, credentials or paths. Review them before saving.") && !t.includes("secret"));
check("F-049 it lists what is never in the file, tool settings first", has(t, "Never in a Clawtrate file", "Tool permissions and skills", "Memory and About you (MEMORY.md, notes, USER.md)", "Routines", "Channel routes"));
check("S9 no gateway-package path is offered in the app", !t.includes("claws") && !(await p.$("[data-lc-way]")));
await clickText(p, "#lc-dialog", "Export file…");
check("S9 exporting reads the bot first", (await dlg(p)).includes("Reading Pip from the gateway…"));
await p.waitForTimeout(800);
check("F-049 a save the host confirmed names the file and its size", (await dlg(p)).includes("Saved Pip.clawtrate-bot.json, 4 KB") && (await announced(p)) === "Saved Pip.clawtrate-bot.json, 4 KB");
await p.close();
for (const [exp, words] of [
  ["web", ["Download requested", "Your browser decides where the file goes and whether it keeps it."]],
  ["cancelled", ["Not saved", "You closed the save dialog. Nothing was written."]],
  ["unchanged", ["Couldn't save", "The file that was there before, Pip.clawtrate-bot.json, still holds what it held."]],
  ["absent", ["Couldn't save", "No file was written."]],
  ["saved-anyway", ["Saved Pip.clawtrate-bot.json, 4 KB", "The save reported an error, “the disk is full”, but reading the file back shows it holds the export."]],
  ["unknown", ["Couldn't save", "Clawtrate couldn't tell what the file holds now."]],
  ["readfail", ["Couldn't read Pip's instructions", "The gateway didn't answer. Nothing was saved."]],
]) {
  p = await open(`lc=export&delbot=pip&exp=${exp}`);
  await clickText(p, "#lc-dialog", "Export file…");
  await p.waitForTimeout(800);
  check(`S9 the host's save ends ${exp}: said as the host reported it`, has(await dlg(p), ...words));
  await p.close();
}
p = await open("lc=export&delbot=pip&exp=absent");
await clickText(p, "#lc-dialog", "Export file…");
await p.waitForTimeout(800);
await clickText(p, "#lc-dialog", "Try again");
await p.waitForTimeout(800);
check("S9 after a failed save, Try again saves", (await dlg(p)).includes("Saved Pip.clawtrate-bot.json, 4 KB"));
await p.close();

p = await open("");
await click(p, "#new-button");
await p.waitForTimeout(60);
check("F-265 the + menu has Import a bot…", (await text(p, "#rail-menu")).includes("Import a bot…"));
await clickText(p, "#rail-menu", "Import a bot…");
t = await dlg(p);
check("F-265 Import asks for a Clawtrate file and says reading changes nothing", has(t, "Import a bot", "Choose a Clawtrate file. You'll see everything it would create before anything is.", "At most 5 MB. Reading it changes nothing on the gateway."));
await clickText(p, "#lc-dialog", "Choose file…");
check("F-265 the file is read first", (await dlg(p)).includes("Reading wren.clawtrate-bot.json…"));
await p.waitForTimeout(500);
t = await dlg(p);
check("F-265 the review shows the picture, name and label, and what the file says of itself", has(t, "Add Wren?", "Label: Garden · wren.clawtrate-bot.json. The file says it was written by Clawtrate 0.4.0.") && (await p.evaluate(() => document.querySelector("#lc-imp-name").value === "Wren" && Boolean(document.querySelector("#lc-dialog .b-preview svg")))));
check("F-265 it says the files will become instructions, and nothing is created until Add Bot", t.includes("These files will become instructions the new bot may follow when it runs. Read them first: Clawtrate shows them and doesn't run them, and nothing is created until Add Bot.") && (await p.evaluate(() => app.bots.length === 4)));
check("F-265 every row is folded and expands", (await p.evaluate(() => [...document.querySelectorAll(".lc-review")].map((d) => d.dataset.lcRow + ":" + d.open).join(","))) === "agents:false,soul:false,settings:false,never:false");
await click(p, '[data-lc-row="agents"] summary');
check("F-265 the instructions row shows AGENTS.md in full", (await text(p, '[data-lc-row="agents"]')).includes("You keep the garden calendar. Ask before ordering seeds. Never water on a rain day."));
await click(p, '[data-lc-row="settings"] summary');
t = await text(p, '[data-lc-row="settings"]');
check("F-265 the settings row lists each setting that will be written, and no tool settings", t.includes("3 to write") && has(t, "Model: openai/gpt-5.5Will be written", "Effort: MediumWill be written", "Fallback list: noneWill be written") && !t.includes("Tools"));
await click(p, '[data-lc-row="never"] summary');
check("F-265 the review lists what will not be created", has(await text(p, '[data-lc-row="never"]'), "a Clawtrate file never carries these", "Tool permissions and skills", "Routines", "Channel routes", "Nor any account binding or sign-in store"));
await clickText(p, "#lc-dialog", "Add Bot");
check("F-265 Add Bot runs Duplicate's writes", (await dlg(p)).includes("Adding Wren"));
await p.waitForTimeout(1800);
t = await dlg(p);
check("F-265 each write has its own read-back row", has(t, "New bot with the selected settings", "Made WrenListed", "PictureWritten", "LabelWritten", "ModelWritten", "Fallback list: noneWritten", "EffortWritten", "AGENTS.mdWritten", "SOUL.mdWritten"));
await clickText(p, "#lc-dialog", "Open Wren");
check("F-265 Open shows Wren in the list", (await text(p, "#bot-list")).includes("Wren") && (await p.evaluate(() => app.model.selectedBot)) === "wren");
await p.close();

p = await open("lc=import&imp=unavailable");
await click(p, '[data-lc-row="settings"] summary');
t = await text(p, '[data-lc-row="settings"]');
check("F-265 with its model left out, no fallback list is written either", !t.includes("Fallback list"));
check("F-265 a model this gateway doesn't offer is left out, not guessed", has(t, "nothing to write, 1 not available here", "Model: globex/atlas-2Not available here, left out", "Effort: MediumLeft out with the model", "With its model left out, Wren uses the gateway's default model, openai/gpt-5.5, until you choose one"));
await p.close();

for (const [imp, words] of [
  ["version", "Its format version is 3, and this version of Clawtrate reads version 1."],
  ["size", "It is 6.2 MB, and a Clawtrate bot file holds at most 5 MB."],
  ["type", "Its label is a number, not text."],
  ["field", "It has a field Clawtrate doesn't read: “tools”."],
  ["account", "Its model names an account, “openai/gpt-5.5@work”. A Clawtrate file names models without accounts."],
  ["picture", "Its picture isn't a PNG, JPEG, WebP or GIF image that decodes."],
]) {
  p = await open(`lc=import&imp=${imp}`);
  await p.waitForTimeout(80);
  check(`F-265 a file refused before anything of it is used: ${imp}`, (await dlg(p)).includes(`Clawtrate can't read this file. ${words} Nothing in it was used.`) && (await p.evaluate(() => !document.querySelector('[data-lc="import-add"]'))));
  await p.close();
}
p = await open("lc=import&imp=field");
await p.waitForTimeout(80);
await clickText(p, "#lc-dialog", "Choose another file…");
await p.waitForTimeout(500);
check("F-265 Choose another file reads the next one", (await dlg(p)).includes("Add Wren?"));
await p.close();

p = await open("lc=import&imp=review&impresult=taken");
await p.waitForTimeout(80);
await clickText(p, "#lc-dialog", "Add Bot");
await p.waitForTimeout(500);
check("F-265 a name already taken is refused as in Duplicate, nothing made", (await dlg(p)).includes("The gateway didn't make the bot: “agent \"wren\" already exists”. Nothing was made.") && (await p.evaluate(() => !app.bots.some((x) => x.id === "wren"))));
await p.fill("#lc-imp-name", "Wren 2");
await clickText(p, "#lc-dialog", "Add Bot");
await p.waitForTimeout(1800);
check("F-265 ... and another name goes through", (await dlg(p)).includes("Wren 2 is listed"));
await p.close();
p = await open("lc=import&imp=review&impresult=partial");
await p.waitForTimeout(80);
await clickText(p, "#lc-dialog", "Add Bot");
await p.waitForTimeout(2000);
t = await dlg(p);
check("F-265 a partial import names each write that didn't land", has(t, "Some settings still need attention") && (await rowWord(p, "agents")) === "Changed on the gateway" && (await rowWord(p, "soul")) === "Couldn't check" && (await rowWord(p, "effort")) === "Still has the gateway's default, Medium");
await clickText(p, "#lc-dialog", "Try again");
await p.waitForTimeout(300);
check("F-265 Try again writes only what is missing", (await dlg(p)).includes("New bot with the selected settings"));
await p.close();

// Delete (section 10) --------------------------------------------------------------------------------------
p = await open("lc=delete&delbot=pip&delread=loading");
check("S10 the dialog reads before it lists", (await dlg(p)).includes("Reading what Pip has on the gateway…"));
await p.close();
p = await open("lc=delete&delbot=pip&delread=failed");
check("S10 a failed read deletes nothing", (await dlg(p)).includes("Couldn't read what Pip has. The gateway didn't answer. Clawtrate doesn't delete a bot without saying what goes."));
await clickText(p, "#lc-dialog", "Try again");
check("S10 Try again reads and lists", (await dlg(p)).includes("Removed from the gateway"));
await p.close();

p = await open("lc=delete&delbot=pip");
t = await dlg(p);
check("S10 the confirmation is an alertdialog, named by its title, with focus on Cancel", (await p.evaluate(() => { const d = document.querySelector("#lc-dialog"); return d.getAttribute("role") === "alertdialog" && document.getElementById(d.getAttribute("aria-labelledby"))?.textContent === "Delete Pip?" && document.activeElement?.textContent === "Cancel"; })));
check("F-050 the dialog lists what goes now, counts only from complete lists", has(t, "Delete Pip?", "Pip's settings", "Its 4 tasks, from every task list", "Its 2 routines: Weekly plan, Sunday reminder", "Approvals saved for its commands") && !t.includes("23 files"));
check("F-276 the folder option is unticked, and says what the gateway will try", has(t, "Also move Pip's folders to the Trash on the gateway's machine", "The gateway will try to move this workspace, workspace-pip, including its files and memory. It keeps folders still used by another bot.", "Its own folder. May include local sign-ins and other bot data.", "Its tasks' transcripts") && (await p.evaluate(() => !document.querySelector("[data-lc-files]").checked)));
check("F-050 the folder option says the Trash can give them back", t.includes("They can be restored from that Trash, on the gateway's machine, until it's emptied."));
check("S10 it says the gateway checks ownership while deleting, and promises nothing about shared memory", t.includes("The gateway checks, while it deletes, which folders another bot still uses.") && !t.includes("shared memory") && !t.includes("All three folders"));
check("S10 what stays, unticked", has(t, "Its folders: with the box unticked, none is asked for the Trash. The gateway may archive its tasks' transcripts.", "What Pip said in other bots' tasks", "Before deleting, Clawtrate reads all of this again."));
await clickText(p, "#lc-dialog", "Delete Pip");
check("S10 Deleting", (await dlg(p)).includes("Deleting Pip…"));
await p.waitForTimeout(700);
t = await dlg(p);
check("F-050 afterwards each line is a read", has(t, "Pip was deleted", "Read back from the gateway just now:", "Not in the gateway's list of bots", "No settings or channel routes for Pip", "No routines of Pip's", "No tasks of Pip's listed") && !(await text(p, "#bot-list")).includes("Pip"));
check("F-276 unticked, the box-off words", (await text(p, "[data-lc-nofolders]")) === "No folders requested for Trash. The gateway removed the bot's active task records and may archive the transcript files.");
await p.close();

p = await open("lc=delete&delbot=otto");
check("S10 a channel route is named as removed", (await dlg(p)).includes("Removes this channel route: Telegram, account home"));
await p.close();

p = await open("lc=delete&delbot=pip");
await click(p, "[data-lc-files]");
check("F-276 ticked, the folders leave the Stays list", !(await dlg(p)).includes("none is asked for the Trash"));
await clickText(p, "#lc-dialog", "Delete Pip");
await p.waitForTimeout(700);
t = await dlg(p);
check("F-276 ticked, each path as the gateway's answer reported it", has(t, "Folders, as the gateway's answer reported them", "workspace-pip: Gateway reported moving this to Trash", "agents/pip/agent: Gateway reported moving this to Trash", "agents/pip/sessions: Gateway reported moving this to Trash", "agents/pip/agent/openclaw-agent.sqlite-journal: Gateway reported this path was already gone"));
check("F-276 ... and the after state says they can be restored from there", t.includes("What was moved to the Trash on the gateway's machine can be restored from there until it's emptied."));
await p.close();

p = await open("lc=delete&delbot=pip&shared=1&files=1");
t = await dlg(p);
check("F-464 a confirmed shared workspace: the exact also-used-by line", t.includes("Its workspace folder, workspace-juniper, stays: also used by Juniper.") && (await p.evaluate(() => !document.querySelector("[data-lc-files]").disabled)));
await clickText(p, "#lc-dialog", "Delete Pip");
await p.waitForTimeout(700);
check("F-464 ... and after, no claim the reply doesn't make", (await text(p, '[data-lc-path="workspace-juniper"]')).includes("workspace-juniper: The gateway didn't confirm what happened to this path. Juniper still lists it as its workspace."));
await p.close();

p = await open("lc=delete&delbot=pip&files=1&delresult=partial");
await clickText(p, "#lc-dialog", "Delete Pip");
await p.waitForTimeout(700);
t = await dlg(p);
check("S10 a path the gateway couldn't move is named with its reason, and Retry cleanup is offered", has(t, "Pip was deleted, but the gateway couldn't move one folder", "workspace-pip: Gateway couldn't move this: permission denied", "Retry cleanup", "Leave it") && !t.includes("still on the gateway"));
await clickText(p, "#lc-dialog", "Retry cleanup");
await p.waitForTimeout(700);
check("S10 Retry cleanup reports again from the answer", (await text(p, '[data-lc-path="workspace-pip"]')).includes("Gateway reported moving this to Trash"));
await p.close();

p = await open("lc=delete&delbot=pip&files=1&delresult=purge");
await clickText(p, "#lc-dialog", "Delete Pip");
await p.waitForTimeout(700);
t = await dlg(p);
check("S10 a session-store failure in its own words, and no folder claims", has(t, "Pip was deleted, but its task records weren't", "The gateway couldn't remove Pip's task records, so it moved no folders.", "Retry the same delete") && !t.includes("Gateway reported moving"));
await p.close();

p = await open("lc=delete&delbot=pip&files=1&delresult=uncertain");
await clickText(p, "#lc-dialog", "Delete Pip");
await p.waitForTimeout(700);
t = await dlg(p);
check("S10 a lost answer keeps the choice and promises nothing", has(t, "Clawtrate didn't get the gateway's answer", "You asked to move its folders to the Trash; a retry asks the same.", "workspace-pip: The gateway didn't confirm what happened to this path", "Check again", "Retry the same delete"));
await clickText(p, "#lc-dialog", "Check again");
await p.waitForTimeout(500);
check("S10 Check again reads again", (await dlg(p)).includes("Read again just now.") && (await dlg(p)).includes("Not in the gateway's list of bots"));
await clickText(p, "#lc-dialog", "Retry the same delete");
await p.waitForTimeout(700);
check("S10 Retry the same delete reports what the answer says", (await dlg(p)).includes("Pip was deleted"));
await p.close();

p = await open("lc=delete&delbot=pip&delresult=refused");
await clickText(p, "#lc-dialog", "Delete Pip");
await p.waitForTimeout(700);
t = await dlg(p);
check("S10 a refusal is quoted, and what is there is read, not promised", has(t, "The gateway didn't delete Pip", "cannot be deleted.", "Still in the gateway's list of bots", "Its settings are still there") && !t.includes("Nothing was removed") && (await text(p, "#bot-list")).includes("Pip"));
await p.close();

p = await open("lc=delete&delbot=pip&delchanged=1");
await clickText(p, "#lc-dialog", "Delete Pip");
await p.waitForTimeout(600);
t = await dlg(p);
check("S10 the preview is read again at Delete, and a change asks again", t.includes("What Pip has changed since this opened: it now has 5 tasks. Check what goes, then delete again.") && t.includes("Its 5 tasks, from every task list") && (await p.evaluate(() => app.bots.some((b) => b.id === "pip"))));
await clickText(p, "#lc-dialog", "Delete Pip");
await p.waitForTimeout(700);
check("S10 ... and deleting again goes through", (await dlg(p)).includes("Pip was deleted"));
await p.close();

p = await open(`bot=otto&${settings}&onlybot=1`);
check("S10 the only bot can't be deleted, with the reason", (await panel(p)).includes("Otto is the gateway's only bot, and the gateway doesn't delete its only bot.") && (await p.evaluate(() => document.querySelector('#panel-settings [data-lc="open-delete"]').disabled)));
await p.close();

p = await open(`bot=otto&${settings}&access=read`);
t = await panel(p);
check("S2 below admin Manage offers Export only", t.includes("Export…") && !t.includes("Duplicate…") && !t.includes("Delete Otto"));
await p.close();

// Phone and dark (section 11) ------------------------------------------------------------------------
p = await open("lc=delete&delbot=pip&width=phone", { width: 390, height: 844 });
check("S11 at 390 a dialog is a sheet the width of the screen", await p.evaluate(() => Math.round(document.querySelector("#lc-dialog").getBoundingClientRect().width) === 390));
check("S11 nothing in it scrolls sideways", await p.evaluate(() => document.querySelector("#lc-dialog .b-body").scrollWidth <= document.querySelector("#lc-dialog .b-body").clientWidth + 1));
await p.close();
p = await open("lc=choose&theme=dark");
check("S11 the star is drawn in dark too", await p.evaluate(() => getComputedStyle(document.querySelector(".lc-star")).backgroundColor !== "rgba(0, 0, 0, 0)"));
await p.close();

// The gallery reaches every state, and each one opens --------------------------------------------------
p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(pageUrl("gallery.html") + "?chrome=0&section=lifecycle");
await p.waitForTimeout(200);
const links = await p.evaluate(() => [...document.querySelectorAll('#lifecycle a[href^="lifecycle.html"]')].map((a) => a.getAttribute("href")));
check("S14 the gallery's Bot lifecycle section links every state", links.length >= 45, `(${links.length})`);
check("S14 the gallery's header links the page", await p.evaluate(() => Boolean(document.querySelector('.gallery header a[href="lifecycle.html"]'))));
await p.close();
let broken = [];
for (const href of links) {
  const q = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  q.on("pageerror", (e) => errors.push(String(e)));
  await q.goto(pageUrl(href) + "&chrome=0");
  await q.waitForTimeout(120);
  if (errors.length) broken.push(`${href}: ${errors[0]}`);
  await q.close();
}
check("S14 every linked state opens without an error", broken.length === 0, broken.join(" | "));

await b.close();
console.log(out.join("\n"));
console.log(`${out.filter((l) => l.startsWith("ok")).length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
