// Icons and bot characters for the prototype, all drawn for Clawtrate.
//
// Icons: a 16px grid and a 1.6px round stroke.
// Characters: a flat body in one colour and a dark visor with two eyes.
// A bot is a body shape, a colour, a tilt and a direction to look in.
//
// Markup asks for them with attributes, and this file fills them in:
//   <span class="avatar" data-bot="otto"></span>
//   <i data-icon="search"></i>

(function () {
  const icons = {
    chevron: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
    back: '<path d="M10 3.5 5.5 8l4.5 4.5"/>',
    check: '<path d="m3.25 8.5 3 3 6.5-7"/>',
    x: '<path d="m4 4 8 8M12 4l-8 8"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    search: '<circle cx="7.1" cy="7.1" r="4.35"/><path d="m10.4 10.4 3.1 3.1"/>',
    settings:
      '<path d="M2.75 5h5.5M11.75 5h1.5M2.75 11h1.5M7.75 11h5.5"/><circle cx="10" cy="5" r="1.75"/><circle cx="6" cy="11" r="1.75"/>',
    panel: '<rect x="2" y="2.75" width="12" height="10.5" rx="2.5"/><path d="M10 2.75v10.5"/>',
    sidebar: '<rect x="2" y="2.75" width="12" height="10.5" rx="2.5"/><path d="M6 2.75v10.5"/>',
    copy: '<rect x="5.25" y="5.25" width="8" height="8" rx="2"/><path d="M10.75 5.25V4a1.25 1.25 0 0 0-1.25-1.25H4A1.25 1.25 0 0 0 2.75 4v5.5A1.25 1.25 0 0 0 4 10.75h1.25"/>',
    "arrow-up": '<path d="M8 12.75V3.5M4.25 7.25 8 3.5l3.75 3.75"/>',
    "arrow-down": '<path d="M8 3.25v9.25M4.25 8.75 8 12.5l3.75-3.75"/>',
    external: '<path d="M6.75 3.25h-3.5v9.5h9.5v-3.5M9.5 3.25h3.25V6.5M12.5 3.5 7.75 8.25"/>',
    warning: '<path d="M8 2.75 14 13H2L8 2.75ZM8 6.75v3M8 11.5v.05"/>',
    retry: '<path d="M12.75 8a4.75 4.75 0 1 1-1.4-3.36M12.75 2.5v2.75H10"/>',
    clock: '<circle cx="8" cy="8" r="5.75"/><path d="M8 4.75V8l2.25 1.5"/>',
    lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.75"/><path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7"/>',
    eye: '<path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8Z"/><circle cx="8" cy="8" r="1.9"/>',
    file: '<path d="M4 2.75h5.25L12 5.5v7.75H4V2.75ZM9 2.75V5.5h3"/>',
    screen: '<rect x="2.25" y="3" width="11.5" height="8" rx="1.75"/><path d="M6 13.5h4M8 11v2.5"/>',
    sun: '<circle cx="8" cy="8" r="2.75"/><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05"/>',
    moon: '<path d="M13.25 9.6A5.5 5.5 0 0 1 6.4 2.75a5.5 5.5 0 1 0 6.85 6.85Z"/>',

    // Step kinds, used by the conversation components.
    read: '<path d="M4 2.75h5.25L12 5.5v7.75H4V2.75ZM9 2.75V5.5h3M6.25 8.5h3.5M6.25 10.75h3.5"/>',
    write: '<path d="m3 13 .7-2.9 6.9-6.9a1.45 1.45 0 0 1 2.05 2.05l-6.9 6.9L3 13ZM9.6 4.2l2.1 2.1"/>',
    list: '<path d="M2.5 4.5c0-.7.55-1.25 1.25-1.25h2.5L7.6 4.75h4.65c.7 0 1.25.55 1.25 1.25v5.5c0 .7-.55 1.25-1.25 1.25h-8.5c-.7 0-1.25-.55-1.25-1.25v-7Z"/>',
    web: '<circle cx="8" cy="8" r="5.75"/><path d="M2.25 8h11.5M8 2.25c1.75 1.6 2.6 3.5 2.6 5.75s-.85 4.15-2.6 5.75M8 2.25C6.25 3.85 5.4 5.75 5.4 8s.85 4.15 2.6 5.75"/>',
    command: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="m4.75 6.5 2 1.75-2 1.75M8.5 10h2.75"/>',
    thought: '<circle cx="8" cy="8" r="1.4"/><path d="M4.3 4.9a4.9 4.9 0 0 0 0 6.2M11.7 4.9a4.9 4.9 0 0 1 0 6.2"/>',
    message: '<path d="M3 4.25c0-.83.67-1.5 1.5-1.5h7c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5H7.6l-2.85 2.5v-2.5H4.5c-.83 0-1.5-.67-1.5-1.5v-5Z"/>',
    code: '<path d="M5.5 5.25 2.75 8l2.75 2.75M10.5 5.25 13.25 8l-2.75 2.75M9.1 3.75l-2.2 8.5"/>',
    approval: '<path d="m8 2.25 4.75 1.75v3.9c0 2.7-1.9 4.9-4.75 5.85-2.85-.95-4.75-3.15-4.75-5.85V4L8 2.25ZM6 8l1.5 1.5 2.75-3"/>',
    memory: '<path d="M4.5 2.75h7v10.5L8 10.75l-3.5 2.5V2.75Z"/>',
    tool: '<path d="M8 2.5 13.5 8 8 13.5 2.5 8 8 2.5Z"/>',
    queue: '<path d="M3 4.5h10M3 8h7M3 11.5h4"/>',
    "new-task": '<rect x="2.75" y="2.75" width="10.5" height="10.5" rx="2.25"/><path d="M8 5.75v4.5M5.75 8h4.5"/>',
  };

  // Body shapes, on a 40px grid.
  const bodies = {
    pebble: '<ellipse cx="20" cy="20.5" rx="17.5" ry="15.5" transform="rotate(-10 20 20)"/>',
    block: '<rect x="3.5" y="4.5" width="33" height="31" rx="11"/>',
    arch: '<path d="M5 19.5a15 15 0 0 1 30 0V30a6 6 0 0 1-6 6H11a6 6 0 0 1-6-6V19.5Z"/>',
    bloom:
      '<circle cx="20" cy="20" r="11"/>' +
      [0, 60, 120, 180, 240, 300]
        .map((a) => `<circle cx="20" cy="9.6" r="7.4" transform="rotate(${a} 20 20)"/>`)
        .join(""),
    disc: '<circle cx="20" cy="20" r="17"/>',
    hex: '<path d="M20 6.5 31.7 13.2v13.6L20 33.5 8.3 26.8V13.2L20 6.5Z" stroke-width="6" stroke-linejoin="round"/>',
    drop: '<path d="M20 3.5c8.8 0 15.5 6.2 15.5 14.6 0 9-7.2 15.3-15.5 18.4C11.7 33.4 4.5 27.1 4.5 18.1 4.5 9.7 11.2 3.500 20 3.5Z"/>',
    gem: '<rect x="7.5" y="7.5" width="25" height="25" rx="8" transform="rotate(45 20 20)"/>',
  };

  // The seed bots, plus four more characters for the connection screen.
  const bots = {
    juniper: { body: "pebble", color: "#58c26f", tilt: -7, look: [0.6, -0.3] },
    otto: { body: "block", color: "#5b8dff", tilt: 0, look: [0.9, 0.2] },
    marlow: { body: "arch", color: "#ff8552", tilt: 5, look: [-0.7, 0.3], lift: -1.5 },
    pip: { body: "bloom", color: "#a98bff", tilt: -5, look: [0, -0.5] },
    extra1: { body: "disc", color: "#f6bd3b", tilt: 6, look: [0.8, 0] },
    extra2: { body: "hex", color: "#ff6f9c", tilt: -4, look: [-0.8, 0.2] },
    extra3: { body: "drop", color: "#45bdf5", tilt: 3, look: [0.3, 0.5], lift: 1 },
    extra4: { body: "gem", color: "#a5d955", tilt: 0, look: [-0.4, -0.4] },
  };

  // The eyes say the state. idle: looking the bot's own way. thinking: turned
  // up. working: straight ahead. waiting: wide, on the viewer. blocked and
  // failed: half closed. done: smiling.
  function eyes(state, look, y) {
    let [lx, ly] = look;
    const at = (x, shape) => shape(x + lx, y + ly);
    let shape = (x, cy) => `<circle cx="${x}" cy="${cy}" r="2.05"/>`;
    if (state === "thinking") [lx, ly] = [lx * 0.4, -1.7];
    if (state === "working") [lx, ly] = [0, 0];
    if (state === "waiting") {
      [lx, ly] = [0, 0];
      shape = (x, cy) => `<circle cx="${x}" cy="${cy}" r="2.65"/>`;
    }
    if (state === "blocked" || state === "failed") {
      [lx, ly] = [0, 0.8];
      shape = (x, cy) => `<ellipse cx="${x}" cy="${cy}" rx="2.2" ry="0.85"/>`;
    }
    if (state === "done") {
      [lx, ly] = [0, 0];
      shape = (x, cy) =>
        `<path d="M${x - 2.1} ${cy + 0.9}Q${x} ${cy - 2.6} ${x + 2.1} ${cy + 0.9}" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>`;
    }
    return `<g class="eyes" fill="#fff">${at(15.8, shape)}${at(24.2, shape)}</g>`;
  }

  function character(id, state = "idle") {
    const bot = bots[id];
    if (!bot) return "";
    const y = 19.3 + (bot.lift || 0);
    return (
      `<svg viewBox="0 0 40 40" aria-hidden="true">` +
      `<g fill="${bot.color}" stroke="${bot.color}" stroke-width="0">${bodies[bot.body]}</g>` +
      `<g transform="rotate(${bot.tilt} 20 ${y})">` +
      `<rect x="8.8" y="${y - 4.8}" width="22.4" height="9.6" rx="4.8" fill="#16181b"/>` +
      eyes(state, bot.look, y) +
      `</g></svg>`
    );
  }

  const icon = (name, cls = "icon") =>
    `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true">${icons[name] || ""}</svg>`;

  function hydrate(root = document) {
    root.querySelectorAll("[data-icon]").forEach((el) => {
      el.outerHTML = icon(el.dataset.icon, el.className ? `icon ${el.className}` : "icon");
    });
    root.querySelectorAll("[data-bot]:empty").forEach((el) => {
      el.innerHTML = character(el.dataset.bot, el.dataset.state);
    });
  }

  document.addEventListener("DOMContentLoaded", () => hydrate());

  window.CT = Object.assign(window.CT || {}, { icon, character, hydrate, botArt: bots });
})();
