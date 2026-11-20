// Checks for groups.html: every walk of docs/design/group-chats.md clicked
// through to its outcome, and every state's words and structure.
// Run from the repository root:  node docs/design/prototype/tools/checks/groups.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("groups.html") + "?chrome=0";
const b = await chromium.launch();
const out = [];
let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed += 1;
  out.push(`${ok ? "ok  " : "FAIL"} ${name} ${ok ? "" : extra}`);
};
const open = async (query = "", { width = 1440, height = 900, theme = "light" } = {}) => {
  const p = await b.newPage({ viewport: { width, height } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(`${base}&theme=${theme}${width < 500 ? "&width=phone" : ""}&${query}`);
  await p.waitForTimeout(150);
  p.errors = errors;
  return p;
};
const text = (p, sel = "#root") => p.evaluate((s) => [...document.querySelectorAll(s)].map((n) => n.textContent).join(" ").replace(/\s+/g, " "), sel);
const missing = (t, words) => words.filter((w) => !t.includes(w));
const has = async (name, p, words, sel) => {
  const t = await text(p, sel);
  const miss = missing(t, words);
  check(name, miss.length === 0 && p.errors.length === 0, `missing: ${miss.join(" | ")} ${p.errors.join(" | ")}`);
};
const waitText = async (p, words, sel = "#root", timeout = 5000) => {
  try {
    await p.waitForFunction(
      ([s, w]) => {
        const t = [...document.querySelectorAll(s)].map((n) => n.textContent).join(" ").replace(/\s+/g, " ");
        return w.every((x) => t.includes(x));
      },
      [sel, words],
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
};
const btn = (p, name) => p.getByRole("button", { name, exact: true }).first().click();
// A menu item's name may end with its shortcut ("New group⌘⇧N").
const item = (p, name) => p.getByRole("menuitem", { name: new RegExp(`^${name.replace(/[()]/g, "\\$&")}`) }).first().click();
const label = (p, sel) => p.getAttribute(sel, "aria-label");
const gone = (p, sel, timeout = 4000) => p.locator(sel).first().waitFor({ state: "detached", timeout }).then(() => true, () => false);
const members = (p, n, timeout = 4000) => p.locator(`.bot[data-group="g1"] .g-stack[data-count="${n}"]`).waitFor({ timeout }).then(() => true, () => false);
const order = (p, words) => p.evaluate((w) => { const t = document.querySelector(".transcript-inner").textContent; return w.map((x) => t.indexOf(x)); }, words);
const type = async (p, value) => {
  await p.click("#g-input");
  await p.keyboard.type(value);
};

process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

// Part 1: each state's words, controls and names --------------------------------------------
{
  const p = await open("state=open");
  await has("open: the group row, the first line, your message once, speakers, the cost", p, [
    "Weekend plans",
    "Otto: Done. The old cache folder is gone",
    "Clawtrate sends each bot a separate copy. It doesn't pass bot replies between tasks.",
    "Sent to Juniper, Otto and Marlow",
    "3 bots · Each bot that answers uses its own tokens",
  ]);
  const row = await label(p, '.bot[data-group="g1"]');
  check("open: the row's name lists the members", row.startsWith("Weekend plans, group of 3: Juniper, Otto and Marlow"), row);
  check("open: your message is one bubble", (await p.locator('.msg[data-role="user"]').count()) === 1);
  const bubble = await label(p, '.msg[data-role="user"]');
  check("open: the delivery line is part of the bubble's name", bubble === "You said: Plan Saturday for us: the trail in the morning, errands after lunch. Sent to Juniper, Otto and Marlow.", bubble);
  check("open: no Attach control in the group composer", (await p.getByRole("button", { name: "Attach files" }).count()) === 0);
  check("open: Send is named for everyone", (await label(p, "[data-send]")) === "Send to everyone");
  check("open: no Work pane for a group", (await p.locator("#work-panel").count()) === 0);
  const rail = await p.locator("#bot-list .bot-name").allTextContents();
  check("open: bots and groups in one list by recent activity", rail.join("|") === "Weekend plans|Juniper|Dinner plans|Otto|Marlow|Pip", rail.join("|"));
  await p.close();
  const q = await open("state=open&dinner=recent");
  const rail2 = await q.locator("#bot-list .bot-name").allTextContents();
  check("rail: a more recent group moves up", rail2.join("|") === "Dinner plans|Weekend plans|Juniper|Otto|Marlow|Pip", rail2.join("|"));
  await q.click('.bot[data-group="g2"]');
  const dinner = await waitText(q, ["Pasta with the spinach and the last of the feta."], ".transcript-inner");
  await q.click('.bot[data-group="g1"]');
  const back = await waitText(q, ["Plan Saturday for us"], ".transcript-inner");
  check("rail: each group opens its own column", dinner && back);
  await q.close();
}
{
  const p = await open("state=empty");
  await has("empty: the two sentences", p, ["Clawtrate sends each bot a separate copy. It doesn't pass bot replies between tasks.", "Write to everyone, or start with @ to choose who answers."]);
  await p.close();
}
{
  const p = await open("state=running");
  await has("running: two status lines and the row", p, ["Searching the web for trail closures", "Reading backup-2026-11-15.log", "Juniper and Otto are working"]);
  check("running: Stop names the count", (await label(p, "[data-stop]")) === "Stop 2 bots");
  check("running: one status line per active run", (await p.locator(".g-status .status-line").count()) === 2);
  await p.close();
}
{
  const p = await open("state=partial");
  await has("partial: the where-it-went line, opened", p, [
    "Sent to Juniper and Otto · Couldn't send to Marlow",
    "The gateway answered: Session … is archived. Restore it before starting new work.",
    "Marlow's task in this group is archived. Messages to everyone skip Marlow.",
    "Restore Marlow's task",
  ]);
  await p.close();
}
{
  const p = await open("state=approval");
  await has("approval: the card names the bot, its task and run; shelf and row", p, [
    "Otto wants to run a command",
    "In Otto's task in this group, run a36bfcc7.",
    "Otto needs your approval to run a command",
    "Waiting for you: Otto, approve a command",
    "Allow once",
    "Always allow…",
    "Deny",
  ]);
  await p.close();
}
{
  const p = await open("state=both");
  await has("both: an approval and a question need attention", p, ["Otto wants to run a command", "Which route should I plan for Saturday?", "Otto needs your approval to run a command", "Juniper asked you a question.", "Waiting for you: Otto and Juniper"]);
  check("both: one card of each, keyed apart", (await p.locator("#g-approval").count()) === 1 && (await p.locator("#g-question").count()) === 1);
  await p.close();
}
{
  const p = await open("state=question");
  await has("question: the card, the shelf and the row", p, [
    "How long should I keep the cache in /srv/scratch before deleting it?",
    "Otto asked you a question. A message to Otto now is held until you answer.",
    "Waiting for you: Otto, a question",
  ]);
  await p.close();
}
{
  const p = await open("state=other");
  await has("other connection: a question it lists, beside an approval it has no card for", p, [
    "Otto is waiting for approval. This connection has no approval card for this run.",
    "Waiting for an answer",
    "Which route should I plan for Saturday?",
    "Waiting for you: Juniper, a question",
    "In Otto's task history",
    "In Juniper's, Otto's and Marlow's task histories",
  ]);
  check("other connection: no approval card", (await p.locator("#g-approval").count()) === 0);
  const t = await text(p);
  check("other connection: claims no device or message for the approval", !t.includes("device that sent") && !t.includes("this message"));
  await p.locator("#g-question .option").first().click();
  check("other connection: answers the question whose run began elsewhere", await waitText(p, ["The lake loop, then."], ".transcript-inner"));
  await p.close();
}
{
  const p = await open("state=readonly");
  await has("read-only: the access bar", p, ["Read-only. You can follow this group here. Approvals and questions aren't shown on this connection.", "Request access"]);
  check("read-only: no composer field and no New", (await p.locator("#g-input").count()) === 0 && (await p.locator("#new-button").isHidden()));
  check("read-only: no message menu", (await p.locator("[data-msg-menu]").count()) === 0);
  await btn(p, "Request access");
  check("read-only: Request access asks, then waits for the owner", await waitText(p, ["Waiting for the gateway's owner."]));
  await p.click("#title-pill");
  await p.waitForTimeout(250); // the record is read first
  await has("read-only: details read, with no changes", p, ["Group details", "Kept with your preferences on the gateway. Your other devices show this group."], "#g-dialog");
  await p.waitForTimeout(200);
  check("read-only: details have no Rename, Add or Remove", (await p.locator("#g-dialog [data-rename], #g-dialog [data-add], #g-dialog [data-remove-group], #g-dialog [data-remove-member]").count()) === 0);
  await p.close();
}
{
  const p = await open("state=offline");
  await has("offline: the held message", p, ["Bring sunscreen too.", "Sends when reconnected"]);
  check("offline: the placeholder", (await p.getAttribute("#g-input", "placeholder")) === "Offline. Messages send when you reconnect.");
  await p.evaluate(() => document.getElementById("g-reconnect").click()); // the prototype bar's "Reconnect"
  check("offline: reconnecting sends it to each member", await waitText(p, ["Bring sunscreen too.", "Sent to Juniper, Otto and Marlow"], ".transcript-inner"));
  await p.close();
}
for (const [s, line, action] of [
  ["archived", "Marlow's task in this group is archived. Messages to everyone skip Marlow.", "Restore Marlow's task"],
  ["taskgone", "Marlow's task in this group was deleted. Messages to everyone skip Marlow.", "Start a new task for Marlow"],
  ["botgone", "Marlow was deleted, with its tasks. Messages to everyone skip Marlow.", "Remove Marlow"],
  ["changed", "Marlow's task changed during the send. The gateway accepted a copy in a new task.", "Use the new task"],
  ["replaced", "Marlow's task was replaced: a new task is at its place.", "Use the new task"],
]) {
  const p = await open(`state=${s}`);
  await has(`${s}: the line and its action`, p, [line, action]);
  const chip = await label(p, ".g-chip[data-skipped]");
  check(`${s}: the To line strikes Marlow`, !!chip && chip.startsWith("Marlow, skipped"), String(chip));
  await p.close();
}
{
  const p = await open("state=removed");
  await has("removed: what stays", p, ["Removed Weekend plans. Juniper's, Otto's and Marlow's tasks stay in their lists."]);
  await p.close();
}
{
  const p = await open("bot=otto");
  await has("a member task under its bot", p, ["This task is part of Weekend plans. Only your messages to Otto are here.", "Open the group"]);
  const name = await label(p, "[data-member-task]");
  check("a member task's name says its group", name.endsWith("in the group Weekend plans"), name);
  check("a member task shows Otto's side only", (await p.locator(".msg").count()) === 2);
  await btn(p, "Open the group");
  check("Open the group returns to the column", await waitText(p, ["Clawtrate sends each bot a separate copy."]));
  await p.close();
}
for (const [q, words] of [
  ["open=new&fail=noprefs", ["This connection can't keep preferences on the gateway, so it can't keep a group.", "Close"]],
  ["open=new", ["New group", "Choose 2 to 6 bots.", "Clawtrate makes a new task with each bot and keeps the group with your preferences on the gateway, so your other devices show it."]],
  ["open=new&pick=juniper,otto", ["Name: Robin, Juniper and Otto. You can rename it later."]],
  ["open=new&pick=juniper,otto,marlow,pip,extra1,extra2", ["A group has at most 6 bots."]],
  ["open=details", ["Group details", "Rename", "Members", "Open Otto's task", "Each member has its own task with you. Opening it shows your messages to that bot and its replies.", "Add a bot", "Remove group…"]],
  ["confirm=member", ["Remove Marlow from Weekend plans?", "Marlow's task and its history stay in Marlow's list. Clawtrate skips Marlow in future group sends. Work the gateway already accepted can continue."]],
  ["confirm=group", ["Remove Weekend plans?", "Juniper's, Otto's and Marlow's tasks stay in their lists, with everything in them. Only the group goes, on all your devices. Nothing running is stopped."]],
  ["state=taskgone&confirm=group", ["Juniper's and Otto's tasks stay in their lists", "Marlow's task is already gone."]],
]) {
  const p = await open(q);
  if (q === "open=details") await p.waitForTimeout(250); // the record is read first
  await has(`dialog ${q}`, p, words, "#g-dialog");
  await p.close();
}
{
  const p = await open("open=new&pick=juniper");
  check("New group: Create waits for two bots", await p.locator("[data-create]").isDisabled());
  await p.close();
  const q = await open("open=new&pick=juniper,otto,marlow,pip,extra1,extra2");
  check("New group: a seventh bot cannot be chosen", (await q.getAttribute('[data-pick="extra3"]', "aria-disabled")) === "true");
  await q.close();
}
for (const [q, words, to] of [
  ["compose=mention", ["Everyone", "Juniper", "Otto", "Marlow"], "To Everyone. 3 bots. Each bot that answers uses its own tokens."],
  ["compose=otto", ["To", "Otto", "1 bot · Each bot that answers uses its own tokens"], "To Otto. 1 bot. Each bot that answers uses its own tokens."],
  ["compose=reply", ["Replying to Juniper", "(replying)"], "To Juniper (replying). 1 bot. Each bot that answers uses its own tokens."],
  ["compose=quote", ["To", "Juniper"], "To Juniper. 1 bot. Each bot that answers uses its own tokens."],
  ["state=samename&compose=ambiguous", ["@Otto matches 2 members. Choose one in the list.", "Otto (Operations)", "Otto (Garage)"], "@Otto matches 2 members. Choose one in the list."],
]) {
  const p = await open(q);
  await has(`composer ${q}`, p, words, "#composer-slot");
  const got = await label(p, ".g-to");
  check(`composer ${q}: the To line's name`, got === to, got);
  if (q === "compose=mention") check("composer: the mention list is a menu", (await p.locator(".g-mentions[role=menu] [role=menuitem]").count()) === 4);
  if (q === "compose=otto") check("composer: Send names Otto", (await label(p, "[data-send]")) === "Send to Otto");
  if (q === "compose=reply") check("composer: Send names Juniper", (await label(p, "[data-send]")) === "Send to Juniper");
  if (q === "compose=quote") check("composer: a quoted @Otto chooses no one", (await label(p, "[data-send]")) === "Send to Juniper");
  if (q.includes("ambiguous")) check("composer: Send waits for a choice", await p.locator("[data-send]").isDisabled());
  await p.close();
}

// Part 2: the walks ------------------------------------------------------------------------
async function newGroup(query, picks, steps, end, name) {
  const p = await open(query);
  await p.click("#new-button");
  await item(p, "New group");
  for (const pick of picks) await p.click(`[data-pick="${pick}"]`);
  await btn(p, "Create");
  for (const [wait, act] of steps) {
    if (!(await waitText(p, wait, "#g-dialog"))) {
      check(`walk: ${name}`, false, `did not see ${wait.join(" | ")}`);
      return p.close();
    }
    if (act) await btn(p, act);
  }
  const ok = await waitText(p, end);
  check(`walk: ${name}`, ok && p.errors.length === 0, ok ? p.errors.join(" | ") : `did not end at ${end.join(" | ")}: ${(await text(p)).slice(0, 200)}`);
  await p.close();
}
await newGroup("state=open", ["juniper", "otto", "marlow"], [], ["Robin, Juniper, Otto and Marlow", "Write to everyone, or start with @ to choose who answers."], "New group to an empty group");
await newGroup(
  "fail=marlow",
  ["juniper", "otto", "marlow"],
  [[["Made tasks for Juniper and Otto. Couldn't make one for Marlow.", 'The gateway answered: Unknown agent id "marlow".'], "Make it without Marlow"]],
  ["Robin, Juniper and Otto", "Write to everyone"],
  "a task refused, then made without it",
);
await newGroup("fail=marlow", ["juniper", "otto", "marlow"], [[["Couldn't make one for Marlow."], "Try Marlow again"]], ["Robin, Juniper, Otto and Marlow"], "a task refused, then tried again");
await newGroup("fail=marlow", ["juniper", "otto", "marlow"], [[["Couldn't make one for Marlow."], "Cancel"]], ["No group was made. Juniper's and Otto's new tasks stay in their lists."], "a task refused, then cancelled");
await newGroup("fail=record", ["juniper", "otto"], [[["Made tasks for Juniper and Otto, but couldn't save the group."], "Try again"]], ["Robin, Juniper and Otto", "Write to everyone"], "the record refused, then saved");
await newGroup("fail=readback", ["juniper", "otto"], [[["Couldn't confirm the group was saved."], "Check again"]], ["Robin, Juniper and Otto", "Write to everyone"], "the read-back missing, then confirmed");
await newGroup(
  "fail=full",
  ["juniper", "otto"],
  [[["The gateway keeps at most 128 preferences for you, and it has no room for another group. Remove a group to make one."], "Cancel"]],
  ["No group was made. Juniper's and Otto's new tasks stay in their lists."],
  "the preferences full",
);

{
  const p = await open("state=open");
  await type(p, "Bring water for everyone");
  await p.keyboard.press("Enter");
  const sending = await waitText(p, ["Sending to Juniper, Otto and Marlow…"], ".transcript-inner", 1500);
  const accepted = await waitText(p, ["Accepted by the gateway for Juniper, Otto and Marlow"], ".transcript-inner", 1500);
  const sent = await waitText(p, ["Sent to Juniper, Otto and Marlow"], ".transcript-inner");
  const streaming = await waitText(p, ["Noted. I'll check"], ".g-status", 2000);
  // Juniper finishes first; Otto's reply, which finishes last, is saved with an earlier time.
  const juniperFirst = await waitText(p, ["Noted. I'll check the forecast again on Friday evening."], ".transcript-inner > :not(.g-status)", 3000);
  const ottoNotYet = !(await text(p, ".transcript-inner > :not(.g-status)")).includes("Will do. I'll keep an eye");
  const all = await waitText(p, ["Will do. I'll keep an eye", "Got it. I'll add it to the note"], ".transcript-inner > :not(.g-status)", 5000);
  const [o, m, j] = await order(p, ["Will do. I'll keep an eye", "Got it. I'll add it", "Noted. I'll check the forecast"]);
  const lines = await p.locator(".g-status .status-line").count();
  check("walk: send to everyone: three copies, accepted, sent, streamed", sending && accepted && sent && streaming, `${sending} ${accepted} ${sent} ${streaming}`);
  check("walk: a reply moves to its saved place when it finishes", juniperFirst && ottoNotYet && all && o < m && m < j && lines === 0, `${juniperFirst} ${ottoNotYet} ${all} ${o} ${m} ${j} ${lines}`);
  await p.close();
}
{
  const p = await open("state=open", { width: 390, height: 700 });
  await type(p, "Bring water for everyone");
  await p.keyboard.press("Enter");
  await waitText(p, ["Accepted by the gateway"], ".transcript-inner", 1500);
  await p.evaluate(() => (document.getElementById("transcript").scrollTop = 0));
  await waitText(p, ["Will do. I'll keep an eye", "Got it. I'll add it"], ".transcript-inner > :not(.g-status)", 5000);
  const top = await p.evaluate(() => document.getElementById("transcript").scrollTop);
  check("walk: the reading position is kept through run events", top < 10, `scrollTop ${top}`);
  await p.close();
}
{
  const p = await open("state=open");
  await type(p, "@");
  const listed = (await p.locator(".g-mentions [role=menuitem]").count()) === 4;
  await item(p, "Otto");
  await p.keyboard.type("how full is the media box?");
  const name = await label(p, "[data-send]");
  await p.keyboard.press("Enter");
  const sent = await waitText(p, ["Sent to Otto"], ".transcript-inner");
  const reply = await waitText(p, ["Will do. I'll keep an eye"], ".transcript-inner", 4000);
  const t = await text(p, ".transcript-inner");
  check("walk: @Otto reaches Otto alone, with the text as typed", listed && name === "Send to Otto" && sent && reply && !t.includes("Noted. I'll check the forecast") && t.includes("@Otto how full is the media box?"), `${listed} ${name} ${sent} ${reply}`);
  await p.close();
}
{
  const p = await open("state=open");
  await type(p, "@");
  await p.keyboard.press("Escape");
  check("walk: Escape closes the mention list and keeps the @", (await p.locator(".g-mentions").count()) === 0 && (await p.inputValue("#g-input")) === "@");
  await p.close();
}
{
  const p = await open("state=samename&compose=ambiguous");
  await item(p, "Otto (Garage)");
  const to = await label(p, ".g-to");
  await p.keyboard.press("Enter");
  const sent = await waitText(p, ["Sent to Otto (Garage)"], ".transcript-inner");
  check("walk: an ambiguous name, chosen, then sent to that bot alone", to.startsWith("To Otto (Garage)") && sent, `${to} ${sent}`);
  await p.close();
}
{
  const p = await open("state=open");
  await p.hover('[data-said]:has-text("forecast")');
  await p.click('[aria-label="More for Juniper\'s message"]');
  await item(p, "Reply");
  const strip = await waitText(p, ["Replying to Juniper"], "#composer-slot");
  const to = (await label(p, ".g-to")).startsWith("To Juniper (replying)");
  await p.keyboard.type("Can we start at 7 instead? @Otto too");
  const still = (await label(p, "[data-send]")) === "Send to Juniper";
  await p.keyboard.press("Enter");
  const sent = await waitText(p, ["Sent to Juniper"], ".transcript-inner");
  check("walk: Reply goes to the bot that wrote it, whatever the text names", strip && to && still && sent, `${strip} ${to} ${still} ${sent}`);
  await p.close();
}
{
  const p = await open("state=open");
  await p.hover('[data-said]:has-text("trailer")');
  await p.click('[aria-label="More for Marlow\'s message"]');
  await item(p, "Quote");
  const v = await p.inputValue("#g-input");
  const everyone = (await label(p, "[data-send]")) === "Send to everyone";
  await p.keyboard.type("@Juniper is 8 still right?");
  const juniper = (await label(p, "[data-send]")) === "Send to Juniper";
  check("walk: Quote puts the message in the draft; its @Otto chooses no one", v.startsWith("> Marlow: I'll draft a short note") && v.includes("@Otto") && everyone && juniper, `${everyone} ${juniper}`);
  await p.close();
}
{
  const p = await open("state=open&fail=vanish");
  await type(p, "Who has the trailer key?");
  await p.keyboard.press("Enter");
  const refused = await waitText(p, ["Couldn't send to Marlow", "Marlow's task in this group was deleted. Messages to everyone skip Marlow."], ".transcript-inner");
  await p.locator("[data-went]").last().click();
  const why = await waitText(p, ["The gateway answered: active branch changed; review and retry"], ".transcript-inner", 1500);
  check("walk: a task deleted during the send is refused by the guard, not remade", refused && why, `${refused} ${why}`);
  await p.close();
}
{
  const p = await open("state=changed");
  await btn(p, "Use the new task");
  const ask = await waitText(p, ["Use Marlow's new task in Weekend plans?", "The new task holds only the copy the gateway just accepted."], "#g-dialog");
  await p.locator("#g-dialog [data-do-adopt]").click();
  const done = (await gone(p, '[data-member-line="marlow"]')) && (await waitText(p, ["Sent to Juniper, Otto and Marlow"], ".transcript-inner"));
  check("walk: a replacement task is adopted only when the person confirms", ask && done, `${ask} ${done}`);
  await p.close();
}
{
  const p = await open("state=running");
  await p.click("[data-stop]");
  const stopping = await waitText(p, ["Stopping…"], "#root", 1000);
  const stopped = await waitText(p, ["Stopped. Juniper's and Otto's runs stopped. Completed actions are not undone."], ".transcript-inner");
  check("walk: Stop names each run it stopped", stopping && stopped && (await p.locator(".g-status .status-line").count()) === 0 && (await p.locator("[data-stop]").count()) === 0);
  await p.close();
}
{
  const p = await open("state=twodevices");
  await p.click("[data-stop]");
  const said = await waitText(p, ["Stopped. Juniper's run stopped.", "Couldn't stop Otto's run from this device."]);
  const live = (await p.locator(".g-status .status-line").count()) === 1 && (await text(p, ".g-status")).includes("Reading backup-2026-11-15.log");
  const stop = await label(p, "[data-stop]");
  check("walk: Stop across two devices: one run stopped, the other refused and still live", said && live && stop === "Stop 1 bot", `${said} ${live} ${stop}`);
  await p.close();
}
{
  const p = await open("state=queuedturn");
  const before = (await p.locator(".g-status .status-line").count()) === 2 && (await text(p, ".g-status")).includes("Queued by the gateway");
  await p.click("[data-stop]");
  const stopped = await waitText(p, ["Stopped. Otto's run stopped."], ".transcript-inner");
  const next = await waitText(p, ["@Otto also check the trail camera.", "In Otto's task history"], ".transcript-inner", 2000);
  const result = await waitText(p, ["The trail camera has 40 new pictures"], ".transcript-inner", 4000);
  const lines = await p.locator(".g-status .status-line").count();
  check("walk: a turn the gateway queued finishes after Stop, with its own result", before && stopped && next && result && lines === 0, `${before} ${stopped} ${next} ${result} ${lines}`);
  await p.close();
}
{
  const p = await open("state=running&stopfail=otto");
  await p.click("[data-stop]");
  const partly = await waitText(p, ["Stopped. Juniper's run stopped.", "No answer about Otto's run. It may still be working."]);
  const back = (await label(p, "[data-stop]")) === "Stop 1 bot";
  await btn(p, "Try again");
  const stopped = await waitText(p, ["Stopped. Otto's run stopped."], ".transcript-inner");
  check("walk: no answer about a run, then Try again on the same run", partly && back && stopped, `${partly} ${back} ${stopped}`);
  await p.close();
}
{
  const p = await open("state=question");
  await type(p, "Also check the trail cam");
  await p.keyboard.press("Enter");
  const held = await waitText(p, ["Sent to Juniper and Marlow · Held until you answer Otto"], ".transcript-inner");
  await p.locator("#g-question .option").first().click();
  const released = await waitText(p, ["Sent to Juniper and Marlow · Steer for Otto"], ".transcript-inner");
  const reply = await waitText(p, ["I'll keep the cache for a week"], ".transcript-inner", 4000);
  check("walk: a copy held by Otto's question, released when it is answered", held && released && reply, `${held} ${released} ${reply}`);
  await p.close();
}
{
  const p = await open("state=question");
  await type(p, "@Otto never mind");
  await p.keyboard.press("Enter");
  const held = await waitText(p, ["Held until you answer Otto"], ".transcript-inner");
  await p.click("[data-stop]");
  const notSent = await waitText(p, ["Not sent to Otto", "Cancelled: you stopped the run", "Stopped. Otto's run stopped."], ".transcript-inner");
  check("walk: Stop leaves a held copy Not sent and cancels the question", held && notSent, `${held} ${notSent}`);
  await p.close();
}
{
  const p = await open("state=running");
  await p.click("[data-stop]");
  await type(p, "Pack the trailer");
  await p.keyboard.press("Enter");
  const queued = await waitText(p, ["Queued on this device for Juniper and Otto"], ".transcript-inner", 1500);
  const after = await waitText(p, ["Not sent to Juniper and Otto", "Stopped. Juniper's and Otto's runs stopped."], ".transcript-inner");
  const marlow = await waitText(p, ["Sent to Marlow"], ".transcript-inner");
  check("walk: a message while stopping is queued for the stopping members, then Not sent", queued && after && marlow, `${queued} ${after} ${marlow}`);
  await p.close();
}
for (const [decision, end] of [
  ["Allow once", ["Allowed once", "It's steady at 71%."]],
  ["Deny", ["Denied", "Understood. I won't list the files"]],
]) {
  const p = await open("state=approval");
  await btn(p, decision);
  const ok = await waitText(p, end, ".transcript-inner");
  const shelf = (await text(p, "#composer-slot")).includes("Otto needs your approval");
  check(`walk: approval, ${decision}`, ok && !shelf, `${ok} shelf ${shelf}`);
  await p.close();
}
{
  const p = await open("state=approval");
  await btn(p, "Always allow…");
  const form = await waitText(p, ["so Otto is not asked again for commands it matches"], ".request");
  await btn(p, "Allow and save");
  const ok = await waitText(p, ["Always allowed", "Added to media-box's allowlist."], ".transcript-inner");
  check("walk: approval, Always allow saves for the asking bot", form && ok, `${form} ${ok}`);
  await p.close();
}
{
  const p = await open("state=partial");
  const noResend = (await p.getByRole("button", { name: "Resend to Marlow", exact: true }).count()) === 0;
  await btn(p, "Restore Marlow's task");
  const restored = await waitText(p, ["Resend to Marlow"], ".transcript-inner");
  await btn(p, "Resend to Marlow");
  const sent = await waitText(p, ["Sent to Juniper, Otto and Marlow"], ".transcript-inner");
  const reply = await waitText(p, ["A tide table and the trailer key."], ".transcript-inner", 4000);
  check("walk: a refused copy, its task restored, then resent", noResend && restored && sent && reply, `${noResend} ${restored} ${sent} ${reply}`);
  await p.close();
}
{
  const p = await open("state=archived");
  await btn(p, "Restore Marlow's task");
  const busy = await waitText(p, ["Restoring Marlow's task…"], ".transcript-inner", 1000);
  const restored = busy && (await gone(p, '[data-member-line="marlow"]'));
  check("walk: restore an archived member task", restored && (await p.locator(".g-chip[data-skipped]").count()) === 0);
  await p.close();
}
{
  const p = await open("state=taskgone");
  await btn(p, "Start a new task for Marlow");
  const busy = await waitText(p, ["Starting a new task for Marlow…"], ".transcript-inner", 1000);
  check("walk: start a new task for a member whose task was deleted", busy && (await gone(p, '[data-member-line="marlow"]')));
  await p.close();
}
{
  const p = await open("state=botgone");
  await btn(p, "Remove Marlow");
  await has("walk: removing a deleted bot asks first", p, ["Remove Marlow from Weekend plans?", "Marlow was deleted, with its tasks."], "#g-dialog");
  await btn(p, "Remove");
  check("walk: a deleted bot removed from the group", await members(p, 2));
  await p.close();
}
{
  const p = await open("state=archived");
  await p.click("#title-pill");
  await btn(p, "Remove Juniper");
  await btn(p, "Remove");
  await members(p, 2);
  const line = await text(p, '[data-member-line="marlow"]');
  check("walk: at two members a member's line offers a replacement or removing the group", line.includes("Add a bot") && line.includes("Remove group…") && !line.includes("Remove Marlow"), line);
  await p.click("#title-pill");
  await p.waitForTimeout(250);
  await has("walk: at two members Group details says why there is no Remove", p, ["A group has at least two bots. To change one, add another bot first, or remove the group."], "#g-dialog");
  check("walk: at two members details have no Remove", (await p.locator("#g-dialog [data-remove-member]").count()) === 0);
  await p.close();
}
{
  const p = await open("state=running");
  await p.click("#title-pill");
  await btn(p, "Remove Otto");
  await btn(p, "Remove");
  await waitText(p, ["Juniper is working"], "#bot-list");
  const stop = await label(p, "[data-stop]");
  check("walk: a removed member leaves the group's Stop and summaries", stop === "Stop 1 bot" && (await p.locator(".g-status .status-line").count()) === 1, stop);
  await p.close();
}
{
  const p = await open("state=open&fail=memberconflict");
  await p.click("#title-pill");
  await btn(p, "Remove Marlow");
  await btn(p, "Remove");
  const conflict = await waitText(p, ["This group changed on another device. It now has Juniper, Otto, Marlow and Pip."], "#g-dialog");
  await btn(p, "Remove anyway");
  const removed = await members(p, 3);
  check("walk: removing a member meets a change from another device, shown from the read-back", conflict && removed, `${conflict} ${removed}`);
  await p.close();
}
{
  const p = await open("state=open&fail=unconfirmed");
  await p.click("#title-pill");
  await btn(p, "Remove Marlow");
  await btn(p, "Remove");
  const unconfirmed = await waitText(p, ["Couldn't confirm the change."], "#g-dialog");
  await btn(p, "Check again");
  const removed = await members(p, 2);
  check("walk: a change that couldn't be confirmed, then read back", unconfirmed && removed, `${unconfirmed} ${removed}`);
  await p.close();
}
{
  const p = await open("state=offline");
  await p.click("#title-pill");
  await btn(p, "Remove Marlow");
  await btn(p, "Remove");
  await members(p, 2);
  await p.evaluate(() => document.getElementById("g-reconnect").click());
  const ok = await waitText(p, ["Sent to Juniper and Otto · Not sent to Marlow"], ".transcript-inner");
  await p.locator("[data-went]").last().click();
  const why = await waitText(p, ["Marlow is no longer in this group."], ".transcript-inner", 1500);
  check("walk: a held copy is checked against the members before it goes", ok && why, `${ok} ${why}`);
  await p.close();
}
{
  const p = await open("state=open");
  await p.click("#title-pill");
  await btn(p, "Rename");
  await p.fill("#g-name", "");
  const empty = await p.locator("[data-save-name]").isDisabled();
  await p.fill("#g-name", "Saturday trail");
  await btn(p, "Save");
  const saving = await waitText(p, ["Saving…"], "#g-dialog", 800);
  const saved = await waitText(p, ["Saturday trail"], "#title-pill");
  const row = (await text(p, '.bot[data-group="g1"]')).includes("Saturday trail");
  check("walk: rename, read back in the pill and the row; an empty name cannot be saved", empty && saving && saved && row, `${empty} ${saving} ${saved} ${row}`);
  await p.close();
}
{
  const p = await open("state=open&conflict=1");
  await p.click("#title-pill");
  await btn(p, "Rename");
  await p.fill("#g-name", "Saturday trail");
  await btn(p, "Save");
  const conflict = await waitText(p, ["This group changed on another device. It's now called Saturday."], "#g-dialog");
  const pill = (await text(p, "#title-pill")).includes("Saturday");
  await btn(p, "Save again");
  const saved = await waitText(p, ["Saturday trail"], "#title-pill");
  check("walk: rename meets a change from another device, then saves", conflict && pill && saved, `${conflict} ${pill} ${saved}`);
  await p.close();
}
{
  const p = await open("state=open&conflict=refused");
  await p.click("#title-pill");
  await btn(p, "Rename");
  await p.fill("#g-name", "Saturday trail");
  await btn(p, "Save");
  const refused = await waitText(p, ["Couldn't save the name.", "It is still called Weekend plans."], "#g-dialog");
  check("walk: a refused rename says the name read back", refused && (await text(p, "#title-pill")).includes("Weekend plans"));
  await p.close();
}
{
  const p = await open("state=open");
  await p.click("#title-pill");
  await btn(p, "Add a bot");
  await p.click('[data-add-pick="pip"]');
  await btn(p, "Add");
  const making = await waitText(p, ["Making Pip's task…"], "#g-dialog", 800);
  const added = await waitText(p, ["Pip"], "#g-dialog .g-members");
  check("walk: add a bot", making && added && (await p.locator('.bot[data-group="g1"] .g-stack[data-count="4"]').count()) === 1);
  await p.close();
}
{
  const p = await open("state=open&fail=add");
  await p.click("#title-pill");
  await btn(p, "Add a bot");
  await p.click('[data-add-pick="pip"]');
  await btn(p, "Add");
  const made = await waitText(p, ["Pip's task was made. This group still has Juniper, Otto and Marlow."], "#g-dialog");
  await btn(p, "Try again");
  const added = await waitText(p, ["Pip"], "#g-dialog .g-members");
  check("walk: a task made but not added, then added with that task", made && added, `${made} ${added}`);
  await p.close();
}
{
  const p = await open("state=open");
  await p.click("#title-pill");
  await btn(p, "Remove Marlow");
  await has("walk: removing a member says what stays", p, ["Marlow's task and its history stay in Marlow's list."], "#g-dialog");
  await btn(p, "Remove");
  const gone2 = await members(p, 2);
  const replies = (await text(p, ".transcript-inner")).includes("borrowing the trailer");
  check("walk: remove a member; its messages leave the column", gone2 && !replies);
  await p.close();
}
{
  const p = await open("state=open");
  await p.click("#title-pill");
  await btn(p, "Remove group…");
  await btn(p, "Remove group");
  const ok = await waitText(p, ["Removed Weekend plans. Juniper's, Otto's and Marlow's tasks stay in their lists."]);
  check("walk: remove the group; the tasks stay", ok && (await p.locator('.bot[data-group="g1"]').count()) === 0 && (await p.locator('.bot[data-group="g2"]').count()) === 1);
  await p.close();
}
{
  const p = await open("state=open&fail=remove");
  await p.click("#title-pill");
  await btn(p, "Remove group…");
  await btn(p, "Remove group");
  const unconfirmed = await waitText(p, ["Couldn't confirm the change."], "#g-dialog");
  await btn(p, "Check again");
  const kept = await waitText(p, ["Weekend plans is still saved, with Juniper, Otto and Marlow."], "#g-dialog");
  await btn(p, "Remove group");
  const ok = await waitText(p, ["Removed Weekend plans."]);
  check("walk: removing the group unconfirmed, read back, then removed", unconfirmed && kept && ok, `${unconfirmed} ${kept} ${ok}`);
  await p.close();
}
{
  const p = await open("state=open&fail=gone");
  await p.click("#title-pill");
  await btn(p, "Remove group…");
  await btn(p, "Remove group");
  check("walk: a group another device already removed", await waitText(p, ["Weekend plans was already removed on another device. Juniper's, Otto's and Marlow's tasks stay in their lists."]));
  await p.close();
}
{
  const p = await open("state=open");
  await p.click('.bot[data-group="g1"]', { button: "right" });
  const items = await p.locator("#rail-menu [role=menuitem]").allTextContents();
  await item(p, "Rename…");
  await p.waitForTimeout(250);
  const field = await p.locator("#g-name").count();
  check("walk: the row's menu renames", items.join("|") === "Rename…|Group details|Remove group…" && field === 1, items.join("|"));
  await p.close();
}
{
  const p = await open("state=open");
  await p.keyboard.press("Meta+Shift+N");
  check("walk: ⌘⇧N opens New group", await waitText(p, ["New group"], "#g-dialog", 1000));
  await p.close();
}
{
  const p = await open("state=open", { width: 390, height: 844 });
  await p.click("#title-pill");
  await p.waitForTimeout(250);
  const edit = await p.getByRole("button", { name: "Edit", exact: true }).count();
  await btn(p, "Edit");
  const done = await p.getByRole("button", { name: "Done", exact: true }).count();
  check("phone: Edit, Name, Done", edit === 1 && done === 1);
  await p.close();
}
{
  const p = await open("state=open&view=list", { width: 390, height: 844 });
  const rowVisible = await p.locator('.bot[data-group="g1"]').isVisible();
  await p.click('.bot[data-group="g1"]');
  const opened = await p.locator("#g-input").isVisible();
  check("phone: the group is a row of the list and opens full screen", rowVisible && opened);
  await p.close();
}
for (const theme of ["light", "dark"]) {
  const p = await open("state=both", { theme });
  check(`${theme}: no page errors`, p.errors.length === 0, p.errors.join(" | "));
  await p.close();
}

await b.close();
console.log(out.join("\n"));
console.log(failed ? `${failed} failed` : `all ${out.length} passed`);
process.exit(failed ? 1 : 0);
