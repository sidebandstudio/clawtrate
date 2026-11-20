// Checks for drafts.html: every state of docs/design/drafts-and-vault.md opened
// from the address with its words and structure; every path clicked through to
// its outcome, carrying what the person typed; what the secret field keeps; the
// widths, the themes, the phone; and the gallery and the bar reaching the page.
// Run from the repository root:  node docs/design/prototype/tools/checks/drafts.mjs
import { chromium, pageUrl } from "./browser.mjs";

const b = await chromium.launch();
const out = [];
let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed += 1;
  out.push(`${ok ? "ok  " : "FAIL"} ${name} ${extra}`);
};
const open = async (query, { width = 1440, height = 900, theme = "light", chrome = "0" } = {}) => {
  const p = await b.newPage({ viewport: { width, height } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(`${pageUrl("drafts.html")}?chrome=${chrome}&theme=${theme}&${query}`);
  await p.waitForTimeout(80);
  p.errors = errors;
  return p;
};
const text = (p, sel = "#root") => p.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, " ") || "", sel);
const missing = (t, words) => words.filter((w) => !t.includes(w)).join(" | ");
const absent = (t, words) => words.filter((w) => t.includes(w)).join(" | ");
const click = async (p, selector) => {
  await p.locator(selector).first().click();
  await p.waitForTimeout(60);
};
const waitText = async (p, words, timeout = 4000) => {
  try {
    await p.waitForFunction((ws) => ws.every((w) => document.getElementById("root").textContent.replace(/\s+/g, " ").includes(w)), words, { timeout });
    return true;
  } catch {
    return false;
  }
};
const bar = (p, key, value) => p.selectOption(`[data-proto="${key}"]`, value);

process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

const PROPOSED = "Draft examples use a proposed plugin (#89) and stand-in tools.";
const PLAIN = "The gateway keeps this value in its state database on its own machine and doesn't encrypt it there.";

