// The files a person sent, on their own message (#451): which is drawn as a
// picture, which is a named file, and each state of a picture: loading, shown,
// and each line for one that can't be shown (#469), in the order sent.

import type { ClawtrateBridge, SentAttachment } from "@clawtrate/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../src/bridge.tsx";
import {
  SENT_PICTURE_LINES,
  SentFiles,
  SentPictureView,
  type SentPictureShown,
} from "../src/SentFiles.tsx";

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

  it("F-557: with no message to ask for, a picture says plainly that this connection can't load it", () => {
    const { html, kinds } = render([shot], null);
    expect(kinds).toEqual(["sent-picture:cannot-load"]);
    expect(html).toContain("shot.png");
    expect(html).toContain("This connection can&#x27;t load the picture back from the gateway.");
  });

  it("F-557: a message without files draws nothing for them", () => {
    expect(render([], "m1:user").html).toBe("");
  });
});

const view = (shown: SentPictureShown) =>
  renderToStaticMarkup(
    createElement(SentPictureView, {
      file: shot,
      shown,
      onRetry: () => {},
      onDrawError: () => {},
    }),
  );
const decode = (html: string) => html.replaceAll("&#x27;", "'");

describe("F-557: each state of a picture you sent", () => {
  it("F-557: loading is a quiet placeholder of the picture's place, with no line to read", () => {
    const html = view({ status: "loading" });
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('class="visually-hidden">Loading Your picture: shot.png<');
    for (const line of Object.values(SENT_PICTURE_LINES)) expect(decode(html)).not.toContain(line);
    expect(html).not.toContain("shot.png</span><span");
    expect(html).not.toContain("<button");
  });

  it("F-557: shown is the picture, a button that opens it larger, with its text", () => {
    const html = view({ status: "shown", url: "data:image/png;base64,iVBORw0KGgo=" });
    expect(html).toContain('data-state="shown"');
    expect(html).toContain('alt="Your picture: shot.png"');
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  });

  it("F-557: each picture that can't be shown has its name, its size and one plain line; only a failed read offers Try again", () => {
    expect(SENT_PICTURE_LINES).toEqual({
      "cannot-load": "This connection can't load the picture back from the gateway.",
      gone: "The gateway no longer keeps this picture.",
      failed: "The picture didn't load.",
    });
    for (const status of ["cannot-load", "gone", "failed"] as const) {
      const html = decode(view({ status }));
      expect(html).toContain(`data-state="${status}"`);
      expect(html).toContain("shot.png");
      expect(html).toContain(">2 KB<");
      expect(html).toContain(SENT_PICTURE_LINES[status]);
      expect(html).not.toContain("<img");
      expect(html).not.toContain('role="alert"');
      expect(html.includes(">Try again</button>"), status).toBe(status === "failed");
    }
  });

  it("F-557: a picture whose bytes aren't one is a named file, with no line", () => {
    const html = view({ status: "not-a-picture" });
    expect(html).toContain('data-testid="sent-file"');
    expect(html).toContain("shot.png");
    for (const line of Object.values(SENT_PICTURE_LINES)) expect(decode(html)).not.toContain(line);
  });
});
