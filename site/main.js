// The site's only script: the theme switch, copy buttons, the approval demo,
// the questions, and the entrances. The page reads fully without it.

(function () {
  const root = document.documentElement;
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const isDark = () => (root.dataset.theme ? root.dataset.theme === "dark" : darkQuery.matches);

  // Screenshots follow the page's theme, also when it is chosen by hand.
  function syncShots() {
    const dark = isDark();
    document.querySelectorAll("picture").forEach((picture) => {
      const img = picture.querySelector("img");
      const source = picture.querySelector("source[data-dark]");
      if (!img || !source) return;
      source.media = root.dataset.theme ? "not all" : "(prefers-color-scheme: dark)";
      img.src = dark && root.dataset.theme ? img.dataset.darkSrc : img.dataset.lightSrc;
    });
  }

  const toggle = document.querySelector("[data-theme-toggle]");
  function labelToggle() {
    toggle.setAttribute("aria-label", isDark() ? "Switch to light" : "Switch to dark");
  }
  toggle.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {
      // Without storage the choice lasts for this visit.
    }
    labelToggle();
    syncShots();
  });
  darkQuery.addEventListener("change", () => {
    labelToggle();
    syncShots();
  });
  labelToggle();
  syncShots();

  // Copy the install command.
  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        button.textContent = "Copied";
      } catch {
        const code = button.parentElement.querySelector("code");
        window.getSelection().selectAllChildren(code);
        button.textContent = "Selected";
      }
      setTimeout(() => (button.textContent = "Copy"), 1800);
    });
  });

  // The approval demo: Allow once or Deny, then ask again.
  const demo = document.querySelector(".demo");
  const tag = demo.querySelector("[data-tag]");
  const live = demo.querySelector(".demo-live");
  const pill = demo.querySelector(".pill img");
  const states = {
    pending: { tag: "Needs approval", face: "bots/otto.svg", say: "" },
    allowed: {
      tag: "Allowed once",
      face: "bots/otto-done.svg",
      say: "Allowed once. Otto ran the command.",
    },
    denied: { tag: "Denied", face: "bots/otto-blocked.svg", say: "Denied. Otto changed nothing." },
  };
  function show(state, focus) {
    demo.dataset.state = state;
    tag.textContent = states[state].tag;
    pill.src = states[state].face;
    live.textContent = states[state].say;
    if (focus) focus.focus();
  }
  demo.querySelectorAll("[data-answer]").forEach((button) => {
    button.addEventListener("click", () => {
      show(
        button.dataset.answer === "allow" ? "allowed" : "denied",
        demo.querySelector("[data-reset]"),
      );
    });
  });
  demo.querySelector("[data-reset]").addEventListener("click", () => {
    show("pending", demo.querySelector('[data-answer="allow"]'));
  });

  // Questions: one open at a time. On wide screens the open answer sits to the right.
  const faq = document.querySelector("[data-faq]");
  const questions = [...faq.querySelectorAll("button[aria-controls]")];
  const wide = window.matchMedia("(min-width: 761px)");
  function open(button) {
    questions.forEach((each) => {
      const on = each === button;
      each.setAttribute("aria-expanded", String(on));
      document.getElementById(each.getAttribute("aria-controls")).hidden = !on;
    });
  }
  questions.forEach((button, index) => {
    button.addEventListener("click", () => {
      const already = button.getAttribute("aria-expanded") === "true";
      if (already && !wide.matches) {
        button.setAttribute("aria-expanded", "false");
        document.getElementById(button.getAttribute("aria-controls")).hidden = true;
      } else open(button);
    });
    button.addEventListener("mouseenter", () => wide.matches && open(button));
    button.addEventListener("keydown", (event) => {
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const next = questions[(index + step + questions.length) % questions.length];
      next.focus();
      if (wide.matches) open(next);
    });
  });

  // Entrances: the parts that arrive together rise in turn, once.
  const parts = [...document.querySelectorAll(".rise")];
  if (!("IntersectionObserver" in window)) {
    parts.forEach((el) => el.classList.add("in"));
    return;
  }
  const watcher = new IntersectionObserver(
    (entries) => {
      entries
        .filter((entry) => entry.isIntersecting)
        .forEach((entry, index) => {
          entry.target.style.setProperty("--i", String(Math.min(index, 5)));
          entry.target.classList.add("in");
          watcher.unobserve(entry.target);
        });
    },
    { rootMargin: "0px 0px -2% 0px" },
  );
  parts.forEach((el) => watcher.observe(el));
})();