// Part 1: every state from the address, with its words ------------------------------------------
const states = [
  ["view=draft", [PROPOSED, "New email", "Ready to send", "Otto wants to send this from its email tool, mail_send.", "otto@example.com", "dana@example.com", "lee@example.org", "Media box report", "report.txt", "Checked when Otto asked, 5:42 PM. Will be checked again after your first answer.", "Send email", "Edit", "Discard", "Show full request", "Disable drafts for Otto", "Held by Clawtrate's drafts plugin. It waits up to 10 minutes.", "Raw", "Show more"]],
  ["view=draft&d=full", ["Hide full request", "mail_send", "5:42 PM, expires 5:52 PM", "Clawtrate's drafts plugin"]],
  ["view=draft&d=raw", ["plugin.approval.requested", "toolCallId", "the bot's call (tool start)", "clawtrate-drafts.get (proposed)", "Hide Raw"]],
  ["view=draft&d=sending", ["Sending your decision…", "Discard"]],
  ["view=draft&d=sent", ["Answered", "Sent from otto@example.com to dana@example.com, cc lee@example.org, with report.txt (28 bytes), at 5:43 PM. Read back from the email tool's result."]],
  ["view=draft&d=sentnoreport", ["Answered", "The email tool reported success at 5:43 PM. It doesn't say what it sent; this is what you approved."]],
  ["view=draft&d=toolfailed", ["Tool failed", "Tool failed. Sending could not be confirmed."]],
  ["view=draft&d=discarded", ["Discarded at 5:43 PM. Nothing was sent. Otto was told you discarded it."]],
  ["view=draft&d=refused", ["The gateway refused this decision", "The draft is still waiting.", "Try again", "Discard"]],
  ["view=draft&d=noanswer", ["No answer from the gateway. Your decision may or may not have been applied.", "Check again", "Discard"]],
  ["view=draft&d=stillwaiting", ["Your decision wasn't applied. The draft is still waiting.", "Send email"]],
  ["view=draft&d=unknown", ["Couldn't confirm what happened. The gateway no longer lists this draft, and Otto's email tool hasn't reported back.", "Check again"]],
  ["view=draft&d=already", ["Already answered on another device at 5:25 PM. Your decision was not applied."]],
  ["view=draft&d=expired", ["Expired at 5:52 PM without an answer. Nothing was sent."]],
  ["view=draft&d=closed", ["The run ended before this was answered. Nothing was sent."]],
  ["view=draft&d=cancelled", ["You stopped the run before answering. Nothing was sent."]],
  ["view=draft&d=runended", ["Otto's run ended. Couldn't confirm whether this was sent."]],
  ["view=draft&d=restartunknown", ["The gateway restarted. Couldn't confirm whether this was sent."]],
  ["view=draft&d=filechanged", ["Not sent", "report.txt changed after Otto asked (28 bytes then, 44 now), so nothing was sent. Otto was told why. If it asks again, the new draft appears below."]],
  ["view=draft&d=unchecked", ["Couldn't check report.txt: the plugin couldn't read it. If it changes before it's sent, Clawtrate can't tell.", "Send email"]],
  ["view=draft&d=norecord", ["Couldn't read this draft. The gateway still lists it as waiting.", "Check again", "Discard"]],
  ["view=draft&d=edit", ["Your edit goes to Clawtrate's drafts plugin, for this draft only. Sending it releases Otto's email to the plugin, which swaps in your edit. The gateway then asks once more, for the edited email, and that answer sends it.", "From and the attachments stay as Otto set them.", "Send edited email", "Cancel edit", "Discard"]],
  ["view=draft&d=editsaving", ["Giving your edit to the drafts plugin…"]],
  ["view=draft&d=editfailed", ["This draft was already edited on another device."]],
  ["view=draft&d=editunconfirmed", ["Couldn't confirm the edit. Check the draft's current state.", "Check the draft"]],
  ["view=draft&d=editwaiting", ["Waiting for the gateway to ask again for the edited email.", "Edited email"]],
  ["view=draft&d=edited", ["Edited email", "You edited Otto's email. This is what will be sent.", "Show Otto's version", "dana@example.com, sam@example.net", "Media box report: disk at 91%", "Edited", "Checked after the first answer. The file can still change while this draft waits.", "Send edited email", "The gateway asks again because you edited it. This answer sends it."]],
  ["view=draft&d=elsewhere", ["Edited on another device at 5:44 PM.", "Send edited email"]],
  ["view=draft&d=editsent", ["Answered", "Sent from otto@example.com to dana@example.com, sam@example.net", "You edited this before it was sent.", "Otto used mail_send", "Edited before sending: To, Subject, Body. What was sent is on the draft card."]],
  ["view=draft&d=editsent&p=unchecked", ["Clawtrate can't tell whether this was edited: it couldn't read the drafts plugin's record."]],
  ["view=draft&d=editdiscarded", ["Discarded at 5:44 PM. Nothing was sent. Your edit wasn't used."]],
  ["view=draft&d=editexpired", ["Expired at 5:54 PM without an answer. Nothing was sent. Your edit wasn't used."]],
  ["view=draft&d=editrestart", ["The gateway restarted before this was sent. Nothing was sent, and your edit wasn't used."]],
  ["view=draft&d=disable", ["Send Otto's emails and messages without drafts?", "They'll go under Otto's rules", "The gateway's automatic reviewer covers commands, not sends; a send can still meet an Ask or a Never rule.", "it holds only while the plugin runs.", "Send without drafts"]],
  ["view=draft&d=disabled", ["Drafts off for Otto. This draft is still waiting for you."]],
  ["view=draft&d=disableunknown", ["Couldn't confirm the setting. Read it again.", "Read again"]],
  ["view=draft&kind=slack", ["Slack message", "Otto wants to post this with its Slack tool, slack_post.", "Workspace", "Example Co", "#ops", "Thread", "Disk alerts", "Send message"]],
  ["view=draft&kind=slack&d=sent", ["Posted to #ops in Example Co, in the thread Disk alerts, at 5:43 PM. Read back from the message tool's result."]],
  ["view=draft&access=read", ["Read-only.", "Request approvals access to see drafts", "Request approvals access"]],
  ["view=draft&access=read&req=requested", ["Waiting for the gateway's owner.", "openclaw devices approve"]],
  ["view=draft&p=unchecked", ["Clawtrate couldn't check the drafts plugin. Drafts may be unavailable.", "Send email"]],
  ["view=draft&p=absent", ["Drafts methods unavailable on this gateway."]],
  ["view=draft&p=old&d=sent", ["Clawtrate's drafts plugin is version 0.9; drafts need 1.0 or newer.", "Answered", "Sent from otto@example.com"]],
  ["view=draft&p=old&d=norecord", ["Clawtrate's drafts plugin is version 0.9; drafts need 1.0 or newer.", "Couldn't read this draft. The gateway still lists it as waiting."]],
  ["view=draft&d=stillon", ["Drafts on for Otto. This draft is still waiting for you."]],
  ["view=draft&p=old", ["Clawtrate's drafts plugin is version 0.9; drafts need 1.0 or newer."]],
  ["view=secret", ["Otto asks for a secret", "PRICE_TRACKER_KEY", "To read prices from the store's API for your tracker.", "Saving sends the value to the gateway's store. The answer the bot gets contains a reference and status. Saving replaces any value already stored under this name.", "Allowed hosts", "api.example.com", "When the gateway's egress proxy is enabled, it can substitute the value in supported requests to these hosts. Settings can use the reference separately.", "Secret value", PLAIN, "Save to the gateway", "Skip", "About filling this field", "Raw"]],
  ["view=secret&s=hosts", ["api.example.com", "api.example.net"]],
  ["view=secret&s=exists", ["STORE_API_KEY", "This replaces the value saved as STORE_API_KEY on Nov 19."]],
  ["view=secret&s=saving", ["Saving…"]],
  ["view=secret&s=saved", ["Saved to your gateway as PRICE_TRACKER_KEY.", "Hosts reported by the bot's tool after saving: api.example.com."]],
  ["view=secret&s=savedrefresh", ["Saved to the Vault. The gateway couldn't refresh settings that use it."]],
  ["view=secret&s=refused", ["The gateway didn't save it: an allowed host isn't a valid hostname. Correct it and type the value again."]],
  ["view=secret&s=unattributed", ["The gateway records this question as answered. Clawtrate couldn't confirm which value was saved."]],
  ["view=secret&s=unconfirmed", ["Couldn't confirm whether the gateway saved it.", "Check"]],
  ["view=secret&s=already", ["Already answered on another device."]],
  ["view=secret&s=skipped", ["Skipped. Otto was told no secret arrived."]],
  ["view=secret&s=expired", ["Expired without an answer. Otto was told no secret arrived."]],
  ["view=secret&s=raw", ["question.requested", "(not kept by Clawtrate)", "secretStoreAllowedHosts"]],
  ["view=secret&s=omitted", ["Current hosts unavailable: the list was too long for the bot's tool to report."]],
  ["view=secret&s=missing", ["Current hosts unavailable: the entry wasn't listed when the bot's tool looked."]],
  ["view=secret&s=kindchanged", ["Current hosts unavailable: the entry is now an environment value."]],
  ["view=secret&s=hostsunavailable", ["Current hosts unavailable."]],
  ["view=secret&s=cannotask&access=interactive", ["missing scope: operator.questions", "Inferred: the gateway lets a bot ask for a secret only in a run started from a connection with admin access."]],
  ["view=secret&access=read", ["Request questions access to see questions", "Request questions access"]],
  ["view=vault", ["Values this gateway keeps for its bots and settings. Protected values are never listed. Environment values are returned to callers that can list them, and supplied to commands.", "New item", "BUILD_REGION", "Environment value", "MEDIA_BOX_TOKEN", "STORE_API_KEY", "Protected", "Where a bot's secrets come from", "Protected values aren't listed to bots or to Clawtrate.", "the value is given to the bot, which can see it.", "Nothing on the gateway makes a bot try these in an order."]],
  ["view=vault&v=empty", ["No secrets yet."]],
  ["view=vault&v=error", ["Couldn't read the Vault.", "Try again"]],
  ["view=vault&v=item", ["store · default · STORE_API_KEY", PLAIN, "How it can be used.", "Settings can use this value through its reference. When the gateway's egress proxy is enabled, it can substitute the value in supported requests to these hosts from commands on the gateway's machine.", "The gateway doesn't limit an item to chosen bots.", "Offered the Secrets tool: Otto, Pip and Marlow", "Replace…", "Remove…"]],
  ["view=vault&v=envitem", ["BUILD_REGION", "Environment value", "The gateway returns this value to callers that can list it, and supplies it to commands.", "Clawtrate does not show it.", "The bot's Secrets tool can list this value."]],
  ["view=vault&v=new", ["New item", "Kind", "Protected", "Environment value", "Secret value", PLAIN, "Allowed hosts", "Save"]],
  ["view=vault&v=newenv", ["Environment value", "The gateway returns this value to callers that can list it, and supplies it to commands."]],
  ["view=vault&v=replace", ["Replace STORE_API_KEY", "STORE_API_KEY exists. Saving replaces its value and hosts.", PLAIN]],
  ["view=vault&v=saved", ["Saved in the Vault."]],
  ["view=vault&v=savedrefresh", ["Saved in the Vault. The gateway couldn't refresh settings that use it."]],
  ["view=vault&v=listedonly", ["This name and its settings are listed. Clawtrate couldn't confirm which value was saved."]],
  ["view=vault&v=notlisted", ["Couldn't confirm the save. The name isn't listed."]],
  ["view=vault&v=listedother", ["The name is listed with different settings. Clawtrate couldn't confirm the save."]],
  ["view=vault&v=saveunread", ["Couldn't confirm the save. The Vault couldn't be read."]],
  ["view=vault&v=failed", ["Couldn't save"]],
  ["view=vault&v=remove", ["Remove STORE_API_KEY?", "These settings refer to this name: plugins.entries.price-tracker.config.apiKey. A running process may still have the value.", "Removal leaves the value in the database. The gateway's cleanup can purge the deleted row after 30 days."]],
  ["view=vault&v=removed", ["Removed from the Vault."]],
  ["view=vault&v=removedrefresh", ["Removed from the Vault. The gateway couldn't refresh settings that used it."]],
  ["view=vault&v=stilllisted", ["STORE_API_KEY is still listed."]],
  ["view=vault&v=removednoreply", ["STORE_API_KEY is no longer listed in the Vault."]],
  ["view=vault&v=removeunknown", ["Couldn't confirm the removal. The Vault couldn't be read.", "Check"]],
  ["view=vault&access=interactive", ["Seeing the Vault needs admin access. The gateway shows its secret store to admin connections only.", "Request admin access"]],
  ["view=vault&access=read&req=denied", ["The request was denied."]],
  ["view=drafts", [PROPOSED, "Drafts plugin answered at 5:46 PM.", "the gateway's automatic reviewer covers commands, not sends.", "Sending tools", "mail_send", "slack_post", "Destination as given, from target, targets, accountId, replyTo and threadId; Clawtrate can't name it."]],
  ["view=drafts&p=unchecked", ["Clawtrate couldn't check the drafts plugin. Drafts may be unavailable.", "Unknown"]],
  ["view=drafts&p=absent", ["Drafts methods unavailable on this gateway."]],
  ["view=drafts&p=old", ["Clawtrate's drafts plugin is version 0.9; drafts need 1.0 or newer."]],
  ["view=drafts&access=interactive", ["Changing drafts needs admin access."]],
];
for (const [query, words] of states) {
  const p = await open(query);
  const t = await text(p, "body");
  check(`${query}: its words`, !missing(t, words) && p.errors.length === 0, missing(t, words) || p.errors.join(" "));
  await p.close();
}

