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
check("S4 with the tool offered, the tab says less, not more", (await dlg(p)).includes("Juniper is offered the gateway's image tool, but Clawtrate can't make a picture with it yet. Ask Juniper for one in a task."));
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
p = await open(`bot=juniper&${settings}`);
t = await panel(p);
check("F-040 About has one row: the two files", (await p.evaluate(() => document.querySelector('[data-bs="instructions"] .b-open-value')?.textContent)) === "AGENTS.md, 5 lines · SOUL.md, 1 line" && !t.includes("Description"));
await click(p, '[data-bs="instructions"]');
t = await panel(p);
check("F-040 the page names both files and says when they are read", has(t, "Juniper reads these two files at the start of each new task. A task already open keeps the copy it started with.", "Instructions · AGENTS.md", "Personality · SOUL.md"));
check("F-040 it says memory is separate", t.includes("Memory is separate: what Juniper remembers is under Memory, and these files don't change it."));
check("F-040 Save waits for a change", await p.evaluate(() => document.querySelector('[data-lc="instr-save"]').disabled));
await p.fill("#lc-agents", "# Juniper\n\nCite every source.\n");
await click(p, '[data-lc="instr-save"]');
check("F-040 Saving, then Saved only on the hash read back", (await panel(p)).includes("Saving…") && (await announced(p, 550)) === "Instructions saved" && (await panel(p)).includes("Saved 5:44 PM. The gateway has this text now."));
await p.close();

p = await open(`bot=juniper&${settings}&bview=instructions&instr=conflict`);
t = await panel(p);
check("F-040 a change on the gateway during editing keeps the person's text and shows the gateway's", has(t, "Juniper's instructions changed on the gateway while you were editing. Your text is kept here. The gateway now has:", "Cite every source you use, with its date.", "Save mine over it", "Use the gateway's") && (await p.evaluate(() => document.querySelector('[data-lc="instr-save"]').disabled && document.querySelector("#lc-agents").value.includes("200 words"))));
await clickText(p, "#panel-settings", "Save mine over it");
check("F-040 Save mine over it writes the kept text", (await announced(p, 550)) === "Saved over the gateway's copy");
await p.close();
p = await open(`bot=juniper&${settings}&bview=instructions&instr=conflict`);
await clickText(p, "#panel-settings", "Use the gateway's");
check("F-040 Use the gateway's shows the gateway's text", (await p.evaluate(() => document.querySelector("#lc-agents").value.includes("with its date"))) && !(await panel(p)).includes("changed on the gateway while"));
await p.close();
p = await open(`bot=juniper&${settings}&bview=instructions&instrfail=1`);
await p.fill("#lc-soul", "Brisk.\n");
await click(p, '[data-lc="instr-save"]');
await p.waitForTimeout(550);
check("S6 a failed save keeps the text and says so", (await panel(p)).includes("Couldn't save: the gateway didn't answer. Your text is kept here.") && (await p.evaluate(() => document.querySelector("#lc-soul").value === "Brisk.\n")));
await p.close();
p = await open(`bot=juniper&${settings}&bview=instructions&access=read`);
t = await panel(p);
check("S6 below admin the files are text and the bar asks for admin", (await p.evaluate(() => !document.querySelector("#panel-settings textarea"))) && t.includes("Changing Juniper's instructions needs admin access.") && t.includes("Cite every source you use."));
await p.close();

