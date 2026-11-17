# Clawtrate computer plugin

`clawtrate-computer` is a plugin for an OpenClaw gateway. It gives each bot you choose a browser of its own, lets the people who can use that bot watch the browser live, and lets one of them take it over (to sign in, or get past a captcha) and hand it back.

Clawtrate is an independent open-source project. It is not made by, affiliated with or endorsed by OpenClaw.

> **Status: development gateways only.** This plugin is written from the requirements in Clawtrate's [gateway capability map](../../docs/research/gateway-capabilities.md#requirements-for-the-shipped-plugin), and its tests cover each of them. It has not yet had a security review of its own. Until it has, install it only on a development gateway, never on a gateway that holds real sign-ins.

## What it adds

Without the plugin, watching a bot's browser needs full admin access to the gateway (`operator.admin`), and nothing stops a person and a bot from acting in the same tab at once. With it:

- **One browser per bot.** Every `browser` tool call of a configured bot is sent to that bot's own browser profile on the gateway's machine. Other agents cannot use a configured bot's profile.
- **Watching.** Anyone whose device may use one of the bot's tasks can list the bot's tabs and watch one live.
- **Taking over.** One person at a time can take control of a tab. While they hold it, the bot's own browser tool is blocked in every one of its tasks, and the tool's result tells the bot so. Handing back unblocks it.
- **No admin access for the device.** The device needs `operator.read` and `operator.write`, the same as for chatting with the bot.

## What it needs

- OpenClaw 2026.10.6 (the version it is tested against). Plugin interfaces are marked experimental, so pin that version.
- The gateway's bundled browser plugin, enabled (the default), and a Chromium-based browser on the gateway's machine for the gateway to launch.
- One free loopback port per bot, for that bot's browser.

## Installing and configuring it

1. Install the plugin into the gateway's profile, for example from a checkout of Clawtrate:

   ```bash
   openclaw plugins install --link <checkout>/plugins/clawtrate-computer
   ```

2. Give each bot a managed browser profile of its own, on a port of its own, in the gateway's config. The profile must use the managed driver (no `cdpUrl`, no `driver`), and the default profile must not be a bot's:

   ```json5
   {
     browser: {
       defaultProfile: "openclaw",
       profiles: {
         openclaw: { cdpPort: 18800 },
         "bot-juniper": { cdpPort: 18811 },
         "bot-otto": { cdpPort: 18812 },
       },
     },
   }
   ```

3. Tell the plugin which bot owns which profile, at which address (always `http://127.0.0.1:<the profile's cdpPort>` or `http://[::1]:<port>`):

   ```json5
   {
     plugins: {
       entries: {
         "clawtrate-computer": {
           enabled: true,
           config: {
             bots: {
               juniper: { profile: "bot-juniper", cdpUrl: "http://127.0.0.1:18811" },
               otto: { profile: "bot-otto", cdpUrl: "http://127.0.0.1:18812" },
             },
             // Optional. How long a request for control waits for the bot's
             // running browser call to finish (1000 to 60000, default 15000).
             drainTimeoutMs: 15000,
             // Optional. How long a view or a held tab lives without being
             // renewed (5000 to 60000, default 20000).
             renewTimeoutMs: 20000,
           },
         },
       },
     },
   }
   ```

4. Give those bots the `browser` tool (and keep it from bots that should not have one). A device can watch only a bot whose task policy allows the browser tool.

The plugin refuses to load when its config does not match the gateway's browser config: an unknown setting, a profile or port given to two bots, an address that is not literal loopback, a bot profile that is not declared under `browser.profiles` on exactly that port, another profile on a bot's port, or a bot profile as the default. It checks the gateway's config again on every call; if a bot's profile was changed afterwards, the plugin ends that bot's views and held tabs and refuses its browser calls until the two agree again.

## What a device can do with it

Every method is on the write tier (`operator.write`) and admitted by the gateway per session: the call names one of the bot's tasks (`sessionKey`), the gateway checks that this device may use that task and that the task's tool policy allows the browser tool, and the plugin then serves that task's bot. A read-only connection is refused every method, so it never receives a tab list, a ticket, a frame or a way to send input. Every reader does receive the control events.

