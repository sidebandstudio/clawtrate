// The theme switch, on both pages. Dark is the default; a choice of light is
// kept in localStorage, which each page's head reads before the first paint.

(function () {
  const root = document.documentElement;
  const isLight = () => root.dataset.theme === "light";
  const toggle = document.querySelector("[data-theme-toggle]");
  if (!toggle) return;
  function labelToggle() {
    toggle.setAttribute("aria-label", isLight() ? "Switch to dark" : "Switch to light");
  }
  toggle.addEventListener("click", () => {
    const next = isLight() ? "dark" : "light";
    if (next === "light") root.dataset.theme = "light";
    else delete root.dataset.theme;
    try {
      localStorage.setItem("theme", next);
    } catch {
      // Without storage the choice lasts for this visit.
    }
    labelToggle();
  });
  labelToggle();
})();
