// Behaviour checks for bots.html: creating a bot with its account, connecting
// accounts, a bot's settings with its account and lock, and T3 Code.
// Run from the repository root:  node docs/design/prototype/tools/checks/bots.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("bots.html") + "?chrome=0&theme=light";
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
const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.textContent || "", sel);
const dlg = (p, id = "create-dialog") => p.evaluate((i) => document.getElementById(i).open, id);
const focused = (p) => p.evaluate(() => document.activeElement?.id || document.activeElement?.dataset?.b || document.activeElement?.tagName);

// Part 1: creating a bot ------------------------------------------------------------------------
let p = await open();
await p.click("#new-button");
await p.click('[data-action="new-bot"]');
await p.waitForTimeout(60);
check("P1 New bot opens the dialog with focus on the name", (await dlg(p)) && (await focused(p)) === "b-name");
await p.keyboard.type("Viral");
await p.focus('.b-shape[aria-checked="true"]');
await p.keyboard.press("ArrowRight");
check("P1 shapes are one radio group: an arrow moves and chooses", await p.evaluate(() => document.activeElement.dataset.bBody === "gem" && document.activeElement.getAttribute("aria-checked") === "true"));
await p.keyboard.press("Enter").catch(() => {});
await p.click('[data-b="next"]').catch(() => {});
check("P1 Next goes to the Account step", (await text(p, "#create-title")) === "Account");
check("P1 the step keeps the name", (await text(p, "#create-dialog .b-lead")).includes("Viral runs on"));
const order = await p.evaluate(() => [...document.querySelectorAll("#create-dialog .b-group")].map((g) => g.textContent));
check("P1 subscriptions are listed first", order[0] === "Subscriptions" && order[1] === "API keys", order.join(" / "));
check("P1 nothing is chosen at first, and the step says what that means", await p.evaluate(() => !document.querySelector('#create-dialog [role="radio"][aria-checked="true"]') && document.querySelector("#create-dialog").textContent.includes("No account chosen. Viral would use the gateway's default model")));
check("P1 two accounts of one provider are told apart by label", await p.evaluate(() => { const t = [...document.querySelectorAll("#create-dialog .b-choice-title")].map((x) => x.textContent); return t.includes("OpenAI · Work") && t.includes("OpenAI · Home"); }));
await p.click('[data-b-choose="xai:default"]');
check("P1 choosing an account shows model and effort side by side", await p.evaluate(() => { const m = document.querySelector('#create-dialog [data-b-select="model"]'); const e = document.querySelector('#create-dialog [data-b-select="effort"]'); return m && e && Math.abs(m.getBoundingClientRect().top - e.getBoundingClientRect().top) < 2 && m.textContent.includes("grok-4.7"); }));
await p.click('#create-dialog [data-b-select="model"]');
const models = await p.evaluate(() => [...document.querySelectorAll(".b-menu .menu-item")].map((i) => i.dataset.value));
check("P1 the model menu lists only the account's provider's models", models.length === 4 && models.every((m) => m.startsWith("grok")), models.join(","));
await p.keyboard.press("Escape");
check("P1 Escape closes the menu and not the dialog", (await dlg(p)) && !(await p.evaluate(() => document.querySelector(".b-menu"))) && (await p.evaluate(() => document.activeElement.dataset.bSelect === "model")));
await p.click('[data-b="connect"]');
check("P1 Connect another account opens the providers inside the dialog", (await text(p, "#create-title")) === "Connect an account");
check("P1 the API key path is collapsed and not preselected", await p.evaluate(() => { const d = document.querySelector("#create-dialog .b-disclosure"); return d && !d.open && d.querySelector("summary").textContent.includes("Use an API key instead"); }));
check("P1 the API key path says it is billed per token", (await text(p, "#create-dialog .b-disclosure")).includes("bills each request by the tokens it uses"));
await p.click('[data-b-option="xai/xai-oauth"]');
check("P1 starting: the gateway is asked", (await text(p, "#create-dialog .b-body")).includes("Asking the gateway to start the sign-in"));
await p.waitForTimeout(900);
check("P1 waiting: a link and a code the gateway polls for", await p.evaluate(() => document.querySelector("#create-dialog .b-code code")?.textContent === "QK4F-7PZD" && document.querySelector('#create-dialog [data-b="open-link"]') && document.querySelector("#create-dialog .b-wait")));
await p.click('[data-b="cancel-signin"]');
check("P1 cancelled: nothing was saved", (await text(p, "#create-dialog .b-result")).includes("Nothing was saved"));
await p.click('[data-b="restart-signin"]');
await p.waitForTimeout(900);
await p.evaluate(() => window.bots.connectTo("connected"));
await p.waitForTimeout(100);
check("P1 connected: the label step, with focus in the field", (await text(p, "#create-dialog .b-result h3")).includes("Connected to xAI") && (await p.evaluate(() => document.activeElement.matches("[data-b-label]"))));
await p.keyboard.type("Studio");
await p.click('[data-b="label-done"]');
check("P1 back on the Account step with the new account chosen and the bot kept", (await text(p, "#create-title")) === "Account" && (await p.evaluate(() => document.querySelector('[role="radio"][aria-checked="true"]')?.textContent.includes("xAI · Studio") && document.querySelector("#create-dialog .b-lead").textContent.includes("Viral"))));
await p.click('[data-b="create"]');
check("P1 Create reads Creating… and is disabled", await p.evaluate(() => { const c = document.querySelector('[data-b="create"]'); return c.disabled && c.textContent === "Creating…"; }));
await p.waitForTimeout(900);
check("P1 after Create the new bot's composer has focus", await p.evaluate(() => document.activeElement.classList.contains("composer-input")));
check("P1 the new bot is created on its account and opened", !(await dlg(p)) && (await p.evaluate(() => document.querySelector("#title-pill").getAttribute("aria-label").startsWith("Viral, Main") && window.bots.accounts().find((a) => a.id === window.bots.binding.viral.account)?.label === "Studio")));
await p.close();

