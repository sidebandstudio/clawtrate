// The files a person sent, on their own message (#451): which is drawn as a
// picture from this app's copy, which is a named file, and what another device
// says, in the order sent.

import type { ClawtrateBridge, SentAttachment } from "@clawtrate/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../src/bridge.tsx";
import { SentFiles } from "../src/SentFiles.tsx";

const shot: SentAttachment = { fileName: "shot.png", mimeType: "image/png", sizeBytes: 2_048 };
const notes: SentAttachment = { fileName: "notes.txt", mimeType: "text/plain", sizeBytes: 10 };
const large: SentAttachment = {
  fileName: "large.png",
  mimeType: "image/png",
  sizeBytes: 5_242_881,
};
const drawing: SentAttachment = {
  fileName: "drawing.svg",
  mimeType: "image/svg+xml",
  sizeBytes: 900,
};

function render(files: SentAttachment[], messageKey: string | null): HTMLLikeResult {
  const html = renderToStaticMarkup(
    createElement(BridgeProvider, {
      bridge: {} as ClawtrateBridge,
      children: createElement(SentFiles, { taskKey: "agent:pip:a", messageKey, files }),
    }),
  );
  return {
    html,
    kinds: [
      ...html.matchAll(/data-testid="(sent-picture|sent-file)"(?: data-state="([a-z-]+)")?/g),
    ].map((match) => (match[2] ? `${match[1]}:${match[2]}` : match[1]!)),
  };
}
type HTMLLikeResult = { html: string; kinds: string[] };

describe("F-557: your files on your message", () => {
  it("F-557: a picture this app may hold is asked for; a file, one over 5 MB and a type not drawn are named with their size, in order", () => {
    const { html, kinds } = render([shot, notes, large, drawing], "m1:user");
    expect(kinds).toEqual(["sent-picture:loading", "sent-file", "sent-file", "sent-file"]);
    expect(html.indexOf("notes.txt")).toBeLessThan(html.indexOf("large.png"));
    expect(html.indexOf("large.png")).toBeLessThan(html.indexOf("drawing.svg"));
    expect(html).toContain("5.0 MB");
    expect(html).not.toContain("<img");
  });

  it("F-557: with no copy to ask for, a picture says plainly that it was sent and isn't shown", () => {
    const { html, kinds } = render([shot], null);
    expect(kinds).toEqual(["sent-picture:not-kept"]);
    expect(html).toContain("shot.png");
    expect(html).toContain(
      "Picture sent with this message. The gateway doesn&#x27;t give it back to show here.",
    );
  });

  it("F-557: a message without files draws nothing for them", () => {
    expect(render([], "m1:user").html).toBe("");
  });
});