// Structure ----------------------------------------------------------------------------------------
let p = await open("view=draft");
check("the draft card is a region named for its recipient", (await p.getAttribute('[data-testid="draft"]', "aria-label")) === "New email to dana@example.com. Ready to send.");
check("Discard is the last button of the card", await p.evaluate(() => [...document.querySelectorAll('[data-testid="draft"] .request-actions .button')].pop().textContent === "Discard"));
await p.close();
for (const q of ["view=draft&access=read", "view=secret&access=read"]) {
  p = await open(q);
  check(`${q}: no card is drawn, only the request`, (await p.locator('[data-testid="draft"], [data-testid="secret"], [data-testid="draft-resolved"]').count()) === 0 && (await p.locator(".access-bar").count()) === 1);
  await p.close();
}
p = await open("view=draft&access=interactive");
check("below admin there is no Disable drafts link", !(await text(p)).includes("Disable drafts for Otto"));
await p.close();
p = await open("view=draft&d=norecord");
check("no record: Send is never offered", (await p.locator('[data-d="send"]').count()) === 0);
await p.close();
p = await open("view=draft&d=editwaiting");
check("before the newer approval is seen, no Send and no Discard: neither hold is pending", (await p.locator('[data-d="send"], [data-d="discard"]').count()) === 0);
await p.close();
p = await open("view=draft&d=editunconfirmed");
check("an unconfirmed edit offers no Try again, only Check", (await p.locator('[data-d="edit-send"]').count()) === 0 && (await p.locator('[data-d="edit-check"]').count()) === 1);
await p.close();
p = await open("view=draft&d=runended");
check("a run known to be over shows no actions", (await p.locator('[data-d="send"], [data-d="discard"]').count()) === 0);
await p.close();
p = await open("view=secret");
const attrs = await p.evaluate(() => {
  const f = document.getElementById("secret-value");
  return [f.type, f.getAttribute("autocomplete"), f.getAttribute("spellcheck"), f.getAttribute("autocapitalize"), f.labels[0]?.textContent];
});
check("the Secure Form's field: password, no autocomplete, no spelling, no capitals, labelled", JSON.stringify(attrs) === JSON.stringify(["password", "off", "false", "off", "Secret value"]), JSON.stringify(attrs));
check("the plain-storage notice describes the field, before submission", (await p.evaluate(() => document.getElementById(document.getElementById("secret-value").getAttribute("aria-describedby"))?.textContent)) === PLAIN);
await p.close();
for (const q of ["view=vault&v=new", "view=vault&v=replace"]) {
  p = await open(q);
  check(`${q}: the plain-storage notice sits beside the field`, (await p.evaluate(() => document.getElementById(document.getElementById("secret-value").getAttribute("aria-describedby"))?.textContent)).startsWith(PLAIN));
  await p.close();
}
p = await open("view=vault&v=newenv");
check("an environment value has no hosts field, and its field says so", !(await text(p)).includes("Allowed hosts") && (await p.evaluate(() => document.getElementById("secret-value").labels[0].textContent)) === "Environment value");
await p.close();
p = await open("view=vault&v=remove");
check("removing asks in an alert dialog", (await p.getAttribute('[data-testid="remove-dialog"]', "role")) === "alertdialog");
await p.close();