// The other two sign-in kinds.
p = await open("open=create&step=connect&name=Viral&connect=openai/openai");
await p.waitForTimeout(900);
check("P1 paste: the field is a password field and says the code is not kept", await p.evaluate(() => document.querySelector("[data-b-paste]")?.type === "password" && document.querySelector("#create-dialog").textContent.includes("Clawtrate does not keep it")));
await p.fill("[data-b-paste]", "one-time-code");
await p.click('[data-b="paste-next"]');
check("P1 paste: checking with the provider", (await text(p, "#create-dialog .b-body")).includes("Finishing the sign-in"));
await p.waitForTimeout(1000);
check("P1 paste: a second OpenAI account must have a label", await p.evaluate(() => document.querySelector('[data-b="label-done"]').disabled));
await p.keyboard.type("Work");
check("P1 a label already used by that provider is refused", (await text(p, ".b-field-error")).includes("Another OpenAI account is called Work") && (await p.evaluate(() => document.querySelector('[data-b="label-done"]').disabled)));
await p.close();
p = await open("open=create&step=connect&name=Viral&connect=openai/openai-token-sharing&stage=waiting");
check("P1 the gateway's machine: the command to forward the port, ready to copy", await p.evaluate(() => document.querySelector("#create-dialog .command-line code")?.textContent.startsWith("ssh -N -L 8080") && document.querySelector('#create-dialog .copy[aria-label="Copy command"]')));
await p.close();
for (const [stage, words] of [["failed", "Couldn't connect"], ["expired", "The sign-in expired"], ["dropped", "a sign-in ends with its connection"], ["busy", "does one at a time"]]) {
  p = await open(`open=create&step=connect&name=Viral&connect=xai/xai-oauth&stage=${stage}`);
  check(`P1 ${stage}: says so`, (await text(p, "#create-dialog .b-body")).includes(words));
  await p.close();
}
p = await open("open=create&step=connect&name=Viral&connect=github-copilot/github-copilot-enterprise");
check("P1 Copilot Enterprise asks for the company's address first", (await p.evaluate(() => !!document.querySelector("[data-b-domain]"))));
await p.close();

