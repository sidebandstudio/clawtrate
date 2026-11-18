// Checks for setup.html: every state of docs/design/setup.md, its words and its
// structure, and the keyboard, phone and reduced-motion rules.
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
  await p.waitForTimeout(120);
  p.errors = errors;
  return p;
};
const text = (p, sel = "#setup-root") => p.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, " ") || "", sel);
const has = (t, ...words) => words.every((w) => t.includes(w));
const missing = (t, ...words) => words.filter((w) => !t.includes(w)).join(" | ");

process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

// Every state: its words. Each entry is the state and the words the design gives it.
const WORDS = {
  first: [
    "Clawtrate",
    "Your OpenClaw agents, orchestrated.",
    "Where does OpenClaw run?",
    "This computer",
    "Clawtrate looks for OpenClaw here.",
    "Another computer",
    "A computer you reach with SSH, such as a server or a desktop at home.",
    "Have a setup code?",
    "Advanced",
    "New to OpenClaw? Choose where it should run, and Clawtrate offers to set it up there.",
  ],
  "looking-here": ["Looking on this computer", "Finding OpenClaw", "Checking its version", "Asking the gateway"],
  found: [
    "On this computer",
    "OpenClaw is running",
    "Version",
    "2026.10.6",
    "Listens",
    "On this computer only",
    "Starts",
    "With the computer",
    "Connect",
    "Clawtrate asks for read access. Sending or changing anything is asked for later, once.",
  ],
  stopped: ["OpenClaw is installed but not running", "With the computer, but stopped now", "Start OpenClaw"],
  "start-confirm": [
    "Start OpenClaw on this computer?",
    "The gateway starts as a service and keeps running after Clawtrate closes.",
    "Start",
    "Cancel",
  ],
  refusing: [
    "The gateway here won't let Clawtrate in",
    "This computer's OpenClaw is set to connect to another gateway.",
    "Look on another computer",
  ],
  notfound: ["OpenClaw isn't on this computer", "Set up OpenClaw here", "It runs on another computer"],
  older: [
    "OpenClaw 2026.9.37 is older than the version this Clawtrate is tested with (2026.10.6). Some things may not work.",
    "Connect anyway",
    "How to update",
    "openclaw update",
    "Run it on the gateway's computer when you're ready. Clawtrate doesn't update OpenClaw.",
  ],
  newer: [
    "OpenClaw 2026.11.4 is newer than the version this Clawtrate is tested with (2026.10.6). It should work; if something looks wrong, update Clawtrate.",
  ],
  tooold: [
    "This OpenClaw is too old for Clawtrate",
    "OpenClaw 2026.6.2 speaks an older protocol than Clawtrate needs. Update it, then look again.",
    "Look again",
  ],
  several: ["Two gateways run here", "OpenClaw · port 18789", "OpenClaw · port 19001"],
  there: [
    "Another computer",
    "SSH host or alias",
    "Clawtrate uses your SSH settings and keys, and never asks for a password.",
    "Look there",
    "Have a setup code instead?",
    "devbox",
    "OpenClaw 2026.10.6 · last used today",
  ],
  "looking-there": ["Looking on devbox", "Reaching devbox", "Finding OpenClaw", "Checking its version", "Asking the gateway"],
  unreachable: [
    "Can't reach devbox",
    "Nothing answered at devbox.example (connection refused).",
    "Check the name and that the computer is on. A VPN or a jump host goes in your SSH settings.",
    "Try again",
  ],
  refused: [
    "devbox didn't accept your key",
    "The SSH sign-in for you@devbox.example was refused.",
    "Check that your key is on that computer. A key with a passphrase has to be in your SSH agent first.",
  ],
  hostkey: [
    "Is this devbox?",
    "Clawtrate hasn't connected to devbox before. Check that this matches the key the computer shows, then trust it.",
    "ED25519",
    "SHA256:Q3v8Lw0e Xk2Rj9Ta Nf5Hc1Ub Ym7Pd4Gs Zi6Ko2Ea Vr8",
    "How to check",
    "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub",
    "Trust and connect",
  ],
  "hostkey-changed": [
    "devbox's identity has changed",
    "The key devbox sent is not the one trusted before. This can mean someone is between you and that computer, so Clawtrate won't connect. If devbox was reinstalled, remove its old key from your SSH settings, then try again.",
    "The key devbox sent",
    "Try again",
  ],
  "found-there": ["On devbox", "OpenClaw is running", "On devbox only", "Connect"],
  connecting: [
    "Connecting to devbox",
    "Making a one-time code on devbox",
    "Opening a private connection to devbox",
    "Connecting",
    "Loading your bots",
  ],
  "install-confirm": [
    "Set up OpenClaw on this computer",
    "OpenClaw 2026.10.6, the version this Clawtrate is tested with, and its own copy of Node.js",
    "In Clawtrate's folder, about 830 MB",
    "The npm registry and nodejs.org",
    "A gateway that listens on this computer only, starts with the computer, and has no AI provider yet. You sign in to one when you make your first bot.",
    "Nothing is asked for: no account and no model key.",
    "OpenClaw keeps running if you remove Clawtrate. To remove it too, use Settings first.",
    "Download and set up",
    "Cancel",
  ],
  "install-confirm-win": [
    "For every program on this computer, through npm",
    "The npm registry, nodejs.org, and Windows Package Manager if Node.js needs updating",
    "as a scheduled task",
    "If this computer's Node.js is older than OpenClaw needs, Windows Package Manager updates it for every program.",
  ],
  installing: [
    "Setting up OpenClaw",
    "Download OpenClaw 2026.10.6",
    "Install Node.js and OpenClaw",
    "Node.js 24.22.1",
    "0:14",
    "Set up the gateway",
    "Start and check",
    "Connect",
    "Cancel",
  ],
  "install-failed": [
    "Install Node.js and OpenClaw failed.",
    "npm install did not produce a usable OpenClaw package",
    "Try again",
    "Show details",
    "Cancel",
  ],
  "install-cancel": [
    "Stop setting up OpenClaw?",
    "Clawtrate stops and removes what it installed in its folder. Nothing else on this computer was changed.",
    "Stop and remove",
    "Keep going",
  ],
  approve: [
    "Waiting for the gateway's owner.",
    "Approve this request on the gateway's machine:",
    "openclaw devices approve e5eb4aa8-175f-40f1-bc7a-8f15cfc40942",
    "Request e5eb4aa8",
    "checking again in 4s",
    "Approve from here",
    "Check now",
    "Cancel request",
  ],
  "approve-confirm": [
    "Approve on devbox?",
    "Send messages and stop runs",
    "Answer questions",
    "Approve actions",
    "Clawtrate runs OpenClaw's approve command on devbox for request e5eb4aa8.",
    "Approve",
    "Cancel",
  ],
  restoring: ["Restoring the connection to devbox", "· showing saved messages", "Retry now"],
  remove: [
    "Remove devbox from Clawtrate?",
    "Clawtrate disconnects and forgets how to reach it. OpenClaw keeps running on devbox.",
    "Also stop OpenClaw on devbox. Clawtrate started it.",
    "Remove",
  ],
  uninstall: [
    "Remove OpenClaw from this computer?",
    "This removes the gateway service, its settings, its bots and their conversations, and the program. It can't be undone.",
    "Keep the bots and their conversations",
  ],
  phone: ["Connect a phone", "Works on the same Wi-Fi as this computer.", "Expires in 9:41"],
  "phone-request": ["Clawtrate iPhone wants to connect", "Read bots, tasks and conversations", "Approve", "Not now"],
  "phone-expired": ["This code has expired.", "Make a new code"],
  "phone-loopback": [
    "A phone can't reach this gateway yet.",
    "It only listens on this computer.",
    "Turn on private access with Tailscale",
    "Or set OpenClaw to listen on your network (gateway.bind).",
  ],
  code: [
    "Use a setup code",
    "Setup code",
    "Connects to devbox.local, on your network. Expires in 8 minutes.",
    "Connect",
  ],
  iphone: [
    "Connect to your OpenClaw",
    "Scan a setup code",
    "Paste a setup code",
    "Make a code in Clawtrate on your computer, in Settings, Connect a phone. Or run openclaw qr on the gateway's computer.",
    "Advanced",
  ],
  "iphone-waiting": [
    "Waiting for approval",
    "Connects to devbox.tailnet.example, through Tailscale.",
    "Approve this iPhone in Clawtrate on your computer, or run this on the gateway's computer:",
    "openclaw devices approve",
    "Waiting for approval, checking again in 4s",
  ],
  tailscale: [
    "Private access with Tailscale",
    "Reach this gateway from your own devices anywhere, through Tailscale. Tailscale is never needed for anything else.",
    "devbox over SSH · In use",
    "Connect a phone",
    "Installed by Clawtrate · OpenClaw 2026.10.6 · Starts with the computer",
    "Remove this gateway",
    "Remove OpenClaw…",
  ],
  "tailscale-confirm": [
    "Turn on private access?",
    "OpenClaw restarts on devbox. Your devices signed in to Tailscale can then reach it at an address like devbox.tailnet.example. Clawtrate reconnects by itself.",
    "Turn on",
  ],
  "tailscale-missing": [
    "Tailscale isn't installed on devbox.",
    "Install Tailscale on devbox and sign in, then turn this on again.",
    "The gateway is reachable the way it was.",
  ],
  "tailscale-signedout": [
    "Tailscale is signed out on devbox.",
    "Sign in to Tailscale on devbox, then turn this on again.",
    "The gateway is reachable the way it was.",
  ],
  "tailscale-https": [
    "HTTPS isn't turned on for this tailnet.",
    "Turn on HTTPS certificates in your Tailscale admin console, then turn this on again.",
    "The gateway is reachable the way it was.",
  ],
  "tailscale-foreign": [
    "A Tailscale route to this gateway already exists.",
    "Clawtrate didn't make it and leaves it alone. OpenClaw refuses connections through it unless its owner sets gateway.trustedProxies.",
  ],
  advanced: [
    "Advanced",
    "Clawtrate works with an OpenClaw gateway you already run. It asks for read access only, and the token is used once.",
  ],
};

