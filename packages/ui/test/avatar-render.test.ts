// The desktop and web renderer of the creatures (Avatar.tsx): every family in
// every state, with the state ring's host and badge kept, and a bot's own
// picture still in a circle. The sizes are checked in the browser
// (visual/avatars.visual.spec.ts).
import {
  AVATAR_MOTIONS,
  avatarScene,
  avatarVariation,
  pictureWithChoice,
  type AvatarChoice,
  type Bot,
} from "@clawtrate/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { avatarKeyframes, Presence, type FaceState } from "../src/Avatar.tsx";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC";

const FAMILIES: AvatarChoice[] = [
  { family: "clawling", body: "dome", eyes: "pair", claws: "fiddler", color: "blue" },
  { family: "shellfolk", shell: "spotted", color: "pink" },
  { family: "lantern", body: "bell", lure: "wave", eyes: "one", color: "lime" },
];
const STATES: FaceState[] = [
  "idle",
  "thinking",
  "working",
  "waiting",
  "blocked",
  "failed",
  "done",
  "stopped",
];

function bot(avatarUrl: string | null, id = "atlas"): Bot {
  return { id, name: "Atlas", emoji: null, avatarUrl, theme: null, model: null, isDefault: false };
}

const render = (b: Bot, state: FaceState, badge: "failed" | null = null) =>
  renderToStaticMarkup(createElement(Presence, { bot: b, state, badge }));

describe("the creature renderer", () => {
  it("draws a bot without a picture as its own Clawling", () => {
    const html = render(bot(null), "idle");
    expect(html).toContain('data-family="clawling"');
    expect(html).toContain('data-kind="character"');
    expect(html).not.toContain("<img");
  });

  for (const choice of FAMILIES)
    it(`draws ${choice.family} in every state, with its motions and its still pose`, () => {
      const kept = bot(pictureWithChoice(PNG, choice));
      for (const state of STATES) {
        const html = render(kept, state, state === "failed" ? "failed" : null);
        const pose = state === "failed" ? "blocked" : state === "stopped" ? "idle" : state;
        expect(html).toContain(`data-family="${choice.family}"`);
        expect(html).toContain(`data-state="${pose}"`);
        // Named with the state it shows, and the badge beside it.
        expect(html).toContain(
          `aria-label="Atlas, ${state === "waiting" ? "waiting for you" : state}"`,
        );
        expect(html.includes('class="glyph"')).toBe(state === "failed");
        expect(html.includes("data-muted")).toBe(pose === "blocked");
        expect(html).not.toContain("<img");
        // Each motion the scene names is played, and nothing else.
        const named = new Set<string>();
        const visit = (shape: { motion?: string; kind: string; children?: unknown[] }) => {
          if (shape.motion) named.add(shape.motion);
          for (const child of (shape.children ?? []) as (typeof shape)[]) visit(child);
        };
        visit(avatarScene(choice, pose, avatarVariation("atlas")).root);
        const played = new Set([...html.matchAll(/animation:av-([a-z-]+) /g)].map((m) => m[1]));
        expect(played).toEqual(named);
        // Each eye's lid is clipped to its own white, in this avatar's own clip paths.
        for (const [, id] of html.matchAll(/clip-path="url\(#([^)]+)\)"/g))
          expect(html).toContain(`<clipPath id="${id}">`);
      }
    });

  it("marks only fine detail to drop at small sizes, and gives a waving claw a still pose", () => {
    const waving = render(bot(pictureWithChoice(PNG, FAMILIES[0]!)), "waiting");
    expect(waving).toMatch(/class="av-still" style="[^"]*--av-still:-54deg/);
    for (const [, part] of waving.matchAll(/class="av-fine"[^>]*data-part="([a-z]+)"/g))
      expect(["mouth", "glint", "pattern"]).toContain(part);
    expect(waving).toMatch(/class="av-fine"[^>]*data-part="mouth"/);
  });

  it("keeps a bot's own picture in a circle, with the ring's state", () => {
    const html = render(bot(PNG), "thinking");
    expect(html).toContain(`<img src="${PNG}"`);
    expect(html).toContain('data-kind="image"');
    expect(html).not.toContain("<svg");
  });

  it("turns every motion of the spec into CSS keyframes", () => {
    const css = avatarKeyframes();
    for (const name of Object.keys(AVATAR_MOTIONS)) expect(css).toContain(`@keyframes av-${name}{`);
    expect(css).toContain("@keyframes av-snap{0%{stroke-dasharray: 78 22;stroke-dashoffset: 0}");
    expect(css).toContain("93.5%{translate: 0px 6.7px}");
  });
});
