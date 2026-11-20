// Behaviour for device.html: every screen of docs/design/device-node.md,
// chosen with ?screen=<id> (section 15 lists them). Nothing is contacted and
// nothing runs. Each action leads where the real one would, so every path can
// be walked to its outcome by clicking.
//
// The host's confirmation (.s-host), Siri's panel (.d-sys) and the sharing
// app behind the share sheet are stand-ins: the app shows a native dialog, and
// the phone draws its own panels. Events that come from outside the app (the
// gateway answering, a deadline passing, an acknowledgement going missing)
// are links in a dashed "Prototype" box, which is not product.
//
// Everything a gateway or a request supplies (device, task and bot names, a
// note, parameters) goes through esc() and is shown as text.

(function () {
  const CT = window.CT;
  const params = CT.params;
  const icon = (name) => CT.icon(name);
  const esc = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // What the operator connection holds: read, write (the interactive tier), or admin.
  const access = ["read", "write", "admin"].includes(params.get("access")) ? params.get("access") : "admin";
  const isAdmin = access === "admin";
  const screenId = params.get("screen") || "mac-off";
  const phoneScreen = /^(phone-|card-|share|siri)/.test(screenId) || params.get("dev") === "phone";
  // The owner's choice serves either device: dev=phone puts it on This iPhone.
  const P = phoneScreen;
  const WHAT = P ? "iPhone" : "Mac";
  const HOME = P ? "phone-on" : "mac-on";
  const TITLE = P ? "This iPhone" : "This Mac";

  // Kept from one state to the next; everything else is per state.
  const KEEP = ["theme", "width", "motion", "chrome", "access", "link", "app", "own", "local", "prior", "allowed", "off", "devname", "taskname", "to", "note", "task", "from", "dev", "msg"];
  const go = (to, extra = {}) => {
    const next = new URLSearchParams();
    for (const key of KEEP) if (params.get(key) !== null) next.set(key, params.get(key));
    next.set("screen", to);
    for (const [key, value] of Object.entries(extra)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    return `device.html?${next}`;
  };

  // Samples. Names may be replaced from the address (devname, taskname) to show they stay text.
  const MAC = params.get("devname") || "Studio Mac";
  const PHONE = params.get("devname") || "iPhone";
  const TASK = params.get("taskname") || "Plan Saturday";
  const GATEWAY = "devbox";
  const BOTS = { juniper: "Juniper", marlow: "Marlow", otto: "Otto", pip: "Pip" };
  const down = params.get("link") === "down";

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
  const svg = (name) => `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">${GLYPHS[name]}</svg>`;
  const glyph = (name) => `<span class="d-glyph">${svg(name)}</span>`;

  // The three marks of section 2.
  const markListed = (time = "5:31 PM") => `<span class="d-mark" data-mark="listed">${icon("eye")}Listed by the gateway, ${time}</span>`;
  const markRefuses = () => `<span class="d-mark" data-mark="gateway">${icon("approval")}The gateway refuses this</span>`;
  const markDevice = () => `<span class="d-mark" data-mark="device">${svg("device")}This device refuses this</span>`;

  // Pieces ----------------------------------------------------------------------

  const logo = "../../../packages/ui/src/assets/logo-mark.png";
  // Going somewhere is a link; doing something is a button.
  const link = (label, to, { variant, size = "sm", attrs = "" } = {}) =>
    `<a class="button"${variant ? ` data-variant="${variant}"` : ""} data-size="${size}" href="${to}"${attrs ? ` ${attrs}` : ""}>${label}</a>`;
  const act = (label, to, { variant, size = "sm", attrs = "" } = {}) =>
    `<button type="button" class="button"${variant ? ` data-variant="${variant}"` : ""} data-size="${size}" data-go="${to}"${attrs ? ` ${attrs}` : ""}>${label}</button>`;
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
  const sw = (on, to, label, disabled = false) =>
    `<button type="button" class="b-switch" role="switch" aria-checked="${on}" aria-label="${label}"${disabled ? ' aria-disabled="true"' : ` data-go="${to}"`}></button>`;
  const adminBar = (need, requested = params.get("req") === "requested") =>
    `<section class="access-bar" role="region" aria-label="Access" data-state="${requested ? "requested" : "none"}">` +
    (requested
      ? `<div class="access-row">${icon("clock")}<span class="shelf-text"><b>Waiting for the gateway's owner.</b> Approve this request on the gateway's machine:</span></div>` +
        `<div class="command-line"><code>openclaw devices approve 5d2e7f10</code></div>`
      : `<div class="access-row">${icon("eye")}<span class="shelf-text"><b>${need}</b></span>${act("Request admin access", go(screenId, { req: "requested" }), { variant: "primary", attrs: "data-request" })}</div>`) +
    `</section>`;

  // The Settings frame of bots.md §7. On the iPhone it is one pane, with Settings as Back.
  const NAV = ["Gateway", "Accounts", "Integrations", "Permissions", "Memory", "Usage", "Machines", "This Mac"];
  const settings = ({ title, body, current = "This Mac", phone = false }) => {
    if (phone)
      return (
        `<div class="b-settings" data-pane="one"><section class="b-section" aria-labelledby="d-title">` +
        `<header class="b-section-head"><span class="button" data-variant="quiet" data-size="sm">${icon("back")}Settings</span><h3 id="d-title" tabindex="-1" data-d-title>${title}</h3></header>` +
        `<div class="b-section-body">${body}</div></section></div>`
      );
    const nav =
      `<nav class="b-nav" aria-label="Settings"><div class="b-nav-head"><h2>Settings</h2></div>` +
      NAV.map((label) => `<span class="b-nav-item"${label === current ? ' aria-current="page"' : ""}>${label}${icon("chevron")}</span>`).join("") +
      `</nav>`;
    return (
      `<div class="b-settings" data-pane="section">${nav}<section class="b-section" aria-labelledby="d-title">` +
      `<header class="b-section-head"><h3 id="d-title" tabindex="-1" data-d-title>${title}</h3></header>` +
      `<div class="b-section-body">${body}</div></section></div>`
    );
  };
  const dialog = (title, body, actions) =>
    `<div class="d-scrim" data-d-dialog><div class="d-dialog" role="alertdialog" aria-modal="true" aria-labelledby="d-dialog-title">` +
    `<h2 id="d-dialog-title" tabindex="-1">${title}</h2>${body}<div class="d-actions">${actions}</div></div></div>`;

  // Apps ------------------------------------------------------------------------

  const MAC_APPS = [
    ["location", "Location", ["location.get"], "get this Mac's location"],
    ["contacts", "Contacts", ["contacts.search"], "search your contacts"],
    ["calendar", "Calendar", ["calendar.events"], "read your calendar's events"],
    ["reminders", "Reminders", ["reminders.list"], "read your reminders"],
    ["messages", "Messages", ["clawtrate.messages.read", "clawtrate.messages.send"], "read the messages of a conversation it names and send a text message as you"],
    ["mail", "Mail", ["clawtrate.mail.search", "clawtrate.mail.send"], "search your mail and read what it finds, and send a message as you"],
    ["notes", "Notes", ["clawtrate.notes.search", "clawtrate.notes.create"], "search your notes and read what it finds, and create a note"],
  ];
  const PHONE_APPS = [
    ["calendar", "Calendar", ["calendar.events"], "read your calendar's events"],
    ["contacts", "Contacts", ["contacts.search"], "search your contacts"],
    ["location", "Location", ["location.get"], "get your location"],
    ["reminders", "Reminders", ["reminders.list"], "read your reminders"],
    ["alarms", "Alarms", ["clawtrate.alarms.list", "clawtrate.alarms.set"], "list the alarms Clawtrate set, and set or remove one"],
    ["home", "Home", ["clawtrate.home.list", "clawtrate.home.control"], "list your home's accessories and turn them on or off or set their level"],
  ];
  const OWN_APPS = ["messages", "mail", "notes", "alarms", "home"];
  const appOf = (id) => [...MAC_APPS, ...PHONE_APPS].find((a) => a[0] === id);
  const chosen = OWN_APPS.includes(params.get("app")) ? params.get("app") : phoneScreen ? "alarms" : "messages";
  const chosenApp = appOf(chosen);
  const list = (key) => (params.get(key) || "").split(",").filter(Boolean);

  // This device's decision for an app: undecided, allowed, denied or settings.
  function localOf(id, phone) {
    if (list("off").includes(id)) return "denied";
    if (list("allowed").includes(id)) return "allowed";
    if (id === chosen && params.get("local")) return params.get("local") === "allowed" ? "allowed" : "denied";
    if (id === chosen && params.get("prior") === "denied") return "denied";
    const defaults = phone
      ? { calendar: "allowed", contacts: "settings", reminders: "denied" }
      : { location: "allowed", contacts: "settings", reminders: "denied" };
    return defaults[id] || "undecided";
  }
  // What the gateway listed for an app: listed or notlisted.
  const gatewayOf = (id) => (OWN_APPS.includes(id) ? (id === chosen && params.get("own") === "listed" ? "listed" : "notlisted") : "listed");

  const without = (key, id) => list(key).filter((x) => x !== id).join(",") || null;
  const withId = (key, id) => [...new Set([...list(key), id])].join(",");

  function appRow([id, name, , does], { phone = false, off = false } = {}) {
    const here = phone ? "On this iPhone" : "On this Mac";
    const page = phone ? "phone-on" : "mac-on";
    if (off)
      return (
        `<li><div class="d-app" role="group" aria-label="${name}" aria-disabled="true" data-app="${id}">${glyph(id)}` +
        `<div class="d-app-text"><span class="d-app-name">${name}</span><span class="d-fact">Offered once bots may use this ${phone ? "iPhone" : "Mac"}</span></div>` +
        `<div class="d-app-action"><span class="d-value">Off</span></div></div></li>`
      );
    const local = localOf(id, phone);
    const gateway = gatewayOf(id);
    const word = { undecided: "Not decided", allowed: "Allowed", denied: "Denied", settings: phone ? "Turned off in Settings" : "Turned off in System Settings" }[local];
    const allowTo = go(page, { allowed: withId("allowed", id), off: without("off", id), said: `${name} allowed`, ...(id === chosen ? { local: null, prior: null } : {}) });
    const offTo = go(page, { off: withId("off", id), allowed: without("allowed", id), said: `${name} turned off`, ...(id === chosen ? { local: null } : {}) });
    let action = "";
    if (local === "undecided" || local === "denied") action = act("Allow", allowTo, { attrs: `data-allow="${id}" aria-label="Allow ${name}"` });
    if (local === "allowed") action = act("Turn off", offTo, { attrs: `data-turnoff="${id}" aria-label="Turn off ${name}"` });
    if (local === "settings") action = `<button type="button" class="button" data-size="sm" aria-label="Open Settings for ${name}" data-where="Opens the system's privacy settings for Clawtrate. Nothing opens in the prototype.">Open Settings</button>`;
    if (gateway === "notlisted" && OWN_APPS.includes(id))
      action += act("Add…", isAdmin ? go("mac-messages-confirm", { app: id, own: null, dev: phone ? "phone" : null }) : go("mac-messages-needadmin", { app: id, own: null, dev: phone ? "phone" : null }), { attrs: `data-add="${id}" aria-label="Add ${name} to the gateway's allowlist"` });
    if (gateway === "listed" && OWN_APPS.includes(id) && isAdmin)
      action += act("Remove…", go("mac-messages-remove", { app: id, dev: phone ? "phone" : null }), { variant: "quiet", attrs: `data-remove="${id}" aria-label="Remove ${name} from the gateway's allowlist"` });
    const scope = local === "undecided" ? `<span class="d-fact" data-scope>Allow lets every request for ${name} that reaches this ${phone ? "iPhone" : "Mac"} ${does}, from now on, until you turn it off.</span>` : "";
    return (
      `<li><div class="d-app" role="group" aria-label="${name}" data-app="${id}" data-local="${local}" data-gateway="${gateway}">${glyph(id)}<div class="d-app-text"><span class="d-app-name">${name}</span>` +
      `<span class="d-fact"${local === "denied" || local === "settings" ? ' data-tone="warn"' : ""}>${here}: <b>${word}</b>${markDevice()}</span>` +
      `<span class="d-fact">Gateway: <b>${gateway === "listed" ? "Listed, 5:31 PM" : "Not listed"}</b>${gateway === "listed" ? markListed() : markRefuses()}</span>` +
      (gateway === "notlisted" && OWN_APPS.includes(id) ? `<span class="d-fact">The gateway's allowlist didn't include it when read at 5:31 PM.</span>` : "") +
      scope +
      `</div><div class="d-app-action">${action}</div></div></li>`
    );
  }

  const botsLine = () =>
    `<h4 class="b-group">Bots offered the tool in their latest listed tasks</h4>` +
    `<p class="d-lead" data-bots>Otto (listed Nov 19). Juniper and Marlow: not offered (listed Nov 18, Nov 19). Pip: no listing yet. ${markListed("Nov 19")}</p>` +
    `<p class="d-lead">A listing changes when a bot's setup changes or it runs again. It says what the listings showed, not what a bot can do next.</p>` +
    `<div class="d-actions">${link("Open a bot's permissions", "controls.html?bot=otto&panel=open&tab=settings&bview=rules")}</div>`;

  const never = (phone) =>
    `<p class="d-never"><b>What this ${phone ? "iPhone" : "Mac"} never offers.</b> Clawtrate never lets a bot run programs, read or list files, use a browser or record the screen on this ${phone ? "iPhone" : "Mac"}. Those commands exist on the gateway; this ${phone ? "iPhone" : "Mac"} doesn't offer them.</p>`;

  // Examples of what this device sends back, with its own name and an app of its own.
  const examples = (phone) => {
    const d = esc(phone ? PHONE : MAC);
    const app = phone ? "Location" : "Calendar";
    const rows = [
      ["NOT_ALLOWED_ON_DEVICE", `${app} is not allowed on ${d}.`],
      ["NO_ANSWER_ON_DEVICE", `No one answered on ${d} within five minutes. ${app} is not decided.`],
      ["TURNED_OFF_IN_SETTINGS", `${app} is turned off for Clawtrate in ${d}'s ${phone ? "Settings" : "System Settings"}.`],
      ["TURNED_OFF_ON_DEVICE", `${app} was turned off on ${d} before the request was run.`],
      ...(phone ? [["NOT_OPEN_ON_DEVICE", `Clawtrate isn't open on ${d}, so no one could be asked.`]] : []),
      ["NOT_SERVED", `${d} doesn't answer this request.`],
      ["UNAVAILABLE_ON_DEVICE", `${app} couldn't answer on ${d}.`],
    ];
    return (
      `<details class="d-told"><summary>Examples of what this device sends back</summary>` +
      `<p class="d-lead">Examples. Each request's record shows the code and sentence this device actually sent.</p>` +
      `<table><thead><tr><th>Code</th><th>Sentence</th></tr></thead><tbody>` +
      rows.map(([c, t]) => `<tr><td><code>${c}</code></td><td>${t}</td></tr>`).join("") +
      `</tbody></table></details>`
    );
  };

  // Requests to this device: one record per request received.
  const record = (r) =>
    `<li class="d-record" data-record="${r.id}"><p class="d-record-head"><b>${r.when}</b> · ${r.app} · <code>${r.command}</code></p>` +
    `<p>${r.named}</p><p data-did>${r.did}</p><p data-sent>${r.sent}</p><p data-ack>${r.ack}</p></li>`;
  const records = (phone, rows) =>
    `<h4 class="b-group">Requests to this device</h4><ul class="d-records" aria-label="Requests to this device">${rows.map(record).join("")}</ul>`;
  const named = (kind) =>
    kind === "listed"
      ? `The request names a task of Otto's, “${esc(TASK)}”. This ${phoneScreen ? "iPhone" : "Mac"} can't confirm who sent it.`
      : kind === "other"
        ? `The request names a task this ${phoneScreen ? "iPhone" : "Mac"} doesn't list (<code>agent:otto:dashboard:5b1e…</code>). This ${phoneScreen ? "iPhone" : "Mac"} can't confirm who sent it.`
        : `The request names no task. This ${phoneScreen ? "iPhone" : "Mac"} can't confirm who sent it.`;
  const MAC_RECORDS = [
    { id: "r1", when: "5:44 PM", app: "Location", command: "location.get", named: named("listed"), did: "Ran it.", sent: "Sent the result.", ack: "The gateway accepted it." },
    { id: "r2", when: "5:12 PM", app: "Reminders", command: "reminders.list", named: named("none"), did: "Didn't run it: Reminders is Denied on this Mac.", sent: "Sent <code>NOT_ALLOWED_ON_DEVICE</code>.", ack: "The gateway accepted it." },
    { id: "r3", when: "4:58 PM", app: "Calendar", command: "calendar.events", named: named("other"), did: "Timed out. Didn't run it.", sent: "Sent nothing.", ack: "—" },
  ];

  // The page once the node is on.
  function onPage({ phone = false, state, extraTop = "", recs } = {}) {
    const apps = phone ? PHONE_APPS : MAC_APPS;
    const what = phone ? "iPhone" : "Mac";
    const line =
      state ||
      (phone
        ? `<p class="d-state" data-tone="ok">Connected while Clawtrate is open.<small>The gateway last saw it at 5:31 PM (connect).</small></p>`
        : `<p class="d-state" data-tone="ok">Connected as a device for bots since 5:31 PM.</p>`);
    return (
      `<div class="d-switch-row"><h4>Let bots use this ${what}</h4>${sw(true, go(phone ? "phone-stop" : "mac-stop"), `Let bots use this ${what}`)}` +
      `<p>Bots, and other devices connected to the gateway with write access, can send this ${what} requests for the apps you allow below. Clawtrate asks you before an app's first use.</p></div>` +
      line +
      extraTop +
      `<h4 class="b-group">Apps</h4><ul class="d-apps" aria-label="Apps this ${what} offers">${apps.map((a) => appRow(a, { phone })).join("")}</ul>` +
      records(phone, recs || (phone ? PHONE_RECORDS() : MAC_RECORDS)) +
      botsLine() +
      examples(phone) +
      never(phone) +
      facts([["Device name", `${esc(phone ? PHONE : MAC)} (bots)`], ["Gateway", `${GATEWAY}, OpenClaw 2026.10.6`]])
    );
  }

  function offPage({ phone = false, after = "" } = {}) {
    const what = phone ? "iPhone" : "Mac";
    const apps = phone ? PHONE_APPS : MAC_APPS;
    return (
      `<div class="d-switch-row"><h4>Let bots use this ${what}</h4>${sw(false, go(phone ? "phone-confirm" : "mac-confirm"), `Let bots use this ${what}`, !isAdmin)}` +
      `<p>Bots, and other devices connected to the gateway with write access, could then send this ${what} requests for the apps you allow below. Clawtrate asks you before an app's first use.</p></div>` +
      (isAdmin ? "" : note("", "", `Letting bots use this ${what} needs admin access: only an admin connection can get this ${what}'s device sign-in.`) + adminBar("Admin access needed.")) +
      after +
      botsLine() +
      `<h4 class="b-group">Apps it would offer</h4><ul class="d-apps" aria-label="Apps this ${what} would offer">${apps.map((a) => appRow(a, { phone, off: true })).join("")}</ul>` +
      never(phone) +
      facts([["Device name", `${esc(phone ? PHONE : MAC)} (bots)`], ["Gateway", `${GATEWAY}, OpenClaw 2026.10.6`]])
    );
  }

  // Screens ---------------------------------------------------------------------

  const hostDialog = (phone) => {
    const what = phone ? "iPhone" : "Mac";
    const apps = phone ? "Calendar, Contacts, Location and Reminders (<code>calendar.events</code>, <code>contacts.search</code>, <code>location.get</code>, <code>reminders.list</code>)" : "Location, Contacts, Calendar and Reminders (<code>location.get</code>, <code>contacts.search</code>, <code>calendar.events</code>, <code>reminders.list</code>)";
    return (
      `<div class="s-host-scrim" data-host-scrim><div class="s-host" role="alertdialog" aria-modal="true" aria-labelledby="s-host-title" aria-describedby="s-host-detail" data-host-dialog="nodeOn">` +
      `<p class="s-host-caption">The app's own dialog, not part of the page (a stand-in for the native dialog)</p>` +
      `<div class="s-host-body"><img src="${logo}" alt="" width="40" height="40" /><div>` +
      `<h2 id="s-host-title" tabindex="-1">Let bots on ${GATEWAY} use this ${what}?</h2><div id="s-host-detail" class="s-host-detail">` +
      `<p>Clawtrate asks the gateway for a one-time sign-in for this ${what} as a device for bots, and uses it at once. Because you hold admin access, the gateway pairs it without asking anyone else.</p>` +
      `<p>It offers ${apps}. Clawtrate asks you before an app's first use; once you allow an app, later requests for it are answered without asking, until you turn it off.</p></div>` +
      `</div></div><div class="s-host-buttons"><a class="button" data-size="sm" href="${go(phone ? "phone-off" : "mac-off")}" data-host-cancel>Cancel</a>` +
      `<a class="button" data-variant="primary" data-size="sm" href="${go(phone ? "phone-steps" : "mac-steps")}" data-host-confirm>Let bots use this ${what}</a></div></div></div>`
    );
  };

  function stepsPage(phone) {
    const what = phone ? "iPhone" : "Mac";
    const fail = params.get("fail");
    const s1 = fail === "code" ? "failed" : "done";
    const s2 = fail === "code" ? "waiting" : fail === "pair" ? "failed" : "done";
    const s3 = fail === "code" || fail === "pair" ? "waiting" : fail === "extra" ? "failed" : "running";
    const after =
      fail === "code"
        ? note("danger", `The gateway didn't give this ${what} a device sign-in: it needs admin access.`, "The switch is off.")
        : fail === "pair"
          ? note("danger", `The gateway didn't pair this ${what} with the code.`, "Its reason: <code>PAIRING_REQUIRED (role-upgrade)</code>.") +
            `<div class="d-actions">${act("Try again", go(phone ? "phone-steps" : "mac-steps", { fail: null }), { variant: "primary", attrs: "data-retry" })}</div>`
          : fail === "extra"
            ? note("danger", `The gateway lists commands this ${what} doesn't offer. Clawtrate disconnected it.`, "Listed: <code>system.run</code>.")
            : proto(link("The read-back agrees", go(phone ? "phone-on" : "mac-on", { said: `This ${what} can be used by bots` })), link("The read-back lists an extra command", go(phone ? "phone-steps" : "mac-steps", { fail: "extra" })), link("The code doesn't pair it", go(phone ? "phone-steps" : "mac-steps", { fail: "pair" })));
    return (
      `<div class="d-switch-row"><h4>Let bots use this ${what}</h4>${sw(fail ? false : true, "", `Let bots use this ${what}`, true)}<p>Turning on. Each step is done only when the gateway's answer shows it.</p></div>` +
      steps([
        [`Getting this ${what}'s device sign-in`, s1, s1 === "done" ? "The gateway answered with a code for the node role only." : ""],
        ["Connecting as a device for bots", s2, s2 === "done" ? "Its hello says role node." : ""],
        ["Reading back what the gateway lists", s3, s3 === "running" ? "Waiting for paired, approved, connected, and commands this " + what + " declared." : ""],
      ]) +
      after
    );
  }

  const SCREENS = {
    "mac-off": () => settings({ title: "This Mac", body: offPage() }),
    "mac-confirm": () => settings({ title: "This Mac", body: offPage() }) + hostDialog(false),
    "mac-steps": () => settings({ title: "This Mac", body: stepsPage(false) }),
    "mac-on": () => settings({ title: "This Mac", body: onPage() }),

    "mac-messages-confirm": () =>
      settings({ title: TITLE, phone: P, body: onPage({ phone: P }) }) +
      dialog(
        `Let bots ask this ${WHAT} for ${chosenApp[1]}?`,
        `<p>Clawtrate adds ${chosenApp[2].map((c) => `<code>${c}</code>`).join(" and ")} to the gateway's allowlist. With them, a request that reaches this ${WHAT} can ${chosenApp[3]}.</p>` +
          `<p>The allowlist is for the whole gateway. Bots offered the tool in their latest listed tasks: <b>Otto</b> (listed Nov 19); Pip has no listing yet. A bot whose setup changes, a bot added later, and any device connected to the gateway with write access can send such requests too.</p>` +
          `<p>This doesn't allow ${chosenApp[1]} on this ${WHAT}. Clawtrate still asks you before its first use.</p>`,
        link("Cancel", go(HOME, { app: null }), { size: "md", attrs: "data-cancel" }) + act(`Add ${chosenApp[1]}`, go("mac-messages-steps"), { variant: "primary", size: "md", attrs: "data-confirm" }),
      ),

    "mac-messages-steps": () => {
      const fail = params.get("fail");
      const name = chosenApp[1];
      const s1 = fail === "1" || fail === "1quiet" ? "failed" : "done";
      const s2 = s1 === "failed" ? "waiting" : fail === "2" ? "failed" : "done";
      const s3 = s2 === "done" ? "running" : "waiting";
      const after =
        fail === "1"
          ? note("danger", "The gateway refused the change.", `Its allowlist, read again at 5:33 PM, doesn't include ${name}.`)
          : fail === "1quiet"
            ? note("danger", "Clawtrate couldn't confirm whether the gateway's settings changed.", "") + `<div class="d-actions">${act("Check again", go("mac-messages-steps", { fail: null }), { variant: "primary" })}</div>`
            : fail === "2"
              ? note("danger", `The gateway's settings list ${name}, but the gateway doesn't list it for this ${WHAT} yet.`, "") +
                `<div class="d-actions">${act("Try again", go("mac-messages-steps", { fail: null }), { variant: "primary" })}${act("Remove it from the allowlist", go(HOME, { fail: null, app: null, said: "Removed from the gateway's allowlist" }), { variant: "quiet" })}</div>`
              : proto(link(`The gateway lists the commands for this ${WHAT}`, go("mac-messages-on", { own: "listed", said: `${name} listed by the gateway` })));
      return settings({
        title: TITLE,
        phone: P,
        body:
          `<h4 class="b-group">Adding ${name}</h4>` +
          steps([
            [`Writing ${name} to the gateway's allowlist`, s1, s1 === "done" ? "The stored settings show both entries (read 5:33 PM)." : ""],
            [`Asking the gateway to list them for this ${WHAT}`, s2, s2 === "done" ? `Clawtrate compared the request with what this ${WHAT} declares, then approved it with admin.` : ""],
            ["Reading back", s3],
          ]) +
          after,
      });
    },

    "mac-messages-needadmin": () =>
      settings({
        title: TITLE,
        phone: P,
        body: onPage({ phone: P, extraTop: note("", `${chosenApp[1]} needs the gateway's owner.`, "Adding it to the gateway's allowlist needs admin access.") + adminBar("Admin access needed.") }),
      }),

    "mac-messages-on": () => settings({ title: TITLE, phone: P, body: onPage({ phone: P }) }),

    "mac-messages-remove": () =>
      settings({ title: TITLE, phone: P, body: onPage({ phone: P }) }) +
      dialog(
        `Remove ${chosenApp[1]} from the gateway's allowlist?`,
        `<p>Bots will no longer be able to ask any device for ${chosenApp[1]}. A request the gateway is waiting on ends, and the gateway refuses later ones. What this ${WHAT} already did is not undone. ${chosenApp[1]} on this ${WHAT} stays as it is.</p>`,
        link("Cancel", go("mac-messages-on"), { size: "md", attrs: "data-cancel" }) +
          act("Remove", go(HOME, { own: null, said: "Removed from the gateway's allowlist" }), { variant: "primary", size: "md", attrs: "data-confirm" }),
      ),

    "mac-stop": () => settings({ title: "This Mac", body: onPage() }) + stopDialog(false),
    "mac-stopped": () => settings({ title: "This Mac", body: offPage({ after: stoppedNote(false) }) }),

    "mac-offline": () =>
      settings({
        title: "This Mac",
        body: onPage({ state: `<p class="d-state">Not connected. Clawtrate is trying again.<small>The gateway last saw it at 5:02 PM (connect).</small></p>` }),
      }),
    "mac-refused": () =>
      settings({
        title: "This Mac",
        body: offPage({ after: `<p class="d-state" data-tone="danger">The gateway refused this Mac's device sign-in. Turn it on again to get a new one.</p>` }),
      }),
    "mac-unlisted": () =>
      settings({
        title: "This Mac",
        body: offPage({ after: `<p class="d-state" data-tone="danger">The gateway no longer lists this Mac as a device for bots.</p>` }),
      }),

    "mac-request": () => {
      const st = params.get("ask");
      return settings({
        title: "This Mac",
        body:
          `<div class="d-banner" role="status">${icon("warning")}<span>A request for Calendar on this Mac</span></div>` +
          (st === "allowed"
            ? resolvedCard({ tag: "Allowed", tone: "accent", line: "A request for Calendar", words: "Allowed. This Mac read your calendar's events and sent them at 5:44 PM; the gateway accepted the answer. Calendar is allowed from now on.", cmd: "calendar.events", p: '{"from":"2026-11-21","to":"2026-11-22"}', kind: "none" })
            : askCard({
                title: "Calendar requested on this Mac",
                kind: "none",
                scope: "Allow reads your calendar's events for this request, and lets every later request for Calendar that reaches this Mac read them, until you turn it off.",
                foot: "This request can be answered until 5:44:30 PM.",
                allowTo: go("mac-request", { ask: "allowed", said: "Calendar allowed" }),
                denyTo: go("mac-on", { off: withId("off", "calendar"), said: "Calendar denied" }),
                cmd: "calendar.events",
                p: '{"from":"2026-11-21","to":"2026-11-22"}',
              })) +
          onPage().replace(/^[\s\S]*?(?=<h4 class="b-group">Apps<\/h4>)/, ""),
      });
    },

    machines: () => {
      const ipad = params.get("ipad");
      const pc = params.get("pc");
      const dlg = params.get("dlg");
      const readfail = params.get("readfail") === "1";
      const after = (text) => (readfail ? `<p class="d-event" data-after>Couldn't read the gateway.</p>` : `<p class="d-event" data-after>${text}</p>`);
      const ipadBlock =
        ipad === "approved"
          ? after("Kitchen iPad is paired as a device for bots (read 5:22 PM).")
          : ipad === "rejected"
            ? after("The gateway reported the request rejected.")
            : ipad === "gone"
              ? after("The request is no longer pending.")
              : `<div class="d-request" data-request="ipad"><h4>Kitchen iPad asks to be a device bots can use</h4><p>iPadOS, asked 5:20 PM</p>` +
                `<div class="d-actions">${act("Approve", go("machines", { dlg: "ipad" }), { variant: "primary", attrs: 'aria-label="Approve Kitchen iPad"' })}${act("Reject", go("machines", { ipad: "rejected" }), { variant: "quiet", attrs: 'aria-label="Reject Kitchen iPad"' })}</div>` +
                proto(link("The request disappears with no event", go("machines", { ipad: "gone" }))) +
                `</div>`;
      const pcBlock =
        pc === "approved"
          ? after("The gateway lists these commands for Workshop PC (read 5:22 PM): <code>location.get</code>, <code>system.run</code>, <code>fs.listDir</code>.")
          : `<div class="d-request" data-request="pc"><h4>Workshop PC asks to offer: Location, and more</h4><p><code>location.get</code>, <code>system.run</code>, <code>fs.listDir</code></p>` +
            `<p data-tone="warn">It also offers commands that run programs or read files on it: <code>system.run</code>, <code>fs.listDir</code>.</p>` +
            `<div class="d-actions">${act("Approve", go("machines", { dlg: "pc" }), { variant: "primary", attrs: 'aria-label="Approve Workshop PC\'s commands"' })}${act("Reject", go("machines", { pc: "rejected" }), { variant: "quiet", attrs: 'aria-label="Reject Workshop PC\'s commands"' })}</div></div>`;
      const requests = isAdmin
        ? `<h4 class="b-group">Devices asking to be used by bots</h4>${ipadBlock}${pc === "rejected" ? after("The gateway reported the request rejected.") : pcBlock}`
        : `<h4 class="b-group">Devices asking to be used by bots</h4>${note("", "", "Approving other devices for bots needs admin access.")}${adminBar("Admin access needed.")}`;
      const body =
        `<h4 class="b-group">Machines</h4>${facts([["The gateway's machine", "Connected"], ["media-box", "Connected"]])}` +
        requests +
        `<h4 class="b-group">Paired devices</h4>${facts([["This device", esc(MAC)], [`${esc(MAC)} (bots)`, "A device for bots, connected"], ["iPhone", "Last seen 4:58 PM"]])}`;
      let over = "";
      if (dlg === "ipad")
        over = dialog(
          "Approve Kitchen iPad as a device for bots?",
          `<p>Its commands are a separate request, approved separately. What a device does with a request is up to the device.</p>`,
          link("Cancel", go("machines", { dlg: null }), { size: "md", attrs: "data-cancel" }) + act("Approve", go("machines", { dlg: null, ipad: "approved" }), { variant: "primary", size: "md", attrs: "data-confirm" }),
        );
      if (dlg === "pc")
        over = dialog(
          "Approve Workshop PC's commands?",
          `<p>Requests that reach it could ask it for Location, and run programs and read files on it: <code>system.run</code>, <code>fs.listDir</code>.</p>`,
          link("Cancel", go("machines", { dlg: null }), { size: "md", attrs: "data-cancel" }) + act("Approve", go("machines", { dlg: null, pc: "approved" }), { variant: "primary", size: "md", attrs: "data-confirm" }),
        );
      return settings({ title: "Machines", body, current: "Machines" }) + over;
    },

    // The iPhone ------------------------------------------------------------------

    "phone-off": () => settings({ title: "This iPhone", phone: true, body: offPage({ phone: true }) }),
    "phone-confirm": () => settings({ title: "This iPhone", phone: true, body: offPage({ phone: true }) }) + hostDialog(true),
    "phone-steps": () => settings({ title: "This iPhone", phone: true, body: stepsPage(true) }),
    "phone-on": () => settings({ title: "This iPhone", phone: true, body: onPage({ phone: true }) }),
    "phone-stop": () => settings({ title: "This iPhone", phone: true, body: onPage({ phone: true }) }) + stopDialog(true),
    "phone-stopped": () => settings({ title: "This iPhone", phone: true, body: offPage({ phone: true, after: stoppedNote(true) }) }),
    "phone-back": () =>
      settings({
        title: "This iPhone",
        phone: true,
        body:
          records(true, [
            { id: "b1", when: "5:41 PM", app: "Location", command: "location.get", named: named("listed"), did: "Didn't run it: Clawtrate wasn't open.", sent: "Sent <code>NOT_OPEN_ON_DEVICE</code>.", ack: "The gateway accepted it." },
            { id: "b2", when: "5:39 PM", app: "Calendar", command: "calendar.events", named: named("none"), did: "Ran it, before Clawtrate left the foreground.", sent: "Sent the result.", ack: "Clawtrate couldn't confirm the gateway received it." },
          ]) +
          `<p class="d-event">Requests made while this iPhone wasn't connected never reached it.</p>` +
          `<p class="d-state" data-tone="ok">Connected while Clawtrate is open.<small>The gateway last saw it at 5:02 PM (connect).</small></p>`,
      }),
  };

  function stopDialog(phone) {
    const what = phone ? "iPhone" : "Mac";
    return dialog(
      `Stop letting bots use this ${what}?`,
      `<p>This ${what} stops answering at once, here, whether or not the gateway can be reached. An operation already started can't always be undone: a message already sent stays sent.</p>` +
        `<p>The gateway keeps this ${what} as a device, and its allowlist as it is, until an admin changes them.</p>` +
        (isAdmin ? `<label class="d-check"><input type="checkbox" data-also-remove /> <span>Also remove it from the gateway</span></label>` : ""),
      link("Cancel", go(phone ? "phone-on" : "mac-on"), { size: "md", attrs: "data-cancel" }) + act("Stop", go(phone ? "phone-stopped" : "mac-stopped", { said: "Stopped on this " + what }), { variant: "primary", size: "md", attrs: "data-stop" }),
    );
  }

  function stoppedNote(phone) {
    const what = phone ? "iPhone" : "Mac";
    const removed = params.get("removed");
    const status = down
      ? "Gateway status couldn't be checked."
      : removed === "1"
        ? "Removed from the gateway (read 5:40 PM)."
        : removed === "fail"
          ? `Couldn't remove it from the gateway: <code>node pairing removal denied</code>. It's stopped on this ${what}.`
          : `The gateway lists this ${what} as a device, not connected (read 5:40 PM).`;
    const allowlist = !down && params.get("own") === "listed" ? `<p>The gateway's allowlist still lists ${chosenApp[2].map((c) => `<code>${c}</code>`).join(", ")} (read 5:40 PM).</p>` : "";
    return `<div class="b-note" role="status" data-stopped>${icon("clock")}<div><p><b>Stopped on this ${what}.</b> ${status}</p>${allowlist}<p>The apps' decisions on this ${what} stay as they were.</p></div></div>`;
  }

  // The permission card ---------------------------------------------------------

  const raw = (cmd, p, kind) =>
    `<details class="d-raw"><summary>Raw</summary><pre><code>${esc(
      JSON.stringify(
        { id: "c41d…", nodeId: "6ad2…", command: cmd, paramsJSON: p, timeoutMs: 30000, ...(kind === "none" ? {} : { sessionKey: kind === "other" ? "agent:otto:dashboard:5b1e…" : "agent:otto:dashboard:9c2e…" }) },
        null,
        1,
      ),
    )}</code></pre></details>`;

  function askCard({ title, kind, scope, foot, allowTo, denyTo, cmd, p, id = "ask" }) {
    return (
      `<section class="card d-ask" data-state="pending" data-card="${id}" role="region" aria-label="${esc(title)}. Needs permission.">` +
      `<header class="request-head"><h3 class="request-title">${title}</h3><span class="tag" data-tone="warn">Needs permission</span></header>` +
      `<p data-named>${named(kind)}</p>` +
      `<p data-scope>${scope}</p>` +
      `<details><summary>Show request</summary><dl><div><dt>Command</dt><dd>${cmd}</dd></div><div><dt>Parameters</dt><dd>${esc(p)}</dd></div></dl>${raw(cmd, p, kind)}</details>` +
      `<div class="d-actions">${act("Allow", allowTo, { variant: "primary", size: "md", attrs: `data-ask-allow aria-label="Allow, for ${esc(title)}"` })}<span class="spacer"></span>${act("Don't allow", denyTo, { variant: "quiet", size: "md", attrs: `data-ask-deny aria-label="Don't allow, for ${esc(title)}"` })}</div>` +
      (foot ? `<p class="d-ask-foot">${foot}</p>` : "") +
      `</section>`
    );
  }
  const resolvedCard = ({ tag, tone, line, words, extra = "", cmd = "location.get", p = '{"desiredAccuracy":"balanced"}', kind = taskKind() }) =>
    `<details class="card d-ask" data-state="resolved" data-tag="${tag}"><summary><span class="tag"${tone ? ` data-tone="${tone}"` : ""}>${tag}</span> ${line}</summary>` +
    `<p data-words>${words}</p><p data-named>${named(kind)}</p>` +
    `<dl><div><dt>Command</dt><dd>${cmd}</dd></div><div><dt>Parameters</dt><dd>${esc(p)}</dd></div></dl>${raw(cmd, p, kind)}</details>${extra}`;

  const taskKind = () => (["other", "none"].includes(params.get("task")) ? params.get("task") : "listed");

  // Where a card goes: in the task it named, when this iPhone lists it; otherwise on This iPhone.
  function cardPlace(body) {
    if (taskKind() === "listed")
      return (
        `<div class="d-chat">` +
        `<header class="d-chat-head"><span class="avatar" data-bot="otto"></span><b>Otto</b><span>${esc(TASK)}</span></header>` +
        `<div class="d-chat-body" data-d-chat><p class="d-msg-you">Where am I on Saturday morning? Check my location.</p><p class="d-msg-bot">I'll ask this iPhone for its location.</p>${body}</div></div>`
      );
    return settings({ title: "This iPhone", phone: true, body: `<h4 class="b-group">Requests to this device</h4>${body}` });
  }

  const LOC = {
    title: "Location requested on this iPhone",
    scope: "Allow gets your location for this request, and lets every later request for Location that reaches this iPhone get it, until you turn it off.",
    foot: "This request can be answered until 5:44:30 PM.",
    cmd: "location.get",
    p: '{"desiredAccuracy":"balanced"}',
  };
  const later = `<div class="d-actions">${link("Location in This iPhone", go("phone-on", { task: null, from: "timedout" }), { attrs: "data-to-row" })}</div>`;

  const PHONE_RECORDS = () => {
    const from = params.get("from");
    return [
      ...(from === "timedout"
        ? [{ id: "t1", when: "5:44 PM", app: "Location", command: "location.get", named: named("listed"), did: "Timed out. Didn't run it.", sent: "Sent nothing.", ack: "—" }]
        : []),
      { id: "p1", when: "5:20 PM", app: "Calendar", command: "calendar.events", named: named("listed"), did: "Ran it.", sent: "Sent the result.", ack: "The gateway accepted it." },
      { id: "p2", when: "5:02 PM", app: "Reminders", command: "reminders.list", named: named("none"), did: "Didn't run it: Reminders is Denied on this iPhone.", sent: "Sent <code>NOT_ALLOWED_ON_DEVICE</code>.", ack: "The gateway ignored it: it was no longer waiting." },
    ];
  };

  Object.assign(SCREENS, {
    "card-pending": () => {
      const second = params.get("second") === "1";
      const first = askCard({ ...LOC, kind: taskKind(), allowTo: go("card-sent", { said: "Location allowed", ...(second ? { second: "1" } : {}) }), denyTo: go("card-dontallow") });
      const other = second
        ? askCard({ ...LOC, id: "ask2", title: "Location requested on this iPhone again", foot: "This request can be answered until 5:45:10 PM.", p: '{"desiredAccuracy":"precise"}', kind: taskKind(), allowTo: go("card-sent", { second: "1", which: "2" }), denyTo: go("card-dontallow", { second: "1", which: "2" }) })
        : "";
      return cardPlace(
        first +
          other +
          proto(
            link("The deadline passes", go("card-timedout")),
            link("Allow, then the gateway ignores the answer", go("card-ignored")),
            link("Allow, and no acknowledgement", go("card-unconfirmed")),
            link("Turn off Location on this iPhone", go("card-turnedoff")),
            link("Don't allow, and the gateway ignores it", go("card-dontallow", { ack: "ignored" })),
          ),
      );
    },
    "card-sent": () => {
      const second = params.get("second") === "1";
      const resolved = resolvedCard({ tag: "Allowed", tone: "accent", line: "Location requested", words: "Allowed. This iPhone got your location and sent it at 5:44 PM; the gateway accepted the answer. Location is allowed from now on." });
      // Answering one card answers only its request; the other keeps its own card.
      const stillWaiting = second
        ? askCard({ ...LOC, id: "ask2", title: "Location requested on this iPhone again", foot: "This request can be answered until 5:45:10 PM.", p: '{"desiredAccuracy":"precise"}', kind: taskKind(), allowTo: go("card-sent", { second: null }), denyTo: go("card-dontallow", { second: null }) })
        : "";
      return cardPlace(resolved + stillWaiting);
    },
    "card-ignored": () =>
      cardPlace(resolvedCard({ tag: "Allowed", tone: "accent", line: "Location requested", words: "Allowed. This iPhone got your location and sent it at 5:44 PM, but the gateway ignored the answer: it was no longer waiting for this request. Location is allowed from now on." })),
    "card-unconfirmed": () =>
      cardPlace(resolvedCard({ tag: "Allowed", tone: "accent", line: "Location requested", words: "Allowed. This iPhone got your location and sent it at 5:44 PM. Clawtrate couldn't confirm the gateway received it. Location is allowed from now on." })),
    "card-dontallow": () =>
      cardPlace(
        resolvedCard({
          tag: "Not allowed",
          line: "Location requested",
          words:
            params.get("ack") === "ignored"
              ? "Not allowed. This iPhone didn't run the request. The gateway ignored the refusal: it was no longer waiting. Location stays Denied until you change it."
              : "Not allowed. This iPhone didn't run the request and sent the refusal <code>NOT_ALLOWED_ON_DEVICE</code>; the gateway accepted it. Location stays Denied until you change it.",
        }),
      ),
    "card-turnedoff": () =>
      cardPlace(
        resolvedCard({
          tag: "Turned off",
          line: "Location requested",
          words: "Location was turned off on this iPhone while the request waited. This iPhone didn't run it and sent the refusal <code>TURNED_OFF_ON_DEVICE</code>; the gateway accepted it.",
        }),
      ),
    "card-timedout": () =>
      cardPlace(resolvedCard({ tag: "Timed out", line: "Location requested", words: "Timed out at 5:44 PM. This iPhone didn't run the request, and Location is still not decided.", extra: later })),
    "card-settings": () =>
      cardPlace(
        `<section class="card d-ask" data-state="pending" role="region" aria-label="Location is turned off for Clawtrate. Needs permission.">` +
          `<header class="request-head"><h3 class="request-title">Location is turned off for Clawtrate</h3><span class="tag" data-tone="warn">Turned off</span></header>` +
          `<p>Location is turned off for Clawtrate in Settings. This iPhone didn't run the request.</p><p data-named>${named(taskKind())}</p>` +
          `<div class="d-actions"><button type="button" class="button" data-variant="primary" data-size="md" data-where="Opens Settings, Clawtrate, Location. Nothing opens in the prototype.">Open Settings</button></div></section>`,
      ),
  });

  // The share sheet -------------------------------------------------------------

  const toBot = () => (BOTS[params.get("to")] ? params.get("to") : "juniper");
  const noteText = () => (params.get("note") !== null ? params.get("note") : "For Saturday's route.");
  const chips = () =>
    `<li>${icon("link")}<span>https://trail-guide.example/saturday</span></li>` +
    `<li>${icon("image")}<span>trail-map.png</span><small>240 KB</small></li>`;
  const other = () =>
    `<div class="d-other" aria-hidden="true"><p class="d-other-caption">Another app on the iPhone (a stand-in)</p><div class="d-other-tile"></div><div class="d-other-tile"></div></div>`;
  const sheet = (inner, title = "Clawtrate") =>
    `<div class="d-share" role="dialog" aria-modal="true" aria-labelledby="d-share-title" data-d-modal>` +
    `<div class="d-share-head">${link("Cancel", go("share-closed"), { variant: "quiet", attrs: "data-cancel" })}<h2 id="d-share-title" tabindex="-1" data-d-title>${title}</h2><span></span></div>${inner}</div>`;

  function shareSheet() {
    const bot = toBot();
    const sendTo = down ? go("share-cant") : params.get("lost") === "1" ? go("share-unsure") : go("share-sent", { said: `Sent to ${BOTS[bot]}` });
    return (
      other() +
      sheet(
        `<a class="d-to" href="${go("share-to")}" data-to-row data-keep-note><span class="d-to-label">To:</span><span class="avatar" data-bot="${bot}"></span><span>${BOTS[bot]}</span>${icon("chevron")}</a>` +
          `<ul class="d-chips" aria-label="What is shared">${chips()}</ul>` +
          `<textarea aria-label="Add a note" placeholder="Add a note" data-note>${esc(noteText())}</textarea>` +
          `<p class="d-lead">Send starts a new task with ${BOTS[bot]}. Nothing is sent before.</p>` +
          `<div class="d-actions">${act("Send", sendTo, { variant: "primary", size: "md", attrs: "data-share-send data-keep-note" })}</div>` +
          proto(link("The reply will be lost", go("share", { lost: "1" }), { attrs: "data-keep-note" })),
      )
    );
  }

  Object.assign(SCREENS, {
    share: () => shareSheet(),
    "share-to": () => {
      const bot = toBot();
      return (
        other() +
        sheet(
          `<div role="radiogroup" aria-label="Send to" class="d-radios" data-radios>` +
            Object.entries(BOTS)
              .map(
                ([id, name]) =>
                  `<button type="button" class="d-to" role="radio" aria-checked="${id === bot}" tabindex="${id === bot ? 0 : -1}" data-to="${id}"><span class="avatar" data-bot="${id}"></span><span>${name}${id === "juniper" ? ' <span class="d-to-label">The primary bot</span>' : ""}</span></button>`,
              )
              .join("") +
            `</div>` +
            `<div class="d-actions">${act("Done", go("share"), { variant: "primary", size: "md", attrs: "data-to-done" })}</div>`,
          "Send to",
        )
      );
    },
    "share-sent": () => other() + sheet(`<p class="d-lead">The gateway made the task.</p>`, `Sent to ${BOTS[toBot()]}`),
    "share-cant": () =>
      other() +
      sheet(
        note("warn", "Clawtrate couldn't reach the gateway before sending.", "Nothing was sent.") +
          `<div class="d-actions">${link("Open in Clawtrate", go("share-draft"), { variant: "primary", size: "md", attrs: "data-open-draft" })}</div>`,
      ),
    "share-unsure": () => {
      const late = params.get("late") === "1";
      return (
        other() +
        sheet(
          (late
            ? note("warn", "Clawtrate still couldn't confirm it.", `Look in ${BOTS[toBot()]}'s tasks before sending again.`) + `<div class="d-actions">${link(`Open ${BOTS[toBot()]}`, "app.html", { variant: "primary", size: "md" })}</div>`
            : note("warn", "Clawtrate couldn't confirm whether the gateway received this.", "Check again sends the same request; the gateway makes no second task.") +
              `<div class="d-actions">${act("Check again", go("share-sent", { lost: null, said: `Sent to ${BOTS[toBot()]}` }), { variant: "primary", size: "md", attrs: "data-check-again" })}</div>` +
              proto(link("Four minutes pass", go("share-unsure", { late: "1" })))),
        )
      );
    },
    "share-draft": () => {
      const fromSiri = params.get("from") === "siri";
      const nobot = params.get("nobot") === "1";
      const bot = toBot();
      return (
        `<div class="d-chat">` +
        `<header class="d-chat-head">${nobot ? "" : `<span class="avatar" data-bot="${bot}"></span><b>${BOTS[bot]}</b>`}<span>New task</span></header>` +
        `<div class="d-chat-body" data-d-chat>` +
        `<p class="d-event">${fromSiri ? "From Send Message" : "Shared from another app"}. Nothing has been sent.</p>` +
        (nobot ? note("", "This draft has no bot yet.", "Choose one before sending.") : "") +
        `<div class="d-composer" aria-label="Composer">` +
        (fromSiri ? "" : `<ul class="d-chips">${chips()}</ul>`) +
        `<textarea aria-label="Message" data-draft>${esc(fromSiri ? params.get("msg") || "Remind me to water the plants tonight." : noteText())}</textarea>` +
        `<div class="d-actions"><button type="button" class="button" data-variant="primary" data-size="sm"${nobot ? " disabled" : ""}>Send</button></div></div></div></div>`
      );
    },
    "share-closed": () => other() + `<p class="d-proto" data-closed><span>Prototype:</span>The sheet closed and sent nothing.</p>`,
  });

  // Siri and Shortcuts ----------------------------------------------------------

  const sys = (title, body, actions = "", after = "") =>
    `<div class="d-sys" role="dialog" aria-modal="true" aria-labelledby="d-sys-title" data-d-modal><p class="d-sys-caption">Siri or Shortcuts (a stand-in for the phone's own panel)</p>` +
    `<h2 id="d-sys-title" tabindex="-1" data-d-title>${title}</h2>${body}${actions ? `<div class="d-actions">${actions}</div>` : ""}${after}</div>`;
  const msg = () => params.get("msg") || "Remind me to water the plants tonight.";

  Object.assign(SCREENS, {
    "siri-locked": () => other() + sys("Clawtrate", `<p>Unlock your iPhone to use Clawtrate.</p>`, "", proto(link("Unlocked", go("siri-confirm")))),
    "siri-list": () => other() + sys("Clawtrate", `<p>You have four bots: Juniper, Marlow, Otto and Pip.</p><ul><li>Juniper (the primary bot)</li><li>Marlow</li><li>Otto</li><li>Pip</li></ul>`),
    "siri-list-fail": () => other() + sys("Clawtrate", `<p>Clawtrate couldn't reach the gateway.</p>`),
    "siri-confirm": () =>
      other() +
      sys(
        `Send to ${BOTS[toBot()]}?`,
        `<blockquote data-exact>${esc(msg())}</blockquote>`,
        act("Cancel", go("siri-cancelled"), { size: "md", attrs: "data-cancel" }) + act("Open in Clawtrate to send it", go("share-draft", { from: "siri" }), { variant: "primary", size: "md", attrs: "data-siri-handoff" }),
        proto(link("Once the confirmation is proven on a device: Send", down ? go("siri-fail") : go("siri-sent", { said: `Sent to ${BOTS[toBot()]}` }), { attrs: "data-siri-send" })),
      ),
    "siri-handoff": () => SCREENS["share-draft"](),
    "siri-sent": () => other() + sys("Clawtrate", `<p>Sent to ${BOTS[toBot()]}.</p>`),
    "siri-fail": () =>
      other() + sys("Clawtrate", `<p>Clawtrate couldn't send this: it couldn't reach the gateway.</p>`, link("Open in Clawtrate", go("share-draft", { from: "siri" }), { variant: "primary", size: "md" })),
    "siri-cancelled": () => other() + sys("Clawtrate", `<p>Nothing was sent.</p>`),
  });

  // Mount -----------------------------------------------------------------------

  const root = document.getElementById("device-root");
  const id = SCREENS[screenId] ? screenId : "mac-off";
  root.dataset.screen = id;
  if (phoneScreen && !params.get("width")) {
    CT.settings.width = "phone";
    document.documentElement.dataset.width = "phone";
    document.documentElement.dataset.input = "touch";
  }
  root.innerHTML = SCREENS[id]();
  CT.hydrate(root);

  const live = document.getElementById("device-live");
  if (params.get("said")) setTimeout(() => (live.textContent = params.get("said")), 50);

  // A modal (dialog, host dialog, share sheet, system panel): focus its title, make the rest inert, keep Tab inside.
  const modal = root.querySelector("[data-host-scrim], [data-d-dialog], [data-d-modal]");
  if (modal) {
    for (const el of root.children) if (el !== modal && !el.contains(modal)) el.inert = true;
    modal.querySelector("h2")?.focus();
    modal.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const items = [...modal.querySelectorAll("a[href], button:not([disabled]), textarea, input, [tabindex='0']")].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement) || document.activeElement.tagName === "H2")) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  } else if (params.get("said")) root.querySelector("[data-d-title]")?.focus();

  // The note and the chosen bot go with the person from one state of the share sheet to the next.
  const withNote = (url) => {
    const field = root.querySelector("[data-note]");
    if (!field) return url;
    const next = new URL(url, location.href);
    next.searchParams.set("note", field.value);
    return `${next.pathname.split("/").pop()}${next.search}`;
  };

  root.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-go]");
    if (target && target.getAttribute("aria-disabled") !== "true") {
      location.href = target.hasAttribute("data-keep-note") ? withNote(target.dataset.go) : target.dataset.go;
      return;
    }
    const keep = event.target.closest("a[data-keep-note]");
    if (keep) {
      event.preventDefault();
      location.href = withNote(keep.getAttribute("href"));
      return;
    }
    const radio = event.target.closest("[role=radio]");
    if (radio) {
      location.href = go("share", { to: radio.dataset.to });
      return;
    }
    const where = event.target.closest("[data-where]");
    if (where) live.textContent = where.dataset.where;
  });

  // The bot list: one tab stop; Up and Down move and choose; Done takes the choice.
  const group = root.querySelector("[data-radios]");
  if (group) {
    const radios = [...group.querySelectorAll("[role=radio]")];
    const choose = (r) => {
      for (const o of radios) {
        o.setAttribute("aria-checked", String(o === r));
        o.tabIndex = o === r ? 0 : -1;
      }
      r.focus();
      root.querySelector("[data-to-done]").dataset.go = go("share", { to: r.dataset.to });
    };
    group.addEventListener("keydown", (event) => {
      const at = radios.indexOf(document.activeElement);
      if (at < 0) return;
      const to = { ArrowDown: (at + 1) % radios.length, ArrowRight: (at + 1) % radios.length, ArrowUp: (at - 1 + radios.length) % radios.length, ArrowLeft: (at - 1 + radios.length) % radios.length }[event.key];
      if (to === undefined) return;
      event.preventDefault();
      choose(radios[to]);
    });
  }

  // "Also remove it from the gateway" changes where Stop leads.
  const also = root.querySelector("[data-also-remove]");
  if (also) {
    const stop = root.querySelector("[data-stop]");
    const base = stop.dataset.go;
    also.addEventListener("change", () => {
      const next = new URL(base, location.href);
      if (also.checked) next.searchParams.set("removed", "1");
      else next.searchParams.delete("removed");
      stop.dataset.go = `device.html${next.search}`;
    });
  }

  // Escape closes a modal by its Cancel.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const cancel = root.querySelector("[data-host-cancel], [data-d-dialog] [data-cancel], [data-d-modal] [data-cancel]");
    if (!cancel) return;
    location.href = cancel.getAttribute("href") || cancel.dataset.go;
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
