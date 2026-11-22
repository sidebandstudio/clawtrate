// The avatar studio (docs/design/avatar-studio.md): building a Claw with a
// live preview that follows the bot's name, accessories, Surprise me, the
// Custom row, a simulated "Describe a Claw", New bot through Create, Edit
// picture through Save, and a bot proposing its own picture in chat.
// Not product code. Creatures come from creatures.js (the shared spec's copy),
// their accessories and the name's Claw from accessories.js (the proposed
// addition), and the saved picture from avatar-picture.js.

(function () {
  const C = window.ClawtrateCreatures;
  const A = window.ClawtrateAccessories;
  const P = window.ClawtratePicture;
  const CT = window.CT;
  const params = new URLSearchParams(location.search);
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const reduced = () => document.documentElement.dataset.motion === "reduce";
  // Icons this page adds to the set in icons.js, on the same 16 px grid and stroke.
  const LOCAL_ICONS = {
    dice: '<rect x="2.75" y="2.75" width="10.5" height="10.5" rx="2.75"/><path d="M5.6 5.6h.01M8 8h.01M10.4 10.4h.01M10.4 5.6h.01M5.6 10.4h.01"/>',
    undo: '<path d="M5.5 4 3 6.5 5.5 9"/><path d="M3.5 6.5h6a3.25 3.25 0 0 1 0 6.5H7"/>',
  };
  const icon = (name) =>
    LOCAL_ICONS[name] ? `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">${LOCAL_ICONS[name]}</svg>` : CT.icon(name);

  // Timings ---------------------------------------------------------------------------

  /** The name's Claw: how long typing pauses before the Claw changes, and before it settles. */
  const NAME_DEBOUNCE_MS = 250;
  const NAME_SETTLE_MS = 900;
  const SWAP_MS = 320;

  // Drawing ---------------------------------------------------------------------------

  const MOTIONS = { ...C.AVATAR_MOTIONS, ...A.ACCESSORY_MOTIONS };
  const keyframes = Object.entries(MOTIONS)
    .map(([name, motion]) => {
      const frames = motion.frames.map((f) => {
        const rules = [];
        if (f.translate) rules.push(`translate: ${f.translate[0]}px ${f.translate[1]}px`);
        if (f.rotate !== undefined) rules.push(`rotate: ${f.rotate}deg`);
        if (f.scale !== undefined) rules.push(`scale: ${f.scale}`);
        if (f.opacity !== undefined) rules.push(`opacity: ${f.opacity}`);
        if (f.dash) rules.push(`stroke-dasharray: ${f.dash[0]} ${f.dash[1]}`);
        if (f.dashOffset !== undefined) rules.push(`stroke-dashoffset: ${f.dashOffset}`);
        return `${Math.round(f.at * 1000) / 10}%{${rules.join(";")}}`;
      });
      return `@keyframes av-${name}{${frames.join("")}}`;
    })
    .join("\n");
  const style = document.createElement("style");
  style.textContent = keyframes;
  document.head.append(style);

  let clips = 0;
  function shape(s, clip) {
    const attrs = [];
    const css = [];
    if (s.origin) css.push("transform-box:view-box", `transform-origin:${s.origin[0]}px ${s.origin[1]}px`);
    if (s.rotate) css.push(`rotate:${s.rotate}deg`);
    if (s.motion) {
      const m = MOTIONS[s.motion];
      css.push(`animation:av-${s.motion} ${m.duration}ms cubic-bezier(${m.easing.join(",")}) ${s.delay || 0}ms infinite`);
    }
    if (s.still !== undefined) css.push(`--av-still:${s.still}deg`);
    const cls = [s.fine && "av-fine", s.still !== undefined && "av-still"].filter(Boolean).join(" ");
    if (cls) attrs.push(`class="${cls}"`);
    if (css.length) attrs.push(`style="${css.join(";")}"`);
    if (s.part) attrs.push(`data-part="${s.part}"`);
    if (s.fill) attrs.push(`fill="${s.fill}"`);
    if (s.stroke) attrs.push(`stroke="${s.stroke}"`);
    if (s.strokeWidth !== undefined) attrs.push(`stroke-width="${s.strokeWidth}"`);
    if (s.round) attrs.push('stroke-linecap="round" stroke-linejoin="round"');
    if (s.opacity !== undefined) attrs.push(`opacity="${s.opacity}"`);
    if (s.dash) attrs.push(`pathLength="100" stroke-dasharray="${s.dash[0]} ${s.dash[1]}"`);
    if (s.fixedStroke) attrs.push('vector-effect="non-scaling-stroke"');
    if (s.transform) attrs.push(`transform="${s.transform}"`);
    if (s.clip) attrs.push(`clip-path="url(#${clip}-${s.clip})"`);
    const a = attrs.join(" ");
    switch (s.kind) {
      case "path":
        return `<path ${a} d="${s.d}"/>`;
      case "circle":
        return `<circle ${a} cx="${s.cx}" cy="${s.cy}" r="${s.r}"/>`;
      case "ellipse":
        return `<ellipse ${a} cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}"/>`;
      case "rect":
        return `<rect ${a} x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}"${s.rx !== undefined ? ` rx="${s.rx}"` : ""}/>`;
      default:
        return `<g ${a}>${s.children.map((child) => shape(child, clip)).join("")}</g>`;
    }
  }

  /** A creature wearing its accessories, as inline SVG on the 40-unit grid. */
  function creature(choice, state = "idle", id = "studio", extra = "") {
    const scene = A.accessorize(C.avatarScene(choice, state, C.avatarVariation(id)), choice);
    const clip = `as${++clips}`;
    const defs = Object.entries(C.AVATAR_EYE_CLIP)
      .map(([name, r]) => `<clipPath id="${clip}-${name}"><circle r="${r}"/></clipPath>`)
      .join("");
    return (
      `<svg viewBox="0 0 40 40" class="creature" data-family="${choice.family}" data-state="${state}"` +
      `${scene.muted ? " data-muted" : ""}${extra} aria-hidden="true"><defs>${defs}</defs>${shape(scene.root, clip)}</svg>`
    );
  }

  const avatar = (choice, state, size, id) =>
    `<span class="avatar" style="width:${size}px;height:${size}px">${creature(choice, state, id)}</span>`;

  /** The app's Presence wrapper: the avatar, the ring while working, and the badge for the states that carry one. */
  function presence(choice, state, size, id) {
    // The badge is components.js's glyph, which this page doesn't load: the same markup, styled by app.css.
    const badge = ["waiting", "blocked"].includes(state) ? `<span class="glyph" data-state="${state}" aria-hidden="true"></span>` : "";
    return `<span class="presence" data-state="${state}" style="--size:${size}px">${avatar(choice, state, size, id)}${badge}</span>`;
  }

  /** The saved still at 128 px: the same scene, sockets and fit as the live Claw, tagged. */
  const savedPicture = (choice) => P.stillPicture(creature(choice, "idle", "save"), choice);

  /**
   * A stand-in for a raster picture: the creature drawn small and enlarged
   * without smoothing, so it reads as a made picture, not the live creature.
   * Clawtrate's own art; no model makes it here.
   */
  function pixelPicture(choice, background) {
    return new Promise((resolve) => {
      const svg = creature(choice, "idle", "pixel").replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" ');
      const img = new Image();
      img.onload = () => {
        const small = document.createElement("canvas");
        small.width = 28;
        small.height = 28;
        const s = small.getContext("2d");
        s.fillStyle = background;
        s.fillRect(0, 0, 28, 28);
        s.drawImage(img, 1, 2, 26, 26);
        const big = document.createElement("canvas");
        big.width = 128;
        big.height = 128;
        const b = big.getContext("2d");
        b.imageSmoothingEnabled = false;
        b.drawImage(small, 0, 0, 128, 128);
        resolve(big.toDataURL("image/png"));
      };
      img.onerror = () => resolve(null);
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
  }

  // Words -----------------------------------------------------------------------------

  const FAMILY_WORDS = { clawling: "Clawlings", shellfolk: "Shellfolk", lantern: "Lanterns" };
  const ONE_FAMILY = { clawling: "Clawling", shellfolk: "Shellfolk", lantern: "Lantern" };
  const PART_WORDS = { body: "Body", eyes: "Eyes", claws: "Claws", shell: "Shell", lure: "Lure" };
  const VALUE_WORDS = {
    dome: "Dome", tall: "Tall", wide: "Wide", round: "Round", pair: "Two eyes", splayed: "Splayed eyes",
    short: "Short stalks", single: "One eye", even: "Even claws", fiddler: "Fiddler claw", big: "Big claws",
    spiral: "Spiral", turret: "Turret", spotted: "Spotted", bell: "Bell", oval: "Oval", box: "Box", hook: "Hook",
    flick: "Flick", wave: "Wave", reach: "Reach", two: "Two eyes", one: "One eye",
  };
  const COLOR_WORDS = { green: "Green", blue: "Blue", orchid: "Orchid", violet: "Violet", yellow: "Yellow", pink: "Pink", sky: "Sky", lime: "Lime" };
  const WEAR_WORDS = {
    beanie: "Beanie", beret: "Beret", party: "Party hat", crown: "Crown", headphones: "Headphones",
    glasses: "Round glasses", shades: "Sunglasses", bowtie: "Bow tie",
  };
  const WEAR_SHORT = {
    beanie: "a beanie", beret: "a beret", party: "a party hat", crown: "a crown", headphones: "headphones",
    glasses: "round glasses", shades: "sunglasses", bowtie: "a bow tie",
  };
  const SLOT_WORDS = { head: "On its head", face: "Over its eyes", neck: "Round its neck" };
  const STATE_WORDS = { idle: "Idle", thinking: "Thinking", working: "Working", waiting: "Waiting for you", blocked: "Blocked", done: "Done" };

  const listWords = (items) =>
    items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

  /** What the preview is called: plain words, for a screen reader. The crown is gold whatever the trim. */
  function describe(choice) {
    const parts = Object.keys(C.AVATAR_PARTS[choice.family]).map((key) => VALUE_WORDS[choice[key]].toLowerCase());
    const others = A.SLOTS.filter((s) => choice[s] && choice[s] !== "crown").map((s) => WEAR_SHORT[choice[s]]);
    let text = `${COLOR_WORDS[choice.color]} ${ONE_FAMILY[choice.family]}: ${parts.join(", ")}`;
    const trim = COLOR_WORDS[A.trimName(choice)].toLowerCase();
    if (choice.head === "crown") text += `, wearing a gold crown${others.length ? ` and ${listWords(others)} in ${trim}` : ""}`;
    else if (others.length) text += `, wearing ${listWords(others)} in ${trim}`;
    return text;
  }

  // Fixtures --------------------------------------------------------------------------

  const STARTERS = [
    { family: "clawling", body: "round", eyes: "single", claws: "even", color: "violet", head: "beret", face: "glasses", neck: "bowtie", trim: "sky" },
    { family: "lantern", body: "round", lure: "hook", eyes: "two", color: "sky", head: "headphones", trim: "violet" },
    { family: "shellfolk", shell: "spiral", color: "pink", head: "crown" },
    { family: "clawling", body: "dome", eyes: "pair", claws: "even", color: "yellow", head: "party", trim: "blue" },
    { family: "lantern", body: "box", lure: "flick", eyes: "one", color: "lime", face: "shades", trim: "blue" },
    { family: "shellfolk", shell: "dome", color: "orchid", head: "beanie", trim: "lime" },
    { family: "clawling", body: "wide", eyes: "short", claws: "big", color: "blue", neck: "bowtie", trim: "yellow" },
    { family: "lantern", body: "bell", lure: "wave", eyes: "two", color: "green", face: "glasses", trim: "pink" },
  ].map((s) => A.tidy(s));

  const MAIN_BOT = "Atlas";
  const ROUTE = "anthropic/claude-sonnet-5.5";
  const EDIT_BOT = { name: "Juniper", choice: { family: "clawling", body: "tall", eyes: "splayed", claws: "fiddler", color: "green" } };
  const MAX_CUSTOM = 12;

  /** The fields given in the address, over the family's first choice. */
  function choiceFromParams() {
    const family = params.get("family");
    if (!family && !params.get("head") && !params.get("face") && !params.get("neck")) return null;
    const start = A.STARTER();
    const base = { ...(family ? C.firstChoice(family, params.get("color") || start.color) : start) };
    for (const key of ["body", "eyes", "claws", "shell", "lure", "color", "head", "face", "neck", "trim"]) {
      const value = params.get(key);
      if (value) base[key] = value;
    }
    return A.tidy(base);
  }

  // State -----------------------------------------------------------------------------

  const mode = params.get("mode") === "edit" ? "edit" : "new";
  const given = choiceFromParams();
  const S = {
    view: params.get("view") || "studio",
    mode,
    open: true,
    step: "build", // New bot: build, then account
    name: params.get("name") || "",
    nameError: false,
    // New bot: the Claw follows the name until the person picks something by hand.
    source: mode === "new" && !given ? "name" : "manual",
    choice: given || (mode === "edit" ? EDIT_BOT.choice : A.nameChoice(params.get("name") || "")),
    saved: mode === "edit" ? EDIT_BOT.choice : null,
    picture: null, // { url, kind: "upload" | "picture", label }
    tab: params.get("tab") || "creature",
    state: params.get("state") || "idle",
    playing: false,
    typing: false,
    swap: null,
    undo: null,
    custom: [],
    selectedCustom: null,
    uploading: 0,
    saving: false,
    saveError: false,
    done: null, // after Create or Save: what was written and what reads back
    describe: {
      phase: params.get("describe") ? "typing" : "idle",
      text: params.get("words") || "",
      ideas: [],
      pick: 0,
      guard: false,
      attempt: 0,
    },
    chat: params.get("chat") || "proposed",
  };
  const asker = () => (S.mode === "edit" ? EDIT_BOT.name : MAIN_BOT);
  const unavailable = params.get("describe") === "unavailable";

  let beatTimer = null;
  let playTimer = null;
  let describeTimer = null;
  let slowTimer = null;
  let nameTimer = null;
  let settleTimer = null;
  let swapTimer = null;
  let uploadToken = 0;

  // The announcer: one polite live region, outside everything that redraws.

  function announce(text) {
    const live = $("#as-live");
    if (!live) return;
    live.textContent = "";
    setTimeout(() => (live.textContent = text), 30);
  }

  // Choosing --------------------------------------------------------------------------

  /** Everything Undo surprise puts back: the Claw, whether it followed the name, and a chosen picture. */
  const snapshot = () => ({ choice: S.choice, source: S.source, picture: S.picture, selectedCustom: S.selectedCustom });

  /** A choice made by hand. In New bot it takes the Claw off the name. */
  function setChoice(next, words) {
    const parsed = A.tidy(next);
    if (!parsed) return;
    S.choice = parsed;
    S.picture = null;
    S.selectedCustom = null;
    if (S.mode === "new") S.source = "manual";
    if (words) announce(words);
    beat();
    render();
  }

  /** The small happy beat: the done pose for a moment, never with motion reduced or while states play. */
  function beat() {
    if (reduced() || S.playing) return;
    clearTimeout(beatTimer);
    S.state = "done";
    beatTimer = setTimeout(() => {
      S.state = "idle";
      renderPreview();
    }, 1100);
  }

  const withPart = (key, value) => ({ ...S.choice, [key]: value });

  function family(next) {
    if (next === S.choice.family) return S.choice;
    const worn = {};
    for (const slot of A.SLOTS) if (S.choice[slot]) worn[slot] = S.choice[slot];
    if (S.choice.trim) worn.trim = S.choice.trim;
    return { ...C.firstChoice(next, S.choice.color), ...worn };
  }

  const pickFrom = (list) => list[Math.floor(Math.random() * list.length)];

  function surprise() {
    const before = snapshot();
    let next;
    do {
      const fam = pickFrom(C.AVATAR_FAMILIES);
      next = { family: fam, color: pickFrom(C.AVATAR_COLOR_NAMES) };
      for (const [key, values] of Object.entries(C.AVATAR_PARTS[fam])) next[key] = pickFrom(values);
      // Most surprises wear something; a few wear two things.
      const roll = Math.random();
      const slots = roll < 0.2 ? [] : roll < 0.75 ? [pickFrom(A.SLOTS)] : [...A.SLOTS].sort(() => Math.random() - 0.5).slice(0, 2);
      for (const slot of slots) next[slot] = pickFrom(A.AVATAR_ACCESSORIES[slot]);
      if (slots.length) next.trim = pickFrom(C.AVATAR_COLOR_NAMES.filter((c) => c !== next.color));
      next = A.tidy(next);
    } while (A.encodeChoice(next) === A.encodeChoice(S.choice));
    S.undo = before;
    setChoice(next, `Surprise: ${describe(next)}`);
  }

  // The name's Claw -----------------------------------------------------------------------

  /** Typing: the Claw looks up at the name while it waits; after a pause it becomes the name's Claw. */
  function nameTyped(value) {
    S.name = value;
    if (S.nameError && value.trim()) {
      S.nameError = false;
      renderNameNote();
    }
    if (S.source !== "name") return;
    renderNameNote();
    clearTimeout(nameTimer);
    clearTimeout(settleTimer);
    if (!reduced() && !S.playing) {
      clearTimeout(beatTimer);
      S.typing = true;
      S.state = "waiting";
      renderPreview();
    }
    nameTimer = setTimeout(followName, NAME_DEBOUNCE_MS);
    settleTimer = setTimeout(() => {
      S.typing = false;
      if (!S.playing) S.state = "idle";
      renderPreview();
      if (S.source === "name") announce(`${S.name.trim() ? "From the name" : "The starter"}: ${describe(S.choice)}`);
    }, NAME_SETTLE_MS);
  }

  /** The Claw becomes the name's, with a pop between families or a quick morph within one. */
  function followName() {
    const next = A.nameChoice(S.name);
    if (A.encodeChoice(next) === A.encodeChoice(S.choice) && !S.picture) return;
    swapTo(next);
    S.choice = next;
    S.picture = null;
    S.selectedCustom = null;
    renderPreview();
    renderNameNote();
    renderPanel();
    renderFoot();
  }

  function swapTo(next) {
    if (reduced()) return;
    const box = $("#as-preview svg");
    S.swap = { from: box ? box.outerHTML : "", kind: next.family === S.choice.family && !S.picture ? "morph" : "pop" };
    clearTimeout(swapTimer);
    swapTimer = setTimeout(() => {
      S.swap = null;
      $("#as-preview .as-swap-out")?.remove();
      $("#as-preview svg[data-swap]")?.removeAttribute("data-swap");
    }, SWAP_MS);
  }

  /** "Match my name": the Claw goes back to following the name. */
  function matchName() {
    S.source = "name";
    S.undo = null;
    const next = A.nameChoice(S.name);
    swapTo(next);
    S.choice = next;
    S.picture = null;
    S.selectedCustom = null;
    render();
    announce(`Matches the name again: ${describe(next)}`);
    $("#as-name")?.focus();
  }

  // Playing the states --------------------------------------------------------------------

  function playStates() {
    if (S.playing) return stopStates();
    clearTimeout(beatTimer);
    S.playing = true;
    let i = 0;
    const step = () => {
      S.state = C.AVATAR_STATES[i];
      renderPreview();
      announce(STATE_WORDS[S.state]);
      i += 1;
      if (i > C.AVATAR_STATES.length) return stopStates();
      playTimer = setTimeout(step, 1600);
    };
    step();
  }

  function stopStates() {
    clearTimeout(playTimer);
    S.playing = false;
    S.state = "idle";
    renderPreview();
  }

  // Describe a Claw, simulated ---------------------------------------------------------

  // The words a description is read for. In the product the gateway's
  // tool-free route sends it to the model, which answers with JSON; here a
  // small table writes that JSON, so the flow and the reply's checks can be
  // walked with no model. It never leaves the page.
  const CUES = [
    [/jazz|music|record|dj|song|playlist|headphone|beats?/, { head: "headphones" }],
    [/king|queen|royal|crown|regal|boss/, { head: "crown" }],
    [/party|birthday|celebrat|fun/, { head: "party" }],
    [/winter|cold|cosy|cozy|knit|snow/, { head: "beanie" }],
    [/paris|artist|paint|french|poet/, { head: "beret" }],
    [/read|book|study|professor|smart|nerd|scholar/, { face: "glasses" }],
    [/cool|sun|beach|summer|chill/, { face: "shades" }],
    [/fancy|dapper|formal|smart|butler|gentle/, { neck: "bowtie" }],
    [/snail|shell|shy|slow|home/, { family: "shellfolk" }],
    [/lantern|glow|light|night|deep|sea|fish|lamp/, { family: "lantern" }],
    [/claw|crab|pinch|grab|busy|builder/, { family: "clawling" }],
    [/sleep|tired|lazy|calm/, { eyes: "short" }],
    [/one eye|cyclops|single/, { eyes: "single" }],
    [/green|leaf|plant|forest/, { color: "green" }],
    [/blue|ocean|water/, { color: "blue" }],
    [/purple|violet|lavender/, { color: "violet" }],
    [/orchid|flower|magenta/, { color: "orchid" }],
    [/yellow|gold|sunny|honey/, { color: "yellow" }],
    [/pink|rose|candy/, { color: "pink" }],
    [/sky|cloud|air/, { color: "sky" }],
    [/lime|citrus|zest/, { color: "lime" }],
  ];
  /** Asking for a red or orange Claw: Clawtrate's own note, from the words, never from the model. */
  const GUARD_WORDS = /\b(red|orange|scarlet|crimson|lobster|crab)\b/;

  function readWords(text) {
    const t = text.toLowerCase();
    const found = {};
    for (const [re, give] of CUES) if (re.test(t)) Object.assign(found, give);
    return found;
  }

  function ideasFor(text) {
    const cue = readWords(text);
    const fams = cue.family ? [cue.family, ...C.AVATAR_FAMILIES.filter((f) => f !== cue.family)] : ["lantern", "clawling", "shellfolk"];
    const color = cue.color || (GUARD_WORDS.test(text.toLowerCase()) ? "pink" : "sky");
    const worn = {};
    for (const slot of A.SLOTS) if (cue[slot]) worn[slot] = cue[slot];
    if (!Object.keys(worn).length) worn.head = "beanie";
    const trims = C.AVATAR_COLOR_NAMES.filter((c) => c !== color);
    return fams.map((fam, i) => {
      const base = C.firstChoice(fam, i === 2 ? C.AVATAR_COLOR_NAMES[(C.AVATAR_COLOR_NAMES.indexOf(color) + 3) % 8] : color);
      Object.entries(C.AVATAR_PARTS[fam]).forEach(([key, values], j) => (base[key] = values[(i + j) % values.length]));
      if (fam === "clawling" && cue.eyes) base.eyes = cue.eyes;
      return { ...base, ...worn, trim: trims[(i * 3 + 1) % trims.length] };
    });
  }

  /**
   * The simulated model's reply, as text: what the boundary in accessories.js
   * reads. "fail" never gives a usable reply; "prose" wraps the first reply in
   * words, so the one retry is used; "twice" repeats an idea, which collapses.
   * The third idea writes its empty slots as null and "none", as models do.
   */
  function simulatedReply(text, attempt) {
    const t = text.toLowerCase();
    if (/fail|nothing/.test(t)) return attempt === 0 ? "Sure! Here's a lovely Claw for you." : '{"ideas":[{"family":"lobster","color":"red"}]}';
    const ideas = ideasFor(text);
    if (/twice|same/.test(t)) ideas[1] = { ...ideas[0] };
    ideas[2] = { ...ideas[2], face: ideas[2].face ?? null, neck: ideas[2].neck ?? "none" };
    const json = JSON.stringify({ ideas });
    return /prose/.test(t) && attempt === 0 ? `Here are three ideas: ${json}` : json;
  }

  function startDescribe() {
    const text = S.describe.text.trim();
    if (!text) {
      announce("Write a few words first");
      return;
    }
    const fromField = !!document.activeElement?.closest?.("#as-describe");
    S.describe.phase = "waiting";
    S.describe.slow = false;
    S.describe.attempt = 0;
    render();
    // The control that was pressed is gone: focus goes to Cancel once.
    if (fromField) $('[data-act="describe-cancel"]')?.focus();
    announce(`${asker()} is imagining it`);
    clearTimeout(describeTimer);
    clearTimeout(slowTimer);
    const slow = /slow|long/.test(text.toLowerCase());
    if (slow)
      slowTimer = setTimeout(() => {
        S.describe.slow = true;
        renderPanel();
      }, 2200);
    describeTimer = setTimeout(() => replied(text), slow ? 4200 : 1800);
  }

  function replied(text) {
    const result = A.parseIdeasReply(simulatedReply(text, S.describe.attempt));
    if (result.ok) return finishDescribe(text, result.ideas);
    if (S.describe.attempt === 0) {
      // One short retry, for a reply in the wrong shape.
      S.describe.attempt = 1;
      renderPanel();
      announce("Asking once more for a reply Clawtrate can read");
      describeTimer = setTimeout(() => replied(text), 1200);
      return;
    }
    failDescribe();
  }

  function finishDescribe(text, ideas) {
    S.describe.ideas = ideas;
    S.describe.pick = 0;
    S.describe.guard = GUARD_WORDS.test(text.toLowerCase());
    S.describe.phase = "result";
    clearTimeout(slowTimer);
    render();
    $('#as-describe [role="radio"]')?.focus();
    announce(`${ideas.length === 1 ? "One idea" : `${ideas.length === 2 ? "Two" : "Three"} ideas`} from ${asker()}. The first is in the preview.`);
  }

  function failDescribe() {
    clearTimeout(describeTimer);
    clearTimeout(slowTimer);
    S.describe.phase = "failed";
    render();
    $('#as-describe [data-act="describe-go"]')?.focus();
    announce("Couldn't make a Claw from that. Nothing changed.");
  }

  /** Kept on this device: the Claw or the 128 px picture, never the words or the file it came from. */
  function keepCustom(item) {
    S.custom.unshift(item);
    S.custom = S.custom.slice(0, MAX_CUSTOM);
  }

  function useIdea() {
    const idea = S.describe.ideas[S.describe.pick];
    const item = { id: `c${Date.now()}`, kind: "claw", choice: idea };
    keepCustom(item);
    S.describe.phase = "idle";
    S.describe.text = "";
    setChoice(idea, `Using the idea: ${describe(idea)}`);
    S.selectedCustom = item.id;
    render();
    $(`[data-act="custom"][data-value="${item.id}"]`)?.focus();
  }

  // Seed the Custom row: two Claws described earlier on this device, and an uploaded picture.
  function seedCustom() {
    S.custom = [
      { id: "c-jazz", kind: "claw", choice: A.tidy({ family: "lantern", body: "oval", lure: "wave", eyes: "two", color: "violet", head: "headphones", trim: "lime" }) },
      { id: "c-royal", kind: "claw", choice: A.tidy({ family: "shellfolk", shell: "turret", color: "yellow", head: "crown" }) },
    ];
    pixelPicture({ family: "clawling", body: "dome", eyes: "pair", claws: "big", color: "sky", face: "shades", trim: "pink" }, "#2b2f3a").then((url) => {
      if (!url) return;
      S.custom.push({ id: "p-upload", kind: "picture", url });
      if (S.view === "studio" && S.tab === "custom" && S.open) renderPanel();
    });
  }

  // Uploading ---------------------------------------------------------------------------

  /**
   * #300's limits before anything is decoded: the type from the file's own
   * first bytes, under 25 MB, and the sides from its header within 8,192 px.
   */
  async function sniff(file) {
    if (file.size >= 25 * 1024 * 1024) throw new Error("Choose an image under 25 MB.");
    const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    const at = (i, ...b) => b.every((v, j) => head[i + j] === v);
    const png = at(0, 137, 80, 78, 71, 13, 10, 26, 10);
    const gif = at(0, 71, 73, 70, 56);
    const jpeg = at(0, 255, 216, 255);
    const webp = at(0, 82, 73, 70, 70) && at(8, 87, 69, 66, 80);
    if (!png && !gif && !jpeg && !webp) throw new Error("Choose a PNG, JPEG, WebP or GIF image.");
    const dv = new DataView(head.buffer);
    const sides = png ? [dv.getUint32(16), dv.getUint32(20)] : gif ? [dv.getUint16(6, true), dv.getUint16(8, true)] : null;
    if (sides && (sides[0] < 1 || sides[1] < 1 || sides[0] > 8192 || sides[1] > 8192)) throw new Error("Choose an image up to 8,192 pixels on each side.");
  }

  async function uploaded(file) {
    await sniff(file);
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error("That file couldn't be read as an image.");
    }
    if (bitmap.width > 8192 || bitmap.height > 8192) throw new Error("Choose an image up to 8,192 pixels on each side.");
    const side = Math.min(bitmap.width, bitmap.height);
    // Redrawn: the file's own bytes and text chunks, a Clawtrate tag included, never go on.
    for (const px of [128, 96, 72, 56]) {
      const canvas = document.createElement("canvas");
      canvas.width = px;
      canvas.height = px;
      canvas.getContext("2d").drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, px, px);
      const url = canvas.toDataURL("image/png");
      if (url.length <= P.MAX_PICTURE_CHARS) return url;
    }
    throw new Error("That image has too much detail to keep. Try a simpler one.");
  }

  // Saving --------------------------------------------------------------------------------

  /** Whether the foot may write: something to write, nothing pending, no idea left unaccepted. */
  function blocked() {
    if (S.saving) return "Saving…";
    if (S.uploading) return "Wait for the picture to finish.";
    if (S.describe.phase === "result") return "Use an idea or close the ideas first.";
    if (S.describe.phase === "waiting") return "Wait for the ideas, or cancel.";
    return "";
  }

  function changed() {
    if (S.mode !== "edit") return true;
    if (S.picture) return true;
    return A.encodeChoice(S.choice) !== A.encodeChoice(S.saved);
  }

  /**
   * Create or Save: the still at 128 px with the choice's one tag, then the
   * read-back by the reader the app uses. Create writes exactly the Claw shown.
   */
  async function write() {
    if (S.saving) return;
    S.saving = true;
    S.saveError = false;
    renderFoot();
    announce(S.mode === "new" ? `Creating ${S.name.trim()}` : "Saving");
    const url = S.picture ? S.picture.url : await savedPicture(S.choice);
    const read = url ? P.readPicture(url) : { kind: "invalid" };
    await new Promise((r) => setTimeout(r, 400));
    if (!url || read.kind === "invalid" || params.get("save") === "fail") {
      S.saving = false;
      S.saveError = true;
      renderFoot();
      $("#as-foot [data-act]")?.focus();
      announce("Couldn't save the picture. Your changes are still here.");
      return;
    }
    S.done = {
      mode: S.mode,
      name: S.mode === "new" ? S.name.trim() : EDIT_BOT.name,
      url,
      shown: S.picture ? null : A.encodeChoice(S.choice),
      read,
      tags: P.tags(url),
    };
    S.saving = false;
    // Create and Save clear the draft.
    if (S.mode === "edit") S.saved = S.choice;
    close(S.mode === "new" ? `Created ${S.done.name}` : `Saved ${EDIT_BOT.name}'s picture`);
  }

  // Rendering the studio ------------------------------------------------------------------

  const TABS = [
    ["creature", "Creature"],
    ["colour", "Colour"],
    ["extras", "Extras"],
    ["custom", "Custom"],
  ];

  function radioGroup({ id, label, values, current, tile, extraClass = "" }) {
    return (
      `<p class="as-label" id="${id}-label">${label}</p>` +
      `<div class="as-tiles ${extraClass}" role="radiogroup" aria-labelledby="${id}-label" data-group="${id}">` +
      values
        .map((value, index) => {
          const checked = value === current;
          const focusable = checked || (current === undefined && index === 0);
          return tile(value, checked, focusable ? 0 : -1);
        })
        .join("") +
      `</div>`
    );
  }

  function panelCreature() {
    const c = S.choice;
    const starters = radioGroup({
      id: "as-starters",
      label: "Starters",
      values: STARTERS.map((_, i) => String(i)),
      current: (() => {
        if (S.source === "name") return undefined;
        const at = STARTERS.findIndex((s) => A.encodeChoice(s) === A.encodeChoice(c));
        return at < 0 ? undefined : String(at);
      })(),
      tile: (value, checked, tab) => {
        const starter = STARTERS[Number(value)];
        const name = describe(starter);
        return `<button type="button" class="as-tile" role="radio" aria-checked="${checked}" tabindex="${tab}" aria-label="${esc(name)}" title="${esc(name)}" data-act="starter" data-value="${value}">${creature(starter, "idle", "starter" + value)}</button>`;
      },
    });
    const families = radioGroup({
      id: "as-family",
      label: "Family",
      values: C.AVATAR_FAMILIES,
      current: c.family,
      extraClass: "as-families",
      tile: (value, checked, tab) =>
        `<button type="button" class="as-family" role="radio" aria-checked="${checked}" tabindex="${tab}" data-act="family" data-value="${value}">${creature(A.tidy(family(value)), "idle", "fam" + value)}<span>${FAMILY_WORDS[value]}</span></button>`,
    });
    const parts = Object.entries(C.AVATAR_PARTS[c.family])
      .map(([key, values]) =>
        radioGroup({
          id: `as-part-${key}`,
          label: PART_WORDS[key],
          values,
          current: c[key],
          tile: (value, checked, tab) =>
            `<button type="button" class="as-tile" role="radio" aria-checked="${checked}" tabindex="${tab}" aria-label="${VALUE_WORDS[value]}" title="${VALUE_WORDS[value]}" data-act="part" data-key="${key}" data-value="${value}">${creature(A.tidy(withPart(key, value)), "idle", "part")}</button>`,
        }),
      )
      .join("");
    return starters + families + parts;
  }

  function swatches(id, label, current, act, exclude) {
    return radioGroup({
      id,
      label,
      values: C.AVATAR_COLOR_NAMES,
      current,
      extraClass: "as-colors",
      tile: (value, checked, tab) =>
        `<button type="button" class="as-color" role="radio" aria-checked="${checked}" tabindex="${tab}" aria-label="${COLOR_WORDS[value]}${value === exclude ? ", the body's colour" : ""}" title="${COLOR_WORDS[value]}" style="--swatch:${C.AVATAR_COLORS[value]}" data-act="${act}" data-value="${value}"></button>`,
    });
  }

  function panelColour() {
    const c = S.choice;
    let html = swatches("as-color", "Body", c.color, "color");
    if (A.onlyCrown(c)) html += `<p class="as-hint" data-testid="crown-hint">The crown is always gold, so it takes no colour of its own.</p>`;
    else if (A.wears(c)) {
      html += swatches("as-trim", "Accessories", A.trimName(c), "trim", c.color);
      if (c.head === "crown") html += `<p class="as-hint">The crown stays gold; this colours the rest.</p>`;
    } else html += `<p class="as-hint" data-testid="trim-hint">Accessories take a colour of their own once one is on (Extras).</p>`;
    html += `<p class="as-hint">Eight colours, the same in light and dark. None of them is red or orange: Claws keep clear of lobster and crab colours.</p>`;
    return html;
  }

  function panelExtras() {
    return A.SLOTS.map((slot) => {
      const values = ["none", ...A.AVATAR_ACCESSORIES[slot]];
      return radioGroup({
        id: `as-wear-${slot}`,
        label: SLOT_WORDS[slot],
        values,
        current: S.choice[slot] || "none",
        tile: (value, checked, tab) => {
          const preview = { ...S.choice };
          if (value === "none") delete preview[slot];
          else preview[slot] = value;
          const word = value === "none" ? "None" : WEAR_WORDS[value];
          return `<button type="button" class="as-tile" role="radio" aria-checked="${checked}" tabindex="${tab}" aria-label="${word}" title="${word}" data-act="wear" data-slot="${slot}" data-value="${value}">${creature(A.tidy(preview), "idle", "wear")}<span class="as-tile-word">${word}</span></button>`;
        },
      });
    }).join("");
  }

  function customRow() {
    // One tab stop: the chosen item, or the first when none is chosen.
    const chosen = S.custom.some((c) => c.id === S.selectedCustom);
    const items = S.custom
      .map((item, i) => {
        const checked = S.selectedCustom === item.id;
        const art = item.kind === "claw" ? creature(item.choice, "idle", item.id) : `<img src="${item.url}" alt="" />`;
        const label = item.kind === "claw" ? `Described: ${describe(item.choice)}` : "Your picture";
        return `<button type="button" class="as-tile as-custom-item" data-kind="${item.kind}" role="radio" aria-checked="${checked}" tabindex="${checked || (!chosen && i === 0) ? 0 : -1}" aria-label="${esc(label)}" title="${esc(label)}" data-act="custom" data-value="${item.id}">${art}</button>`;
      })
      .join("");
    const remove = chosen
      ? `<div class="as-actions"><button type="button" class="button" data-variant="quiet" data-size="sm" data-act="custom-remove">Remove from this device</button></div>`
      : "";
    return (
      `<p class="as-label" id="as-custom-label">Custom</p>` +
      `<div class="as-custom-row">` +
      `<button type="button" class="as-tile as-make" data-act="describe-open" aria-expanded="${S.describe.phase !== "idle"}" aria-controls="as-describe"${unavailable ? ' aria-disabled="true"' : ""}>${icon("write")}<span class="as-tile-word">Describe</span></button>` +
      `<button type="button" class="as-tile as-make" data-act="upload">${icon("arrow-up")}<span class="as-tile-word">Upload</span></button>` +
      (items ? `<div class="as-custom-items" role="radiogroup" aria-labelledby="as-custom-label">${items}</div>` : "") +
      `</div>` +
      remove +
      `<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden data-testid="picture-file" id="as-file" />` +
      `<p class="as-hint">Kept on this device, at most ${MAX_CUSTOM}: the Claws and pictures only, not your words or files. The picture you save is kept with the bot on your gateway.</p>`
    );
  }

  function describePanel() {
    const d = S.describe;
    if (d.phase === "idle") return "";
    if (unavailable)
      return (
        `<section class="as-describe" id="as-describe" aria-label="Describe a Claw">` +
        `<div class="b-note" data-testid="describe-unavailable">${icon("warning")}<p><b>Describe a Claw isn't available on this gateway.</b> It needs a way to send your words to the model with no tools, and this gateway doesn't offer one yet.</p></div></section>`
      );
    const sim = `<p class="as-sim" data-testid="simulated">${icon("warning")}<span><b>Simulated.</b> No model is called in this prototype; a small word table writes ${esc(asker())}'s reply.</span></p>`;
    const route =
      S.mode === "new"
        ? `Sent through your gateway with ${MAIN_BOT}'s model, <span class="as-route">${ROUTE}</span>, because this bot doesn't exist yet.`
        : `Sent through your gateway to ${esc(EDIT_BOT.name)}'s model, <span class="as-route">${ROUTE}</span>.`;
    const field =
      `<label class="as-field"><span>Describe a Claw</span>` +
      `<textarea class="input as-words" id="as-words" rows="2" maxlength="200" placeholder="A sleepy lantern who loves jazz" ${d.phase === "waiting" ? "disabled" : ""}>${esc(d.text)}</textarea></label>` +
      `<p class="as-hint" data-testid="route">${route} This uses that account's model usage. The model gets no tools and none of the bot's memory or conversations. A reply in the wrong shape gets one short retry, which can use a second turn.</p>`;
    let body = "";
    if (d.phase === "typing")
      body = `<div class="as-actions"><button type="button" class="button" data-variant="primary" data-size="sm" data-act="describe-go">Make it</button><button type="button" class="button" data-variant="quiet" data-size="sm" data-act="describe-close">Cancel</button></div>`;
    else if (d.phase === "waiting")
      body =
        `<div class="as-wait-row"><p class="as-wait" data-testid="waiting"><span class="as-dot" aria-hidden="true"></span><span>${d.attempt ? "Asking once more for a reply Clawtrate can read…" : `${esc(asker())} is imagining it…`}</span></p>` +
        `<button type="button" class="button" data-variant="quiet" data-size="sm" data-act="describe-cancel">Cancel</button></div>` +
        (d.slow ? `<p class="as-hint" data-testid="slow">Still imagining. It stops after 45 seconds.</p>` : "");
    else if (d.phase === "failed")
      body =
        `<div class="b-note" data-tone="danger" role="alert">${icon("warning")}<div><p><b>Couldn't make a Claw from that.</b> ${esc(asker())}'s reply didn't name parts the studio has, twice. Nothing changed.</p>` +
        `<div class="as-actions"><button type="button" class="button" data-size="sm" data-act="describe-go">Try again</button><button type="button" class="button" data-variant="quiet" data-size="sm" data-act="describe-edit">Change the words</button></div></div></div>`;
    else if (d.phase === "result") {
      const ideas = d.ideas
        .map((idea, i) => {
          const name = describe(idea);
          return `<button type="button" class="as-tile as-idea" role="radio" aria-checked="${i === d.pick}" tabindex="${i === d.pick ? 0 : -1}" aria-label="Idea ${i + 1}: ${esc(name)}" title="${esc(name)}" data-act="idea" data-value="${i}">${creature(idea, "idle", "idea" + i)}</button>`;
        })
        .join("");
      body =
        `<p class="as-label" id="as-ideas-label">${esc(asker())}'s ideas</p>` +
        `<div class="as-tiles as-ideas" role="radiogroup" aria-labelledby="as-ideas-label">${ideas}</div>` +
        // Clawtrate's own words for the idea, from its fields: nothing the model wrote is shown.
        `<p class="as-said" data-testid="idea-caption">${esc(`Idea ${d.pick + 1} of ${d.ideas.length}: ${describe(d.ideas[d.pick])}`)}</p>` +
        (d.guard ? `<div class="b-note" data-testid="guard-note">${icon("warning")}<p>There's no red or orange: Claws keep clear of lobster and crab colours. Pink is the closest.</p></div>` : "") +
        `<div class="as-actions as-result-actions" data-testid="result-actions"><button type="button" class="button" data-variant="primary" data-size="sm" data-act="idea-use">Use this</button><button type="button" class="button" data-size="sm" data-act="describe-go">Try again</button><button type="button" class="button" data-variant="quiet" data-size="sm" data-act="describe-edit">Change the words</button></div>`;
    }
    return `<section class="as-describe" id="as-describe" aria-label="Describe a Claw">${sim}${field}${body}</section>`;
  }

  function panelCustom() {
    return customRow() + describePanel() + `<p class="b-field-error" role="alert" id="as-upload-error" hidden></p>`;
  }

  function panelAccount() {
    const rows = [
      ["main", "Claude", "The gateway's default account"],
      ["work", "Codex", "Signed in on this gateway"],
    ];
    return (
      `<p class="as-label" id="as-account-label">Account</p>` +
      `<div class="as-accounts" role="radiogroup" aria-labelledby="as-account-label" data-group="as-account">` +
      rows
        .map(
          ([id, name, line], i) =>
            `<button type="button" class="as-account" role="radio" aria-checked="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-act="account" data-value="${id}"><b>${name}</b><span>${line}</span></button>`,
        )
        .join("") +
      `</div><p class="as-hint">The Claw above is what Create saves.</p>`
    );
  }

  /** What the preview shows: an idea being looked at, the person's picture, or the Claw being built. */
  function previewChoice() {
    if (S.describe.phase === "result") return S.describe.ideas[S.describe.pick];
    return S.choice;
  }

  function renderPreview() {
    const box = $("#as-preview");
    if (!box) return;
    const waiting = S.describe.phase === "waiting";
    const state = waiting ? "thinking" : S.state;
    const choice = previewChoice();
    if (S.picture && S.describe.phase !== "result") {
      box.innerHTML = `<img src="${S.picture.url}" alt="" />`;
      box.setAttribute("aria-label", S.picture.label);
      box.dataset.kind = "picture";
    } else {
      const swap = S.swap && !reduced() ? S.swap : null;
      box.innerHTML =
        (swap && swap.from && swap.kind === "morph" ? `<span class="as-swap-out" aria-hidden="true">${swap.from}</span>` : "") +
        creature(choice, state, "studio", swap ? ` data-swap="${swap.kind}"` : "");
      box.setAttribute("aria-label", (S.describe.phase === "result" ? "Idea: " : "") + describe(choice));
      box.dataset.kind = "claw";
    }
    box.dataset.state = state;
    box.dataset.source = S.source;
    const caption = $("#as-state-word");
    if (caption) caption.textContent = S.playing ? STATE_WORDS[S.state] : "";
    const play = $('[data-act="play"]');
    if (play) {
      play.setAttribute("aria-pressed", String(S.playing));
      play.setAttribute("aria-label", S.playing ? "Stop playing the states" : "Play the states");
      play.title = S.playing ? "Stop" : "Play the states";
      play.innerHTML = icon(S.playing ? "x" : "play");
    }
  }

  /** Under the name: that the Claw follows it, or the way back to it. */
  function renderNameNote() {
    const note = $("#as-name-note");
    if (!note) return;
    if (S.nameError) note.innerHTML = `<span class="as-name-error" role="alert">Give your bot a name first.</span>`;
    else if (S.source === "name")
      note.innerHTML = `<span class="as-follows" data-testid="follows-name">${S.name.trim() ? "Your Claw comes from the name. Pick anything below to make it your own." : "Type a name and your Claw will come from it."}</span>`;
    else note.innerHTML = `<button type="button" class="button as-match" data-variant="quiet" data-size="sm" data-act="match-name">${icon("undo")}Match my name</button>`;
    $("#as-name")?.setAttribute("aria-invalid", String(S.nameError));
  }

  function renderPanel() {
    const panel = $("#as-panel");
    if (!panel) return;
    const html =
      S.step === "account" ? panelAccount() : { creature: panelCreature, colour: panelColour, extras: panelExtras, custom: panelCustom }[S.tab]();
    panel.innerHTML = html;
    panel.setAttribute("aria-labelledby", S.step === "account" ? "as-title" : `as-tab-${S.tab}`);
    CT.hydrate(panel);
  }

  function renderFoot() {
    const foot = $("#as-foot");
    if (!foot) return;
    const why = blocked();
    const undo = S.undo && S.step === "build" ? `<button type="button" class="button" data-variant="quiet" data-size="sm" data-act="undo">Undo surprise</button>` : "";
    const error = S.saveError
      ? `<div class="b-note" data-tone="danger" role="alert" data-testid="save-error">${icon("warning")}<p><b>Couldn't save the picture.</b> Your changes are still here.</p></div>`
      : "";
    const hint = why && !S.saving ? `<p class="as-foot-hint">${why}</p>` : "";
    let main;
    if (S.mode === "new" && S.step === "build")
      main = `<button type="button" class="button" data-variant="primary" data-size="lg" data-act="next" ${why ? "disabled" : ""}>Next</button>`;
    else if (S.mode === "new")
      main =
        `<div class="as-foot-row"><button type="button" class="button" data-size="lg" data-act="back" ${S.saving ? "disabled" : ""}>Back</button>` +
        `<button type="button" class="button" data-variant="primary" data-size="lg" data-act="create" ${S.saving ? "disabled" : ""}>${S.saving ? "Creating…" : "Create"}</button></div>`;
    else
      main = `<button type="button" class="button" data-variant="primary" data-size="lg" data-act="save" ${changed() && !why ? "" : "disabled"}>${S.saving ? "Saving…" : "Save"}</button>`;
    foot.innerHTML = error + undo + hint + main;
  }

  /** Where focus was, so a redraw can put it back on the same control. */
  function focusKey() {
    const el = document.activeElement;
    if (!el || !el.closest?.(".as-dialog")) return null;
    if (el.id) return `#${el.id}`;
    if (!el.dataset.act) return null;
    let key = `[data-act="${el.dataset.act}"]`;
    if (el.dataset.value) key += `[data-value="${el.dataset.value}"]`;
    if (el.dataset.slot) key += `[data-slot="${el.dataset.slot}"]`;
    if (el.dataset.key) key += `[data-key="${el.dataset.key}"]`;
    return key;
  }

  function render() {
    if (S.view !== "studio" || !S.open) return;
    const key = focusKey();
    const dialog = $(".as-dialog");
    if (dialog) dialog.dataset.step = S.step;
    renderPreview();
    for (const [id] of TABS) {
      const tab = $(`#as-tab-${id}`);
      tab.setAttribute("aria-selected", String(id === S.tab));
      tab.tabIndex = id === S.tab ? 0 : -1;
    }
    const title = $("#as-title");
    if (title) title.textContent = S.step === "account" ? "Account" : S.mode === "new" ? "New bot" : `${EDIT_BOT.name}'s picture`;
    renderNameNote();
    renderPanel();
    renderFoot();
    // Focus stays on the control it was on, when that control is still there.
    if (key && (document.activeElement === document.body || !document.activeElement?.isConnected)) $(key)?.focus();
    // A wait, the ideas or a failure come into view as they arrive.
    if (S.tab === "custom" && ["waiting", "result", "failed"].includes(S.describe.phase))
      $("#as-describe")?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }

  function studio() {
    const name =
      S.mode === "new"
        ? `<label class="as-name-wrap"><span class="visually-hidden">Name</span><input class="input as-name" id="as-name" placeholder="Name" autocomplete="off" maxlength="64" aria-describedby="as-name-note" value="${esc(S.name)}" /></label>` +
          `<p class="as-name-note" id="as-name-note"></p>`
        : `<p class="as-bot-name">${esc(EDIT_BOT.name)}</p>`;
    return (
      `<div class="as-scrim"></div>` +
      `<section class="as-dialog" role="dialog" aria-modal="true" aria-labelledby="as-title" data-mode="${S.mode}" data-testid="studio">` +
      `<header class="b-head"><h2 id="as-title" tabindex="-1"></h2><button type="button" class="icon-button b-close as-close" data-variant="quiet" aria-label="Close" data-act="close">${icon("x")}</button></header>` +
      `<div class="as-top">` +
      `<div class="as-stage">` +
      `<button type="button" class="icon-button as-side" data-act="play" aria-pressed="false" aria-label="Play the states" title="Play the states">${icon("play")}</button>` +
      `<span class="as-preview" id="as-preview" role="img" data-testid="studio-preview"></span>` +
      `<button type="button" class="icon-button as-side" data-act="surprise" aria-label="Surprise me" title="Surprise me">${icon("dice")}</button>` +
      `</div>` +
      `<p class="as-state-word" id="as-state-word" aria-hidden="true"></p>` +
      name +
      `<div class="as-tabs" role="tablist" aria-label="Build">` +
      TABS.map(([id, word]) => `<button type="button" role="tab" id="as-tab-${id}" aria-controls="as-panel" data-act="tab" data-value="${id}">${word}</button>`).join("") +
      `</div>` +
      `</div>` +
      `<div class="as-panel" id="as-panel" role="tabpanel" tabindex="0"></div>` +
      `<footer class="as-foot" id="as-foot"></footer>` +
      `</section>`
    );
  }

  // The app behind the dialog ------------------------------------------------------------

  function backdrop() {
    const rows = [
      { name: "Atlas", choice: C.defaultAvatar("atlas") },
      { name: "Juniper", choice: S.mode === "edit" ? S.saved : EDIT_BOT.choice },
      { name: "Wren", choice: { family: "shellfolk", shell: "spiral", color: "blue" } },
      { name: "Otto", choice: { family: "lantern", body: "round", lure: "hook", eyes: "two", color: "sky" } },
    ];
    // A bot just created is drawn from its read-back picture, as every client would.
    const made = S.done && S.done.mode === "new" ? S.done : null;
    if (made && made.read.kind === "creature") rows.unshift({ name: made.name, choice: made.read.choice, created: true });
    return (
      `<div class="as-app" inert aria-hidden="true">` +
      `<aside class="as-rail">${rows.map((r) => `<div class="as-row"${r.created ? ' data-testid="created-row"' : ""}>${avatar(r.choice, "idle", 32, r.name.toLowerCase())}<span>${esc(r.name)}</span></div>`).join("")}</aside>` +
      `<div class="as-main"></div>` +
      `</div>`
    );
  }

  /** After Close, Create or Save: what was written, read back, and the way into the studio again. */
  function closed() {
    const d = S.done;
    const opener = S.mode === "new" ? "New bot" : `Edit ${EDIT_BOT.name}'s picture`;
    const result = d
      ? `<div class="as-done" data-testid="done">` +
        `<p class="as-done-title">${d.mode === "new" ? `Created ${esc(d.name)}` : `Saved ${esc(d.name)}'s picture`}</p>` +
        `<div class="as-pair"><figure><span class="avatar as-saved"><img src="${d.url}" alt="" /></span><figcaption>Saved picture, cropped as other apps show it</figcaption></figure>` +
        (d.read.kind === "creature" ? `<figure>${avatar(d.read.choice, "idle", 72, "done")}<figcaption>Read back and drawn</figcaption></figure>` : "") +
        `</div>` +
        `<p class="as-tag" data-testid="saved-tag"><code>${esc((d.tags || []).map(([k, t]) => `${k}: ${t}`).join(" · "))}</code></p></div>`
      : `<p class="as-hint">Closed. What you chose is kept until the app quits.</p>`;
    return `<div class="as-closed">${result}<button type="button" class="button" data-variant="primary" id="as-opener" data-act="open">${esc(opener)}</button></div>`;
  }

  function open() {
    S.open = true;
    if (S.done) {
      // A fresh draft after Create or Save.
      S.done = null;
      if (S.mode === "new") {
        S.name = "";
        S.source = "name";
        S.choice = A.nameChoice("");
      }
      S.undo = null;
      S.picture = null;
      S.selectedCustom = null;
    }
    mount();
  }

  function close(words) {
    clearTimeout(beatTimer);
    clearTimeout(playTimer);
    clearTimeout(describeTimer);
    clearTimeout(slowTimer);
    clearTimeout(nameTimer);
    clearTimeout(settleTimer);
    S.playing = false;
    S.typing = false;
    S.state = "idle";
    S.step = "build";
    if (S.describe.phase === "waiting") S.describe.phase = "typing";
    S.open = false;
    mount();
    $("#as-opener")?.focus();
    announce(words || "Closed. What you chose is kept until the app quits.");
  }

  // The chat path, as a mock ----------------------------------------------------------------

  const PROPOSED = A.tidy({ family: "lantern", body: "round", lure: "hook", eyes: "two", color: "sky", head: "headphones", trim: "violet" });

  const CARD_ENDS = {
    declined: "Kept its picture.",
    expired: "This proposal expired after 24 hours. Ask Juniper again for a new one.",
    superseded: "Juniper proposed a newer picture, so this one no longer applies.",
    elsewhere: "Juniper's picture was changed somewhere else since this was proposed, so it no longer applies.",
  };

  function proposalCard(state) {
    const now = EDIT_BOT.choice;
    const next = PROPOSED;
    const fields = `<p class="as-fields" data-testid="proposal-fields">${esc(describe(next))}</p>`;
    const pair =
      `<div class="as-pair"><figure>${avatar(now, "idle", 64, "juniper")}<figcaption>Now</figcaption></figure>` +
      `<span class="as-arrow" aria-hidden="true">${icon("chevron")}</span>` +
      `<figure>${avatar(next, state === "saved" ? "done" : "idle", 64, "juniper")}<figcaption>${state === "saved" ? "Saved" : "Proposed"}</figcaption></figure></div>`;
    let foot = "";
    if (state === "proposed")
      foot =
        `<p class="as-hint">Nothing changes until you choose.</p>` +
        `<div class="as-actions"><button type="button" class="button" data-variant="primary" data-size="sm" data-act="chat-use">Use it</button><button type="button" class="button" data-size="sm" data-act="chat-open">Open in studio</button><button type="button" class="button" data-variant="quiet" data-size="sm" data-act="chat-no">Not now</button></div>`;
    else if (state === "saved")
      foot = `<p class="as-result" role="status">${icon("check")} Juniper's picture changed.</p><div class="as-actions"><button type="button" class="button" data-variant="quiet" data-size="sm" data-act="chat-undo">Undo</button></div>`;
    else if (state === "unconfirmed")
      foot =
        `<div class="b-note" data-tone="danger" role="alert">${icon("warning")}<p><b>Couldn't confirm the save.</b> Juniper's picture may or may not have changed. Checking again reads it from the gateway before anything is sent twice.</p></div>` +
        `<div class="as-actions"><button type="button" class="button" data-size="sm" data-act="chat-check">Check again</button></div>`;
    else if (state === "admin")
      foot =
        `<div class="access-bar as-access" role="region" aria-label="Admin access">${icon("eye")}<p><b>Admin access needed.</b> Changing Juniper's picture needs admin access.</p><button type="button" class="button" data-variant="primary" data-size="sm">Request admin access</button></div>`;
    else foot = `<p class="as-result" role="status">${CARD_ENDS[state] || ""}</p>`;
    return (
      `<article class="card as-proposal" data-state="${state}" data-testid="proposal" aria-labelledby="as-proposal-title">` +
      `<header><h3 id="as-proposal-title">A new picture for Juniper</h3><span class="as-by">Proposed by Juniper</span></header>` +
      pair +
      fields +
      foot +
      `</article>`
    );
  }

  function chat() {
    const state = S.chat;
    const picture = state === "picture";
    return (
      `<div class="as-chat" data-testid="chat">` +
      `<header class="as-chat-head"><span class="as-pill">${avatar(state === "saved" ? PROPOSED : EDIT_BOT.choice, "idle", 22, "juniper")}<span>Juniper</span></span></header>` +
      `<div class="as-transcript" role="log" aria-label="Conversation with Juniper">` +
      `<p class="stamp">Today 9:41 PM</p>` +
      `<div class="msg" data-role="user"><div class="bubble">${picture ? "Make yourself a picture, like a little painting of you" : "Make an avatar for yourself based on something you know about me"}</div></div>` +
      `<p class="event-line">${icon("search")} Looked through what it remembers about you</p>` +
      (picture
        ? `<p class="event-line">${icon("screen")} Made a picture with the gateway's image model</p>` +
          `<div class="msg" data-role="assistant"><div class="bubble">Here's me as a little painting. Want it as my picture?</div></div>` +
          `<article class="card as-proposal" data-state="proposed" data-testid="proposal" aria-labelledby="as-proposal-title"><header><h3 id="as-proposal-title">A new picture for Juniper</h3><span class="as-by">Made with the gateway's image model</span></header>` +
          `<div class="as-pair"><figure>${avatar(EDIT_BOT.choice, "idle", 64, "juniper")}<figcaption>Now</figcaption></figure><span class="as-arrow" aria-hidden="true">${icon("chevron")}</span><figure><span class="avatar as-raster" style="width:64px;height:64px" id="as-raster"></span><figcaption>Proposed</figcaption></figure></div>` +
          `<p class="as-hint">A picture, not a Claw: it won't act out states. Cropped to a circle and kept at 128 px. Later work: raster proposals wait for an authorized image result (section 8). Stand-in art: no image model runs in this prototype.</p>` +
          `<div class="as-actions"><button type="button" class="button" data-variant="primary" data-size="sm" disabled>Use it</button><button type="button" class="button" data-variant="quiet" data-size="sm">Not now</button></div></article>`
        : `<p class="event-line">${icon("write")} Proposed a new picture</p>` +
          `<div class="msg" data-role="assistant"><div class="bubble">You're up late most nights with a record on, so I'd be a Lantern in headphones. Sky blue, like the covers you keep sending me.</div></div>` +
          proposalCard(state)) +
      (state === "saved" ? `<p class="event-line" data-side="center">Juniper changed its picture</p>` : "") +
      `</div>` +
      `<div class="as-composer" aria-hidden="true"><span>Message Juniper</span></div>` +
      `</div>`
    );
  }

  // The board: every family wearing things, in each state, at each size ---------------------

  const BOARD_ROWS = [
    { name: "Clawling", choice: { family: "clawling", body: "dome", eyes: "pair", claws: "even", color: "blue", head: "beret", face: "glasses", neck: "bowtie", trim: "yellow" } },
    { name: "Clawling, one eye", choice: { family: "clawling", body: "round", eyes: "single", claws: "fiddler", color: "lime", head: "party", face: "shades", trim: "violet" } },
    { name: "Clawling, tallest", choice: { family: "clawling", body: "tall", eyes: "splayed", claws: "big", color: "orchid", head: "party", face: "shades", neck: "bowtie", trim: "sky" } },
    { name: "Clawling, one eye, beanie", choice: { family: "clawling", body: "tall", eyes: "single", claws: "even", color: "green", head: "beanie", face: "glasses", neck: "bowtie", trim: "green" } },
    { name: "Shellfolk", choice: { family: "shellfolk", shell: "spiral", color: "pink", head: "beanie", face: "glasses", neck: "bowtie", trim: "sky" } },
    { name: "Shellfolk, turret", choice: { family: "shellfolk", shell: "turret", color: "sky", head: "party", face: "shades", trim: "yellow" } },
    { name: "Lantern", choice: { family: "lantern", body: "round", lure: "hook", eyes: "two", color: "violet", head: "headphones", face: "shades", trim: "lime" } },
    { name: "Lantern, crown", choice: { family: "lantern", body: "bell", lure: "wave", eyes: "one", color: "green", head: "crown", neck: "bowtie", trim: "orchid" } },
    { name: "Lantern, oval", choice: { family: "lantern", body: "oval", lure: "reach", eyes: "two", color: "yellow", head: "beret", face: "glasses", neck: "bowtie", trim: "blue" } },
  ];
  const SIZES = [18, 22, 32, 56, 120, 152];

  const FIT_COLUMNS = [
    ...C.CLAWLING_BODIES.map((body) => ({ family: "clawling", body, eyes: "pair", claws: "even", color: "blue" })),
    { family: "clawling", body: "dome", eyes: "single", claws: "even", color: "blue" },
    { family: "clawling", body: "tall", eyes: "splayed", claws: "fiddler", color: "blue" },
    ...C.SHELLFOLK_SHELLS.map((shell) => ({ family: "shellfolk", shell, color: "orchid" })),
    ...C.LANTERN_BODIES.map((body, i) => ({ family: "lantern", body, lure: C.LANTERN_LURES[i], eyes: i === 3 ? "one" : "two", color: "lime" })),
  ];
  const FIT_ROWS = [...A.AVATAR_HEADWEAR.map((head) => ({ head })), ...A.AVATAR_FACEWEAR.map((face) => ({ face })), { neck: "bowtie" }];

  function board(theme) {
    const head = `<tr><th></th>${C.AVATAR_STATES.map((s) => `<th>${s}</th>`).join("")}<th>saved</th></tr>`;
    const rows = SIZES.flatMap((size) =>
      BOARD_ROWS.map((row, r) => {
        const choice = A.tidy(row.choice);
        return (
          `<tr><th>${row.name}, ${size} px</th>` +
          C.AVATAR_STATES.map(
            (state) => `<td data-size="${size}" data-state="${state}" data-family="${choice.family}" data-row="${r}">${presence(choice, state, size, row.name)}</td>`,
          ).join("") +
          `<td data-saved="${r}" data-size="${size}"><span class="avatar as-saved" style="width:${size}px;height:${size}px"></span></td>` +
          `</tr>`
        );
      }),
    ).join("");
    const fitHead = `<tr><th></th>${FIT_COLUMNS.map((c) => `<th>${ONE_FAMILY[c.family]}<br>${Object.keys(C.AVATAR_PARTS[c.family]).map((k) => c[k]).join(" ")}</th>`).join("")}</tr>`;
    const fitRows = FIT_ROWS.map(
      (wear) =>
        `<tr><th>${WEAR_WORDS[wear.head || wear.face || wear.neck]}</th>` +
        FIT_COLUMNS.map((col) => `<td data-fit="${wear.head || wear.face || wear.neck}" data-family="${col.family}">${presence(A.tidy({ ...col, ...wear }), "idle", 56, "fit")}</td>`).join("") +
        `</tr>`,
    ).join("");
    return (
      `<section class="av-board as-board" data-theme="${theme}" data-board="${theme}">` +
      `<h2>${theme === "dark" ? "Dark" : "Light"}: wearing things, in each state, at each size, in the app's Presence ring and badge; the last column is the saved 128 px still, cropped</h2>` +
      `<table><thead>${head}</thead><tbody>${rows}</tbody></table>` +
      `<h2>${theme === "dark" ? "Dark" : "Light"}: each accessory on each family, 56 px</h2>` +
      `<div class="as-fit"><table><thead>${fitHead}</thead><tbody>${fitRows}</tbody></table></div>` +
      `</section>`
    );
  }

  /** The motion's extreme frame: the furthest lift, turn or scale. */
  function peakAt(motion) {
    let best = motion.frames[0];
    const size = (f) => Math.abs(f.translate?.[1] ?? 0) + Math.abs(f.translate?.[0] ?? 0) + Math.abs(f.rotate ?? 0) / 4 + Math.abs((f.scale ?? 1) - 1) * 20;
    for (const f of motion.frames) if (size(f) > size(best)) best = f;
    return best.at * motion.duration;
  }

  /** ?peak=1: every creature motion held at its peak, the hat's tip with the hop. */
  function holdPeaks(root = document) {
    for (const animation of root.getAnimations(root === document ? undefined : { subtree: true })) {
      const name = animation.animationName?.replace(/^av-/, "");
      const motion = MOTIONS[name];
      if (!motion) continue;
      animation.pause();
      const delay = animation.effect.getTiming().delay || 0;
      animation.currentTime = peakAt(motion) + delay;
    }
  }

  // Events ------------------------------------------------------------------------------------

  function radioKeys(event) {
    const group = event.target.closest('[role="radiogroup"]');
    if (!group || event.target.getAttribute("role") !== "radio") return false;
    const radios = [...group.querySelectorAll('[role="radio"]')];
    const index = radios.indexOf(event.target);
    let next = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % radios.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + radios.length) % radios.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = radios.length - 1;
    if (next === null) return false;
    event.preventDefault();
    const groupId = group.dataset.group || group.getAttribute("aria-labelledby");
    act(radios[next]);
    // The panel was drawn again: put focus on the same group's chosen radio.
    const again = groupId && (document.querySelector(`[data-group="${groupId}"]`) || document.querySelector(`[aria-labelledby="${groupId}"]`));
    const target = again && (again.querySelector('[aria-checked="true"]') || again.querySelectorAll('[role="radio"]')[next]);
    target?.focus();
    return true;
  }

  function tabKeys(event) {
    if (event.target.getAttribute("role") !== "tab") return false;
    const ids = TABS.map(([id]) => id);
    const index = ids.indexOf(S.tab);
    let next = null;
    if (event.key === "ArrowRight") next = (index + 1) % ids.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + ids.length) % ids.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = ids.length - 1;
    if (next === null) return false;
    event.preventDefault();
    S.tab = ids[next];
    render();
    $(`#as-tab-${S.tab}`).focus();
    return true;
  }

  const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /** Tab and Shift+Tab stay inside the dialog. */
  function trapKeys(event) {
    if (event.key !== "Tab") return false;
    const dialog = $(".as-dialog");
    if (!dialog) return false;
    const all = [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && el.offsetParent !== null);
    if (!all.length) return false;
    const first = all[0];
    const last = all[all.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
      return true;
    }
    if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
      return true;
    }
    return false;
  }

  function act(el) {
    const what = el.dataset.act;
    const value = el.dataset.value;
    switch (what) {
      case "tab":
        S.tab = value;
        render();
        return;
      case "starter":
        S.undo = null;
        return setChoice(STARTERS[Number(value)], describe(STARTERS[Number(value)]));
      case "family":
        S.undo = null;
        return setChoice(family(value), FAMILY_WORDS[value]);
      case "part":
        S.undo = null;
        return setChoice(withPart(el.dataset.key, value), VALUE_WORDS[value]);
      case "color":
        S.undo = null;
        return setChoice({ ...S.choice, color: value }, COLOR_WORDS[value]);
      case "trim":
        S.undo = null;
        return setChoice({ ...S.choice, trim: value }, `Accessories in ${COLOR_WORDS[value].toLowerCase()}`);
      case "wear": {
        S.undo = null;
        const next = { ...S.choice };
        const slot = el.dataset.slot;
        const before = next[slot];
        if (value === "none") delete next[slot];
        else next[slot] = value;
        return setChoice(next, value === "none" ? `${WEAR_WORDS[before] || "Nothing"} off` : `${WEAR_WORDS[value]} on`);
      }
      case "surprise":
        return surprise();
      case "undo": {
        const back = S.undo;
        S.undo = null;
        S.choice = back.choice;
        S.source = back.source;
        S.picture = back.picture;
        S.selectedCustom = back.selectedCustom;
        render();
        announce(`Back to ${back.picture ? back.picture.label : describe(back.choice)}`);
        $('[data-act="surprise"]')?.focus();
        return;
      }
      case "match-name":
        return matchName();
      case "play":
        return playStates();
      case "custom": {
        const item = S.custom.find((c) => c.id === value);
        if (!item) return;
        S.undo = null;
        if (item.kind === "claw") setChoice(item.choice, describe(item.choice));
        else {
          S.picture = { url: item.url, label: "Your picture", kind: "picture" };
          if (S.mode === "new") S.source = "manual";
          announce("Your picture");
        }
        S.selectedCustom = item.id;
        render();
        return;
      }
      case "custom-remove": {
        const at = S.custom.findIndex((c) => c.id === S.selectedCustom);
        if (at < 0) return;
        S.custom.splice(at, 1);
        S.selectedCustom = null;
        render();
        announce("Removed from this device");
        ($('[data-act="custom"]') || $('[data-act="upload"]'))?.focus();
        return;
      }
      case "describe-open":
        if (unavailable && S.describe.phase === "idle") {
          S.describe.phase = "typing";
          render();
          return;
        }
        S.describe.phase = S.describe.phase === "idle" ? "typing" : "idle";
        render();
        if (S.describe.phase === "typing") $("#as-words")?.focus();
        return;
      case "describe-close":
      case "describe-cancel":
        clearTimeout(describeTimer);
        clearTimeout(slowTimer);
        S.describe.phase = "idle";
        render();
        announce("Stopped. Nothing changed.");
        $('[data-act="describe-open"]')?.focus();
        return;
      case "describe-edit":
        S.describe.phase = "typing";
        render();
        $("#as-words")?.focus();
        return;
      case "describe-go":
        return startDescribe();
      case "idea":
        S.describe.pick = Number(value);
        renderPreview();
        renderPanel();
        announce(`Idea ${Number(value) + 1}: ${describe(S.describe.ideas[S.describe.pick])}`);
        return;
      case "idea-use":
        return useIdea();
      case "upload":
        $("#as-file")?.click();
        return;
      case "next":
        if (!S.name.trim()) {
          S.nameError = true;
          renderNameNote();
          $("#as-name")?.focus();
          announce("Give your bot a name first");
          return;
        }
        clearTimeout(nameTimer);
        clearTimeout(settleTimer);
        if (S.source === "name") S.choice = A.nameChoice(S.name);
        S.typing = false;
        S.state = "idle";
        S.step = "account";
        render();
        $("#as-title")?.focus();
        announce("Account");
        return;
      case "back":
        S.step = "build";
        render();
        $("#as-title")?.focus();
        return;
      case "account":
        return;
      case "create":
      case "save":
        return write();
      case "close":
        return close();
      case "open":
        open();
        return;
      case "chat-use":
        S.chat = "saved";
        mount();
        announce("Juniper's picture changed");
        return;
      case "chat-no":
        S.chat = "declined";
        mount();
        announce("Kept its picture");
        return;
      case "chat-undo":
        S.chat = "proposed";
        mount();
        announce("Juniper's picture is back as it was");
        return;
      case "chat-check":
        S.chat = "saved";
        mount();
        announce("Read from the gateway: Juniper's picture changed");
        return;
      case "chat-open":
        location.search = "?view=studio&mode=edit&family=lantern&body=round&lure=hook&eyes=two&color=sky&head=headphones&trim=violet";
        return;
    }
  }

  function wire(root) {
    root.addEventListener("click", (event) => {
      const el = event.target.closest("[data-act]");
      if (el && !el.disabled) act(el);
    });
    root.addEventListener("keydown", (event) => {
      if (trapKeys(event) || radioKeys(event) || tabKeys(event)) return;
      if (event.key === "Enter" && event.target.id === "as-words" && !event.shiftKey) {
        event.preventDefault();
        startDescribe();
      }
      if (event.key === "Escape" && S.open && S.view === "studio") {
        event.preventDefault();
        if (S.playing) stopStates();
        else if (S.describe.phase === "waiting") act({ dataset: { act: "describe-cancel" } });
        else close();
      }
    });
    root.addEventListener("input", (event) => {
      if (event.target.id === "as-words") S.describe.text = event.target.value;
      if (event.target.id === "as-name") nameTyped(event.target.value);
    });
    root.addEventListener("change", (event) => {
      if (event.target.id !== "as-file") return;
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      // Only the latest upload may finish.
      const token = ++uploadToken;
      S.uploading += 1;
      renderFoot();
      uploaded(file)
        .then(
          (url) => {
            if (token !== uploadToken) return;
            const item = { id: `u${Date.now()}`, kind: "picture", url };
            keepCustom(item);
            S.undo = null;
            S.picture = { url, label: "Your picture", kind: "upload" };
            if (S.mode === "new") S.source = "manual";
            S.selectedCustom = item.id;
            render();
            announce("Your picture is in the preview");
          },
          (error) => {
            if (token !== uploadToken) return;
            const box = $("#as-upload-error");
            if (box) {
              box.hidden = false;
              box.textContent = error.message;
            }
          },
        )
        .finally(() => {
          S.uploading -= 1;
          renderFoot();
        });
    });
  }

  // Mounting ----------------------------------------------------------------------------------

  function mount() {
    const frame = $("#as-frame");
    clearTimeout(beatTimer);
    if (S.view === "board") {
      document.documentElement.dataset.view = "board";
      frame.innerHTML = `<div class="as-board-page">${board("dark")}${board("light")}</div>`;
      // The saved still for each row, drawn and read back as the app would.
      BOARD_ROWS.forEach((row, r) =>
        savedPicture(A.tidy(row.choice)).then((url) => {
          for (const slot of document.querySelectorAll(`[data-saved="${r}"] .as-saved`)) slot.innerHTML = url ? `<img src="${url}" alt="" />` : "";
        }),
      );
      if (params.get("peak") === "1") holdPeaks();
      return;
    }
    document.documentElement.dataset.view = S.view;
    if (S.view === "chat") {
      frame.innerHTML = chat();
      CT.hydrate(frame);
      if (S.chat === "picture")
        pixelPicture(A.tidy({ family: "clawling", body: "tall", eyes: "splayed", claws: "fiddler", color: "green", head: "beret", trim: "violet" }), "#f1e7d6").then((url) => {
          const slot = $("#as-raster");
          if (slot && url) slot.innerHTML = `<img src="${url}" alt="" />`;
        });
      return;
    }
    if (!S.open) {
      frame.innerHTML = backdrop() + closed();
      CT.hydrate(frame);
      return;
    }
    frame.innerHTML = backdrop() + studio();
    CT.hydrate(frame);
    render();
    // Focus when the studio opens: the name in New bot, the title in Edit picture.
    (S.mode === "new" && S.step === "build" ? $("#as-name") : $("#as-title"))?.focus({ preventScroll: true });
    // Describe states reached from the address, for review and screenshots.
    const phase = params.get("describe");
    const text = (fallback) => (S.describe.text ||= fallback);
    if (phase === "result" || phase === "guard") {
      const words = text(phase === "guard" ? "A red lobster who loves the beach" : "A night owl who loves jazz records");
      finishDescribe(words, A.parseIdeasReply(simulatedReply(words, 0)).ideas);
    } else if (phase === "waiting" || phase === "slow" || phase === "retry") {
      text("A night owl who loves jazz records");
      S.describe.phase = "waiting";
      S.describe.slow = phase === "slow";
      S.describe.attempt = phase === "retry" ? 1 : 0;
      render();
    } else if (phase === "typing" || phase === "unavailable") {
      text("A night owl who loves jazz records");
      render();
    } else if (phase === "failed") {
      text("Something nobody could draw");
      failDescribe();
    }
    if (S.state !== "idle") renderPreview();
  }

  // The bar's own controls for this page: the view, and New bot or Edit picture.
  function extras() {
    const box = document.getElementById("proto-extra");
    if (!box) return;
    const link = (q, text, on) => `<a href="?${q}"${on ? ' aria-current="page"' : ""}>${text}</a>`;
    box.innerHTML =
      `<span class="proto-seg">View<span>` +
      link("view=studio&mode=new", "New bot", S.view === "studio" && S.mode === "new") +
      link("view=studio&mode=edit", "Edit picture", S.view === "studio" && S.mode === "edit") +
      link("view=chat", "Chat", S.view === "chat") +
      link("view=board", "Board", S.view === "board" && params.get("peak") !== "1") +
      link("view=board&peak=1", "Board at peaks", S.view === "board" && params.get("peak") === "1") +
      `</span></span>`;
  }

  document.addEventListener("DOMContentLoaded", () => {
    extras();
    seedCustom();
    wire(document.getElementById("as-frame"));
    mount();
  });
  // With motion reduced, a beat or a look at the name in progress ends at once.
  document.addEventListener("ct:settings", () => {
    if (reduced() && (S.state === "done" || S.typing) && !S.playing && S.view === "studio") {
      clearTimeout(beatTimer);
      S.typing = false;
      S.state = "idle";
      renderPreview();
    }
  });

  window.CTStudio = { S, describe, creature, act, savedPicture, holdPeaks, simulatedReply, NAME_DEBOUNCE_MS, NAME_SETTLE_MS };
})();