// Part 2: every path, clicked to its outcome ---------------------------------------------------------
async function walk(name, query, steps, words, opts = {}) {
  const pg = await open(query, { chrome: "1", ...opts });
  for (const step of steps) await step(pg);
  const ok = await waitText(pg, words);
  check(`walk: ${name}`, ok && pg.errors.length === 0, ok ? pg.errors.join(" ") : missing(await text(pg), words));
  return pg;
}
const tap = (sel) => (pg) => click(pg, sel);
const answer = (v) => (pg) => bar(pg, "answer", v);
const pause = (ms) => (pg) => pg.waitForTimeout(ms);

(await walk("Send email → Answered, read back", "view=draft", [tap('[data-d="send"]')], ["Answered", "Read back from the email tool's result."])).close();
(await walk("Send: the tool says nothing", "view=draft", [(pg) => bar(pg, "tool", "silent"), tap('[data-d="send"]')], ["It doesn't say what it sent; this is what you approved."])).close();
(await walk("Send: the tool fails → not confirmed", "view=draft", [(pg) => bar(pg, "tool", "fails"), tap('[data-d="send"]')], ["Tool failed. Sending could not be confirmed."])).close();
(await walk("Discard → Discarded", "view=draft", [tap('[data-d="discard"]')], ["Discarded at 5:43 PM. Nothing was sent."])).close();
(await walk("Send, refused → Try again → Answered", "view=draft", [answer("refused"), tap('[data-d="send"]'), pause(700), answer("applied"), tap('[data-d="send"]')], ["Answered"])).close();
for (const [finds, words] of [
  ["waiting", ["Your decision wasn't applied. The draft is still waiting."]],
  ["expired", ["Expired at 5:52 PM without an answer."]],
  ["refused", ["The gateway refused this decision"]],
  ["unknown", ["Couldn't confirm what happened."]],
  ["confirmed", ["Answered"]],
])
  (await walk(`No answer → Check again finds ${finds}`, "view=draft", [answer("noanswer"), (pg) => bar(pg, "checkfinds", finds), tap('[data-d="send"]'), pause(700), tap('[data-d="check"]')], words)).close();
(await walk("Send, already answered elsewhere", "view=draft", [answer("already"), tap('[data-d="send"]')], ["Already answered on another device at 5:25 PM."])).close();
(await walk("A file changes while waiting → Send → Not sent", "view=draft", [tap('[data-proto-event="file"]'), tap('[data-d="send"]')], ["Not sent", "report.txt changed after Otto asked"])).close();
(await walk("Raw opens drawn, and closes", "view=draft", [tap('[data-d="raw"]')], ["plugin.approval.requested", "Hide Raw"])).close();
(await walk("No record → Check again", "view=draft&d=norecord", [tap('[data-d="check-record"]')], ["Send email"])).close();