// Part 1: every state renders with its words, a focused title, no errors -------------------------
let p = await open("screen=first");
const listed = await p.evaluate(() => window.CT.setupScreens);
check("every state the page offers is checked", listed.every((s) => s in WORDS), listed.filter((s) => !(s in WORDS)).join(", "));
check("every state checked is offered by the page", Object.keys(WORDS).every((s) => listed.includes(s)));
await p.close();

for (const [screen, words] of Object.entries(WORDS)) {
  p = await open(`screen=${screen}`);
  const t = await text(p);
  check(`${screen}: its words`, has(t, ...words), missing(t, ...words));
  if (["approve", "restoring"].includes(screen)) {
    // A state inside the app: the access bar or the strip, each a status region.
    check(`${screen}: a status region inside the app`, await p.evaluate(() => document.querySelector('.access-bar[role="status"], .status-strip[role="status"]') !== null));
  } else {
    const title = await p.evaluate(() => {
      const h = document.querySelector("[data-s-title]");
      return h && document.activeElement === h && document.getElementById("setup-live").textContent === h.textContent;
    });
    check(`${screen}: its title has focus and is announced`, title);
  }
  check(`${screen}: no page errors`, p.errors.length === 0, p.errors.join(" | "));
  check(
    `${screen}: no field for the shared token outside Advanced`,
    screen === "advanced" ? true : !(await p.evaluate(() => document.querySelector('input[type="password"]'))),
  );
  await p.close();
}

