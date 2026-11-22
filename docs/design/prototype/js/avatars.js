// The avatars page: the creatures drawn from the shared spec (creatures.js),
// as the app's renderer draws them (packages/ui/src/Avatar.tsx). Not product code.

(function () {
  const C = window.ClawtrateCreatures;
  const SIZES = [18, 22, 32, 40, 56];
  const ROWS = [
    { name: "Atlas", choice: C.defaultAvatar("atlas"), note: "no choice: its Clawling" },
    { name: "Juniper", choice: { family: "clawling", body: "tall", eyes: "splayed", claws: "fiddler", color: "green" } },
    { name: "Wren", choice: { family: "shellfolk", shell: "spiral", color: "blue" } },
    { name: "Otto", choice: { family: "lantern", body: "round", lure: "hook", eyes: "two", color: "sky" } },
  ];
  const WORDS = { clawling: "Clawlings", shellfolk: "Shellfolk", lantern: "Lanterns" };

  // The spec's keyframes as CSS, as the app adds them.
  const keyframes = Object.entries(C.AVATAR_MOTIONS)
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
      const m = C.AVATAR_MOTIONS[s.motion];
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

  function creature(choice, state, id) {
    const scene = C.avatarScene(choice, state, C.avatarVariation(id));
    const clip = `pc${++clips}`;
    const defs = Object.entries(C.AVATAR_EYE_CLIP)
      .map(([name, r]) => `<clipPath id="${clip}-${name}"><circle r="${r}"/></clipPath>`)
      .join("");
    return (
      `<svg viewBox="0 0 40 40" class="creature" data-family="${choice.family}" data-state="${state}"` +
      `${scene.muted ? " data-muted" : ""} aria-hidden="true"><defs>${defs}</defs><g transform="translate(${scene.shift[0]} ${scene.shift[1]}) translate(20 20) scale(${scene.fit}) translate(-20 -20)">${shape(scene.root, clip)}</g></svg>`
    );
  }

  const avatar = (choice, state, id, size) =>
    `<span class="avatar" style="width:${size}px;height:${size}px">${creature(choice, state, id)}</span>`;

  function parts(family) {
    const color = family === "clawling" ? "blue" : family === "shellfolk" ? "pink" : "lime";
    const base = C.firstChoice(family, color);
    return Object.entries(C.AVATAR_PARTS[family])
      .map(([key, values]) =>
        values
          .map((value) => `<span>${avatar({ ...base, [key]: value }, "idle", "parts", 32)}${key}: ${value}</span>`)
          .join(""),
      )
      .join("");
  }

  function board(theme) {
    const head = `<tr><th></th>${C.AVATAR_STATES.map((s) => `<th>${s}</th>`).join("")}</tr>`;
    const rows = SIZES.flatMap((size) =>
      ROWS.map(
        (row) =>
          `<tr><th>${row.name}, ${WORDS[row.choice.family]}, ${size} px</th>` +
          C.AVATAR_STATES.map(
            (state) =>
              `<td data-size="${size}" data-state="${state}" data-family="${row.choice.family}">${avatar(row.choice, state, row.name.toLowerCase(), size)}</td>`,
          ).join("") +
          `</tr>`,
      ),
    ).join("");
    return (
      `<section class="av-board" data-theme="${theme}" data-board="${theme}">` +
      `<h2>${theme === "dark" ? "Dark" : "Light"}</h2>` +
      `<table><thead>${head}</thead><tbody>${rows}</tbody></table>` +
      C.AVATAR_FAMILIES.map((f) => `<h2>${WORDS[f]}: the parts</h2><div class="av-parts">${parts(f)}</div>`).join("") +
      `</section>`
    );
  }

  document.getElementById("avatars").innerHTML = board("dark") + board("light");
})();