// What the person types is carried through both holds and a retry.
const TYPED = {
  to: "dana@example.com, ren@example.net",
  subject: "Disk at 91%, logs archived",
  body: "Hi Dana and Ren,\n\nTwo  spaces  stay.\nLast line.",
};
async function typeEmail(pg) {
  await click(pg, '[data-d="edit"]');
  await pg.fill("#e-to", TYPED.to);
  await pg.fill("#e-subject", TYPED.subject);
  await pg.fill("#e-body", TYPED.body);
}
const bodyText = (pg) => pg.evaluate(() => document.querySelector('[data-testid="draft"] [data-testid="body"], [data-testid="draft-resolved"] [data-testid="body"]')?.firstChild?.textContent ?? "");
p = await open("view=draft", { chrome: "1" });
await typeEmail(p);
await click(p, '[data-d="edit-send"]');
check("walk: the edit is taken and the second hold shows what was typed", await waitText(p, ["Edited email", "dana@example.com, ren@example.net", TYPED.subject], 5000));
check("walk: the body keeps its doubled spaces and line breaks", (await bodyText(p)) === TYPED.body, JSON.stringify(await bodyText(p)));
check("walk: the second hold's file line says the file can still change", (await text(p)).includes("Checked after the first answer. The file can still change while this draft waits."));
await click(p, '[data-d="show-original"]');
check("walk: Show Otto's version opens the bot's own version", (await p.locator('[data-testid="original"]').count()) === 1);
await click(p, '[data-d="send"]');
check("walk: the second answer sends what was typed, read back", await waitText(p, ["Sent from otto@example.com to dana@example.com, ren@example.net", "You edited this before it was sent.", "Edited before sending: To, Subject, Body."]));
check("walk: the sent body is exactly what was typed", (await bodyText(p)) === TYPED.body);
await p.close();
p = await open("view=draft", { chrome: "1" });
await bar(p, "answer", "noanswer");
await typeEmail(p);
await click(p, '[data-d="edit-send"]');
await waitText(p, ["Couldn't confirm the edit. Check the draft's current state."]);
check("walk: an unconfirmed edit keeps every typed field", (await p.inputValue("#e-to")) === TYPED.to && (await p.inputValue("#e-subject")) === TYPED.subject && (await p.inputValue("#e-body")) === TYPED.body);
await bar(p, "checkfinds", "unknown");
await click(p, '[data-d="edit-check"]');
check("walk: a Check that doesn't find the first hold waiting keeps the edit unconfirmed", (await waitText(p, ["Couldn't confirm the edit."])) && (await p.locator('[data-d="edit-send"]').count()) === 0);
await bar(p, "checkfinds", "waiting");
await click(p, '[data-d="edit-check"]');
check("walk: Check finding the first hold waiting returns to the fields with what was typed", (await p.inputValue("#e-to")) === TYPED.to && (await p.inputValue("#e-subject")) === TYPED.subject && (await p.inputValue("#e-body")) === TYPED.body);
await bar(p, "answer", "applied");
await click(p, '[data-d="edit-send"]');
check("walk: sending again after Check carries the same edit to the second hold", (await waitText(p, ["Edited email", TYPED.subject], 5000)) && (await bodyText(p)) === TYPED.body);
await p.close();
p = await open("view=draft", { chrome: "1" });
await bar(p, "tool", "silent");
await typeEmail(p);
await click(p, '[data-d="edit-send"]');
await waitText(p, ["Edited email"], 5000);
await click(p, '[data-d="send"]');
check("walk: an edited send whose tool says nothing doesn't claim a report", await waitText(p, ["It doesn't say what it sent; this is what you approved."]));
await p.close();
const SLACK_TYPED = { to: "#ops-oncall", text: "Disk at 91%.\n\nLogs  moved  to archive/." };
p = await open("view=draft&kind=slack", { chrome: "1" });
await click(p, '[data-d="edit"]');
await p.fill("#e-to", SLACK_TYPED.to);
await p.fill("#e-body", SLACK_TYPED.text);
await click(p, '[data-d="edit-send"]');
check("walk: Slack: the second hold shows the new destination and message", (await waitText(p, ["Edited Slack message", "#ops-oncall"], 5000)) && (await bodyText(p)) === SLACK_TYPED.text);
await click(p, '[data-d="send"]');
check("walk: Slack: what was typed is posted", (await waitText(p, ["Posted to #ops-oncall in Example Co"])) && (await bodyText(p)) === SLACK_TYPED.text);
await p.close();
(await walk("Edit, already edited elsewhere", "view=draft", [answer("already"), tap('[data-d="edit"]'), tap('[data-d="edit-send"]')], ["This draft was already edited on another device."])).close();
(await walk("Edit → Cancel edit", "view=draft", [tap('[data-d="edit"]'), tap('[data-d="edit-cancel"]')], ["Send email", "Edit"])).close();
(await walk("Edit → second hold → Discard", "view=draft", [tap('[data-d="edit"]'), tap('[data-d="edit-send"]'), pause(1700), tap('[data-d="discard"]')], ["Discarded at 5:44 PM. Nothing was sent. Your edit wasn't used."])).close();
(await walk("Edit → second hold expires", "view=draft", [tap('[data-d="edit"]'), tap('[data-d="edit-send"]'), pause(1700), tap('[data-proto-event="expire"]')], ["Expired at 5:54 PM without an answer. Nothing was sent. Your edit wasn't used."])).close();
(await walk("Edit → the gateway restarts", "view=draft", [tap('[data-d="edit"]'), tap('[data-d="edit-send"]'), pause(1700), tap('[data-proto-event="restart"]')], ["The gateway restarted before this was sent. Nothing was sent, and your edit wasn't used."])).close();
(await walk("Edit → the run is stopped", "view=draft", [tap('[data-d="edit"]'), tap('[data-d="edit-send"]'), pause(1700), tap('[data-proto-event="stop"]')], ["Otto's run ended. Couldn't confirm whether this was sent."])).close();
(await walk("Run ends with no recorded outcome → couldn't confirm", "view=draft", [tap('[data-proto-event="close"]')], ["Otto's run ended. Couldn't confirm whether this was sent."])).close();
(await walk("A bare restart → couldn't confirm", "view=draft", [tap('[data-proto-event="restart"]')], ["The gateway restarted. Couldn't confirm whether this was sent."])).close();
for (const ev of ["close", "stop", "restart"]) {
  p = await open("view=draft", { chrome: "1" });
  await click(p, '[data-d="send"]');
  await waitText(p, ["Answered"]);
  await click(p, `[data-proto-event="${ev}"]`);
  const t = await text(p);
  check(`a confirmed send keeps Sent after the bar's ${ev} event`, t.includes("Answered") && t.includes("Sent from otto@example.com") && !t.includes("Couldn't confirm whether this was sent"));
  await p.close();
}
(await walk("Edit, a file changed before the second hold", "view=draft", [tap('[data-proto-event="file"]'), tap('[data-d="edit"]'), tap('[data-d="edit-send"]'), pause(1200)], ["report.txt changed after Otto asked", "Your edit wasn't used."])).close();
p = await walk("Edited elsewhere → Send, once, on its second hold", "view=draft&d=elsewhere", [tap('[data-d="send"]')], ["Answered", "You edited this before it was sent."]);
check("walk: the edited-elsewhere send asks no third time", (await p.locator('[data-testid="draft"]').count()) === 0);
await p.close();
p = await walk("Edit → a file changes during the second hold → Send", "view=draft", [tap('[data-d="edit"]'), tap('[data-d="edit-send"]'), pause(1700), tap('[data-proto-event="file"]'), tap('[data-d="send"]')], ["Answered"]);
check("walk: a file changed during the second hold is not vetoed by the plugin", !(await text(p)).includes("report.txt changed after Otto asked") && !(await text(p)).includes("Not sent"));
await p.close();
(await walk("Disable drafts → off, this draft still waits", "view=draft", [tap('[data-d="disable"]'), tap('[data-d="disable-yes"]')], ["Drafts off for Otto. This draft is still waiting for you."])).close();
p = await walk("Disable drafts, refused → unknown → Read again still fails", "view=draft", [answer("refused"), tap('[data-d="disable"]'), tap('[data-d="disable-yes"]'), pause(500), tap('[data-d="disable-read"]')], ["Couldn't confirm the setting. Read it again."]);
check("walk: a failed read says neither on nor off", !(await text(p)).includes("Drafts off for Otto") && !(await text(p)).includes("Drafts on for Otto"));
await bar(p, "answer", "applied");
await click(p, '[data-d="disable-read"]');
check("walk: a read that answers shows the value it read: On", await waitText(p, ["Drafts on for Otto. This draft is still waiting for you."]));
await p.close();
for (const q of ["view=draft&p=absent", "view=draft&p=old"]) {
  p = await open(q);
  check(`${q}: a status supplies no send history`, !(await text(p)).includes("It wasn't held as a draft") && (await p.locator('[data-testid="draft"], [data-testid="draft-resolved"]').count()) === 0);
  await p.close();
}
p = await open("view=drafts&p=unchecked");
check("Settings, Drafts: without the plugin's settings read no sending tools are listed", !(await text(p)).includes("Sending tools") && !(await text(p)).includes("mail_send"));
await p.close();
(await walk("Read-only: Request approvals access → waiting", "view=draft&access=read", [tap('[data-d="request"]')], ["Waiting for the gateway's owner."])).close();
p = await open("view=draft", { chrome: "1" });
await p.locator('[data-d="edit"]').focus();
await p.keyboard.press("Meta+Enter");
check("⌘↵ in the card sends", await waitText(p, ["Answered"]));
await p.close();

