// Checks for drafts.html: every state of docs/design/drafts-and-vault.md opened
// from the address with its words and structure; every path clicked through to
// its outcome; what the secret field keeps; the widths, the themes, the phone;
// and the gallery and the bar reaching the page.
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
const bar = async (p, key, value) => {
  await p.selectOption(`[data-proto="${key}"]`, value);
};

process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

// Part 1: every state from the address, with its words ------------------------------------------
const states = [
  ["view=draft", ["New email", "Ready to send", "Otto wants to send this from its email tool, mail_send.", "From", "otto@example.com", "To", "dana@example.com", "Cc", "lee@example.org", "Subject", "Media box report", "report.txt", "Checked when Otto asked, 5:42 PM. Checked again before it's sent.", "Send email", "Edit", "Discard", "Show full request", "Disable drafts for Otto", "Held by Clawtrate's drafts plugin. It waits up to 10 minutes.", "Raw", "Show more"]],
  ["view=draft&d=full", ["Hide full request", "Tool", "mail_send", "Disk almost full on the media box", "5:42 PM, expires 5:52 PM", "Clawtrate's drafts plugin"]],
  ["view=draft&d=sending", ["Sending your decision…", "Discard"]],
  ["view=draft&d=sent", ["Answered", "Sent from otto@example.com to dana@example.com, cc lee@example.org, with report.txt (28 bytes), at 5:43 PM. Read back from the email tool's result."]],
  ["view=draft&d=sentnoreport", ["Answered", "The email tool reported it sent this at 5:43 PM. It doesn't say what it sent; this is what you approved."]],
  ["view=draft&d=failed", ["Not sent", "The email tool failed: account not connected. Nothing in its result says it was sent."]],
  ["view=draft&d=discarded", ["Discarded", "Discarded at 5:43 PM. Nothing was sent. Otto was told you discarded it."]],
  ["view=draft&d=refused", ["The gateway refused this decision", "The draft is still waiting.", "Try again", "Discard"]],
  ["view=draft&d=noanswer", ["No answer from the gateway. Your decision may or may not have been applied.", "Check again", "Discard"]],
  ["view=draft&d=already", ["Already answered on another device at 5:25 PM. Your decision was not applied."]],
  ["view=draft&d=expired", ["Expired", "Expired at 5:52 PM without an answer. Nothing was sent."]],
  ["view=draft&d=closed", ["The run ended before this was answered. Nothing was sent."]],
  ["view=draft&d=cancelled", ["You stopped the run before answering. Nothing was sent."]],
  ["view=draft&d=filechanged", ["Not sent", "report.txt changed after Otto asked (28 bytes then, 44 now), so nothing was sent. Otto was told why. If it asks again, the new draft appears below."]],
  ["view=draft&d=unchecked", ["Couldn't check report.txt: it isn't in Otto's workspace. If it changes before it's sent, Clawtrate can't tell.", "Send email"]],
  ["view=draft&d=edit", ["Your edit goes to Clawtrate's drafts plugin, for this draft only. Sending it releases Otto's email to the plugin, which swaps in your edit. The gateway then asks once more, for the edited email, and that answer sends it.", "From and the attachments stay as Otto set them.", "Send edited email", "Cancel edit", "Discard"]],
  ["view=draft&d=editsaving", ["Giving your edit to the drafts plugin…"]],
  ["view=draft&d=editfailed", ["Clawtrate's drafts plugin didn't take your edit. Nothing was sent; the draft is still waiting.", "Try again", "Cancel edit", "Discard"]],
  ["view=draft&d=edited", ["Edited email", "Ready to send", "You edited Otto's email. This is what will be sent.", "Show Otto's version", "dana@example.com, sam@example.net", "Media box report: disk at 91%", "Edited", "Send edited email", "Discard", "The gateway asks again because you edited it. This answer sends it."]],
  ["view=draft&d=elsewhere", ["Edited on another device at 5:44 PM.", "Send edited email", "Discard"]],
  ["view=draft&d=editsent", ["Answered", "Sent from otto@example.com to dana@example.com, sam@example.net", "Read back from the email tool's result.", "You edited this before it was sent.", "Otto used mail_send", "Otto asked to send to dana@example.com, subject \"Media box report\".", "Edited before sending: To, Subject, Body. What was sent is on the draft card."]],
  ["view=draft&d=editsent&p=stopped", ["Clawtrate's drafts plugin isn't answering"]],
  ["view=draft&d=editdiscarded", ["Discarded at 5:44 PM. Nothing was sent. Your edit wasn't used."]],
  ["view=draft&d=editexpired", ["Expired at 5:54 PM without an answer. Nothing was sent. Your edit wasn't used."]],
  ["view=draft&d=editrestart", ["Closed", "The gateway restarted before this was sent. Nothing was sent, and your edit wasn't used."]],
  ["view=draft&d=disable", ["Send Otto's emails and messages without drafts?", "won't wait for you. They'll run as Otto's rules allow", "what Otto may do", "The gateway's automatic review covers commands, not sends.", "it holds only while the plugin runs.", "Send without drafts", "Cancel"]],
  ["view=draft&d=disabled", ["Drafts off for Otto. This draft is still waiting for you."]],
  ["view=draft&d=disablefailed", ["Couldn't save. Drafts are still on for Otto."]],
  ["view=draft&kind=slack", ["Slack message", "Otto wants to post this through its Slack channel, with the message tool.", "Workspace", "Example Co", "#ops", "Thread", "Disk alerts", "Send message", "Discard"]],
  ["view=draft&kind=slack&d=sent", ["Posted to #ops in Example Co, in the thread Disk alerts, at 5:43 PM. Read back from the message tool's result."]],
  ["view=draft&access=read", ["Read-only.", "Answering needs approvals access.", "Request approvals access"]],
  ["view=draft&access=read&req=requested", ["Waiting for the gateway's owner.", "openclaw devices approve"]],
  ["view=draft&p=stopped", ["It wasn't held as a draft", "Clawtrate's drafts plugin isn't answering, so nothing waits as a draft. Otto, Pip and Marlow send as their rules allow."]],
  ["view=secret", ["Otto asks for a secret", "Secret", "Name", "PRICE_TRACKER_KEY", "Why", "To read prices from the store's API for your tracker.", "It will be saved to your gateway's shared secret store. The gateway keeps it in its state database on its own machine and doesn't encrypt it there. Skip saves nothing.", "Allowed hosts", "api.example.com", "The egress proxy sends this secret only to these hosts.", "Secret value", "Save to the gateway", "Skip", "Never shown to Otto, and not kept by Clawtrate. Bots on this gateway see its name and hosts, not its value.", "About filling this field", "Raw"]],
  ["view=secret&s=hosts", ["api.example.com", "api.example.net"]],
  ["view=secret&s=exists", ["STORE_API_KEY", "This replaces the value saved as STORE_API_KEY on Nov 19."]],
  ["view=secret&s=saving", ["Saving…"]],
  ["view=secret&s=saved", ["Saved", "Saved to your gateway as PRICE_TRACKER_KEY at 5:44 PM. Otto can't read it back.", "Allowed hosts now: api.example.com."]],
  ["view=secret&s=refused", ["The gateway didn't save it", "Type it again to retry."]],
  ["view=secret&s=noanswer", ["No answer from the gateway. The secret may or may not have been saved.", "Check"]],
  ["view=secret&s=already", ["Already answered on another device."]],
  ["view=secret&s=skipped", ["Skipped. Otto was told no secret arrived."]],
  ["view=secret&s=expired", ["Expired without an answer. Otto was told no secret arrived."]],
  ["view=secret&s=cannotask&access=interactive", ["Asked for a secret", "Failed", "missing scope: operator.questions", "Inferred: the gateway lets a bot ask for a secret only in a run started from a connection with admin access. This device has read, write, approvals and questions."]],
  ["view=secret&access=read", ["Answering needs questions access.", "Request questions access"]],
  ["view=vault", ["Vault", "Secrets on this gateway. Every bot on the gateway can use them, through the hosts each allows; none can read a protected value back.", "New item", "BUILD_REGION", "Readable by bots", "No hosts", "MEDIA_BOX_TOKEN", "STORE_API_KEY", "Protected", "Updated Nov 19", "Where a bot's secrets come from", "This Vault: values the gateway keeps.", "the value is given to the bot, which can see it.", "Nothing on the gateway makes a bot try these in an order. Each bot chooses which to use."]],
  ["view=vault&v=empty", ["No secrets yet. A bot can ask for one in a conversation, or add one here."]],
  ["view=vault&v=error", ["Couldn't read the Vault.", "Try again"]],
  ["view=vault&v=item", ["STORE_API_KEY", "Kind", "Protected", "Allowed hosts", "Reference", "store · default · STORE_API_KEY", "The gateway keeps this value in its state database on its own machine and doesn't encrypt it there.", "Who can use it.", "The gateway doesn't limit an item to chosen bots.", "Offered the Secrets tool: Otto, Pip and Marlow", "Replace…", "Remove…"]],
  ["view=vault&v=item&item=BUILD_REGION", ["Bots can read this value: it is listed to them and given to their commands."]],
  ["view=vault&v=new", ["New item", "Name", "Uppercase letters, digits and _.", "Secret value", "Kind", "Protected", "Readable by bots", "Allowed hosts", "Save", "Cancel"]],
  ["view=vault&v=replace", ["Replace STORE_API_KEY", "STORE_API_KEY exists. Saving replaces its value and hosts."]],
  ["view=vault&v=saved", ["Saved. PRICE_TRACKER_KEY is in the Vault, Protected, with api.example.com."]],
  ["view=vault&v=unconfirmed", ["The gateway accepted it, but the Vault couldn't confirm it. Check the list."]],
  ["view=vault&v=failed", ["Couldn't save: the gateway refused it."]],
  ["view=vault&v=remove", ["Remove STORE_API_KEY?", "Every bot on this gateway loses it: Otto, Pip, Marlow and Juniper.", "Settings that refer to it stop working: plugins.entries.price-tracker.config.apiKey.", "The gateway keeps the removed value for 30 days, then deletes it.", "Remove", "Cancel"]],
  ["view=vault&v=removed", ["Removed. Otto, Pip, Marlow and Juniper can no longer use STORE_API_KEY."]],
  ["view=vault&v=stilllisted", ["The gateway answered, but STORE_API_KEY is still listed.", "Try again"]],
  ["view=vault&v=removeunknown", ["Removed? The gateway answered, but the Vault couldn't be read to confirm.", "Check"]],
  ["view=vault&access=interactive", ["Admin access needed.", "Seeing the Vault needs admin access. The gateway shows its secret store to admin connections only.", "Request admin access"]],
  ["view=vault&access=read&req=denied", ["The request was denied. Nothing changed."]],
  ["view=drafts", ["Drafts", "Drafts plugin answered at 5:46 PM.", "When a bot sends an email or a message through one of these tools, Clawtrate's drafts plugin holds it here until you send or discard it. It holds only while the plugin runs.", "Bots", "Otto", "Pip", "Marlow", "Juniper", "Sending tools", "mail_send", "To from to", "message", "A tool not on this list never makes a draft; its calls follow the bot's rules.", "the gateway's automatic review covers commands, not sends."]],
  ["view=drafts&p=stopped", ["Clawtrate's drafts plugin isn't answering.", "Not held now: the drafts plugin isn't running", "nothing waits as a draft"]],
  ["view=drafts&p=absent", ["Drafts methods unavailable on this gateway."]],
  ["view=drafts&access=interactive", ["Changing drafts needs admin access."]],
];
for (const [query, words] of states) {
  const p = await open(query);
  const t = await text(p, "body");
  check(`${query}: its words`, !missing(t, words) && p.errors.length === 0, missing(t, words) || p.errors.join(" "));
  await p.close();
}

