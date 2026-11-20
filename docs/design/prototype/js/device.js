// Behaviour for device.html: every screen of docs/design/device-node.md,
// chosen with ?screen=<id> (section 15 lists them). Nothing is contacted and
// nothing runs. Each action leads where the real one would, so every path can
// be walked to its outcome by clicking.
//
// The host's confirmation (.s-host), Siri's panel (.d-sys) and the sharing
// app behind the share sheet are stand-ins: the app shows a native dialog, and
// the phone draws its own panels. Events that come from outside the app (the
// gateway's owner approving, a request's time running out) are links in a
// dashed "Prototype" box, which is not product.

(function () {
  const CT = window.CT;
  const params = CT.params;
  const icon = (name) => CT.icon(name);
  const esc = (text) =>
    String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // What the operator connection holds. `write` is the interactive tier;
  // `pairing` adds device access; `admin` is everything.
  const access = ["read", "write", "pairing", "admin"].includes(params.get("access")) ? params.get("access") : "admin";
  const level = { read: 0, write: 1, pairing: 2, admin: 3 }[access];
  const isAdmin = level >= 3;
  const hasPairing = level >= 2;
  const via = params.get("via");

  // Kept from one state to the next; everything else is per state.
  const KEEP = ["theme", "width", "motion", "chrome", "access", "via", "to", "link", "app", "own"];
  const go = (to, extra = {}) => {
    const next = new URLSearchParams();
    for (const key of KEEP) if (params.get(key)) next.set(key, params.get(key));
    next.set("screen", to);
    for (const [key, value] of Object.entries(extra)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    return `device.html?${next}`;
  };

  // Samples. The device names, the gateway's name and the request ids are invented.
  const MAC = "Studio Mac";
  const PHONE = "iPhone";
  const GATEWAY = "devbox";
  const REQUEST = "3c9b20e4-6f1d-4a7e-9b21-58d0c4e7a6f3";
  const SURFACE = "8e14a0c2-57b9-4d3f-a6e1-0f92c3b7d548";
  const BOTS = { juniper: "Juniper", marlow: "Marlow", otto: "Otto", pip: "Pip" };

  // Glyphs for the apps, drawn for this page in the icon set's style.
  const GLYPHS = {
    location: '<path d="M8 13.5s4.25-3.9 4.25-7.25a4.25 4.25 0 1 0-8.5 0C3.75 9.6 8 13.5 8 13.5Z"/><circle cx="8" cy="6.25" r="1.5"/>',
    contacts: '<circle cx="8" cy="5.75" r="2.5"/><path d="M3.25 13.25c.5-2.6 2.4-4.1 4.75-4.1s4.25 1.5 4.75 4.1"/>',
    calendar: '<rect x="2.5" y="3.5" width="11" height="9.75" rx="2"/><path d="M2.5 6.75h11M5.5 2.25v2.5M10.5 2.25v2.5"/>',
    reminders: '<path d="m2.75 4.6 1.1 1.1 1.9-2.1M2.75 9.6l1.1 1.1 1.9-2.1M7.75 4.75h5.5M7.75 9.75h5.5"/>',
    messages: '<path d="M3 4.25c0-.83.67-1.5 1.5-1.5h7c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5H7.6l-2.85 2.5v-2.5H4.5c-.83 0-1.5-.67-1.5-1.5v-5Z"/>',
    mail: '<rect x="2.25" y="3.5" width="11.5" height="9" rx="1.75"/><path d="m2.75 4.5 5.25 4 5.25-4"/>',
    notes: '<rect x="3" y="2.5" width="10" height="11" rx="2"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3"/>',
    alarms: '<circle cx="8" cy="8.5" r="4.75"/><path d="M8 6v2.5l1.75 1.25M3 3.25l1.5-1M13 3.25l-1.5-1"/>',
    home: '<path d="M2.75 7.25 8 2.75l5.25 4.5v6H2.75v-6ZM6.5 13.25v-3.5h3v3.5"/>',
    device: '<rect x="4.25" y="1.75" width="7.5" height="12.5" rx="1.75"/><path d="M7 12h2"/>',
  };
  const glyph = (name) => `<span class="d-glyph"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true">${GLYPHS[name]}</svg></span>`;
  const markDevice = () =>
    `<span class="d-mark"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true">${GLYPHS.device}</svg>This device enforces this</span>`;
  const markGateway = () => `<span class="d-mark">${icon("approval")}The gateway enforces this</span>`;

  // Pieces ----------------------------------------------------------------------

  const logo = "../../../packages/ui/src/assets/logo-mark.png";
  const link = (label, to, { variant, size = "sm", attrs = "" } = {}) =>
    `<a class="button"${variant ? ` data-variant="${variant}"` : ""} data-size="${size}" href="${to}"${attrs ? ` ${attrs}` : ""}>${label}</a>`;
  const proto = (...links) => `<p class="d-proto"><span>Prototype:</span>${links.join("")}</p>`;
  const note = (tone, lead, text, extra = "") =>
    `<div class="b-note"${tone ? ` data-tone="${tone}"` : ""} role="${tone === "danger" ? "alert" : "status"}">` +
    `${icon(tone ? "warning" : "clock")}<div><p>${lead ? `<b>${lead}</b>` : ""}${lead && text ? " " : ""}${text}</p>${extra}</div></div>`;
  const facts = (rows) => `<dl class="facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
  const steps = (list) =>
    `<ol class="s-steps" aria-label="Steps">` +
    list
      .map(([text, state, sub]) => {
        const m = state === "done" ? icon("check") : state === "failed" ? icon("x") : "";
        return (
          `<li data-state="${state}"${state === "running" ? ' aria-current="step"' : ""} aria-label="${esc(text)}, ${state}">` +
          `<span class="s-step-mark">${m}</span><span>${text}</span><span class="s-step-time"></span>` +
          (sub ? `<span class="s-step-sub">${sub}</span>` : "") +
          `</li>`
        );
      })
      .join("") +
    `</ol>`;
  const command = (text, label) =>
    `<div class="command"><code>${esc(text)}</code><button type="button" class="icon-button copy" aria-label="${label}" data-copy="${esc(text)}">${icon("copy")}</button></div><p class="copy-status" aria-live="polite"></p>`;
  const sw = (on, to, label, disabled = false) =>
    `<button type="button" class="b-switch" role="switch" aria-checked="${on}" aria-label="${label}"${disabled ? ' aria-disabled="true"' : ` data-go="${to}"`}></button>`;
  const accessBar = (need, scope, requested = false) =>
    `<section class="access-bar" role="region" aria-label="Access" data-state="${requested ? "requested" : "none"}">` +
    (requested
      ? `<div class="access-row">${icon("clock")}<span class="shelf-text"><b>Waiting for the gateway's owner.</b> Approve this request on the gateway's machine:</span></div>` +
        `<div class="command-line"><code>openclaw devices approve 5d2e7f10</code></div>`
      : `<div class="access-row">${icon("eye")}<span class="shelf-text"><b>${need}</b></span>${link(`Request ${scope}`, go(screenId, { req: "requested" }), { variant: "primary", attrs: 'data-request' })}</div>`) +
    `</section>`;

  // The Settings frame of bots.md §7, standing on its own here.
  const NAV = ["Gateway", "Accounts", "Integrations", "Permissions", "Memory", "Usage", "Machines", "This Mac"];
  const settings = ({ title, body, current = "This Mac", phone = false }) => {
    const nav =
      `<nav class="b-nav" aria-label="Settings"><div class="b-nav-head"><h2>Settings</h2></div>` +
      NAV.map((label) => `<span class="b-nav-item"${label === current ? ' aria-current="page"' : ""}>${label}${icon("chevron")}</span>`).join("") +
      `</nav>`;
    const back = phone ? `<span class="button" data-variant="quiet" data-size="sm">${icon("back")}Settings</span>` : "";
    return (
      `<div class="b-settings" data-pane="section">${phone ? "" : nav}<section class="b-section" aria-labelledby="d-title">` +
      `<header class="b-section-head">${back}<h3 id="d-title" tabindex="-1" data-d-title>${title}</h3></header>` +
      `<div class="b-section-body">${body}</div></section></div>`
    );
  };
  const dialog = (title, body, actions, { role = "alertdialog" } = {}) =>
    `<div class="d-scrim" data-d-dialog><div class="d-dialog" role="${role}" aria-modal="true" aria-labelledby="d-dialog-title">` +
    `<h2 id="d-dialog-title" tabindex="-1">${title}</h2>${body}<div class="d-actions">${actions}</div></div></div>`;

  // Apps ------------------------------------------------------------------------

  // local: allow | allowed | denied | settings. gateway: offered | waiting | notoffered.
  const MAC_APPS = [
    ["location", "Location", "location.get"],
    ["contacts", "Contacts", "contacts.search"],
    ["calendar", "Calendar", "calendar.events"],
    ["reminders", "Reminders", "reminders.list"],
    ["messages", "Messages", null],
    ["mail", "Mail", null],
    ["notes", "Notes", null],
  ];
  const PHONE_APPS = [
    ["calendar", "Calendar", "calendar.events"],
    ["contacts", "Contacts", "contacts.search"],
    ["location", "Location", "location.get"],
    ["reminders", "Reminders", "reminders.list"],
    ["alarms", "Alarms", null],
    ["home", "Home", null],
  ];
  // The owner's choice: what each app outside the defaults can do with the person's account.
  const OWN = {
    messages: ["Messages", "That includes reading your conversations and sending messages as you."],
    mail: ["Mail", "That includes reading your mail and sending mail as you."],
    notes: ["Notes", "That includes reading and changing your notes."],
  };
  const chosen = OWN[params.get("app")] ? params.get("app") : "messages";
  const chosenName = OWN[chosen][0];
  const LOCAL_WORD = { allow: "Allow", allowed: "Allowed", denied: "Denied", settings: "Turned off in System Settings" };
  const GATEWAY_WORD = {
    offered: "Offered to bots",
    waiting: "Waiting for approval",
    notoffered: "Not offered: the gateway's allowlist doesn't include it",
  };

  function appRow([id, name], { local, gateway, off = false, phone = false, action = "" }) {
    const where = phone ? "On this iPhone" : "On this Mac";
    const localWord = local === "settings" && phone ? "Turned off in Settings" : LOCAL_WORD[local];
    const value = off
      ? `<span class="d-value">Off</span>`
      : action || (local === "allowed" || local === "denied" ? `<span class="d-value">${localWord}</span>` : "");
    return (
      `<li><div class="d-app" role="group" aria-label="${name}"${off ? ' aria-disabled="true"' : ""} data-app="${id}">` +
      `${glyph(id)}<div class="d-app-text"><span class="d-app-name">${name}</span>` +
      (off
        ? `<span class="d-fact">Offered when bots may use this ${phone ? "iPhone" : "Mac"}</span>`
        : `<span class="d-fact"${local === "denied" || local === "settings" ? ' data-tone="warn"' : ""}>${where}: <b>${localWord}</b>${markDevice()}</span>` +
          `<span class="d-fact"${gateway === "waiting" ? ' data-tone="warn"' : ""}>On the gateway: <b>${GATEWAY_WORD[gateway]}</b>${gateway === "offered" ? markGateway() : ""}</span>`) +
      `</div><div class="d-app-action">${value}</div></div></li>`
    );
  }

  const botsLine = (phone) =>
    `<h4 class="b-group">Bots that can use this ${phone ? "iPhone" : "Mac"}</h4>` +
    `<p class="d-lead">In their latest tasks, the gateway offered Otto the tool for other devices. Juniper, Marlow and Pip weren't offered it. <span class="d-mark">${icon("eye")}Offered: the gateway's listing, Nov 19</span></p>` +
    `<div class="d-actions">${link("Open a bot's permissions", "controls.html?bot=otto&panel=open&tab=settings&bview=rules")}</div>`;

  const never = (phone) =>
    `<p class="d-never"><b>What this ${phone ? "iPhone" : "Mac"} never offers.</b> Clawtrate never lets a bot run programs, read or list files, use a browser or record the screen on this ${phone ? "iPhone" : "Mac"}. Those commands exist on the gateway; this ${phone ? "iPhone" : "Mac"} doesn't offer them.</p>`;

  const TOLD = [
    ["NOT_ALLOWED_ON_DEVICE", "The person chose Don't allow for Calendar on Studio Mac."],
    ["NO_ANSWER_ON_DEVICE", "No one answered on Studio Mac in time. Calendar is not allowed yet."],
    ["TURNED_OFF_IN_SETTINGS", "Calendar is turned off for Clawtrate in Studio Mac's System Settings."],
    ["TURNED_OFF_ON_DEVICE", "Calendar was turned off on Studio Mac while this request was answered."],
    ["NOT_OPEN_ON_DEVICE", "Clawtrate isn't open on iPhone, so no one could be asked. Ask again when it is open."],
    ["NOT_FROM_YOUR_CHAT", "iPhone answers only requests from the person's own chat with a bot. Ask with the invoke action from that chat."],
    ["NOT_SERVED", "Studio Mac doesn't answer this request."],
    ["UNAVAILABLE_ON_DEVICE", "Calendar couldn't answer on Studio Mac."],
  ];
  const told = () =>
    `<details class="d-told"><summary>What bots are told</summary>` +
    `<p class="d-lead">When this device says no, the bot reads the code and the sentence, and nothing the request carried.</p>` +
    `<table><thead><tr><th>Code</th><th>Sentence</th></tr></thead><tbody>` +
    TOLD.map(([c, s]) => `<tr><td><code>${c}</code></td><td>${s}</td></tr>`).join("") +
    `</tbody></table></details>`;

  // The apps on the desktop page, by the state's address.
  function macApps() {
    const cal = params.get("calendar") === "allowed" ? "allowed" : "allow";
    const own = params.get("own"); // the chosen app's state: offered | denied | null
    return MAC_APPS.map((app) => {
      const [id, name] = app;
      if (id === "location") return appRow(app, { local: "allowed", gateway: "offered" });
      if (id === "contacts") return appRow(app, { local: "settings", gateway: "offered", action: `<button type="button" class="button" data-size="sm" data-where="Opens System Settings, Privacy, for Clawtrate. Nothing opens in the prototype.">Open Settings</button>` });
      if (id === "calendar")
        return appRow(app, {
          local: cal,
          gateway: "offered",
          action: cal === "allow" ? link("Allow", go("mac-on", { calendar: "allowed", said: "Calendar allowed" }), { attrs: 'data-allow="calendar"' }) : "",
        });
      if (id === "reminders") return appRow(app, { local: "denied", gateway: "offered", action: `<span class="d-value">Denied</span>${link("Allow", go("mac-on", { said: "Reminders allowed" }))}` });
      if (id === chosen && own)
        return appRow(app, {
          local: own === "denied" ? "denied" : "allowed",
          gateway: "offered",
          action:
            own === "denied"
              ? `<span class="d-value">Denied</span>`
              : link("Turn off", go("mac-on", { own: "denied", said: `${name} turned off` }), { attrs: `data-turnoff="${id}"` }) +
                (isAdmin ? link("Remove…", go("mac-messages-remove", { own: "offered" }), { variant: "quiet", attrs: `data-remove="${id}"` }) : ""),
        });
      const to = isAdmin ? go("mac-messages-confirm", { app: id, own: null }) : go("mac-messages-needadmin", { app: id, own: null });
      return appRow(app, { local: "allow", gateway: "notoffered", action: link("Allow…", to, { attrs: `data-allowx="${id}"` }) });
    }).join("");
  }

  // The page once the node is on.
  function macOn({ state, extraTop = "" } = {}) {
    const line =
      state ||
      `<p class="d-state" data-tone="ok">Connected. Bots can send requests to this Mac. Approved Nov 19, 5:31 PM.</p>` +
        (via === "silent"
          ? `<p class="d-lead">The gateway approved this Mac by itself, because Clawtrate runs on the gateway's own computer.</p>`
          : "");
    return (
      `<div class="d-switch-row"><h4 id="d-switch-label">Let bots use this Mac</h4>${sw(true, go("mac-stop"), "Let bots use this Mac")}` +
      `<p>Bots that may use other devices can ask this Mac for the apps you allow below. Each app asks you on this Mac first.</p></div>` +
      line +
      extraTop +
      macRest()
    );
  }
  const macRest = () =>
    `<h4 class="b-group">Apps</h4><ul class="d-apps" aria-label="Apps this Mac offers">${macApps()}</ul>` +
    botsLine(false) +
    told() +
    never(false) +
    facts([["Device name", MAC], ["Gateway", `${GATEWAY}, OpenClaw 2026.10.6`]]);

  // Screens ---------------------------------------------------------------------

  const hostDialog = () =>
    `<div class="s-host-scrim" data-host-scrim><div class="s-host" role="alertdialog" aria-modal="true" aria-labelledby="s-host-title" aria-describedby="s-host-detail" data-host-dialog="nodeOn">` +
    `<p class="s-host-caption">The app's own dialog, not part of the page (a stand-in for the native dialog)</p>` +
    `<div class="s-host-body"><img src="${logo}" alt="" width="40" height="40" /><div>` +
    `<h2 id="s-host-title" tabindex="-1">Let bots on ${GATEWAY} use this Mac?</h2><div id="s-host-detail" class="s-host-detail">` +
    `<p>Clawtrate connects to the gateway as a device bots can send requests to. It offers Location, Contacts, Calendar and Reminders, and asks you before each one is used.</p>` +
    `<p>The gateway's owner approves this device first.</p></div>` +
    `</div></div><div class="s-host-buttons"><a class="button" data-size="sm" href="${go("mac-off")}" data-host-cancel>Cancel</a>` +
    `<a class="button" data-variant="primary" data-size="sm" href="${via === "silent" ? go("mac-on", { said: "This Mac can be used by bots" }) : go("mac-waiting-device")}" data-host-confirm>Let bots use this Mac</a></div></div></div>`;

  const offPage = () =>
    `<div class="d-switch-row"><h4>Let bots use this Mac</h4>${sw(false, go("mac-confirm"), "Let bots use this Mac")}` +
    `<p>Bots that may use other devices could then ask this Mac for the apps you allow below. Each app asks you on this Mac first.</p></div>` +
    (params.get("stopped") === "kept"
      ? note("", "", "This Mac is no longer connected. Bots that ask it are told it isn't connected. The gateway keeps it as a device until its owner removes it.")
      : params.get("stopped") === "removed"
        ? note("", "", "This Mac is no longer connected, and the gateway no longer lists it as a device.")
        : params.get("cancelled")
          ? note("", "", "The request was cancelled. Nothing is offered to bots.")
          : "") +
    botsLine(false) +
    `<h4 class="b-group">Apps it would offer</h4><ul class="d-apps" aria-label="Apps this Mac would offer">${MAC_APPS.map((a) => appRow(a, { off: true })).join("")}</ul>` +
    never(false) +
    facts([["Device name", MAC], ["Gateway", `${GATEWAY}, OpenClaw 2026.10.6`]]);

  const turningOn = (stepsList, extra) =>
    `<div class="d-switch-row"><h4>Let bots use this Mac</h4>${sw(true, "", "Let bots use this Mac", true)}` +
    `<p>Turning on. The switch is on while the gateway answers.</p></div>` +
    steps(stepsList) +
    extra;

  const screenId = CT.params.get("screen") || "mac-off";

  const SCREENS = {
    "mac-off": () => settings({ title: "This Mac", body: offPage() }),

    "mac-confirm": () => settings({ title: "This Mac", body: offPage() }) + hostDialog(),

    "mac-waiting-device": () =>
      settings({
        title: "This Mac",
        body: turningOn(
          [
            ["Asking the gateway", "done"],
            ["Waiting for the gateway's owner to approve this Mac", "running"],
            ["Approving this Mac's commands", "waiting"],
            ["Reading back what the gateway accepted", "waiting"],
          ],
          (isAdmin
            ? `<p class="d-lead">You're connected with admin access, so you can approve this Mac yourself.</p>` +
              `<div class="d-actions">${link("Approve this Mac", go("mac-waiting-surface"), { variant: "primary" })}${link("Cancel request", go("mac-off", { cancelled: "1" }), { variant: "quiet" })}</div>`
            : `<p class="d-lead">Approving a device for bots needs admin access. On ${GATEWAY}, approve this request for the default profile:</p>` +
              command(`openclaw devices approve ${REQUEST}`, "Copy approve command") +
              `<p class="d-event">Checking again in 8 s.</p>` +
              `<div class="d-actions">${link("Check now", go("mac-waiting-device"))}${link("Cancel request", go("mac-off", { cancelled: "1" }), { variant: "quiet" })}</div>` +
              proto(link(`The owner approves on ${GATEWAY}`, go("mac-waiting-surface")))) +
            `<p class="d-event">This Mac's request to be used by bots is waiting. Ask for more access once it is answered: the gateway would combine the two.</p>`,
        ),
      }),

    "mac-waiting-surface": () =>
      settings({
        title: "This Mac",
        body: turningOn(
          [
            ["Asking the gateway", "done"],
            ["Waiting for the gateway's owner to approve this Mac", "done"],
            ["Approving this Mac's commands", "running", hasPairing ? "Clawtrate checked that the request lists only Location, Contacts, Calendar and Reminders." : ""],
            ["Reading back what the gateway accepted", "waiting"],
          ],
          hasPairing
            ? proto(link("The gateway accepts the approval", go("mac-on", { said: "This Mac can be used by bots" })))
            : accessBar("Approving this Mac's commands needs device access.", "device access", params.get("req") === "requested") +
              `<p class="d-lead">Or on ${GATEWAY}: <code>openclaw nodes approve ${SURFACE}</code></p>` +
              proto(link(`The owner approves on ${GATEWAY}`, go("mac-on", { said: "This Mac can be used by bots" }))),
        ),
      }),

    "mac-on": () => settings({ title: "This Mac", body: macOn() }),

    "mac-messages-confirm": () =>
      settings({ title: "This Mac", body: macOn() }) +
      dialog(
        `Let bots use ${chosenName} on this Mac?`,
        `<p>Otto can use other devices, so Otto could then use ${chosenName} on this Mac: whatever ${chosenName} can do with your account here, Otto could do. ${OWN[chosen][1]}</p>` +
          `<p>The gateway's allowlist is for every bot. A bot given the tool for other devices later could use ${chosenName} too. Clawtrate still asks you on this Mac before the first request.</p>`,
        link("Cancel", go("mac-on", { app: null }), { size: "md" }) + link(`Allow ${chosenName}`, go("mac-messages-steps"), { variant: "primary", size: "md" }),
      ),

    "mac-messages-steps": () => {
      const failed = params.get("fail") === "2";
      return settings({
        title: "This Mac",
        body:
          `<h4 class="b-group">Allowing ${chosenName}</h4>` +
          steps([
            [`Adding ${chosenName} to the gateway's allowlist`, "done", "Read back from the gateway's settings, 5:33 PM."],
            ["Asking the gateway to accept it", failed ? "failed" : "done"],
            ["Reading back", failed ? "waiting" : "running"],
          ]) +
          (failed
            ? note("danger", "The gateway didn't answer.", `${chosenName} is on the gateway's allowlist, but the gateway hasn't accepted it from this Mac yet.`) +
              `<div class="d-actions">${link("Try again", go("mac-messages-steps", { fail: null }), { variant: "primary" })}${link("Remove it from the allowlist", go("mac-on", { fail: null, said: "Removed from the gateway's allowlist" }), { variant: "quiet" })}</div>`
            : proto(link("The gateway reads back the command", go("mac-messages-on", { own: "offered", said: `${chosenName} allowed` })))),
      });
    },

    "mac-messages-needadmin": () =>
      settings({
        title: "This Mac",
        body: macOn({
          extraTop:
            note("", `${chosenName} needs the gateway's owner.`, "Adding it to the gateway's allowlist needs admin access.") +
            accessBar("Admin access needed.", "admin access", params.get("req") === "requested"),
        }),
      }),

    "mac-messages-on": () => settings({ title: "This Mac", body: macOn() }),

    "mac-messages-remove": () =>
      settings({ title: "This Mac", body: macOn() }) +
      dialog(
        `Remove ${chosenName} from the gateway's allowlist?`,
        `<p>Bots will no longer be able to ask any device for ${chosenName}. A request waiting for this Mac ends at once, and the bot is told the command is no longer allowed. What this Mac already did is not undone.</p>`,
        link("Cancel", go("mac-messages-on"), { size: "md" }) + link("Remove", go("mac-on", { own: null, app: null, said: "Removed from the gateway's allowlist" }), { variant: "primary", size: "md" }),
      ),

    "mac-stop": () =>
      settings({ title: "This Mac", body: macOn() }) +
      dialog(
        "Stop letting bots use this Mac?",
        `<p>Bots that ask this Mac will be told it isn't connected. The gateway keeps this Mac as a device until its owner removes it.</p>` +
          (isAdmin ? `<label class="d-check"><input type="checkbox" data-also-remove /> <span>Also remove it from the gateway</span></label>` : ""),
        link("Cancel", go("mac-on"), { size: "md" }) + link("Stop", go("mac-off", { stopped: "kept", said: "This Mac is no longer used by bots" }), { variant: "primary", size: "md", attrs: "data-stop" }),
      ),

    "mac-offline": () =>
      settings({
        title: "This Mac",
        body: macOn({
          state: `<p class="d-state">Not connected. Bots that ask this Mac are told it isn't connected.<small>Last seen 5:02 PM</small></p><div class="d-actions">${link("Connect again", go("mac-on"))}</div>`,
        }),
      }),

    "mac-removed": () =>
      settings({
        title: "This Mac",
        body:
          `<div class="d-switch-row"><h4>Let bots use this Mac</h4>${sw(false, go("mac-confirm"), "Let bots use this Mac")}<p>Turn it on again to ask anew.</p></div>` +
          `<p class="d-state" data-tone="danger">The gateway's owner removed this Mac as a device for bots. Turn it on again to ask anew.</p>` +
          never(false),
      }),

    "mac-request": () => {
      const allowed = params.get("ask") === "allowed";
      return (
        settings({
          title: "This Mac",
          body:
            `<div class="d-banner" role="status">${icon("warning")}<span>A request for Calendar on this Mac</span><span class="spacer"></span></div>` +
            `<h4 class="b-group">Requests for this device</h4>` +
            (allowed
              ? `<details class="card d-ask" data-state="allowed" open><summary><span class="tag" data-tone="accent">Allowed</span> A request for Calendar</summary><p>Allowed. This Mac sent the request its answer at 5:44 PM. Calendar is allowed for bots from now on.</p></details>`
              : askCard({
                  title: "A request wants Calendar on this Mac",
                  summary: "A request through the gateway asked to read your calendar's events. It didn't say which task it came from. Allowing lets any bot that can use this Mac read them from now on.",
                  foot: "The request waits until 5:44:30 PM. If you answer after that, Allow keeps Calendar allowed for next time.",
                  allowTo: go("mac-request", { ask: "allowed" }),
                  denyTo: go("mac-on", { said: "Calendar denied" }),
                  command: "calendar.events",
                  paramsText: '{"from":"2026-11-21","to":"2026-11-22"}',
                })) +
            macRest(),
        })
      );
    },

    machines: () => {
      const ipad = params.get("ipad");
      const dlg = params.get("dlg");
      const requests = isAdmin
        ? `<h4 class="b-group">Devices asking to be used by bots</h4>` +
          (ipad === "approved"
            ? `<p class="d-event">Kitchen iPad was approved as a device for bots (read back 5:22 PM).</p>`
            : ipad === "rejected"
              ? `<p class="d-event">Kitchen iPad's request was rejected (read back 5:22 PM).</p>`
              : `<div class="d-request" data-request="ipad"><h4>Kitchen iPad asks to be a device bots can use</h4><p>iPadOS, asked 5:20 PM</p>` +
                `<div class="d-actions">${link("Approve", go("machines", { dlg: "ipad" }), { variant: "primary" })}${link("Reject", go("machines", { ipad: "rejected", said: "Rejected" }), { variant: "quiet" })}</div></div>`) +
          `<div class="d-request" data-request="pc"><h4>Workshop PC asks to offer: Location, and more</h4><p><code>location.get</code>, <code>system.run</code>, <code>fs.listDir</code></p>` +
          `<p data-tone="warn">It also offers commands that run programs or read files on it: <code>system.run</code>, <code>fs.listDir</code>.</p>` +
          `<div class="d-actions">${link("Approve", go("machines", { dlg: "pc" }), { variant: "primary" })}${link("Reject", go("machines", { said: "Rejected" }), { variant: "quiet" })}</div></div>`
        : `<h4 class="b-group">Devices asking to be used by bots</h4>` + accessBar("Approving other devices for bots needs admin access.", "admin access", params.get("req") === "requested");
      const body =
        `<h4 class="b-group">Machines</h4>${facts([["The gateway's machine", "Connected"], ["media-box", "Connected"], [MAC, "Connected, a device for bots"]])}` +
        requests +
        `<h4 class="b-group">Paired devices</h4>${facts([["This device", MAC], ["iPhone", "Last seen 4:58 PM"]])}`;
      let over = "";
      if (dlg === "ipad")
        over = dialog(
          "Approve Kitchen iPad for bots?",
          `<p>Bots that can use other devices will be able to send it requests. What the device does with a request is up to the device.</p>`,
          link("Cancel", go("machines"), { size: "md" }) + link("Approve", go("machines", { ipad: "approved", said: "Approved" }), { variant: "primary", size: "md" }),
        );
      if (dlg === "pc")
        over = dialog(
          "Approve Workshop PC's commands?",
          `<p>Bots that can use other devices will be able to ask it for Location, and to run programs and read files on it: <code>system.run</code>, <code>fs.listDir</code>.</p>`,
          link("Cancel", go("machines"), { size: "md" }) + link("Approve", go("machines", { said: "Approved" }), { variant: "primary", size: "md" }),
        );
      return settings({ title: "Machines", body, current: "Machines" }) + over;
    },

    // The iPhone ------------------------------------------------------------------

    "phone-on": () =>
      settings({
        title: "This iPhone",
        phone: true,
        body:
          `<div class="d-switch-row"><h4>Let bots use this iPhone</h4>${sw(true, go("phone-on"), "Let bots use this iPhone")}<p>Bots that may use other devices can ask this iPhone for the apps you allow below, while Clawtrate is open.</p></div>` +
          `<p class="d-state" data-tone="ok">Connected while Clawtrate is open.<small>Approved Nov 19, 5:31 PM</small></p>` +
          `<h4 class="b-group">Apps</h4><ul class="d-apps" aria-label="Apps this iPhone offers">` +
          PHONE_APPS.map((app) => {
            const id = app[0];
            if (id === "calendar") return appRow(app, { phone: true, local: "allowed", gateway: "offered" });
            if (id === "contacts")
              return appRow(app, { phone: true, local: "settings", gateway: "offered", action: `<button type="button" class="button" data-size="sm" data-where="Opens Settings, Clawtrate. Nothing opens in the prototype.">Open Settings</button>` });
            if (id === "location") return appRow(app, { phone: true, local: "allow", gateway: "offered", action: link("Allow", go("phone-on", { said: "Location allowed" })) });
            if (id === "reminders") return appRow(app, { phone: true, local: "denied", gateway: "offered", action: `<span class="d-value">Denied</span>${link("Allow", go("phone-on", { said: "Reminders allowed" }))}` });
            return appRow(app, { phone: true, local: "allow", gateway: "notoffered", action: link("Allow…", go("phone-on", { said: "Needs the gateway's owner" })) });
          }).join("") +
          `</ul>` +
          botsLine(true) +
          told() +
          never(true),
      }),

    "phone-back": () =>
      chat({
        body:
          `<p class="d-event" role="status">While Clawtrate was in the background, Otto asked this iPhone for your location at 5:41 PM. Otto was told Clawtrate wasn't open.</p>` +
          `<p class="d-event">Requests made while this iPhone wasn't connected never reached it; the bot was told the device wasn't connected.</p>`,
      }),

    // The share sheet ------------------------------------------------------------

    share: () => shareSheet(),
    "share-to": () => shareSheet({ choosing: true }),
    "share-sent": () => other() + `<div class="d-share" role="dialog" aria-labelledby="d-share-title"><div class="d-share-head"><span></span><h2 id="d-share-title" tabindex="-1" data-d-title>Sent to ${BOTS[toBot()]}</h2><span></span></div><p class="d-lead">The gateway started the task. Open it in Clawtrate to follow it.</p></div>`,
    "share-cant": () =>
      other() +
      `<div class="d-share" role="dialog" aria-labelledby="d-share-title"><div class="d-share-head">${link("Cancel", go("share"), { variant: "quiet" })}<h2 id="d-share-title" tabindex="-1" data-d-title>Clawtrate</h2><span></span></div>` +
      note("warn", "Clawtrate can't reach the gateway from here.", "Nothing was sent.") +
      `<div class="d-actions">${link("Open in Clawtrate", go("share-draft"), { variant: "primary", size: "md" })}</div></div>`,
    "share-draft": () =>
      chat({
        bot: toBot(),
        title: "New task",
        body:
          `<p class="d-event">${params.get("from") === "siri" ? "From Send Message" : "Shared from another app"}. Nothing has been sent.</p>` +
          `<div class="d-composer" aria-label="Composer">` +
          (params.get("from") === "siri" ? "" : `<ul class="d-chips">${chips()}</ul>`) +
          `<textarea aria-label="Message ${BOTS[toBot()]}">${params.get("from") === "siri" ? "Remind me to water the plants tonight." : "For Saturday's route."}</textarea>` +
          `<div class="d-actions"><button type="button" class="button" data-variant="primary" data-size="sm">Send</button></div></div>`,
      }),

    // Siri and Shortcuts ---------------------------------------------------------

    "siri-list": () =>
      other() +
      sys(
        "Clawtrate",
        `<p>You have four bots: Juniper, Marlow, Otto and Pip.</p><ul><li>Juniper (your primary bot)</li><li>Marlow</li><li>Otto</li><li>Pip</li></ul>`,
      ),
    "siri-list-fail": () => other() + sys("Clawtrate", `<p>Clawtrate couldn't reach the gateway.</p>`),
    "siri-confirm": () =>
      other() +
      sys(
        "Send to Juniper?",
        `<blockquote>Remind me to water the plants tonight.</blockquote><p class="d-lead">Clawtrate always asks before it sends.</p>`,
        link("Cancel", go("siri-list"), { size: "md" }) +
          link("Send", params.get("link") === "down" ? go("siri-fail") : go("siri-sent", { said: "Sent to Juniper" }), { variant: "primary", size: "md", attrs: "data-siri-send" }),
      ),
    "siri-sent": () => other() + sys("Clawtrate", `<p>Sent to Juniper.</p>`),
    "siri-fail": () =>
      other() +
      sys(
        "Clawtrate",
        `<p>Clawtrate couldn't send this: it can't reach the gateway.</p>`,
        link("Open in Clawtrate", go("share-draft", { from: "siri" }), { variant: "primary", size: "md" }),
      ),
  };

  // The permission card ---------------------------------------------------------

  function askCard({ title, summary, foot, allowTo, denyTo, command: cmd, paramsText, allowLabel = "Allow", tag = "Needs permission" }) {
    return (
      `<section class="card d-ask" data-state="pending" role="region" aria-label="${esc(title)}. Needs permission.">` +
      `<header class="request-head"><h3 class="request-title">${title}</h3><span class="tag" data-tone="warn">${tag}</span></header>` +
      `<p>${summary}</p>` +
      `<details><summary>Show request</summary><dl><div><dt>Command</dt><dd>${cmd}</dd></div><div><dt>Parameters</dt><dd>${esc(paramsText)}</dd></div></dl></details>` +
      `<div class="d-actions">${link(allowLabel, allowTo, { variant: "primary", size: "md", attrs: "data-ask-allow" })}<span class="spacer"></span>${link("Don't allow", denyTo, { variant: "quiet", size: "md", attrs: "data-ask-deny" })}</div>` +
      (foot ? `<p class="d-ask-foot">${foot}</p>` : "") +
      `</section>`
    );
  }
  const resolvedCard = (tag, tone, words, extra = "") =>
    `<details class="card d-ask" data-state="resolved" open><summary><span class="tag"${tone ? ` data-tone="${tone}"` : ""}>${tag}</span> Otto wants your location</summary><p>${words}</p>${extra}</details>`;

  function chat({ bot = "otto", title = "Plan Saturday", body }) {
    return (
      `<div class="d-chat">` +
      `<header class="d-chat-head"><span class="avatar" data-bot="${bot}"></span><b>${BOTS[bot]}</b><span>${title}</span></header>` +
      `<div class="d-chat-body" data-d-chat>` +
      (bot === "otto" && title === "Plan Saturday"
        ? `<p class="d-msg-you">Where am I on Saturday morning? Check my location.</p><p class="d-msg-bot">I'll ask this iPhone for your location.</p>`
        : "") +
      body +
      `</div></div>`
    );
  }

  const LOCATION_PENDING = {
    title: "Otto wants your location on this iPhone",
    summary: "Otto asked, through the gateway, for this iPhone's current location. Allowing lets any bot that can use this iPhone get it from now on.",
    foot: "Otto's request waits until 5:44:30 PM. If you answer after that, Allow keeps Location allowed for next time.",
    command: "location.get",
    paramsText: '{"desiredAccuracy":"balanced"}',
  };

  Object.assign(SCREENS, {
    "card-pending": () =>
      chat({
        body:
          askCard({ ...LOCATION_PENDING, allowTo: go("card-sent", { said: "Location allowed" }), denyTo: go("card-dontallow") }) +
          proto(link("30 seconds pass", go("card-ended")), link("Allow after the gateway stopped waiting", go("card-ignored"))),
      }),
    "card-sent": () =>
      chat({
        body: resolvedCard("Allowed", "accent", "Allowed. This iPhone sent Otto's request its answer at 5:44 PM. Location is allowed for bots from now on."),
      }),
    "card-ignored": () =>
      chat({
        body: resolvedCard("Allowed", "accent", "Allowed. The request had ended when this iPhone answered, so nothing reached Otto. Location is allowed for next time."),
      }),
    "card-dontallow": () =>
      chat({
        body: resolvedCard(
          "Not allowed",
          "",
          params.get("late")
            ? "Not allowed. Otto's request had ended. Location stays Denied until you change it in This iPhone."
            : "Not allowed. Otto was told you chose Don't allow. Location stays Denied until you change it in This iPhone.",
        ),
      }),
    "card-ended": () =>
      chat({
        body:
          `<p class="d-msg-bot">This iPhone didn't answer in time, so I don't have your location.</p>` +
          askCard({
            ...LOCATION_PENDING,
            summary: "Otto's request ended at 5:44 PM and nothing was sent. You can still allow Location for next time.",
            foot: "This stays open until 5:49 PM, five minutes after the request.",
            allowLabel: "Allow for next time",
            allowTo: go("card-later", { said: "Location allowed for next time" }),
            denyTo: go("card-dontallow", { late: "1" }),
          }) +
          proto(link("Five minutes pass", go("card-timedout"))),
      }),
    "card-later": () =>
      chat({
        body: resolvedCard("Allowed for next time", "accent", "Allowed for next time. Otto's request ended at 5:44 PM and wasn't run. Otto will be answered the next time it asks."),
      }),
    "card-timedout": () =>
      chat({
        body: resolvedCard("Timed out", "", "Timed out. Nothing was sent, and Location is still not allowed. Change it in This iPhone.", `<div class="d-actions">${link("This iPhone", go("phone-on"))}</div>`),
      }),
    "card-settings": () =>
      chat({
        body:
          `<section class="card d-ask" data-state="pending" role="region" aria-label="Location is turned off for Clawtrate. Needs permission.">` +
          `<header class="request-head"><h3 class="request-title">Location is turned off for Clawtrate</h3><span class="tag" data-tone="warn">Turned off</span></header>` +
          `<p>Otto asked this iPhone for its location. Location is turned off for Clawtrate in Settings, so Clawtrate can't ask you here. Otto was told it is turned off.</p>` +
          `<div class="d-actions"><button type="button" class="button" data-variant="primary" data-size="md" data-where="Opens Settings, Clawtrate, Location. Nothing opens in the prototype.">Open Settings</button></div></section>`,
      }),
  });

  // The share sheet's pieces.
  function toBot() {
    const to = params.get("to");
    return BOTS[to] ? to : "juniper";
  }
  const chips = () =>
    `<li>${icon("link")}<span>https://trail-guide.example/saturday</span></li>` +
    `<li>${icon("image")}<span>trail-map.png</span><small>240 KB</small></li>`;
  const other = () =>
    `<div class="d-other" aria-hidden="true"><p class="d-other-caption">Another app on the iPhone (a stand-in)</p><div class="d-other-tile"></div><div class="d-other-tile"></div></div>`;
  function shareSheet({ choosing = false } = {}) {
    const bot = toBot();
    const down = params.get("link") === "down";
    const to = choosing
      ? `<fieldset class="b-choices" role="radiogroup" aria-label="Send to" style="border:0;margin:0;padding:0">` +
        Object.entries(BOTS)
          .map(
            ([id, name]) =>
              `<a class="d-to" role="radio" aria-checked="${id === bot}" href="${go("share", { to: id })}" data-to="${id}"><span class="avatar" data-bot="${id}"></span><span>${name}${id === "juniper" ? ' <span class="d-to-label">Your primary bot</span>' : ""}</span>${id === bot ? icon("check") : ""}</a>`,
          )
          .join("") +
        `</fieldset>`
      : `<a class="d-to" href="${go("share-to")}" data-to-row><span class="d-to-label">To:</span><span class="avatar" data-bot="${bot}"></span><span>${BOTS[bot]}</span>${icon("chevron")}</a>`;
    return (
      other() +
      `<div class="d-share" role="dialog" aria-labelledby="d-share-title">` +
      `<div class="d-share-head">${link("Cancel", go("share"), { variant: "quiet" })}<h2 id="d-share-title" tabindex="-1" data-d-title>Clawtrate</h2><span></span></div>` +
      to +
      `<ul class="d-chips" aria-label="What is shared">${chips()}</ul>` +
      `<textarea aria-label="Add a note" placeholder="Add a note">For Saturday's route.</textarea>` +
      `<p class="d-lead">Send starts a new task with ${BOTS[bot]}. Nothing is sent before.</p>` +
      `<div class="d-actions">${link("Send", down ? go("share-cant") : go("share-sent", { said: `Sent to ${BOTS[bot]}` }), { variant: "primary", size: "md", attrs: "data-share-send" })}</div>` +
      `</div>`
    );
  }
  function sys(title, body, actions = "") {
    return (
      `<div class="d-sys" role="dialog" aria-labelledby="d-sys-title"><p class="d-sys-caption">Siri or Shortcuts (a stand-in for the phone's own panel)</p>` +
      `<h2 id="d-sys-title" tabindex="-1" data-d-title>${title}</h2>${body}${actions ? `<div class="d-actions">${actions}</div>` : ""}</div>`
    );
  }

  // Mount -----------------------------------------------------------------------

  const root = document.getElementById("device-root");
  const id = SCREENS[screenId] ? screenId : "mac-off";
  root.dataset.screen = id;
  const phoneScreen = /^(phone-|card-|share|siri)/.test(id);
  if (phoneScreen && !params.get("width")) {
    CT.settings.width = "phone";
    document.documentElement.dataset.width = "phone";
    document.documentElement.dataset.input = "touch";
  }
  root.innerHTML = SCREENS[id]();
  CT.hydrate(root);

  const live = document.getElementById("device-live");
  if (params.get("said")) setTimeout(() => (live.textContent = params.get("said")), 50);

  // Focus: a dialog's title, else the screen's title.
  const focusTarget = root.querySelector("[data-host-scrim] h2, [data-d-dialog] h2") || root.querySelector("[data-d-title]");
  if (params.get("said") || root.querySelector("[data-host-scrim], [data-d-dialog]")) focusTarget?.focus();
  root.querySelectorAll("[data-host-scrim], [data-d-dialog]").forEach((over) => {
    for (const el of root.children) if (el !== over) el.inert = true;
  });

  // Switches go where they lead; a disabled one does nothing.
  root.addEventListener("click", async (event) => {
    const s = event.target.closest(".b-switch[data-go]");
    if (s) {
      location.href = s.dataset.go;
      return;
    }
    const where = event.target.closest("[data-where]");
    if (where) {
      live.textContent = where.dataset.where;
      return;
    }
    const copy = event.target.closest("[data-copy]");
    if (copy) {
      const status = copy.closest(".command")?.nextElementSibling;
      try {
        await navigator.clipboard.writeText(copy.dataset.copy);
        if (status) status.textContent = "Copied.";
      } catch {
        if (status) status.textContent = "Selected. Press ⌘C to copy.";
      }
    }
  });

  // "Also remove it from the gateway" changes where Stop leads.
  const also = root.querySelector("[data-also-remove]");
  if (also) {
    const stop = root.querySelector("[data-stop]");
    also.addEventListener("change", () => {
      stop.href = go("mac-off", { stopped: also.checked ? "removed" : "kept", said: "This Mac is no longer used by bots" });
    });
  }

  // Escape closes a dialog by its Cancel.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const cancel = root.querySelector("[data-host-cancel], [data-d-dialog] .d-actions a:first-child");
    if (cancel?.href) location.href = cancel.href;
  });

  // The prototype bar: every state, one choice away.
  document.addEventListener("DOMContentLoaded", () => {
    const extra = document.getElementById("proto-extra");
    if (!extra) return;
    extra.innerHTML =
      `<label class="proto-seg">State <select id="device-state" aria-label="Device state">` +
      Object.keys(SCREENS).map((key) => `<option value="${key}"${key === id ? " selected" : ""}>${key}</option>`).join("") +
      `</select></label>`;
    document.getElementById("device-state").addEventListener("change", (event) => (location.href = go(event.target.value)));
  });

  CT.deviceScreens = Object.keys(SCREENS);
})();
