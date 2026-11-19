// Behaviour checks for a task's model and effort in bots.html (conversation.md
// section 25): the chip and its menu, held and refused changes, the event
// line, the turn's record, the read-only form and the phone width.
// Run from the repository root:  node docs/design/prototype/tools/checks/model.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("bots.html") + "?chrome=0&theme=light&bot=otto&task=o1";
const b = await chromium.launch();
const out = [];
let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed += 1;
  out.push(`${ok ? "ok  " : "FAIL"} ${name} ${extra}`);
};
const open = async (query = "", viewport = { width: 1440, height: 900 }) => {
  const p = await b.newPage({ viewport });
  p.on("pageerror", (e) => out.push("PAGEERROR " + e));
  await p.goto(base + (query ? "&" + query : ""));
  await p.waitForTimeout(150);
  return p;
};
process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

// The chip ------------------------------------------------------------------------------------
let p = await open();
check("25.1 the chip sits at the top left of the header, before the title pill", await p.evaluate(() => {
  const chip = document.getElementById("t-chip");
  const pill = document.getElementById("title-pill");
  return chip && chip.getBoundingClientRect().right < pill.getBoundingClientRect().left && chip.compareDocumentPosition(pill) & Node.DOCUMENT_POSITION_FOLLOWING;
}));
check("25.1 it reads the model and the effort, and its name is complete", await p.evaluate(() => {
  const chip = document.getElementById("t-chip");
  return chip.textContent.includes("dev-1") && chip.textContent.includes("Low") && chip.getAttribute("aria-label") === "Model for this task: acme/dev-1, Low effort. Change." && chip.getAttribute("aria-haspopup") === "menu";
}));
await p.focus("#t-chip");
await p.keyboard.press("Enter");
check("25.1 Enter opens the menu with focus on the checked model", await p.evaluate(() => document.activeElement.dataset.tModel === "dev-1" && document.activeElement.getAttribute("aria-checked") === "true" && document.getElementById("t-chip").getAttribute("aria-expanded") === "true"));
check("25.1 the menu has a Model group and an Effort group, and its foot names the bot's settings", await p.evaluate(() => {
  const groups = [...document.querySelectorAll('.t-menu [role="group"]')].map((g) => g.getAttribute("aria-label"));
  return groups.join() === "Model,Effort" && document.querySelector(".t-menu-foot").textContent.includes("Otto's own model is in its settings");
}));
check("25.1 an unavailable model is shown, disabled, with Not available", await p.evaluate(() => {
  const old = document.querySelector('[data-t-model="dev-old"]');
  return old.disabled && old.textContent.includes("Not available");
}));
await p.keyboard.press("End");
await p.keyboard.press("Home");
await p.keyboard.press("ArrowDown");
check("25.1 arrows move through the items", await p.evaluate(() => document.activeElement.dataset.tModel === "dev-2"));
await p.keyboard.press("Escape");
check("25.1 Escape closes the menu alone and returns focus to the chip", await p.evaluate(() => !document.querySelector(".t-menu") && document.activeElement.id === "t-chip"));

// Saving at once: no turn runs --------------------------------------------------------------------
await p.click("#t-chip");
await p.click('[data-t-model="dev-lite"]');
await p.waitForTimeout(40);
check("25.4 a saved change posts an event line, and the effort follows the model", await p.evaluate(() => {
  const lines = [...document.querySelectorAll(".t-event")].map((l) => l.textContent);
  return lines.at(-1) === "Model changed to acme/dev-lite, effort to Off · from the next turn";
}));
check("25.2 the chip shows the saved values and focus is back on it", await p.evaluate(() => document.getElementById("t-chip").textContent.includes("dev-lite") && document.activeElement.id === "t-chip"));
check("25.2 the change is announced", await p.evaluate(() => document.getElementById("b-announce").textContent === "Model changed for this task"));
check("25.4 the line's name says what it was and when", await p.evaluate(() => document.querySelector(".t-event:last-of-type").getAttribute("aria-label").includes("Was acme/dev-1 · Low.")));
await p.close();

// Held during a run ------------------------------------------------------------------------------
p = await open("running=1");
await p.click("#t-chip");
await p.click('[data-t-effort="high"]');
await p.waitForTimeout(40);
check("25.3 a change during a run is held: the chip shows it with the clock and says so", await p.evaluate(() => {
  const chip = document.getElementById("t-chip");
  return chip.textContent.includes("High") && !!chip.querySelector(".t-held") && chip.getAttribute("aria-label").includes("Held until this turn ends");
}));
check("25.3 a held change posts no line yet", await p.evaluate(() => [...document.querySelectorAll(".t-event")].every((l) => !l.textContent.startsWith("Effort changed"))));
check("25.3 holding is announced", await p.evaluate(() => document.getElementById("b-announce").textContent === "Held until this turn ends"));
await p.evaluate(() => window.app.setPanel(true));
await p.waitForTimeout(60);
check("25.3 Details says it is held and offers to keep the model", await p.evaluate(() => document.getElementById("t-details-line").textContent.includes("Held until Otto's turn ends") && !!document.querySelector("[data-t-keep]")));
await p.click("[data-t-keep]");
await p.waitForTimeout(40);
check("25.3 Keep cancels the held change", await p.evaluate(() => !document.getElementById("t-chip").querySelector(".t-held") && document.getElementById("t-chip").textContent.includes("Low")));
await p.close();

