# The Library and Pages: what the gateway gives

What a client can learn from an OpenClaw gateway about what a bot made, what a Page is there, how one can be shown and exported, and where pins can be kept, checked against OpenClaw 2026.10.6 on a development instance with this project's own client. It is the evidence behind `docs/design/library.md` and the parity rows F-208 to F-210 and F-371 to F-374.

How to read the citations, as in `setup-flow.md`:

- `<openclaw>/…` is a path inside the installed `openclaw` 2026.10.6 npm package, the one the `openclaw` wrapper script runs. Bundled chunk names carry a build hash that changes with every release; search by the `//#region <source path>` marker at the top of each chunk instead. Line numbers are of the 2026.10.6 chunks.
- **Live** means it was run here and the result is quoted. **Source** means it was read in shipped code only (read-only-from-source). **Not established** marks what could not be settled, with the reason.

Where things were run:

- **One development instance**, `d14lib`, started by this checkout with `pnpm dev-gateway start --instance d14lib`, on loopback (`gateway.bind: "loopback"`), with its four seeded bots. The hand-over scenarios of the artifacts work (`#hand-several`, `#hand-page`, `#hand-link`, `#hand-file`: `tools/dev-gateway/src/handover.ts`, `scenarios.ts` and the stand-in coding agent's `share_page` on the `m42-artifacts` branch) were applied to the checkout for the run and not committed: on `main` no scenario hands anything over. `share_page` names a canvas document through the gateway's own canvas preview shape; the gateway's `canvas` and `show_widget` tools stay denied by the development contract.
- **The probe** is `library/library-probe.ts`. Its connections are this project's `ClawtrateClient` (`packages/core`), as the desktop app makes them: client id `gateway-client`, mode `ui`, a first connect with `operator.read` alone, and the interactive tier (`operator.read`, `operator.write`, `operator.approvals`, `operator.questions`) only after `requestAccess("interactive")` and the owner's approval. Device A was paired read-only and then upgraded; device B stayed read-only. The probe approved only its own requests, by id, through the tool's guarded runner. It prints no token and no capability: every hosted address is printed with `<capability>` in its place.
- **Chromium** (Playwright 1.65.1, headless, offline) for what a Page's HTML can do in Clawtrate's frame, with a loopback HTTP server of the probe's own that counts every request reaching it.

## Summary

| # | Question | Answer | Section |
| --- | --- | --- | --- |
| 1 | What does `artifacts.list` list, and for what? | One task (`sessionKey`, or `runId` where only one bot is configured). Not a bot, not the gateway: `{agentId}` alone is refused. One call lists the whole transcript's items; only the picture list (`type: "image"`) is paged, at most 4 at a time. Entries carry no time; they carry `messageSeq` and `runId`, and the time is the message's `timestamp` in `chat.history`. Kinds: `image`, `audio`, `video`, `file`. Pages and links are not artifacts. **Live**, read tier. | 1 |
| 2 | What is a Page? | A canvas document: a folder on the gateway with a manifest and an HTML entrypoint. The transcript names it with a `canvas` block (`preview.viewId`, `title`); `canvas.document.view {docId}` (`operator.read`) returns `{html, sandboxUrl, sandboxPort}` and nothing else: no title, no time, no revision. The shipped `show_widget` tool makes a new document id each time and keeps at most 32 per task. **Live** and **source**. | 2 |
| 3 | The hosted surface | `hello-ok.pluginSurfaceUrls.canvas` is `http://127.0.0.1:<gateway port>/__openclaw__/cap/<capability>`: the gateway's own listener, with a bearer capability in the path, good for 10 minutes, replaced by `plugin.surface.refresh` (`operator.read`), which ends the old one. Anyone holding it can fetch without any other credential; under it the gateway serves the canvas documents with their scripts allowed, and its root serves the Control UI's page. Clawtrate never reads, shows, logs, opens or exports it. **Live**. | 3 |
| 4 | Can a Page talk back? | Not in Clawtrate's frame (`sandbox=""`, scripts removed, `default-src 'none'`): no script ran, a form did not submit, no window opened, no message reached the parent, and no request reached the network. Checkboxes, menus and folded sections still moved, and were back as written when the Page was shown again. A link click replaced the frame with an error page unless the link's address was taken out first. **Live** (Chromium). In the gateway's own Control UI a Page runs its scripts and can call back through the host (`board.action`, `mcp.app.callTool`); none of that exists in Clawtrate. **Source**. | 4 |
| 5 | "Updated below" | Not established by the gateway. Sharing one document id twice gives two `canvas` blocks with the same `viewId`; `canvas.document.view` then returns the HTML as it is now for both, with no revision and no event. A shipped bot's new page is a new id, with no link to the old one. **Live** and **source**. | 5 |
| 6 | The side chat | `chat.send` to the task whose transcript holds the Page's block; accepted at the interactive tier and refused at read (`missing scope: operator.write`). **Live**. | 6 |
| 7 | Export | What `canvas.document.view` returns: the entrypoint's HTML only, up to 10 MiB, scripts included as written; files beside it in the document's folder are not returned. **Source** and **live**. | 7 |
| 8 | Pins | `users.prefs.get` (`operator.read`) and `users.prefs.set` (`operator.write`) on the connection's user profile: a value of at most 4,096 bytes of JSON, at most 32 keys a call, 128 keys a profile, compare-and-set with `expectedEntries`, and `users.prefs.changed {profileId, keys}` to every connection of that profile, read-only ones included. Both of the owner's devices had the profile `gateway-owner` and saw each other's change. A connection without a profile is answered `{status: "no_durable_identity"}`. **Live**, except the last (**source**). | 8 |
| 9 | Apps | MCP App views reach the transcript as `canvas` blocks carrying `mcpApp`; they run only with scripts (`mcp.app.view`). No development gateway produced one. **Source**. | 9 |

## 1. `artifacts.list`

### What the gateway does

`artifacts.list`, `artifacts.get` and `artifacts.download` are `operator.read` (`<openclaw>/dist/core-method-policy-DkntKRY_.mjs` line 917 and the two after it). The parameters are `sessionKey`, `runId`, `agentId`, `messageRole: "assistant"`, and for pictures `type`, `limit` and `cursor` (`<openclaw>/dist/src-BSx5Woe0.mjs`, `ArtifactQueryParamsProperties`). A query needs `sessionKey` or `runId` (`requireQueryable`, `<openclaw>/dist/artifacts-CVcZMNpQ.mjs` line 394); `limit` and `cursor` are refused unless `type` is `image` (line 496). The transcript's blocks are read by type: `image`, `input_image`, `image_url` as image; `audio`, `input_audio`; `video`, `input_video`; `file`, `attachment`, `input_file` and anything else with content as file. Each entry is `{id, type, title, mimeType?, sizeBytes?, sessionKey, runId?, messageSeq, source, download: {mode}}` (`<openclaw>/dist/session-artifact-read-CN5ihAvI.mjs` lines 67-79 and 152-167): no time. `messageRole: "assistant"` keeps only items in the bot's own messages; without it the person's uploads and what tools returned are listed too, and nothing in an entry says which.

### Live

Read tier (device B), Juniper's seeded "Show your work" and the probe's own task:

```
artifacts.list {sessionKey}: ok {"artifacts":[]}
artifacts.list {agentId} alone: refused {"code":"INVALID_REQUEST","message":"artifacts require sessionKey or runId","details":{"type":"artifact_query_unsupported"}}
artifacts.list {sessionKey, limit}: refused {"code":"INVALID_REQUEST","message":"invalid artifacts.list params: at /limit: must be <= 4"}
read tier, Library probe task: artifacts ["file@4","image@4","image@4","audio@4","file@14"]
```

Interactive tier (device A), a task with Marlow, after `#hand-several`, `#hand-page`, `#hand-link`, `#hand-file` and `#hand-page` again (ids shortened):

```
artifacts.list {sessionKey}: [{"id":"artifact_managed_media_3846…","type":"file","title":"trail-report.md","mimeType":"text/markdown","sizeBytes":149,"sessionKey":"agent:marlow:dashboard:8399…","runId":"8a23…","messageSeq":4,"source":"session-transcript","download":{"mode":"url"}}, {…"type":"image","title":"ridge-profile.png"…"messageSeq":4…}, {…"type":"image","title":"trail-photo.png","sizeBytes":417541…}, {…"type":"audio","title":"trail-chime.wav"…}, {…"type":"file","title":"trail-report.md"…"messageSeq":14…}]
artifacts.list {messageRole: assistant} count: 5 types: ["file","image","image","audio","file"]
artifacts.list {runId} alone: refused {"code":"INVALID_REQUEST","message":"Multiple agents are configured, but this operation has no explicit owner. Select an agent explicitly; …"}
artifacts.list {sessionKey, type: image, limit: 1}: ok {"artifacts":[{…"title":"trail-photo.png"…}],"nextCursor":"ca82…"}
```

The page shared twice and the link are not in the list. `chat.history` rows carry the time and the sequence number that the entries name:

```
history row: {"role":"assistant","timestamp":1795099178778,"seq":4,"blocks":[{"type":"text",…},{"type":"attachment","artifactId":"artifact_managed_media_3846…"},{"type":"image",…},{"type":"image",…},{"type":"audio",…}]}
history row: {"role":"assistant","timestamp":1795099188294,"seq":8,"blocks":[{"type":"text","text":"I made a page with Saturday's routes."},{"type":"canvas","preview":{"kind":"canvas","surface":"assistant_message","render":"url","title":"Trail guide","url":"/__openclaw__/canvas/documents/trail-guide/index.html","viewId":"trail-guide"},…}]}
history row: {"role":"assistant","timestamp":1795099197892,"seq":10,"blocks":[{"type":"text","text":"The park keeps this week's trail conditions here: https://trails.example/conditions"}]}
```

`chat.history` pages from the end: on the read tier, `{limit: 4}` returned 4 rows with `{"hasMore":true,"nextOffset":4}`, and `{limit: 4, offset: 4}` the rows before them, `[11,12,13,14]`. `sessions.list {agentId: "main", limit: 50}` returned that bot's six tasks with `updatedAt`.

### What follows

- A bot's Library is assembled by the client: its tasks from `sessions.list {agentId}`, then per task `artifacts.list {sessionKey, messageRole: "assistant"}` and `chat.history` for the times, the Pages and the links. Nothing gives a count of a bot's items, and nothing lists them across tasks.
- **Today, This week and Older** are computed on the device, in the device's time zone, from the `timestamp` of the message that carried each item. An item whose message is not in the history pages read has no time; it is not placed in a group by guess.
- **Kinds.** Media is `image`, `audio` and `video`; Files is `file`; Pages are `canvas` blocks without `mcpApp` (section 2); Links are `http` and `https` addresses in the bot's message text, read by the client. None of the last two is an artifact.
- For one conversation (the iPhone's Library, F-371), `artifacts.list` without `messageRole` includes the person's uploads; telling them from what a tool returned needs the row's `role` from `chat.history`, matched by `messageSeq`.

## 2. What a Page is

### Source

- `canvas.document.view` and `canvas.document.preview` are `operator.read`, since 2026.9 (`<openclaw>/dist/core-method-policy-DkntKRY_.mjs` lines 2689 and 2856). `plugin.surface.refresh` is `operator.read` (line 2200).
- `canvas.document.view {docId}` reads `<state>/canvas/documents/<id>/manifest.json` and its `localEntrypoint`, which must be `.html` (`<openclaw>/dist/documents-v0C8qpqy.mjs` lines 26-37), refuses a document whose manifest does not say `cspSandbox: "scripts"` or whose HTML is over 10,485,760 bytes, and answers `{html, sandboxUrl, sandboxPort, sandboxOrigin?}`; every failure is `UNAVAILABLE` with one message, "Canvas widget unavailable; reload the chat or ask the agent to recreate it." (`<openclaw>/dist/canvas-CC6bLIsN.mjs` lines 12-44). It takes any id: nothing ties a document to a task or a bot.
- `canvas.document.preview {html}` returns the caller's own HTML (at most 2 MiB) with a sandbox address: it is for showing HTML the client already has, not for reading a bot's page (same file, lines 46-53).
- `sandboxPort` is the gateway's port plus one (`SANDBOX_HOST_PORT_OFFSET`, `<openclaw>/dist/sandbox-host-C4L4QQ2a.mjs` line 227), the host where the gateway's Control UI runs a page's scripts under a policy that allows inline scripts and five public script hosts (`<openclaw>/dist/board-sandbox-CZGxV3Ka.mjs` lines 19-38; `<openclaw>/dist/widget-html-DuR2hZeB.mjs` line 4).
- The shipped tool that makes a page, `show_widget`, calls `createCanvasDocument` without an id (`<openclaw>/dist/openclaw-tools-DV-z1IAc.mjs` lines 1194-1202), so each page gets a new `cv_<uuid>` id (`documents-v0C8qpqy.mjs` line 78); a document given an existing id is deleted and written again (line 80). Each task keeps at most 32 such documents; the oldest are deleted (`WIDGET_MAX_PER_SCOPE`, `openclaw-tools-DV-z1IAc.mjs` line 949; `pruneCanvasDocumentsForScope`, `documents-v0C8qpqy.mjs` lines 38-58).
- `chat.history` turns a canvas preview into `{type: "canvas", preview: {kind, surface, render, title?, url, viewId, …}}`; a preview carrying an `mcpApp` descriptor is an MCP App view (`<openclaw>/dist/chat-display-projection.canvas-OCRpCKvQ.mjs` lines 39-82).

### Live

```
hello advertises: {"artifacts.list":true,"artifacts.get":true,"artifacts.download":true,"canvas.document.view":true,"canvas.document.preview":true,"plugin.surface.refresh":true,"users.prefs.get":true,"users.prefs.set":true,"chat.send":true,…}
canvas.document.view trail-guide: ok {"html":"<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Trail guide</title>…
canvas.document.view unknown: refused {"code":"UNAVAILABLE","message":"Canvas widget unavailable; reload the chat or ask the agent to recreate it."}
canvas.document.preview: ok {"html":"<!doctype html><p>probe</p>","sandboxUrl":"/mcp-app-sandbox?csp=…&v=…","sandboxPort":19541}
view probe-script: {"sameAsWritten":true,"sandboxUrl":"/mcp-app-sandbox?csp=…","sandboxPort":19541,"keys":["html","sandboxUrl","sandboxPort"]}
view probe-strict (cspSandbox strict): refused {"code":"UNAVAILABLE","message":"Canvas widget unavailable; …"}
listeners on the gateway's port and the next: ["127.0.0.1:19540 (LISTEN)","[::1]:19540 (LISTEN)","127.0.0.1:19541 (LISTEN)","[::1]:19541 (LISTEN)"]
```

All on the read tier. The probe's own documents (a page with a script, one with a form and links, one with a refresh, a base address, a remote stylesheet, picture and frame) came back exactly as written: the gateway does not change a page's HTML.

## 3. The hosted surface

### Live

```
hello pluginSurfaceUrls: {"canvas":"http://127.0.0.1:19540/__openclaw__/cap/<capability>"} pluginSurfaceBaseUrl: null
host: 127.0.0.1 port: 19540 path carries a capability: true same port as the socket: true
GET the address itself: {"status":401,…}
GET the address + /: {"status":200,"type":"text/html; charset=utf-8","csp":"default-src 'self'; …","body":"<!doctype html>\n<html data-openclaw-control-ui-base-path=\"\" … (20524 chars)"}
GET a document under it: {"status":200,"type":"text/html; charset=utf-8","csp":"default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://esm.sh https://unpkg.com … connect-src 'none'; … form-action 'none'; frame-src 'none'; sandbox allow-scripts","body":"<!doctype html>…<title>Trail guide</title>…"}
GET the same document without the capability: {"status":401,…}
GET a wrong capability: {"status":401,…}
refresh: {"sameAddress":false,"expiresInSeconds":600}
the first address after the refresh: 401
```

The plain HTTP requests carried no token and no device credential: the capability alone opened the document and the Control UI's page. The address is minted per connection at the handshake (`<openclaw>/dist/message-handler-CRCo2VX0.mjs` line 3073), from the path prefix `/__openclaw__/cap` and a default life of 600,000 ms (`<openclaw>/dist/plugin-node-capability-xdPNxiHJ.mjs` lines 10-12). Its host and port are the gateway's own listener, so it is served wherever the gateway listens: on this instance, loopback only. **Not established**: what else the capability opens beyond these two paths.

### What follows

The address is a bearer credential that opens the gateway's own interface and runs a page's scripts with their outside script hosts. Clawtrate does not need it: `canvas.document.view` gives the HTML over the socket. The remote-content rule already says the address is never loaded or opened (`docs/decisions.md`, "Addresses a gateway hands the client", on the branch that decides it). The Library design adds that it is never shown, logged, copied or exported, and that `plugin.surface.refresh` is never called.

## 4. What a Page's HTML can do in Clawtrate's frame

The frame is the one the artifacts branch builds (`m42-artifacts:packages/ui/src/artifacts/viewer.tsx`, `framedPage` and `PAGE_POLICY`): the HTML parsed aside, `script`, `base` and `meta[http-equiv]` removed, `default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; font-src data:` put first in its head, shown as `srcdoc` in an `iframe` with `sandbox=""`, inside a page under the desktop renderer's policy. The "design" frame also removes every `href`, `action`, `formaction`, `target` and `ping`. The page joined the three probe documents of section 2, its addresses pointing at the probe's own loopback server.

```
BRANCH frame keeps a script: false meta refresh: false an href: true
  the page's own button: counter 0
  checkbox true menu Ridge folded section open true
  after Send, the new-window link and the link: frame at chrome-error://chromewebdata/ still the page: false
  opened again: checkbox false menu Lake
  requests that reached the probe's server: []
  popups and console: ["19 console lines"]
DESIGN frame keeps a script: false meta refresh: false an href: false
  the page's own button: counter 0
  checkbox true menu Ridge folded section open true
  after Send, the new-window link and the link: frame at about:srcdoc still the page: true
  opened again: checkbox false menu Lake
  requests that reached the probe's server: []
  popups and console: ["13 console lines"]
```

The console lines were the policies refusing the stylesheet, the pictures and the frame. No popup opened and the parent received no message. So, in this frame:

- **A Page cannot talk back.** No script runs, so nothing calls the gateway, the parent or any host; a form does not submit (`sandbox` without `allow-forms`); no window opens (`allow-popups` absent); nothing is fetched (`default-src 'none'`, and the parent's own policy). In the gateway's Control UI the same page runs its scripts in the sandbox host and can act through the host page: `board.action` and `board.event` (`operator.write`) and `mcp.app.callTool` (`operator.write`) exist for that (`core-method-policy-DkntKRY_.mjs`). Clawtrate has no such host.
- **"Filters and switches change only the view"** holds for what works without scripts: a checkbox, a menu and a folded section changed on screen and were as written when the page was shown again. Anything a page does with its scripts, a filter that hides rows or a chart drawn at load, does not happen at all.
- **A link** inside the page navigates the frame itself, which the parent's policy refuses, leaving an error page in place of the Page. Taking out link addresses before framing keeps the Page in place.

The desktop app's request filter cancels a subframe's load as well (remote-content research, §2); the probe stood for the renderer's policy only.

## 5. "Updated below"

Live: `#hand-page` shared `trail-guide` at seq 8; the probe then changed the document's HTML on disk (as a bot rewriting a page with the same id would) and `#hand-page` shared it again at seq 18. Both rows carry the same `preview` (`"viewId":"trail-guide"`, `"title":"Trail guide"`); neither carries a revision or a time other than the message's. `canvas.document.view` afterwards returned 1,555 characters against 1,533 before, the changed page, whichever card asks. No event was received for the change.

Source: the shipped `show_widget` gives each page a new id, so a bot that makes a page again makes another page, with nothing linking the two. The same id appears twice only when something names an existing document again.

So a client can tell that one document was shown again later in a task, and nothing else: not that it changed, not which version a card showed. "Updated below" is not established; "Shown again below" is.

## 6. The side chat

The Page's block sits in one task's transcript, and `chat.send {sessionKey, message, idempotencyKey}` to that task is the side chat. Live: the probe's task took five `chat.send`s at the interactive tier; on the read tier, `chat.send` to it with the text `About the page “Trail guide”: probe` was refused with `{"code":"FORBIDDEN","message":"missing scope: operator.write"}`. The gateway adds nothing to a message's text; what the person reads in the field is what is sent.

## 7. Export

`canvas.document.view` returns the entrypoint's HTML only (`documents-v0C8qpqy.mjs` line 34). A document folder may hold other files (`manifest.assets`), which the method does not return and which the client could fetch only through the hosted address it never uses. The HTML is the bot's, scripts included (section 2, "came back exactly as written"). A file of it opened in a browser runs those scripts with that browser's access and loads what they name; the gateway's own policy for it allows five public script hosts (section 3). Nothing about export needs the gateway beyond the read.

## 8. Pins in the person's preferences

### Source

- `users.prefs.get` is `operator.read` and `users.prefs.set` is `operator.write`, since 2026.8 (`core-method-policy-DkntKRY_.mjs` lines 2429 and 2435).
- Both act on `client.authenticatedUserProfile.profileId`; without one they answer `{status: "no_durable_identity"}` (`<openclaw>/dist/users-XXBiT3kC.mjs` lines 338-410).
- A set takes at most 32 entries (`<openclaw>/dist/user-preferences-9JKSYgKc.mjs` line 14), keys of 1 to 256 characters, values whose JSON is at most 4,096 bytes (line 39); a profile holds at most 128 keys (`<openclaw>/dist/user-preferences.store-BbmywMbP.mjs` line 120). `expectedEntries` makes it a compare-and-set that answers `{status: "conflict"}` (line 113). A successful set sends `users.prefs.changed {profileId, keys}` to every connection of that profile (`<openclaw>/dist/user-preference-events-9hhFtAwt.mjs` line 11).

### Live

Device A at the interactive tier, device B read-only, both connected:

```
users.prefs.get (B, read tier): ok {"status":"ok","entries":{}}
users.prefs.set (B, read tier): refused {"code":"FORBIDDEN","message":"missing scope: operator.write",…}
A users.prefs.set pins: ok {"status":"ok"}
A users.prefs.get again: ok {"status":"ok","entries":{"clawtrate.library.pins":["a"]}}
A set a 4097-byte value: refused {"code":"INVALID_REQUEST","message":"invalid users.prefs.set entry for clawtrate.library.big: value-too-large"}
A set with a stale expectation: ok {"status":"conflict"}
B users.prefs.get: ok {"status":"ok","entries":{"clawtrate.library.pins":["a"]}}
events B received: [{"event":"users.prefs.changed","payload":{"profileId":"gateway-owner","keys":["clawtrate.library.pins"]}}]
events A received: [{"event":"users.prefs.changed","payload":{"profileId":"gateway-owner","keys":["clawtrate.library.pins"]}}]
```

### What follows

Pins kept in preferences belong to the person's profile on the gateway, not to the device: every device and client of the gateway's owner reads and changes the same entries, and each is told when another changes them. A read-only connection reads them and is refused a change. 4,096 bytes holds roughly 25 pins of a task key and an item id each. A connection the gateway gives no profile (a gateway with roles, for a device without a user) gets `no_durable_identity`, and its pins can only be kept on the device; not exercised here, since every development connection is the owner's.

## 9. Apps

An MCP App view reaches the transcript as a `canvas` block whose preview has `mcpApp {viewId, serverName, toolName, uiResourceUri, toolCallId}` (`chat-display-projection.canvas-OCRpCKvQ.mjs` lines 14-32 and 67-71), and is shown by the Control UI through `mcp.app.view` and the sandbox host, with scripts. The development gateway's tool servers declare no app, so none was produced, and Clawtrate runs no page's scripts. Nothing else on the gateway marks an item as an app.

## 10. What could not be established

- What a canvas capability opens beyond the documents and the Control UI's page (section 3).
- Pins on a connection without a user profile, and on a gateway with roles (section 8): read from source only.
- An MCP App block (section 9).
- A shipped bot's page: `show_widget` and `canvas` are denied on a development gateway, so the pages here were named through `share_page`; the shipped tool's behavior is read from source (section 2).
