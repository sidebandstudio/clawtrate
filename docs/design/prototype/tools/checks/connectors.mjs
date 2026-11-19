// Checks for connectors.html: every walk of docs/design/connectors.md clicked
// through to its outcome, with each destination asserted; every state's words
// and structure; the access request; the keyboard, phone and theme rules.
// Run from the repository root:  node docs/design/prototype/tools/checks/connectors.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("connectors.html") + "?chrome=0";
const b = await chromium.launch();
const out = [];
let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed += 1;
  out.push(`${ok ? "ok  " : "FAIL"} ${name} ${extra}`);
};
const open = async (query, { width = 1440, height = 900, theme = "light" } = {}) => {
  const p = await b.newPage({ viewport: { width, height } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  p.setDefaultTimeout(4000);
  p.setDefaultNavigationTimeout(30000);
  await p.goto(`${base}&theme=${theme}&${query}`);
  await p.waitForTimeout(60);
  p.errors = errors;
  return p;
};
// The words a person meets: the text, and each field's placeholder.
const text = (p, sel = "#c-root") =>
  p.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return "";
    const holders = [...el.querySelectorAll("[placeholder]")].map((i) => i.getAttribute("placeholder")).join(" ");
    return `${el.textContent} ${holders}`.replace(/\s+/g, " ");
  }, sel);
const missing = (t, words) => words.filter((w) => !t.includes(w)).join(" | ");
const screenOf = (p) => p.evaluate(() => new URLSearchParams(location.search).get("screen") || "home");
const at = async (p, screen) => {
  try {
    await p.waitForFunction((s) => (new URLSearchParams(location.search).get("screen") || "home") === s, screen, { timeout: 4000 });
    await p.waitForTimeout(40);
    return true;
  } catch {
    return false;
  }
};
const link = (name) => (p) => p.getByRole("link", { name, exact: true }).first().click();
const row = (name) => (p) => p.locator(`.c-row-main[aria-label^="${name},"]`).first().click();
const inConfirm = (name) => (p) => p.locator(".c-confirm").getByRole("link", { name, exact: true }).click();
const typeIn = (sel, value) => (p) => p.fill(sel, value);
const submit = (p) => p.locator("#c-server-form button[type=submit]").click();
const tick = (value) => (p) => p.locator(`.c-tile input[value="${value}"]`).check();

process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

