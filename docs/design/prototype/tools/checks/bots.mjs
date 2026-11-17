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
check("P1 choosing an account shows model and effort side by side", await p.evaluate(() => { const m = document.querySelector('[data-b-select="model"]'); const e = document.querySelector('[data-b-select="effort"]'); return m && e && Math.abs(m.getBoundingClientRect().top - e.getBoundingClientRect().top) < 2 && m.textContent.includes("grok-4.7"); }));
await p.click('[data-b-select="model"]');
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
await p.click('[data-b="request"]');
check("P1 asking the gateway", (await text(p, "#create-dialog .access-bar")).includes("Asking the gateway"));
await p.waitForTimeout(800);
check("P1 requested: the host's command and the request id", await p.evaluate(() => document.querySelector("#create-dialog .access-bar code").textContent === "openclaw devices approve 3f9a2c71" && document.querySelector('#create-dialog [aria-label="Copy request id"]')));
await p.click('[data-b="request-check"]');
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

if (globalThis.__botsPart2) await globalThis.__botsPart2({ open, check, text, dlg, focused, out });

await b.close();
console.log(out.join("\n"));
const oks = out.filter((l) => l.startsWith("ok")).length;
console.log(`\n${oks} ok, ${failed} not ok`);
process.exit(failed || out.some((l) => l.startsWith("PAGEERROR")) ? 1 : 0);