// The secret
const VALUE = "example-marker-value-check";
async function secretWalk(name, choice, words, after) {
  const pg = await open("view=secret", { chrome: "1" });
  await bar(pg, "secretsave", choice);
  await pg.fill("#secret-value", VALUE);
  await click(pg, '[data-d="s-save"]');
  const ok = await waitText(pg, words);
  check(`walk: secret: ${name}`, ok, ok ? "" : missing(await text(pg), words));
  check(`walk: secret: ${name}: the marker is nowhere on the page`, await pg.evaluate((v) => !document.documentElement.outerHTML.includes(v) && ![...document.querySelectorAll("input")].some((i) => i.value === v), VALUE));
  if (after) await after(pg);
  await pg.close();
}
await secretWalk("stored → Saved, hosts reported", "stored", ["Saved to your gateway as PRICE_TRACKER_KEY.", "Hosts reported by the bot's tool after saving: api.example.com."]);
await secretWalk("stored, refresh failed → saved, no new entry", "refresh", ["Saved to the Vault. The gateway couldn't refresh settings that use it."], async (pg) =>
  check("walk: secret: a refresh failure offers no new value", (await pg.locator("#secret-value").count()) === 0),
);
await secretWalk("not stored → the field again", "notstored", ["The gateway didn't save it"], async (pg) => check("walk: secret: not stored offers an empty field", (await pg.inputValue("#secret-value")) === ""));
await secretWalk("unclear → Check finds answered", "unclear", ["Couldn't confirm whether the gateway saved it."], async (pg) => {
  await click(pg, '[data-d="s-check"]');
  check(
    "walk: secret: Check finding the question answered after a lost reply doesn't credit this submission",
    (await waitText(pg, ["The gateway records this question as answered. Clawtrate couldn't confirm which value was saved."])) && !(await text(pg)).includes("Saved to"),
  );
});
await secretWalk("unclear → Check finds pending", "unclear-pending", ["Couldn't confirm whether the gateway saved it."], async (pg) => {
  await click(pg, '[data-d="s-check"]');
  check(
    "walk: secret: Check finding the question pending after an unclear reply keeps Check and offers no field",
    (await waitText(pg, ["Couldn't confirm whether the gateway saved it."])) && (await pg.locator('[data-d="s-check"]').count()) === 1 && (await pg.locator("#secret-value").count()) === 0 && !(await text(pg)).includes("Saved to"),
  );
});
p = await open("view=secret&s=exists&access=interactive");
check(
  "secret: at the interactive tier the replaced value's date is hidden",
  !(await text(p)).includes("on Nov 19") && (await text(p)).includes("Saving replaces any value already stored under this name."),
);
await p.close();
p = await open("view=secret&s=exists", { chrome: "1" });
check("secret: the replacement names STORE_API_KEY before saving", (await text(p)).includes("STORE_API_KEY") && !(await text(p)).includes("PRICE_TRACKER_KEY"));
await p.fill("#secret-value", VALUE);
await click(p, '[data-d="s-save"]');
check("walk: secret: an acknowledged replacement still names STORE_API_KEY", (await waitText(p, ["Saved to your gateway as STORE_API_KEY."])) && !(await text(p)).includes("PRICE_TRACKER_KEY"));
await p.close();
p = await open("view=secret", { chrome: "1" });
await click(p, '[data-host="api.example.com"]');
await p.fill("#add-host", "prices.example.net");
await p.press("#add-host", "Enter");
await p.waitForTimeout(60);
await p.fill("#secret-value", VALUE);
await click(p, '[data-d="s-save"]');
check(
  "walk: secret: the reported hosts are the tool result's, not the submitted chips",
  (await waitText(p, ["Hosts reported by the bot's tool after saving: api.example.com."])) && !(await text(p, '[data-testid="hosts-back"]')).includes("prices.example.net"),
);
await p.close();
for (const [rep, words] of [
  ["omitted", "the list was too long"],
  ["missing", "the entry wasn't listed"],
  ["kind_changed", "now an environment value"],
  ["unavailable", "Current hosts unavailable."],
]) {
  const pg = await open("view=secret", { chrome: "1" });
  await bar(pg, "hostsrep", rep);
  await pg.fill("#secret-value", VALUE);
  await click(pg, '[data-d="s-save"]');
  check(`walk: secret: hosts reported as ${rep}`, await waitText(pg, [words]));
  await pg.close();
}
(await walk("Secret: Skip", "view=secret", [tap('[data-d="s-skip"]')], ["Skipped. Otto was told no secret arrived."])).close();
(await walk("Secret: remove the only host", "view=secret", [tap('[data-host="api.example.com"]')], ["No hosts: the egress proxy won't substitute this value in any request."])).close();
(await walk("Secret: Raw opens, with no value", "view=secret", [tap('[data-d="raw"]')], ["(not kept by Clawtrate)"])).close();
p = await open("view=secret", { chrome: "1" });
await p.fill("#secret-value", VALUE);
await p.press("#secret-value", "Escape");
check("Escape clears the field and does not skip", (await p.inputValue("#secret-value")) === "" && (await text(p)).includes("Save to the gateway"));
await p.fill("#secret-value", VALUE);
await click(p, '[data-d="reveal"]');
check("Show reveals the typed value", (await p.getAttribute("#secret-value", "type")) === "text");
await p.press("#secret-value", "a");
check("the next keystroke hides it again", (await p.getAttribute("#secret-value", "type")) === "password");
await p.close();