// Part 1: every state's words -------------------------------------------------------------------
const STATES = [
  ["screen=home", ["Connect apps", "Home gateway", "Open Connect apps from the foot of the rail."]],
  ["screen=browse", ["Connect apps", "Browse", "On this gateway", "Add a custom connector", "Search across apps and skills", "All", "Productivity", "Recommended for you", "Featured in the catalog.", "All apps", "Quillnote", "Added", "Not working", "Turned off", "Needs setup", "Not available"]],
  ["screen=browse&picked=Quillnote,Tasktide", ["You picked", "Recommended for you"]],
  ["screen=browse&device=iphone", ["Plugins", "Search plugins", "Featured"]],
  ["screen=browse-loading", ["Search across apps and skills", "Prototype: the catalog"]],
  ["screen=browse-loading&slow=1", ["Still loading. The gateway is asking the catalog."]],
  ["screen=browse-offline", ["The catalog can't be reached from the gateway.", "You can still see and manage what's on this gateway. Apps to add come back when the gateway can reach the catalog.", "Details", "ClawHub is unavailable", "Try again", "Search what's on this gateway", "Categories and recommendations come from the catalog.", "On this gateway", "Tasktide"]],
  ["screen=browse-retry", ["Asking the catalog… This can take up to 15 seconds."]],
  ["screen=browse-error", ["Couldn't load the catalog.", "Try again"]],
  ["screen=browse-category&cat=finance", ["Finance", "Ledgerkin"]],
  ["screen=app&id=quillnote", ["Quillnote", "by quillnote-labs", "What it adds", "quillnote, a tool server that signs in with OAuth", "Daily notes, a skill", "About", "Version 2.4.1", "Add"]],
  ["screen=app&id=docklet", ["Not available for this gateway's version."]],
  ["screen=app&id=quillnote&access=read", ["Read-only.", "Adding apps needs admin access.", "Request admin access"]],
  ["screen=add-confirm&id=quillnote", ["Add Quillnote to the gateway?", "The gateway downloads Quillnote 2.4.1 from the catalog and installs it, with the packages it depends on, on the gateway's machine.", "It then runs inside the gateway, with the gateway's access", "The gateway doesn't restart.", "Cancel", "Add"]],
  ["screen=add-consent&id=quillnote", ["Quillnote asks for more than the catalog listed.", "before_tool_call", "Add anyway"]],
  ["screen=add-warning&id=quillnote", ["The gateway's install check found something.", "Warning:", "line 12", "Add anyway"]],
  ["screen=add-progress&id=quillnote", ["Adding Quillnote", "Finding the release", "Downloading", "Unpacking", "Writing files", "Installing what it needs", "Starting it on the gateway"]],
  ["screen=add-done&id=quillnote", ["Added Quillnote.", "It's turned on. Its tools reach bots from their next message.", "Open Quillnote"]],
  ["screen=add-restart&id=quillnote", ["The gateway says it needs a restart before Quillnote works. Clawtrate doesn't restart the gateway."]],
  ["screen=add-refused&id=quillnote", ["Couldn't add Quillnote:", "The gateway lists nothing new.", "Try again"]],
  ["screen=add-partial&id=quillnote", ["Quillnote was installed but didn't start:"]],
  ["screen=add-checking&id=quillnote", ["Checking what the gateway has…"]],
  ["screen=installed", ["Turned on", "Turned off", "Comes with OpenClaw (3)", "Tool servers", "notes-work", "Added by address", "search-index", "Runs a command", "Add a custom connector"]],
  ["screen=connector&id=tasktide&busy=1", ["The gateway is busy with another change.", "Try again in a moment.", "Try again"]],
  ["screen=remove-confirm&id=tasktide&bots=none", ["its tools, from every bot that doesn't deny them"]],
  ["screen=connector&id=tasktide", ["Tasktide", "Added", "Tools", "tasktide, a tool server", "Which bots may use these is in each bot's settings.", "Accounts", "Shared by everyone on this gateway", "Signed in.", "The gateway holds this sign-in until Dec 17, 5:12 PM.", "Whether it still works shows when a bot next uses Tasktide.", "Sign in again", "Turn off", "Remove…"]],
  ["screen=connector&id=calendrop", ["Needs sign-in", "Sign in"]],
  ["screen=connector&id=calendrop&auth=requires-authorization", ["Needs sign-in again", "The server asked for more access."]],
  ["screen=connector&id=calendrop&auth=pending-authorization", ["A sign-in was started and didn't finish."]],
  ["screen=connector&id=ledgerkin", ["Turned off. Its tools aren't offered to any bot.", "Turn on", "The gateway reports sign-ins only while Ledgerkin is turned on."]],
  ["screen=connector&id=postlark", ["Needs setup: the gateway needs Account address before it can turn Postlark on. Change these in the gateway's own settings page."]],
  ["screen=connector&id=boxwharf", ["Not working: boxwharf-sync: the token store couldn't be read"]],
  ["screen=connector&id=linkpeek", ["Comes with OpenClaw", "Added. Not loaded yet: it loads when a bot first needs it.", "Comes with OpenClaw, so it can be turned off but not removed."]],
  ["screen=connector&id=tasktide&access=read", ["Read-only.", "Changing connectors needs admin access.", "Request admin access"]],
  ["screen=turnoff-confirm&id=tasktide", ["Turn off Tasktide?", "Its tools stop reaching every bot on this gateway. Its settings and its sign-in stay."]],
  ["screen=remove-confirm&id=tasktide", ["Remove Tasktide from the gateway?", "Goes", "Tasktide's files on the gateway's machine", "its settings on the gateway", "its tools, from every bot that has them: Juniper, Pip", "Stays", "its sign-in, kept by the gateway in its state, not encrypted there", "a note on the gateway that Tasktide is off, so nothing turns it back on by itself"]],
  ["screen=removed&id=tasktide", ["Removed Tasktide.", "The gateway no longer lists it."]],
  ["screen=server&id=notes-work", ["notes-work", "Name on the gateway", "Added by address", "https://notes.example/mcp", "Authorization", "Hidden: the gateway doesn't show saved values. Kept by the gateway in its settings file, not encrypted there.", "Signs in with OAuth", "What the last run found", "8 tools, at Pip's run at 5:12 PM", "Sign-in", "Not reported.", "The gateway doesn't report whether it's signed in to this server, or for whom. A bot's run shows whether its tools work.", "Sign in", "Accounts", "A second name for the same server, with its own sign-in. Bots tell them apart by name.", "Add another account", "Remove…"]],
  ["screen=server&id=notes-work&last=notyet", ["No bot has run since this was added. Its tools show after the next run."]],
  ["screen=server&id=notes-work&last=unavailable", ["Unavailable at Pip's run at 5:12 PM:", "server unavailable"]],
  ["screen=server&id=notes-work&last=none", ["Not reported: the gateway's tool list doesn't mention this server."]],
  ["screen=server&id=search-index", ["Runs a command", "/opt/example/bin/search-server --stdio --index ./notes", "spawn /opt/example/bin/search-server ENOENT"]],
  ["screen=server&id=team-notes", ["Each person signs in", "Each person connects their own account when a bot first uses it, from the conversation."]],
  ["screen=server&id=notes-work&signed=1", ["Last signed in from Clawtrate: Nov 19, 5:12 PM."]],
  ["screen=server&id=notes-work&device=iphone", ["Change it from Clawtrate on your computer."]],
  ["screen=server-remove-confirm&id=notes-work", ["Remove notes-work from the gateway?", "the server's entry in the gateway's settings, with its headers", "its tools, from every bot that has them", "its sign-in, kept by the gateway in its state, not encrypted there. Removing the server does not delete it, and the gateway finds it again if a server with the same name and URL is added.", "To sign out first, run this on the gateway's machine before removing the server:", "openclaw mcp logout notes-work"]],
  ["screen=server-remove-confirm&id=search-index", ["Remove search-index from the gateway?", "nothing else: it has no sign-in the gateway keeps"]],
  ["screen=server-removed&id=notes-work", ["Removed notes-work.", "The gateway's settings no longer list it."]],
  ["screen=server-remove-failed&id=notes-work", ["notes-work is still listed:", "Try again"]],
  ["screen=add-server", ["Add a custom connector", "Type", "Remote HTTPS", "Command", "Name", "Server URL", "Headers", "Kept by the gateway in its settings file, not encrypted there. Clawtrate can't read a value back once it's saved.", "Sign-in", "None", "Sign in with OAuth", "Each person signs in", "OpenClaw registers itself with the server when it signs in.", "Add to gateway"]],
  ["screen=add-server&type=command", ["Command", "Arguments", "One per line. Each is passed as one argument, never through a shell.", "Working folder", "The gateway runs this program on its own machine, as the user the gateway runs as, whenever a bot's run needs its tools. It can do anything that user can.", "Continue"]],
  ["screen=add-server&access=read", ["Read-only.", "Adding a custom connector needs admin access."]],
  ["screen=command-confirm&name=search-index&cmd=/opt/example/bin/search-server&args=--stdio", ["Run this command on the gateway's machine?", "Home gateway will run, on its own machine (studio.example), as the user it runs as:", "/opt/example/bin/search-server", "--stdio", "with that user's access to files, programs and the network.", "Run it on the gateway"]],
  ["screen=add-server-saved&name=notes-work", ["Added notes-work.", "The gateway lists it. Its tools reach bots from their next run, unless a bot's settings deny them."]],
  ["screen=add-server-saved&name=search-index&type=command", ["Added search-index.", "The gateway will run it at a bot's next run."]],
  ["screen=add-server-refused&name=notes-work", ["Couldn't add notes-work:", "Expected http:// or https:// URL", "Nothing saved."]],
  ["screen=add-server-checking&name=notes-work", ["Checking what the gateway has…"]],
  ["screen=signin-starting&id=calendrop", ["Sign in to Calendrop", "Asking the gateway to start the sign-in…", "Cancel"]],
  ["screen=signin-waiting&id=calendrop&app=preview", ["Sign in on Calendrop's page.", "auth.calendrop.example", "https://auth.calendrop.example/authorize?response_type=code", "Open in your browser", "Waiting for the sign-in. This works for 10 minutes.", "Cancel"]],
  ["screen=signin-waiting&id=calendrop&app=preview&opened=1", ["Opened in a new tab of your browser."]],
  ["screen=signin-done&id=calendrop", ["Signed in to Calendrop.", "The gateway keeps the sign-in."]],
  ["screen=signin-failed&id=calendrop", ["Sign-in didn't finish.", "Sign-in did not finish. Check the connector settings and try again, or run openclaw mcp login with this connector's name in this Gateway's terminal.", "Try again"]],
  ["screen=signin-expired&id=calendrop", ["The sign-in expired", "before it finished."]],
  ["screen=signin-cancelled&id=calendrop", ["Sign-in cancelled."]],
  ["screen=signin-dropped&id=calendrop", ["The sign-in ended with the connection.", "A sign-in belongs to the connection that started it."]],
  ["screen=signin-cannot&id=calendrop", ["The gateway can't start this sign-in from here.", "This connector cannot use operator browser sign-in. Check its existing account settings."]],
  ["screen=signin-cli&id=calendrop", ["The gateway starts this sign-in from its own command line or its own settings page.", "On the gateway's machine, run:", "openclaw mcp login calendrop", "It prints an address. Open it in a browser and sign in to Calendrop.", "MCP OAuth credentials saved", "openclaw mcp login calendrop --code <code>", "Or sign in from Settings on the gateway's own web page."]],
  ["screen=signin-waiting&id=calendrop&app=preview&loopback=1", ["The sign-in page returns to the gateway's own address, which only a browser on the gateway's machine can reach.", "openclaw mcp login calendrop"]],
  ["screen=signin-waiting&id=notes-work&server=1", ["Sign in to notes-work", "auth.notes.example"]],
  ["screen=chat", ["Add today's standup to team-notes.", "Connect your team-notes account", "Pip asked to use team-notes for you. After you sign in, its tools reach Pip from your next message.", "auth.teamnotes.example", "https://auth.teamnotes.example/authorize?response_type=code", "Open in your browser", "Anyone who opens this link signs in for you."]],
  ["screen=chat&card=opened", ["Opened at 5:12 PM. If the page didn't finish, open it again.", "Reopen"]],
  ["screen=chat&card=connected", ["Connected team-notes. Its tools reach Pip from your next message."]],
  ["screen=chat&card=error", ["team-notes can't ask you to sign in here:", "gateway.publicOrigin is not configured"]],
  ["screen=picker", ["What do you use every day?", "Pick the apps you use. Nothing is connected now; they come first in Connect apps.", "Search apps", "Quillnote", "Huddlewick", "Skip", "Next"]],
];
for (const [query, words] of STATES) {
  const p = await open(query);
  const t = await text(p);
  const lack = missing(t, words);
  check(`state ${query}`, !lack && p.errors.length === 0, [lack, ...p.errors].filter(Boolean).join(" | "));
  await p.close();
}

