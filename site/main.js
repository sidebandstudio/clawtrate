// The home page's script: the theme switch, the install commands, the approval demo,
// the questions, and the entrances. claws.js adds the Claws and the logo row.
// The page reads fully without either, in dark.
// Screens follow the theme through CSS, so the first paint is already right.

(function () {
  const root = document.documentElement;
  const isLight = () => root.dataset.theme === "light";

  const toggle = document.querySelector("[data-theme-toggle]");
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

  // Copy the install command.
  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.parentElement.querySelector("code").textContent);
        button.textContent = "Copied";
      } catch {
        const code = button.parentElement.querySelector("code");
        window.getSelection().selectAllChildren(code);
        button.textContent = "Selected";
      }
      setTimeout(() => (button.textContent = "Copy"), 1800);
    });
  });

  // Homebrew or curl: tabs over the two commands, the same choice in every box.
  const switches = [...document.querySelectorAll("[data-cmd]")];
  function choose(tool) {
    switches.forEach((box) => {
      box.querySelectorAll("[data-cmd-tabs] button").forEach((tab) => {
        const on = tab.dataset.tool === tool;
        tab.setAttribute("aria-selected", String(on));
        tab.tabIndex = on ? 0 : -1;
      });
      box.querySelectorAll(".cmd-box").forEach((panel) => {
        panel.hidden = panel.dataset.tool !== tool;
      });
    });
  }
  switches.forEach((box) => {
    const list = box.querySelector("[data-cmd-tabs]");
    const tabs = [...list.querySelectorAll("button")];
    list.setAttribute("role", "tablist");
    list.setAttribute("aria-labelledby", box.previousElementSibling.id);
    tabs.forEach((tab, index) => {
      const panel = box.querySelector(`.cmd-box[data-tool="${tab.dataset.tool}"]`);
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", panel.id);
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tab.id);
      tab.addEventListener("click", () => choose(tab.dataset.tool));
      tab.addEventListener("keydown", (event) => {
        const last = tabs.length - 1;
        const to = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: last }[event.key];
        if (to === undefined) return;
        event.preventDefault();
        const next = tabs[(to + tabs.length) % tabs.length];
        choose(next.dataset.tool);
        next.focus();
      });
    });
  });
  choose("brew");

  // The approval demo: Allow once or Deny, then reset.
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
  // Reserve the tallest state's height, so answering never moves the page.
  const win = demo.querySelector(".win");
  function fit() {
    const current = demo.dataset.state;
    win.style.minHeight = "0px";
    let tallest = 0;
    for (const state of Object.keys(states)) {
      demo.dataset.state = state;
      tallest = Math.max(tallest, win.getBoundingClientRect().height);
    }
    demo.dataset.state = current;
    win.style.minHeight = `${Math.ceil(tallest)}px`;
  }
  let fitting = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(fitting);
    fitting = requestAnimationFrame(fit);
  });
  document.fonts.ready.then(fit);
  fit();

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

  // Questions: one open at a time, chosen by click or arrow keys. On phones a
  // second click closes it.
  const faq = document.querySelector("[data-faq]");
  const questions = [...faq.querySelectorAll(".faq-q h3")].map((heading) => {
    const button = document.createElement("button");
    button.type = "button";
    button.id = heading.id;
    button.textContent = heading.textContent;
    button.setAttribute("aria-controls", heading.nextElementSibling.id);
    heading.replaceWith(button);
    return button;
  });
  const wide = window.matchMedia("(min-width: 761px)");
  const answerOf = (button) => document.getElementById(button.getAttribute("aria-controls"));
  function open(button) {
    questions.forEach((each) => {
      const on = each === button;
      each.setAttribute("aria-expanded", String(on));
      answerOf(each).hidden = !on;
    });
  }
  questions.forEach((button, index) => {
    button.addEventListener("click", () => {
      if (button.getAttribute("aria-expanded") === "true" && !wide.matches) {
        button.setAttribute("aria-expanded", "false");
        answerOf(button).hidden = true;
      } else open(button);
    });
    button.addEventListener("keydown", (event) => {
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const next = questions[(index + step + questions.length) % questions.length];
      next.focus();
      if (wide.matches) open(next);
    });
  });

  open(questions[0]);
  faq.dataset.interactive = "";

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