// Part 2: structure -------------------------------------------------------------------------------
p = await open("screen=first");
check(
  "first: two choices, each opening the next screen",
  await p.evaluate(() => {
    const rows = [...document.querySelectorAll(".b-choices .b-choice")];
    return rows.length === 2 && rows[0].href.includes("screen=looking-here") && rows[1].href.includes("screen=there");
  }),
);
check("first: no question about being new or experienced", !(await text(p)).includes("I already use"));
check("first: the bots stand along the foot, hidden from screen readers", await p.evaluate(() => document.querySelector(".ensemble")?.getAttribute("aria-hidden") === "true"));
await p.keyboard.press("Tab");
check("first: Tab reaches This computer after the title", await p.evaluate(() => document.activeElement.textContent.includes("This computer")));
await p.close();

for (const [screen, running] of [
  ["looking-here", "Checking its version"],
  ["looking-there", "Finding OpenClaw"],
  ["connecting", "Opening a private connection to devbox"],
  ["installing", "Install Node.js and OpenClaw"],
]) {
  p = await open(`screen=${screen}`);
  const steps = await p.evaluate(() =>
    [...document.querySelectorAll(".s-steps li")].map((li) => ({ state: li.dataset.state, label: li.getAttribute("aria-label"), current: li.getAttribute("aria-current") })),
  );
  const current = steps.filter((s) => s.current === "step");
  check(`${screen}: one running step, marked as the current step`, current.length === 1 && current[0].label === `${running}, running`, JSON.stringify(current));
  check(`${screen}: each step's state is in its name`, steps.every((s) => s.label.endsWith(`, ${s.state}`)));
  await p.close();
}

