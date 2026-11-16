// Small behaviours the components need, shared by the gallery and the
// scripted conversation. Expanding uses the browser's own <details>.

(function () {
  const CT = window.CT;

  document.addEventListener("click", (event) => {
    const target = event.target;

    // Readable and Raw: two views of one step.
    const viewButton = target.closest("[data-view-button]");
    if (viewButton) {
      const body = viewButton.closest(".step-body");
      const view = viewButton.dataset.viewButton;
      body.querySelectorAll("[data-view-button]").forEach((button) => {
        button.setAttribute("aria-selected", String(button === viewButton));
      });
      body.querySelectorAll("[data-view]").forEach((panel) => {
        panel.hidden = panel.dataset.view !== view;
      });
      return;
    }

    // Copy: copy the text beside the button, and say so for a moment.
    const copy = target.closest(".copy");
    if (copy) {
      event.preventDefault();
      const source =
        copy.closest(".code-head")?.nextElementSibling ||
        copy.closest(".command-line")?.querySelector("code") ||
        copy.closest("dd")?.querySelector("span");
      navigator.clipboard?.writeText(source?.textContent ?? "").catch(() => {});
      copy.dataset.copied = "true";
      copy.innerHTML = CT.icon("check");
      setTimeout(() => {
        delete copy.dataset.copied;
        copy.innerHTML = CT.icon("copy");
      }, 1400);
      return;
    }

    // Long output: show the rest.
    if (target.closest('[data-action="unclip"]')) {
      const more = target.closest(".code-more");
      more.previousElementSibling.removeAttribute("data-clipped");
      more.remove();
      return;
    }

    // Always allow: swap the buttons for the form, and back.
    const standingToggle = target.closest('[data-action="standing-open"], [data-action="standing-close"]');
    if (standingToggle) {
      const card = standingToggle.closest(".request");
      const open = standingToggle.dataset.action === "standing-open";
      card.querySelector(":scope > .request-actions").hidden = open;
      card.querySelector(".standing").hidden = !open;
      (open ? card.querySelector(".standing [aria-checked='true']") : card.querySelector('[data-action="standing-open"]'))?.focus();
      return;
    }

    // Scope and duration: one choice each, and the sentence follows.
    const radio = target.closest('.seg [role="radio"]');
    if (radio) {
      radio.parentElement.querySelectorAll('[role="radio"]').forEach((button) => {
        button.setAttribute("aria-checked", String(button === radio));
      });
      const standing = radio.closest(".standing");
      if (standing) {
        const picked = (key) => standing.querySelector(`[data-standing="${key}"] [aria-checked="true"]`).textContent;
        standing.querySelector(".standing-outcome").textContent = CT.standingOutcome(
          standing.dataset.bot,
          picked("scope"),
          picked("lasts"),
        );
      }
      return;
    }

    // Question options: one for a single choice, any number for several.
    const option = target.closest(".option");
    if (option && !option.closest("[data-live-question]")) {
      if (option.getAttribute("role") === "radio") {
        option.closest(".options").querySelectorAll(".option").forEach((other) => {
          other.setAttribute("aria-checked", String(other === option));
        });
      } else {
        option.setAttribute("aria-checked", String(option.getAttribute("aria-checked") !== "true"));
      }
    }
  });
})();
