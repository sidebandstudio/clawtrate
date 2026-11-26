// What a person's message from Clawtrate carries so that the bot can tell where it is (#666). The
// gateway calls every message an app sends it "webchat", whichever app sent it, and nothing about
// how Clawtrate connects reaches the model. `chat.send`'s `workContext` does: OpenClaw 2026.10.6
// and 2026.11.10 add it to the model's copy of the message, after the person's words, as
// "Working context captured at send time. … {"page":"Clawtrate"}", and keep the person's own
// text as the message everywhere it is shown. Nothing in OpenClaw sets this value by itself.
//
// It tells a bot where it is. It proves nothing: any client of the gateway may send the same
// value, so nothing in Clawtrate reads it back as evidence of who sent a message.

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";

/** The marker, fixed: nothing from the conversation, the person or the device. */
export const CLAWTRATE_WORK_CONTEXT = { page: "Clawtrate" } as const;

/**
 * Whether the gateway refused a `chat.send` because of the marker, and so the same message
 * goes once more without it under the same key:
 * - `message`: this message can't carry it. The gateway takes the field on ordinary chat
 *   messages only, not on a command, `/btw` or a stop word ("Working context is only supported
 *   for ordinary chat messages."). And a replay of the key whose first copy the gateway can't
 *   compare is refused as "The previous mention selections cannot be verified. …": Clawtrate
 *   sends no mentions, so only the marker can cause it, and without the marker the replay is
 *   today's request.
 * - `gateway`: this gateway's schema doesn't take the field: it is an unexpected property, or
 *   its value doesn't fit. Every message would meet the same refusal on this connection.
 * - `null`: anything else, which is the message's own failure and is shown as today.
 * Both answers are the same on OpenClaw 2026.10.6 and 2026.11.10 (`INVALID_REQUEST`).
 */
export function markerRefusal(error: unknown): "message" | "gateway" | null {
  if (!(error instanceof GatewayProtocolRequestError) || error.gatewayCode !== "INVALID_REQUEST")
    return null;
  const text = error.message;
  if (text === "Working context is only supported for ordinary chat messages.") return "message";
  if (text.startsWith("The previous mention selections cannot be verified.")) return "message";
  if (
    text.startsWith("invalid chat.send params:") &&
    (text.includes("unexpected property 'workContext'") || /\bat \/workContext\b/.test(text))
  )
    return "gateway";
  return null;
}
