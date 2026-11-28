# MCP Apps: what the gateway gives a client

Research behind issue #997, opening an interactive MCP App result from a conversation. It answers what OpenClaw tells a client about an MCP App result, and what a client needs to show one.

`<openclaw>/…` is a path in the OpenClaw 2026.10.6 package the development gateway pins. Chunk names carry a build hash, so search by function name if a name changes. **Live** means it was seen on a development gateway, started by `pnpm dev-gateway` with the stand-in coding agent's `show_board` tool and the `#mcp-app` directive. **Source** means it was read only. Findings 1, 2 and 5 were also read in 2026.11.10's source, which has the same code.

## Findings

| #   | What                                                                                                                                                                                                                                                                                                       | Evidence                                                                                                                                         | Kind         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| 1   | The gateway marks a tool result as an MCP App only when `mcp.apps.enabled` is on and the tool declares `_meta.ui.resourceUri`. It then adds `details.mcpAppPreview`, whose `mcpApp` is `{viewId, serverName, toolName, uiResourceUri, toolCallId, originSessionKey}`.                                              | `<openclaw>/dist/agent-bundle-mcp-materialize-*.mjs`, the `mcpAppsEnabled && tool.uiResourceUri` branch; `buildMcpAppCanvasPayload` in `<openclaw>/dist/mcp-ui-resource-*.mjs` | live, source |
| 2   | The marker is in the live `agent` stream, as the tool result's `data.result.details.mcpAppPreview`, and in `chat.history`, as the result row's `details.mcpAppPreview`. History keeps it through its display projection, which drops most other details. It drops `mcpApp` when the view id is longer than 128 characters. | `<openclaw>/dist/chat-display-projection.canvas-*.mjs`, `coerceMcpAppDescriptor` and the `mcpAppPreview` projection; `pnpm scenarios`, "an MCP App call" | live, source |
| 3   | `mcp.app.view {sessionKey, viewId}` returns the app's HTML, its tool input and result, the sandbox listener's port and a sandbox path. It needs `operator.read`.                                                                                                                                         | `<openclaw>/dist/mcp-app-*.mjs`, the `mcp.app.view` handler; `<openclaw>/dist/core-method-policy-*.mjs`                                         | live, source |
| 4   | To show the app, a client must either embed the gateway's sandbox page in a frame of its own and relay the app's messages, or open the gateway's own `standaloneUrl`.                                                                                                                                   | `<openclaw>/docs/cli/mcp/apps.md`                                                                                                                | source       |
| 5   | The gateway makes a `standaloneUrl` only for a view with no requester: `createMcpAppStandaloneTicket` returns nothing when the view has a `requesterId`. A run started from a paired device has one, so `mcp.app.view` returned no `standaloneUrl` for it.                                                  | `<openclaw>/dist/mcp-app-standalone-*.mjs`, `createMcpAppStandaloneTicket`                                                                     | live, source |
| 6   | The sandbox listener runs on the port after the gateway's. A development instance's port block keeps that port free.                                                                                                                                                                                      | `tools/dev-gateway/src/instance.ts`, `NAMED_PORT_BLOCK`                                                                                         | source       |

## What Clawtrate does

Clawtrate embeds nothing. A frame that runs a tool server's script, and a relay for its messages, would be a new surface to secure in the desktop app and in the web preview, for one feature.

The engine keeps the marker on the step and on the history block, as `mcpApp {serverName, toolName, viewId}`, each cut to its bound (`mcpAppOf` in `packages/core/src/mapping.ts`). The result's card labels the result "An app from &lt;server&gt;", and the result's text stays readable under it. The card offers no Open app, because for a run this device started there is nothing to open (finding 5). The marker is read only from the gateway's `details`, never from the tool's own text.

## Gaps

- The gateway gives a paired device no page to open for an app view it requested. Until it does, Open app (`docs/parity.md`, F-615) stays `todo`.
- A view lives only as long as the gateway's view store keeps it. The marker in history can name a view that has expired. `mcp.app.view` would then fail, and Open app must say so.

## Request to OpenClaw

The text below is ready to file with OpenClaw. It has not been filed.

```text
Title: Standalone MCP App page for a view a paired device requested

What happens
mcp.app.view returns standaloneUrl only for a view with no requester.
createMcpAppStandaloneTicket returns early when view.requesterId is set.
A run started from a paired operator device always has a requester, so
the device gets no standaloneUrl for the apps its own runs show. To show
the app, the client must embed the sandbox page in a frame of its own
and relay the app's messages itself.

What we ask
Let mcp.app.view create a standalone ticket bound to the requester: the
device id, or the profile, that the view's requesterId names. The page
behind the ticket would accept it only from that same device or profile,
with the same expiry and tool-operation rules the ticket has today. A
client could then open the gateway's own page for the view, in a browser
window, without building a sandbox of its own.

Why
Clients that are not the Control UI, such as desktop and mobile apps,
can show MCP App results with the gateway's own sandbox and permission
checks, instead of each building and securing its own embedding.

Seen on OpenClaw 2026.10.6, and the same code in 2026.11.10.
```