// Structure: what the document cuts is not drawn.
{
  const p = await open("screen=add-server");
  const t = await text(p);
  check("no Client ID or Client Secret field (cut, R§5)", !/client id|client secret/i.test(t));
  check("a header's value is a password field", (await p.locator("#c-h-value").getAttribute("type")) === "password");
  await p.close();
  const q = await open("screen=browse");
  check("no picture of any connector: only drawn initials", (await q.locator(".c-window img").count()) === 0 && (await q.locator(".c-initial").count()) > 0);
  check("no state is drawn as Connected", !(await text(q)).includes("Connected"));
  await q.close();
  const r = await open("screen=connector&id=tasktide");
  check("a signed-in connector never says Connected", !(await text(r)).includes("Connected"));
  check("the section's title takes focus", await r.evaluate(() => document.activeElement?.id === "c-section-title"));
  await r.close();
  const s = await open("screen=remove-confirm&id=tasktide");
  check("a confirmation is an alertdialog with focus on Cancel", (await s.locator("[role=alertdialog]").count()) === 1 && (await s.evaluate(() => document.activeElement?.textContent)) === "Cancel");
  await s.close();
  const u = await open("screen=connector&id=linkpeek");
  check("a connector that comes with OpenClaw has no Remove", (await u.getByRole("link", { name: "Remove…" }).count()) === 0);
  await u.close();
  const v = await open("screen=browse&access=read");
  check("below admin, Add is absent, not disabled", (await v.locator(".c-row-end .button").count()) === 0 && (await text(v)).includes("Request admin access"));
  await v.close();
  const w = await open("screen=browse-offline");
  check("without the catalog nothing offers Add", (await w.locator(".c-row-end .button").count()) === 0 && (await w.locator(".c-chips").count()) === 0);
  await w.close();
}