// Structure that matters ---------------------------------------------------------------------------
let p = await open("view=draft");
check("the draft card is a region named for its recipient", (await p.getAttribute('[data-testid="draft"]', "aria-label")) === "New email to dana@example.com. Ready to send.");
check("the rows are a description list", (await p.locator(".d-rows dt").count()) === 4);
check("Discard is the last button of the card", await p.evaluate(() => [...document.querySelectorAll('[data-testid="draft"] .request-actions .button')].pop().textContent === "Discard"));
await p.close();
p = await open("view=draft&access=interactive");
check("below admin there is no Disable drafts link", !(await text(p)).includes("Disable drafts for Otto") && (await text(p)).includes("Send email"));
await p.close();
p = await open("view=draft&access=read");
check("read-only: the card has no Send or Discard", (await p.locator('[data-d="send"], [data-d="discard"]').count()) === 0);
await p.close();
p = await open("view=secret");
const attrs = await p.evaluate(() => {
  const f = document.getElementById("secret-value");
  return [f.type, f.getAttribute("autocomplete"), f.getAttribute("spellcheck"), f.getAttribute("autocapitalize"), f.labels[0]?.textContent];
});
check("the Secure Form's field: password, no autocomplete, no spelling, no capitals, labelled", JSON.stringify(attrs) === JSON.stringify(["password", "off", "false", "off", "Secret value"]), JSON.stringify(attrs));
check("Save to the gateway starts disabled", await p.locator('[data-d="s-save"]').isDisabled());
check("the secret card is a region named for its secret", (await p.getAttribute('[data-testid="secret"]', "aria-label")) === "Otto asks for a secret: PRICE_TRACKER_KEY.");
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
(await walk("Send email: the tool says nothing", "view=draft", [(pg) => bar(pg, "tool", "silent"), tap('[data-d="send"]')], ["It doesn't say what it sent; this is what you approved."])).close();
(await walk("Send email: the tool fails", "view=draft", [(pg) => bar(pg, "tool", "fails"), tap('[data-d="send"]')], ["Not sent", "The email tool failed"])).close();
(await walk("Discard → Discarded", "view=draft", [tap('[data-d="discard"]')], ["Discarded at 5:43 PM. Nothing was sent."])).close();
(await walk("Send, refused → Try again → Answered", "view=draft", [answer("refused"), tap('[data-d="send"]'), pause(700), answer("applied"), tap('[data-d="send"]')], ["Answered"])).close();
(await walk("Send, no answer → Check again → Answered", "view=draft", [answer("noanswer"), tap('[data-d="send"]'), pause(700), tap('[data-d="check"]')], ["Answered"])).close();
(await walk("Send, already answered elsewhere", "view=draft", [answer("already"), tap('[data-d="send"]')], ["Already answered on another device at 5:25 PM. Your decision was not applied."])).close();
(await walk("A file changes while waiting → Send → Not sent", "view=draft", [tap('[data-proto-event="file"]'), tap('[data-d="send"]')], ["Not sent", "report.txt changed after Otto asked (28 bytes then, 44 now), so nothing was sent."])).close();
p = await walk("Edit → Send edited email → the edit is taken → the second hold → Send → sent as edited", "view=draft", [tap('[data-d="edit"]'), tap('[data-d="edit-send"]'), pause(1400)], ["Edited email", "You edited Otto's email. This is what will be sent.", "Send edited email"]);
await click(p, '[data-d="show-original"]');
check("walk: Show Otto's version opens the bot's own version", (await p.locator('[data-testid="original"]').count()) === 1 && (await text(p)).includes("Otto's version"));
await click(p, '[data-d="send"]');
check("walk: the second answer sends the edit, read back, with the action card's line", await waitText(p, ["Sent from otto@example.com to dana@example.com, sam@example.net", "You edited this before it was sent.", "Edited before sending: To, Subject, Body."]));
await p.close();
(await walk("Edit → the plugin refuses the edit → Try again → taken", "view=draft", [answer("refused"), tap('[data-d="edit"]'), tap('[data-d="edit-send"]'), pause(700), answer("applied"), tap('[data-d="edit-send"]'), pause(1400)], ["Edited email"])).close();
(await walk("Edit, already edited on another device", "view=draft", [answer("already"), tap('[data-d="edit"]'), tap('[data-d="edit-send"]')], ["Clawtrate's drafts plugin didn't take your edit.", "This draft was already edited on another device."])).close();
(await walk("Edit → Cancel edit → back to the draft", "view=draft", [tap('[data-d="edit"]'), tap('[data-d="edit-cancel"]')], ["Send email", "Edit"])).close();
(await walk("Edit → the second hold → Discard → your edit wasn't used", "view=draft", [tap('[data-d="edit"]'), tap('[data-d="edit-send"]'), pause(1400), tap('[data-d="discard"]')], ["Discarded at 5:44 PM. Nothing was sent. Your edit wasn't used."])).close();
(await walk("Edit → the second hold expires", "view=draft", [tap('[data-d="edit"]'), tap('[data-d="edit-send"]'), pause(1400), tap('[data-proto-event="expire"]')], ["Expired at 5:54 PM without an answer. Nothing was sent. Your edit wasn't used."])).close();
(await walk("Edit → the gateway restarts", "view=draft", [tap('[data-d="edit"]'), tap('[data-d="edit-send"]'), pause(1400), tap('[data-proto-event="restart"]')], ["The gateway restarted before this was sent. Nothing was sent, and your edit wasn't used."])).close();
(await walk("Edit, a file changed → Not sent, the edit unused", "view=draft", [tap('[data-proto-event="file"]'), tap('[data-d="edit"]'), tap('[data-d="edit-send"]'), pause(1400)], ["report.txt changed after Otto asked (28 bytes then, 44 now)", "Your edit wasn't used."])).close();
(await walk("Edited on another device → Send edited email → the second hold → Send", "view=draft&d=elsewhere", [tap('[data-d="send"]'), pause(700), tap('[data-d="send"]')], ["You edited this before it was sent.", "Edited before sending"])).close();
p = await open("view=draft&d=edited");
check("the edited draft marks To, Subject and Body as edited, in words", (await p.locator(".d-changed").count()) === 3);
await p.close();
p = await open("view=draft&d=elsewhere");
check("another device: no Edit, since the call already has its edit", (await p.locator('[data-d="edit"]').count()) === 0);
await p.close();
(await walk("Disable drafts → Send without drafts → off, this draft still waits", "view=draft", [tap('[data-d="disable"]'), tap('[data-d="disable-yes"]')], ["Drafts off for Otto. This draft is still waiting for you.", "Send email"])).close();
(await walk("Disable drafts, refused → still on", "view=draft", [answer("refused"), tap('[data-d="disable"]'), tap('[data-d="disable-yes"]')], ["Couldn't save. Drafts are still on for Otto."])).close();
(await walk("Disable drafts → Cancel", "view=draft", [tap('[data-d="disable"]'), tap('[data-d="disable-no"]')], ["Disable drafts for Otto"])).close();
(await walk("Expire", "view=draft", [tap('[data-proto-event="expire"]')], ["Expired at 5:52 PM without an answer. Nothing was sent."])).close();
(await walk("The run ends", "view=draft", [tap('[data-proto-event="close"]')], ["The run ended before this was answered. Nothing was sent."])).close();
(await walk("Stop", "view=draft", [tap('[data-proto-event="stop"]')], ["You stopped the run before answering. Nothing was sent."])).close();
(await walk("Show full request, and hide it", "view=draft", [tap('[data-d="full"]'), tap('[data-d="full"]')], ["Show full request"])).close();
(await walk("Show more, then Show less", "view=draft", [tap('[data-d="fold"]')], ["Show less", "transcode/ (64 GB)"])).close();
(await walk("Slack: Send message → posted, read back", "view=draft&kind=slack", [tap('[data-d="send"]')], ["Posted to #ops in Example Co, in the thread Disk alerts"])).close();
(await walk("Slack: Discard", "view=draft&kind=slack", [tap('[data-d="discard"]')], ["Discarded at 5:43 PM. Nothing was sent."])).close();
(await walk("Slack: Edit → the second hold → Send edited message", "view=draft&kind=slack", [tap('[data-d="edit"]'), tap('[data-d="edit-send"]'), pause(1400), tap('[data-d="send"]')], ["Posted to #ops in Example Co", "Disk at 91% on the media box.", "You edited this before it was sent."])).close();
(await walk("Read-only: Request approvals access → waiting", "view=draft&access=read", [tap('[data-d="request"]')], ["Waiting for the gateway's owner."])).close();
p = await walk("Review moves focus to the waiting card", "view=draft", [tap('[data-d="review"]')], ["Send email"]);
check("walk: Review focuses the card", await p.evaluate(() => document.activeElement?.dataset.testid === "draft"));
await p.close();
p = await open("view=draft", { chrome: "1" });
await p.locator('[data-d="edit"]').focus();
await p.keyboard.press("Meta+Enter");
check("⌘↵ in the card sends", await waitText(p, ["Answered"]));
await p.close();

