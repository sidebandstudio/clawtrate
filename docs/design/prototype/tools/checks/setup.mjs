// Checks for setup.html: every walk of docs/design/setup.md clicked through to
// its outcome, with each destination asserted; every state's words and
// structure; the host's confirmations; and the keyboard, phone and
// reduced-motion rules.
// Run from the repository root:  node docs/design/prototype/tools/checks/setup.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("setup.html") + "?chrome=0";
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
  await p.goto(`${base}&theme=${theme}&${query}`);
  await p.waitForTimeout(100);
  p.errors = errors;
  return p;
};
const text = (p, sel = "#root") => p.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, " ") || "", sel);
const missing = (t, words) => words.filter((w) => !t.includes(w)).join(" | ");
const screenOf = (p) => p.evaluate(() => new URLSearchParams(location.search).get("screen") || location.pathname.split("/").pop());
const at = async (p, screen, timeout = 6000) => {
  try {
    await p.waitForFunction(
      (s) => (s.endsWith(".html") ? location.pathname.endsWith(s.split("?")[0]) : new URLSearchParams(location.search).get("screen") === s),
      screen,
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
};
const click = async (p, selector) => {
  await p.locator(selector).first().click();
  await p.waitForTimeout(80);
};
const hostConfirm = async (p) => {
  await p.waitForSelector("[data-host-dialog]");
  await click(p, "[data-host-confirm]");
};

process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

// Part 1: the walks, clicked through, each destination asserted ------------------------------
async function walk(name, start, stepsList, end) {
  const p = await open(`screen=${start}`);
  let ok = true;
  let where = start;
  for (const [action, expect] of stepsList) {
    await action(p);
    if (expect && !(await at(p, expect))) {
      ok = false;
      where = `${await screenOf(p)} (expected ${expect})`;
      break;
    }
    where = expect || where;
  }
  if (ok && end && !(await at(p, end, 7000))) {
    ok = false;
    where = `${await screenOf(p)} (expected ${end})`;
  }
  check(`walk: ${name}`, ok && p.errors.length === 0, ok ? "" : `stopped at ${where} ${p.errors.join(" | ")}`);
  await p.close();
}
const link = (name) => (p) => p.getByRole("link", { name, exact: true }).first().click();
const btn = (name) => (p) => p.getByRole("button", { name, exact: true }).first().click();
const typeHost = (host) => async (p) => {
  await p.fill("#ssh-host", host);
  await p.press("#ssh-host", "Enter");
};

await walk(
  "this computer, found, to the app read-only",
  "first",
  [
    [(p) => p.locator("[data-choice]").first().click(), "looking-here"],
    [() => {}, "found"],
    [link("Connect"), "connecting-here"],
  ],
  "app.html",
);
await walk(
  "another computer, known key, to the app read-only",
  "there",
  [
    [typeHost("devbox"), "looking-there"],
    [() => {}, "found-there"],
    [link("Connect"), "connecting-there"],
  ],
  "app.html",
);
await walk(
  "another computer, first contact: key shown, the host confirms, then found",
  "there",
  [
    [typeHost("newbox"), "hostkey"],
    [btn("Trust this key…"), null],
    [hostConfirm, "looking-there"],
  ],
  "found-there",
);
await walk(
  "a changed key: replaced only through the host's dialog with its checkbox",
  "hostkey-changed",
  [
    [btn("Replace the trusted key…"), null],
    [async (p) => (await p.waitForSelector("[data-host-dialog]"), p.check("[data-host-check]")), null],
    [hostConfirm, "looking-there"],
  ],
);
await walk(
  "another computer, nothing there: set up over SSH, to the app",
  "there",
  [
    [typeHost("emptybox"), "looking-there"],
    [() => {}, "notfound-there"],
    [link("Set up OpenClaw on emptybox"), "install-confirm-there"],
    [btn("Set up OpenClaw…"), null],
    [hostConfirm, "installing-there"],
    [() => {}, "connecting-there"],
  ],
  "app.html",
);
await walk(
  "this computer, nothing there: set up here, to the app",
  "notfound",
  [
    [link("Set up OpenClaw here"), "install-confirm"],
    [btn("Set up OpenClaw…"), null],
    [hostConfirm, "installing"],
    [() => {}, "connecting-here"],
  ],
  "app.html",
);
await walk("Windows, nothing there: another computer instead", "notfound-windows", [[link("Use another computer"), "there"]]);
await walk(
  "Windows, first screen: This computer leads to nothing offered",
  "first&os=windows",
  [
    [(p) => p.locator("[data-choice]").first().click(), "looking-here"],
    [() => {}, "notfound-windows"],
  ],
);
await walk(
  "a pasted code: a first pairing, then the app",
  "code",
  [
    [btn("Paste a sample code"), null],
    [link("Connect"), "code-pairing"],
    [link("The gateway's owner approves"), null],
  ],
  "app.html",
);
await walk(
  "a phone, from the desktop: code made after the host's dialog, request approved after it",
  "phone",
  [
    [btn("Make a code…"), null],
    [hostConfirm, "phone-code"],
    [link("The iPhone scans the code"), "phone-request"],
    [btn("Approve…"), null],
    [hostConfirm, "phone-done"],
  ],
);
await walk(
  "the iPhone: review the address, wait, approved",
  "iphone",
  [
    [link("Scan a setup code"), "iphone-review"],
    [link("Connect"), "iphone-waiting"],
    [link("The gateway's owner approves"), "iphone-done"],
  ],
);
await walk("approve from here, through the host's dialog", "approve", [[btn("Approve from here"), null], [hostConfirm, "approve-done"]]);
await walk(
  "Tailscale on, checked",
  "tailscale",
  [
    [(p) => p.getByRole("switch", { name: "Private access with Tailscale" }).click(), null],
    [hostConfirm, "tailscale-steps"],
  ],
  "tailscale-on",
);
await walk(
  "Tailscale off",
  "tailscale-on",
  [
    [(p) => p.getByRole("switch", { name: "Private access with Tailscale" }).click(), null],
    [hostConfirm, "tailscale"],
  ],
);
await walk("remove OpenClaw: named computer, the host's dialog, then what is left", "uninstall", [[btn("Remove…"), null], [hostConfirm, "uninstall-partial"]]);
await walk("advanced: the address-and-token form as built", "first", [[link("Advanced"), "connect.html"]]);
await walk("cancel an install: the host confirms, nothing left", "installing", [[btn("Cancel"), null], [hostConfirm, "notfound"]]);

// Part 2: every state, its words ---------------------------------------------------------------
const WORDS = {
  first: ["Where does OpenClaw run?", "This computer", "Clawtrate looks for OpenClaw here.", "Another computer", "A computer you reach with SSH, such as a server or a desktop at home.", "Have a setup code?", "Advanced", "New to OpenClaw? Choose where it should run, and Clawtrate offers to set it up there."],
  "looking-here": ["Looking on this computer", "Finding OpenClaw", "Checking its version", "Asking the gateway"],
  found: ["On this computer", "OpenClaw is running", "2026.10.6", "Profile", "default", "On this computer only", "LaunchAgent, starts when you log in", "Connect", "Connect pairs this computer with the gateway as a device that can only read, and the gateway keeps it. Sending or changing anything is asked for later."],
  "connecting-here": ["Connecting", "Making a one-time code", "Pairing this computer, read-only", "Loading your bots"],
  stopped: ["OpenClaw is installed but not running", "LaunchAgent, stopped", "Start OpenClaw"],
  untested: ["OpenClaw 2026.9.37 isn't the version this Clawtrate is tested with (2026.10.6). Clawtrate connects read-only, and won't run commands on this computer for you until the versions match.", "Connect read-only", "How to update"],
  tooold: ["This OpenClaw is too old for Clawtrate", "OpenClaw 2026.6.2 speaks an older protocol than Clawtrate needs. Update it, then look again.", "Look again"],
  "setup-missing": ["OpenClaw seems to be set up here, but Clawtrate can't find its program", "Clawtrate looked in the usual places."],
  canttell: ["Clawtrate couldn't tell what is on this computer", "Asking the gateway didn't finish in time.", "Look again"],
  nottoken: ["This gateway uses another way to sign in", "Clawtrate connects by itself only to gateways that use a token. Use Advanced."],
  notfound: ["OpenClaw isn't on this computer", "Set up OpenClaw here", "It runs on another computer", "Clawtrate also saw another OpenClaw service here (OpenClaw Gateway (work)). It connects only to the default gateway and its own; use Advanced for others."],
  "notfound-windows": ["OpenClaw isn't on this computer", "Clawtrate doesn't set OpenClaw up on Windows yet: OpenClaw's Windows installer changes this computer's Node.js, npm and PATH, which Clawtrate won't do for you.", "Use another computer", "OpenClaw's own install instructions"],
  there: ["Another computer", "SSH host or alias", "Clawtrate uses your SSH keys and the host's settings from your SSH configuration, and never asks for a password.", "Look there", "Have a setup code instead?"],
  "there-config": ["devbox is reached through another computer.", "Clawtrate doesn't connect through jump hosts yet. Use a setup code made on devbox, or Advanced."],
  "looking-there": ["Looking on devbox", "Reaching devbox", "Finding OpenClaw"],
  unreachable: ["Can't reach devbox", "Nothing answered at devbox.example (connection refused).", "Check the name and that the computer is on.", "Try again"],
  refused: ["devbox didn't accept your key", "The SSH sign-in for you@devbox.example was refused.", "Check that your key is on that computer. A key with a passphrase has to be in your SSH agent first."],
  hostkey: ["Is this devbox?", "This is the first time Clawtrate connects to devbox. Its key is below. If you can, compare it with the key devbox itself shows before you trust it.", "ED25519", "SHA256:Q3v8Lw0e Xk2Rj9Ta Nf5Hc1Ub Ym7Pd4Gs Zi6Ko2Ea Vr8", "How to compare", "Trust this key…"],
  "hostkey-changed": ["devbox's key has changed", "This happens when a computer is reinstalled, and it is also what someone between you and devbox would cause. Clawtrate won't connect until you decide.", "Trusted", "Presented now", "Replace the trusted key…"],
  "found-there": ["On devbox", "OpenClaw is running", "On devbox only", "systemd user service, starts with your session", "Connect"],
  "connecting-there": ["Connecting to devbox", "Making a one-time code on devbox", "Opening a private connection to devbox", "Pairing this computer, read-only", "Loading your bots"],
  "notfound-there": ["OpenClaw isn't on devbox", "Set up OpenClaw on devbox"],
  "install-confirm": ["Set up OpenClaw on this computer", "OpenClaw 2026.10.6, the version this Clawtrate is tested with, with its own copy of Node.js 24.22.1", "Its own folders: the program in Clawtrate's folder, the gateway's data in ~/.openclaw-clawtrate. An OpenClaw you already have isn't touched.", "OpenClaw and Node.js are checked against fingerprints built into this Clawtrate before anything runs.", "npm then downloads about 345 packages OpenClaw uses from the npm registry. Clawtrate can't check those.", "as a LaunchAgent that starts when you log in", "Nothing is asked for: no account and no model key.", "OpenClaw keeps running if you remove Clawtrate. Remove it in Settings first if you want it gone.", "Set up OpenClaw…"],
  "install-confirm-there": ["Set up OpenClaw on devbox", "~/.local/share/clawtrate/openclaw and ~/.openclaw-clawtrate on devbox. An OpenClaw already there isn't touched.", "Clawtrate can't check those."],
  installing: ["Setting up OpenClaw", "Download and check OpenClaw 2026.10.6", "Install Node.js and OpenClaw", "Node.js 24.22.1, checked", "Set up the gateway", "Start and check", "Connect", "The times are samples.", "Cancel"],
  "installing-there": ["Setting up OpenClaw", "On devbox", "OpenClaw 2026.10.6, 345 packages"],
  "install-failed": ["Install Node.js and OpenClaw failed.", "The installer didn't use the checked Node.js.", "Try again", "Show details", "Exit status"],
  approve: ["Waiting for the gateway's owner.", "openclaw devices approve e5eb4aa8-175f-40f1-bc7a-8f15cfc40942", "Check that the request is yours: this computer's device code is 5AE2-3AFF.", "Request e5eb4aa8", "Approve from here", "Check now", "Cancel request"],
  "approve-untested": ["Run this on devbox.", "openclaw devices approve"],
  "approve-done": ["Access granted", "· you can send, stop and answer"],
  restoring: ["Restoring the connection to devbox", "· showing saved messages", "Retry now"],
  "route-changed": ["This address now leads to a different gateway", "Review"],
  uninstall: ["Remove OpenClaw from devbox?", "devbox.example, which reports its name as devbox-1.", "The service ai.openclaw.clawtrate", "The program in ~/.local/share/clawtrate/openclaw", "The gateway's settings, bots and conversations in ~/.openclaw-clawtrate", "Keep the gateway's settings, bots and conversations", "Remove…"],
  "uninstall-partial": ["OpenClaw is removed.", "macOS moved its service file to your Trash.", "Part of OpenClaw is still on devbox:", "~/Library/Logs/openclaw/gateway-clawtrate.log"],
  phone: ["Connect a phone", "Make a one-time code that Clawtrate on your iPhone can scan. It works once, for 10 minutes, and it can only ask to read.", "Make a code…"],
  "phone-code": ["This code leads to devbox.local on your local network. The connection isn't encrypted until the phone is paired; use it only on a network you trust.", "Sample", "Open Clawtrate on your iPhone and scan this code.", "Expires at 20:41 (in 9 minutes)", "Waiting for the phone"],
  "phone-request": ["Check that the device code matches the one on your iPhone.", "iPhone · 7C41-D2E0", "Asks to read bots, tasks and conversations", "Approve…", "Not now"],
  "phone-overreach": ["Asks for more than read access. Clawtrate won't approve it here."],
  "phone-done": ["iPhone connected, read-only."],
  "phone-expired": ["This code has expired.", "Make a new code…"],
  "phone-loopback": ["A phone can't reach this gateway yet.", "It only listens on devbox itself.", "Turn on private access with Tailscale", "Or let OpenClaw listen on your local network. Run these on devbox yourself:", "openclaw config set gateway.bind lan", "openclaw gateway restart", "Anyone on that network can then reach the gateway's sign-in; it still needs a token or a pairing. Clawtrate doesn't change the gateway's bind for you."],
  code: ["Use a setup code", "Setup code"],
  "code-pairing": ["Approve this device", "openclaw devices approve", "Read bots, tasks and conversations", "this computer's device code 5AE2-3AFF"],
  iphone: ["Connect to your OpenClaw", "Scan a setup code", "Paste a setup code", "Make a code in Clawtrate on your computer, in Settings, Connect a phone.", "Advanced"],
  "iphone-review": ["Connect to devbox?", "This code leads to devbox.tailnet.example, through Tailscale. Your phone needs Tailscale on.", "Expires at 20:41 (in 9 minutes)", "Connect", "Cancel"],
  "iphone-waiting": ["Waiting for approval", "Approve this iPhone in Clawtrate on your computer. Its device code is:", "7C41-D2E0", "Or, on the gateway's computer, run:", "Waiting for approval, checking again in 4s"],
  "iphone-done": ["Connected, read-only", "Open Clawtrate"],
  tailscale: ["Private access with Tailscale", "Reach this gateway from your own devices anywhere, through Tailscale. Tailscale is never needed for anything else.", "devbox over SSH · In use", "Connect a phone", "Installed by Clawtrate · OpenClaw 2026.10.6", "Remove this gateway…", "Remove OpenClaw…"],
  "tailscale-steps": ["Checking Tailscale", "Turning on private access", "Restarting OpenClaw", "Checking the new address", "Checking the connection here"],
  "tailscale-on": ["On · devbox.tailnet.example · checked on devbox"],
  "tailscale-missing": ["Tailscale isn't installed on devbox.", "Install Tailscale on devbox and sign in, then turn this on again.", "Nothing was changed."],
  "tailscale-stopped": ["Tailscale is stopped on devbox.", "Start Tailscale on devbox, then turn this on again.", "Nothing was changed."],
  "tailscale-signedout": ["Tailscale is signed out on devbox.", "Sign in to Tailscale on devbox, then turn this on again."],
  "tailscale-operator": ["OpenClaw can't use Tailscale on devbox.", "sudo tailscale set --operator=$USER"],
  "tailscale-https": ["HTTPS isn't turned on for this tailnet.", "Turn on HTTPS certificates in your Tailscale admin console, then turn this on again.", "The setting is back as it was, and the gateway answers again."],
  "tailscale-unconfirmed": ["The setting is back as it was, but the gateway hasn't answered yet. Clawtrate keeps checking."],
  "tailscale-foreign": ["A Tailscale route to this gateway already exists.", "Clawtrate didn't make it and leaves it alone. OpenClaw refuses connections through it unless its owner sets gateway.trustedProxies."],
  "tailscale-outside": ["On, set outside Clawtrate. Change it on devbox."],
};

let p = await open("screen=first");
const listed = await p.evaluate(() => window.CT.setupScreens);
const hostOps = await p.evaluate(() => window.CT.setupHostDialogs);
check("every state the page offers is checked", listed.every((s) => s in WORDS), listed.filter((s) => !(s in WORDS)).join(", "));
check("every state checked is offered by the page", Object.keys(WORDS).every((s) => listed.includes(s)), Object.keys(WORDS).filter((s) => !listed.includes(s)).join(", "));
await p.close();

for (const [screen, words] of Object.entries(WORDS)) {
  p = await open(`screen=${screen}`);
  const t = await text(p);
  check(`${screen}: its words`, !missing(t, words), missing(t, words));
  check(
    `${screen}: its title or status has focus and is announced`,
    await p.evaluate(() => {
      const h = document.querySelector("[data-s-title]");
      return Boolean(h) && document.activeElement === h && document.getElementById("setup-live").textContent === h.textContent;
    }),
  );
  check(`${screen}: no page errors`, p.errors.length === 0, p.errors.join(" | "));
  check(`${screen}: no field for a shared token`, !(await p.evaluate(() => document.querySelector('input[type="password"]'))));
  await p.close();
}

// Part 3: the host's confirmations ---------------------------------------------------------------
const HOST_WORDS = {
  trustKey: ["Trust devbox's key?", "Clawtrate will connect to devbox only while it presents this key."],
  replaceKey: ["Replace devbox's trusted key?", "I checked the new key on devbox itself"],
  start: ["Start OpenClaw on this computer?", "Starts the LaunchAgent ai.openclaw.gateway. It keeps running after Clawtrate closes."],
  install: ["Set up OpenClaw on this computer?", "which Clawtrate can't check"],
  installThere: ["Set up OpenClaw on devbox?", "devbox.example, which reports its name as devbox-1."],
  cancelInstall: ["Stop setting up OpenClaw?", "Nothing else is touched."],
  approve: ["Approve this request on devbox?", "Gateway: devbox · gateway c5fd-e286, as you on devbox.example.", "Device: Clawtrate Desktop · 5AE2-3AFF, this computer.", "Adds: Send messages and stop runs. Answer questions. Approve actions."],
  approvePhone: ["Device: iPhone · 7C41-D2E0.", "Adds: Read bots, tasks and conversations."],
  phoneCode: ["Make a one-time setup code on devbox?", "Anyone who has the code in the next 10 minutes can ask to connect. Nothing connects until you approve it."],
  tailscaleOn: ["Turn on private access on devbox?", "If anything fails, Clawtrate puts the setting back as it was and checks that the gateway answers."],
  tailscaleOff: ["Turn off private access on devbox?", "Devices using the Tailscale address stop reaching it."],
  removeRoute: ["Remove devbox from Clawtrate?", "leaves OpenClaw on devbox running", "Also stop OpenClaw on devbox (Clawtrate started it)"],
  uninstall: ["Remove OpenClaw from devbox?", "devbox.example, which reports its name as devbox-1.", "The service ai.openclaw.clawtrate."],
};
check("every host dialog is checked", hostOps.every((op) => op in HOST_WORDS), hostOps.filter((op) => !(op in HOST_WORDS)).join(", "));
for (const [op, words] of Object.entries(HOST_WORDS)) {
  p = await open(`screen=first&host=${op}`);
  const t = await text(p, "[data-host-dialog]");
  check(`host dialog ${op}: its words`, !missing(t, words), missing(t, words));
  check(`host dialog ${op}: says it is the app's own dialog, not the page`, t.includes("The app's own dialog, not part of the page"));
  await p.close();
}

p = await open("screen=hostkey-changed");
await click(p, '[data-host="replaceKey"]');
check("replace key: the host's dialog can't be confirmed before its checkbox is ticked", await p.evaluate(() => document.querySelector("[data-host-confirm]").getAttribute("aria-disabled") === "true"));
// Playwright won't click an aria-disabled control, so the click is dispatched as a person's would be.
await p.evaluate(() => document.querySelector("[data-host-confirm]").click());
await p.waitForTimeout(150);
check("replace key: clicking the unticked confirm does nothing", (await screenOf(p)) === "hostkey-changed");
check("host dialog: everything behind it is inert", await p.evaluate(() => [...document.getElementById("root").children].filter((el) => !el.hasAttribute("data-host-scrim")).every((el) => el.inert)));
check("host dialog: its title has focus", await p.evaluate(() => document.activeElement?.id === "s-host-title"));
for (let i = 0; i < 6; i++) await p.keyboard.press("Tab");
check("host dialog: Tab stays inside it", await p.evaluate(() => Boolean(document.activeElement?.closest("[data-host-dialog]"))));
await p.keyboard.press("Escape");
check("host dialog: Escape closes it and returns focus to the button that opened it", await p.evaluate(() => !document.querySelector("[data-host-scrim]") && document.activeElement?.dataset.host === "replaceKey"));
await p.close();

p = await open("screen=phone");
check("phone: nothing is made before the host's dialog (no QR, no code)", await p.evaluate(() => !document.querySelector(".s-qr") && !document.querySelector('[aria-label="Copy setup code"]')));
await p.close();

// Part 4: what each state may and may not offer ---------------------------------------------------
const offers = async (query, label, fn) => {
  p = await open(query);
  check(label, await p.evaluate(fn));
  await p.close();
};
await offers("screen=connecting-here", "connecting here: says nothing about SSH or another computer", () => !/SSH|devbox|private connection/.test(document.getElementById("root").textContent));
await offers("screen=there", "there, first visit: no remembered computers", () => !document.querySelector(".s-remembered"));
await offers("screen=there&returning=1", "there, return visit: the remembered computer", () => document.querySelector(".s-remembered")?.textContent.includes("OpenClaw 2026.10.6 · last used today"));
await offers("screen=hostkey-changed", "changed key: no way to trust it without the host's dialog", () => !document.querySelector('a[href*="found-there"]') && document.querySelector('[data-host="replaceKey"]') !== null);
await offers("screen=phone-overreach", "a request for more than read: no Approve", () => !document.querySelector('[data-host="approvePhone"]'));
await offers("screen=approve-untested", "untested version: no Approve from here, the command to run instead", () => !document.querySelector('[data-host="approve"]') && document.body.textContent.includes("Run this on devbox."));
await offers("screen=notfound-windows", "Windows: setting up is not offered", () => !/Set up OpenClaw/.test(document.getElementById("root").textContent));
await offers("screen=first&os=windows", "Windows first screen: the hint points to another computer", () => document.body.textContent.includes("New to OpenClaw? Choose Another computer to use or set up OpenClaw on a Mac or a Linux computer."));
await offers("screen=tailscale-foreign", "a route Clawtrate didn't make: the switch is disabled", () => document.querySelector('[role="switch"]').disabled);
await offers("screen=tailscale-outside", "set outside Clawtrate: the switch is disabled", () => document.querySelector('[role="switch"]').disabled);
await offers("screen=tailscale-steps", "while turning on: the switch is disabled", () => document.querySelector('[role="switch"]').disabled);
await offers("screen=install-failed", "a failed step is drawn failed and the later ones wait", () => [...document.querySelectorAll(".s-steps li")].map((li) => li.dataset.state).join(",") === "done,failed,waiting,waiting,waiting");
await offers("screen=unreachable", "a failure is an alert", () => document.querySelector('.b-note[data-tone="danger"]')?.getAttribute("role") === "alert");
await offers("screen=phone-code", "the QR is labelled as a sample", () => document.querySelector(".s-qr .s-sample")?.textContent === "Sample");
await offers("screen=uninstall&keep=1", "keeping the data strikes out the data line", () => document.querySelector(".s-kept")?.textContent.includes("~/.openclaw-clawtrate"));

for (const [screen, running] of [
  ["looking-here", "Checking its version"],
  ["looking-there", "Finding OpenClaw"],
  ["connecting-here", "Pairing this computer, read-only"],
  ["connecting-there", "Opening a private connection to devbox"],
  ["installing", "Install Node.js and OpenClaw"],
  ["tailscale-steps", "Checking the new address"],
]) {
  p = await open(`screen=${screen}`);
  const steps = await p.evaluate(() => [...document.querySelectorAll(".s-steps li")].map((li) => ({ state: li.dataset.state, label: li.getAttribute("aria-label"), current: li.getAttribute("aria-current") })));
  const current = steps.filter((s) => s.current === "step");
  check(`${screen}: one running step, marked as the current step`, current.length === 1 && current[0].label === `${running}, running`);
  check(`${screen}: each step's state is in its name`, steps.every((s) => s.label.endsWith(`, ${s.state}`)));
  check(`${screen}: has a way back or out`, await p.evaluate(() => Boolean(document.querySelector("[data-back], [data-host='cancelInstall'], .b-close"))));
  await p.close();
}

// Part 5: the SSH field, Back, and the pasted code ------------------------------------------------
p = await open("screen=there");
for (const bad of ["-oProxyCommand=sh", "-user@host", "devbox; rm", "host name", "user@host:22", ".hidden"]) {
  await p.fill("#ssh-host", bad);
  await p.press("#ssh-host", "Enter");
  await p.waitForTimeout(40);
  check(`there: "${bad}" is refused before anything runs`, (await text(p)).includes("That isn't an SSH host or alias Clawtrate can use.") && (await screenOf(p)) === "there");
}
await p.fill("#ssh-host", "devbox");
await p.press("#ssh-host", "Enter");
await at(p, "looking-there");
await click(p, "[data-back]");
check("Back from the look keeps the typed host", (await at(p, "there")) && (await p.inputValue("#ssh-host")) === "devbox");
await p.close();

p = await open("screen=code");
const where = () => text(p, "#code-where");
const connectOff = () => p.evaluate(() => document.getElementById("code-connect").getAttribute("aria-disabled") === "true" && !document.getElementById("code-connect").hasAttribute("href"));
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
check("code: Connect is unavailable before a code", await connectOff());
await p.fill("#setup-code", "invalid");
check("code: something that isn't a code says so, and Connect stays unavailable", (await where()) === "That isn't a setup code Clawtrate can use." && (await connectOff()));
await p.fill("#setup-code", enc({ url: "ws://devbox.local:18789", bootstrapToken: "sample", expiresAtMs: 1000 }));
check("code: an expired code says so, and Connect stays unavailable", (await where()) === "This code has expired. Make a new one on the gateway's computer." && (await connectOff()));
await p.fill("#setup-code", enc({ url: "ws://127.0.0.1:18789", bootstrapToken: "sample", expiresAtMs: 4102444800000 }));
check("code: a loopback code works only where it was made", (await where()).startsWith("This code leads to the computer it was made on") && (await connectOff()));
await p.fill("#setup-code", enc({ url: "wss://user:pw@gateway.example", bootstrapToken: "sample", expiresAtMs: 4102444800000 }));
check("code: an address with a user name is refused", (await where()) === "That isn't a setup code Clawtrate can use." && (await connectOff()));
await p.fill("#setup-code", enc({ url: "wss://gateway.example", bootstrapToken: "sample", expiresAtMs: 4102444800000 }));
check("code: an encrypted address is named, and Connect is available", (await where()) === "Connects to gateway.example, over an encrypted connection. Expires at 20:41." && !(await connectOff()));
check("code: the token is never shown", !(await text(p, "#code-where")).includes("sample"));
await p.close();

// Part 6: keyboard ----------------------------------------------------------------------------
p = await open("screen=first");
await p.keyboard.press("Tab");
check("first: Tab reaches This computer after the title", await p.evaluate(() => document.activeElement.textContent.includes("This computer")));
await p.keyboard.press("ArrowDown");
check("first: Down moves to Another computer", await p.evaluate(() => document.activeElement.textContent.includes("Another computer")));
await p.keyboard.press("Home");
check("first: Home goes back to This computer", await p.evaluate(() => document.activeElement.textContent.includes("This computer")));
await p.close();

// Part 7: widths, themes, motion -----------------------------------------------------------------
for (const [label, width] of [["1100", 1100], ["800", 800], ["phone", 390]]) {
  for (const screen of ["first", "found", "hostkey", "hostkey-changed", "install-confirm", "installing", "phone-request", "approve", "tailscale-https", "uninstall"]) {
    p = await open(`screen=${screen}&width=${label === "phone" ? "phone" : "full"}`, { width, height: 844 });
    check(`${screen} at ${label}: no sideways scroll`, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await p.close();
  }
}
await offers("screen=first&width=phone", "first at phone width: rows are touch-sized", () => document.querySelector(".b-choice").getBoundingClientRect().height >= 64);
p = await open("screen=phone-code&width=phone", { width: 390, height: 844 });
check("phone code at phone width: a sheet, and a 176 px QR", await p.evaluate(() => Math.round(document.querySelector(".s-qr").getBoundingClientRect().width) === 176 && document.querySelector(".s-scrim .b-dialog").getBoundingClientRect().bottom >= innerHeight - 1));
await p.close();
await offers("screen=iphone", "iphone: shown at phone width with touch sizes", () => document.documentElement.dataset.width === "phone" && document.documentElement.dataset.input === "touch");
for (const theme of ["light", "dark"]) {
  p = await open("screen=phone-code", { theme });
  check(`phone code, ${theme}: the QR stays black on white`, await p.evaluate(() => getComputedStyle(document.querySelector(".s-qr")).backgroundColor === "rgb(255, 255, 255)"));
  await p.close();
}
await offers("screen=installing&motion=reduce", "installing, reduced motion: the running step stands still", () => getComputedStyle(document.querySelector('[data-state="running"] .s-step-mark'), "::before").animationName === "none");
await offers("screen=installing", "installing: the running step turns with full motion", () => getComputedStyle(document.querySelector('[data-state="running"] .s-step-mark'), "::before").animationName === "s-turn");
p = await open("screen=looking-here");
await p.waitForTimeout(2800);
check("a wait reached from the address holds, so it can be looked at", (await screenOf(p)) === "looking-here");
await p.close();

// Part 8: the gallery and the bar reach this page -----------------------------------------------
p = await b.newPage();
await p.goto(pageUrl("gallery.html") + "?chrome=1");
await p.waitForTimeout(100);
check("gallery: links to the setup page", await p.evaluate(() => [...document.querySelectorAll("a")].some((a) => a.getAttribute("href")?.startsWith("setup.html"))));
check("the prototype bar links to the setup page", await p.evaluate(() => [...document.querySelectorAll("#proto-bar a")].some((a) => a.getAttribute("href") === "setup.html")));
await p.close();

await b.close();
console.log(out.join("\n"));
console.log(`${out.filter((l) => l.startsWith("ok")).length} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