// The Vault
async function vaultSave(name, choice, words, opts = {}) {
  const pg = await open(opts.query || "view=vault", { chrome: "1" });
  await bar(pg, "vanswer", choice);
  await click(pg, opts.replace ? '[data-d="v-replace"]' : '[data-d="v-new"]');
  if (!opts.replace) await pg.fill("#v-name", "PRICE_TRACKER_KEY");
  await pg.fill("#secret-value", VALUE);
  await click(pg, '[data-d="v-save"]');
  const ok = await waitText(pg, words);
  check(`walk: Vault: ${name}`, ok, ok ? "" : missing(await text(pg), words));
  check(`walk: Vault: ${name}: the marker is nowhere on the page`, await pg.evaluate((v) => !document.documentElement.outerHTML.includes(v), VALUE));
  await pg.close();
}
await vaultSave("acknowledged → Saved in the Vault", "ack", ["Saved in the Vault.", "PRICE_TRACKER_KEY"]);
await vaultSave("saved, refresh failed", "refresh", ["Saved in the Vault. The gateway couldn't refresh settings that use it."]);
await vaultSave("lost answer, listed → value not confirmed", "lostlisted", ["This name and its settings are listed. Clawtrate couldn't confirm which value was saved."]);
await vaultSave("lost answer, not listed", "lostnot", ["Couldn't confirm the save. The name isn't listed."]);
await vaultSave("lost answer, listed with other settings", "lostother", ["The name is listed with different settings. Clawtrate couldn't confirm the save."]);
await vaultSave("lost answer, the Vault unreadable", "lostunread", ["Couldn't confirm the save. The Vault couldn't be read."]);
await vaultSave("refused", "refused", ["Couldn't save"]);
p = await open("view=vault&v=envitem");
check("an environment value's page has no egress sentence", !(await text(p)).includes("egress proxy"));
await p.close();
p = await open("view=vault&v=item");
check("a protected value's page keeps the egress sentence and the Secrets tool's reach", (await text(p)).includes("When the gateway's egress proxy is enabled") && (await text(p)).includes("The bot's Secrets tool lists the name and can remove the entry where the gateway grants it access."));
await p.close();
p = await open("view=vault", { chrome: "1" });
await click(p, '[data-d="v-new"]');
await p.fill("#v-name", "PRICE_TRACKER_KEY");
await p.fill("#secret-value", VALUE);
await click(p, '[data-d="v-save"]');
await waitText(p, ["Saved in the Vault."]);
await click(p, '[data-item="PRICE_TRACKER_KEY"]');
check(
  "walk: Vault: the newly saved name opens its own item page",
  (await text(p)).includes("store · default · PRICE_TRACKER_KEY") && !(await text(p)).includes("STORE_API_KEY"),
);
await p.close();
await vaultSave("Replace → Saved in the Vault", "ack", ["Saved in the Vault.", "STORE_API_KEY"], { query: "view=vault&v=item", replace: true });
p = await walk("Vault: a bad name is refused", "view=vault", [tap('[data-d="v-new"]'), (pg) => pg.fill("#v-name", "price tracker"), tap('[data-d="v-save"]')], ["Use letters, digits and _"]);
await p.close();
p = await open("view=vault&v=new", { chrome: "1" });
await p.check('input[name="v-kind"][value="env"]');
await p.waitForTimeout(80);
check("walk: choosing Environment value relabels the field and drops hosts", (await p.evaluate(() => document.getElementById("secret-value").labels[0].textContent)) === "Environment value" && !(await text(p)).includes("Allowed hosts"));
await p.close();
for (const [choice, words] of [
  ["ack", ["Removed from the Vault."]],
  ["refresh", ["Removed from the Vault. The gateway couldn't refresh settings that used it."]],
  ["lostlisted", ["STORE_API_KEY is still listed."]],
  ["lostnot", ["STORE_API_KEY is no longer listed in the Vault."]],
  ["refused", ["Couldn't confirm the removal. The Vault couldn't be read."]],
])
  (await walk(`Vault: Remove → ${choice}`, "view=vault&v=item", [(pg) => bar(pg, "vanswer", choice), tap('[data-d="v-remove"]'), tap('[data-d="v-remove-yes"]')], words)).close();