// Part 2: the walks, clicked through, each destination asserted -----------------------------------
async function walk(name, start, stepsList, finalWords = []) {
  const p = await open(start);
  let ok = true;
  let where = start;
  for (const [action, expect] of stepsList) {
    try {
      await action(p);
    } catch (e) {
      ok = false;
      where = `${await screenOf(p)}: ${e.message.split("\n")[0]}`;
      break;
    }
    if (expect && !(await at(p, expect))) {
      ok = false;
      where = `${await screenOf(p)} (expected ${expect})`;
      break;
    }
    await p.waitForTimeout(40);
    where = expect || where;
  }
  const lack = ok ? missing(await text(p), finalWords) : "";
  check(`walk: ${name}`, ok && !lack && p.errors.length === 0, ok ? [lack, ...p.errors].filter(Boolean).join(" | ") : `stopped at ${where}`);
  await p.close();
}

await walk("Connect apps, add a connector, sign in, signed in", "screen=home", [
  [link("Connect apps"), "browse"],
  [row("Quillnote"), "app"],
  [link("Add"), "add-confirm"],
  [link("Add"), "add-progress"],
  [link("Added"), "add-done"],
  [link("Open Quillnote"), "connector"],
  [link("Sign in"), "signin-cli"],
], ["openclaw mcp login quillnote", "openclaw mcp login quillnote --code <code>"]);
await walk("the web preview: sign in in the browser, then the page shows what the gateway reports", "screen=connector&id=calendrop&app=preview", [
  [link("Sign in"), "signin-starting"],
  [link("With a sign-in page"), "signin-waiting"],
  [link("Open in your browser"), "signin-waiting"],
  [link("Approved"), "signin-done"],
  [link("Done"), "connector"],
], ["Signed in.", "Whether it still works shows when a bot next uses Calendrop."]);
{
  const p = await open("screen=connector&id=calendrop");
  await link("Sign in")(p);
  await at(p, "signin-cli");
  check("the desktop app never offers the browser sign-in", !(await text(p)).includes("Open in your browser") && !(await text(p)).includes("Asking the gateway"));
  await p.close();
  const q = await open("screen=signin-waiting&id=calendrop&app=preview");
  const order = await q.evaluate(() => {
    const addr = document.querySelector(".c-address");
    const btn = [...document.querySelectorAll(".c-open a")].find((a) => a.textContent === "Open in your browser");
    return Boolean(addr && btn && addr.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  check("the full sign-in address is shown before its button", order);
  await q.close();
}
await walk("Add from a row, cancelled", "screen=browse", [[link("Add Quillnote"), "add-confirm"], [link("Cancel"), "app"]], ["What it adds"]);
await walk("add: a capability review, then a failure after writing", "screen=add-confirm&id=quillnote", [
  [link("A review"), "add-confirm"],
  [link("Add"), "add-consent"],
  [link("Add anyway"), "add-progress"],
  [link("Fails after writing"), "add-partial"],
], ["was installed but didn't start"]);
await walk("add: an install warning", "screen=add-confirm&id=quillnote", [[link("An install warning"), "add-confirm"], [link("Add"), "add-warning"], [link("Add anyway"), "add-progress"], [link("Needs a restart"), "add-restart"]], ["needs a restart"]);
await walk("add: refused, then try again", "screen=add-progress&id=quillnote", [[link("Refused"), "add-refused"], [link("Try again"), "add-confirm"]]);
await walk("add: no answer, then the read-back lists it", "screen=add-progress&id=quillnote", [[link("No answer"), "add-checking"], [link("Lists it"), "add-done"]], ["Added Quillnote."]);
await walk("add: no answer, then the read-back doesn't list it", "screen=add-progress&id=quillnote", [[link("No answer"), "add-checking"], [link("Doesn't list it"), "add-refused"]], ["The gateway lists nothing new."]);
await walk("the catalog can't be reached, try again", "screen=browse-loading", [
  [link("Can't be reached"), "browse-offline"],
  [link("Try again"), "browse-retry"],
  [link("Still can't be reached"), "browse-offline"],
  [typeIn("#c-q", "tide")],
], ["Tasktide", "Searching skills needs the catalog."]);
await walk("the catalog loads after 4 s", "screen=browse-loading", [[link("4 s pass"), "browse-loading"], [link("Answers"), "browse"]], ["Recommended for you"]);
await walk("the gateway refuses the catalog, try again", "screen=browse-loading", [[link("The gateway refuses"), "browse-error"], [link("Try again"), "browse-loading"]]);
await walk("search across apps and skills", "screen=browse", [[typeIn("#c-q", "weekly")]], ["Skills", "Weekly review"]);
await walk("search with no match", "screen=browse", [[typeIn("#c-q", "zzzz")]], ['No apps or skills match "zzzz".']);
const chip = (name) => (p) => p.getByRole("radio", { name, exact: true }).click();
await walk("Show more asks the next page", "screen=browse", [[link("Show more"), "browse"]], ["Mapwhistle", "Tunebarrow"]);
await walk("a category chip", "screen=browse", [[chip("Finance"), "browse-category"], [chip("All"), "browse"]], ["All apps"]);
await walk("turn a connector on, then off", "screen=installed", [
  [row("Ledgerkin"), "connector"],
  [link("Turn on"), "connector"],
  [link("Turn off"), "turnoff-confirm"],
  [inConfirm("Turn off"), "connector"],
], ["Turned off Ledgerkin.", "Turn on"]);
await walk("turn off while the gateway is busy, then try again", "screen=turnoff-confirm&id=tasktide", [[link("Busy with another change"), "turnoff-confirm"], [inConfirm("Turn off"), "connector"], [link("Try again"), "turnoff-confirm"]]);
{
  const p = await open("screen=installed");
  check("the plugins that come with OpenClaw are folded", !(await p.locator(".c-fold .c-rows").isVisible()));
  await p.locator(".c-fold > summary").click();
  check("and open in place", await p.locator('.c-fold .c-row-main[aria-label^="Linkpeek,"]').isVisible());
  await p.close();
}
await walk("remove a connector", "screen=installed", [[row("Tasktide"), "connector"], [link("Remove…"), "remove-confirm"], [link("Remove"), "removed"], [link("Back to the list"), "installed"]]);
await walk("remove a tool server", "screen=installed", [[row("notes-work"), "server"], [link("Remove…"), "server-remove-confirm"], [link("Remove"), "server-removed"]], ["Removed notes-work."]);
await walk("a tool server still listed after removal", "screen=server-remove-confirm&id=notes-work", [[link("Still lists it"), "server-remove-failed"], [link("Try again"), "server-remove-confirm"]]);
await walk("add another account to a tool server", "screen=server&id=notes-work", [[link("Add another account"), "add-server"]]);
{
  const p = await open("screen=server&id=notes-work");
  await link("Add another account")(p);
  await at(p, "add-server");
  check("Add another account keeps the address and leaves the name empty", (await p.inputValue("#c-url")) === "https://notes.example/mcp" && (await p.inputValue("#c-name")) === "");
  await p.close();
}
await walk("sign in to a tool server (web preview)", "screen=server&id=notes-work&app=preview", [[link("Sign in"), "signin-starting"], [link("With a sign-in page"), "signin-waiting"], [link("Approved"), "signin-done"], [link("Done"), "server"]], ["Last signed in from Clawtrate: Nov 19, 5:12 PM.", "Not reported."]);
await walk("sign-in in the web preview: the gateway answers with its command line", "screen=connector&id=calendrop&app=preview", [[link("Sign in"), "signin-starting"], [link('"Open Settings on this Gateway…"'), "signin-cli"]], ["openclaw mcp login calendrop"]);
await walk("sign-in: the gateway can't start it", "screen=signin-starting&id=calendrop", [[link('"This connector cannot…"'), "signin-cannot"]]);
for (const [label, to] of [["Refused", "signin-failed"], ["10 minutes pass", "signin-expired"], ["Drop connection", "signin-dropped"]]) {
  await walk(`sign-in: ${label}, then try again`, "screen=signin-waiting&id=calendrop&app=preview", [[link(label), to], [link("Try again"), "signin-starting"]]);
}
await walk("sign-in: cancelled", "screen=signin-waiting&id=calendrop&app=preview", [[link("Cancel"), "signin-cancelled"], [link("Back"), "connector"]]);
await walk("add a server by address: Clawtrate's checks, then saved", "screen=add-server", [
  [submit],
  [typeIn("#c-name", "notes-work")],
  [typeIn("#c-url", "http://notes.example/mcp")],
  [submit],
], ["There's already a server named notes-work.", "Use the server's https:// URL."]);
{
  const p = await open("screen=add-server");
  await submit(p);
  await p.waitForTimeout(50);
  const t = await text(p);
  check("an empty form names both required fields, and focuses the first", t.includes("Enter a name.") && t.includes("Enter the server's URL.") && (await p.evaluate(() => document.activeElement?.id)) === "c-name");
  await p.fill("#c-name", "notes-home");
  await p.fill("#c-url", "not an address");
  await submit(p);
  await p.waitForTimeout(50);
  check("a URL that is not one", (await text(p)).includes("Enter a URL that starts with https://."));
  await p.fill("#c-url", "http://127.0.0.1:8080/mcp");
  await submit(p);
  await p.waitForTimeout(50);
  check("a non-HTTPS URL is refused, even on loopback, and nothing is saved", (await text(p)).includes("Use the server's https:// URL.") && (await screenOf(p)) === "add-server");
  await p.fill("#c-url", "https://notes-home.example/mcp");
  await p.locator("input[name=signin][value=oauth]").check();
  await submit(p);
  check("an https URL is saved", await at(p, "add-server-saved"));
  check("with OAuth, Sign in is the next step", (await p.getByRole("link", { name: "Sign in", exact: true }).count()) === 1);
  await link("Refused")(p);
  check("then the gateway refuses it", await at(p, "add-server-refused"));
  await p.close();
}
{
  const p = await open("screen=add-server");
  await p.locator("input[name=signin][value=each]").check();
  check("each person signs in: the public address line shows", await p.locator("#c-each-line").isVisible());
  await p.close();
}
await walk("add a server started by a command, through its confirmation", "screen=add-server&type=command", [
  [submit],
  [typeIn("#c-name", "search-local")],
  [typeIn("#c-command", "/opt/example/bin/search-server")],
  [typeIn("#c-args", "--stdio\n--index ./notes")],
  [submit, "command-confirm"],
  [link("Run it on the gateway"), "add-server-saved"],
], ["Added search-local.", "The gateway will run it at a bot's next run."]);
{
  const p = await open("screen=add-server&type=command");
  await p.fill("#c-name", "search-local");
  await submit(p);
  await p.waitForTimeout(50);
  check("an empty command is refused by Clawtrate", (await text(p)).includes("Enter the command.") && (await screenOf(p)) === "add-server");
  await p.fill("#c-command", "/opt/example/bin/search-server");
  await p.fill("#c-args", "--stdio\n--index ./notes");
  await submit(p);
  await at(p, "command-confirm");
  const shown = await p.locator(".c-cmd").textContent();
  check("the confirmation shows the exact command and every argument, one per line", shown === "/opt/example/bin/search-server\n--stdio\n--index ./notes");
  await p.keyboard.press("Escape");
  check("Escape in the confirmation is Cancel", await at(p, "add-server"));
  await p.close();
}
await walk("the connect card, opened and reopened", "screen=chat", [[link("Open in your browser"), "chat"], [link("Reopen"), "chat"]], ["Reopen", "Opened at 5:12 PM."]);
await walk("the connect card in a shared task", "screen=chat", [[link("In a shared task"), "chat"]], ["Anyone who opens this link signs in for you."]);
{
  const p = await open("screen=chat&shared=1");
  check("in a shared task, the warning line is in --warn", (await p.locator(".c-card .c-line").getAttribute("data-tone")) === "warn");
  await p.close();
}
await walk("the connect card: no public address", "screen=chat", [[link("No public address"), "chat"]], ["gateway.publicOrigin is not configured"]);
await walk("the connect card: already connected", "screen=chat", [[link("Already connected"), "chat"]], ["Connected team-notes."]);
await walk("what do you use every day: tick, then Browse leads with them", "screen=home", [
  [link("What do you use every day?"), "picker"],
  [tick("Quillnote")],
  [tick("Calendrop")],
  [link("Next"), "browse"],
], ["You picked", "Quillnote", "Calendrop"]);
await walk("what do you use every day: search, then skip", "screen=picker", [[typeIn("#c-q", "tune")], [link("Skip"), "home"]]);
{
  const p = await open("screen=picker");
  await p.fill("#c-q", "tune");
  await p.waitForTimeout(40);
  check("the picker's search filters the tiles", (await p.locator(".c-tiles li:not([hidden])").count()) === 1);
  await p.close();
}
await walk("read-only: request admin access, approved, then Add", "screen=app&id=quillnote&access=read", [
  [link("Request admin access"), "app"],
  [link("Files the request"), "app"],
  [link("Approves"), "app"],
], ["Admin access granted.", "Add"]);
await walk("read-only: the request denied", "screen=connector&id=tasktide&access=read&req=requested", [[link("Denies"), "connector"]], ["The request was denied.", "Request again"]);
await walk("read-only: the request expired", "screen=connector&id=tasktide&access=read&req=requested", [[link("Lets it expire"), "connector"]], ["The request expired", "Request again"]);
{
  const p = await open("screen=connector&id=tasktide&access=read&req=requested");
  check("a waiting request shows the approve command and the request id", (await text(p)).includes("openclaw devices approve 3f9a2c71") && (await text(p)).includes("Request 3f9a2c71"));
  await p.close();
}
{
  const p = await open("screen=browse");
  await p.keyboard.press("Escape");
  check("Escape closes the window", await at(p, "home"));
  await p.close();
}
await walk("On this gateway, from the section list", "screen=browse", [[link("On this gateway"), "installed"], [link("Add a custom connector"), "add-server"]]);

// Part 3: widths, themes, phone ----------------------------------------------------------------
for (const width of [1440, 1100, 800]) {
  const p = await open("screen=browse", { width });
  const box = await p.locator(".c-window").boundingBox();
  check(`at ${width}, the window is the Settings frame, both panes`, box && box.width <= 800 && (await p.locator(".c-nav").isVisible()) && (await p.locator(".c-section").isVisible()));
  await p.close();
}
{
  const p = await open("screen=browse", { width: 390, height: 844 });
  const box = await p.locator(".c-window").boundingBox();
  check("at 390, the window is a sheet the width of the screen, one pane", box && box.width === 390 && !(await p.locator(".c-nav").isVisible()) && (await p.locator(".c-section").isVisible()));
  const scroll = await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  check("at 390, no sideways scroll of the page", scroll);
  await p.getByRole("link", { name: "Back" }).first().click();
  check("at 390, Back goes to the section list", await at(p, "nav"));
  check("at 390, the section list stands alone", await p.locator(".c-nav").isVisible());
  await p.close();
}
{
  const p = await open("screen=browse", { theme: "dark" });
  const bg = await p.evaluate(() => getComputedStyle(document.querySelector(".c-window")).backgroundColor);
  const fg = await p.evaluate(() => getComputedStyle(document.querySelector(".c-row-name")).color);
  check("dark theme: the window and its text take the dark tokens", bg !== "rgb(255, 255, 255)" && fg !== "rgb(0, 0, 0)", `${bg} ${fg}`);
  await p.close();
}
{
  const p = await open("screen=browse-loading&motion=reduce");
  const anim = await p.evaluate(() => getComputedStyle(document.querySelector(".c-grey-row")).animationName);
  check("reduced motion: the loading rows don't shimmer", anim === "none");
  await p.close();
}

await b.close();
console.log(out.join("\n"));
console.log(failed ? `${failed} failed` : `all ${out.length} checks passed`);
process.exit(failed ? 1 : 0);
