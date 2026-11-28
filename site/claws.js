// The Claws and the logo row, on both pages. A Claw rests in one state,
// reacts while the pointer or focus is in its zone, and plays a moment when
// pressed. Under reduced motion each state is a still pose. Without this
// script each Claw shows its resting pose as a disabled button, and the logos
// show at once.

(function () {
  document.querySelectorAll("[data-claw]").forEach((claw) => {
    const art = claw.querySelector(".claw-art");
    const zone = claw.closest("[data-claw-zone]") || claw;
    // Other controls that wake this Claw too, such as the download button beside it.
    const cues = claw.id ? [...document.querySelectorAll(`[data-claw-cue="${claw.id}"]`)] : [];
    const moment = claw.dataset.moment.split(" ").map((step) => {
      const [state, ms] = step.split(":");
      return { state, ms: Number(ms) };
    });
    let rest = art.dataset.state;
    let near = 0;
    let timer = 0;
    let playing = false;

    function settle() {
      if (!playing) art.dataset.state = near > 0 ? claw.dataset.react : rest;
    }
    function play(index) {
      if (index >= moment.length) {
        playing = false;
        zone.removeAttribute("data-burst");
        settle();
        return;
      }
      art.dataset.state = moment[index].state;
      timer = setTimeout(() => play(index + 1), moment[index].ms);
    }

    for (const target of [zone, ...cues]) {
      let inside = false;
      let focused = false;
      const update = (pointer, focus) => {
        const was = inside || focused;
        inside = pointer;
        focused = focus;
        const is = inside || focused;
        if (is !== was) near += is ? 1 : -1;
        settle();
      };
      target.addEventListener("pointerenter", () => update(true, focused));
      target.addEventListener("pointerleave", () => update(false, focused));
      target.addEventListener("focusin", () => update(inside, true));
      target.addEventListener("focusout", (event) => {
        if (!target.contains(event.relatedTarget)) update(inside, false);
      });
    }

    let burst = 0;
    claw.addEventListener("click", () => {
      clearTimeout(timer);
      cancelAnimationFrame(burst);
      playing = true;
      // Restart the bubbles two frames later, even when pressed again mid-moment:
      // with one frame the browser can merge the removal and the re-add, and the
      // bubbles keep their old timeline.
      zone.removeAttribute("data-burst");
      burst = requestAnimationFrame(() => {
        burst = requestAnimationFrame(() => {
          burst = 0;
          zone.setAttribute("data-burst", "");
        });
      });
      play(0);
    });
    // A hidden page ends the moment where it is.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) return;
      clearTimeout(timer);
      cancelAnimationFrame(burst);
      timer = 0;
      playing = false;
      zone.removeAttribute("data-burst");
      settle();
    });
    claw.setAttribute("aria-label", `${claw.getAttribute("aria-label")} Press to play.`);
    claw.disabled = false;

    // On the home page the Claw follows the film: it leans in while the film
    // plays and celebrates when it ends.
    const film = claw.closest("[data-film]");
    if (film) {
      const poses = { idle: art.dataset.state, playing: "waiting", ended: "done" };
      new MutationObserver(() => {
        rest = poses[film.dataset.state] || poses.idle;
        settle();
      }).observe(film, { attributes: true, attributeFilter: ["data-state"] });
    }
  });

  // The logo row: the logos come in one after another, once.
  const rows = document.querySelectorAll("[data-reveal]");
  if (!("IntersectionObserver" in window)) {
    rows.forEach((row) => row.classList.add("in"));
    return;
  }
  const watcher = new IntersectionObserver(
    (entries) => {
      entries
        .filter((entry) => entry.isIntersecting)
        .forEach((entry) => {
          entry.target.classList.add("in");
          watcher.unobserve(entry.target);
        });
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  rows.forEach((row) => watcher.observe(row));
})();
