// Clawtrate links from the operating system (docs/design/links.md). macOS sends
// them as `open-url`, also the one that launched the app; Windows starts the
// app, or a second copy that hands over, with the command its installer
// registered, `"<app>" -- "%1"`. Each link is validated here, and only the
// latest is held until the window takes it. The renderer gets its values, never
// the raw link.

import { CHAT_LINK_SCHEME, deliverChatLink, type ChatLinkDelivery } from "@clawtrate/core";

/**
 * The link a launch was given, or null: what follows the first `--`, when it starts
 * with Clawtrate's scheme in any case. After `--` Chromium reads no switches
 * (base/command_line.cc), so a link Windows splits at a quote or a space cannot pass
 * one. One argument is the link; several are a link Windows split, which the parser
 * refuses, since a link holds no space.
 */
export function linkArgument(argv: readonly string[]): string | null {
  const end = argv.indexOf("--");
  if (end === -1) return null;
  const given = argv.slice(end + 1);
  const scheme = `${CHAT_LINK_SCHEME}:`;
  if (given[0]?.slice(0, scheme.length).toLowerCase() !== scheme) return null;
  return given.join(" ");
}

/**
 * Whether a launch's arguments give the switch `--<name>`, read as Chromium and
 * Electron's Node read them: only before the first `--`. A switch after it opens no
 * debugging port or inspector (checked with Electron 45.3.2), so a piece of a link
 * Windows split does not count as one either.
 */
export function givesSwitch(argv: readonly string[], name: string): boolean {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).some(
    (arg) => arg === `--${name}` || arg.startsWith(`--${name}=`),
  );
}

/** The one link waiting for the window: a later link replaces it. */
export class LinkInbox {
  private next = 1;
  private held: ChatLinkDelivery | null = null;
  private readonly arrived: () => void;

  /** `arrived` tells the window a link is waiting. */
  constructor(arrived: () => void) {
    this.arrived = arrived;
  }

  receive(raw: string): void {
    this.held = deliverChatLink(this.next++, raw);
    this.arrived();
  }

  /** The waiting link, once. */
  take(): ChatLinkDelivery | null {
    const held = this.held;
    this.held = null;
    return held;
  }
}