// A change to the instructions in the conversation (section 7) ---------------------------------------
const role = (p) => text(p, "#lc-role");
p = await open("bot=juniper&task=j1&rolechange=1");
check("F-041 the run's change posts an event line", (await role(p)).startsWith("Juniper changed its instructions"));
await click(p, "#lc-role summary");
t = await role(p);
check("F-041 opened, it shows the diff from Clawtrate's last copy", has(t, "AGENTS.md, since Clawtrate read it at 5:38 PM", "Removed: Keep answers under 300 words.", "Added: Keep answers under 200 words.", "Accept", "Undo", "The change is already saved on the gateway."));
await clickText(p, "#lc-role", "Accept");
check("F-041 Accept writes nothing and says so", (await role(p)).includes("Accepted. The change was already on the gateway, so nothing was written.") && (await role(p)).includes("· accepted"));
await p.close();
p = await open("bot=juniper&task=j1&rolechange=1");
await click(p, "#lc-role summary");
await clickText(p, "#lc-role", "Undo");
check("F-041 Undo shows Undoing, then what the gateway has", (await role(p)).includes("Undoing…") && (await announced(p, 550)) === "Undone" && (await role(p)).includes("Undone. AGENTS.md on the gateway is back to Clawtrate's copy from 5:38 PM."));
await p.close();
p = await open("bot=juniper&task=j1&rolechange=1&undo=conflict");
await click(p, "#lc-role summary");
await clickText(p, "#lc-role", "Undo");
await p.waitForTimeout(550);
check("S7 an undo that would overwrite a later change is refused", (await role(p)).includes("Nothing was undone: AGENTS.md changed again after this run. Open the instructions to see what it has now."));
await clickText(p, "#lc-role", "Open instructions");
await p.waitForTimeout(100);
check("S7 Open instructions opens the page", (await panel(p)).includes("Personality · SOUL.md"));
await p.close();
p = await open("bot=juniper&task=j1&rolechange=1&rolediff=nocopy");
await click(p, "#lc-role summary");
t = await role(p);
check("S7 with no earlier copy it says so and offers no Undo", t.includes("Juniper wrote to AGENTS.md in this run. Clawtrate has no earlier copy of the file to compare, so it can't show the change or undo it.") && !t.includes("Undo"));
await p.close();
p = await open("bot=juniper&task=j1&rolechange=1&access=read");
await click(p, "#lc-role summary");
t = await role(p);
check("S7 below admin: Accept only, and why", t.includes("Undoing it needs admin access.") && !(await p.evaluate(() => [...document.querySelectorAll("#lc-role button")].some((x) => x.textContent === "Undo"))));
await p.close();

// Duplicate (section 8) -----------------------------------------------------------------------------
p = await open(`bot=pip&${settings}`);
await clickText(p, "#panel-settings", "Duplicate…");
t = await dlg(p);
check("F-048 Duplicate has a name and a checklist of what is copied", has(t, "Duplicate Pip", "Name of the copy", "Picture and label", "Model, account and effort", "OpenAI · Home, gpt-5.5-mini, effort Low.", "Instructions and personality", "Tool permissions and skills"));
check("F-048 it lists what is not copied, from what was read", has(t, "Its memory: MEMORY.md and 3 notes, and About you (USER.md)", "Its 4 tasks and their history", "Its 2 routines: Weekly plan, Sunday reminder. A copy would run them twice.", "The other files in its workspace folder", "Its own sign-ins (Pip's key), which only Pip can use"));
check("S8 it says the copy is a new bot, not linked", t.includes("The copy is a new bot with its own workspace folder. Nothing links it to Pip afterwards: changing one doesn't change the other."));
await click(p, '[data-lc-copy="tools"]');
await click(p, '[data-lc="dup-go"]');
check("S8 progress shows each step with its state", (await dlg(p)).includes("Duplicating Pip") && (await dlg(p)).includes("Made Pip copy"));
await p.waitForTimeout(1500);
t = await dlg(p);
check("F-048 a copy that read back is ready, with only what was ticked", has(t, "Pip copy is ready", "Read back Pip copy from the gateway", "Read back from the gateway: Pip copy is listed with what's ticked above.") && !t.includes("Tool permissions and skills"));
await clickText(p, "#lc-dialog", "Open Pip copy");
check("F-048 Open shows the copy in the list", (await text(p, "#bot-list")).includes("Pip copy") && (await p.evaluate(() => app.model.selectedBot)) === "pip-copy");
await p.close();