// No account at all; creating fails; a connection that may not create.
p = await open("open=create&step=account&name=Viral&accounts=none");
check("P1 no accounts: the way to connect one, and the default named", await p.evaluate(() => document.querySelector('#create-dialog .b-foot [data-b="connect"]')?.dataset.variant === "primary" && document.querySelector("#create-dialog").textContent.includes("No accounts yet") && document.querySelector("#create-dialog").textContent.includes("default model")));
await p.close();
p = await open("open=create&step=account&name=Viral&chosen=xai:default&create=failed");
await p.click('[data-b="create"]');
await p.waitForTimeout(900);
check("P1 a failed create keeps the dialog and says so", (await dlg(p)) && (await text(p, "#create-dialog .b-foot")).includes("Could not create the bot. Please try again."));
await p.close();
p = await open("open=create&step=account&name=Viral&access=write");
check("P1 below admin: no Create, the admin request instead", await p.evaluate(() => !document.querySelector('[data-b="create"]') && document.querySelector("#create-dialog .access-bar").textContent.includes("Admin access needed.")));
await p.click('#create-dialog [data-b="request"]');
check("P1 asking the gateway", (await text(p, "#create-dialog .access-bar")).includes("Asking the gateway"));
await p.waitForTimeout(800);
check("P1 requested: the host's command and the request id", await p.evaluate(() => document.querySelector("#create-dialog .access-bar code").textContent === "openclaw devices approve 3f9a2c71" && document.querySelector('#create-dialog [aria-label="Copy request id"]')));
await p.click('#create-dialog [data-b="request-check"]');
check("P1 granted: Create appears, nothing chosen was lost", await p.evaluate(() => !!document.querySelector('[data-b="create"]') && document.querySelector("#create-dialog .b-lead").textContent.includes("Viral")));
await p.close();
p = await open("access=read");
check("P1 read-only: no way to create a bot", await p.evaluate(() => document.querySelector("#new-button").hidden));
await p.close();

// Settings, Accounts.
p = await open();
await p.click(".gateway-pill");
await p.click('[data-action="b-settings"]');
check("P1 Settings opens from the gateway menu on Accounts", (await dlg(p, "settings-dialog")) && (await text(p, "#b-section-title")) === "Accounts");
await p.click('[data-b-account="openai:work"]');
check("P1 an account's page: label, kind, state, the bots that use it", await p.evaluate(() => { const t = document.querySelector("#settings-dialog .facts").textContent; return t.includes("Work") && t.includes("Subscription") && t.includes("Connected") && t.includes("Otto (locked), Marlow"); }));
await p.click('[data-b="relabel"]');
await p.fill("[data-b-relabel]", "Home");
await p.click('[data-b="relabel-save"]');
check("P1 relabelling to another account's label is refused", await p.evaluate(() => document.querySelector("[data-b-relabel]")?.getAttribute("aria-invalid") === "true"));
await p.fill("[data-b-relabel]", "Office");
await p.click('[data-b="relabel-save"]');
check("P1 a new label is saved and shown", (await text(p, "#b-section-title")) === "OpenAI · Office");
await p.click('[data-b="disconnect"]');
check("P1 disconnecting asks, naming the bots that use it", (await dlg(p, "confirm-dialog")) && (await text(p, "#confirm-text")).includes("Otto and Marlow use it"));
await p.click('[data-b="confirm-ok"]');
check("P1 after disconnecting, those bots have no account", await p.evaluate(() => window.bots.binding.otto.account === null && window.bots.binding.marlow.account === null && !window.bots.accounts().some((a) => a.id === "openai:work")));
await p.keyboard.press("Escape");
await p.waitForTimeout(50);
check("P1 closing Settings returns focus to the gateway row", !(await dlg(p, "settings-dialog")) && (await p.evaluate(() => document.activeElement.classList.contains("gateway-pill"))));
await p.close();
p = await open("open=settings&access=read");
check("P1 read-only Settings: ids, not labels, and no Connect", await p.evaluate(() => !document.querySelector('#settings-dialog [data-b="connect"]') && document.querySelector("#settings-dialog .b-choice-title .mono")?.textContent === "openai:work" && document.querySelector("#settings-dialog .access-bar").textContent.includes("Read-only.")));
await p.close();