// Refused ------------------------------------------------------------------------------------------
p = await open("tmodel=refused&panel=open");
check("25.2 a refused change puts the chip back to what the gateway has", await p.evaluate(() => document.getElementById("t-chip").textContent.includes("dev-lite") && document.getElementById("t-chip").textContent.includes("Off")));
check("25.4 a refused change posts a line with a warning mark", await p.evaluate(() => {
  const line = document.querySelector('.t-event[data-tone="warn"]');
  return line && line.textContent.startsWith("Couldn't change the effort to High") && !!line.querySelector(".icon");
}));
check("25.2 Details gives the gateway's reason", await p.evaluate(() => document.getElementById("t-details-line").textContent.includes("is not supported for acme/dev-lite")));
await p.close();

// The turn's record ----------------------------------------------------------------------------------
p = await open("record=open");
check("25.5 the run line's tooltip is the record", await p.evaluate(() => document.querySelector("#t-run > summary").title === "acme/dev-2 · low effort requested"));
check("25.5 opened, it shows the record and the run id, and says requested, never used", await p.evaluate(() => {
  const text = document.querySelector("#t-run .run-record").textContent;
  return text.includes("acme/dev-2") && text.includes("low effort requested") && text.includes("run-7c41d09e") && !text.includes("used");
}));
await p.click("[data-t-raw]");
check("25.5 Raw holds the model as the gateway sends it and what was sent, each labelled", await p.evaluate(() => {
  const raw = document.querySelector(".t-raw");
  return !raw.hidden && raw.textContent.includes("Model, as the gateway sends it") && raw.textContent.includes('"phase":"model"') && raw.textContent.includes("The task's effort when this turn was sent, from its row") && raw.textContent.includes('"thinkingDefault":"low"');
}));
await p.close();

// Loading and failed lists, not reported ------------------------------------------------------------
p = await open("tmodel=loading");
await p.click("#t-chip");
check("25.2 while the list loads the menu says so and offers nothing", await p.evaluate(() => document.querySelector(".t-menu-wait").textContent === "Loading models…" && !document.querySelector(".t-menu .menu-item")));
await p.close();
p = await open("tmodel=failed");
await p.click("#t-chip");
check("25.2 a list that failed offers Try again", await p.evaluate(() => document.querySelector(".t-menu-wait").textContent.includes("Couldn't load the models.") && document.activeElement.dataset.tRetry !== undefined));
await p.close();
p = await open("tmodel=unreported");
check("25.2 a task whose row names no model has no chip and no Model group", await p.evaluate(() => !document.getElementById("t-chip") && !document.getElementById("t-details")));
await p.close();

// Read-only --------------------------------------------------------------------------------------------
p = await open("access=read&panel=open");
check("25.6 read-only: the chip is a note with the values and no control", await p.evaluate(() => {
  const chip = document.getElementById("t-chip");
  return chip.tagName === "P" && chip.getAttribute("role") === "note" && chip.textContent.includes("dev-1") && !chip.getAttribute("aria-label").includes("Change");
}));
check("25.6 read-only: Details shows fact rows and no selects", await p.evaluate(() => !document.querySelector("#t-details .b-select") && document.querySelector("#t-details .facts").textContent.includes("acme/dev-1")));
await p.close();

// The phone ----------------------------------------------------------------------------------------------
p = await open("width=phone&panel=open", { width: 390, height: 844 });
check("25.7 below 688 px there is no chip; Back has the header's left side", await p.evaluate(() => getComputedStyle(document.getElementById("t-chip")).display === "none"));
check("25.7 Details holds the control, Model over Effort", await p.evaluate(() => {
  const [m, e] = document.querySelectorAll("#t-details .b-select");
  return m && e && e.getBoundingClientRect().top > m.getBoundingClientRect().top;
}));
await p.close();

// Dark ------------------------------------------------------------------------------------------------------
p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(base.replace("theme=light", "theme=dark"));
await p.waitForTimeout(150);
check("25.7 the chip uses the raised fill in the dark theme too", await p.evaluate(() => {
  const chip = getComputedStyle(document.getElementById("t-chip"));
  return chip.backgroundColor !== getComputedStyle(document.querySelector(".conversation")).backgroundColor;
}));
await p.close();

await b.close();
console.log(out.join("\n"));
console.log(`${out.filter((l) => l.startsWith("ok")).length} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