p = await open("lc=duplicate&delbot=pip&dup=partial");
await click(p, '[data-lc="dup-go"]');
await p.waitForTimeout(1600);
t = await dlg(p);
check("S8 a step that failed after the bot was made is named, and the rest stands", has(t, "Pip copy was made, without Pip's instructions", "Not copied", "Its instructions weren't copied: the gateway didn't answer. Pip copy has the gateway's starting AGENTS.md and SOUL.md.", "Try again", "Leave it as it is"));
await clickText(p, "#lc-dialog", "Try again");
await p.waitForTimeout(800);
check("S8 Try again does the missing steps", (await dlg(p)).includes("Pip copy is ready"));
await p.close();

p = await open("lc=duplicate&delbot=pip&dup=refused");
await click(p, '[data-lc="dup-go"]');
await p.waitForTimeout(500);
check("S8 a refused create makes nothing and says so", (await dlg(p)).includes("The gateway didn't make the copy: “agent \"pip-copy\" already exists”. Nothing was made.") && (await p.evaluate(() => !app.bots.some((x) => x.id === "pip-copy"))));
await p.close();

p = await open("lc=duplicate&delbot=pip&dupacct=own");
t = await dlg(p);
check("S8 an account kept by the bot alone isn't carried; the copy's account is chosen", t.includes("Model and effort, on an account you choose") && t.includes("Pip's key is kept by Pip alone, so the copy can't use it.") && (await p.evaluate(() => document.querySelector('[data-lc="dup-go"]').disabled)));
await click(p, '[data-lc-acct="openai:work"]');
check("S8 ... and Duplicate waits for that choice", await p.evaluate(() => !document.querySelector('[data-lc="dup-go"]').disabled));
await p.close();
p = await open("lc=duplicate&delbot=pip&access=read");
check("S2 below admin Duplicate asks for admin", (await dlg(p)).includes("Duplicating Pip needs admin access."));
await p.close();

// Export and import (section 9) ------------------------------------------------------------------------
p = await open("lc=export&delbot=marlow");
t = await dlg(p);
check("F-049 a bot installed from a package: the gateway's own export command", has(t, "Marlow was installed from a package, so the gateway can export it again with its own command line. Clawtrate can't make a package itself.", "OPENCLAW_EXPERIMENTAL_CLAWS=1 openclaw claws export marlow --out ./marlow-claw", "Its memory, its tasks and their transcripts", "Sign-ins and keys"));
await p.close();
p = await open("lc=export&delbot=pip");
t = await dlg(p);
check("F-049 a bot made by the create method can't be exported, said plainly", has(t, "The gateway can't export Pip", "The gateway exports only bots installed from a package. Pip was made with the gateway's create method, which gives it settings a package can't hold, and Clawtrate has no other way to export a bot."));
await clickText(p, "#lc-dialog", "Duplicate…");
check("S9 ... and offers to duplicate instead", (await dlg(p)).includes("Duplicate Pip"));
await p.close();
p = await open("lc=export&delbot=otto");
check("F-049 a bot with no record: the gateway's own check", (await dlg(p)).includes("OPENCLAW_EXPERIMENTAL_CLAWS=1 openclaw claws migrate otto --dry-run") && (await dlg(p)).includes("Packages are an experimental part of the gateway"));
await p.close();
p = await open("");
await click(p, "#new-button");
await p.waitForTimeout(60);
check("F-265 the + menu has Import a bot…", (await text(p, "#rail-menu")).includes("Import a bot…"));
await clickText(p, "#rail-menu", "Import a bot…");
t = await dlg(p);
check("F-265 Import shows the gateway's dry run, then the add with its digest", has(t, "Clawtrate can't read a package or add one itself.", "openclaw claws add ./pip-claw --dry-run", "openclaw claws add ./pip-claw --yes --plan-integrity <digest>", "The new bot appears in your list when the gateway lists it."));
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
check("F-050 the dialog lists what goes now", has(t, "Delete Pip?", "Pip's settings", "Its 4 tasks, from every task list", "Its 2 routines: Weekly plan, Sunday reminder", "Approvals saved for its commands"));
check("F-276 the folder option is unticked, and names each folder and the memory in it", has(t, "Also move Pip's folders to the Trash on the gateway's machine", "Its workspace folder, workspace-pip: 23 files, its memory among them (MEMORY.md and 3 notes)", "Its own folder, with the sign-ins only Pip uses (Pip's key)", "Its tasks' transcripts") && (await p.evaluate(() => !document.querySelector("[data-lc-files]").checked)));
check("F-050 the dialog lists what stays", has(t, "All three folders above, where they are now", "Accounts other bots use, and shared memory", "What Pip said in other bots' tasks", "This can't be undone from Clawtrate."));
check("S10 focus starts on Cancel", await p.evaluate(() => document.activeElement?.textContent === "Cancel"));
await clickText(p, "#lc-dialog", "Delete Pip");
check("S10 Deleting", (await dlg(p)).includes("Deleting Pip…"));
await p.waitForTimeout(700);
t = await dlg(p);
check("F-050 F-276 afterwards it says what the gateway has, read back; unticked, the folders stay", has(t, "Pip was deleted", "Read back from the gateway just now:", "No longer in the gateway's list of bots", "No tasks of Pip's listed", "No routines of Pip's", "Its folders stay on the gateway's machine, as asked") && !(await text(p, "#bot-list")).includes("Pip"));
await p.close();