// The secret
const VALUE = "example-secret-value-check";
p = await open("view=secret", { chrome: "1" });
await p.fill("#secret-value", VALUE);
check("typing a value enables Save to the gateway", !(await p.locator('[data-d="s-save"]').isDisabled()));
await click(p, '[data-d="s-save"]');
check("walk: Save to the gateway → Saved, with hosts read back", await waitText(p, ["Saved to your gateway as PRICE_TRACKER_KEY", "Allowed hosts now: api.example.com."]));
check("after saving the value is nowhere on the page or in the live region", await p.evaluate((v) => !document.documentElement.outerHTML.includes(v) && ![...document.querySelectorAll("input")].some((i) => i.value === v), VALUE));
check("the field is gone after Saved", (await p.locator("#secret-value").count()) === 0);
await p.close();
p = await open("view=secret", { chrome: "1" });
await bar(p, "answer", "refused");
await p.fill("#secret-value", VALUE);
await click(p, '[data-d="s-save"]');
check("walk: Save, refused → type it again, field empty", (await waitText(p, ["The gateway didn't save it", "Type it again to retry."])) && (await p.inputValue("#secret-value")) === "");
await p.close();
p = await open("view=secret", { chrome: "1" });
await bar(p, "answer", "noanswer");
await p.fill("#secret-value", VALUE);
await click(p, '[data-d="s-save"]');
await waitText(p, ["may or may not have been saved"]);
check("no answer: the value is not kept", await p.evaluate((v) => !document.documentElement.outerHTML.includes(v), VALUE));
await click(p, '[data-d="s-check"]');
check("walk: Save, no answer → Check → Saved", await waitText(p, ["Saved to your gateway"]));
await p.close();
p = await open("view=secret", { chrome: "1" });
await bar(p, "answer", "already");
await p.fill("#secret-value", VALUE);
await click(p, '[data-d="s-save"]');
check("walk: Save, already answered elsewhere", await waitText(p, ["Already answered on another device."]));
await p.close();
(await walk("Skip → Skipped", "view=secret", [tap('[data-d="s-skip"]')], ["Skipped. Otto was told no secret arrived."])).close();
(await walk("Remove the only host → no hosts", "view=secret", [tap('[data-host="api.example.com"]')], ["No hosts: the egress proxy won't send this secret anywhere. Settings that refer to it can still use it."])).close();
p = await open("view=secret", { chrome: "1" });
await p.fill("#add-host", "api.example.org");
await p.press("#add-host", "Enter");
check("walk: add a host with Enter", await waitText(p, ["api.example.org"]));
await p.fill("#secret-value", VALUE);
await p.press("#secret-value", "Escape");
check("Escape clears the field and does not skip", (await p.inputValue("#secret-value")) === "" && (await text(p)).includes("Save to the gateway"));
await p.fill("#secret-value", VALUE);
await p.press("#secret-value", "Enter");
check("Enter in the field saves", await waitText(p, ["Saved to your gateway"]));
await p.close();
p = await open("view=secret", { chrome: "1" });
await p.fill("#secret-value", VALUE);
await click(p, '[data-d="reveal"]');
check("Show reveals the typed value", (await p.getAttribute("#secret-value", "type")) === "text");
await p.press("#secret-value", "a");
check("the next keystroke hides it again", (await p.getAttribute("#secret-value", "type")) === "password");
await p.close();
(await walk("Secret: expire", "view=secret", [tap('[data-proto-event="expire"]')], ["Expired without an answer."])).close();

