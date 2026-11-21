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

  // What the operator connection holds: read, write (the interactive tier), pairing (device access), or admin.
  const access = ["read", "write", "pairing", "admin"].includes(params.get("access")) ? params.get("access") : "admin";
  const isAdmin = access === "admin";
  const screenId = params.get("screen") || "mac-off";
  const phoneScreen = /^(phone-|card-|share|siri)/.test(screenId) || params.get("dev") === "phone";
  // The owner's choice serves either device: dev=phone puts it on This iPhone.
  const P = phoneScreen;
  const WHAT = P ? "iPhone" : "Mac";
  const HOME = P ? "phone-on" : "mac-on";
  const TITLE = P ? "This iPhone" : "This Mac";

  // Kept from one state to the next; everything else is per state.
  const KEEP = ["theme", "width", "motion", "chrome", "access", "link", "app", "own", "local", "prior", "allowed", "off", "devname", "taskname", "to", "note", "task", "from", "dev", "msg", "omit", "history", "half", "gw", "gone", "big", "nodefault", "nobots"];
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
  // Only on an observed refusal; an absence from a listing carries no refusal mark.
  const markRefused = () => `<span class="d-mark" data-mark="gateway">${icon("approval")}The gateway refused this request</span>`;
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

  // Example grants and records made before, shown only with history=1. A first-time activation
  // starts every app at Not decided unless the operating system already refused (Contacts here):
  // pairing never creates a local Allow.
  const history = params.get("history") === "1";

  // This device's decision for an app: undecided, allowed, denied or settings.
  function localOf(id, phone) {
    if (list("off").includes(id)) return "denied";
    if (list("allowed").includes(id)) return "allowed";
    if (id === chosen && params.get("local")) return params.get("local") === "allowed" ? "allowed" : "denied";
    if (id === chosen && params.get("prior") === "denied") return "denied";
    if (id === "contacts") return "settings";
    if (!history) return "undecided";
    const before = phone ? { calendar: "allowed", reminders: "denied" } : { location: "allowed", reminders: "denied" };
    return before[id] || "undecided";
  }
  // What the gateway listed for an app: listed, partial (half=<app>: its first command only) or notlisted.
  const gatewayOf = (id) =>
    list("omit").includes(id) ? "notlisted" : list("half").includes(id) ? "partial" : OWN_APPS.includes(id) ? (id === chosen && params.get("own") === "listed" ? "listed" : "notlisted") : "listed";
  const codes = (cmds, join = " and ") => cmds.map((c) => `<code>${c}</code>`).join(join);

  const without = (key, id) => list(key).filter((x) => x !== id).join(",") || null;
  const withId = (key, id) => [...new Set([...list(key), id])].join(",");

  function appRow([id, name, cmds, does], { phone = false, off = false } = {}) {
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
    // Both values that offer Allow disclose what Allow lets through, before the tap.
    const scope = local === "undecided" || local === "denied" ? `<span class="d-fact" data-scope>Allow lets every request for ${name} that reaches this ${phone ? "iPhone" : "Mac"} ${does}, from now on, until you turn it off.</span>` : "";
    // Each mark on its own evidence: a refusal mark only on a Denied or OS-blocked row; an undecided row says it will ask.
    const localMark = local === "denied" || local === "settings" ? markDevice() : local === "undecided" ? `<span class="d-mark" data-mark="asks">Clawtrate asks you first</span>` : "";
    const gatewayLine =
      gateway === "listed"
        ? `<b>Listed, 5:31 PM</b>${markListed()}`
        : gateway === "partial"
          ? `<b>Listed, 5:31 PM: ${codes(cmds.slice(0, 1))}</b>${markListed()}`
          : `<b>Not listed when read at 5:31 PM</b>`;
    const missingLine = gateway === "partial" ? `<span class="d-fact" data-missing>Not listed when read at 5:31 PM: ${codes(cmds.slice(1))}</span>` : "";
    return (
      `<li><div class="d-app" role="group" aria-label="${name}" data-app="${id}" data-local="${local}" data-gateway="${gateway}">${glyph(id)}<div class="d-app-text"><span class="d-app-name">${name}</span>` +
      `<span class="d-fact"${local === "denied" || local === "settings" ? ' data-tone="warn"' : ""}>${here}: <b>${word}</b>${localMark}</span>` +
      `<span class="d-fact">Gateway: ${gatewayLine}</span>` +
      missingLine +
      // Read as absent from the allowlist (config.get), entry by entry.
      (gateway === "notlisted" && OWN_APPS.includes(id) ? `<span class="d-fact" data-absent>The gateway's allowlist didn't include ${codes(cmds, " or ")} when read at 5:31 PM.</span>` : "") +
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
  // A record: the operation, its local send attempt and what the gateway acknowledged. "Sent nothing" has no
  // acknowledgement. Raw holds the request's own ID and parameters, and for a refusal the code and sentence sent.
  const record = (r) =>
    `<li class="d-record" data-record="${r.id}"><p class="d-record-head"><b>${r.when}</b> · ${r.app} · <code>${r.command}</code></p>` +
    `<p>${r.named}</p><p data-did>${r.did}</p><p data-sent>${r.code ? `Sent <code>${r.code}</code>.` : r.sent}</p>${r.ack ? `<p data-ack>${r.ack}</p>` : ""}` +
    `<details class="d-raw"><summary>Raw</summary><pre><code>${esc(
      JSON.stringify({ id: `${r.id}7f…`, command: r.command, paramsJSON: r.params || "{}", ...(r.code ? { sent: { ok: false, error: { code: r.code, message: r.sentence } } } : {}) }, null, 1),
    )}</code></pre></details></li>`;
  const records = (phone, rows) =>
    `<h4 class="b-group">Requests to this device</h4>` +
    (rows.length
      ? `<ul class="d-records" aria-label="Requests to this device">${rows.map(record).join("")}</ul>`
      : `<p class="d-lead" data-no-records>No requests have reached this ${phone ? "iPhone" : "Mac"} yet.</p>`);
  const named = (kind) =>
    kind === "listed"
      ? `The request names a task of Otto's, “${esc(TASK)}”. This ${phoneScreen ? "iPhone" : "Mac"} can't confirm who sent it.`
      : kind === "other"
        ? `The request names a task this ${phoneScreen ? "iPhone" : "Mac"} doesn't list (<code>agent:otto:dashboard:5b1e…</code>). This ${phoneScreen ? "iPhone" : "Mac"} can't confirm who sent it.`
        : `The request names no task. This ${phoneScreen ? "iPhone" : "Mac"} can't confirm who sent it.`;
  const MAC_RECORDS = [
    { id: "r1", when: "5:44 PM", app: "Location", command: "location.get", params: '{"desiredAccuracy":"balanced"}', named: named("listed"), did: "Ran it.", sent: "Sent the result.", ack: "The gateway accepted it." },
    { id: "r2", when: "5:12 PM", app: "Reminders", command: "reminders.list", named: named("none"), did: "Didn't run it: Reminders is Denied on this Mac.", code: "NOT_ALLOWED_ON_DEVICE", sentence: `Reminders is not allowed on ${MAC}.`, ack: "The gateway accepted it." },
    { id: "r3", when: "4:58 PM", app: "Calendar", command: "calendar.events", params: '{"from":"2026-11-21"}', named: named("other"), did: "Timed out at 4:58 PM. Didn't run it.", sent: "Sent nothing." },
    // The gateway's own timer ended this call after it reached this Mac: the record stays.
    { id: "r4", when: "4:40 PM", app: "Location", command: "location.get", params: '{"desiredAccuracy":"precise"}', named: named("none"), did: "Ran it.", sent: "Sent the result.", ack: "The gateway ignored this device's answer." },
  ];
  // What Stop and Turn off left in the records: each from its own evidence.
  const STOP_RECORDS = [
    { id: "s1", when: "5:39 PM", app: "Calendar", command: "calendar.events", named: named("none"), did: "Started it. Stopped the operation: Calendar confirmed it.", sent: "Sent nothing." },
    { id: "s2", when: "5:39 PM", app: "Location", command: "location.get", named: named("listed"), did: "Started it. Clawtrate couldn't confirm whether it stopped.", sent: "Sent nothing." },
    { id: "s3", when: "5:38 PM", app: "Messages", command: "clawtrate.messages.send", named: named("listed"), did: "Sent the message before Stop.", sent: "Sent the result.", ack: "Clawtrate couldn't confirm the gateway received it." },
    { id: "s4", when: "5:38 PM", app: "Reminders", command: "reminders.list", named: named("none"), did: "Didn't run it: Clawtrate stopped answering on this Mac.", code: "TURNED_OFF_ON_DEVICE", sentence: `Reminders was turned off on ${MAC} before the request was run.`, ack: "The gateway accepted it." },
    { id: "s5", when: "5:30 PM", app: "Messages", command: "clawtrate.messages.read", named: named("none"), did: "Didn't run it: Messages was turned off on this Mac.", code: "TURNED_OFF_ON_DEVICE", sentence: `Messages was turned off on ${MAC} before the request was run.`, ack: "The gateway accepted it." },
  ];

  // The page once the node is on.
  function onPage({ phone = false, state, extraTop = "", recs } = {}) {
    const apps = phone ? PHONE_APPS : MAC_APPS;
    const what = phone ? "iPhone" : "Mac";
    const line =
      state ||
      (phone
        ? `<p class="d-state" data-tone="ok" data-facts>Connected as a device for bots (read 5:31 PM).<small>This iPhone's node socket has a hello, and the gateway listed ${esc(PHONE)} (bots) as connected at 5:31 PM.</small></p>`
        : `<p class="d-state" data-tone="ok" data-facts>This host's node socket has a hello.<small>The gateway listed ${esc(MAC)} (bots) as connected at 5:31 PM.</small></p>`);
    return (
      `<div class="d-switch-row"><h4>Let bots use this ${what}</h4>${sw(true, go(phone ? "phone-stop" : "mac-stop"), `Let bots use this ${what}`)}` +
      `<p>Bots, and other devices connected to the gateway with write access, can send this ${what} requests for the apps you allow below. Clawtrate asks you before an app's first use.</p></div>` +
      line +
      extraTop +
      `<h4 class="b-group">Apps</h4><ul class="d-apps" aria-label="Apps this ${what} offers">${apps.map((a) => appRow(a, { phone })).join("")}</ul>` +
      records(phone, recs || (phone ? PHONE_RECORDS() : history ? MAC_RECORDS : [])) +
      botsLine() +
      examples(phone) +
      never(phone) +
      facts([["Device name", `${esc(phone ? PHONE : MAC)} (bots)`], ["Gateway", `${GATEWAY}, OpenClaw 2026.10.6`]])
    );
  }

  // saved=1: this device keeps a node sign-in from before (Stop keeps it). Only admin can get a new one;
  // a saved one reconnects without admin.
  const saved = params.get("saved") === "1";

  function offPage({ phone = false, after = "", recs } = {}) {
    const what = phone ? "iPhone" : "Mac";
    const apps = phone ? PHONE_APPS : MAC_APPS;
    return (
      `<div class="d-switch-row"><h4>Let bots use this ${what}</h4>${sw(false, go(phone ? "phone-confirm" : "mac-confirm", saved ? { saved: "1" } : {}), `Let bots use this ${what}`, !isAdmin && !saved)}` +
      `<p>Bots, and other devices connected to the gateway with write access, could then send this ${what} requests for the apps you allow below. Clawtrate asks you before an app's first use.</p></div>` +
      (isAdmin || saved ? "" : note("", "", `Letting bots use this ${what} needs admin access: only an admin connection can get this ${what}'s device sign-in.`) + adminBar("Admin access needed.")) +
      after +
      records(phone, recs || (phone ? PHONE_RECORDS() : history ? MAC_RECORDS : [])) +
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
      (saved
        ? `<p>Clawtrate will connect with this ${what}'s saved device sign-in. The next screen shows what the gateway listed.</p>`
        : `<p>Clawtrate will ask the connected gateway for a one-time sign-in for this ${what} as a device for bots. The next screen shows what the gateway listed.</p>`) +
      `<p>It offers ${apps}. Clawtrate asks you before an app's first use. Later requests that reach this device may use an app you allowed without asking again.</p></div>` +
      `</div></div><div class="s-host-buttons"><a class="button" data-size="sm" href="${saved ? go(phone ? "phone-stopped" : "mac-stopped", { saved: "1" }) : go(phone ? "phone-off" : "mac-off")}" data-host-cancel>Cancel</a>` +
      `<a class="button" data-variant="primary" data-size="sm" href="${go(phone ? "phone-steps" : "mac-steps", saved ? { saved: "1" } : {})}" data-host-confirm>Let bots use this ${what}</a></div></div></div>`
    );
  };

  // Turning on: each step's done mark follows its own simulated read (`at`); `fail` picks what a read showed.
  // Turning on again with the saved node sign-in: no code; the same read-back; the fence stays closed until it.
  function savedSteps(phone) {
    const what = phone ? "iPhone" : "Mac";
    const here = phone ? "phone-steps" : "mac-steps";
    const at = Number(params.get("at") || 0);
    const unread = params.get("fail") === "read";
    const state = (n) => (unread && n === 2 ? "failed" : at >= n ? "done" : at + 1 === n ? "running" : "waiting");
    const said = `The gateway listed ${phone ? PHONE : MAC} (bots) as connected at 5:31 PM.`;
    return (
      `<div class="d-switch-row"><h4>Let bots use this ${what}</h4>${sw(false, "", `Let bots use this ${what}`, true)}<p>Turning on again. Each step is done only when the gateway's answer shows it.</p></div>` +
      steps([
        [`Connecting with this ${what}'s saved device sign-in`, state(1), state(1) === "done" ? "Its hello says role node." : ""],
        ["Reading back what the gateway lists", state(2), state(2) === "running" ? `Requests to this ${what} wait until it is read.` : ""],
      ]) +
      (unread
        ? note("danger", "Couldn't read what the gateway lists.", `Requests to this ${what} wait until it is read.`) + `<div class="d-actions">${act("Check again", go(here, { saved: "1", fail: null, at: "1" }), { variant: "primary", attrs: "data-retry" })}</div>`
        : at === 0
          ? proto(link("The node's hello arrives", go(here, { saved: "1", at: "1" })), link("The gateway refuses the saved sign-in", go(phone ? "phone-refused" : "mac-refused", { saved: null, at: null })))
          : proto(link("The read-back agrees", go(phone ? "phone-on" : "mac-on", { saved: null, at: null, said })), link("It can't be read", go(here, { saved: "1", fail: "read" }))))
    );
  }

  function stepsPage(phone) {
    if (saved) return savedSteps(phone);
    const what = phone ? "iPhone" : "Mac";
    const here = phone ? "phone-steps" : "mac-steps";
    const fail = params.get("fail");
    const at = Number(params.get("at") || 0);
    const failedAt = { code: 1, codeother: 1, hello: 2, pair: 2, read: 3, pending: 3, changed: 3, extra: 3 }[fail] || 0;
    const state = (n) => (failedAt === n ? "failed" : failedAt ? (n < failedAt ? "done" : "waiting") : at >= n ? "done" : at + 1 === n ? "running" : "waiting");
    const retry = (label = "Try again") => `<div class="d-actions">${act(label, go(here, { fail: null, at: null }), { variant: "primary", attrs: "data-retry" })}</div>`;
    const declared = phone ? ["calendar.events", "contacts.search", "location.get", "reminders.list"] : ["location.get", "contacts.search", "calendar.events", "reminders.list"];
    const after =
      fail === "code"
        ? note("danger", `The gateway didn't give this ${what} a device sign-in: it needs admin access.`, "")
        : fail === "codeother"
          ? note("danger", `Couldn't get this ${what}'s device sign-in.`, "The gateway said: <code>pairing setup needs a gateway address it can reach</code>.") + retry()
          : fail === "hello"
            ? note("danger", `This ${what} stopped trying to connect. The gateway pairing couldn't be confirmed.`, "") + retry()
            : fail === "pair"
              ? note("danger", `The gateway didn't pair this ${what} with the code.`, "Its reason: <code>PAIRING_REQUIRED (role-upgrade)</code>.") + retry()
              : fail === "read"
                ? note("danger", "Couldn't read what the gateway lists.", `Requests to this ${what} wait until it is read.`) + retry("Check again")
                : fail === "pending"
                  ? note("warn", `This ${what}'s commands wait for approval.`, `Pending: <code>${declared[2]}</code>, <code>${declared[3]}</code>.`) +
                    // Compared again just before node.pair.approve {requestId}: the request against the current declaration.
                    `<p class="d-lead" data-compared>Compared with this ${what}'s declaration at 5:31 PM: <code>${declared[2]}</code> and <code>${declared[3]}</code> are declared; <code>${declared[0]}</code> and <code>${declared[1]}</code> are already listed.</p>` +
                    `<div class="d-actions">${act("Approve its commands", go(here, { fail: null, at: "2", approved: "1" }), { variant: "primary", attrs: "data-approve-own" })}</div>` +
                    proto(link("The request changed since it was read", go(here, { fail: "changed" })))
                  : fail === "changed"
                    ? note("danger", "The pending request changed since Clawtrate read it. Clawtrate approved nothing.", `It now also lists <code>system.run</code>, which this ${what} doesn't declare.`)
                  : fail === "extra"
                    ? note("danger", `The gateway lists commands this ${what} doesn't offer. Clawtrate disconnected it.`, "Listed: <code>system.run</code>.")
                    : at === 0
                      ? proto(link("The gateway answers with a node code", go(here, { at: "1" })), link("Answer: needs admin", go(here, { fail: "code" })), link("Answer: another refusal", go(here, { fail: "codeother" })))
                      : at === 1
                        ? proto(link("The node's hello arrives", go(here, { at: "2" })), link("No hello", go(here, { fail: "hello" })), link("The code doesn't pair it", go(here, { fail: "pair" })))
                        : params.get("subset") === "1"
                          ? note("warn", `The gateway listed some of this ${what}'s commands.`, `Not listed: <code>${declared[3]}</code>.`) +
                            `<div class="d-actions">${act("Finish", go(phone ? "phone-on" : "mac-on", { omit: "reminders", said: `The gateway listed ${phone ? PHONE : MAC} (bots) as connected at 5:31 PM.` }), { variant: "primary", attrs: "data-finish" })}</div>`
                          : proto(
                              link("The read-back agrees", go(phone ? "phone-on" : "mac-on", { said: `The gateway listed ${phone ? PHONE : MAC} (bots) as connected at 5:31 PM.` })),
                              link("It lists a strict subset", go(here, { at: "2", subset: "1" })),
                              link("It can't be read", go(here, { fail: "read" })),
                              link("The commands wait for approval", go(here, { fail: "pending" })),
                              link("It lists an extra command", go(here, { fail: "extra" })),
                            );
    return (
      `<div class="d-switch-row"><h4>Let bots use this ${what}</h4>${sw(false, "", `Let bots use this ${what}`, true)}<p>Turning on. Each step is done only when the gateway's answer shows it.</p></div>` +
      steps([
        [`Getting this ${what}'s device sign-in`, state(1), state(1) === "done" ? "The gateway answered with a usable code for the node role only, for this gateway's address." : ""],
        ["Connecting as a device for bots", state(2), state(2) === "done" ? "Its hello says role node." : ""],
        [
          "Reading back what the gateway lists",
          state(3),
          state(3) === "running"
            ? params.get("approved") === "1"
              ? `Approved request 7a1c…. Reading the resulting commands: approving is not listing, and any command beyond this ${what}'s declaration disconnects it.`
              : `Waiting for paired, approved, connected, and commands this ${what} declared.`
            : "",
        ],
      ]) +
      after
    );
  }

  // The stored settings (config.get) and the active listing for this node (node.describe), reported apart.
  // kind is "list" after an add, "unlist" after a removal; read=both|stored|active|fail picks what each read showed.
  function readBack(kind) {
    const r = params.get("read");
    if (!r) return "";
    const c = codes(chosenApp[2]);
    const dev = `${esc(P ? PHONE : MAC)} (bots)`;
    const t = kind === "list" ? "5:33 PM" : "5:41 PM";
    const storedDone = r === "both" || r === "stored";
    const activeDone = r !== "stored";
    const stored =
      r === "fail"
        ? "Couldn't read the gateway's allowlist."
        : kind === "list"
          ? storedDone ? `The gateway's stored settings list ${c} (read ${t}).` : `The gateway's stored settings don't list ${c} (read ${t}).`
          : storedDone ? `The gateway's stored settings no longer list ${c} (read ${t}).` : `The gateway's stored settings still list ${c} (read ${t}).`;
    const active =
      kind === "list"
        ? activeDone ? `The gateway listed them for ${dev} at ${t}.` : `The gateway doesn't list them for ${dev} yet (read ${t}).`
        : activeDone ? `The gateway no longer lists them for ${dev} (read ${t}).` : `The gateway still lists them for ${dev} (read ${t}).`;
    const lead = kind === "list" ? "" : storedDone ? "Removed from the gateway's allowlist." : "Clawtrate couldn't confirm the allowlist edit.";
    return `<div class="b-note" role="status" data-readback="${r}">${icon(storedDone ? "check" : "warning")}<div>${lead ? `<p><b>${lead}</b></p>` : ""}<p data-stored>${stored}</p><p data-active>${active}</p></div></div>`;
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
          `<p>This doesn't allow ${chosenApp[1]} on this ${WHAT}. This keeps this ${WHAT}'s current ${chosenApp[1]} choice. You can change that choice here.</p>`,
        link("Cancel", go(HOME, { app: null }), { size: "md", attrs: "data-cancel" }) + act(`Add ${chosenApp[1]}`, go("mac-messages-steps"), { variant: "primary", size: "md", attrs: "data-confirm" }),
      ),

    "mac-messages-steps": () => {
      const fail = params.get("fail");
      const name = chosenApp[1];
      const s1 = ["1", "1quiet", "hash"].includes(fail) ? "failed" : "done";
      const s2 = s1 === "failed" ? "waiting" : fail === "2" ? "failed" : "done";
      const s3 = s2 === "done" ? "running" : "waiting";
      const stored = codes(chosenApp[2]);
      const after =
        fail === "1"
          ? note("danger", `The gateway refused this change: <code>config.patch denied</code>.`, params.get("reread") === "fail" ? "Couldn't read the gateway's allowlist." : `The gateway's allowlist, read at 5:33 PM: <code>calendar.add</code>.`) + markRefused()
          : fail === "hash"
            ? note("danger", "The gateway's settings changed since Clawtrate read them. Clawtrate didn't write this change.", "") +
              `<div class="d-actions">${act("Try again", go("mac-messages-confirm", { fail: null }), { variant: "primary", attrs: "data-retry" })}</div>`
          : fail === "1quiet"
            ? note("danger", "Clawtrate couldn't confirm whether the gateway's settings changed.", "") + `<div class="d-actions">${act("Check again", go("mac-messages-steps", { fail: null }), { variant: "primary" })}</div>`
            : fail === "2"
              ? note("danger", `The gateway's settings list ${name}, but the gateway doesn't list it for this ${WHAT} yet.`, "") +
                `<div class="d-actions">${act("Try again", go("mac-messages-steps", { fail: null }), { variant: "primary" })}${act("Remove it from the allowlist", go("mac-messages-remove", { fail: null }), { variant: "quiet" })}</div>`
              : proto(
                  link(`The gateway lists the commands for this ${WHAT}`, go("mac-messages-on", { own: "listed", read: "both", said: `${name} listed by the gateway` })),
                  link("The settings write answers with a refusal", go("mac-messages-steps", { fail: "1" })),
                  link("The settings changed since they were read", go("mac-messages-steps", { fail: "hash" })),
                );
      return settings({
        title: TITLE,
        phone: P,
        body:
          `<h4 class="b-group">Adding ${name}</h4>` +
          steps([
            [`Writing ${name} to the gateway's allowlist`, s1, s1 === "done" ? `The gateway's stored settings list ${stored} (read 5:33 PM).` : ""],
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
        body: onPage({ phone: P, extraTop: note("", "", "Adding it to the gateway's allowlist needs admin access.") + adminBar("Admin access needed.") }),
      }),

    // The stored and the active read-back, each on its own read.
    "mac-messages-on": () => settings({ title: TITLE, phone: P, body: onPage({ phone: P, extraTop: readBack("list") }) }),

    "mac-messages-remove": () =>
      settings({ title: TITLE, phone: P, body: onPage({ phone: P }) }) +
      dialog(
        `Remove ${chosenApp[1]} from the gateway's allowlist?`,
        `<p>Remove ${codes(chosenApp[2])} from the gateway-wide allowlist? If that removes the commands from the active policy, the gateway can end waiting calls and refuse later calls for them. An operation this ${WHAT} already started may finish. This ${WHAT} keeps its ${chosenApp[1]} choice.</p>`,
        link("Cancel", go("mac-messages-on", { read: null }), { size: "md", attrs: "data-cancel" }) +
          act("Remove", go("mac-messages-removed", { read: "both", own: null }), { variant: "primary", size: "md", attrs: "data-confirm" }),
      ),

    // After the removal: what each read showed, apart. Done for the edit comes from the stored read.
    "mac-messages-removed": () => {
      return settings({
        title: TITLE,
        phone: P,
        body: onPage({
          phone: P,
          extraTop:
            readBack("unlist") +
            proto(
              link("Both reads show it gone", go("mac-messages-removed", { read: "both", own: null })),
              link("Only the stored settings show it gone", go("mac-messages-removed", { read: "stored", own: "listed" })),
              link("Only the active listing shows it gone", go("mac-messages-removed", { read: "active", own: null })),
              link("The allowlist can't be read", go("mac-messages-removed", { read: "fail", own: null })),
            ),
        }),
      });
    },

    "mac-stop": () => settings({ title: "This Mac", body: onPage() }) + stopDialog(false),
    "mac-stopped": () => settings({ title: "This Mac", body: offPage({ after: stoppedNote(false), recs: STOP_RECORDS }) }),

    "mac-offline": () =>
      settings({
        title: "This Mac",
        body: onPage({ state: `<p class="d-state">Not connected. Clawtrate is trying again.<small>The gateway last saw it at 5:02 PM (connect).</small></p>` }),
      }),
    "phone-refused": () =>
      settings({
        title: "This iPhone",
        phone: true,
        body: offPage({ phone: true, after: `<p class="d-state" data-tone="danger">The gateway refused this iPhone's device sign-in. Turn it on again to get a new one.</p>` }),
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
            ? resolvedCard({ tag: "Allowed", tone: "accent", line: "A request for Calendar", words: "Allowed. This Mac read your calendar's events and sent them at 5:44 PM; the gateway accepted the answer. This request set Calendar to Allowed.", cmd: "calendar.events", p: '{"from":"2026-11-21","to":"2026-11-22"}', kind: "none" })
            : askCard({
                title: "Calendar requested on this Mac",
                kind: "none",
                scope: "Allow reads your calendar's events for this request, and lets every later request for Calendar that reaches this Mac read them, until you turn it off.",
                foot: "Clawtrate closes this card by 5:44:30 PM.",
                allowTo: go("mac-request", { ask: "allowed", said: "Calendar allowed" }),
                denyTo: go("mac-on", { off: withId("off", "calendar"), said: "Calendar denied" }),
                cmd: "calendar.events",
                p: '{"from":"2026-11-21","to":"2026-11-22"}',
              })) +
          onPage().replace(/^[\s\S]*?(?=<h4 class="b-group">Apps<\/h4>)/, ""),
      });
    },

    // Each line says what a read or an event matched to the request's ID established, with its time.
    machines: () => {
      const ipad = params.get("ipad");
      const pc = params.get("pc");
      const dlg = params.get("dlg");
      const readfail = params.get("readfail") === "1";
      const said = (text) => `<p class="d-event" data-after>${text}</p>`;
      const unread = (who) => said(`Couldn't read the gateway. Clawtrate can't tell what happened to ${who}'s request.`) + `<div class="d-actions">${act("Check again", go("machines", { readfail: null }), { attrs: "data-reread" })}</div>`;
      const ipadRow = (extra = "") =>
        `<div class="d-request" data-request="ipad"><h4>Kitchen iPad requests the node role.</h4><p>iPadOS, asked 5:20 PM. Request <code>5d2e…</code></p>${extra}` +
        `<div class="d-actions">${act("Approve", go("machines", { dlg: "ipad", ipad: null }), { variant: "primary", attrs: 'aria-label="Approve Kitchen iPad"' })}${act("Reject", go("machines", { ipad: "rejected" }), { variant: "quiet", attrs: 'aria-label="Reject Kitchen iPad"' })}</div>` +
        proto(link("The approval is refused", go("machines", { ipad: "refused" })), link("The request disappears with no event", go("machines", { ipad: "gone" })), link("It disappears, and the read fails", go("machines", { ipad: "gone", readfail: "1" }))) +
        `</div>`;
      const ipadBlock =
        ipad === "approved"
          ? readfail
            ? unread("Kitchen iPad")
            : said("Kitchen iPad's device entry lists the node role (read 5:22 PM).")
          : ipad === "refused"
            ? ipadRow(note("danger", "The gateway refused the approval: <code>missing scope: operator.admin</code>.", "The request is still pending (read 5:22 PM)."))
            : ipad === "rejected"
              ? said("The gateway reported request <code>5d2e…</code> rejected (<code>device.pair.resolved</code>, 5:22 PM).")
              : ipad === "gone"
                ? readfail
                  ? unread("Kitchen iPad")
                  : said("The request is no longer pending (read 5:22 PM).")
                : ipadRow();
      const PC_CMDS = "<code>location.get</code>, <code>system.run</code>, <code>fs.listDir</code>";
      const pcRow = (extra = "") =>
        `<div class="d-request" data-request="pc"><h4>Workshop PC requests ${PC_CMDS}. These commands need admin approval.</h4><p>Windows, asked 5:21 PM. Request <code>9b04…</code></p>` +
        `<p data-tone="warn">If approved and permitted, these commands can run a program or list files on Workshop PC.</p>${extra}` +
        `<div class="d-actions">${act("Approve", go("machines", { dlg: "pc", pc: null }), { variant: "primary", attrs: 'aria-label="Approve Workshop PC\'s commands"' })}${act("Reject", go("machines", { pc: "rejected" }), { variant: "quiet", attrs: 'aria-label="Reject Workshop PC\'s commands"' })}</div>` +
        proto(link("The approval is refused", go("machines", { pc: "refused" }))) +
        `</div>`;
      const pcBlock =
        pc === "approved"
          ? readfail
            ? unread("Workshop PC")
            : said(`The gateway lists these commands for Workshop PC (read 5:22 PM): ${PC_CMDS}.`)
          : pc === "refused"
            ? pcRow(note("danger", "The gateway refused the approval: <code>node pairing changed</code>.", "The request is still pending (read 5:22 PM)."))
            : pc === "rejected"
              ? said("The gateway reported request <code>9b04…</code> rejected (<code>node.pair.resolved</code>, 5:22 PM).")
              : pcRow();
      // Below admin the two sections stay independent: the requests show the admin line; Paired devices
      // shows controls.md §15's device-access line below pairing, this device's own records at pairing,
      // and the whole list only at admin.
      const requests = isAdmin ? ipadBlock + pcBlock : note("", "", "Approving other devices for bots needs admin access.") + adminBar("Admin access needed.");
      const paired = isAdmin
        ? facts([["This device", esc(MAC)], [`${esc(MAC)} (bots)`, "A device for bots, connected"], ["iPhone", "Last seen 4:58 PM"]])
        : access === "pairing"
          ? facts([["This device", esc(MAC)]]) + `<p class="d-lead" data-paired-scope>Only this device's own records are listed. Seeing other devices needs admin access.</p>`
          : `<p class="d-lead" data-paired-scope>Seeing paired devices needs device access.</p><div class="d-actions">${act("Request access", go("machines", { req: "requested" }), { attrs: "data-request-pairing" })}</div>`;
      const body =
        `<h4 class="b-group">Machines</h4>${facts([["The gateway's machine", "Connected"], ["media-box", "Connected"]])}` +
        `<h4 class="b-group">Devices asking to be used by bots</h4>${requests}` +
        `<h4 class="b-group">Paired devices</h4><div data-paired>${paired}</div>`;
      let over = "";
      if (dlg === "ipad")
        over = dialog(
          "Approve Kitchen iPad as a device for bots?",
          `<p>Kitchen iPad requests the node role. Its commands are a separate request, approved separately. What a device does with a request is up to the device.</p>`,
          link("Cancel", go("machines", { dlg: null }), { size: "md", attrs: "data-cancel" }) + act("Approve", go("machines", { dlg: null, ipad: "approved" }), { variant: "primary", size: "md", attrs: "data-confirm" }),
        );
      if (dlg === "pc")
        over = dialog(
          "Approve Workshop PC's commands?",
          `<p>Workshop PC requests ${PC_CMDS}. If approved and permitted, these commands can run a program or list files on Workshop PC.</p>`,
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
    // Back in the foreground: the gateway read again, and the records this iPhone kept. gap=1: the app was
    // suspended and the socket closed unobserved, so whether anything was delivered meanwhile is unknown.
    "phone-back": () => {
      const gap = params.get("gap") === "1";
      return settings({
        title: "This iPhone",
        phone: true,
        body:
          (gap
            ? `<p class="d-event" data-back>While Clawtrate was suspended, whether requests were delivered to this iPhone, and when the gateway saw its socket close, isn't known. The records show only what this iPhone received.</p>` +
              `<p class="d-state" data-tone="ok" data-facts>Connected as a device for bots (read 5:46 PM).<small>The gateway last saw the earlier connection at 5:12 PM (disconnect).</small></p>` +
              records(true, [
                { id: "b2", when: "5:39 PM", app: "Calendar", command: "calendar.events", named: named("none"), did: "Ran it, before Clawtrate left the foreground.", sent: "Sent the result.", ack: "The gateway accepted it." },
              ])
            : `<p class="d-state" data-tone="ok" data-facts>Connected as a device for bots (read 5:46 PM).<small>This iPhone's node socket has a hello, and the gateway listed ${esc(PHONE)} (bots) as connected at 5:46 PM.</small></p>` +
              records(true, [
                // The background refusal line, only for a call received while Clawtrate wasn't active.
                { id: "b1", when: "5:41 PM", app: "Location", command: "location.get", named: named("listed"), did: "Didn't run it: Clawtrate wasn't active on this iPhone.", code: "NOT_OPEN_ON_DEVICE", sentence: `Clawtrate isn't open on ${PHONE}, so no one could be asked.`, ack: "The gateway accepted it." },
                { id: "b2", when: "5:39 PM", app: "Calendar", command: "calendar.events", named: named("none"), did: "Ran it, before Clawtrate left the foreground.", sent: "Sent the result.", ack: "Clawtrate couldn't confirm the gateway received it." },
              ])) +
          proto(link("A request was refused while inactive", go("phone-back", { gap: null })), link("The app was suspended and its socket closed", go("phone-back", { gap: "1" }))),
      });
    },
  };

  function stopDialog(phone) {
    const what = phone ? "iPhone" : "Mac";
    return dialog(
      `Stop letting bots use this ${what}?`,
      `<p>This ${what} stops answering at once, here, whether or not the gateway can be reached. An operation already started can't always be undone: a message already sent stays sent.</p>` +
        `<p>This ${what} keeps its saved device sign-in, so turning it on again needs no new code. This ${what}'s separate operator sign-in and the gateway's allowlist stay as read.</p>` +
        (isAdmin ? `<label class="d-check"><input type="checkbox" data-also-remove /> <span>Also remove this ${what}'s node pairing from the gateway</span></label>` : ""),
      link("Cancel", go(phone ? "phone-on" : "mac-on"), { size: "md", attrs: "data-cancel" }) + act("Stop", go(phone ? "phone-stopped" : "mac-stopped", { saved: "1", said: "Stopped on this " + what }), { variant: "primary", size: "md", attrs: "data-stop" }),
    );
  }

  function stoppedNote(phone) {
    const what = phone ? "iPhone" : "Mac";
    const removed = params.get("removed");
    // Whether the node is listed, and its connection state, only from a fresh read.
    const status = down
      ? removed === "unknown"
        ? "Gateway status couldn't be checked. Clawtrate couldn't confirm the removal."
        : "Gateway status couldn't be checked."
      : removed === "1"
        ? "Removed from the gateway (read 5:40 PM)."
        : removed === "fail"
          ? `Couldn't remove it from the gateway: <code>node pairing removal denied</code>. It's stopped on this ${what}.`
          : `The gateway lists this ${what} as a device, not connected (read 5:40 PM).`;
    // The saved node sign-in is cleared only on a confirmed absence.
    const cred = saved
      ? `<p data-cred>This ${what} keeps its saved device sign-in: turning it on again uses it, with no new code.</p>`
      : removed === "1"
        ? `<p data-cred>The gateway confirmed the removal, so this ${what}'s device sign-in was cleared. Turning it on again needs a new one, from admin.</p>`
        : "";
    const allowlist = !down && params.get("own") === "listed" ? `<p>The gateway's allowlist still lists ${chosenApp[2].map((c) => `<code>${c}</code>`).join(", ")} (read 5:40 PM).</p>` : "";
    return `<div class="b-note" role="status" data-stopped>${icon("clock")}<div><p><b>Stopped on this ${what}.</b> ${status}</p>${cred}${allowlist}<p>The apps' decisions on this ${what} stay as they were.</p></div></div>`;
  }

  // The permission card ---------------------------------------------------------

  // Two fixed request records, keyed by their own invocation IDs. Each card renders from its own
  // record (its ID, task key, parameters, budget and outcome); a control updates only its own ID.
  const REQS = {
    c41d: { id: "c41d…", line: "Location requested", title: "Location requested on this iPhone", p: '{"desiredAccuracy":"balanced"}', accuracy: "balanced", timeoutMs: 30000, foot: "Clawtrate closes this card by 5:44:30 PM." },
    e7a0: { id: "e7a0…", line: "Location requested again", title: "Location requested on this iPhone again", p: '{"desiredAccuracy":"precise"}', accuracy: "precise", timeoutMs: 70000, foot: "Clawtrate closes this card by 5:45:10 PM." },
  };
  const raw = (cmd, p, kind, req = REQS.c41d) =>
    `<details class="d-raw"><summary>Raw</summary><pre><code>${esc(
      JSON.stringify(
        { id: req.id, nodeId: "6ad2…", command: cmd, paramsJSON: p, timeoutMs: req.timeoutMs, ...(kind === "none" ? {} : { sessionKey: kind === "other" ? "agent:otto:dashboard:5b1e…" : "agent:otto:dashboard:9c2e…" }) },
        null,
        1,
      ),
    )}</code></pre></details>`;

  function askCard({ title, kind, scope, foot, allowTo, denyTo, cmd, p, req = REQS.c41d }) {
    return (
      `<section class="card d-ask" data-state="pending" data-card="${req.id.slice(0, 4)}" data-req="${req.id}" data-accuracy="${req.accuracy}" role="region" aria-label="${esc(title)}. Needs permission.">` +
      `<header class="request-head"><h3 class="request-title">${title}</h3><span class="tag" data-tone="warn">Needs permission</span></header>` +
      `<p data-named>${named(kind)}</p>` +
      `<p data-scope>${scope}</p>` +
      `<details><summary>Show request</summary><dl><div><dt>Command</dt><dd>${cmd}</dd></div><div><dt>Parameters</dt><dd>${esc(p)}</dd></div></dl>${raw(cmd, p, kind, req)}</details>` +
      `<div class="d-actions">${act("Allow", allowTo, { variant: "primary", size: "md", attrs: `data-ask-allow aria-label="Allow, for ${esc(title)}"` })}<span class="spacer"></span>${act("Don't allow", denyTo, { variant: "quiet", size: "md", attrs: `data-ask-deny aria-label="Don't allow, for ${esc(title)}"` })}</div>` +
      (foot ? `<p class="d-ask-foot">${foot}</p>` : "") +
      `</section>`
    );
  }
  const resolvedCard = ({ tag, tone, line, words, extra = "", cmd = "location.get", req = REQS.c41d, p = req.p, kind = taskKind() }) =>
    `<details class="card d-ask" data-state="resolved" data-tag="${tag}" data-card="${req.id.slice(0, 4)}" data-req="${req.id}" data-accuracy="${req.accuracy}"><summary><span class="tag"${tone ? ` data-tone="${tone}"` : ""}>${tag}</span> ${line}</summary>` +
    `<p data-words>${words}</p><p data-named>${named(kind)}</p>` +
    `<dl><div><dt>Command</dt><dd>${cmd}</dd></div><div><dt>Parameters</dt><dd>${esc(p)}</dd></div></dl>${raw(cmd, p, kind, req)}</details>${extra}`;

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
    foot: "Clawtrate closes this card by 5:44:30 PM.",
    cmd: "location.get",
    p: '{"desiredAccuracy":"balanced"}',
  };
  const later = `<div class="d-actions">${link("Location in This iPhone", go("phone-on", { task: null, from: "timedout" }), { attrs: "data-to-row" })}</div>`;

  const PHONE_RECORDS = () => {
    const from = params.get("from");
    return [
      ...(from === "timedout"
        ? [{ id: "t1", when: "5:44 PM", app: "Location", command: "location.get", named: named("listed"), did: "Timed out at 5:44 PM. Didn't run it. No permission was set by this request.", sent: "Sent nothing." }]
        : []),
      ...(history ? [{ id: "p1", when: "5:20 PM", app: "Calendar", command: "calendar.events", named: named("listed"), did: "Ran it.", sent: "Sent the result.", ack: "The gateway accepted it." },
      { id: "p2", when: "5:02 PM", app: "Reminders", command: "reminders.list", named: named("none"), did: "Didn't run it: Reminders is Denied on this iPhone.", code: "NOT_ALLOWED_ON_DEVICE", sentence: `Reminders is not allowed on ${PHONE}.`, ack: "The gateway ignored this device's answer." }] : []),
    ];
  };

  // What a card that was answered says, from its own record.
  // "This request set Location to …" only when this request actually changed the grant; the current grant stays on the app's row.
  const setBy = (value, changed = true) => (changed ? ` This request set Location to ${value}.` : "");
  const OUTCOME = {
    allowed: (r, changed) => ({ req: r, tag: "Allowed", tone: "accent", line: r.line, words: `Allowed. This iPhone got your location and sent it at 5:44 PM; the gateway accepted the answer.${setBy("Allowed", changed)}` }),
    denied: (r, changed) => ({ req: r, tag: "Not allowed", line: r.line, words: `Not allowed. This iPhone didn't run the request and sent the refusal <code>NOT_ALLOWED_ON_DEVICE</code> at 5:44 PM; the gateway accepted it.${setBy("Denied", changed)}` }),
  };

  Object.assign(SCREENS, {
    // second=1: two requests, each its own record; done=<id>:<outcome>,… holds what each card's own control did.
    "card-pending": () => {
      const two = params.get("second") === "1";
      // budget=short: 12 seconds left on arrival; budget=cap: 10 minutes, so this device's five-minute cap comes first.
      const budget = params.get("budget");
      const ids = two ? ["c41d", "e7a0"] : ["c41d"];
      const done = Object.fromEntries(list("done").map((x) => x.split(":")));
      // In the order answered: an answer changes the grant only when it differs from the one before it.
      const changed = {};
      list("done").reduce((grant, x) => {
        const [k, v] = x.split(":");
        changed[k] = v !== grant;
        return v;
      }, "undecided");
      const withOutcome = (id, v) => [...ids.filter((k) => done[k] && k !== id).map((k) => `${k}:${done[k]}`), `${id}:${v}`].join(",");
      const cards = ids
        .map((id) => {
          const r = REQS[id];
          if (OUTCOME[done[id]]) return resolvedCard(OUTCOME[done[id]](r, changed[id]));
          return askCard({
            ...LOC,
            title: r.title,
            foot: budget === "short" ? "Clawtrate closes this card by 5:44:12 PM." : budget === "cap" ? "Clawtrate closes this card by 5:49:00 PM." : r.foot,
            p: r.p,
            req: r,
            kind: taskKind(),
            allowTo: two ? go("card-pending", { second: "1", done: withOutcome(id, "allowed"), said: "Location allowed" }) : go("card-sent", { said: "Location allowed" }),
            denyTo: two ? go("card-pending", { second: "1", done: withOutcome(id, "denied") }) : go("card-dontallow"),
          });
        })
        .join("");
      return cardPlace(
        cards +
          (two
            ? ""
            : budget === "cap"
              ? proto(
                  link("Five minutes pass; the refusal is accepted", go("card-cap", { ack: "accepted" })),
                  link("Five minutes pass; the refusal is ignored", go("card-cap", { ack: "ignored" })),
                  link("Five minutes pass; no acknowledgement", go("card-cap", { ack: "none" })),
                )
              : proto(
                link("The deadline passes", go("card-timedout")),
                link("Allow, then the gateway ignores the answer", go("card-ignored")),
                link("Allow, and no acknowledgement", go("card-unconfirmed")),
                link("Turn off Location on this iPhone", go("card-turnedoff")),
                link("Don't allow, and the gateway ignores it", go("card-dontallow", { ack: "ignored" })),
                link("Clawtrate stops answering on this iPhone", go("card-stopped")),
              )),
      );
    },
    "card-sent": () => cardPlace(resolvedCard(OUTCOME.allowed(REQS.c41d))),
    "card-ignored": () =>
      cardPlace(resolvedCard({ tag: "Allowed", tone: "accent", line: "Location requested", words: "Allowed. This iPhone got your location and sent it at 5:44 PM. The gateway ignored this device's answer. This request set Location to Allowed." })),
    "card-unconfirmed": () =>
      cardPlace(resolvedCard({ tag: "Allowed", tone: "accent", line: "Location requested", words: "Allowed. This iPhone got your location and sent it at 5:44 PM. Clawtrate couldn't confirm the gateway received it. This request set Location to Allowed." })),
    "card-dontallow": () =>
      cardPlace(
        resolvedCard({
          tag: "Not allowed",
          line: "Location requested",
          words:
            params.get("ack") === "ignored"
              ? "Not allowed. This iPhone didn't run the request and sent the refusal <code>NOT_ALLOWED_ON_DEVICE</code> at 5:44 PM. The gateway ignored this device's answer. This request set Location to Denied."
              : "Not allowed. This iPhone didn't run the request and sent the refusal <code>NOT_ALLOWED_ON_DEVICE</code> at 5:44 PM; the gateway accepted it. This request set Location to Denied.",
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
    "card-stopped": () =>
      cardPlace(
        resolvedCard({
          tag: "Stopped",
          line: "Location requested",
          words: "Clawtrate stopped answering on this iPhone. This iPhone didn't run it and sent the refusal <code>TURNED_OFF_ON_DEVICE</code>; the gateway accepted it.",
        }),
      ),
    "card-timedout": () =>
      cardPlace(resolvedCard({ tag: "Timed out", line: "Location requested", words: "Timed out at 5:44 PM. This iPhone didn't run it. No permission was set by this request. Sent nothing.", extra: later })),
    // The five-minute cap came first for a 10-minute budget: NO_ANSWER_ON_DEVICE attempted, its acknowledgement as it came.
    "card-cap": () => {
      const ack = params.get("ack");
      const said =
        ack === "ignored" ? " The gateway ignored this device's answer." : ack === "none" ? " Clawtrate couldn't confirm the gateway received it." : "; the gateway accepted it.";
      return cardPlace(
        resolvedCard({
          tag: "Timed out",
          line: "Location requested",
          words: `No answer by 5:49 PM, this iPhone's five-minute limit. This iPhone didn't run it and sent <code>NO_ANSWER_ON_DEVICE</code>${ack === "ignored" || ack === "none" ? "." : ""}${said} No permission was set by this request.`,
          extra: later,
        }),
      );
    },
    "card-settings": () =>
      cardPlace(
        `<section class="card d-ask" data-state="pending" role="region" aria-label="Location is turned off for Clawtrate. Needs permission.">` +
          `<header class="request-head"><h3 class="request-title">Location is turned off for Clawtrate</h3><span class="tag" data-tone="warn">Turned off</span></header>` +
          `<p>Location is turned off for Clawtrate in Settings. This iPhone didn't run the request.</p><p data-named>${named(taskKind())}</p>` +
          `<div class="d-actions"><button type="button" class="button" data-variant="primary" data-size="md" data-where="Opens Settings, Clawtrate, Location. Nothing opens in the prototype.">Open Settings</button></div></section>`,
      ),
  });

  // The share sheet -------------------------------------------------------------

  // nodefault=1: agents.list's defaultId isn't among the returned bots, so To starts empty. nobots=1: no bot is
  // selectable. big=1: a shared item over the composer's limit, left out with its reason.
  const toBot = () => (Object.hasOwn(BOTS, params.get("to")) ? params.get("to") : params.get("nodefault") === "1" ? null : "juniper");
  const noBots = params.get("nobots") === "1";
  const listedBot = () => (noBots ? null : toBot());
  const canSend = access === "write" || isAdmin;
  const noteText = () => (params.get("note") !== null ? params.get("note") : "For Saturday's route.");
  const chips = () =>
    `<li>${icon("link")}<span>https://trail-guide.example/saturday</span></li>` +
    `<li>${icon("image")}<span>trail-map.png</span><small>240 KB</small></li>` +
    (params.get("big") === "1" ? `<li data-excluded>${icon("warning")}<span>trail-video.mov</span><small>1.4 GB · Can't be sent: larger than the composer's limit</small></li>` : "");
  const items = () => (params.get("big") === "1" ? "the note and 2 items; trail-video.mov is left out" : "the note and 2 items");
  const other = () =>
    `<div class="d-other" aria-hidden="true"><p class="d-other-caption">Another app on the iPhone (a stand-in)</p><div class="d-other-tile"></div><div class="d-other-tile"></div></div>`;
  // Before submission the sheet offers Cancel; once submitted (pending, unknown or acknowledged), Close.
  const sheet = (inner, title = "Clawtrate", closed = null) =>
    `<div class="d-share" role="dialog" aria-modal="true" aria-labelledby="d-share-title" data-d-modal>` +
    `<div class="d-share-head">${
      closed
        ? link("Close", go("share-closed", { closed }), { variant: "quiet", attrs: "data-cancel data-close" })
        : link("Cancel", go("share-closed", { closed: null }), { variant: "quiet", attrs: "data-cancel" })
    }<h2 id="d-share-title" tabindex="-1" data-d-title>${title}</h2><span></span></div>${inner}</div>`;

  // The bot picker: a radio group of the listed bots; choosing sends nothing.
  const picker = (to, current) =>
    `<div role="radiogroup" aria-label="Send to" class="d-radios" data-radios data-pick-to="${to}">` +
    (noBots
      ? ""
      : Object.entries(BOTS)
          .map(
            ([id, name]) =>
              `<button type="button" class="d-to" role="radio" aria-checked="${id === current}" tabindex="${id === current || (!current && id === "juniper") ? 0 : -1}" data-to="${id}"><span class="avatar" data-bot="${id}"></span><span>${name}${id === "juniper" && params.get("nodefault") !== "1" ? ' <span class="d-to-label">The primary bot</span>' : ""}</span></button>`,
          )
          .join("")) +
    `</div>`;

  // The task the gateway returned: 4f2a…. It is the target for every retry of this handoff; no second task is made.
  const TASK_ID = "4f2a…";

  function shareSheet() {
    const bot = listedBot();
    const why = params.get("gw") === "none" ? "nogateway" : params.get("gone") === "1" ? "unlisted" : !canSend ? "no-write" : down ? "unreachable" : null;
    const sendTo = why ? go("share-cant", { why }) : params.get("lost") === "1" ? go("share-unsure") : go("share-sent", { said: `Sent to ${BOTS[bot]}` });
    return (
      other() +
      sheet(
        `<a class="d-to" href="${go("share-to")}" data-to-row data-keep-note><span class="d-to-label">To:</span>${bot ? `<span class="avatar" data-bot="${bot}"></span><span>${BOTS[bot]}</span>` : `<span data-to-empty>Choose a listed bot</span>`}${icon("chevron")}</a>` +
          `<ul class="d-chips" aria-label="What is shared">${chips()}</ul>` +
          `<textarea aria-label="Add a note" placeholder="Add a note" data-note>${esc(noteText())}</textarea>` +
          (bot ? `<p class="d-lead" data-preview>Send starts a new task with ${BOTS[bot]}, with ${items()}. Nothing is sent before.</p>` : `<p class="d-lead" data-preview>Choose a bot to send this to. Nothing is sent before.</p>`) +
          `<div class="d-actions">${bot ? act("Send", sendTo, { variant: "primary", size: "md", attrs: "data-share-send data-keep-note" }) : `<button type="button" class="button" data-variant="primary" data-size="md" disabled data-share-send>Send</button>`}</div>` +
          proto(
            link("The reply will be lost", go("share", { lost: "1" }), { attrs: "data-keep-note" }),
            link("The task is made, the message refused", go("share-msgfail"), { attrs: "data-keep-note" }),
            link("Only the task is confirmed", go("share-taskonly"), { attrs: "data-keep-note" }),
            link("No gateway saved", go("share", { gw: "none" }), { attrs: "data-keep-note" }),
            link("The bot is no longer listed", go("share", { gone: "1" }), { attrs: "data-keep-note" }),
          ),
      )
    );
  }

  // The returned task, with the exact first message and the supported items held there for retry, by the composer's rules.
  function heldTask(held) {
    const bot = toBot() || "juniper";
    return (
      `<div class="d-chat" data-task="${TASK_ID}">` +
      `<header class="d-chat-head"><span class="avatar" data-bot="${bot}"></span><b>${BOTS[bot]}</b><span>Task ${TASK_ID}</span></header>` +
      `<div class="d-chat-body" data-d-chat><p class="d-event">Shared from another app.</p>` +
      `<div class="d-composer" aria-label="First message" data-held>` +
      `<ul class="d-chips">${chips()}</ul><p data-held-text>${esc(noteText())}</p>` +
      (held === "refused"
        ? note("danger", "The gateway refused the message.", "It's kept here. Retry sends it to this task.") + `<div class="d-actions">${act("Retry", go("share-task", { held: "retried", said: `Sent to ${BOTS[bot]}` }), { variant: "primary", size: "sm", attrs: "data-retry-held" })}</div>`
        : held === "retried"
          ? `<p class="d-event">Sent to this task.</p>`
          : note("warn", "Clawtrate couldn't confirm the message.", "Clawtrate is checking it against this task before anything is sent again.")) +
      `</div></div></div>`
    );
  }

  Object.assign(SCREENS, {
    share: () => shareSheet(),
    "share-to": () =>
      other() +
      sheet(
        (noBots ? `<p class="d-lead">No bot is listed to send this to.</p>` : "") +
          picker("share", listedBot()) +
          `<div class="d-actions">${act("Done", go("share"), { variant: "primary", size: "md", attrs: "data-to-done" })}</div>`,
        "Send to",
      ),
    "share-sent": () => other() + sheet(`<p class="d-lead">The gateway accepted the first message in a new task.</p>`, `Sent to ${BOTS[toBot()]}`, "done"),
    // A created task whose first message was refused, or not confirmed: never "Sent", and never a second task.
    "share-msgfail": () =>
      other() +
      sheet(
        note("warn", `${BOTS[toBot()]}'s task was created. The gateway refused the message.`, "") +
          `<div class="d-actions">${link(`Open ${BOTS[toBot()]}'s task`, go("share-task", { held: "refused" }), { variant: "primary", size: "md", attrs: "data-open-task" })}</div>`,
        "Clawtrate",
        "done",
      ),
    "share-taskonly": () =>
      other() +
      sheet(
        note("warn", `${BOTS[toBot()]}'s task was created. Clawtrate couldn't confirm the message.`, "") +
          `<div class="d-actions">${link(`Open ${BOTS[toBot()]}'s task`, go("share-task", { held: "unconfirmed" }), { variant: "primary", size: "md", attrs: "data-open-task" })}</div>`,
        "Clawtrate",
        "unknown",
      ),
    "share-task": () => heldTask(params.get("held")),
    "share-cant": () => {
      const why = params.get("why");
      const words =
        why === "nogateway" ? "No gateway is saved in Clawtrate." : why === "unlisted" ? `${BOTS[toBot()] || "That bot"} is no longer listed.` : why === "no-write" ? "Sending needs write access to the gateway." : "Clawtrate couldn't reach the gateway before sending.";
      // No gateway, or the chosen bot no longer listed: the draft has no bot.
      const extra = why === "nogateway" || why === "unlisted" ? { nobot: "1" } : {};
      return (
        other() +
        sheet(note("warn", words, "Nothing was sent.") + `<div class="d-actions">${link("Open in Clawtrate", go("share-draft", extra), { variant: "primary", size: "md", attrs: "data-open-draft data-keep-note" })}</div>`)
      );
    },
    "share-unsure": () => {
      // Check again may submit the same operation only within four minutes, and only when the current
      // hello matches the saved address, credential context and nonempty boot ID.
      const outside = params.get("late") === "1" || ["changed", "missing"].includes(params.get("start")) || params.get("cred") === "changed";
      const bot = toBot();
      return (
        other() +
        sheet(
          outside
            ? note("warn", "Clawtrate still couldn't confirm it.", `Look in ${BOTS[bot]}'s tasks before sending again.`) +
                `<div class="d-actions">${link(`Open ${BOTS[bot]}`, `app.html?bot=${bot}`, { variant: "primary", size: "md", attrs: "data-open-bot" })}</div>`
            : note("warn", "Clawtrate couldn't confirm whether the gateway received this.", "Check again uses the original send.") +
                `<div class="d-actions">${act("Check again", go("share-sent", { lost: null, said: `Sent to ${BOTS[bot]}` }), { variant: "primary", size: "md", attrs: "data-check-again" })}</div>` +
                proto(
                  link("Four minutes pass", go("share-unsure", { late: "1" })),
                  link("A new gateway start", go("share-unsure", { start: "changed" })),
                  link("A hello with no boot ID", go("share-unsure", { start: "missing" })),
                  link("Other credentials", go("share-unsure", { cred: "changed" })),
                ),
          "Clawtrate",
          "unknown",
        )
      );
    },
    "share-draft": () => {
      const fromSiri = params.get("from") === "siri";
      const nobot = params.get("nobot") === "1";
      const bot = nobot ? null : listedBot();
      return (
        `<div class="d-chat">` +
        `<header class="d-chat-head">${bot ? `<span class="avatar" data-bot="${bot}"></span><b>${BOTS[bot]}</b>` : ""}<span>New task</span></header>` +
        `<div class="d-chat-body" data-d-chat>` +
        `<p class="d-event">${fromSiri ? "From Send Message" : "Shared from another app"}. Nothing has been sent.</p>` +
        // No destination: a bot picker before Send. Choosing selects; it sends nothing and keeps the note and items.
        (bot
          ? ""
          : noBots
            ? note("", "No bot is listed to send this to.", "The draft is kept here until a bot is listed.")
            : note("", "This draft has no bot yet.", "Choose one before sending.") + picker("share-draft", null)) +
        `<div class="d-composer" aria-label="Composer">` +
        (fromSiri ? "" : `<ul class="d-chips">${chips()}</ul>`) +
        `<textarea aria-label="Message" data-draft>${esc(fromSiri ? params.get("msg") || "Remind me to water the plants tonight." : noteText())}</textarea>` +
        (!canSend ? `<p class="d-lead" data-preview>Sending needs write access to the gateway.</p>` : bot && !fromSiri ? `<p class="d-lead" data-preview>Send starts a new task with ${BOTS[bot]}, with ${items()}.</p>` : "") +
        `<div class="d-actions"><button type="button" class="button" data-variant="primary" data-size="sm" data-draft-send${bot && canSend ? "" : " disabled"}>Send</button></div></div></div></div>`
      );
    },
    "share-closed": () => {
      const closed = params.get("closed");
      const words = closed === "unknown" ? "Closed. Clawtrate couldn't confirm whether it was sent." : closed === "done" ? "Closed." : "Nothing was sent.";
      return other() + `<p class="d-event" role="status" data-closed>${words}</p>`;
    },
  });

  // Siri and Shortcuts ----------------------------------------------------------

  const sys = (title, body, actions = "", after = "", caption = "Siri or Shortcuts (a stand-in for the phone's own panel)") =>
    `<div class="d-sys" role="dialog" aria-modal="true" aria-labelledby="d-sys-title" data-d-modal><p class="d-sys-caption">${caption}</p>` +
    `<h2 id="d-sys-title" tabindex="-1" data-d-title>${title}</h2>${body}${actions ? `<div class="d-actions">${actions}</div>` : ""}${after}</div>`;
  const msg = () => params.get("msg") || "Remind me to water the plants tonight.";
  // Every system panel can be dismissed: Close (Escape too), and Tab stays inside.
  const closeSys = () => link("Close", go("siri-closed", { closed: screenId === "siri-sent" ? "done" : null }), { size: "md", attrs: "data-cancel data-close" });
  const pendingProof = `<p class="d-proto"><span>Prototype:</span>Not a supported Send Message state until the confirmation is proven on a device.</p>`;

  Object.assign(SCREENS, {
    // The system's own unlock prompt, before any Clawtrate content: no bot name, message text, result or send.
    // action=list|send: unlocking returns to the action the person chose.
    "siri-locked": () => {
      const action = params.get("action") === "list" ? "list" : "send";
      return (
        other() +
        sys(
          "Locked",
          `<p data-unlock>The system asks for the iPhone to be unlocked. Clawtrate shows nothing until it is.</p>`,
          act("Cancel", go("siri-closed", { action: null }), { size: "md", attrs: "data-cancel" }),
          proto(link("Unlocked", go(action === "list" ? "siri-list" : "siri-confirm", { action: null }), { attrs: "data-unlocked" })),
          "The system's unlock prompt (a stand-in)",
        )
      );
    },
    "siri-list": () => other() + sys("Clawtrate", `<p>You have four bots: Juniper, Marlow, Otto and Pip.</p><ul><li>Juniper (the primary bot)</li><li>Marlow</li><li>Otto</li><li>Pip</li></ul>`, closeSys()),
    "siri-list-fail": () => other() + sys("Clawtrate", `<p>Clawtrate couldn't reach the gateway.</p>`, closeSys()),
    "siri-confirm": () =>
      other() +
      sys(
        `Send to ${BOTS[toBot()]}?`,
        `<blockquote data-exact>${esc(msg())}</blockquote>`,
        act("Cancel", go("siri-cancelled"), { size: "md", attrs: "data-cancel" }) + act("Open in Clawtrate to send it", go("share-draft", { from: "siri" }), { variant: "primary", size: "md", attrs: "data-siri-handoff" }),
        proto(link("Once the confirmation is proven on a device: Send", !canSend || down ? go("siri-fail") : go("siri-sent", { said: `Sent to ${BOTS[toBot()]}` }), { attrs: "data-siri-send" })),
      ),
    "siri-handoff": () => SCREENS["share-draft"](),
    // Not supported states until the confirmation is proven on a device: drawn for the build after that proof.
    "siri-sent": () => other() + sys("Clawtrate", `<p>Sent to ${BOTS[toBot()]}.</p>`, closeSys(), pendingProof),
    "siri-fail": () =>
      other() + sys("Clawtrate", `<p>Clawtrate couldn't send this: ${canSend ? "it couldn't reach the gateway" : "sending needs write access to the gateway"}.</p>`, link("Open in Clawtrate", go("share-draft", { from: "siri" }), { variant: "primary", size: "md" }) + closeSys(), pendingProof),
    "siri-cancelled": () => other() + sys("Clawtrate", `<p>Nothing was sent.</p>`, closeSys()),
    "siri-closed": () => other() + `<p class="d-event" role="status" data-closed>${params.get("closed") === "done" ? "Closed." : "Closed. Nothing was sent."}</p>`,
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
    const field = root.querySelector("[data-note], [data-draft]");
    if (!field) return url;
    const next = new URL(url, location.href);
    next.searchParams.set(params.get("from") === "siri" ? "msg" : "note", field.value);
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
      // Choosing a bot selects it and sends nothing; the note or draft goes along as edited.
      location.href = withNote(go(radio.closest("[data-pick-to]")?.dataset.pickTo || "share", { to: radio.dataset.to, nobot: null }));
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
      const done = root.querySelector("[data-to-done]");
      if (done) done.dataset.go = go("share", { to: r.dataset.to });
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

  // "Also remove this device's node pairing from the gateway" changes where Stop leads.
  const also = root.querySelector("[data-also-remove]");
  if (also) {
    const stop = root.querySelector("[data-stop]");
    const base = stop.dataset.go;
    also.addEventListener("change", () => {
      const next = new URL(base, location.href);
      // With the gateway unreachable the removal can't be confirmed, and the saved sign-in is kept.
      if (also.checked) next.searchParams.set("removed", down ? "unknown" : "1");
      else next.searchParams.delete("removed");
      if (also.checked && !down) next.searchParams.delete("saved");
      else next.searchParams.set("saved", "1");
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
