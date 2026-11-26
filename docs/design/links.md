# Links into a bot’s chat

A Clawtrate link opens a bot’s chat and puts editable text in its composer, unsent. This design covers
F-248. Try the states from [Links into a bot’s chat](prototype/links.html) in the
prototype gallery.

## Contents

1. Shared rules and link form
2. The chat and its draft
3. When a link cannot open
4. What the gateway’s facts drive
5. Parity row to reword
6. For builders

## 1. Shared rules and link form

`clawtrate://chat?bot=marlow&gateway=<gateway-id>&text=Review%20the%20intro`

Use the literal lowercase prefix `clawtrate://chat?`. Require exactly one each
of `bot`, `gateway` and `text`, in any order. Separate fields with `&` and
values with `=`. The `gateway` value is the connected gateway’s public identity,
64 lowercase hexadecimal characters. It is only compared with the current
connection’s confirmed identity. It grants no access. The `bot` value is a
case-sensitive ID of 1–64 ASCII characters, starting with a lowercase letter or
digit and continuing with lowercase letters, digits, underscores or hyphens.

Reject a raw URL longer than 8,192 ASCII bytes. Values may contain ASCII letters,
digits, `.`, `_`, `~`, `-` and UTF-8 percent escapes. Encode spaces as `%20`
and a literal plus as `%2B`. Match parameter names before decoding and decode
values once. Reject malformed escapes and invalid UTF-8. Reject extra, duplicate
or empty fields, including a trailing `&`. Reject alternate schemes or routes,
userinfo, ports, paths and fragments. There are no fields for task IDs, gateway
addresses, credentials, attachments, settings or actions. An unknown field
invalidates the whole link.

In decoded text, turn CRLF and CR into LF and tabs into spaces. Refuse other
Unicode control characters (category Cc), Unicode line and paragraph separators
(U+2028 and U+2029), and bidi controls U+061C, U+200E–U+200F, U+202A–U+202E and
U+2066–U+2069. Strip leading and trailing whitespace with ECMAScript
`String.prototype.trim`. After stripping, require 1–2,000 Unicode code points.
Keep internal spaces, line breaks and printable Unicode. Every refusal uses
the invalid-link state below.

Treat the link as untrusted input. Insert its text as a textarea value. Markup,
Markdown, commands and URLs in the draft are plain text. Opening a link can
select a chat and edit its local draft. It cannot send, queue, steer, attach,
approve, run a tool, change settings, connect, or request more access. Never
log, display as an error detail, or forward the raw URL or its text. The normal
composer handles any later, deliberate send.

## 2. The chat and its draft

Bring the app forward. Once the current connection and its bot and task lists
are ready, verify the destination. Use the same existing chat as selecting the
bot in the rail. Open its last selected task if still available, or its most
recent task otherwise. A link cannot name or create a task. Save the draft of
the chat being left through the normal composer path.

| State                      | What is shown and what happens                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opened into an empty draft | Open the conversation. Fill the composer. Show and announce “Link text added to your draft. Nothing was sent.” Focus the field with the caret at the end. Drop the notice on edit or navigation.                                                                                                                                                                                                     |
| Existing draft             | Open the conversation and put the link's text in place of the draft, with nothing asked ("Doing, not asking"). Any non-empty draft counts, including whitespace. Show and announce “Replaced your draft. Nothing was sent.” with “Put it back”, which restores the earlier draft exactly and drops the link's text. Keep the earlier draft until the person sends, edits past it or leaves the chat. |

