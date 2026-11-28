// A turn the gateway started itself, in the iPhone chat (#699), as the desktop draws it
// (`packages/ui/src/GatewayEventLine.tsx`; a unit test keeps the words the same): the
// gateway's line is the centred row, and the text its event came with is one step away,
// closed until opened. Whatever caused the event chose that text (a command's output, a
// bot's wake, another app), so it never shows without saying so first, and it shows as
// text: no markdown, links or pictures.

export const GATEWAY_EVENT_WORDS = {
  toggle: "Text that came with it",
  note: "Written by whatever started this turn (a command, a bot or another app), not by the gateway or Clawtrate.",
} as const;

/** What the disclosure shows: closed, its button alone; open, the note and then the text. */
export type GatewayEventView = {
  /** The disclosure's button: its words, and whether it is open. */
  toggle: { label: string; expanded: boolean };
  /** Only while open. `spoken` reads the note before the text, as one. */
  body: { note: string; text: string; spoken: string } | null;
};

/** The disclosure for an event's `text`, closed unless `open`. */
export function gatewayEventView(text: string, open = false): GatewayEventView {
  const { toggle, note } = GATEWAY_EVENT_WORDS;
  return {
    toggle: { label: toggle, expanded: open },
    body: open ? { note, text, spoken: `${note} ${text}` } : null,
  };
}
