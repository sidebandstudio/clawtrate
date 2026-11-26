// Unlock, and Clear a kept order, with a button (#660; bots.md section 10): the confirmation,
// which says what changes and that going back needs the gateway's command line, and the line
// that says how the press ended. The state the page shows comes from the gateway's own read;
// this line only says what the press did.

import { clearShown, type BotBinding, type OrderClear } from "@clawtrate/core";
import { Confirm } from "./Dialog.tsx";
import { CheckIcon } from "../icons.tsx";
import { Note, Wait } from "./parts.tsx";
import { clock } from "./words.ts";

/** What the confirmation is about, as the page read it. */
export type ClearAsk = {
  kind: OrderClear["kind"];
  provider: string;
  /** The one account the order names: the order the press acts on. */
  account: string;
};

export function ClearOrderConfirm({
  ask,
  name,
  who,
  named,
  bound,
  stopped,
  busy,
  onAction,
  onCancel,
}: {
  ask: ClearAsk;
  /** The bot's name. */
  name: string;
  /** The provider's name. */
  who: string;
  /** The account the order names, as the page names it. */
  named: string;
  /** The bot's own account, when it has one, as the page names it. */
  bound: string | null;
  /** The gateway's command line changes orders only while it is stopped. */
  stopped: boolean;
  busy: boolean;
  onAction: () => void;
  onCancel: () => void;
}) {
  const unlock = ask.kind === "unlock";
  const now =
    unlock && bound === named
      ? `${name}'s ordinary runs use ${named} only.`
      : unlock
        ? `The gateway's order for ${name} still lists only ${named}.`
        : `The gateway still has an order for ${name} that names only ${named}.`;
  const after = unlock
    ? `After this, ${name} follows the gateway's other orders, and when ${bound ?? named} fails the gateway may use another ${who} account.`
    : `After this, the gateway chooses among ${who}'s accounts for each of ${name}'s runs, by its other orders.`;
  const back = `${unlock ? `Locking ${name} again` : `Keeping ${name} on one account again`} ${
    stopped
      ? "needs the gateway stopped and a command on its machine"
      : "needs a command on the gateway's machine"
  }.`;
  return (
    <Confirm
      title={unlock ? `Unlock ${name}?` : `Clear ${name}'s order?`}
      text={`${now} ${after} ${back}`}
      action={unlock ? "Unlock" : "Clear order"}
      busy={busy}
      onAction={onAction}
      onCancel={onCancel}
    />
  );
}

/**
 * How the last press for this bot ended, in words, from the gateway's reads (`clearShown`).
 * Nothing once a later read shows the order back. Where the page has no Check now of its own
 * (a bot the gateway chooses for), `onCheck` puts one in the line of an ending that couldn't tell.
 */
export function ClearOutcome({
  clear,
  binding,
  name,
  who,
  named,
  onCheck,
  connected,
}: {
  clear: OrderClear;
  binding: BotBinding;
  name: string;
  who: string;
  /** The account the order named, as the page names it. */
  named: string;
  onCheck: (() => void) | null;
  connected: boolean;
}) {
  const shown = clearShown(clear, binding);
  if (!shown) return null;
  const unlock = clear.kind === "unlock";
  const doing = unlock ? `unlock ${name}` : `clear ${name}'s order`;
  const line = (tone: "warn" | undefined, text: string, alert = false, check = false) => (
    // Apart from the account's facts that follow it.
    <div style={{ marginBottom: 12 }}>
      <Note tone={tone} icon={tone ? undefined : <CheckIcon />} testId="clear-outcome">
        <p role={alert ? "alert" : "status"} tabIndex={-1} data-bs="clear-outcome">
          {text}
        </p>
        {check && onCheck && (
          <div className="b-actions">
            <button
              type="button"
              className="button"
              data-size="sm"
              disabled={!connected}
              onClick={onCheck}
            >
              Check now
            </button>
          </div>
        )}
      </Note>
    </div>
  );
  // The order the page's last read found: the same one account, or another order.
  const same =
    binding.provider === clear.provider &&
    binding.order?.stored === true &&
    binding.order.ids.length === 1 &&
    binding.order.ids[0] === clear.account;
  switch (shown.status) {
    case "sending":
      return <Wait>{unlock ? `Unlocking ${name}…` : `Clearing ${name}'s order…`}</Wait>;
    case "cleared":
      return line(
        undefined,
        `${unlock ? "Unlocked" : "Cleared"}. The gateway no longer keeps an order for ${name} that names only ${named}${
          unlock
            ? `, so ${name} follows its other orders`
            : `, so it chooses among ${who}'s accounts for ${name}`
        }. Checked with the gateway${shown.checkedAt ? ` at ${clock(shown.checkedAt)}` : ""}.`,
      );
    case "refused":
      return line(
        "warn",
        `The gateway refused to ${doing}: ${clear.error ?? "no reason given"}.`,
        true,
      );
    case "unanswered":
      return line(
        "warn",
        `The gateway didn't answer${clear.error ? ` (${clear.error})` : ""}, so Clawtrate can't tell yet whether ${name}'s order was cleared. Check now reads it again.`,
        true,
        true,
      );
    case "kept":
      return line(
        "warn",
        same
          ? `The gateway answered, but its order for ${name} still names only ${named}. Check now reads it again.`
          : `The gateway answered, but it still keeps an order for ${name}. Check now reads it again.`,
        true,
        true,
      );
    case "unread":
      return line(
        "warn",
        `The gateway answered, but Clawtrate couldn't read ${name}'s order back, so it can't say yet whether it was cleared. Check now reads it again.`,
        true,
        true,
      );
    case "moved":
      return line(
        "warn",
        `${name}'s order changed on the gateway while this was open, so Clawtrate sent nothing. The page shows the order as the gateway has it now.`,
        true,
      );
    case "unsent":
      return line(
        "warn",
        // The host's own refusal already says nothing was sent; anything else is why.
        clear.error && /nothing was sent/i.test(clear.error)
          ? clear.error
          : `Nothing was sent.${clear.error ? ` ${clear.error}` : ""}`,
        true,
      );
  }
}