// Check reads the selected read-back again; it never announces a removal the list didn't show.
for (const [then, words, gone] of [
  ["lostlisted", ["STORE_API_KEY is still listed."], ["Removed from the Vault", "no longer listed"]],
  ["refused", ["Couldn't confirm the removal. The Vault couldn't be read."], ["Removed from the Vault", "no longer listed"]],
  ["lostnot", ["STORE_API_KEY is no longer listed in the Vault."], ["Removed from the Vault"]],
]) {
  p = await walk(
    `Vault: Remove, unreadable → Check finds ${then}`,
    "view=vault&v=item",
    [(pg) => bar(pg, "vanswer", "refused"), tap('[data-d="v-remove"]'), tap('[data-d="v-remove-yes"]'), pause(700), (pg) => bar(pg, "vanswer", then), tap('[data-d="v-remove-check"]')],
    words,
  );
  const said = absent(await text(p), gone);
  check(`Vault: Check finding ${then} doesn't say more than the list showed`, !said, said);
  await p.close();
}
(await walk("Vault: error → Try again", "view=vault&v=error", [tap('[data-d="v-retry"]')], ["STORE_API_KEY"])).close();

// Settings, Drafts
p = await open("view=drafts", { chrome: "1" });
await click(p, '[data-bot-switch="juniper"]');
check("walk: a drafts switch says Saving… until the read-back", (await text(p)).includes("Saving…"));
await p.waitForTimeout(700);
check("walk: the switch moves once read back", (await p.getAttribute('[data-bot-switch="juniper"]', "aria-checked")) === "true");
await bar(p, "answer", "refused");
await click(p, '[data-bot-switch="otto"]');
await p.waitForTimeout(700);
check("walk: a failed save leaves the setting unknown, with Read again", (await text(p)).includes("Couldn't confirm the setting. Read it again.") && (await p.locator('[data-bot-switch="otto"]').count()) === 0);
await click(p, '[data-read="otto"]');
check("walk: Read again shows the setting again", (await p.locator('[data-bot-switch="otto"]').count()) === 1);
await p.close();
p = await open("view=vault&width=800", { chrome: "1", width: 1100 });
await click(p, '[data-d="to-nav"]');
check("800: Back shows the list of sections", await p.locator(".b-nav").isVisible());
await click(p, '[data-d="nav-drafts"]');
check("800: a section opens as one pane", (await p.locator(".b-section").isVisible()) && !(await p.locator(".b-nav").isVisible()));
await p.close();

// Part 3: widths, themes, the phone ------------------------------------------------------------------
const views = ["view=draft", "view=draft&d=edit", "view=draft&d=edited", "view=draft&d=editsent", "view=draft&d=raw", "view=draft&kind=slack", "view=secret", "view=secret&s=saved", "view=vault", "view=vault&v=item", "view=vault&v=new", "view=drafts"];
for (const [label, width, w] of [["1440", 1440, "full"], ["1100", 1100, "1100"], ["800", 800, "800"], ["390", 390, "phone"]]) {
  for (const v of views) {
    p = await open(`${v}&width=${w}`, { width, height: 844 });
    check(`${v} at ${label}: no sideways scroll`, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.getElementById("root").scrollWidth <= document.getElementById("root").clientWidth + 1));
    await p.close();
  }
}
p = await open("view=draft&width=phone", { width: 390, height: 844 });
const phone = await p.evaluate(() => [...document.querySelectorAll('[data-testid="draft"] .request-actions .button')].map((x) => [x.textContent, Math.round(x.getBoundingClientRect().height), Math.round(x.getBoundingClientRect().width)]));
check("phone: the card's buttons stack full width, 48 px, Discard last", phone.length === 3 && phone.every(([, h]) => h >= 48) && phone[2][0] === "Discard" && phone[0][2] === phone[2][2], JSON.stringify(phone));
await p.close();
for (const v of ["view=draft", "view=secret", "view=vault"]) {
  p = await open(v, { theme: "dark" });
  check(`${v}, dark: the page uses the dark theme`, await p.evaluate(() => document.documentElement.dataset.theme === "dark" && getComputedStyle(document.querySelector(".d-page")).backgroundColor !== "rgb(255, 255, 255)"));
  await p.close();
}

// Part 4: nothing the document cuts is drawn, and no overclaim ---------------------------------------
p = await b.newPage();
await p.goto(pageUrl("gallery.html") + "?chrome=1&section=drafts");
await p.waitForTimeout(100);
const links = await p.evaluate(() => [...document.querySelectorAll('#drafts a[href^="drafts.html"]')].map((a) => a.getAttribute("href")));
check("gallery: the Drafts and the Vault section links to every state", links.length === 96, String(links.length));
check("gallery: the section says draft examples use a proposed plugin", (await text(p, "#drafts")).includes(PROPOSED));
check("the prototype bar links to the drafts page", await p.evaluate(() => [...document.querySelectorAll("#proto-bar a")].some((a) => a.getAttribute("href") === "drafts.html")));
await p.close();
const banned = ["securely", "Every bot on this gateway loses it", "Never shown to Otto", "can't read it back", "Every bot on the gateway can use them", "nothing waits as a draft", "Sign in to", "Filled directly to", "Securely save to Bot's vault"];
const broken = [];
const claims = [];
for (const href of links) {
  const pg = await open(href.split("?")[1] || "");
  const t = await pg.evaluate(() => document.body.textContent);
  if (t.replace(/\s+/g, " ").length < 40 || pg.errors.length) broken.push(href);
  const hit = banned.filter((w) => t.toLowerCase().includes(w.toLowerCase()));
  if (hit.length) claims.push(`${href}: ${hit.join(", ")}`);
  await pg.close();
}
check("every gallery link opens a drawn state with no error", broken.length === 0, broken.join(" "));
check("no state makes a claim the document removed", claims.length === 0, claims.join(" | "));
p = await b.newPage();
await p.goto(pageUrl("gallery.html") + "?chrome=1");
await p.waitForTimeout(100);
check("gallery: the page header links to the drafts page", await p.evaluate(() => [...document.querySelectorAll(".gallery header a")].some((a) => a.getAttribute("href") === "drafts.html")));
await p.close();
void absent;

await b.close();
console.log(out.join("\n"));
console.log(`${out.filter((l) => l.startsWith("ok")).length} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
