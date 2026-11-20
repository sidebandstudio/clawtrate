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
// After a server write is sent: the gateway accepts it, and a fresh read matches what was reviewed.
const finishWrite = async (p) => {
  if (await p.getByRole("link", { name: "Accepted", exact: true }).count()) await p.getByRole("link", { name: "Accepted", exact: true }).click();
  if (await p.getByRole("link", { name: "Matches every reviewed field", exact: true }).count()) await p.getByRole("link", { name: "Matches every reviewed field", exact: true }).click();
  await p.waitForTimeout(60);
};
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
  ["screen=add-confirm&id=quillnote", ["Add Quillnote to the gateway?", "Package: @quillnote-labs/quillnote, from ClawHub.", "Version 2.4.1, the release reviewed here.", "The gateway installs this package and can run it with the gateway's access. The gateway will tell you if it needs a restart.", "Cancel", "Add"]],
  ["screen=add-confirm&id=chartwick", ["from the gateway's official catalog", "The gateway picks the release from its catalog."]],
  ["screen=add-consent&id=quillnote", ["Quillnote asks for more than the catalog listed.", "before_tool_call", "Add anyway"]],
  ["screen=add-warning&id=quillnote", ["The gateway's install check found something.", "Warning:", "line 12", "Add anyway"]],
  ["screen=add-progress&id=quillnote", ["Adding Quillnote", "Finding the release", "Downloading", "Unpacking", "Writing files", "Installing what it needs", "Starting it on the gateway"]],
  ["screen=add-done&id=quillnote", ["Added Quillnote.", "The gateway lists it as installed and turned on.", "Open Quillnote"]],
  ["screen=add-restart&id=quillnote", ["The gateway says it needs a restart before Quillnote works. Clawtrate doesn't restart the gateway."]],
  ["screen=add-refused&id=quillnote", ["Couldn't add Quillnote:", "The gateway lists nothing new.", "Try again"]],
  ["screen=add-partial&id=quillnote", ["Quillnote was installed but didn't start:"]],
  ["screen=add-checking&id=quillnote", ["Checking what the gateway has…"]],
  ["screen=installed", ["Turned on", "Turned off", "Comes with OpenClaw (3)", "Tool servers", "notes-work", "Added by address", "search-index", "Runs a command", "Add a custom connector"]],
  ["screen=connector&id=tasktide&busy=1", ["The gateway is busy with another change.", "Try again in a moment.", "Try again"]],
  ["screen=connector&id=tasktide", ["Tasktide", "Added", "Tools", "tasktide, a tool server", "Which bots may use these is in each bot's settings.", "Accounts", "tasktide · Shared by everyone on this gateway", "Signed in.", "The gateway reports saved sign-in tokens.", "Whether they still work isn't reported.", "Turn off", "Remove…"]],
  ["screen=connector&id=calendrop", ["calendrop · Shared by everyone on this gateway", "Needs sign-in."]],
  ["screen=connector&id=calendrop&auth=requires-authorization", ["Needs sign-in again."]],
  ["screen=connector&id=calendrop&auth=pending-authorization", ["Sign-in pending."]],
  ["screen=connector&id=calendrop&auth=none", ["Sign-in status not reported."]],
  ["screen=connector&id=ledgerkin", ["Turned off. Its tools aren't offered to any bot.", "Turn on", "The gateway reports sign-ins only while Ledgerkin is turned on."]],
  ["screen=connector&id=postlark", ["Needs setup. Open Settings on the gateway to finish setup.", "The gateway reports missing: Account address."]],
  ["screen=connector&id=boxwharf", ["Not working: boxwharf-sync: the token store couldn't be read"]],
  ["screen=connector&id=linkpeek", ["Comes with OpenClaw", "Added. Not loaded yet: it loads when a bot first needs it.", "Comes with OpenClaw, so it can be turned off but not removed."]],
  ["screen=connector&id=tasktide&access=read", ["Read-only.", "Changing connectors needs admin access.", "Request admin access"]],
  ["screen=turnoff-confirm&id=tasktide", ["Turn off Tasktide?", "The gateway stops offering its tools. Its settings and any saved sign-ins stay."]],
  ["screen=remove-confirm&id=tasktide", ["Remove Tasktide from the gateway?", "The package @tasktide/tasktide, with: Tasktide, Tasktide sync.", "Goes", "the package's files on the gateway's machine", "its settings on the gateway", "its tools", "Stays", "any saved sign-ins, kept by the gateway in its state, not encrypted there", "a note on the gateway that Tasktide is off, so nothing turns it back on by itself"]],
  ["screen=removed&id=tasktide", ["Removed Tasktide.", "No longer installed: Tasktide, Tasktide sync."]],
  ["screen=removed-unconfirmed&id=tasktide", ["Couldn't confirm the removal.", "Check again"]],
  ["screen=browse&readonly=1", ["This gateway's settings are read-only.", "Plugins and tool servers can't be changed here."]],
  ["screen=connector&id=tasktide&readonly=1", ["This gateway's settings are read-only."]],
  ["screen=server&id=notes-work", ["notes-work", "Name on the gateway", "Added by address", "https://notes.example/mcp", "Authorization", "Hidden: the gateway doesn't show saved values. Kept by the gateway in its settings file, not encrypted there.", "Signs in with OAuth", "Gateway tool listing", "Gateway tool listing for Pip's task, read at 5:12 PM: 8 tools", "A listing shows what the gateway has discovered for this task. A bot's tool rules still decide what it is offered.", "Sign-in", "Not reported.", "The gateway doesn't report whether it's signed in to this server, or for whom. A bot's run shows whether its tools work.", "Sign in", "Accounts", "A second name for the same server, with its own sign-in. Bots tell them apart by name.", "Add another account", "Remove…"]],
  ["screen=server&id=notes-work&last=notyet", ["The gateway hasn't listed this server's tools for this task."]],
  ["screen=server&id=notes-work&last=unavailable", ["Gateway tool listing for Pip's task, read at 5:12 PM:", "server unavailable"]],
  ["screen=server&id=notes-work&last=none", ["Not reported: the gateway's tool listing for this task doesn't mention this server."]],
  ["screen=server&id=search-index", ["Runs a command", "Program", "/opt/example/bin/search-server", "Arguments", "--stdio", "./notes", "spawn /opt/example/bin/search-server ENOENT"]],
  ["screen=server&id=team-notes", ["Uses the gateway's requester sign-in. Set up and use it in a channel where the gateway identifies each sender.", "Clawtrate offers no sign-in for it."]],
  ["screen=server&id=notes-work&device=iphone", ["Change it from Clawtrate on your computer."]],
  ["screen=server-remove-confirm&id=notes-work", ["Remove notes-work from the gateway?", "the server's entry in the gateway's settings, with its headers", "its tools", "Removing this entry leaves any saved MCP sign-ins in the gateway's state. The gateway keeps them unencrypted.", "To clear them, run this on the gateway's machine before removing the entry:", "openclaw mcp logout notes-work", "openclaw mcp unset notes-work"]],
  ["screen=server-remove-confirm&id=team-notes", ["Removing this entry leaves any saved MCP sign-ins in the gateway's state. The gateway keeps them unencrypted.", "To remove it and clear them, run this on the gateway's machine instead:", "openclaw mcp unset team-notes"]],
  ["screen=server-remove-confirm&id=search-index", ["Remove search-index from the gateway?"]],
  ["screen=add-server", ["Add a custom connector", "Type", "Remote HTTPS", "Command", "Name", "Server URL", "Headers", "Kept by the gateway in its settings file, not encrypted there. Clawtrate can't read a value back once it's saved.", "Sign-in", "None", "Sign in with OAuth", "The gateway handles OAuth registration and credentials.", "Add to gateway"]],
  ["screen=add-server&type=command", ["Command", "Arguments", "One per line. Each line is one argument: spaces at its start and end are removed, spaces inside it stay, and an empty line is dropped. Nothing goes through a shell.", "Working folder", "The gateway can start this program on its own machine, as the user it runs as, when it needs this server. The program has that user's access to files, programs and the network.", "The gateway can show saved commands and arguments to operators who can read its settings.", "Continue"]],
  ["screen=add-server&access=read", ["Read-only.", "Adding a custom connector needs admin access."]],
  ["screen=signin-cli&id=notes-work&server=1", ["Sign in to notes-work", "On the gateway's machine, run:", "openclaw mcp login notes-work", "If it prints an address, open it in a browser and sign in.", "If the terminal is listening for the callback, it waits up to five minutes. Follow the terminal's instructions to finish with a code if the callback cannot reach it.", "It may also find a saved sign-in and say so without printing an address.", "Or sign in from Settings on the gateway's own web page.", "On return to Clawtrate, a raw entry still reads \"Not reported.\"", "Back to notes-work"]],
  ["screen=connector&id=calendrop", ["Open Settings on your OpenClaw gateway to sign in to calendrop.", "Check again"]],
  ["screen=connector&id=calendrop&checked=1", ["Read again at 5:12 PM."]],
  ["screen=chat", ["Add today's standup to team-notes.", "Used team-notes connect", "team-notes__connect"]],
  ["screen=chat&card=history", ["Used team-notes connect", "team-notes__connect", "Connect MCP server \"team-notes\" at", "https://auth.teamnotes.example/authorize?state=example-state-2c41"]],
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
  check("a header's value is a password field", (await p.locator(".c-h-value").first().getAttribute("type")) === "password");
  await p.close();
  const q = await open("screen=browse");
  check("no picture of any connector: only drawn initials", (await q.locator(".c-window img").count()) === 0 && (await q.locator(".c-initial").count()) > 0);
  check("no state is drawn as Connected", !(await text(q)).includes("Connected"));
  await q.close();
  const r = await open("screen=connector&id=tasktide");
  check("a signed-in connector never says Connected, and shows no expiry (ruling 8)", !(await text(r)).includes("Connected") && !/until|expire|Dec 17/i.test(await text(r)));
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