// The Vault
p = await walk("Vault: New item → a bad name is refused", "view=vault", [tap('[data-d="v-new"]'), (pg) => pg.fill("#v-name", "price tracker"), tap('[data-d="v-save"]')], ["Use letters, digits and _"]);
await p.fill("#v-name", "PRICE_TRACKER_KEY");
await p.fill("#secret-value", VALUE);
await click(p, '[data-d="v-save"]');
check("walk: Vault: New item → Saved, and listed", await waitText(p, ["Saved. PRICE_TRACKER_KEY is in the Vault", "PRICE_TRACKER_KEY"]));
check("the Vault keeps no value on the page", await p.evaluate((v) => !document.documentElement.outerHTML.includes(v), VALUE));
await p.close();
(await walk("Vault: New item, unconfirmed", "view=vault", [(pg) => bar(pg, "vanswer", "unconfirmed"), tap('[data-d="v-new"]'), (pg) => pg.fill("#v-name", "PRICE_TRACKER_KEY"), tap('[data-d="v-save"]')], ["The gateway accepted it, but the Vault couldn't confirm it."])).close();
(await walk("Vault: New item, refused", "view=vault", [(pg) => bar(pg, "vanswer", "refused"), tap('[data-d="v-new"]'), (pg) => pg.fill("#v-name", "PRICE_TRACKER_KEY"), tap('[data-d="v-save"]')], ["Couldn't save: the gateway refused it."])).close();
(await walk("Vault: New item → Cancel", "view=vault", [tap('[data-d="v-new"]'), tap('[data-d="v-cancel"]')], ["Where a bot's secrets come from"])).close();
(await walk("Vault: open an item", "view=vault", [tap('[data-item="STORE_API_KEY"]')], ["Who can use it.", "Replace…"])).close();
(await walk("Vault: Replace… → Save → the item", "view=vault&v=item", [tap('[data-d="v-replace"]'), tap('[data-d="v-save"]')], ["Who can use it."])).close();
p = await walk("Vault: Remove… → Remove → Removed", "view=vault&v=item", [tap('[data-d="v-remove"]'), tap('[data-d="v-remove-yes"]')], ["Removed. Otto, Pip, Marlow and Juniper can no longer use STORE_API_KEY."]);
check("walk: the removed item is no longer listed", (await p.locator('[data-item="STORE_API_KEY"]').count()) === 0);
await p.close();
(await walk("Vault: Remove…, still listed", "view=vault&v=item", [(pg) => bar(pg, "vanswer", "unconfirmed"), tap('[data-d="v-remove"]'), tap('[data-d="v-remove-yes"]')], ["The gateway answered, but STORE_API_KEY is still listed."])).close();
(await walk("Vault: Remove…, unreadable → Check → Removed", "view=vault&v=item", [(pg) => bar(pg, "vanswer", "refused"), tap('[data-d="v-remove"]'), tap('[data-d="v-remove-yes"]'), pause(700), tap('[data-d="v-remove-check"]')], ["Removed. Otto, Pip, Marlow and Juniper"])).close();
(await walk("Vault: Remove… → Cancel", "view=vault&v=item", [tap('[data-d="v-remove"]'), tap('[data-d="v-remove-no"]')], ["Who can use it."])).close();
(await walk("Vault: error → Try again → the list", "view=vault&v=error", [tap('[data-d="v-retry"]')], ["STORE_API_KEY"])).close();
(await walk("Vault below admin: Request admin access → waiting", "view=vault&access=interactive", [tap('[data-d="request"]')], ["Waiting for the gateway's owner."])).close();

