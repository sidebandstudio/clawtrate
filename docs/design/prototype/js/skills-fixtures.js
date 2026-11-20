// Fixtures for skills.html (docs/design/skills.md), loaded before app.js: one
// task of Juniper's whose transcript has the cards of a bot saving a skill
// (section 12), and the Details tab's hook for Skills in this task (section 9),
// which js/skills.js fills once it has loaded.

(function () {
  const CT = window.CT;
  const icon = (name, cls) => CT.icon(name, cls);
  const esc = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const turn = (role, html) => `<div class="turn" data-role="${role}" data-testid="transcript-turn">${html}</div>`;
  const bubble = (role, html) => `<div class="msg" data-role="${role}"><div class="bubble">${html}</div></div>`;

  // The skill the bot saves: the scripted model's #learn (research section 8).
  const SKILL = {
    slug: "trail-checklist",
    description: "Use when planning a weekend walk, to check the weather, the route and what to pack.",
    body: "1. Check the forecast for the day of the walk.\n2. Choose the route and note its length.\n3. Pack water, a map and a warm layer.",
  };
  CT.skillsLearned = SKILL;

  // One card of the action-card family (conversation.md section 7), in its words for skill_workshop.
  const card = ({ id, verb, object, state, tone, body }) =>
    `<details class="card action k-card" data-kind="skill" data-status="${tone === "danger" ? "failed" : "done"}" id="${id}" data-testid="tool-call">` +
    `<summary aria-label="${esc(`${verb} ${object}, ${state}`)}"><span class="action-sentence"><span class="action-verb">${esc(verb)}</span> ` +
    `<span class="action-what">${icon("list")}<span class="action-object">${esc(object)}</span></span></span>` +
    `<span class="action-detail"></span><span class="action-state"><span class="state"${tone ? ` data-tone="${tone}"` : ""}>${esc(state)}</span></span>${icon("chevron", "icon chevron")}</summary>` +
    `<div class="action-body">${body}</div></details>`;
  const readable = (rows, foot = "") =>
    `<dl class="facts k-card-facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>${foot}`;
  const text = (t) => `<pre class="k-plain">${esc(t)}</pre>`;

  const transcript =
    `<div class="stamp">Today 2:51 PM</div>` +
    turn("user", bubble("user", "That checklist worked well. Save this as a skill so you can do it the same way next time.")) +
    turn(
      "assistant",
      card({
        id: "k-card-saved",
        verb: "Saved a skill",
        object: SKILL.slug,
        state: "Saved to your skills",
        body: readable(
          [
            ["Name", `<span class="mono">${SKILL.slug}</span>`],
            ["Use when…", esc(SKILL.description)],
            ["Instructions", text(SKILL.body)],
          ],
          `<div class="b-actions" style="margin-top:10px"><button type="button" class="button" data-size="sm" data-k="card-open">Open in Skills</button></div>`,
        ),
      }) +
        `<div class="k-card-line" id="k-card-attach" role="status"><span>New tasks start with it. This task doesn't have it yet.</span><button type="button" class="button" data-size="sm" data-k="card-attach">Use in this task</button></div>` +
        bubble("assistant", "Saved trail-checklist to your skills."),
    ) +
    `<div class="stamp">Today 2:58 PM</div>` +
    turn("user", bubble("user", "Keep it as one of your own learned skills as well.")) +
    turn(
      "assistant",
      card({
        id: "k-card-refused",
        verb: "Couldn't save a skill",
        object: SKILL.slug,
        state: "Failed",
        tone: "danger",
        body: `<p class="k-card-says">The gateway answered:</p>${text('Validation failed for tool "skill_workshop":\n  - content: schema is false\n  - root: must not have additional properties')}` +
          `<p class="b-hint">From this connection the bot's tool saves only to your library.</p>`,
      }) + bubble("assistant", "The skill was not saved; the gateway's answer is shown above."),
    ) +
    `<div class="stamp">Today 3:04 PM, from an admin connection</div>` +
    turn("user", bubble("user", "Keep it as one of your own learned skills as well.")) +
    turn(
      "assistant",
      card({
        id: "k-card-learned",
        verb: "Learned a skill",
        object: SKILL.slug,
        state: "Learned",
        body: readable(
          [
            ["Name", `<span class="mono">${SKILL.slug}</span>`],
            ["Use when…", esc(SKILL.description)],
            ["The gateway said", esc(`Created "${SKILL.slug}" (created: ${SKILL.description}). Undo with action=archive name=${SKILL.slug}.`)],
          ],
          `<div class="b-actions" style="margin-top:10px"><button type="button" class="button" data-size="sm" data-k="card-learned">Open in Juniper's skills</button></div>`,
        ),
      }) + bubble("assistant", "Learned trail-checklist."),
    );

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
  };
})();
