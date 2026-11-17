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
    copy.addEventListener("click", () => {
      navigator.clipboard?.writeText($("#approve-command").textContent).catch(() => {});
      copy.innerHTML = CT.icon("check");
      $("#copy-status").textContent = "Copied";
      setTimeout(() => {
        copy.innerHTML = CT.icon("copy");
        $("#copy-status").textContent = "";
      }, 1600);
    });
    const check = $("#check-button");
    const waiting = $("#waiting-text");
    let checks = 0;
    check.addEventListener("click", () => {
      check.disabled = true;
      check.textContent = "Checking…";
      setTimeout(() => {
        checks += 1;
        // The second check finds the approval, as it would once someone ran the command.
        if (checks > 1) return (location.href = "app.html" + keep);
        check.disabled = false;
        check.textContent = "Check now";
        waiting.textContent = "Not approved yet. Still waiting";
      }, 800);
    });
    $("#other-gateway").href = "connect.html" + keep;
    if (CT.params.get("state") === "copied") copy.click();
  }
})();