// The phone.
p = await open("open=create&name=Viral", { width: 390, height: 844 });
check("P1 phone: New bot is a full-width sheet", await p.evaluate(() => Math.round(document.querySelector("#create-dialog").getBoundingClientRect().width) === 390));
await p.close();
p = await open("open=settings", { width: 390, height: 844 });
check("P1 phone: Settings opens on its list of sections", await p.evaluate(() => getComputedStyle(document.querySelector(".b-section")).display === "none" && getComputedStyle(document.querySelector(".b-nav")).display !== "none"));
await p.click('[data-b-section="accounts"]');
check("P1 phone: a section replaces the list, with a way back", await p.evaluate(() => getComputedStyle(document.querySelector(".b-nav")).display === "none" && getComputedStyle(document.querySelector('[data-b="to-nav"]')).display !== "none"));
await p.close();

// Part 2: a bot's settings ------------------------------------------------------------------------
const pane = (p) => text(p, "#panel-settings");
p = await open("bot=marlow&panel=open&tab=settings");
check("P2 the Work pane has a Settings tab, reached with the arrows", await p.evaluate(() => document.querySelector("#tab-settings").getAttribute("aria-selected") === "true" && !document.querySelector("#panel-settings").hidden));
check("P2 the account row says the account and that it is bound", (await text(p, '#panel-settings [data-bs="account"]')).includes("OpenAI · Work") && (await text(p, '#panel-settings [data-bs="account"]')).includes("Bound"));
check("P2 model and effort sit side by side", await p.evaluate(() => { const [m, e] = document.querySelectorAll("#panel-settings .b-select"); return m && e && Math.abs(m.getBoundingClientRect().top - e.getBoundingClientRect().top) < 2; }));
await p.click('#panel-settings [data-b-select="model"]');
const pm = await p.evaluate(() => [...document.querySelectorAll(".b-menu .menu-item")].map((i) => i.dataset.value));
check("P2 the model menu lists only the account's models", pm.length === 3 && pm.every((m) => m.startsWith("gpt")), pm.join(","));
await p.click('.b-menu [data-value="gpt-5.5-mini"]');
check("P2 a chosen model is saved and focus returns to its select", (await text(p, '#panel-settings [data-b-select="model"]')).includes("gpt-5.5-mini") && (await p.evaluate(() => document.activeElement.dataset.bSelect === "model")));
await p.click('#panel-settings [data-bs="account"]');
await p.waitForTimeout(50);
check("P2 Account opens with focus on its title", await p.evaluate(() => document.activeElement.textContent === "Account"));
check("P2 bound: says plainly that the gateway may use another account", (await pane(p)).includes("Bound. Marlow runs on OpenAI · Work. If that account fails, the gateway may use another OpenAI account"));
check("P2 the lock is one command, ready to copy", (await text(p, "#panel-settings .command-line code")) === "openclaw models auth order set --provider openai --agent marlow openai:work" && (await p.evaluate(() => !!document.querySelector('#panel-settings .copy[aria-label="Copy lock command"]'))));
check("P2 bound: says what it cannot see", (await pane(p)).includes("a run can start on another OpenAI account without leaving a record Clawtrate can read"));
check("P2 the ways round a lock are listed, folded", await p.evaluate(() => { const d = [...document.querySelectorAll("#panel-settings .b-disclosure")].find((x) => x.textContent.includes("What a lock doesn't cover")); return d && !d.open && d.querySelectorAll("li").length === 7; }));
await p.click('#panel-settings .copy[aria-label="Copy lock command"]');
await p.waitForTimeout(80);
check("P2 copying the command starts checking the gateway", (await text(p, "#panel-settings .b-wait")).includes("Checking the gateway for the lock"));
await p.click('#panel-settings [data-bs="lock-check"]');
check("P2 the gateway's lock is confirmed: Locked", (await pane(p)).includes("Locked. Marlow runs on OpenAI · Work only.") && (await pane(p)).includes("Confirmed by the gateway"));
check("P2 locked: the command to unlock, folded", await p.evaluate(() => [...document.querySelectorAll("#panel-settings .b-disclosure")].some((d) => d.textContent.includes("openclaw models auth order clear --provider openai --agent marlow"))));
await p.click('#panel-settings [data-bs="main"]');
check("P2 the account row now says Locked", (await text(p, '#panel-settings [data-bs="account"]')).includes("Locked"));
await p.close();

