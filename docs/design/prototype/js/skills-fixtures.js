// Fixtures for skills.html (docs/design/skills.md), loaded before app.js: one
// task of Juniper's whose transcript holds the bot's skill_workshop calls, each
// drawn as an action card from the call's arguments and the gateway's result
// alone (section 12), and the Details tab's hook for the skills a task has
// (section 9), which js/skills.js fills once it has loaded.

(function () {
  const CT = window.CT;
  const icon = (name, cls) => CT.icon(name, cls);
  const esc = (text) =>
    String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const turn = (role, html) => `<div class="turn" data-role="${role}" data-testid="transcript-turn">${html}</div>`;
  const bubble = (role, html) => `<div class="msg" data-role="${role}"><div class="bubble">${html}</div></div>`;

  // The skill the bot saves: the scripted model's #learn (research section 8). The
  // fourth line has angle brackets, which stay text everywhere they are shown.
  const SKILL = {
    slug: "trail-checklist",
    description: "Use when planning a weekend walk, to check the weather, the route and what to pack.",
    body: "1. Check the forecast for the day of the walk.\n2. Choose the route and note its length.\n3. Pack water, a map and a warm layer.\n4. Note anything marked <important> on the map.",
  };
  const SKILL_MD = `---\nname: ${SKILL.slug}\ndescription: ${SKILL.description}\n---\n\n${SKILL.body}\n`;
  CT.skillsLearned = SKILL;

  // A skill's parts, read back from the SKILL.md a call carried.
  const parts = (md) => {
    const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(String(md || ""));
    const head = m ? m[1] : "";
    return { name: /^name: (.*)$/m.exec(head)?.[1] || "", description: /^description: (.*)$/m.exec(head)?.[1] || "", body: m ? m[2].replace(/\n$/, "") : String(md || "") };
  };

  // A revision is a hash of the whole SKILL.md and its files' paths, as on the gateway
  // (research section 3); skills.js uses the same function for the library's revisions.
  const hash = (text) => {
    let out = "";
    for (let seed = 0; out.length < 64; seed += 1) {
      let h = 0x811c9dc5 ^ seed;
      for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
      out += h.toString(16).padStart(8, "0");
    }
    return out.slice(0, 64);
  };
  CT.skillsFixtureHash = hash;

  // The calls, as the agent stream and the history hold them: arguments, the
  // gateway's result, and whether it is an error.
  const RECEIPT = {
    state: "published",
    target: "personal",
    entry: { skillId: "cd9e6020-db2d-47a9-8065-9a169d30d18e", slug: SKILL.slug, name: "s_trail_che_cd9e6020db2d47a98065", ownerProfileId: "gateway-owner", revision: hash(SKILL_MD + "[]"), shared: false, enabled: true },
    sessionActivation: "new-sessions",
  };
  const CALLS = [
    { id: "k-card-saved", args: { action: "create", name: SKILL.slug, proposal_content: SKILL_MD }, result: JSON.stringify(RECEIPT, null, 2), isError: false },
    { id: "k-card-listed", args: { action: "list" }, result: JSON.stringify({ entries: [{ slug: SKILL.slug, revision: RECEIPT.entry.revision }], omitted: 0 }, null, 2), isError: false },
    { id: "k-card-shared", args: { action: "share", skill_id: RECEIPT.entry.skillId, expected_revision: RECEIPT.entry.revision }, result: JSON.stringify({ ...RECEIPT, entry: { ...RECEIPT.entry, shared: true } }, null, 2), isError: false },
    { id: "k-card-refused", args: { action: "create", name: SKILL.slug, content: SKILL_MD }, result: 'Validation failed for tool "skill_workshop":\n  - content: schema is false\n  - root: must not have additional properties', isError: true },
    { id: "k-card-learned", args: { action: "create", name: SKILL.slug, content: SKILL_MD }, result: `Created "${SKILL.slug}" (created: ${SKILL.description}). Undo with action=archive name=${SKILL.slug}.`, isError: false },
  ];
  CT.skillsCalls = CALLS;

  // What a card says, from the call and its result only (section 12).
  const json = (t) => {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  };
  // Which actions only look, and which act on an entry without saving its text.
  const LOOK = ["list", "read", "view"];
  const ACT = ["share", "unshare", "remove", "archive", "restore"];
  const mono = (v) => `<span class="mono">${esc(v)}</span>`;
  // `viewer` is the library list's profileId, once skills.js has read it; until then a
  // personal receipt's owner isn't established as the person viewing.
  function cardOf(c, viewer) {
    const a = c.args.action;
    const r = json(c.result);
    const submitted = c.args.proposal_content ?? c.args.content;
    const skill = submitted ? parts(submitted) : null;
    const entry = r?.entry;
    const object = c.args.name || entry?.slug || r?.slug || "";
    // Pending, or a result this adapter doesn't know: the conversation's general card (conversation.md 8.3).
    if (c.result == null) return { verb: "Using skill workshop", object, state: "Running", rows: [], says: null };
    if (c.isError) return { verb: LOOK.includes(a) ? "Couldn't look at skills" : ACT.includes(a) ? "Skill action failed" : "Couldn't save a skill", object, state: "Failed", tone: "danger", rows: [], says: c.result };
    if (a === "list" && Array.isArray(r?.entries)) {
      const n = r.entries.length;
      return { verb: "Looked at skills", object: `Listed ${n} ${n === 1 ? "skill" : "skills"}.${r.omitted > 0 ? ` ${r.omitted} omitted.` : ""}`, state: "Done", rows: [], says: null };
    }
    if ((a === "read" && r?.revision) || a === "view") return { verb: "Looked at skills", object, state: "Done", rows: [], says: null };
    const recorded = (words) => ["The tool's recorded result", words];
    const revRow = entry?.revision ? [["Result revision", mono(entry.revision.slice(0, 12))]] : [];
    if (entry && a === "share" && r.state === "published" && entry.shared === true) return { verb: "Shared a skill", object, state: "Shared", rows: [recorded("Shared on this gateway"), ...revRow], says: null };
    if (entry && a === "unshare" && r.state === "published" && entry.shared === false) return { verb: "Stopped sharing a skill", object, state: "Not shared", rows: [recorded("Not shared"), ...revRow], says: null };
    if (entry && a === "remove" && r.state === "removed") return { verb: "Removed a skill", object, state: "Removed", rows: [recorded("Removed from the library"), ...revRow], says: null };
    if (entry && (a === "create" || a === "update") && (r.state === "published" || r.state === "unchanged")) {
      const verb = r.state === "unchanged" ? "Skill unchanged" : a === "create" ? "Saved a skill" : "Updated a skill";
      const where = r.state === "unchanged" ? "Unchanged" : r.target === "team" ? "Saved to the team library" : viewer != null && entry.ownerProfileId === viewer ? "Saved to your library" : "Saved to a personal library";
      const rows = [["Name", mono(object)]];
      // Only what the arguments actually carried: an update can leave the text out.
      if (skill) rows.push(["Use when…", esc(skill.description)], ["Submitted instructions", `<pre class="k-plain">${esc(skill.body)}</pre>`]);
      return { verb, object, state: where, rows: [...rows, ...revRow], says: null, library: r.state === "published", skillId: entry.skillId, rev: entry.revision };
    }
    if (/^Created "/.test(c.result)) return { verb: "Learned a skill", object, state: "Learned", rows: [["Name", mono(skill?.name)], ["Use when…", esc(skill?.description)], ["Submitted instructions", `<pre class="k-plain">${esc(skill?.body)}</pre>`]], says: c.result, learned: true };
    return { verb: "Used skill workshop", object, state: "Done", rows: [], says: null };
  }
  CT.skillsCardOf = cardOf;
  CT.skillsParts = parts;

  const raw = (c) =>
    `<details class="k-raw"><summary>Raw</summary><p class="b-hint">This stands for the action card's Raw tab in the conversation.</p><p class="k-label">Arguments</p><pre class="k-plain">${esc(JSON.stringify(c.args, null, 2))}</pre>` +
    `<p class="k-label">${c.isError ? "Error" : "Result"}</p><pre class="k-plain">${esc(c.result)}</pre></details>`;
  function card(c) {
    const k = cardOf(c);
    const body =
      (k.rows.length ? `<dl class="facts k-card-facts">${k.rows.map(([a, b]) => `<div><dt>${a}</dt><dd>${b}</dd></div>`).join("")}</dl>` : "") +
      (k.says ? `<p class="k-card-says">The gateway answered:</p><pre class="k-plain">${esc(k.says)}</pre>` : "") +
      (k.library ? `<div class="b-actions" style="margin-top:10px"><button type="button" class="button" data-size="sm" data-k="card-open">Open in Skills</button></div>` : "") +
      (k.learned ? `<div class="b-actions" style="margin-top:10px"><button type="button" class="button" data-size="sm" data-k="card-learned">Open in Juniper's skills</button></div>` : "") +
      raw(c);
    return (
      `<details class="card action k-card" data-kind="skill" data-status="${k.tone === "danger" ? "failed" : "done"}" id="${c.id}" data-testid="tool-call">` +
      `<summary aria-label="${esc(`${k.verb} ${k.object}, ${k.state}`)}"><span class="action-sentence"><span class="action-verb">${esc(k.verb)}</span> ` +
      `<span class="action-what">${icon("list")}<span class="action-object">${esc(k.object)}</span></span></span>` +
      `<span class="action-detail"></span><span class="action-state"><span class="state"${k.tone ? ` data-tone="${k.tone}"` : ""}>${esc(k.state)}</span></span>${icon("chevron", "icon chevron")}</summary>` +
      `<div class="action-body">${body}</div></details>` +
      // The line under a library save: skills.js fills it once it has read this task's skills.
      (k.library ? `<div class="k-card-line" id="k-card-attach" data-k-card="${c.id}" data-k-skill-id="${esc(k.skillId)}" data-k-rev="${esc(k.rev)}" role="status"><span>Reading this task's skills…</span></div>` : "")
    );
  }
  const at = (id) => CALLS.find((c) => c.id === id);

  const transcript =
    `<div class="stamp">Today 2:51 PM</div>` +
    turn("user", bubble("user", "That checklist worked well. Save this as a skill so you can do it the same way next time.")) +
    turn("assistant", card(at("k-card-saved")) + bubble("assistant", "Saved trail-checklist to your skills.")) +
    `<div class="stamp">Today 2:54 PM</div>` +
    turn("user", bubble("user", "Which skills do I have? Share the checklist with the others on this gateway.")) +
    turn("assistant", card(at("k-card-listed")) + card(at("k-card-shared")) + bubble("assistant", "You have one skill, and it is shared now.")) +
    `<div class="stamp">Today 2:58 PM</div>` +
    turn("user", bubble("user", "Keep it as one of your own learned skills as well.")) +
    turn("assistant", card(at("k-card-refused")) + bubble("assistant", "The skill was not saved; the gateway's answer is shown above.")) +
    `<div class="stamp">Today 3:04 PM</div>` +
    turn("user", bubble("user", "Keep it as one of your own learned skills as well.")) +
    turn("assistant", card(at("k-card-learned")) + bubble("assistant", "Learned trail-checklist."));

  CT.appExtension = {
    fixtures(bots, task) {
      const juniper = bots.find((b) => b.id === "juniper");
      juniper?.tasks.unshift(task("jlearn", "Weekend walk checklist", 1050, "3:04 PM", "Learned trail-checklist.", { html: transcript }));
    },
    panel(b) {
      document.querySelector("#files-empty").textContent = `Files ${b.name} reads or writes in this task appear here.`;
      document.querySelector("#computer-empty").textContent = `When ${b.name} uses a browser or a desktop, you can watch it here.`;
      CT.skillsTaskSection?.();
    },
    header() {
      setTimeout(() => CT.skillsCards?.(), 0);
    },
  };
})();
