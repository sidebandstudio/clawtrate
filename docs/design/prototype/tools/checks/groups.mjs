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
const item = (p, name) => p.getByRole("menuitem", { name: new RegExp(`^${name}`) }).first().click();
const type = async (p, value) => {
  await p.click("#g-input");
  await p.keyboard.type(value);
};

process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

// Part 1: each state's words --------------------------------------------------------------
{
  const p = await open("state=open");
  await has("open: the group row, the first line, your message once, speakers", p, [
    "Weekend plans",
    "Otto: Done. The old cache folder is gone",
    "Each bot sees only what you send it. Juniper, Otto and Marlow don't see each other's replies.",
    "Sent to Juniper, Otto and Marlow",
    "Marlow",
    "To",
    "Everyone",
  ]);
  const row = await p.getAttribute(".bot[data-group]", "aria-label");
  check("open: the row's name lists the members", row.startsWith("Weekend plans, group of 3: Juniper, Otto and Marlow"), row);
  check("open: your message is one bubble", (await p.locator('.msg[data-role="user"]').count()) === 1);
  check("open: the combined avatar has three characters", (await p.locator('.bot[data-group] .g-stack[data-count="3"] .avatar').count()) === 3);
  check("open: Send is named for everyone", (await p.getAttribute("[data-send]", "aria-label")) === "Send to everyone");
  check("open: no Work pane for a group", (await p.locator("#work-panel").count()) === 0);
  await p.close();
}
{
  const p = await open("state=empty");
  await has("empty: the two sentences", p, ["Each bot sees only what you send it.", "Write to everyone, or start with @ to choose who answers."]);
  await p.close();
}
{
  const p = await open("state=running");
  await has("running: two status lines and the row", p, ["Searching the web for trail closures", "Reading backup-2026-11-15.log", "Juniper and Otto are working"]);
  check("running: Stop names the count", (await p.getAttribute("[data-stop]", "aria-label")) === "Stop 2 bots");
  check("running: one status line per working member", (await p.locator(".g-status .status-line").count()) === 2);
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
  await has("approval: the card names the bot and its task; shelf and row", p, [
    "Otto wants to run a command",
    "In Otto's task in this group.",
    "Otto needs your approval to run a command",
    "Waiting for you: Otto, approve a command",
    "Allow once",
    "Always allow…",
    "Deny",
  ]);
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
  await has("other device: a note and the status line, no card", p, ["Otto is waiting for an approval. It went to the device that sent this message; answer it there.", "Waiting for an answer"]);
  check("other device: no approval card", (await p.locator(".request").count()) === 0);
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
  await has("read-only: details have no Rename, Add or Remove", p, ["Group details", "Kept with your preferences on the gateway. Your other devices show this group."], "#g-dialog");
  check("read-only: details have no changes", (await p.locator("#g-dialog [data-rename], #g-dialog [data-add], #g-dialog [data-remove-group], #g-dialog [data-remove-member]").count()) === 0);
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
]) {
  const p = await open(`state=${s}`);
  await has(`${s}: the line and its action`, p, [line, action]);
  const chip = await p.getAttribute(".g-chip[data-skipped]", "aria-label");
  check(`${s}: the To line strikes Marlow`, !!chip && chip.startsWith("Marlow, skipped"), String(chip));
  await p.close();
}
{
  const p = await open("state=removed");
  await has("removed: what stays", p, ["Removed Weekend plans. Its three tasks are in Juniper's, Otto's and Marlow's lists."]);
  await p.close();
}
{
  const p = await open("bot=otto");
  await has("a member task under its bot", p, ["This task is part of Weekend plans. Only your messages to Otto are here.", "Open the group"]);
  const name = await p.getAttribute("[data-member-task]", "aria-label");
  check("a member task's name says its group", name.endsWith("in the group Weekend plans"), name);
  check("a member task shows Otto's side only", (await p.locator(".msg").count()) === 2);
  await btn(p, "Open the group");
  check("Open the group returns to the column", await waitText(p, ["Each bot sees only what you send it."]));
  await p.close();
}
for (const [q, words] of [
  ["open=new&fail=noprefs", ["This connection can't keep preferences on the gateway, so it can't keep a group.", "Close"]],
  ["open=new", ["New group", "Choose 2 to 6 bots.", "Clawtrate makes a new task with each bot and keeps the group with your preferences on the gateway, so your other devices show it."]],
  ["open=new&pick=juniper,otto", ["Name: Robin, Juniper and Otto. You can rename it later."]],
  ["open=new&pick=juniper,otto,marlow,pip,extra1,extra2", ["A group has at most 6 bots."]],
  ["open=details", ["Group details", "Rename", "Members", "Open Otto's task", "Each member has its own task with you. Opening it shows what that bot has seen.", "Add a bot", "Remove group…"]],
  ["confirm=member", ["Remove Marlow from Weekend plans?", "Marlow's task stays in Marlow's list, with everything in it. Marlow won't get messages sent to this group. Anything Marlow is doing now keeps going."]],
  ["confirm=group", ["Remove Weekend plans?", "Juniper's, Otto's and Marlow's tasks stay in their lists, with everything in them. Only the group goes, on all your devices. Nothing running is stopped."]],
]) {
  const p = await open(q);
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
for (const [q, words] of [
  ["compose=mention", ["Everyone", "Juniper", "Otto", "Marlow"]],
  ["compose=otto", ["To", "Otto"]],
  ["compose=reply", ["Replying to Juniper", "(replying)"]],
  ["compose=quote", ["To", "Marlow"]],
]) {
  const p = await open(q);
  await has(`composer ${q}`, p, words, "#composer-slot");
  if (q === "compose=mention") check("composer: the mention list is a menu", (await p.locator(".g-mentions[role=menu] [role=menuitem]").count()) === 4);
  if (q === "compose=otto") check("composer: Send names Otto", (await p.getAttribute("[data-send]", "aria-label")) === "Send to Otto");
  if (q === "compose=reply") check("composer: Send names Juniper", (await p.getAttribute("[data-send]", "aria-label")) === "Send to Juniper");
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
  ["Robin, Juniper and Otto", "Juniper and Otto don't see each other's replies."],
  "a task refused, then made without it",
);
await newGroup("fail=marlow", ["juniper", "otto", "marlow"], [[["Couldn't make one for Marlow."], "Try Marlow again"]], ["Robin, Juniper, Otto and Marlow"], "a task refused, then tried again");
await newGroup(
  "fail=marlow",
  ["juniper", "otto", "marlow"],
  [[["Couldn't make one for Marlow."], "Cancel"]],
  ["No group was made. Juniper's and Otto's new tasks stay in their lists, empty."],
  "a task refused, then cancelled",
);
await newGroup(
  "fail=record",
  ["juniper", "otto"],
  [[["Made tasks for Juniper and Otto, but couldn't save the group."], "Try again"]],
  ["Robin, Juniper and Otto", "Write to everyone"],
  "the record refused, then saved",
);
await newGroup("fail=readback", ["juniper", "otto"], [[["Couldn't confirm the group was saved."], "Check again"]], ["Robin, Juniper and Otto", "Write to everyone"], "the read-back missing, then confirmed");
await newGroup(
  "fail=full",
  ["juniper", "otto"],
  [[["The gateway keeps at most 128 preferences for you, and it has no room for another group. Remove a group to make one."], "Cancel"]],
  ["No group was made. Juniper's and Otto's new tasks stay in their lists, empty."],
  "the preferences full",
);

{
  const p = await open("state=open");
  await type(p, "Bring water for everyone");
  await p.keyboard.press("Enter");
  const sending = await waitText(p, ["Sending to Juniper, Otto and Marlow…"], ".transcript-inner", 1500);
  const sent = await waitText(p, ["Sent to Juniper, Otto and Marlow"], ".transcript-inner");
  const replies = await waitText(p, ["Noted. I'll check the forecast", "Will do. I'll keep an eye", "Got it. I'll add it to the note"], ".transcript-inner", 6000);
  const lines = await p.locator(".g-status .status-line").count();
  check("walk: send to everyone, three copies, three replies", sending && sent && replies && lines === 0, `sending ${sending} sent ${sent} replies ${replies} lines ${lines}`);
  await p.close();
}
{
  const p = await open("state=open");
  await type(p, "@");
  const listed = (await p.locator(".g-mentions [role=menuitem]").count()) === 4;
  await item(p, "Otto");
  await p.keyboard.type("how full is the media box?");
  const label = await p.getAttribute("[data-send]", "aria-label");
  await p.keyboard.press("Enter");
  const sent = await waitText(p, ["Sent to Otto"], ".transcript-inner");
  const reply = await waitText(p, ["Will do. I'll keep an eye"], ".transcript-inner", 4000);
  const others = (await text(p, ".transcript-inner")).includes("Noted. I'll check the forecast");
  const stored = (await text(p, ".transcript-inner")).includes("@Otto how full is the media box?");
  check("walk: @Otto reaches Otto alone, with the text as typed", listed && label === "Send to Otto" && sent && reply && !others && stored, `${listed} ${label} ${sent} ${reply} ${others} ${stored}`);
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
  const p = await open("state=open");
  await p.hover('[data-said]:has-text("forecast")');
  await p.click('[aria-label="More for Juniper\'s message"]');
  await item(p, "Reply");
  const strip = await waitText(p, ["Replying to Juniper"], "#composer-slot");
  const to = (await p.getAttribute(".g-to", "aria-label")) === "To Juniper (replying)";
  await p.keyboard.type("Can we start at 7 instead?");
  await p.keyboard.press("Enter");
  const sent = await waitText(p, ["Sent to Juniper"], ".transcript-inner");
  check("walk: Reply goes to the bot that wrote it", strip && to && sent, `${strip} ${to} ${sent}`);
  await p.close();
}
{
  const p = await open("state=open");
  await p.hover('[data-said]:has-text("cache")');
  await p.click('[aria-label="More for Otto\'s message"]');
  await item(p, "Quote");
  const v = await p.inputValue("#g-input");
  check("walk: Quote puts the message in the draft, visible before sending", v.startsWith("> Otto: Done. The old cache folder is gone"), v);
  await p.close();
}
{
  const p = await open("state=running");
  await p.click("[data-stop]");
  const stopping = await waitText(p, ["Stopping…"], "#root", 1000);
  const stopped = await waitText(p, ["Stopped. Juniper and Otto stopped. Completed actions are not undone."], ".transcript-inner");
  check("walk: Stop stops every member's run", stopping && stopped && (await p.locator(".g-status .status-line").count()) === 0 && (await p.locator("[data-stop]").count()) === 0);
  await p.close();
}
{
  const p = await open("state=running&stopfail=otto");
  await p.click("[data-stop]");
  const partly = await waitText(p, ["Stopped. Juniper stopped.", "Couldn't stop Otto. The gateway didn't answer in time."]);
  const back = (await p.getAttribute("[data-stop]", "aria-label")) === "Stop 1 bot";
  await btn(p, "Try again");
  const stopped = await waitText(p, ["Stopped. Otto stopped."], ".transcript-inner");
  check("walk: a failed stop, then Try again", partly && back && stopped, `${partly} ${back} ${stopped}`);
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
  const notSent = await waitText(p, ["Not sent to Otto", "Cancelled: you stopped the run", "Stopped. Otto stopped."], ".transcript-inner");
  check("walk: Stop leaves a held copy Not sent and cancels the question", held && notSent, `${held} ${notSent}`);
  await p.close();
}
{
  const p = await open("state=running");
  await p.click("[data-stop]");
  await type(p, "Pack the trailer");
  await p.keyboard.press("Enter");
  const queued = await waitText(p, ["Queued for Juniper and Otto"], ".transcript-inner", 1500);
  const after = await waitText(p, ["Not sent to Juniper and Otto", "Stopped. Juniper and Otto stopped."], ".transcript-inner");
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
  const restored = busy && (await p.locator('[data-member-line="marlow"]').waitFor({ state: "detached", timeout: 3000 }).then(() => true, () => false));
  const chip = await p.locator(".g-chip[data-skipped]").count();
  check("walk: restore an archived member task", restored && chip === 0, `${restored} ${chip}`);
  await p.close();
}
{
  const p = await open("state=taskgone");
  await btn(p, "Start a new task for Marlow");
  const busy = await waitText(p, ["Starting a new task for Marlow…"], ".transcript-inner", 1000);
  const ok = busy && (await p.locator('[data-member-line="marlow"]').waitFor({ state: "detached", timeout: 3000 }).then(() => true, () => false));
  check("walk: start a new task for a member whose task was deleted", ok);
  await p.close();
}
{
  const p = await open("state=botgone");
  await btn(p, "Remove Marlow");
  await has("walk: removing a deleted bot asks first", p, ["Remove Marlow from Weekend plans?"], "#g-dialog");
  await btn(p, "Remove");
  const ok = await waitText(p, ["Juniper and Otto don't see each other's replies."]);
  check("walk: a deleted bot removed from the group", ok && (await p.locator('.bot[data-group] .g-stack[data-count="2"]').count()) === 1);
  await p.close();
}
{
  const p = await open("state=open");
  await p.click("#title-pill");
  await btn(p, "Rename");
  await p.fill("#g-name", "");
  const empty = await waitText(p, ["A group needs a name."], "#g-dialog", 800).catch(() => false);
  await p.fill("#g-name", "Saturday trail");
  await btn(p, "Save");
  const saving = await waitText(p, ["Saving…"], "#g-dialog", 800);
  const saved = await waitText(p, ["Saturday trail"], "#title-pill");
  const row = (await text(p, ".bot[data-group]")).includes("Saturday trail");
  check("walk: rename, read back in the pill and the row", saving && saved && row, `${empty} ${saving} ${saved} ${row}`);
  await p.close();
}
{
  const p = await open("state=open");
  await p.click("#title-pill");
  await btn(p, "Rename");
  await p.fill("#g-name", "");
  check("walk: an empty name cannot be saved", await p.locator("[data-save-name]").isDisabled());
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
  const refused = await waitText(p, ["Couldn't save the name."], "#g-dialog");
  const kept = (await text(p, "#title-pill")).includes("Weekend plans");
  check("walk: a refused rename keeps the old name", refused && kept);
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
  check("walk: add a bot", making && added && (await p.locator('.bot[data-group] .g-stack[data-count="4"]').count()) === 1);
  await p.close();
}
{
  const p = await open("state=open");
  await p.click("#title-pill");
  await btn(p, "Remove Marlow");
  await btn(p, "Remove");
  const gone = await waitText(p, ["Juniper and Otto don't see each other's replies."]);
  const replies = (await text(p, ".transcript-inner")).includes("borrowing the trailer");
  check("walk: remove a member; its messages leave the column", gone && !replies);
  await p.close();
}
{
  const p = await open("state=open");
  await p.click("#title-pill");
  await btn(p, "Remove group…");
  await btn(p, "Remove group");
  const ok = await waitText(p, ["Removed Weekend plans. Its three tasks are in Juniper's, Otto's and Marlow's lists."]);
  check("walk: remove the group; the tasks stay", ok && (await p.locator(".bot[data-group]").count()) === 0);
  await p.close();
}
{
  const p = await open("state=open&fail=remove");
  await p.click("#title-pill");
  await btn(p, "Remove group…");
  await btn(p, "Remove group");
  const refused = await waitText(p, ["Couldn't remove the group."], "#g-dialog");
  await btn(p, "Try again");
  const ok = await waitText(p, ["Removed Weekend plans."]);
  check("walk: removing fails, then Try again", refused && ok);
  await p.close();
}
{
  const p = await open("state=open");
  await p.click(".bot[data-group]", { button: "right" });
  const items = await p.locator("#rail-menu [role=menuitem]").allTextContents();
  await item(p, "Rename…");
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
  const edit = await p.getByRole("button", { name: "Edit", exact: true }).count();
  await btn(p, "Edit");
  const done = await p.getByRole("button", { name: "Done", exact: true }).count();
  check("phone: Edit, Name, Done", edit === 1 && done === 1);
  await p.close();
}
{
  const p = await open("state=open&view=list", { width: 390, height: 844 });
  const rowVisible = await p.locator(".bot[data-group]").isVisible();
  await p.click(".bot[data-group]");
  const opened = await p.locator("#g-input").isVisible();
  check("phone: the group is a row of the list and opens full screen", rowVisible && opened);
  await p.close();
}
for (const theme of ["light", "dark"]) {
  const p = await open("state=approval", { theme });
  check(`${theme}: no page errors`, p.errors.length === 0, p.errors.join(" | "));
  await p.close();
}

await b.close();
console.log(out.join("\n"));
console.log(failed ? `${failed} failed` : `all ${out.length} passed`);
process.exit(failed ? 1 : 0);
