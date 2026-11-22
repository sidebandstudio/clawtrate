// The parade at the page's end: Claws from the avatar spec, each with its own
// habit. Their eyes follow the pointer (on touch, the last tap); one coming
// near is noticed; a press plays the Claw's "done" beat. It runs only while
// the parade is on screen and the page is visible, and under reduced motion
// the Claws hold still poses and only a press changes them.

(function () {
  const cast = document.querySelector(".cast");
  if (!cast) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const NEAR = 150; // px from a Claw's middle that counts as near
  const random = (from, to) => from + Math.random() * (to - from);

  const claws = [...cast.querySelectorAll(".pc")].map((el) => {
    const art = el.querySelector(".claw-art");
    const [gx, gy] = art.dataset.gaze.split(" ").map(Number);
    return {
      el,
      art,
      act: el.dataset.act,
      rest: "idle",
      gaze: [gx, gy],
      near: false,
      timer: 0,
      beat: 0,
    };
  });

  function pose(claw, state) {
    if (claw.art.dataset.state === state) return;
    // A Shellfolk ducking in or peeking out squashes a little.
    if (claw.act === "duck") {
      claw.el.classList.remove("swap");
      void claw.el.offsetWidth;
      claw.el.classList.add("swap");
    }
    claw.art.dataset.state = state;
  }
  function settle(claw) {
    if (!claw.beat) pose(claw, claw.rest);
  }

  // A press or tap: the done beat, then back to what it was doing.
  claws.forEach((claw) => {
    claw.el.addEventListener("click", () => {
      clearTimeout(claw.beat);
      claw.art.removeAttribute("data-doze");
      pose(claw, "done");
      claw.beat = setTimeout(() => {
        claw.beat = 0;
        settle(claw);
      }, 1700);
    });
  });
  if (reduce) return;
  cast.setAttribute("data-paused", "");

  // Each habit, as a loop of timeouts that stops when the parade is paused.
  const habits = {
    think(claw) {
      claw.timer = setTimeout(
        () => {
          claw.rest = "thinking";
          settle(claw);
          claw.timer = setTimeout(() => {
            claw.rest = "idle";
            settle(claw);
            habits.think(claw);
          }, 2800);
        },
        random(2500, 5000),
      );
    },
    duck(claw) {
      claw.timer = setTimeout(
        () => {
          if (claw.near) return habits.duck(claw);
          claw.rest = "blocked";
          settle(claw);
          claw.timer = setTimeout(
            () => {
              claw.rest = "idle";
              settle(claw);
              habits.duck(claw);
            },
            random(1600, 2600),
          );
        },
        random(3500, 6500),
      );
    },
    busy(claw) {
      claw.timer = setTimeout(
        () => {
          claw.rest = claw.rest === "working" ? "idle" : "working";
          settle(claw);
          habits.busy(claw);
        },
        claw.rest === "working" ? random(2400, 3400) : random(2000, 3600),
      );
    },
    look(claw) {
      claw.timer = setTimeout(
        () => {
          // Looks around on its own while the pointer is still or absent.
          if (performance.now() - lastMove > 2500) {
            const angle = random(0, Math.PI * 2);
            lookAt(claw, Math.cos(angle) * 1.1, Math.sin(angle) * 0.8);
          }
          habits.look(claw);
        },
        random(900, 2200),
      );
    },
    doze(claw) {
      claw.art.setAttribute("data-doze", "");
    },
  };

  function lookAt(claw, x, y) {
    claw.art.style.setProperty("--look-x", `${(x - claw.gaze[0]).toFixed(2)}px`);
    claw.art.style.setProperty("--look-y", `${(y - claw.gaze[1]).toFixed(2)}px`);
  }

  // Coming near: noticed with a hop, woken from a doze, waved at, or brought out of a shell.
  function nearChanged(claw, near) {
    claw.near = near;
    if (claw.act === "wave") {
      claw.rest = near ? "waiting" : "idle";
      settle(claw);
      return;
    }
    if (claw.act === "doze") {
      clearTimeout(claw.timer);
      if (near) claw.art.removeAttribute("data-doze");
      else claw.timer = setTimeout(() => claw.art.setAttribute("data-doze", ""), 4000);
    }
    if (claw.act === "duck" && near && claw.rest === "blocked") {
      claw.rest = "idle";
      settle(claw);
    }
    if (near && claw.art.dataset.state !== "done") {
      claw.el.classList.remove("noticed");
      void claw.el.offsetWidth;
      claw.el.classList.add("noticed");
    }
  }

  // One pointer listener for the whole parade, read once per frame.
  let pointer = null;
  let lastMove = -Infinity;
  let frame = 0;
  function onPointer(event) {
    pointer = { x: event.clientX, y: event.clientY };
    lastMove = performance.now();
    if (!frame) frame = requestAnimationFrame(track);
  }
  function track() {
    frame = 0;
    if (!pointer) return;
    // Read every position first, then write.
    const boxes = claws.map((claw) => claw.el.getBoundingClientRect());
    claws.forEach((claw, i) => {
      const box = boxes[i];
      if (!box.width) return;
      // The eyes sit in the drawing's upper third.
      const dx = pointer.x - (box.left + box.width / 2);
      const dy = pointer.y - (box.top + box.width * 0.3);
      const distance = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, distance / 90) * 1.15;
      if (claw.act !== "doze" || !claw.art.hasAttribute("data-doze"))
        lookAt(claw, (dx / distance) * reach, (dy / distance) * reach * 0.8);
      const near = distance < NEAR;
      if (near !== claw.near) nearChanged(claw, near);
    });
  }

  let running = false;
  function start() {
    if (running) return;
    running = true;
    cast.removeAttribute("data-paused");
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("pointerdown", onPointer, { passive: true });
    claws.forEach((claw, i) => {
      // Staggered, so they never start together.
      claw.timer = setTimeout(() => habits[claw.act]?.(claw), i * 350);
    });
  }
  function stop() {
    if (!running) return;
    running = false;
    cast.setAttribute("data-paused", "");
    window.removeEventListener("pointermove", onPointer);
    window.removeEventListener("pointerdown", onPointer);
    cancelAnimationFrame(frame);
    frame = 0;
    claws.forEach((claw) => clearTimeout(claw.timer));
  }

  let visible = false;
  const update = () => (visible && !document.hidden ? start() : stop());
  document.addEventListener("visibilitychange", update);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1].isIntersecting;
      update();
    }).observe(cast);
  } else {
    visible = true;
    update();
  }
})();
