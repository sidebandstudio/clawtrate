// The home page's script: the install commands, the film, the questions,
// and the entrances. theme.js is the theme switch; claws.js adds the Claws and the logo row.
// The page reads fully without either, in dark.
// Screens follow the theme through CSS, so the first paint is already right.

(function () {
  // Copy the install command. The label says what happened, then goes back.
  document.querySelectorAll("[data-copy]").forEach((button) => {
    let reset = 0;
    const restore = () => {
      clearTimeout(reset);
      reset = 0;
      button.textContent = "Copy";
    };
    button.addEventListener("click", async () => {
      let said;
      try {
        await navigator.clipboard.writeText(button.parentElement.querySelector("code").textContent);
        said = "Copied";
      } catch {
        const code = button.parentElement.querySelector("code");
        window.getSelection().selectAllChildren(code);
        said = "Selected";
      }
      if (document.hidden) return;
      clearTimeout(reset);
      button.textContent = said;
      reset = setTimeout(restore, 1800);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && reset) restore();
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

  // The film: a play button over the poster. The video is fetched when it is pressed.
  // Without script the video keeps its own controls.
  const film = document.querySelector("[data-film]");
  const video = film.querySelector("video");
  const play = film.querySelector("[data-film-play]");
  video.controls = false;
  play.hidden = false;
  play.addEventListener("click", () => {
    play.hidden = true;
    video.controls = true;
    video.focus();
    // A refused play leaves the video's own controls to start it.
    video.play().catch(() => {});
  });
  video.addEventListener("play", () => (film.dataset.state = "playing"));
  video.addEventListener("pause", () => (film.dataset.state = video.ended ? "ended" : "idle"));

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