p = await open("screen=install-failed");
check(
  "install-failed: the failed step is drawn failed and the later ones wait",
  await p.evaluate(() => {
    const s = [...document.querySelectorAll(".s-steps li")].map((li) => li.dataset.state);
    return s.join(",") === "done,failed,waiting,waiting,waiting";
  }),
);
check("install-failed: the failure is an alert", await p.evaluate(() => document.querySelector('.b-note[data-tone="danger"]')?.getAttribute("role") === "alert"));
await p.close();

p = await open("screen=looking-here&slow=1");
check("looking-here: after 8 s it says why it is still looking", (await text(p)).includes("Still looking. A gateway that has just started can take a while to answer."));
await p.close();

for (const screen of ["unreachable", "refused", "hostkey-changed"]) {
  p = await open(`screen=${screen}`);
  check(`${screen}: the failure is a danger note announced as an alert`, await p.evaluate(() => document.querySelector('.b-note[data-tone="danger"]')?.getAttribute("role") === "alert"));
  await p.close();
}

p = await open("screen=hostkey-changed");
check("hostkey-changed: there is no way to accept the changed key", !(await text(p)).includes("Trust"));
await p.close();

p = await open("screen=hostkey");
check(
  "hostkey: the fingerprint is read in groups and can be copied without spaces",
  await p.evaluate(() => {
    const code = document.querySelector(".s-print code");
    const copy = document.querySelector(".s-print [data-copy]");
    return code.getAttribute("aria-label").includes("Xk2Rj9Ta, Nf5Hc1Ub") && !copy.dataset.copy.includes(" ");
  }),
);
await p.close();

p = await open("screen=several");
check("several: nothing is chosen at first and Connect waits", await p.evaluate(() => !document.querySelector('[role="radio"][aria-checked="true"]') && document.getElementById("several-connect").disabled));
await p.click('[role="radio"] >> nth=1');
check("several: choosing one enables Connect", await p.evaluate(() => document.querySelectorAll('[role="radio"][aria-checked="true"]').length === 1 && !document.getElementById("several-connect").disabled));
await p.close();

// Part 3: the SSH field refuses what is not an SSH destination -------------------------------------
p = await open("screen=there");
for (const bad of ["-oProxyCommand=sh", "devbox; rm", "host name", "user@host:22"]) {
  await p.fill("#ssh-host", bad);
  await p.click('#ssh-form button[type="submit"]');
  await p.waitForTimeout(40);
  check(`there: "${bad}" is refused before anything runs`, (await text(p)).includes("That isn't an SSH host or alias Clawtrate can use.") && (await p.evaluate(() => location.search.includes("screen=there"))));
}
await p.fill("#ssh-host", "you@devbox.example");
await Promise.all([p.waitForNavigation(), p.click('#ssh-form button[type="submit"]')]);
check("there: an SSH destination starts the look over SSH", await p.evaluate(() => location.search.includes("screen=looking-there")));
await p.close();

// Part 4: a pasted setup code is read here, and says where it leads ------------------------------------
p = await open("screen=code");
await p.fill("#setup-code", "not a code");
check("code: something that is not a code says so", (await text(p, "#code-where")) === "That isn't a setup code.");
const tailnet = Buffer.from(JSON.stringify({ url: "wss://devbox.tailnet.example", bootstrapToken: "sample", expiresAtMs: 0 })).toString("base64url");
await p.fill("#setup-code", tailnet);
check("code: a Tailscale address is named in plain words", (await text(p, "#code-where")) === "Connects to devbox.tailnet.example, through Tailscale.");
check("code: the token is never shown", !(await text(p)).includes("sample"));
await p.close();