// Ruling 7: no screen claims a run, a time of use or every bot that has something.
{
  const claims = [];
  for (const q of ["screen=server&id=notes-work", "screen=server&id=notes-work&last=notyet", "screen=server&id=search-index", "screen=add-done&id=quillnote", "screen=remove-confirm&id=tasktide", "screen=server-remove-confirm&id=notes-work", "screen=chat"]) {
    const p = await open(q);
    if (/has run|next run|'s run at|from their next|Juniper, Pip/.test(await text(p))) claims.push(q);
    await p.close();
  }
  check("no screen claims a run, a time of use or every bot (ruling 7)", claims.length === 0, claims.join(" | "));
}

// Change 5: a read-only gateway says so on every page reachable from Browse, and nothing in a page leads to a write.
// The section list still opens the custom server page, which then says the settings are read-only.
{
  const WRITES = ["add-confirm", "add-consent", "add-warning", "add-progress", "turnoff-confirm", "remove-confirm", "server-remove-confirm", "add-server", "command-confirm", "write-sent", "write-read", "write-result"];
  const writesOn = (p) =>
    p.evaluate((writes) => {
      const to = [...document.querySelectorAll("#c-root .c-section a[href]")].map((a) => new URL(a.href).searchParams.get("screen")).filter((s) => writes.includes(s));
      const turns = [...document.querySelectorAll("#c-root .c-section a[href]")].filter((a) => new URL(a.href).searchParams.get("now")).length;
      const forms = document.querySelectorAll("#c-server-form, .c-confirm").length;
      return to.length + turns + forms;
    }, WRITES);
  const pages = ["browse", "browse-category&cat=productivity", "browse-offline", "app&id=quillnote", "app&id=mapwhistle", "installed", "connector&id=tasktide", "connector&id=calendrop", "connector&id=ledgerkin", "server&id=notes-work", "server&id=search-index", "add-server", "add-server&type=command", "add-refused&id=quillnote"];
  for (const tier of ["read", "admin"]) {
    const bad = [];
    for (const q of pages) {
      const p = await open(`screen=${q}&readonly=1&access=${tier}`);
      const t = await text(p);
      if (!t.includes("This gateway's settings are read-only. Plugins and tool servers can't be changed here.") || t.includes("Request admin access") || (await writesOn(p)) > 0) bad.push(q);
      await p.close();
    }
    check(`read-only gateway at the ${tier} tier: every page says so and offers no write and no request`, bad.length === 0, bad.join(" | "));
  }
  const d = await open("screen=browse&access=read");
  check("a writable gateway's read-only device still sees the access bar", (await text(d)).includes("Read-only. Adding apps needs admin access.") && (await text(d)).includes("Request admin access") && !(await text(d)).includes("This gateway's settings are read-only."));
  await d.close();
  const p = await open("screen=installed&device=iphone", { width: 390, height: 844 });
  check("iPhone: On this gateway offers no custom connector", (await p.getByRole("link", { name: "Add a custom connector" }).count()) === 0);
  await p.locator('.c-row-main[aria-label^="notes-work,"]').click();
  await at(p, "server");
  check("iPhone at 390: the server's page opens, with no Remove and no Add another account", (await text(p)).includes("Change it from Clawtrate on your computer.") && (await writesOn(p)) === 0 && (await p.getByRole("link", { name: /Remove|Add another account/ }).count()) === 0);
  await p.goto(`${base}&theme=light&screen=add-server&device=iphone`);
  check("iPhone: the custom connector form isn't drawn even from its address", (await p.locator("#c-server-form").count()) === 0 && (await text(p)).includes("Change it from Clawtrate on your computer."));
  await p.close();
}
{
  const p = await open("screen=browse&readonly=1&access=read");
  check("read-only gateway settings: no Add, and no request for admin access (ruling 10)", (await p.locator(".c-row-end .button").count()) === 0 && !(await text(p)).includes("Request admin access"));
  await p.close();
  const q = await open("screen=connector&id=tasktide&readonly=1");
  check("read-only gateway settings: no Turn off and no Remove", (await q.getByRole("link", { name: /Turn off|Remove/ }).count()) === 0);
  await q.close();
  const r = await open("screen=connector&id=pathfinder");
  check("Comes with OpenClaw only for a bundled plugin", (await text(r)).includes("Comes with OpenClaw"));
  await r.close();
  const t = await open("screen=connector&id=tasktide");
  check("a plugin that isn't bundled never says Comes with OpenClaw", !(await text(t)).includes("Comes with OpenClaw"));
  await t.close();
}

// Change 1: gateway strings with inert markup render as text, and nothing opens.
{
  const cases = [
    ["screen=browse&marked=1", "Quillnote <em>beta</em>", "Notes <em>and</em> notebooks."],
    ["screen=app&id=quillnote&marked=1", "Quillnote <em>beta</em>", "quillnote-<em>labs</em>"],
    ["screen=connector&id=postlark&marked=1", "<em>Account</em> address"],
    ["screen=add-refused&id=quillnote&marked=1", "fetch failed <em>offline</em>"],
    ["screen=server&id=notes-work&last=unavailable&marked=1", "fetch failed <em>refused</em>"],
  ];
  for (const [width, label] of [[1440, "desktop"], [390, "phone"]]) {
    for (const [q, ...words] of cases) {
      const p = await open(q, { width, height: width === 390 ? 844 : 900 });
      const requests = [];
      p.on("request", (r) => {
        if (/^https?:/.test(r.url())) requests.push(r.url());
      });
      const t = await text(p);
      const lack = missing(t, words);
      const marks = await p.evaluate(() => document.querySelectorAll("#c-root em").length);
      check(`${label}: ${q}: gateway markup is shown as text, and nothing is requested (change 1)`, !lack && marks === 0 && requests.length === 0, [lack, marks ? `${marks} <em> elements` : "", ...requests].filter(Boolean).join(" | "));
      await p.close();
    }
  }
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
  [link("Check again"), "connector"],
], ["Open Settings on your OpenClaw gateway to sign in to quillnote.", "Read again at 5:12 PM."]);
{
  const p = await open("screen=connector&id=calendrop");
  check("a plugin's server gives no terminal command and no Sign in (ruling 3)", (await p.getByRole("link", { name: "Sign in", exact: true }).count()) === 0 && !(await text(p)).includes("openclaw mcp login"));
  await p.close();
  const s2 = await open("screen=server&id=notes-work");
  await link("Sign in")(s2);
  await at(s2, "signin-cli");
  check("neither app offers a browser sign-in (ruling 2)", !(await text(s2)).includes("Open in your browser") && !(await text(s2)).includes("Asking the gateway"));
  await s2.close();
}
// Change 6: account rows and sign-in instructions belong to the servers eligible for them.
{
  const p = await open("screen=connector&id=calendrop");
  const rowText = (n) => text(p, `.c-account[data-server="${n}"]`);
  const a = await rowText("calendrop");
  const r = await rowText("calendrop-rooms");
  const f = await rowText("calendrop-files");
  check("two reported account rows, each with its own state and shared label", a.includes("calendrop · Shared by everyone on this gateway") && a.includes("Needs sign-in.") && !a.includes("Signed in.") && r.includes("calendrop-rooms · Shared by everyone on this gateway") && r.includes("Signed in. The gateway reports saved sign-in tokens.") && !r.includes("Needs sign-in"), `${a} | ${r}`);
  check("each reported row names its own server in the Settings instruction", a.includes("Open Settings on your OpenClaw gateway to sign in to calendrop.") && r.includes("Open Settings on your OpenClaw gateway to sign in to calendrop-rooms."));
  check("a declared server missing from the reply: its name and Sign-in status not reported, no ownership claim and no instruction", f.includes("calendrop-files") && f.includes("Sign-in status not reported.") && !/Shared|yours|your account|Open Settings|Sign in/.test(f), f);
  check("no date on a status until it is read again", !(await text(p)).includes("Read again at"));
  await p.close();
  const n = await open("screen=connector&id=calendrop&auth=none");
  check("with no reported row there is no Settings instruction and no Check again", !(await text(n)).includes("Open Settings on your OpenClaw gateway") && (await n.getByRole("link", { name: "Check again" }).count()) === 0);
  await n.close();
  const e = await open("screen=server&id=notes-work&gwprofile=work");
  await link("Sign in")(e);
  await at(e, "signin-cli");
  check("the eligible raw entry's command names it and carries the known profile", (await text(e)).includes("openclaw --profile work mcp login notes-work"));
  await e.close();
  const x = await open("screen=server&id=notes-profile&gwprofile=work");
  const xt = await text(x);
  check("an auth-profile entry: no Sign in, no second account, no command", (await x.getByRole("link", { name: /^Sign in$|Add another account/ }).count()) === 0 && !xt.includes("openclaw") && !xt.includes("A second name for the same server") && xt.includes("Not reported."));
  await x.close();
  const xr = await open("screen=server-remove-confirm&id=notes-profile&gwprofile=work");
  const xrt = await text(xr, ".c-confirm");
  check("removing an auth-profile entry keeps the Stays sign-in line and gives no logout directions", xrt.includes("Removing this entry leaves any saved MCP sign-ins in the gateway's state. The gateway keeps them unencrypted.") && !xrt.includes("openclaw mcp") && !xrt.includes("logout"));
  await xr.close();
  const er = await open("screen=server-remove-confirm&id=notes-work&gwprofile=work");
  const ert = await text(er, ".c-confirm");
  check("removing the eligible entry gives profile-qualified logout and unset", ert.includes("openclaw --profile work mcp logout notes-work") && ert.includes("openclaw --profile work mcp unset notes-work"));
  await er.close();
  const s = await open("screen=server-remove-confirm&id=search-index");
  check("an entry without an OAuth mode has no Stays sign-in line", !(await text(s, ".c-confirm")).includes("sign-in") && (await s.locator(".c-confirm h4", { hasText: "Stays" }).count()) === 0);
  await s.close();
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
await walk("search when skills search fails: never No match for skills", "screen=browse&skills=fail", [[typeIn("#c-q", "zzzz")]], ["Skills search didn't answer.", "No apps match."]);
await walk("removal: the read fails", "screen=remove-confirm&id=tasktide", [[link("The read fails"), "removed-unconfirmed"], [link("Check again"), "removed"]], ["No longer installed"]);
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
await walk("add another account to a tool server", "screen=server&id=notes-work", [[link("Add another account"), "add-server"]]);
for (const [width, label] of [[1440, "desktop"], [390, "phone"]]) {
  const p = await open("screen=server&id=notes-work", { width, height: width === 390 ? 844 : 900 });
  await link("Add another account")(p);
  await at(p, "add-server");
  const names = await p.locator(".c-h-name").evaluateAll((els) => els.map((e) => e.value));
  const values = await p.locator(".c-h-value").evaluateAll((els) => els.map((e) => e.value));
  check(`${label}: Add another account fills in the address and both header names, and leaves the name and every value empty (change 3)`, (await p.inputValue("#c-url")) === "https://notes.example/mcp" && (await p.inputValue("#c-name")) === "" && JSON.stringify(names) === '["Authorization","X-Workspace"]' && JSON.stringify(values) === '["",""]' && (await text(p)).includes("Enter any header values this server needs. Saved values are hidden."), JSON.stringify(names));
  await p.fill("#c-name", "notes-home");
  await submit(p);
  await finishWrite(p);
  check(`${label}: the second account is added`, (await text(p)).includes("Added notes-home.") && (await text(p)).includes("The gateway hides saved header values."));
  await link("Open notes-home")(p);
  await at(p, "server");
  const detail = await text(p);
  check(`${label}: its page shows its own name, the same address, both header names and OAuth`, detail.includes("notes-home") && detail.includes("https://notes.example/mcp") && detail.includes("Authorization") && detail.includes("X-Workspace") && detail.includes("Signs in with OAuth"));
  await p.close();
}
{
  const each = await open("screen=server&id=team-notes");
  const cmd = await open("screen=server&id=search-index");
  check("Add another account only for a shared OAuth server", (await each.getByRole("link", { name: "Add another account" }).count()) === 0 && (await cmd.getByRole("link", { name: "Add another account" }).count()) === 0);
  await each.close();
  await cmd.close();
}
await walk("sign in to a tool server: the gateway's own steps, then back", "screen=server&id=notes-work", [[link("Sign in"), "signin-cli"], [link("Back to notes-work"), "server"]], ["Not reported."]);
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
  check("an https URL is sent, and nothing says Added before the read", (await at(p, "write-sent")) && !(await text(p)).includes("Added"));
  await finishWrite(p);
  check("an https URL is saved after the read matches", (await text(p)).includes("Added notes-home."));
  check("with OAuth, Sign in is the next step", (await p.getByRole("link", { name: "Sign in", exact: true }).count()) === 1);
  await p.close();
}
// Change 2: the gateway's reply and the fresh read, chosen independently, at both widths.
const startAdd = async (width) => {
  const p = await open("screen=add-server", { width, height: width === 390 ? 844 : 900 });
  await p.fill("#c-name", "notes-home");
  await p.fill("#c-url", "https://notes-home.example/mcp");
  await p.locator(".c-h-name").first().fill("Authorization");
  await submit(p);
  await at(p, "write-sent");
  return p;
};
for (const [width, label] of [[1440, "desktop"], [390, "phone"]]) {
  const size = { width, height: width === 390 ? 844 : 900 };
  const cases = [
    ["Refused", "Has no such entry", ["Couldn't add notes-home:", "Expected http:// or https:// URL"]],
    ["No reply", "Has no such entry", ["The gateway's settings have no entry named notes-home."]],
    ["No reply", "Matches every reviewed field", ["The gateway lists an entry with these settings.", "Couldn't confirm this save."]],
    ["Refused", "Matches every reviewed field", ["The gateway lists an entry with these settings.", "Couldn't confirm this save."]],
    ["Accepted", "Has a different entry", ["Couldn't confirm the change.", "The gateway lists a different entry.", "https://notes-other.example/mcp"]],
    ["Accepted", "Read failed", ["Couldn't confirm the change.", "The gateway's settings couldn't be read back."]],
    ["Accepted", "Matches every reviewed field", ["Added notes-home.", "The gateway lists this server.", "The gateway hides saved header values."]],
  ];
  for (const [reply, read, words] of cases) {
    const p = await startAdd(width);
    const first = await text(p);
    await link(reply)(p);
    await at(p, "write-read");
    const before = await text(p);
    await link(read)(p);
    await at(p, "write-result");
    const t = await text(p);
    const lack = missing(t, words);
    const wrong = !(reply === "Accepted" && read === "Matches every reviewed field") && t.includes("Added notes-home");
    check(`${label}: add, ${reply}, then the read ${read} (change 2)`, !lack && !wrong && !first.includes("Added") && !before.includes("Added"), lack);
    await p.close();
  }
  {
    const p = await startAdd(width);
    await link("Accepted")(p);
    await at(p, "write-read");
    await link("Read failed")(p);
    await at(p, "write-result");
    await link("Check again")(p);
    check(`${label}: Check again repeats the read only`, await at(p, "write-read"));
    await link("Read failed")(p);
    check(`${label}: and can fail again`, (await at(p, "write-result")) && (await text(p)).includes("The gateway's settings couldn't be read back."));
    await link("Check again")(p);
    await at(p, "write-read");
    await link("Matches every reviewed field")(p);
    await at(p, "write-result");
    check(`${label}: or then confirm the save`, (await text(p)).includes("Added notes-home."));
    await p.close();
  }
  {
    const p = await startAdd(width);
    await link("Settings changed")(p);
    await at(p, "write-read");
    await link("The name now exists")(p);
    await at(p, "write-result");
    const t = await text(p);
    check(`${label}: a stale hash, and the name now exists: the gateway's entry is shown apart, and nothing is retried`, t.includes("The gateway's settings changed.") && t.includes("There's already a server named notes-home on the gateway.") && t.includes("https://notes-other.example/mcp") && !t.includes("Added"));
    await link("Back to the form")(p);
    await at(p, "add-server");
    check(`${label}: the draft is kept, and another name is required`, (await p.inputValue("#c-url")) === "https://notes-home.example/mcp" && (await text(p)).includes("There's already a server named notes-home on the gateway."));
    await submit(p);
    await p.waitForTimeout(50);
    check(`${label}: the same name is refused again before anything is sent`, (await screenOf(p)) === "add-server");
    await p.close();
  }
  for (const [reply, read, words, forbidden] of [
    ["Accepted", "No such entry", ["Removed notes-work.", "The gateway's settings no longer have it."], null],
    ["Refused", "Still has it", ["notes-work is still in the gateway's settings.", "Another plugin or config operation is already running"], "Removed"],
    ["No reply", "Still has it", ["notes-work is still in the gateway's settings."], "Removed"],
    ["Accepted", "Read failed", ["Couldn't confirm the change.", "The gateway's settings couldn't be read back."], "Removed"],
  ]) {
    const p = await open("screen=server&id=notes-work", size);
    await link("Remove…")(p);
    await at(p, "server-remove-confirm");
    await inConfirm("Remove")(p);
    await at(p, "write-sent");
    const before = await text(p);
    await link(reply)(p);
    await at(p, "write-read");
    await link(read)(p);
    await at(p, "write-result");
    const t = await text(p);
    const lack = missing(t, words);
    check(`${label}: remove, ${reply}, then the read ${read}`, !lack && !before.includes("Removed") && (!forbidden || !t.includes(forbidden)), lack);
    if (read === "Read failed") {
      await link("Check again")(p);
      await at(p, "write-read");
      await link("Read failed")(p);
      await at(p, "write-result");
      check(`${label}: an unconfirmed removal's Check again can stay unavailable`, (await text(p)).includes("couldn't be read back"));
      await link("Check again")(p);
      await at(p, "write-read");
      await link("Still has it")(p);
      await at(p, "write-result");
      check(`${label}: or land on present`, (await text(p)).includes("is still in the gateway's settings."));
    }
    await p.close();
  }
  {
    const p = await open("screen=server&id=notes-work", size);
    await link("Remove…")(p);
    await inConfirm("Remove")(p);
    await at(p, "write-sent");
    await link("Settings changed")(p);
    await at(p, "write-read");
    await p.getByRole("link").filter({ hasText: /No such entry|Still has it|Read failed/ }).first().click();
    await at(p, "write-result");
    check(`${label}: removal with a stale hash asks for a review, and offers no retry`, (await text(p)).includes("Review the current entry before trying again.") && (await p.getByRole("link", { name: "Remove", exact: true }).count()) === 0);
    await link("Review notes-work")(p);
    check(`${label}: and reviewing goes back to the entry`, await at(p, "server"));
    await p.close();
  }
}
{
  const p = await open("screen=add-server");
  check("the form offers no per-requester sign-in (ruling 1)", (await p.locator("input[name=signin]").count()) === 2 && !(await text(p)).includes("Each person signs in"));
  const card = await open("screen=chat");
  await card.getByRole("button", { name: "A sign-in page", exact: true }).click();
  check("the connect card never says the sign-in is yours alone", !/your team-notes account|signs in for you/.test(await text(card)));
  await card.close();
  await p.close();
}
for (const [width, label] of [[1440, "desktop"], [390, "phone"]]) {
  const opts = { width, height: width === 390 ? 844 : 900 };
  const p = await open("screen=add-server&type=command", opts);
  await p.fill("#c-name", "search-local");
  await submit(p);
  await p.waitForTimeout(50);
  check(`${label}: an empty command is refused by Clawtrate`, (await text(p)).includes("Enter the command.") && (await screenOf(p)) === "add-server");
  // Zero arguments and a working folder, typed with spaces around them.
  await p.fill("#c-command", "  /opt/example/bin/search-server ");
  await p.fill("#c-args", "");
  await p.fill("#c-cwd", " /srv/notes ");
  await submit(p);
  await at(p, "command-confirm");
  const none = await text(p, ".c-confirm");
  check(`${label}: no arguments reads "No arguments", with the working folder trimmed`, none.includes("No arguments") && none.includes("Working folder") && (await p.locator('.c-confirm [data-c="cwd"]').textContent()) === "/srv/notes" && (await p.locator('.c-confirm [data-c="program"]').textContent()) === "/opt/example/bin/search-server");
  for (let i = 0; i < 8; i++) await p.keyboard.press("Tab");
  check(`${label}: Tab stays inside the confirmation`, await p.evaluate(() => Boolean(document.activeElement?.closest(".c-confirm"))));
  await p.keyboard.press("Shift+Tab");
  check(`${label}: Shift-Tab stays inside the confirmation`, await p.evaluate(() => Boolean(document.activeElement?.closest(".c-confirm"))));
  await p.keyboard.press("Escape");
  check(`${label}: Escape restores the untouched form and puts focus on Continue (change 3)`, (await at(p, "add-server")) && (await p.evaluate(() => document.activeElement?.id)) === "c-submit" && (await p.inputValue("#c-cwd")) === " /srv/notes " && (await p.inputValue("#c-command")) === "  /opt/example/bin/search-server " && (await p.inputValue("#c-args")) === "");
  // Many arguments, one with spaces, and a secret-looking one.
  await p.fill("#c-args", "  --index ./my notes  \n\n--stdio\n--token\nexample-argv-secret\n   ");
  await submit(p);
  await at(p, "command-confirm");
  const argsShown = await p.locator(".c-confirm .c-args li").allTextContents();
  check(`${label}: the argument array is exact and in order`, JSON.stringify(argsShown) === JSON.stringify(["--index ./my notes", "--stdio", "--token", "example-argv-secret"]), JSON.stringify(argsShown));
  check(`${label}: no program, argument or folder is in the confirmation's address`, !/example-argv-secret|search-server|srv/.test(decodeURIComponent(p.url())));
  await p.keyboard.press("Escape");
  await at(p, "add-server");
  check(`${label}: Escape again restores the raw arguments`, (await p.inputValue("#c-args")) === "  --index ./my notes  \n\n--stdio\n--token\nexample-argv-secret\n   ");
  await submit(p);
  await at(p, "command-confirm");
  await inConfirm("Add command server")(p);
  await finishWrite(p);
  check(`${label}: no secret in the result's address either`, !/example-argv-secret|search-server/.test(decodeURIComponent(p.url())) && (await text(p)).includes("Added search-local."));
  await link("Open search-local")(p);
  await at(p, "server");
  const shownArgs = await p.locator('[data-c="args"] li').allTextContents();
  check(`${label}: the new server's page shows the saved program, every argument and the folder`, (await p.locator('[data-c="program"]').textContent()) === "/opt/example/bin/search-server" && JSON.stringify(shownArgs) === JSON.stringify(["--index ./my notes", "--stdio", "--token", "example-argv-secret"]) && (await p.locator('[data-c="cwd"]').textContent()) === "/srv/notes", JSON.stringify(shownArgs));
  await p.close();
  const q = await open("screen=browse", opts);
  await q.locator("#chip-all").focus();
  await q.keyboard.press("ArrowRight");
  check(`${label}: Right Arrow on the categories moves to and chooses the next one`, (await at(q, "browse-category")) && (await q.evaluate(() => document.activeElement?.id)) === "chip-productivity");
  await q.keyboard.press("ArrowLeft");
  check(`${label}: Left Arrow goes back to All`, (await at(q, "browse")) && (await q.evaluate(() => document.activeElement?.id)) === "chip-all");
  await q.close();
}
// Change 4: the connect card comes only from a live result in this page; a reload is ordinary history.
const liveResult = (name) => (p) => p.getByRole("button", { name, exact: true }).click();
for (const [width, label] of [[1440, "desktop"], [390, "phone"]]) {
  const size = { width, height: width === 390 ? 844 : 900 };
  const p = await open("screen=chat", size);
  const requests = [];
  p.on("request", (r) => {
    if (/^https?:/.test(r.url())) requests.push(r.url());
  });
  check(`${label}: before any live result the card is the ordinary recorded call`, (await text(p, "#c-card")).includes("team-notes__connect") && (await p.locator("#c-card .copy").count()) === 0 && (await p.locator("#c-card a").count()) === 0);
  await liveResult("A sign-in page")(p);
  await p.waitForTimeout(40);
  const t = await text(p, "#c-card");
  check(`${label}: a live sign-in result is the copy-only card`, !missing(t, ["team-notes asks for a sign-in", "The gateway sees every device using Clawtrate as one sender", "auth.teamnotes.example", "https://auth.teamnotes.example/authorize?response_type=code", "To sign in, copy this address into a browser.", "After you sign in, ask Pip again.", "Anyone with this address can complete this shared sign-in."]) && (await p.locator("#c-card a").count()) === 0 && (await p.getByRole("button", { name: "Copy sign-in address" }).count()) === 1, missing(t, ["team-notes asks for a sign-in"]));
  await p.reload();
  await p.waitForTimeout(60);
  const r = await text(p, "#c-card");
  check(`${label}: reloading the same task shows the ordinary card: tool name and literal result, no copy, no anchor, nothing opened`, r.includes("team-notes__connect") && r.includes('Connect MCP server "team-notes" at https://auth.teamnotes.example/authorize?state=example-state-2c41') && (await p.locator("#c-card .copy").count()) === 0 && (await p.locator("#c-card a").count()) === 0 && requests.length === 0);
  await liveResult("In a shared task")(p);
  await p.waitForTimeout(40);
  check(`${label}: in a shared task the possession line is a warning`, (await p.locator("#c-card .c-line[data-tone]").last().getAttribute("data-tone")) === "warn");
  await liveResult("No public address")(p);
  await p.waitForTimeout(40);
  check(`${label}: no public address`, (await text(p, "#c-card")).includes("gateway.publicOrigin is not configured"));
  await liveResult("Already connected")(p);
  await p.waitForTimeout(40);
  check(`${label}: already connected is the gateway's words`, (await text(p, "#c-card")).includes("is connected. Its tools become available on the next message."));
  await p.close();
}
for (const [outcome, words] of [["resolve", "Copied sign-in address"], ["reject", "Couldn't copy the sign-in address."]]) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((how) => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => (how === "resolve" ? Promise.resolve() : Promise.reject(new Error("denied"))) }, configurable: true });
  }, outcome);
  const p = await ctx.newPage();
  const requests = [];
  p.on("request", (r) => {
    if (/^https?:/.test(r.url())) requests.push(r.url());
  });
  await p.goto(`${base}&theme=light&screen=chat`);
  await p.getByRole("button", { name: "A sign-in page", exact: true }).click();
  await p.getByRole("button", { name: "Copy sign-in address" }).click();
  await p.waitForTimeout(80);
  const live = await p.evaluate(() => document.getElementById("c-live").textContent);
  check(`copy that ${outcome}s says "${words}", and opens nothing`, live === words && (await text(p, "#c-card")).includes(words) && requests.length === 0 && (await screenOf(p)) === "chat", live);
  await ctx.close();
}
{
  const p = await open("screen=chat&card=history");
  check("from history: no connect card, no button, the address only as text (ruling 9)", (await p.locator(".c-card .c-open, .c-card .c-address, .c-card .copy").count()) === 0 && !(await text(p)).includes("Open in your browser") && (await p.locator(".c-card a").count()) === 0);
  await p.close();
}
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