// Settings, Drafts
p = await open("view=drafts", { chrome: "1" });
await click(p, '[data-bot-switch="juniper"]');
check("walk: a drafts switch says Saving… until the read-back", (await text(p)).includes("Saving…"));
await p.waitForTimeout(700);
check("walk: the switch moves once read back", (await p.getAttribute('[data-bot-switch="juniper"]', "aria-checked")) === "true");
await bar(p, "answer", "refused");
await click(p, '[data-bot-switch="otto"]');
await p.waitForTimeout(700);
check("walk: a refused save leaves the switch where it was", (await p.getAttribute('[data-bot-switch="otto"]', "aria-checked")) === "true");
await p.close();
p = await open("view=drafts&access=interactive");
check("below admin the switches are disabled", await p.locator('[data-bot-switch="otto"]').isDisabled());
await p.close();
p = await open("view=drafts&p=stopped");
check("the plugin stopped: the switches are disabled", await p.locator('[data-bot-switch="otto"]').isDisabled());
await p.close();
(await walk("Settings: Drafts → Vault in the list", "view=drafts", [tap('[data-d="nav-vault"]')], ["Secrets on this gateway."])).close();
p = await open("view=vault&width=800", { chrome: "1", width: 1100 });
await click(p, '[data-d="to-nav"]');
check("800: Back shows the list of sections", await p.locator(".b-nav").isVisible());
await click(p, '[data-d="nav-drafts"]');
check("800: a section opens as one pane", (await p.locator(".b-section").isVisible()) && !(await p.locator(".b-nav").isVisible()));
await p.close();

