// Clawtrate links from the operating system (docs/design/links.md). macOS sends
// them as `open-url`, also the one that launched the app; Windows and Linux
// start the app, or a second copy that hands over, with the link as an
// argument. Each link is validated here, and only the latest is held until the
// window takes it. The renderer gets its values, never the raw link.

import { CHAT_LINK_SCHEME, deliverChatLink, type ChatLinkDelivery } from "@clawtrate/core";

/** The last of a launch's arguments in Clawtrate's scheme, in any case, or null. */
export function linkArgument(argv: readonly string[]): string | null {
  const scheme = `${CHAT_LINK_SCHEME}:`;
  return argv.findLast((arg) => arg.slice(0, scheme.length).toLowerCase() === scheme) ?? null;
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
