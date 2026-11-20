// Checks for groups.html: every walk of docs/design/group-chats.md clicked through to its
// outcome at 1440 and at 390 px, every state's words and structure, and what the page sends:
// the prototype's own journal of record writes and reads, guarded sends and aborts.
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
const WIDTHS = [1440, 390];
const open = async (query = "", { width = 1440, theme = "light" } = {}) => {
  const phone = width < 500;
  const p = await b.newPage({ viewport: { width, height: phone ? 844 : 900 }, hasTouch: phone });
  const errors = [];
  p.requests = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  // Nothing in a group fetches or opens an address: count every network request.
  await p.route(/^https?:/, (route) => {
    p.requests.push(route.request().url());
    route.abort();
  });
  await p.goto(`${base}&theme=${theme}${phone ? "&width=phone" : ""}&${query}`);
  await p.waitForTimeout(150);
  // Every announcement, in order: the live region keeps only the latest.
  await p.evaluate(() => {
    window.__said = [];
    const say = CT.announce;
    CT.announce = (t) => {
      window.__said.push(t);
      say(t);
    };
  });
  p.errors = errors;
  p.phone = phone;
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
const members = (p, n, timeout = 4000) => p.locator(`.bot[data-group="g1"] .g-stack[data-count="${n}"]`).waitFor({ state: "attached", timeout }).then(() => true, () => false);
const order = (p, words) => p.evaluate((w) => { const t = document.querySelector(".transcript-inner").textContent; return w.map((x) => t.indexOf(x)); }, words);
const said = (p, words, timeout = 1500) => p.waitForFunction((w) => window.__said.includes(w), words, { timeout }).then(() => true, () => false);
const journal = (p) => p.evaluate(() => JSON.parse(JSON.stringify(window.__groupJournal)));
const type = async (p, value) => {
  await p.click("#g-input");
  await p.keyboard.type(value);
};
// The phone shows one pane: Back leads to the list before a row is clicked.
const railClick = async (p, sel) => {
  if (p.phone && (await p.locator(".shell").getAttribute("data-view")) === "detail") await p.click('[data-action="back"]');
  await p.click(sel);
};
const renameWord = (p) => (p.phone ? "Edit" : "Rename");
const saveWord = (p) => (p.phone ? "Done" : "Save");
// A real long press: pointer down, held, up.
const longPress = async (p, sel) => {
  const box = await p.locator(sel).first().boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down();
  await p.waitForTimeout(650);
  await p.mouse.up();
};
const groupMenu = async (p, sel) => (p.phone ? longPress(p, sel) : p.click(sel, { button: "right" }));

process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

for (const W of WIDTHS) {
  const at = ` (${W})`;
  const o = (q, x = {}) => open(q, { width: W, ...x });

  // Part 1: each state's words, controls and names ------------------------------------------
  {
    const p = await o("state=open");
    await has("open: rail row, the history label, the first line, receipts from histories, the cost" + at, p, [
      "Weekend plans",
      "Otto: Done. The old cache folder is gone",
      "Showing recent history for Juniper, Otto and Marlow",
      "Clawtrate sends each bot a separate copy. It doesn't pass bot replies between tasks.",
      "In Juniper's, Otto's and Marlow's task histories",
      "Read backup-2026-11-15.log",
      "3 bots · Each bot that answers uses its own tokens",
    ]);
    const row = await label(p, '.bot[data-group="g1"]');
    check("open: the row's spoken name lists the members" + at, row.startsWith("Weekend plans, group of 3: Juniper, Otto and Marlow"), row);
    check("open: your message is one bubble" + at, (await p.locator('.msg[data-role="user"]').count()) === 1);
    const bubble = await label(p, '.msg[data-role="user"]');
    check("open: the receipt is part of the bubble's name" + at, bubble === "You said: Plan Saturday for us: the trail in the morning, errands after lunch. In Juniper's, Otto's and Marlow's task histories.", bubble);
    check("open: no Attach control in the group composer" + at, (await p.getByRole("button", { name: "Attach files" }).count()) === 0);
    check("open: Send is named for everyone" + at, (await label(p, "[data-send]")) === "Send to everyone");
    check("open: no Work pane for a group" + at, (await p.locator("#work-panel").count()) === 0);
    check("open: a gateway address is plain text: no link, no request, nothing opened" + at, (await p.locator(".transcript-inner a[href]").count()) === 0 && p.requests.length === 0 && (await text(p, ".transcript-inner")).includes("https://maps.example/trail"), p.requests.join(" "));
    const rail = await p.locator("#bot-list .bot-name").allTextContents();
    check("open: bots and groups in one list by recent activity" + at, rail.join("|") === "Weekend plans|Juniper|Dinner plans|Otto|Marlow|Pip", rail.join("|"));
    await p.close();
    const q = await o("state=open&dinner=recent");
    const rail2 = await q.locator("#bot-list .bot-name").allTextContents();
    check("rail: a more recent group moves up" + at, rail2.join("|") === "Dinner plans|Weekend plans|Juniper|Otto|Marlow|Pip", rail2.join("|"));
    await railClick(q, '.bot[data-group="g2"]');
    const dinner = await waitText(q, ["Pasta with the spinach and the last of the feta."], ".transcript-inner");
    await railClick(q, '.bot[data-group="g1"]');
    const back = await waitText(q, ["Plan Saturday for us"], ".transcript-inner");
    check("rail: each group opens its own column" + at, dinner && back);
    await q.close();
  }
  {
    const p = await o("state=empty");
    await has("empty: the two sentences" + at, p, ["Clawtrate sends each bot a separate copy. It doesn't pass bot replies between tasks.", "Write to everyone, or start with @ to choose who answers."]);
    await p.close();
  }
  {
    const p = await o("state=running");
    await has("running: two status lines and the row" + at, p, ["Searching the web for trail closures", "Reading backup-2026-11-15.log", "Juniper and Otto are working"]);
    check("running: Stop names the count" + at, (await label(p, "[data-stop]")) === "Stop 2 bots");
    check("running: one status line per active run" + at, (await p.locator(".g-status .status-line").count()) === 2);
    const clip = await p.evaluate(() => {
      const t = document.getElementById("transcript");
      t.scrollTop = t.scrollHeight;
      const s = [...document.querySelectorAll(".g-status .status-line")].pop().getBoundingClientRect();
      return { line: s.bottom, composer: document.querySelector(".composer").getBoundingClientRect().top };
    });
    check("running: the last status line sits above the composer, not clipped" + at, clip.line <= clip.composer + 1, JSON.stringify(clip));
    await p.close();
  }
  {
    const p = await o("state=partial");
    await has("partial: the receipt, opened" + at, p, [
      "Sent to Juniper and Otto · Couldn't send to Marlow",
      "The gateway answered: Session … is archived. Restore it before starting new work.",
      "Marlow's task in this group is archived. Messages to everyone skip Marlow.",
      "Restore Marlow's task",
    ]);
    await p.close();
  }
  {
    const p = await o("state=approval");
    await has("approval: the card names the bot, its task and run; shelf and row" + at, p, ["Otto wants to run a command", "In Otto's task in this group, run a36bfcc7.", "Otto needs your approval to run a command", "Waiting for you: Otto, approve a command", "Allow once", "Always allow…", "Deny"]);
    await p.close();
  }
  {
    const p = await o("state=both");
    await has("both: an approval and a question" + at, p, ["Otto wants to run a command", "Which route should I plan for Saturday?", "In Juniper's task in this group, run f9adc2f3.", "Otto needs your approval to run a command", "Juniper asked you a question.", "Waiting for you: Otto and Juniper"]);
    check("both: each card keyed by its own request" + at, (await p.locator("#g-approval-5e1d0c2a").count()) === 1 && (await p.locator("#g-question-ask_route").count()) === 1);
    await p.close();
  }
  {
    const p = await o("state=question");
    await has("question: the card, the shelf and the row" + at, p, ["How long should I keep the cache in /srv/scratch before deleting it?", "Otto asked you a question. A message to Otto now is held until you answer.", "Waiting for you: Otto, a question"]);
    await p.close();
  }
  {
    const p = await o("state=other");
    await has("other connection: a question it lists, beside a run's wait it has no card for" + at, p, ["Otto is waiting for approval. This connection has no approval card for this run.", "Waiting for an answer", "Which route should I plan for Saturday?", "Waiting for you: Juniper, a question", "In Otto's task history", "In Juniper's, Otto's and Marlow's task histories"]);
    check("other connection: no approval card or approval buttons" + at, (await p.locator('[data-kind="approval"]').count()) === 0 && (await p.getByRole("button", { name: "Allow once" }).count()) === 0);
    const t = await text(p);
    check("other connection: says nothing of a device or a message for the approval" + at, !t.includes("device that sent") && !t.includes("this message"));
    check("other connection: the wait comes from a real active run" + at, (await p.locator('.g-status [data-run="r-otto-a36bfcc7"]').count()) === 1);
    await p.locator("#g-question-ask_route .option").first().click();
    check("other connection: answers a question whose run began elsewhere" + at, await waitText(p, ["The lake loop, then."], ".transcript-inner"));
    await p.close();
  }
  {
    const p = await o("state=readonly");
    await has("read-only: the access bar and the run's wait" + at, p, ["Read-only. You can follow this group here. Approvals and questions aren't shown on this connection.", "Request access", "Otto is waiting for approval. This connection has no approval card for this run."]);
    check("read-only: no composer, no New, no message menu, no card, no card buttons" + at, (await p.locator("#g-input").count()) === 0 && (await p.locator("#new-button").isHidden()) && (await p.locator("[data-msg-menu]").count()) === 0 && (await p.locator(".request").count()) === 0);
    await p.evaluate(() => document.getElementById("g-phase").click()); // the run's live phase ends
    check("read-only: the wait shows only while the live phase is present" + at, await gone(p, '[data-member-line="otto-wait"]'));
    await btn(p, "Request access");
    check("read-only: Request access asks, then waits for the owner" + at, await waitText(p, ["Waiting for the gateway's owner."]));
    await p.click("#title-pill");
    await p.waitForTimeout(250);
    await has("read-only: details read, with no changes" + at, p, ["Group details", "Devices signed in to the same gateway profile show this group."], "#g-dialog");
    check("read-only: details have no Rename, Add or Remove" + at, (await p.locator("#g-dialog [data-rename], #g-dialog [data-add], #g-dialog [data-remove-group], #g-dialog [data-remove-member]").count()) === 0);
    await p.close();
  }
  {
    const p = await o("state=offline");
    await has("offline: the held message" + at, p, ["Bring sunscreen too.", "Sends when reconnected"]);
    check("offline: the placeholder" + at, (await p.getAttribute("#g-input", "placeholder")) === "Offline. Messages send when you reconnect.");
    await p.evaluate(() => document.getElementById("g-reconnect").click());
    const ok = await waitText(p, ["Bring sunscreen too.", "Sent to Juniper, Otto and Marlow"], ".transcript-inner");
    const j = await journal(p);
    check("offline: on reconnect each copy goes through the guarded path" + at, ok && j.sends.length === 3 && j.sends.every((s) => s.expectedLeafEntryId === null && s.queueMode === undefined && s.sessionId), JSON.stringify(j.sends));
    await p.close();
  }
  {
    const p = await o("state=offline&fail=reconnectgone");
    await p.evaluate(() => document.getElementById("g-reconnect").click());
    const ok = await waitText(p, ["Not sent to Marlow", "Marlow's task in this group was deleted."], ".transcript-inner");
    const j = await journal(p);
    check("offline: a task deleted while offline gets no request on reconnect" + at, ok && !j.sends.some((s) => s.sessionKey.endsWith(":marlow")), JSON.stringify(j.sends));
    await p.close();
  }
  for (const [s, line, action] of [
    ["archived", "Marlow's task in this group is archived. Messages to everyone skip Marlow.", "Restore Marlow's task"],
    ["taskgone", "Marlow's task in this group was deleted. Messages to everyone skip Marlow.", "Start a new task for Marlow"],
    ["botgone", "Marlow was deleted, with its tasks. Messages to everyone skip Marlow.", "Remove Marlow"],
    ["changed", "Marlow's task changed during the send. The gateway accepted this copy in the new task.", "Use the current task"],
    ["replaced", "Marlow's task was replaced: a new task is at its place.", "Use the current task"],
  ]) {
    const p = await o(`state=${s}`);
    await has(`${s}: the line and its action` + at, p, [line, action]);
    const chip = await label(p, ".g-chip[data-skipped]");
    check(`${s}: the To line strikes Marlow` + at, !!chip && chip.startsWith("Marlow, skipped"), String(chip));
    await p.close();
  }
  {
    const p = await o("state=taskgone");
    const t = await text(p, ".transcript-inner");
    check("taskgone: a deleted task gives no saved row and no history receipt" + at, !t.includes("borrowing the trailer") && t.includes("In Juniper's and Otto's task histories"));
    await p.close();
  }
  {
    const p = await o("state=removed");
    await has("removed: what stays" + at, p, ["Removed Weekend plans. Juniper's, Otto's and Marlow's tasks stay in their lists."]);
    await p.close();
  }
  {
    const p = await o("bot=otto");
    await has("a member task under its bot" + at, p, ["This task is part of Weekend plans. Only your messages to Otto are here.", "Open the group"]);
    const name = await label(p, "[data-member-task]");
    check("a member task's name says its group" + at, name.endsWith("in the group Weekend plans"), name);
    check("a member task shows Otto's side only" + at, (await p.locator(".msg").count()) === 2);
    await btn(p, "Open the group");
    check("Open the group returns to the column" + at, await waitText(p, ["Clawtrate sends each bot a separate copy."]));
    await p.close();
  }
  for (const [q, words] of [
    ["open=new&fail=noprefs", ["This connection can't keep preferences on the gateway, so it can't keep a group.", "Close"]],
    ["open=new", ["New group", "Choose 2 to 6 bots.", "Clawtrate makes a new task with each bot and keeps the group with your preferences on the gateway, so your other devices show it."]],
    ["open=new&pick=juniper,otto", ["Name: Robin, Juniper and Otto. You can rename it later."]],
    ["open=new&pick=juniper,otto,marlow,pip,extra1,extra2", ["A group has at most 6 bots."]],
    ["open=details", ["Group details", "Members", "Open Otto's task", "Each member has its own task with you. Opening it shows your messages to that bot and its replies.", "Add a bot", "Remove group…", "Devices signed in to the same gateway profile show this group."]],
    ["confirm=member", ["Remove Marlow from Weekend plans?", "Marlow's task is present. Removing this group record keeps the tasks and their histories. Work the gateway already accepted can continue."]],
    ["confirm=group", ["Remove Weekend plans?", "Juniper's, Otto's and Marlow's tasks are present. Removing this group record keeps the tasks and their histories. Work the gateway already accepted can continue."]],
    ["state=taskgone&confirm=group", ["Juniper's and Otto's tasks are present. Marlow's task is already gone."]],
  ]) {
    const p = await o(q);
    if (q === "open=details") await p.waitForTimeout(250); // the record is read first
    await has(`dialog ${q}` + at, p, words, "#g-dialog");
    await p.close();
  }
  {
    const p = await o("open=new&pick=juniper");
    check("New group: Create waits for two bots" + at, await p.locator("[data-create]").isDisabled());
    await p.fill("#g-filter", "iv");
    const shown = await p.locator("[data-pick]:visible").evaluateAll((els) => els.map((e) => e.dataset.pick));
    check("New group: the name filter narrows the list" + at, shown.join(",") === "extra2", shown.join(","));
    await p.close();
    const q = await o("open=new&pick=juniper,otto,marlow,pip,extra1,extra2");
    check("New group: a seventh bot cannot be chosen" + at, (await q.getAttribute('[data-pick="extra3"]', "aria-disabled")) === "true");
    await q.close();
  }
  for (const [q, words, to] of [
    ["compose=mention", ["Everyone", "Juniper", "Otto", "Marlow"], "To Everyone. 3 bots. Each bot that answers uses its own tokens."],
    ["compose=otto", ["To", "Otto", "1 bot · Each bot that answers uses its own tokens"], "To Otto. 1 bot. Each bot that answers uses its own tokens."],
    ["compose=reply", ["Replying to Juniper", "(replying)"], "To Juniper (replying). 1 bot. Each bot that answers uses its own tokens."],
    ["compose=quote", ["To", "Juniper"], "To Juniper. 1 bot. Each bot that answers uses its own tokens."],
    ["state=samename&compose=ambiguous", ["@Otto matches 2 members. Choose one in the list.", "Otto (Operations)", "Otto (Garage)"], "@Otto matches 2 members. Choose one in the list."],
  ]) {
    const p = await o(q);
    await has(`composer ${q}` + at, p, words, "#composer-slot");
    const got = await label(p, ".g-to");
    check(`composer ${q}: the To line's name` + at, got === to, got);
    if (q === "compose=quote") check("composer: a quoted @Otto chooses no one" + at, (await label(p, "[data-send]")) === "Send to Juniper");
    if (q.includes("ambiguous")) check("composer: Send waits for a choice" + at, await p.locator("[data-send]").isDisabled());
    await p.close();
  }
  {
    const p = await o("compose=reply&fail=replypreview");
    await has("reply: an unreadable original says so" + at, p, ["Replying to Juniper", "Original message unavailable."], "#composer-slot");
    await p.close();
  }

  // Part 2: the walks ----------------------------------------------------------------------
  async function newGroup(query, picks, steps, end, name, extra) {
    const p = await o(query);
    if (p.phone) await p.click('[data-action="back"]');
    await p.click("#new-button");
    await item(p, "New group");
    for (const pick of picks) await p.click(`[data-pick="${pick}"]`);
    await btn(p, "Create");
    for (const [wait, act] of steps) {
      if (!(await waitText(p, wait, "#g-dialog"))) {
        check(`walk: ${name}` + at, false, `did not see ${wait.join(" | ")}`);
        return p.close();
      }
      if (act) {
        const before = (await journal(p)).recordWrites.length;
        await btn(p, act);
        if (act === "Check again") check(`walk: ${name}: Check again writes nothing` + at, (await journal(p)).recordWrites.length === before);
      }
    }
    const ok = await waitText(p, end);
    check(`walk: ${name}` + at, ok && p.errors.length === 0, ok ? p.errors.join(" | ") : `did not end at ${end.join(" | ")}: ${(await text(p)).slice(0, 200)}`);
    if (extra) await extra(p);
    await p.close();
  }
  await newGroup("state=open", ["juniper", "otto", "marlow"], [], ["Robin, Juniper, Otto and Marlow", "Write to everyone, or start with @ to choose who answers."], "New group to an empty group");
  await newGroup("fail=marlow", ["juniper", "otto", "marlow"], [[["Made tasks for Juniper and Otto. Couldn't make one for Marlow.", 'The gateway answered: Unknown agent id "marlow".'], "Make it without Marlow"]], ["Robin, Juniper and Otto", "Write to everyone"], "a task refused, then made without it");
  await newGroup("fail=marlow", ["juniper", "otto", "marlow"], [[["Couldn't make one for Marlow."], "Try Marlow again"]], ["Robin, Juniper, Otto and Marlow"], "a task refused, then tried again");
  await newGroup("fail=marlow", ["juniper", "otto", "marlow"], [[["Couldn't make one for Marlow."], "Cancel"]], ["No group was made. Juniper's and Otto's new tasks stay in their lists."], "a task refused, then cancelled, absence read");
  await newGroup("fail=record", ["juniper", "otto"], [[["Made tasks for Juniper and Otto, but couldn't save the group."], "Try again"]], ["Robin, Juniper and Otto", "Write to everyone"], "the record refused, then saved with the same tasks", async (p) => {
    const j = await journal(p);
    const creates = j.taskWrites.filter((w) => w.kind === "create");
    const last = j.recordWrites.at(-1).next.members.map((x) => x.sid);
    check("walk: Try again uses the tasks already made" + at, creates.length === 2 && last.every((sid) => creates.some((c) => c.sid === sid)), JSON.stringify({ creates, last }));
  });
  await newGroup("fail=readback", ["juniper", "otto"], [[["Couldn't confirm the group was saved."], "Check again"]], ["Robin, Juniper and Otto", "Write to everyone"], "saved but unconfirmed, then read");
  await newGroup("fail=readback", ["juniper", "otto"], [[["Couldn't confirm the group was saved."], "Cancel"]], ["Couldn't confirm the group was saved. Juniper's and Otto's new tasks stay in their lists."], "cancelled while unconfirmed");
  await newGroup("fail=full", ["juniper", "otto"], [[["Your gateway preferences have no room for another group. Remove a saved preference and try again."], "Cancel"]], ["No group was made. Juniper's and Otto's new tasks stay in their lists."], "the preferences full");
  {
    const p = await o("open=new&pick=juniper,otto");
    await p.clock?.install?.();
    await p.click("[data-create]");
    await p.waitForTimeout(80);
    const close = await p.getByRole("button", { name: "Close", exact: true }).count();
    await p.keyboard.press("Escape");
    await p.waitForTimeout(80);
    check("walk: a write in progress stays visible, with no Close, through Escape" + at, close === 0 && (await p.locator("#g-dialog").isVisible()));
    await p.close();
  }

  // Sending.
  {
    const p = await o("state=open");
    await type(p, "Bring water for everyone");
    await p.keyboard.press("Enter");
    const sending = await waitText(p, ["Sending to Juniper, Otto and Marlow…"], ".transcript-inner", 1500);
    const accepted = await waitText(p, ["Accepted by the gateway for Juniper, Otto and Marlow"], ".transcript-inner", 1500);
    const sent = await waitText(p, ["Sent to Juniper, Otto and Marlow"], ".transcript-inner");
    const live = await said(p, "Sent to Juniper, Otto and Marlow");
    const juniperFirst = await waitText(p, ["Noted. I'll check the forecast again on Friday evening."], ".g-said", 3000);
    const ottoNotYet = !(await text(p, ".g-said")).includes("Will do. I'll keep an eye");
    const all = await waitText(p, ["Will do. I'll keep an eye", "Got it. I'll add it to the note"], ".g-said", 5000);
    const [ot, ma, ju] = await order(p, ["Will do. I'll keep an eye", "Got it. I'll add it", "Noted. I'll check the forecast"]);
    const j = await journal(p);
    const guarded = j.sends.length === 3 && new Set(j.sends.map((s) => s.copy)).size === 3 && j.sends.every((s) => s.expectedLeafEntryId === null && s.queueMode === undefined && s.sessionId);
    check("walk: send to everyone: sending, accepted, sent, announced" + at, sending && accepted && sent && live, `${sending} ${accepted} ${sent} ${live}`);
    check("walk: one guarded request per copy, no mode override" + at, guarded, JSON.stringify(j.sends));
    check("walk: a reply takes its saved place when it is read back" + at, juniperFirst && ottoNotYet && all && ot < ma && ma < ju, `${juniperFirst} ${ottoNotYet} ${all} ${ot} ${ma} ${ju}`);
    const tl = j.targets.at(-1).join(",");
    check("walk: the To line, Send and the captured targets agree" + at, tl === "juniper,otto,marlow", tl);
    await p.close();
  }
  {
    // The same text stays at the reading line while replies insert above it.
    const p = await o("state=open");
    await type(p, "Check all three bots");
    await p.keyboard.press("Enter");
    await waitText(p, ["Noted. I'll check the forecast again"], ".g-said", 3000);
    await p.fill("#g-input", "Second message below the reading line. ".repeat(130));
    await p.keyboard.press("End");
    await btn(p, "Send to everyone");
    await p.waitForTimeout(50);
    const pos = () =>
      p.evaluate(() => {
        const t = document.querySelector("#transcript");
        const bubble = [...document.querySelectorAll(".g-said")].find((x) => x.textContent.includes("check the forecast again on Friday evening"));
        return { offset: Math.round(bubble.getBoundingClientRect().top - t.getBoundingClientRect().top), id: bubble.dataset.said };
      });
    await p.evaluate(() => {
      const t = document.querySelector("#transcript");
      const bubble = [...document.querySelectorAll(".g-said")].find((x) => x.textContent.includes("check the forecast again on Friday evening"));
      t.scrollTop += bubble.getBoundingClientRect().top - t.getBoundingClientRect().top - 120;
    });
    const before = await pos();
    await waitText(p, ["Will do. I'll keep an eye", "Got it. I'll add it to the note"], ".g-said", 5000);
    await p.waitForTimeout(100);
    const after = await pos();
    check("walk: the same bubble keeps its place through an insertion above it" + at, before.id === after.id && Math.abs(before.offset - after.offset) <= 1, JSON.stringify({ before, after }));
    await p.close();
  }
  {
    const p = await o("state=open");
    await type(p, "@");
    const listed = (await p.locator(".g-mentions [role=menuitem]").count()) === 4;
    await item(p, "Otto");
    await p.keyboard.type("how full is the media box?");
    const name = await label(p, "[data-send]");
    await p.keyboard.press("Enter");
    const sent = await waitText(p, ["Sent to Otto"], ".transcript-inner");
    const reply = await waitText(p, ["Will do. I'll keep an eye"], ".transcript-inner", 4000);
    const t = await text(p, ".transcript-inner");
    check("walk: @Otto reaches Otto alone, with the text as typed" + at, listed && name === "Send to Otto" && sent && reply && !t.includes("Noted. I'll check the forecast") && t.includes("@Otto how full is the media box?"), `${listed} ${name} ${sent} ${reply}`);
    await p.close();
  }
  {
    const p = await o("state=open");
    await type(p, "@");
    await p.keyboard.press("Escape");
    check("walk: Escape closes the mention list and keeps the @" + at, (await p.locator(".g-mentions").count()) === 0 && (await p.inputValue("#g-input")) === "@");
    await p.keyboard.type("O");
    await p.keyboard.press("ArrowDown");
    const focused = await p.evaluate(() => document.activeElement.textContent);
    await p.keyboard.press("Enter");
    check("walk: the mention list by keyboard: filter, arrows, Enter" + at, focused.includes("Otto") && (await p.inputValue("#g-input")) === "@Otto ", `${focused} ${await p.inputValue("#g-input")}`);
    await p.close();
  }
  // Recipients: bindings to one mention in the current draft.
  {
    const p = await o("state=samename&compose=ambiguous");
    await item(p, "Otto (Garage)");
    const first = await label(p, "[data-send]");
    await p.keyboard.press("Enter");
    await waitText(p, ["Sent to Otto (Garage)"], ".transcript-inner");
    await p.fill("#g-input", "@Otto please check again");
    const second = await label(p, ".g-to");
    check("walk: a choice holds for one draft only; sending clears it" + at, first === "Send to Otto (Garage)" && second.startsWith("@Otto matches 2 members") && (await p.locator("[data-send]").isDisabled()), `${first} ${second}`);
    await p.close();
  }
  {
    const p = await o("state=samename");
    await p.fill("#g-input", "@Otto and @Otto both");
    await p.locator("#g-input").press("End");
    await item(p, "Otto (Operations)");
    const after1 = await label(p, ".g-to");
    await item(p, "Otto (Garage)");
    const after2 = await label(p, "[data-send]");
    check("walk: two duplicate mentions each need their own choice" + at, after1.startsWith("@Otto matches 2 members") && after2 === "Send to Otto (Operations) and Otto (Garage)", `${after1} | ${after2}`);
    // Editing a bound token drops its binding, even when it is typed back.
    await p.fill("#g-input", "@Ott and @Otto both");
    await p.fill("#g-input", "@Otto and @Otto both");
    const edited = await label(p, ".g-to");
    check("walk: a changed token loses its binding; the other keeps its own" + at, edited.startsWith("@Otto matches 2 members"), edited);
    await p.fill("#g-input", "@Ottoline can you fetch the key?");
    check("walk: a longer name matches only itself" + at, (await label(p, "[data-send]")) === "Send to Ottoline");
    await p.fill("#g-input", "@everyone and @Otto");
    check("walk: @everyone takes precedence over a duplicate" + at, (await label(p, "[data-send]")) === "Send to everyone" && !(await p.locator("[data-send]").isDisabled()));
    await p.fill("#g-input", "");
    await type(p, "@Iv");
    await item(p, "Ivy May");
    const multi = await label(p, "[data-send]");
    await p.keyboard.type("water the tomatoes");
    await p.keyboard.press("Enter");
    const j = await journal(p);
    check("walk: a multiword name is chosen from the list, and sent to that bot" + at, multi === "Send to Ivy May" && j.targets.at(-1).join(",") === "extra2", `${multi} ${JSON.stringify(j.targets.at(-1))}`);
    await p.close();
  }
  {
    const p = await o("state=open");
    if (!p.phone) await p.hover('[data-said]:has-text("trailer")');
    await p.click('[aria-label="More for Marlow\'s message"]');
    await item(p, "Quote");
    const v = await p.inputValue("#g-input");
    const everyone = (await label(p, "[data-send]")) === "Send to everyone";
    await p.keyboard.type("@Juniper is 8 still right?");
    const juniper = (await label(p, "[data-send]")) === "Send to Juniper";
    check("walk: Quote prefixes every line; a bot name on its second line chooses no one" + at, v === "> Marlow: I'll draft a short note for the neighbours about borrowing the trailer.\n> @Otto, can you print it?\n" && everyone && juniper, JSON.stringify(v));
    await p.close();
  }
  {
    const p = await o("state=open");
    if (!p.phone) await p.hover('[data-said]:has-text("forecast")');
    await p.click('[aria-label="More for Juniper\'s message"]');
    await item(p, "Reply");
    const strip = await waitText(p, ["Replying to Juniper"], "#composer-slot");
    await p.keyboard.type("Can we start at 7 instead? @Otto too");
    const still = (await label(p, "[data-send]")) === "Send to Juniper";
    await p.keyboard.press("Enter");
    const sent = await waitText(p, ["Sent to Juniper"], ".transcript-inner");
    check("walk: Reply goes to the bot that wrote it, whatever the text names" + at, strip && still && sent, `${strip} ${still} ${sent}`);
    await p.close();
  }
  {
    const p = await o("state=open&compose=reply&fail=replygone");
    await p.locator("#g-input").fill("Is 8 still right?");
    await p.locator("#g-input").press("Enter");
    const blocked = await waitText(p, ["Juniper's task in this group was deleted, so it can't take this reply."], "#composer-slot");
    const j = await journal(p);
    const disabled = await p.locator("[data-send]").isDisabled();
    await btn(p, "Cancel reply");
    check("walk: a Reply whose task went sends no request, and Send waits for Cancel" + at, blocked && j.sends.length === 0 && disabled && (await label(p, "[data-send]")) === "Send to everyone", `${blocked} ${j.sends.length} ${disabled}`);
    await p.close();
  }
  // Guarded delivery.
  {
    const p = await o("state=open&fail=vanish");
    await type(p, "Who has the trailer key?");
    await p.keyboard.press("Enter");
    const refused = await waitText(p, ["Couldn't send to Marlow", "Marlow's task in this group was deleted. Messages to everyone skip Marlow."], ".transcript-inner");
    await p.locator("[data-went]").last().click();
    const why = await waitText(p, ["The gateway answered: active branch changed; review and retry"], ".transcript-inner", 1500);
    check("walk: a task deleted during the send is refused by the guard, not remade" + at, refused && why, `${refused} ${why}`);
    await p.close();
  }
  {
    const p = await o("state=open&fail=replacedafter");
    await type(p, "@Marlow are you there?");
    await p.keyboard.press("Enter");
    const line = await waitText(p, ["Marlow's task changed during the send."], ".transcript-inner");
    const t = await text(p, ".transcript-inner");
    check("walk: a replacement after admission, with no correlated receipt, says nothing of where the copy went" + at, line && !t.includes("The gateway accepted this copy") && t.includes("Accepted by the gateway for Marlow"), t.slice(-300));
    await p.close();
  }
  {
    const p = await o("state=open&fail=replacedreceipt");
    await type(p, "@Marlow are you there?");
    await p.keyboard.press("Enter");
    const line = await waitText(p, ["Marlow's task changed during the send. The gateway accepted this copy in the new task.", "Accepted in a new task for Marlow"], ".transcript-inner");
    check("walk: with a correlated receipt, the line says where the copy went" + at, line);
    await p.close();
  }
  {
    const p = await o("state=changed");
    await btn(p, "Use the current task");
    const ask = await waitText(p, ["Use the current task for Marlow in Weekend plans?", "as read now"], "#g-dialog");
    const before = (await journal(p)).recordWrites.length;
    await p.locator("#g-dialog [data-do-adopt]").click();
    const done = await gone(p, '[data-member-line="marlow"]');
    check("walk: the current task is used only on confirmation, after its history is read, by one write" + at, ask && done && (await journal(p)).recordWrites.length === before + 1, `${ask} ${done}`);
    await p.close();
  }
  {
    const p = await o("state=changed&fail=adoptconflict");
    await btn(p, "Use the current task");
    await waitText(p, ["as read now"], "#g-dialog");
    await p.locator("#g-dialog [data-do-adopt]").click();
    check("walk: adopting meets a different record and shows it" + at, await waitText(p, ["Now saved: Weekend plans, with Juniper and Marlow."], "#g-dialog"));
    await p.close();
  }
  {
    const p = await o("state=approval");
    await type(p, "@Otto also check the logs");
    await p.keyboard.press("Enter");
    const acc = await waitText(p, ["Accepted by the gateway for Otto"], ".transcript-inner");
    await p.waitForTimeout(400);
    check("walk: a pending approval does not turn Accepted into Steer" + at, acc && !(await text(p, ".transcript-inner")).includes("Steer for Otto"));
    await p.close();
  }
  {
    const p = await o("state=running");
    await type(p, "@Juniper also the ferry times");
    await p.keyboard.press("Enter");
    const steer = await waitText(p, ["Steer for Juniper"], ".transcript-inner");
    check("walk: a confirmed steer, captioned and announced" + at, steer && (await said(p, "Steer for Juniper")));
    await p.close();
  }
  {
    const p = await o("state=twodevices");
    await type(p, "@Otto a follow-up from this device");
    await p.keyboard.press("Enter");
    const q = await waitText(p, ["Queued by the gateway for Otto"], ".transcript-inner");
    check("walk: a queued turn, captioned and announced" + at, q && (await said(p, "Queued by the gateway for Otto")));
    await p.close();
  }
  {
    const p = await o("state=partial");
    const noResend = (await p.getByRole("button", { name: "Resend to Marlow", exact: true }).count()) === 0;
    await btn(p, "Restore Marlow's task");
    const restored = await waitText(p, ["Resend to Marlow"], ".transcript-inner");
    const tw = (await journal(p)).taskWrites.filter((w) => w.kind === "restore").length;
    await btn(p, "Resend to Marlow");
    const sent = await waitText(p, ["Sent to Juniper, Otto and Marlow"], ".transcript-inner");
    const j = await journal(p);
    check("walk: a refused copy, its task restored by one task write, then resent through the guard" + at, noResend && restored && tw === 1 && sent && j.sends.at(-1).sessionKey.endsWith(":marlow"), `${noResend} ${restored} ${tw} ${sent}`);
    await p.close();
  }
  // Stop.
  {
    const p = await o("state=running");
    await p.click("[data-stop]");
    const stopping = await waitText(p, ["Stopping…"], "#root", 1000);
    const stopped = await waitText(p, ["Stopped. Juniper's and Otto's runs stopped. Completed actions are not undone."], ".transcript-inner");
    const j = await journal(p);
    check("walk: Stop aborts each captured run by its id and names it from its end" + at, stopping && stopped && j.aborts.map((a) => a.runId).sort().join(",") === "r-juniper-5b70e1d4,r-otto-a36bfcc7" && (await p.locator(".g-status .status-line").count()) === 0, JSON.stringify(j.aborts));
    await p.close();
  }
  {
    const p = await o("state=twodevices");
    await p.click("[data-stop]");
    const said = await waitText(p, ["Stopped. Juniper's run stopped.", "Couldn't stop Otto's run from this device."]);
    const line = await text(p, '.g-status [data-run="r-otto-a36bfcc7"]');
    check("walk: Stop across two devices: one run stopped, the other refused and still live" + at, said && line.includes("Reading backup-2026-11-15.log") && (await label(p, "[data-stop]")) === "Stop 1 bot", `${said} ${line}`);
    await p.close();
  }
  {
    const p = await o("state=queuedturn");
    const before = (await p.locator(".g-status .status-line").count()) === 2 && (await text(p, ".g-status")).includes("Queued by the gateway");
    await p.click("[data-stop]");
    const stopped = await waitText(p, ["Stopped. Otto's run stopped."], ".transcript-inner");
    const next = await waitText(p, ["@Otto also check the trail camera.", "In Otto's task history"], ".transcript-inner", 2000);
    const result = await waitText(p, ["The trail camera has 40 new pictures"], ".transcript-inner", 4000);
    const j = await journal(p);
    check("walk: a queued turn keeps its own state through Stop and finishes with its result" + at, before && stopped && next && result && j.aborts.length === 1 && j.aborts[0].runId === "r-otto-a36bfcc7", `${before} ${stopped} ${next} ${result} ${JSON.stringify(j.aborts)}`);
    await p.close();
  }
  {
    // A run that finishes before Stop's answer: its reply stays, and it is not called stopped.
    const p = await o("state=open");
    await type(p, "@Juniper please finish first");
    await p.keyboard.press("Enter");
    await p.locator("[data-stop]").waitFor({ timeout: 2000 });
    await p.waitForTimeout(400);
    await p.click("[data-stop]");
    const ok = await waitText(p, ["Noted. I'll check the forecast again on Friday evening.", "Juniper: Finished before Stop took effect."], ".transcript-inner", 3000);
    check("walk: a mixed finish before Stop's answer is not called stopped" + at, ok && !(await text(p, ".transcript-inner")).includes("Juniper's run stopped"));
    await p.close();
  }
  {
    const p = await o("state=approval");
    await p.click("[data-stop]");
    const ok = await waitText(p, ["Stopped. Otto's run stopped.", "Cancelled"], ".transcript-inner");
    check("walk: Stop with a pending approval closes the card from its own outcome" + at, ok && (await p.getByRole("button", { name: "Allow once", exact: true }).count()) === 0 && !(await text(p, "#composer-slot")).includes("needs your approval"));
    await p.close();
  }
  {
    // No answer, then the run ends by itself: Try again sends no abort.
    const p = await o("state=open&stopfail=marlow");
    await type(p, "@Marlow take your time");
    await p.keyboard.press("Enter");
    await p.locator("[data-stop]").waitFor({ timeout: 2000 });
    await p.click("[data-stop]");
    const noAnswer = await waitText(p, ["No answer about Marlow's run."], "#composer-slot");
    await waitText(p, ["Got it. I'll add it to the note"], ".transcript-inner", 3000);
    const before = (await journal(p)).aborts.length;
    await btn(p, "Try again");
    const after = (await journal(p)).aborts.length;
    check("walk: a retry after the original run ended sends no abort" + at, noAnswer && before === after && !(await text(p, "#composer-slot")).includes("No answer about"), `${noAnswer} ${before} ${after}`);
    await p.close();
  }
  {
    const p = await o("state=running&stopfail=otto");
    await p.click("[data-stop]");
    const partly = await waitText(p, ["Stopped. Juniper's run stopped.", "No answer about Otto's run."]);
    await btn(p, "Try again");
    const stopped = await waitText(p, ["Stopped. Otto's run stopped."], ".transcript-inner");
    const j = await journal(p);
    check("walk: Try again on the same run id while it is active" + at, partly && stopped && j.aborts.filter((a) => a.runId === "r-otto-a36bfcc7").length === 2, `${partly} ${stopped} ${JSON.stringify(j.aborts)}`);
    await p.close();
  }
  // Questions and approvals.
  {
    const p = await o("state=question");
    await type(p, "Also check the trail cam");
    await p.keyboard.press("Enter");
    const held = await waitText(p, ["Held until you answer Otto"], ".transcript-inner");
    await p.locator("#g-question-ask_cache .option").first().click();
    const released = await waitText(p, ["Accepted by the gateway for Otto"], ".transcript-inner");
    const noSteer = !(await text(p, ".transcript-inner")).includes("Steer for Otto");
    const sent = await waitText(p, ["I'll keep the cache for a week", "Sent to Juniper, Otto and Marlow"], ".transcript-inner", 4000);
    check("walk: a held copy released through the guard; a just-closed question does not make it a Steer" + at, held && released && noSteer && sent, `${held} ${released} ${noSteer} ${sent}`);
    await p.close();
  }
  {
    const p = await o("state=twoquestions");
    await type(p, "@Otto thanks");
    await p.keyboard.press("Enter");
    await p.locator("#g-question-ask_cache .option").first().click();
    await p.waitForTimeout(300);
    const stillHeld = (await text(p, ".transcript-inner")).includes("Held until you answer Otto") && (await p.locator('#g-question-ask_downloads[data-state="pending"], #g-question-ask_downloads:not([data-state])').count()) === 1;
    await p.locator("#g-question-ask_downloads .option").first().click();
    const released = await waitText(p, ["Accepted by the gateway for Otto"], ".transcript-inner");
    check("walk: two questions in one task: settling one leaves the other, and the copy waits for the last" + at, stillHeld && released, `${stillHeld} ${released}`);
    await p.close();
  }
  {
    const p = await o("state=twoapprovals");
    const before = await p.getByRole("button", { name: "Allow once", exact: true }).count();
    await p.locator("#g-approval-5e1d0c2a").getByRole("button", { name: "Allow once", exact: true }).click();
    await waitText(p, ["Allowed once"], ".transcript-inner");
    const after = await p.getByRole("button", { name: "Allow once", exact: true }).count();
    check("walk: two approvals from different runs settle apart" + at, before === 2 && after === 1 && (await p.locator("#g-approval-9b44f1c3 [data-decision]").count()) > 0, `${before} ${after}`);
    await p.close();
  }
  for (const [decision, end] of [
    ["Allow once", ["Allowed once", "It's steady at 71%."]],
    ["Deny", ["Denied", "Understood. I won't list the files"]],
  ]) {
    const p = await o("state=approval");
    await btn(p, decision);
    const ok = await waitText(p, end, ".transcript-inner");
    check(`walk: approval, ${decision}` + at, ok && !(await text(p, "#composer-slot")).includes("Otto needs your approval"));
    await p.close();
  }
  {
    const p = await o("state=approval");
    await btn(p, "Always allow…");
    const form = await waitText(p, ["so Otto is not asked again for commands it matches"], ".request");
    await btn(p, "Allow and save");
    check("walk: approval, Always allow saves for the asking bot" + at, form && (await waitText(p, ["Always allowed", "Added to media-box's allowlist."], ".transcript-inner")));
    await p.close();
  }
  // Results stay with their group and task.
  {
    const p = await o("state=open");
    await type(p, "@Otto Weekend-only test");
    await p.keyboard.press("Enter");
    await railClick(p, '.bot[data-group="g2"]');
    await p.waitForTimeout(2200);
    const inDinner = (await text(p, ".transcript-inner")).split("Will do. I'll keep an eye").length - 1;
    await railClick(p, '.bot[data-group="g1"]');
    const inWeekend = (await text(p, ".transcript-inner")).split("Will do. I'll keep an eye").length - 1;
    check("walk: a reply goes to its own group, whichever is open" + at, inDinner === 0 && inWeekend === 1, `${inDinner} ${inWeekend}`);
    await p.close();
  }
  {
    const p = await o("state=open");
    await type(p, "@Marlow please answer this");
    await p.keyboard.press("Enter");
    await waitText(p, ["Got it."], ".g-status", 2000);
    await p.click("#title-pill");
    await btn(p, "Remove Marlow");
    await btn(p, "Remove");
    await members(p, 2);
    await p.waitForTimeout(900);
    const t = await text(p, ".transcript-inner");
    const blank = await p.evaluate(() => [...document.querySelectorAll(".g-went")].some((x) => !x.textContent.trim()));
    const clean = !t.includes("please answer this") && !t.includes("Got it. I'll add it") && (await p.locator('.g-status [data-run]').count()) === 0 && !blank;
    await railClick(p, '[data-bot-row="marlow"]');
    const own = await waitText(p, ["Got it. I'll add it to the note for the neighbours."], ".transcript-inner", 2000);
    check("walk: a member removed mid-run leaves the group; its reply lands in its own task" + at, clean && own, `${clean} ${own} ${t.slice(-200)}`);
    await p.close();
  }
  if (!WIDTHS.includes(390) || W === 1440) {
    const p = await o("state=open");
    await p.locator('.bot[data-group="g2"]').focus();
    await p.keyboard.press("Shift+F10");
    await item(p, "Rename…");
    await p.waitForTimeout(250);
    const name = await p.inputValue("#g-name");
    check("walk: the keyboard menu acts on the row that opened it" + at, name === "Dinner plans" && (await text(p, "#title-pill")).includes("Weekend plans"), name);
    await p.keyboard.press("Escape");
    await p.locator('.bot[data-group="g1"]').focus();
    await p.keyboard.press("Shift+F10");
    await p.keyboard.press("ArrowDown");
    const focused = await p.evaluate(() => document.activeElement.textContent);
    await p.keyboard.press("Enter");
    check("walk: the row's menu by keyboard: arrows and Enter" + at, focused === "Group details" && (await waitText(p, ["Group details"], "#g-dialog")), focused);
    await p.close();
  } else {
    const p = await o("state=open&view=list");
    await longPress(p, '.bot[data-group="g2"]');
    const items = await p.locator("#rail-menu [role=menuitem]").allTextContents();
    await item(p, "Rename…");
    await p.waitForTimeout(250);
    check("walk: a long press on a row opens its menu, acting on that row" + at, items.join("|") === "Rename…|Group details|Remove group…" && (await p.inputValue("#g-name")) === "Dinner plans", items.join("|"));
    await p.close();
    const q = await o("state=open");
    await longPress(q, '[data-said]:has-text("forecast")');
    const msg = await q.locator("#rail-menu [role=menuitem]").allTextContents();
    check("walk: a long press on a reply opens Reply and Quote" + at, msg.join("|") === "Reply|Quote", msg.join("|"));
    await q.close();
  }
  // Changes to a group: pre-read, compare-and-set, read-back; Check again only reads.
  {
    const p = await o("state=open");
    await p.click("#title-pill");
    await btn(p, renameWord(p));
    await p.fill("#g-name", "");
    const empty = await p.locator("[data-save-name]").isDisabled();
    await p.fill("#g-name", "<Saturday>");
    await btn(p, saveWord(p));
    const saved = await waitText(p, ["<Saturday>"], "#title-pill");
    const row = (await text(p, '.bot[data-group="g1"]')).includes("<Saturday>");
    await btn(p, "Remove group…");
    const heading = await waitText(p, ["Remove <Saturday>?"], "#g-dialog h2");
    check("walk: rename read back in the pill and the row; a name with angle brackets is text" + at, empty && saved && row && heading, `${empty} ${saved} ${row} ${heading}`);
    await p.close();
  }
  {
    const p = await o("state=open&conflict=1");
    await p.click("#title-pill");
    await btn(p, renameWord(p));
    await p.fill("#g-name", "Saturday trail");
    await btn(p, saveWord(p));
    const conflict = await waitText(p, ["Now saved: Saturday, with Juniper, Otto and Marlow."], "#g-dialog");
    const pill = (await text(p, "#title-pill")).includes("Saturday");
    await btn(p, "Save again");
    const saved = await waitText(p, ["Saturday trail"], "#title-pill");
    check("walk: rename meets a different record, shows it, saves again against it" + at, conflict && pill && saved, `${conflict} ${pill} ${saved}`);
    await p.close();
  }
  {
    const p = await o("state=open&conflict=refused");
    await p.click("#title-pill");
    await btn(p, renameWord(p));
    await p.fill("#g-name", "Saturday trail");
    await btn(p, saveWord(p));
    check("walk: a refused rename shows the record read back" + at, (await waitText(p, ["The gateway refused the change.", "Now saved: Weekend plans"], "#g-dialog")) && (await text(p, "#title-pill")).includes("Weekend plans"));
    await p.close();
  }
  {
    const p = await o("state=open&fail=lostread");
    await p.click("#title-pill");
    await btn(p, renameWord(p));
    await p.fill("#g-name", "Saturday trail");
    await btn(p, saveWord(p));
    const unconfirmed = await waitText(p, ["Couldn't confirm the change."], "#g-dialog");
    const before = (await journal(p)).recordWrites.length;
    await btn(p, "Check again");
    const saved = await waitText(p, ["Saturday trail"], "#title-pill");
    check("walk: a missing read, then Check again reads without writing" + at, unconfirmed && saved && (await journal(p)).recordWrites.length === before, `${unconfirmed} ${saved}`);
    await p.close();
  }
  {
    const p = await o("state=open");
    await p.click("#title-pill");
    await btn(p, "Add a bot");
    await p.click('[data-add-pick="pip"]');
    await btn(p, "Add");
    check("walk: add a bot" + at, (await members(p, 4)) && (await waitText(p, ["Pip"], "#g-dialog .g-members")));
    await p.close();
  }
  {
    const p = await o("state=open&fail=add");
    await p.click("#title-pill");
    await btn(p, "Add a bot");
    await p.click('[data-add-pick="pip"]');
    await btn(p, "Add");
    const made = await waitText(p, ["Pip's task was made. This group still has Juniper, Otto and Marlow.", "Couldn't confirm the change."], "#g-dialog");
    const w0 = (await journal(p)).recordWrites.length;
    await btn(p, "Check again");
    const read = await waitText(p, ["Pip's task was made. This group still has Juniper, Otto and Marlow.", "Try again"], "#g-dialog");
    const w1 = (await journal(p)).recordWrites.length;
    await btn(p, "Try again");
    const added = await members(p, 4);
    const j = await journal(p);
    const pipCreates = j.taskWrites.filter((w) => w.kind === "create" && w.bot === "pip");
    const lastPip = j.recordWrites.at(-1).next.members.find((x) => x.bot === "pip");
    check("walk: a task made but not added; Check again reads; Try again adds that same task" + at, made && read && w0 === w1 && added && pipCreates.length === 1 && lastPip.sid === pipCreates[0].sid, `${made} ${read} ${w0} ${w1} ${added} ${JSON.stringify(pipCreates)}`);
    await p.close();
  }
  {
    const p = await o("state=five&fail=competingadd");
    await p.click("#title-pill");
    await btn(p, "Add a bot");
    await p.click('[data-add-pick="extra2"]');
    await btn(p, "Add");
    const six = await waitText(p, ["This group still has Juniper, Otto, Marlow, Pip, Ottoline and Basil.", "A group has at most 6 bots."], "#g-dialog");
    check("walk: at six members after another device's add, the stale add is disabled" + at, six && (await p.locator("[data-retry-add]").isDisabled()));
    await p.close();
  }
  {
    const p = await o("state=open");
    await p.click("#title-pill");
    await btn(p, "Remove Marlow");
    await btn(p, "Remove");
    const gone2 = await members(p, 2);
    check("walk: remove a member; its messages leave the column" + at, gone2 && !(await text(p, ".transcript-inner")).includes("borrowing the trailer"));
    await p.close();
  }
  {
    const p = await o("state=open&fail=memberconflict");
    await p.click("#title-pill");
    await btn(p, "Remove Marlow");
    await btn(p, "Remove");
    const conflict = await waitText(p, ["Now saved: Weekend plans, with Juniper, Otto, Marlow and Pip."], "#g-dialog");
    const rail = await members(p, 4);
    await btn(p, "Try again");
    const removed = await members(p, 3);
    check("walk: removing meets a different record; rail and dialog follow the read-back; Try again" + at, conflict && rail && removed, `${conflict} ${rail} ${removed}`);
    await p.close();
  }
  {
    const p = await o("state=open&fail=unconfirmed");
    await p.click("#title-pill");
    await btn(p, "Remove Marlow");
    await btn(p, "Remove");
    const unconfirmed = await waitText(p, ["Couldn't confirm the change."], "#g-dialog");
    const before = (await journal(p)).recordWrites.length;
    await btn(p, "Check again");
    const removed = await members(p, 2);
    check("walk: saved but unconfirmed; Check again reads and writes nothing" + at, unconfirmed && removed && (await journal(p)).recordWrites.length === before && !(await p.locator("#g-dialog").isVisible()), `${unconfirmed} ${removed}`);
    await p.close();
  }
  {
    const p = await o("state=open&fail=competingremove");
    await p.click("#title-pill");
    await btn(p, "Remove Marlow");
    await btn(p, "Remove");
    const read = await waitText(p, ["Now saved: Weekend plans, with Juniper and Marlow.", "A group has at least two bots."], "#g-dialog");
    const choices = (await p.getByRole("button", { name: "Add a bot", exact: true }).count()) === 1 && (await p.getByRole("button", { name: "Remove group…", exact: true }).count()) === 1 && (await p.locator("#g-dialog [data-do-remove]").count()) === 0;
    await btn(p, "Cancel");
    await p.click("#title-pill");
    await p.waitForTimeout(250);
    const details = (await text(p, "#g-dialog")).includes("A group has at least two bots.") && (await p.locator("#g-dialog [data-remove-member]").count()) === 0;
    check("walk: a competing remove leaves two; both entry points offer the same two choices" + at, read && choices && details, `${read} ${choices} ${details}`);
    await p.close();
  }
  {
    const p = await o("state=archived");
    await p.click("#title-pill");
    await btn(p, "Remove Juniper");
    await btn(p, "Remove");
    await members(p, 2);
    const line = await text(p, '[data-member-line="marlow"]');
    check("walk: at two members the member line offers a replacement or removing the group" + at, line.includes("Add a bot") && line.includes("Remove group…") && !line.includes("Remove Marlow"), line);
    await p.close();
  }
  {
    const p = await o("state=running");
    await p.click("#title-pill");
    await btn(p, "Remove Otto");
    await btn(p, "Remove");
    await waitText(p, ["Juniper is working"], "#bot-list");
    check("walk: a removed member leaves the group's Stop and summaries" + at, (await label(p, "[data-stop]")) === "Stop 1 bot" && (await p.locator(".g-status .status-line").count()) === 1);
    await p.close();
  }
  {
    const p = await o("state=offline");
    await p.click("#title-pill");
    await btn(p, "Remove Marlow");
    await btn(p, "Remove");
    await members(p, 2);
    await p.evaluate(() => document.getElementById("g-reconnect").click());
    const ok = await waitText(p, ["Sent to Juniper and Otto · Not sent to Marlow"], ".transcript-inner");
    await p.locator("[data-went]").last().click();
    check("walk: a held copy is checked against the members before it goes" + at, ok && (await waitText(p, ["Marlow is no longer in this group."], ".transcript-inner", 1500)));
    await p.close();
  }
  {
    const p = await o("state=archived");
    await btn(p, "Restore Marlow's task");
    const busy = await waitText(p, ["Restoring Marlow's task…"], ".transcript-inner", 1000);
    check("walk: restore an archived member task, read first" + at, busy && (await gone(p, '[data-member-line="marlow"]')) && (await p.locator(".g-chip[data-skipped]").count()) === 0);
    await p.close();
  }
  {
    const p = await o("state=taskgone");
    await btn(p, "Start a new task for Marlow");
    const busy = await waitText(p, ["Starting a new task for Marlow…"], ".transcript-inner", 1000);
    const done = await gone(p, '[data-member-line="marlow"]');
    const j = await journal(p);
    check("walk: a new task for a member, then the record read back" + at, busy && done && j.taskWrites.some((w) => w.kind === "create" && w.bot === "marlow"));
    await p.close();
  }
  {
    const p = await o("state=botgone");
    await btn(p, "Remove Marlow");
    await has("walk: removing a deleted bot asks first" + at, p, ["Remove Marlow from Weekend plans?", "Marlow was deleted, with its tasks."], "#g-dialog");
    await btn(p, "Remove");
    check("walk: a deleted bot removed from the group" + at, await members(p, 2));
    await p.close();
  }
  {
    const p = await o("state=open");
    await p.click("#title-pill");
    await btn(p, "Remove group…");
    await btn(p, "Remove group");
    const ok = await waitText(p, ["Removed Weekend plans. Juniper's, Otto's and Marlow's tasks stay in their lists."]);
    check("walk: remove the group; the tasks stay" + at, ok && (await p.locator('.bot[data-group="g1"]').count()) === 0 && (await p.locator('.bot[data-group="g2"]').count()) === 1);
    await p.close();
  }
  {
    const p = await o("state=open&fail=remove");
    await p.click("#title-pill");
    await btn(p, "Remove group…");
    await btn(p, "Remove group");
    const unconfirmed = await waitText(p, ["Couldn't confirm the change."], "#g-dialog");
    const before = (await journal(p)).recordWrites.length;
    await btn(p, "Check again");
    const kept = await waitText(p, ["Now saved: Weekend plans, with Juniper, Otto and Marlow."], "#g-dialog");
    const after = (await journal(p)).recordWrites.length;
    await btn(p, "Try again");
    const ok = await waitText(p, ["Removed Weekend plans."]);
    check("walk: removing the group unconfirmed, read back as still saved, then removed" + at, unconfirmed && kept && before === after && ok, `${unconfirmed} ${kept} ${before} ${after} ${ok}`);
    await p.close();
  }
  {
    const p = await o("state=open&fail=gone");
    await p.click("#title-pill");
    await btn(p, "Remove group…");
    await btn(p, "Remove group");
    check("walk: a group already absent is said as no longer saved" + at, await waitText(p, ["This group is no longer saved."]));
    await p.close();
  }
  // History: ties, reload.
  {
    const p = await o("state=tie");
    const arriving = await order(p, ["Second note from Otto.", "A note from Juniper.", "First note from Otto."]);
    await p.evaluate(() => document.getElementById("g-reload").click());
    const [ju, o1, o2] = await order(p, ["A note from Juniper.", "First note from Otto.", "Second note from Otto."]);
    check("walk: rows with one time arrive in any order and settle by member order, then sequence" + at, arriving[0] < arriving[1] && arriving[1] < arriving[2] && ju < o1 && o1 < o2, `${arriving} ${ju} ${o1} ${o2}`);
    await p.close();
  }
  {
    const p = await o("state=partial");
    await p.evaluate(() => document.getElementById("g-reload").click());
    const t = await text(p, ".transcript-inner");
    check("walk: a reload keeps no local sent, held or refusal knowledge" + at, !t.includes("Couldn't send to Marlow") && t.includes("In Juniper's and Otto's task histories"), t.slice(0, 400));
    await p.close();
  }
  {
    const p = await o("state=open");
    if (p.phone) await p.click('[data-action="back"]');
    await p.keyboard.press("Meta+Shift+N");
    check("walk: ⌘⇧N opens New group" + at, await waitText(p, ["New group"], "#g-dialog", 1000));
    await p.close();
  }
  if (W === 390) {
    const p = await o("state=open");
    await p.click("#title-pill");
    await p.waitForTimeout(250);
    const edit = await p.getByRole("button", { name: "Edit", exact: true }).count();
    await btn(p, "Edit");
    check("phone: Edit, Name, Done" + at, edit === 1 && (await p.getByRole("button", { name: "Done", exact: true }).count()) === 1);
    await p.close();
    const q = await o("state=open&view=list");
    const rowVisible = await q.locator('.bot[data-group="g1"]').isVisible();
    await q.click('.bot[data-group="g1"]');
    check("phone: the group is a row of the list and opens full screen" + at, rowVisible && (await q.locator("#g-input").isVisible()));
    await q.close();
  }
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
