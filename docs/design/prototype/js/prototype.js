// Prototype controls: theme, width and motion. None of this is product code.
//
// Every setting can also come from the address, which is how the screenshots
// are taken:  ?theme=dark&width=phone&motion=reduce&chrome=0

(function () {
  const root = document.documentElement;
  const params = new URLSearchParams(location.search);
  const CT = (window.CT = window.CT || {});
  CT.params = params;

  const stored = (key) => {
    try {
      return localStorage.getItem(`ct-proto-${key}`);
    } catch {
      return null;
    }
  };
  const store = (key, value) => {
    try {
      localStorage.setItem(`ct-proto-${key}`, value);
    } catch {
      /* private window: settings just do not persist */
    }
  };

  const settings = {
    theme:
      params.get("theme") ||
      stored("theme") ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
    width: params.get("width") || stored("width") || "full",
    motion:
      params.get("motion") ||
      stored("motion") ||
      (matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduce" : "full"),
  };

  function apply() {
    root.dataset.theme = settings.theme;
    root.dataset.width = settings.width;
    if (settings.motion === "reduce") root.dataset.motion = "reduce";
    else delete root.dataset.motion;
    // The phone frame, or a real window that narrow, gets touch sizes.
    const touch = settings.width === "phone" || (params.get("chrome") === "0" && innerWidth < 500);
    if (touch) root.dataset.input = "touch";
    else delete root.dataset.input;
    document.querySelectorAll("[data-setting]").forEach((button) => {
      button.setAttribute("aria-pressed", String(settings[button.dataset.setting] === button.dataset.value));
    });
    document.dispatchEvent(new CustomEvent("ct:settings", { detail: settings }));
  }

  if (params.get("chrome") === "0") root.dataset.chrome = "off";
  apply();
  CT.settings = settings;

  // The app's own theme choice, used by the gateway menu: system, light or dark.
  CT.setTheme = (choice) => {
    settings.followSystem = choice === "system";
    settings.theme =
      choice === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : choice;
    store("theme", settings.theme);
    apply();
  };

  const seg = (label, key, options) =>
    `<span class="proto-seg">${label}<span>` +
    options
      .map(([value, text]) => `<button type="button" data-setting="${key}" data-value="${value}">${text}</button>`)
      .join("") +
    `</span></span>`;

  document.addEventListener("DOMContentLoaded", () => {
    const bar = document.getElementById("proto-bar");
    if (bar) {
      const page = location.pathname.split("/").pop() || "index.html";
      const link = (href, text) =>
        `<a href="${href}"${page === href ? ' aria-current="page"' : ""}>${text}</a>`;
      bar.innerHTML =
        `<strong>Clawtrate prototype</strong>` +
        link("index.html", "Index") +
        link("connect.html", "Connect") +
        link("pairing.html", "Pairing") +
        link("app.html", "App") +
        link("gallery.html", "Components") +
        link("conversation.html", "Scripted run") +
        link("work.html", "Work pane") +
        link("bots.html", "Bots") +
        link("setup.html", "Setup") +
        link("drafts.html", "Drafts") +
        `<span class="gap"></span><span id="proto-extra"></span>` +
        seg("Theme", "theme", [["light", "Light"], ["dark", "Dark"]]) +
        seg("Width", "width", [["full", "Full"], ["1100", "1100"], ["800", "800"], ["phone", "Phone"]]) +
        seg("Motion", "motion", [["full", "Full"], ["reduce", "Reduced"]]);
      bar.addEventListener("click", (event) => {
        const button = event.target.closest("[data-setting]");
        if (!button) return;
        settings[button.dataset.setting] = button.dataset.value;
        store(button.dataset.setting, button.dataset.value);
        apply();
      });
    }
    apply();
  });
})();