p = await open("bot=marlow&panel=open&tab=settings&bview=change&running=1");
await p.click('#panel-settings [data-b-choose="xai:default"]');
check("P2 changing to an account without the model asks for a model first", await p.evaluate(() => document.querySelector('#panel-settings [data-bs="save-change"]').disabled && document.querySelector("#panel-settings").textContent.includes("xAI doesn't offer gpt-5.5")));
check("P2 a run in progress finishes on the account it started with", (await pane(p)).includes("A run in progress finishes on OpenAI · Work. The next run uses xAI · Personal."));
await p.click('#panel-settings [data-b-select="model"]');
await p.click('.b-menu [data-value="grok-4.7"]');
await p.click('#panel-settings [data-bs="save-change"]');
check("P2 the change posts a grey line in the task", (await text(p, "#transcript")).includes("Marlow now runs on xAI · Personal. The run in progress finishes on OpenAI · Work."));
await p.click('#panel-settings [data-bs="main"]');
check("P2 tools that come with the account appear under its provider", (await pane(p)).includes("With xAI") && (await pane(p)).includes("Search posts on X"));
await p.close();

p = await open("bot=otto&panel=open&tab=settings&bview=change");
await p.click('#panel-settings [data-b-choose="openai:home"]');
check("P2 locked to the old account: says the lock must change too", (await pane(p)).includes("Otto is locked to OpenAI · Work. Until the lock is changed, the gateway keeps using it."));
await p.click('#panel-settings [data-bs="save-change"]');
check("P2 after saving, the lock is out of date and gives the new command", (await pane(p)).includes("The lock is out of date") && (await text(p, "#panel-settings .command-line code")).endsWith("--agent otto openai:home"));
await p.close();

// Served by another account.
p = await open("bot=otto&served=1");
check("P2 the bot's row warns that another account was used", await p.evaluate(() => { const r = document.querySelector('.bot[data-bot="marlow"]'); const pv = r.querySelector(".bot-preview"); return pv.dataset.tone === "warn" && pv.textContent === "Used another account" && r.getAttribute("aria-label").includes("used another account"); }));
await p.click('.bot[data-bot="marlow"]');
check("P2 the task has the grey line, naming the other account only as likely", (await text(p, '[data-testid="served-line"] summary')).includes("OpenAI · Work failed (rate limited). The gateway finished this run on another OpenAI account, likely Home."));
check("P2 opening the task clears the row's warning", await p.evaluate(() => !document.querySelector('.bot[data-bot="marlow"] .bot-preview[data-tone]')));
await p.click('[data-testid="served-line"] summary');
check("P2 opened, the line says what is inferred and what the gateway does not say", (await text(p, '[data-testid="served-line"]')).includes("It doesn't say which account served the run") && (await text(p, '[data-testid="served-line"]')).includes("Inferred:"));
await p.click('[data-testid="served-line"] [data-bs="raw"]');
check("P2 Raw shows the gateway's log record", (await text(p, '[data-testid="served-line"] .b-raw')).includes('"decision": "rotate_profile"'));
await p.click('[data-testid="served-line"] [data-bs="open-settings"]');
check("P2 the line leads to the bot's account", (await pane(p)).includes("Last run:") && (await pane(p)).includes("Lock to this account"));
await p.close();

