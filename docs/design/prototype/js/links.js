(function () {
  const { CT } = window;
  const gateway = "a".repeat(64);
  const prefix = "clawtrate://chat?";
  const example = `${prefix}bot=marlow&gateway=${gateway}&text=${encodeURIComponent("Review the opening.")}`;
  const scene = CT.params.get("scene") || "opened";
  const raw =
    CT.params.get("link") ??
    (scene === "malformed"
      ? example + "&send=1"
      : scene === "unknown"
        ? example.replace("marlow", "missing")
        : example);

  for (const key of [...CT.params.keys()]) {
    if (!["theme", "width", "motion", "chrome"].includes(key)) CT.params.delete(key);
  }
  CT.params.set("bot", "juniper");
  if (scene === "disconnected") CT.params.set("banner", "offline");
  if (scene === "readonly" || scene === "loading") CT.params.set("state", scene);

  function parseLink(url) {
    if (url.length > 8192 || !url.startsWith(prefix)) return null;

    const values = new Map();
    for (const pair of url.slice(prefix.length).split("&")) {
      const match = /^(bot|gateway|text)=((?:[A-Za-z0-9._~-]|%[a-fA-F0-9]{2})*)$/.exec(pair);
      if (!match || match[0] !== pair || values.has(match[1])) return null;
      try {
        values.set(match[1], decodeURIComponent(match[2]));
      } catch (error) {
        if (error instanceof URIError) return null;
        throw error;
      }
    }

    const bot = values.get("bot");
    const gatewayId = values.get("gateway");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(bot ?? "") || !/^[a-f0-9]{64}$/.test(gatewayId ?? ""))
      return null;

    const normalized = values.get("text")?.replace(/\r\n?/g, "\n").replace(/\t/g, " ");
    if (
      normalized === undefined ||
      /[\p{Cc}\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(normalized.replaceAll("\n", ""))
    )
      return null;
    const text = normalized.trim();
    if (!text || [...text].length > 2000) return null;

    return { bot, gatewayId, text };
  }

  const messages = {
    malformed: "This Clawtrate link is invalid. Ask for a new link.",
    disconnected:
      "Clawtrate isn’t connected to a gateway. Connect to the right gateway, then open the link again.",
    different:
      "This link is for a different gateway. Connect to that gateway, then open the link again.",
    unavailable:
      "Clawtrate couldn’t verify the gateway or load its bots and chats. Open the link again when they’re available.",
    unknown: "This bot isn’t on the connected gateway. Check the link or ask for a new one.",
    "no-chat": "This bot has no chat to open.",
    readonly: "This device can read this chat. It can’t edit the draft.",
  };

  const status = document.querySelector("#links-status");
  const dialog = document.querySelector("#links-dialog");
  const title = document.querySelector("#links-title");
  const detail = document.querySelector("#links-detail");
  const actions = document.querySelector("#links-actions");
  const announce = (text) => {
    status.textContent = text;
  };

  function showDialog(heading, message, buttons, restore) {
    title.textContent = heading;
    detail.textContent = message;
    actions.replaceChildren();
    for (const [label, act] of buttons) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button";
      button.dataset.variant = buttons.length > 1 && !act ? "quiet" : "primary";
      button.textContent = label;
      button.addEventListener("click", () => {
        dialog.close();
        if (act) act();
      });
      actions.append(button);
    }
    dialog.onclose = () => restore()?.focus();
    dialog.showModal();
    actions.firstElementChild.focus();
  }

  CT.appExtension = {
    header() {
      announce("");
    },
    fixtures(bots) {
      if (scene === "no-chat") bots.find((bot) => bot.id === "marlow").tasks = [];
    },
    ready(app) {
      const input = () => document.querySelector(".composer-input");
      const problem = (state) =>
        showDialog("Can’t open link", messages[state], [["Close"]], () => priorFocus);

      const active = document.activeElement;
      const priorFocus = active === document.body ? document.querySelector("#title-pill") : active;
      const link = parseLink(raw);
      if (!link) return problem("malformed");
      if (scene === "loading") return;
      if (app.model.connection === "offline") return problem("disconnected");
      if (scene === "unavailable") return problem("unavailable");
      const connectedId = scene === "different" ? "b".repeat(64) : gateway;
      if (link.gatewayId !== connectedId) return problem("different");
      const bot = app.bots.find((item) => item.id === link.bot);
      if (!bot) return problem("unknown");
      if (!bot.tasks.length) return problem("no-chat");
      if (app.model.access === "read") return problem("readonly");

      if (scene === "draft") app.model.drafts.m1 = "Keep the second paragraph as it is.";
      app.selectBot(bot.id);
      const draft = input();
      function fill() {
        draft.value = link.text;
        draft.dispatchEvent(new Event("input", { bubbles: true }));
        draft.setSelectionRange(draft.value.length, draft.value.length);
        draft.focus();
        announce("Link text added to your draft. Nothing was sent.");
      }
      if (draft.value.length === 0) return fill();
      showDialog(
        "Replace your draft?",
        `You already have a draft in this chat with ${bot.name}. Replacing it discards that draft.`,
        [["Keep draft"], ["Replace draft", fill]],
        input,
      );
    },
  };

  document.addEventListener("input", (event) => {
    if (event.target.matches(".composer-input")) announce("");
  });

  // The fixture stops at editing. app.js otherwise simulates sending on Enter or Send.
  document.addEventListener(
    "click",
    (event) => {
      if (event.target.closest('[data-action="send"]')) event.stopImmediatePropagation();
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.target.matches(".composer-input") && event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      if (!dialog.open) return;
      // The app's shortcuts (a new task, for one) would rebuild the composer behind the dialog.
      event.stopPropagation();
      if (event.key !== "Tab") return;
      const first = actions.firstElementChild;
      const last = actions.lastElementChild;
      if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    },
    true,
  );

  document.addEventListener("DOMContentLoaded", () => {
    const extra = document.querySelector("#proto-extra");
    const label = document.createElement("label");
    label.textContent = "Link state ";
    const select = document.createElement("select");
    for (const [value, name] of [
      ["opened", "Opened"],
      ["loading", "Loading"],
      ["draft", "Existing draft"],
      ["malformed", "Invalid link"],
      ["disconnected", "No gateway"],
      ["different", "Different gateway"],
      ["unavailable", "Chat details unavailable"],
      ["unknown", "Unknown bot"],
      ["no-chat", "No chat"],
      ["readonly", "Read-only"],
    ]) {
      select.add(new Option(name, value, false, scene === value));
    }
    select.addEventListener("change", () => {
      const url = new URL(location.href);
      url.searchParams.delete("link");
      url.searchParams.set("scene", select.value);
      location.href = url;
    });
    label.append(select);
    extra.replaceChildren(label);
  });
})();