p = await open("lc=delete&delbot=pip");
await click(p, "[data-lc-files]");
check("F-276 ticked, the folders leave the Stays list", !(await dlg(p)).includes("All three folders above"));
await clickText(p, "#lc-dialog", "Delete Pip");
await p.waitForTimeout(700);
check("F-276 ticked, the folders are moved to the Trash", (await dlg(p)).includes("Its workspace folder, its own folder and its tasks' transcripts moved to the Trash"));
await p.close();

p = await open("lc=delete&delbot=pip&shared=1&files=1");
t = await dlg(p);
check("F-464 a workspace another bot uses stays, said before", t.includes("Its workspace folder, workspace-juniper, stays: also used by Juniper."));
await clickText(p, "#lc-dialog", "Delete Pip");
await p.waitForTimeout(700);
check("F-464 ... and after", (await dlg(p)).includes("Its own folder and its tasks' transcripts moved to the Trash; workspace-juniper stays for Juniper"));
await p.close();

p = await open("lc=delete&delbot=pip&files=1&delresult=partial");
await clickText(p, "#lc-dialog", "Delete Pip");
await p.waitForTimeout(700);
t = await dlg(p);
check("S10 a folder the gateway couldn't move is named with its reason", has(t, "Pip was deleted, but one folder is still there", "workspace-pip wasn't moved: permission denied. It's still on the gateway's machine.", "Trying again moves what's left.", "Try again", "Leave it"));
await clickText(p, "#lc-dialog", "Try again");
await p.waitForTimeout(700);
check("S10 Try again finishes the delete", (await dlg(p)).includes("Pip was deleted") && (await dlg(p)).includes("moved to the Trash"));
await p.close();

p = await open("lc=delete&delbot=pip&delresult=uncertain");
await clickText(p, "#lc-dialog", "Delete Pip");
await p.waitForTimeout(700);
t = await dlg(p);
check("S10 a lost answer: what was read, and what isn't known", has(t, "Pip is no longer listed", "What happened to its folders: the gateway's answer was lost", "Trying again finishes the same delete"));
await clickText(p, "#lc-dialog", "Try again");
await p.waitForTimeout(700);
check("S10 ... and Try again ends it", (await dlg(p)).includes("Pip was deleted"));
await p.close();

p = await open("lc=delete&delbot=pip&delresult=refused");
await clickText(p, "#lc-dialog", "Delete Pip");
await p.waitForTimeout(700);
t = await dlg(p);
check("S10 a refusal is quoted, and nothing is said to have changed", has(t, "The gateway didn't delete Pip", "cannot be deleted.", "Nothing was removed.") && (await text(p, "#bot-list")).includes("Pip"));
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