// An account that fails.
p = await open("fail=quota");
check("P2 out of quota: the turn error names the bound account and why", (await text(p, '[data-testid="account-error"]')).includes("Otto's account, OpenAI · Work, is out of credit or quota") && (await text(p, '[data-testid="account-error"]')).includes("locked to it, so the gateway didn't use another account"));
check("P2 out of quota: Change account and Try again", await p.evaluate(() => [...document.querySelectorAll('[data-testid="account-error"] .button')].map((b) => b.textContent).join("|").startsWith("Change account|Try again")));
check("P2 the bot's row shows the failure", await p.evaluate(() => document.querySelector('.bot[data-bot="otto"] .bot-preview').dataset.tone === "danger"));
await p.click('[data-testid="account-error"] [data-bs="change-account"]');
check("P2 Change account opens the bot's settings on it", (await pane(p)).includes("Change account") && (await p.evaluate(() => document.querySelector("#tab-settings").getAttribute("aria-selected") === "true")));
await p.close();
p = await open("fail=signedout");
await p.click('[data-testid="account-error"] [data-bs="sign-in-again"]');
await p.waitForTimeout(900);
check("P2 signed out: Sign in again starts the provider's sign-in in Settings", (await dlg(p, "settings-dialog")) && (await text(p, "#b-section-title")).startsWith("Sign in to ChatGPT"));
await p.close();

// Checks, the access tiers, loading, errors, no account.
p = await open("bot=pip&panel=open&tab=settings&bview=account&differs=1");
check("P2 a bot whose model has fallbacks is reported", (await pane(p)).includes("Pip can move to another model."));
await p.click('#panel-settings [data-bs="no-fallbacks"]');
check("P2 Remove fallbacks clears it", !(await pane(p)).includes("Pip can move to another model."));
await p.close();
p = await open("bot=marlow&panel=open&tab=settings&access=read");
check("P2 read-only: values shown, nothing to change, the admin request", await p.evaluate(() => [...document.querySelectorAll("#panel-settings .b-select")].every((s) => s.disabled) && document.querySelector("#panel-settings .access-bar").textContent.includes("Changing Marlow's settings needs admin access.")));
await p.click('#panel-settings [data-bs="account"]');
check("P2 read-only: no Change account", !(await p.evaluate(() => document.querySelector('#panel-settings [data-bs="change"]'))));
await p.close();
p = await open("bot=marlow&panel=open&tab=settings&bstate=loading");
check("P2 loading", await p.evaluate(() => !!document.querySelector('#panel-settings [aria-busy="true"]')));
await p.close();
p = await open("bot=marlow&panel=open&tab=settings&bstate=error");
check("P2 could not load", (await pane(p)).includes("Couldn't load Marlow's settings"));
await p.click('#panel-settings [data-bs="reload"]');
check("P2 Try again loads", (await pane(p)).includes("Account"));
await p.close();
p = await open("open=settings&section=accounts&account=openai:home&bot=pip&panel=open&tab=settings");
await p.click('[data-b="disconnect"]');
await p.click('[data-b="confirm-ok"]');
await p.keyboard.press("Escape");
await p.click('#panel-settings [data-bs="account"]');
check("P2 after its account is disconnected, the bot has No account and is not started", (await pane(p)).includes("No account. Pip's account was disconnected. Clawtrate won't start Pip until you choose one."));
await p.close();
p = await open("bot=marlow&panel=open&tab=details");
await p.focus("#tab-details");
await p.keyboard.press("End");
check("P2 keyboard: End reaches the Settings tab", await p.evaluate(() => document.activeElement.id === "tab-settings" && !document.querySelector("#panel-settings").hidden));
await p.close();
p = await open("bot=marlow&panel=open&tab=settings", { width: 390, height: 844 });
check("P2 phone: the settings are a full-width sheet", await p.evaluate(() => Math.round(document.querySelector("#work-panel").getBoundingClientRect().width) === 390));
await p.close();