Use the composer and focus ring from [Visual language, section 8](visual-language.md#8-the-conversation)
and the composer behaviour from [Conversation, section 15](conversation.md#15-the-composer-during-a-run).
The status line above the composer uses secondary text and a polite live region.
It never appears as a message in the transcript. “Put it back” is a button in
that line, reached by Tab from the field.

At 1440, 1100 and 800 px, keep the normal rail and conversation layout, with
the line above the composer. At 390 px the conversation takes the whole pane
with Back to bots, and the line wraps above the composer. Use the same wording,
focus order and tokens in light and dark. The prototype's draft states still
show the earlier Keep draft and Replace draft choice until this conversion is
built (`doing-not-asking.md`, row D9).

## 3. When a link cannot open

Keep the current screen and drafts. Use the existing centred card with the
title “Can’t open link” and one “Close” button. Focus “Close”. Enter or Escape
dismisses the card and restores focus to the previous control, or the current
screen’s heading or title if the app just opened. The title and reason are the
dialog’s accessible name and description. At phone width use the existing bottom
card. The app never retries a refused link on its own.

Evaluate in this order. If normal startup is still loading, hold one validated
link in memory until the existing connection and discovery have an outcome.
Use the app’s existing loading screen, named “Loading conversation”, while it waits.

| State                    | When                                                          | Reason shown                                                                                                  |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Invalid link             | Any validation rule fails                                     | This Clawtrate link is invalid. Ask for a new link.                                                           |
| No gateway               | There is no connected gateway                                 | Clawtrate isn’t connected to a gateway. Connect to the right gateway, then open the link again.               |
| Chat details unavailable | The connection lacks a confirmed identity or discovery failed | Clawtrate couldn’t verify the gateway or load its bots and chats. Open the link again when they’re available. |
| Different gateway        | The confirmed identity differs from the link                  | This link is for a different gateway. Connect to that gateway, then open the link again.                      |
| Unknown bot              | The completed bot list has no matching ID                     | This bot isn’t on the connected gateway. Check the link or ask for a new one.                                 |
| No chat                  | The completed task list has no chat for this bot              | This bot has no chat to open.                                                                                 |
| Read-only                | The existing composer cannot edit a draft on this connection  | This device can read this chat. It can’t edit the draft.                                                      |

## 4. What the gateway’s facts drive

| Fact the app already has                                                        | What it shows                                                                                                                                 |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection state                                                                | The usual connection screen or strip. A disconnected link shows “No gateway”.                                                                 |
| Public identity from `gateway.identity.get`, in the current connection snapshot | Resolve bots only for the matching ID. Show “Different gateway” for a confirmed mismatch and “Chat details unavailable” for missing identity. |
| Bots and tasks from discovery for that connection                               | Use the confirmed bot name and existing chat. A completed list proves absence. Failed discovery yields “Chat details unavailable”.            |
| Granted access and host composer capability                                     | Reuse the composer’s existing guard. A link does not initiate an access request.                                                              |
| Local draft                                                                     | Fill an empty draft or ask before replacing it. This fact comes from the client.                                                              |

## 5. Parity row to reword

F-248 stays `todo`. A Clawtrate link opens the bot’s chat on the matching
connected gateway and fills its composer with editable, unsent text. Ask before
replacing an existing draft. Explain when the link cannot open.

## 6. For builders

1. Receive and validate the URL on the trusted host side. Give the renderer only
   the validated bot ID, gateway ID and text, or a typed refusal. Keep the
   Electron window on its own page under the main process rules in
   [Decisions](../decisions.md#apps). Issue #103 owns scheme registration.
2. Resolve against the current connection snapshot and normal bot selection.
   The engine supplies the connection identity, discovery and access it already
   reads. The link adds no gateway calls or scopes. The normal tiers apply to
   later explicit actions. Bind any choice to the connection and resolved chat.
   Clear pending link text on close or after applying it. If the connection or
   chat changes while the choice is open, discard the choice and show the
   applicable failure. If the draft changes, show the choice again for the new
   draft. A later link replaces the pending request and gets its own validation
   and choice.
3. Set the draft through the existing composer state. Issue #18 owns the
   composer. Use the existing dialog and live-region patterns for outcomes.
4. The prototype uses local fixtures. Its bar selects Opened, Loading, Existing draft,
   Invalid link, No gateway, Different gateway, Chat details unavailable,
   Unknown bot, No chat and Read-only. `?scene=draft` opens the choice, and
   `?link=` accepts an encoded sample URL for validation checks. The prototype
   stops at editing. Run
   `node docs/design/prototype/tools/checks/links.mjs` from the repository root.