// Part 5: dialogs ------------------------------------------------------------------------------------
for (const screen of ["approve-confirm", "install-cancel", "remove", "uninstall", "tailscale-confirm"]) {
  p = await open(`screen=${screen}`);
  check(`${screen}: a modal confirmation`, await p.evaluate(() => document.querySelector('.s-scrim [role="dialog"][aria-modal="true"][data-kind="confirm"]') !== null));
  await p.close();
}
p = await open("screen=remove");
check("remove: stopping the gateway is a choice, off at first", await p.evaluate(() => document.querySelector('.s-check input[type="checkbox"]').checked === false));
await p.close();
p = await open("screen=phone");
check("phone: a QR code with a name, and the code with a copy button", await p.evaluate(() => document.querySelector('.s-qr[role="img"]')?.getAttribute("aria-label") === "QR code of the setup code" && document.querySelector('[aria-label="Copy setup code"]') !== null));
check("phone: the QR stays black on white", await p.evaluate(() => getComputedStyle(document.querySelector(".s-qr")).backgroundColor === "rgb(255, 255, 255)"));
await p.close();
p = await open("screen=phone", { theme: "dark" });
check("phone, dark: the QR stays black on white", await p.evaluate(() => getComputedStyle(document.querySelector(".s-qr")).backgroundColor === "rgb(255, 255, 255)"));
await p.close();
p = await open("screen=tailscale-foreign");
check("tailscale-foreign: the switch is disabled while the other route exists", await p.evaluate(() => document.querySelector("[data-tailscale]").disabled));
await p.close();
p = await open("screen=tailscale");
await Promise.all([p.waitForNavigation(), p.click("[data-tailscale]")]);
check("tailscale: the switch asks first", await p.evaluate(() => location.search.includes("screen=tailscale-confirm")));
await p.close();

// Part 6: widths, themes, motion ----------------------------------------------------------------------
for (const [label, width] of [["1100", 1100], ["800", 800], ["phone", 390]]) {
  for (const screen of ["first", "found", "hostkey", "install-confirm", "installing", "phone", "approve"]) {
    p = await open(`screen=${screen}&width=${label === "phone" ? "phone" : "full"}`, { width, height: 844 });
    const fits = await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    check(`${screen} at ${label}: no sideways scroll`, fits);
    await p.close();
  }
}
p = await open("screen=first&width=phone", { width: 390, height: 844 });
check("first at phone: rows are touch-sized", await p.evaluate(() => document.querySelector(".b-choice").getBoundingClientRect().height >= 64));
await p.close();
p = await open("screen=phone&width=phone", { width: 390, height: 844 });
check("phone at phone width: a sheet, and a 176 px QR", await p.evaluate(() => {
  const d = document.querySelector(".s-scrim .b-dialog").getBoundingClientRect();
  return Math.round(document.querySelector(".s-qr").getBoundingClientRect().width) === 176 && d.bottom >= innerHeight - 1;
}));
await p.close();
p = await open("screen=iphone");
check("iphone: shown at phone width with touch sizes", await p.evaluate(() => document.documentElement.dataset.width === "phone" && document.documentElement.dataset.input === "touch"));
await p.close();
p = await open("screen=installing", { theme: "dark" });
check("installing, dark: the page uses the dark theme", await p.evaluate(() => document.documentElement.dataset.theme === "dark" && getComputedStyle(document.body).backgroundColor !== "rgb(255, 255, 255)"));
await p.close();
p = await open("screen=installing&motion=reduce");
check("installing, reduced motion: the running step stands still", await p.evaluate(() => getComputedStyle(document.querySelector('[data-state="running"] .s-step-mark'), "::before").animationName === "none"));
await p.close();
p = await open("screen=installing");
check("installing: the running step turns with full motion", await p.evaluate(() => getComputedStyle(document.querySelector('[data-state="running"] .s-step-mark'), "::before").animationName === "s-turn"));
await p.close();

// Part 7: the flow plays on only when reached through it ----------------------------------------------
p = await open("screen=first");
await Promise.all([p.waitForNavigation(), p.click(".b-choice >> nth=0")]);
check("first: This computer starts the look", await p.evaluate(() => location.search.includes("screen=looking-here") && location.search.includes("play=1")));
await p.waitForURL(/screen=found/, { timeout: 5000 });
check("looking-here: the look ends on what it found", await p.evaluate(() => location.search.includes("screen=found") && !location.search.includes("play=1")));
await p.close();
p = await open("screen=looking-here");
await p.waitForTimeout(2800);
check("looking-here from the address holds, so it can be looked at", await p.evaluate(() => location.search.includes("screen=looking-here")));
await p.close();

// Part 8: the gallery and the bar reach this page -------------------------------------------------------
p = await b.newPage();
await p.goto(pageUrl("gallery.html") + "?chrome=1");
await p.waitForTimeout(120);
check("gallery: links to the setup page", await p.evaluate(() => [...document.querySelectorAll("a")].some((a) => a.getAttribute("href")?.startsWith("setup.html"))));
check("the prototype bar links to the setup page", await p.evaluate(() => [...document.querySelectorAll("#proto-bar a")].some((a) => a.getAttribute("href") === "setup.html")));
await p.close();

await b.close();
console.log(out.join("\n"));
console.log(`${out.filter((l) => l.startsWith("ok")).length} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