| Method                               | Parameters                                                                                                                                       | Answer                                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clawtrate-computer.tabs`            | `sessionKey`                                                                                                                                     | `{agentId, profile, browser: "running" \| "not-running", reason?, tabs: [{targetId, url, title, lease: null \| {state: "draining" \| "granted", mine}}]}`                                      |
| `clawtrate-computer.view.open`       | `sessionKey, targetId`                                                                                                                           | `{streamId, wsPath, expiresAtMs, renewWithinMs, targetId}`                                                                                                                                     |
| `clawtrate-computer.view.renew`      | `sessionKey, targetId, streamId?, generation?` (at least one)                                                                                    | `{ok: true, renewWithinMs, streamRenewed, leaseRenewed}`                                                                                                                                       |
| `clawtrate-computer.control.take`    | `sessionKey, targetId`                                                                                                                           | once, after the bot's running browser call ends or the drain deadline passes: `{state: "granted", generation, renewWithinMs, targetId}` or `{state: "busy", reason, runningCalls, generation}` |
| `clawtrate-computer.input`           | `sessionKey, targetId, generation, kind: "click" \| "scroll" \| "text"`, and `x, y` (click), `x?, y?, deltaX?, deltaY` (scroll) or `text` (text) | `{ok: true}`                                                                                                                                                                                   |
| `clawtrate-computer.control.release` | `sessionKey, targetId, generation`                                                                                                               | `{state: "released", generation, targetId}`                                                                                                                                                    |

Coordinates are the page's own CSS pixels (a frame's header gives the page's size). Text is 1 to 2000 characters per call. Input is applied one call at a time, in order.

**Refusals** carry one of the gateway's codes and a `details.reason`:

| Code              | `details.reason`                                                   | When                                                                                                        |
| ----------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `UNAVAILABLE`     | `bot_not_configured`                                               | the task's bot has the browser tool but no browser of its own in this plugin                                |
| `UNAVAILABLE`     | `browser_config_mismatch`                                          | the gateway's browser config no longer matches the plugin's                                                 |
| `UNAVAILABLE`     | `browser_unavailable`, `discovery_timeout`, `discovery_failed`     | the bot's browser is not running or did not answer in time                                                  |
| `UNAVAILABLE`     | `control_held`                                                     | someone has, or is taking, control of the tab                                                               |
| `UNAVAILABLE`     | `control_request_ended`                                            | a take ended before it was granted (the caller left, the tab closed, the plugin stopped)                    |
| `UNAVAILABLE`     | `input_not_delivered`                                              | an input could not be applied (control ended meanwhile, or the tab did not answer)                          |
| `UNAVAILABLE`     | `too_many_views`, `connection_closed`                              | a connection opened 8 views (64 in all), or the calling connection has closed                               |
| `FORBIDDEN`       | `tab_not_in_bots_browser`                                          | the tab is not in this bot's browser (another bot's, or closed)                                             |
| `FORBIDDEN`       | `not_holder`                                                       | input or a release without the lease: another connection, a wrong generation, or a lease that already ended |
| `FORBIDDEN`       | `session_access_required`, `session_access_ended`, `no_connection` | no task was admitted, its access ended, or the call has no connection                                       |
| `INVALID_REQUEST` | `bad_target`, `bad_input`, `bad_request`                           | a malformed tab id, input or renewal                                                                        |

A bot whose task policy denies the browser tool is refused by the gateway itself, before the plugin answers (`FORBIDDEN`, `details.code: "SESSION_RESOURCE_TOOL_POLICY"`). A refused release proves nothing about who holds the tab: it is refused for a lease that expired, was replaced, or was never this device's.

**The stream.** `view.open` returns a ticket in `wsPath`. Open a WebSocket to the gateway's own address plus `wsPath` within 60 seconds; a ticket opens one stream once, and a late or unused one is harmless. The stream sends text messages `{type: "ready", targetId, url, title}` and, when the page navigates, `{type: "meta", url}`; and binary frames in the gateway's own screencast layout: a 4-byte big-endian length, a JSON header `{url, cssWidth, cssHeight, scrollX, scrollY, ts}`, then a JPEG. It is view-only: a viewer that sends anything but a ping or a close is disconnected. Close codes: `1000` closed, `4004 target_closed` (the tab closed), `4006 authority_revoked` (not renewed, the task's access ended, or the caller's connection closed), `1011 browser_unavailable`, `1012 shutdown`. The plugin writes no frame to a log.

**The control event**, `plugin.clawtrate-computer.control`, on the read tier: `{agentId, profile, targetId, holder: "user" | "bot", state, generation, reason?}`. `state` is `draining` (a take is waiting for the bot's call), `granted`, `busy` (the take failed at the drain deadline), `released`, `expired` (not renewed), `revoked` (the holder's connection closed, the task's access ended, the browser config changed or the plugin stopped; `reason` says which) or `tab-closed`. Every event carries the `generation` of the lease it is about, so a device can tell its own lease's events from another's. A release is confirmed by the device's own `control.release` succeeding, or by a `released` event with its own generation.

## How long things last

- **Renew** a view and a held tab with `view.renew` well within `renewWithinMs` (every 5 seconds with the default). A view or a held tab that is not renewed ends.
- **A device that disconnects** loses its views and its held tab at once: the plugin ends them when the gateway reports the connection closed.
- **A request for control** waits at most `drainTimeoutMs` for the bot's running browser call. If the call is still running then, the answer is `busy` and nothing is granted. New browser calls of the bot are blocked from the moment of the request. The holder can withdraw its own request before the answer with `control.release` and the generation from the `draining` event.
- **Every wait has a deadline**: listing the browser's tabs (3 s), connecting to a tab (3 s), and every command to it (5 s). Ending a lease (released, expired, revoked, tab closed, the plugin stopping) never waits on the browser: input still queued is cancelled and nothing is sent after the lease ends, and only then is the bot unblocked.
- **A tab that closes**, or a browser that is replaced, ends that tab's views (`4004`) and its lease (`tab-closed`) as soon as the plugin notices: at once through its own connection to a held or watched tab, otherwise at the next list or renewal.

## What it guarantees, and what it cannot

It guarantees, for each configured bot:

- the bot's `browser` calls go to its own profile on the gateway's machine (`target: "host"`), whatever profile, node, sandbox, dashboard or import destination the call asks for; such routing is refused, not redirected;
- the bot may use only tab actions: `status`, `start`, `tabs`, `open`, `focus`, `close`, `snapshot`, `screenshot`, `navigate`, `text` and `act`. Profile import, downloads, uploads, `stop` and every other action are refused;
- no other agent's `browser` call can name the bot's profile, by any spelling, as its profile or as an import destination, and no other agent may use browser dashboards while bots have browsers of their own;
- a device can list, watch and take only the tabs that the bot's own browser lists right now, for a task it may use; nothing in a tool result grants anything;
- while a person holds a tab, every `browser` call of that bot, from all of its tasks, is refused with "A person has control of this bot's browser. Wait until they give it back."; one holder at a time, and only the holder's own connection, with the lease's generation, can send input or release.

**What stays open while a person holds control.** The block covers the bot's `browser` tool calls and nothing else. These routes to a bot's browser stay open:

1. **Operator browser controls.** `browser.request` (for devices with `operator.admin`) and `browser.dashboard.request` (for a browser dashboard widget in a task) are gateway methods; no plugin hook sees them, so such a device can still drive the bot's browser. A dashboard widget can name any browser profile, and the plugin blocks only the browser tool's dashboard selector, not the `dashboard` tool that creates widgets. If that matters, deny the `dashboard` tool, and give `operator.admin` to no device you would not let drive the bot's browser.
2. **The browser's debugging port.** Each bot's browser listens on its loopback port without authentication. Any process on the gateway's machine can drive it there, including a command a bot runs with `exec`, `process` or `code_execution` on the gateway host. Deny those tools, or run them in a sandbox, for every agent that should not reach the bots' browsers.
3. **Other tools that drive a screen or a browser,** such as the `computer` tool, act outside the `browser` tool hook. Deny them where they could reach the bots' browsers.
4. **Other plugins.** This plugin's hook runs first (priority 1000) for the `browser` tool, so its routing is in place before any other plugin asks for approval. A plugin that rewrites browser calls after it could undo that; the plugin logs a warning when a bot's call ran with another profile, but cannot stop it.

**Other limits.**

- Isolation is per bot, not per task: all of a bot's tasks share its browser, its sign-ins and its tabs, and a hold blocks the bot in all of them. Tabs an admin opens in the bot's profile are part of that browser and can be watched from its tasks.
- A person's input and the frames go straight to the browser, so they skip the gateway's navigation policy: a click can follow a link the bot itself could not open.
- A bot call that never finishes keeps that bot's browser `busy` until the gateway restarts. A cancelled call stops counting as running.
- Without a connection-closed signal from the gateway (older gateways), views and held tabs end by renewal only.

## Removing it

1. Remove `clawtrate-computer` from `plugins.entries`, and its folder from `plugins.load.paths` (or run `openclaw plugins uninstall clawtrate-computer`). When the plugin stops, it ends every view (`1012`) and held tab (`revoked`), so no bot stays blocked.
2. Optionally remove the bots' profiles from `browser.profiles`. Each profile's data, including its sign-ins, is in the gateway's state folder under `browser/<profile>/`; delete those folders to remove them.
3. Restore the tool policy you want for the browser tool.

## On a Clawtrate development gateway

The development gateway of this repository loads the plugin on a named instance:

```bash
pnpm dev-gateway start --instance <name> --with-plugin clawtrate-computer
pnpm dev-gateway reset --instance <name>     # when you are done
```

Its [`clawtrate-dev-contract.json`](clawtrate-dev-contract.json) gives Marlow and Pip browsers of their own (`botBrowsers`, a closed declaration: seeded bots only, at most four, a drain of 2, 5 or 15 seconds and a renewal of 6, 10 or 20 seconds). From it the tool writes the whole browser setup: the browser tool for those two bots only, a headless managed profile each on ports of the instance's own block, Playwright's Chromium (never a browser of the machine's owner), no script evaluation, no cookie import from a system browser, and each profile's data inside the instance's state folder. The guard refuses any other browser setting.

**The development browser reaches only the scripted pages on loopback.** Two layers enforce it:

- the gateway's own configuration: `browser.ssrfPolicy` allows `127.0.0.1` and keeps every other private, link-local and special-use address refused, and the gateway refuses every hostname navigation it cannot pin; and
- the tool: the browser is started with `--host-rules=MAP * 127.0.0.1:<pages port>`, so every connection it makes, to any host, address or port, goes to the instance's scripted pages instead, which serve their own pages (`/scripted/pages/sign-in`, `/scripted/pages/welcome`, a slow page) only when asked for by their own origin, and answer anything else with "Refused by the development gateway". TLS to anywhere fails there.

`tools/dev-gateway/test/computer.test.ts` proves the second layer with a real Chromium: addresses outside loopback (in documentation ranges nothing answers), other loopback ports where a server of the test's own listens, and other hostnames all end at the refusal page, and that server is never reached. `pnpm scenarios` proves both on a real gateway (below).

`pnpm scenarios` runs the computer checks on an instance of their own: a bot opens a scripted loopback page in its own browser; a second bot's browser is not visible through the first bot's task; a read-only connection gets no tabs, tickets, frames or input path; a watcher gets a ticket and frames; taking control blocks the bot's browser tool, and the tool's result says so; input reaches the page; a release with a wrong generation is refused; a release with the right one frees the bot and its event carries that generation; a lease that is not renewed expires; a take while the bot acts past the drain deadline answers `busy`; a caller that leaves mid-take leaves nothing granted or streaming; closing the tab ends the view and the lease; and an outside address is refused.

The plugin's own tests run with `pnpm test` (`plugins/clawtrate-computer/test`).
