// #637: a system event the gateway woke a task with, on a gateway that writes the event as its
// own row (OpenClaw 2026.11.10): the gateway's quiet line, with the event's text behind a
// disclosure that names no author, and none of a person's or a bot's message parts. The mounted
// conversation is checked in visual/gateway-event.visual.spec.ts. Rows have the fields a
// development instance of 2026.11.10 returned, with made-up ids.

import { mapHistory } from "@clawtrate/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GatewayEventLine } from "../src/GatewayEventLine.tsx";

const row = (text: string) => ({
  role: "user",
  content: text,
  timestamp: 1_800_000_000_000,
  idempotencyKey: "ev-key",
  provenance: { kind: "internal_system", sourceTool: "exec" },
  __openclaw: {
    senderIsOwner: false,
    transport: { channel: "webchat", messageId: "ev-key" },
    id: "ev-1",
    idempotencyKey: "ev-key",
    seq: 3,
  },
});

const markupOf = (text: string) => {
  const [item] = mapHistory([row(text)], { gatewayEvents: true });
  return renderToStaticMarkup(createElement(GatewayEventLine, { item: item! }));
};

describe("#637: the gateway's event line", () => {
  it("says the gateway started a turn, once, with the event's text behind a disclosure that names no author", () => {
    const markup = markupOf("Exec completed (b7d41c2e, code 0, 12s): the command you ran finished");
    expect(markup).toMatch(
      /^<div class="update-line" data-testid="gateway-event"><p class="event-line" data-side="center">The gateway started a turn by itself<\/p>/,
    );
    expect(markup).toMatch(
      /<details class="event-details"><summary class="event-line" data-side="center">Event text<svg[^>]*aria-hidden="true"/,
    );
    expect(markup).toContain(
      '<p class="gateway-event-text">Exec completed (b7d41c2e, code 0, 12s): the command you ran finished</p>',
    );
  });

  it("has none of a message's parts: no avatar, bubble, name or actions, and no button but the disclosure", () => {
    const markup = markupOf("Exec completed (b7d41c2e, code 0, 12s): done");
    for (const part of ["avatar", "bubble", "msg", "msg-actions", "<button", "You"])
      expect(markup).not.toContain(part);
  });

  it("shows the event's text as text, never as markup, its line breaks kept", () => {
    const markup = markupOf("<img src=x onerror=alert(1)> **bold**\n[link](https://example.com)");
    expect(markup).not.toContain("<img");
    expect(markup).toContain(
      "&lt;img src=x onerror=alert(1)&gt; **bold**\n[link](https://example.com)",
    );
  });
});
