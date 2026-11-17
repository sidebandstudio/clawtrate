// Behaviour for connect.html and pairing.html. No gateway is contacted: each
// action shows the state the real one would lead to.
//   connect.html?state=error   a failed attempt
//   connect.html?state=busy    an attempt in progress

(function () {
  const CT = window.CT;
  const $ = (selector) => document.querySelector(selector);
  const keep = location.search; // carry the prototype's settings to the next page

  const form = $("#connect-form");
  if (form) {
    const button = $("#connect-button");
    const error = $("#connect-error");
    const address = $("#gateway-address");
    const fail = (title, text) => {
      error.innerHTML = `<strong>${title}</strong>${text}`;
      error.hidden = false;
      button.disabled = false;
      button.textContent = "Connect";
    };
    const connect = (to) => {
      error.hidden = true;
      button.disabled = true;
      button.textContent = "Connecting…";
      setTimeout(to, 900);
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!address.value.trim()) {
        fail("Enter the gateway's address", " For example ws://gateway.local:18789.");
        return address.focus();
      }
      // An address that answers needs this device approved first.
      connect(() => (location.href = "pairing.html" + keep));
    });
    $("#dev-button").addEventListener("click", () => {
      address.value = "ws://localhost:19001";
      connect(() => (location.href = "pairing.html" + keep));
    });

    const state = CT.params.get("state");
    if (state) address.value = "ws://gateway.local:18789";
    if (state === "error") fail("Could not connect", " Nothing answered at that address. Check it, and check that the gateway is running.");
    if (state === "busy") {
      button.disabled = true;
      button.textContent = "Connecting…";
    }
  }

  const copy = $("#copy-command");
  if (copy) {
    // The status says what happened. "Copied." only after the clipboard took the
    // command; otherwise the command is selected and the status says how to copy it.
    const forced = CT.params.get("state");
    const command = $("#approve-command");
    const status = $("#copy-status");
    let statusTimer = null;
    const report = (copied) => {
      clearTimeout(statusTimer);
      if (copied) {
        copy.innerHTML = CT.icon("check");
        status.textContent = "Copied.";
        statusTimer = setTimeout(() => {
          copy.innerHTML = CT.icon("copy");
          status.textContent = "";
        }, 1500);
      } else {
        const range = document.createRange();
        range.selectNodeContents(command);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        copy.innerHTML = CT.icon("copy");
        // The selection stays, so the status stays with it.
        status.textContent = `Selected. Press ${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘C" : "Ctrl+C"} to copy.`;
      }
    };
    copy.addEventListener("click", async () => {
      if (forced === "copied") return report(true);
      if (forced === "selected") return report(false);
      try {
        await navigator.clipboard.writeText(command.textContent);
        report(true);
      } catch {
        report(false);
      }
    });
    const check = $("#check-button");
    const waiting = $("#waiting-text");
    let checks = 0;
    // The host checks again by itself; the line counts down to the next check.
    let seconds = 5;
    let prefix = "Waiting for approval";
    const tick = () => (waiting.textContent = `${prefix}, checking again in ${seconds}s`);
    tick();
    setInterval(() => {
      seconds = seconds > 1 ? seconds - 1 : 5;
      tick();
    }, 1000);
    check.addEventListener("click", () => {
      check.disabled = true;
      check.textContent = "Checking…";
      setTimeout(() => {
        checks += 1;
        // The second check finds the approval, as it would once someone ran the command.
        if (checks > 1) return (location.href = "app.html" + keep);
        check.disabled = false;
        check.textContent = "Check now";
        prefix = "Not approved yet";
        seconds = 5;
        tick();
      }, 800);
    });
    $("#other-gateway").href = "connect.html" + keep;
    if (forced === "copied" || forced === "selected") copy.click();
  }
})();