// Part 3: T3 Code ----------------------------------------------------------------------------------
p = await open("open=settings&section=integrations");
check("P3 Settings has Integrations with the T3 Code switch, off", await p.evaluate(() => document.querySelector('[data-t3="toggle"]').getAttribute("aria-checked") === "false" && document.querySelector('[data-t3="toggle"]').getAttribute("role") === "switch"));
check("P3 off: nothing else about T3 Code in Settings", await p.evaluate(() => !document.querySelector("#settings-dialog [data-t3-address]") && !document.querySelector("#settings-dialog").textContent.includes("The gateway's sign-in")));
await p.keyboard.press("Escape");
await p.evaluate(() => { window.app.setPanel(true); document.querySelector("#tab-settings").click(); });
check("P3 off: nothing about T3 Code in a bot's settings", !(await text(p, "#panel-settings")).includes("T3 Code"));
await p.close();
p = await open("open=settings&section=integrations&t3server=none");
await p.click('[data-t3="toggle"]');
check("P3 on: the server's address is asked for", await p.evaluate(() => document.querySelector('[data-t3="toggle"]').getAttribute("aria-checked") === "true" && !!document.querySelector("[data-t3-address]")));
await p.fill("[data-t3-address]", "http://code.example.net");
await p.click('[data-t3="add"]');
check("P3 a plain-http address is refused, and why", (await text(p, "#t3-error")).includes("only over https, or on localhost"));
await p.fill("[data-t3-address]", "https://code.example.net");
await p.click('[data-t3="add"]');
check("P3 added: this connection can't start the sign-in, so the command is shown", (await text(p, "#settings-dialog .command-line code")) === "openclaw mcp login t3code");
await p.click('#settings-dialog .copy[aria-label="Copy sign-in command"]');
await p.waitForTimeout(80);
check("P3 copying it starts checking for the sign-in", (await text(p, "#settings-dialog .b-wait")).includes("Checking Otto's tools for T3 Code"));
await p.close();
p = await open("open=settings&section=integrations&t3=on&t3signin=none&t3origin=1");
await p.click('[data-t3="signin"]');
check("P3 a qualifying connection starts the gateway's sign-in", (await text(p, "#settings-dialog .b-section-body")).includes("Asking the gateway to start the sign-in"));
await p.waitForTimeout(900);
check("P3 waiting: approve on T3 Code's page, or a pairing code", (await text(p, "#settings-dialog .b-section-body")).includes("enter a pairing code") && (await text(p, "#settings-dialog .b-wait")).includes("10 minutes"));
await p.click('[data-t3="cancel"]');
check("P3 cancelled: nothing was saved", (await text(p, "#settings-dialog .b-result")).includes("Nothing was saved"));
await p.evaluate(() => window.t3.setSignin("signed"));
check("P3 signed in: when, from what, and by when it expires at the latest", await p.evaluate(() => { const t = document.querySelector("#settings-dialog .b-section-body").textContent; return t.includes("Signed in") && t.includes("By Dec 17 at the latest") && t.includes("8 T3 Code tools for Otto"); }));
await p.close();
for (const [s, words] of [["expiring", "Sign in again before Nov 19"], ["unseen", "lists no T3 Code tools for Otto any more"], ["failed", "Couldn't sign in"], ["expired", "The sign-in expired"]]) {
  p = await open(`open=settings&section=integrations&t3=on&t3signin=${s}&t3origin=1`);
  check(`P3 sign-in ${s}: says so`, (await text(p, "#settings-dialog .b-section-body")).includes(words));
  await p.close();
}
p = await open("open=settings&section=integrations&t3=on&t3found=1");
check("P3 a bot with the tools that was not turned on is reported", (await text(p, "#settings-dialog")).includes("Pip has the T3 Code tools without being turned on"));
await p.click('[data-t3="deny"]');
check("P3 and can be turned off for it", !(await text(p, "#settings-dialog")).includes("Pip has the T3 Code tools"));
await p.click('[data-t3="toggle"]');
check("P3 turning the switch off while bots use it asks, naming them", (await dlg(p, "confirm-dialog")) && (await text(p, "#confirm-text")).includes("Otto has T3 Code on") && (await text(p, "#confirm-text")).includes("stay on the gateway for next time"));
await p.click('[data-b="confirm-ok"]');
check("P3 after confirming, it is off for the integration and for Otto", await p.evaluate(() => document.querySelector('[data-t3="toggle"]').getAttribute("aria-checked") === "false" && !window.bots.binding.otto.t3.on));
await p.close();
p = await open("t3=on&bot=marlow&panel=open&tab=settings");
check("P3 a bot's switch is a plain switch, with no picture in it", await p.evaluate(() => !document.querySelector('#panel-settings [data-t3="bot-toggle"] svg')));
check("P3 each bot has its own T3 Code switch, off by default", await p.evaluate(() => document.querySelector('#panel-settings [data-t3="bot-toggle"]').getAttribute("aria-checked") === "false"));
await p.click('#panel-settings [data-t3="bot-toggle"]');
check("P3 turned on, the bot gets its limits", (await text(p, '#panel-settings [data-bs="t3"]')).includes("All projects, asks first"));
await p.click('#panel-settings [data-bs="t3"]');
check("P3 limits: projects, providers and models, and asking first, on by default", await p.evaluate(() => { const t = document.querySelector("#panel-settings").textContent; return t.includes("Projects") && t.includes("Providers and models") && document.querySelector('[data-t3="ask"]').getAttribute("aria-checked") === "true"; }));
await p.click('#panel-settings [data-t3="projects"][data-value="some"]');
check("P3 only some projects needs at least one", (await text(p, "#panel-settings")).includes("Choose at least one project"));
await p.close();
p = await open("t3=on&t3plugin=0&bot=otto&panel=open&tab=settings&bview=t3");
check("P3 without Clawtrate's plugin, the limits say what that means", (await text(p, "#panel-settings")).includes("Limits need Clawtrate's plugin on the gateway."));
await p.close();
p = await open("t3=on&t3server=none&bot=marlow&panel=open&tab=settings");
check("P3 before the server is added, a bot's switch is disabled and says why", await p.evaluate(() => document.querySelector('#panel-settings [data-t3="bot-toggle"]').disabled && document.querySelector("#panel-settings").textContent.includes("Add T3 Code in Settings first.")));
await p.close();
p = await open("open=settings&section=integrations&t3=on&access=write");
check("P3 below admin: the admin request; the switch itself still works", await p.evaluate(() => !document.querySelector('[data-t3="toggle"]').disabled && document.querySelector("#settings-dialog .access-bar").textContent.includes("Adding T3 Code to the gateway needs admin access.")));
await p.close();
p = await open("open=settings&section=integrations&access=read");
check("P3 read-only: the switch cannot be changed", await p.evaluate(() => document.querySelector('[data-t3="toggle"]').disabled));
await p.close();

await b.close();
console.log(out.join("\n"));
const oks = out.filter((l) => l.startsWith("ok")).length;
console.log(`\n${oks} ok, ${failed} not ok`);
process.exit(failed || out.some((l) => l.startsWith("PAGEERROR")) ? 1 : 0);