// Part 3: widths, themes, the phone ------------------------------------------------------------------
const views = ["view=draft", "view=draft&d=edit", "view=draft&d=edited", "view=draft&d=editsent", "view=draft&kind=slack", "view=secret", "view=secret&s=saved", "view=vault", "view=vault&v=item", "view=vault&v=new", "view=drafts"];
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
check("phone: the rows stack label over value", await p.evaluate(() => getComputedStyle(document.querySelector(".d-rows")).gridTemplateColumns.split(" ").length === 1));
await p.close();
for (const v of ["view=draft", "view=secret", "view=vault"]) {
  p = await open(v, { theme: "dark" });
  check(`${v}, dark: the page uses the dark theme`, await p.evaluate(() => document.documentElement.dataset.theme === "dark" && getComputedStyle(document.querySelector(".d-page")).backgroundColor !== "rgb(255, 255, 255)"));
  await p.close();
}

// Part 4: nothing the document cuts is drawn ----------------------------------------------------------
p = await open("view=secret");
let t = await text(p, "body");
check("no Secure Form that fills a website, and no use-once choice", !absent(t, ["Sign in to", "Filled directly to", "Securely save to Bot's vault", "used once"]), absent(t, ["Sign in to", "Filled directly to", "Securely save to Bot's vault", "used once"]));
await p.close();
p = await open("view=vault&v=item");
t = await text(p, "body");
check("the Vault never offers to reveal a value or limit an item to a bot", !absent(t, ["Reveal", "Only these bots", "Limit to"]), absent(t, ["Reveal", "Only these bots", "Limit to"]));
await p.close();
p = await open("view=draft&d=sent");
t = await text(p, "body");
check("a resolved draft never says subject to review", !t.includes("subject to review"));
await p.close();

// Part 5: the gallery and the bar reach the page -------------------------------------------------------
p = await b.newPage();
await p.goto(pageUrl("gallery.html") + "?chrome=1&section=drafts");
await p.waitForTimeout(100);
const links = await p.evaluate(() => [...document.querySelectorAll('#drafts a[href^="drafts.html"]')].map((a) => a.getAttribute("href")));
check("gallery: the Drafts and the Vault section links to every state", links.length === 70, String(links.length));
check("the prototype bar links to the drafts page", await p.evaluate(() => [...document.querySelectorAll("#proto-bar a")].some((a) => a.getAttribute("href") === "drafts.html")));
await p.close();
let broken = [];
for (const href of links) {
  const q = href.split("?")[1] || "";
  const pg = await open(q);
  const ok = (await text(pg)).length > 40 && pg.errors.length === 0;
  if (!ok) broken.push(href);
  await pg.close();
}
check("every gallery link opens a drawn state with no error", broken.length === 0, broken.join(" "));
const promising = [];
for (const href of links) {
  const pg = await open(href.split("?")[1] || "");
  if (/securely/i.test(await pg.evaluate(() => document.body.textContent))) promising.push(href);
  await pg.close();
}
check("no state says \"securely\": the gateway keeps values in plain text", promising.length === 0, promising.join(" "));
p = await b.newPage();
await p.goto(pageUrl("gallery.html") + "?chrome=1");
await p.waitForTimeout(100);
check("gallery: the page header links to the drafts page", await p.evaluate(() => [...document.querySelectorAll(".gallery header a")].some((a) => a.getAttribute("href") === "drafts.html")));
await p.close();

await b.close();
console.log(out.join("\n"));
console.log(`${out.filter((l) => l.startsWith("ok")).length} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
