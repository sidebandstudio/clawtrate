// The first-bot prompt (bots.md section 3, "The first bot") and the note in a
// new bot's first task (controls.md section 10). The prompt shows only on a
// gateway whose reads confirmed an unused implicit `main`; it never creates a
// bot by itself and writes nothing to that `main`.

import type { ConnectionState, FirstBotState, HostInfo, NewBotPolicy } from "@clawtrate/core";
import { useEffect, useState } from "react";
import { Character } from "../Avatar.tsx";
import { ShieldIcon } from "../icons.tsx";
import { useBridge } from "../bridge.tsx";
import { AdminBar, Note } from "./parts.tsx";
import { mainPolicySentence, policyNote } from "./policy-words.ts";

/** "Make your first bot", in the conversation's empty-state frame. */
export function FirstBotPrompt({
  firstBot,
  connection,
  info,
  onNewBot,
}: {
  firstBot: FirstBotState;
  connection: ConnectionState;
  info: HostInfo;
  /** Open New bot, as the "+" menu does; called once the reads are checked again. */
  onNewBot: () => void;
}) {
  const bridge = useBridge();
  const [checking, setChecking] = useState(false);
  const admin = connection.canAdmin && !info.readOnly;
  const reported = mainPolicySentence(firstBot.mainPolicy);
  const start = async () => {
    setChecking(true);
    try {
      // The current gateway is read again before the walk starts.
      const again = await bridge.invoke({ type: "recheckFirstBot" });
      if (again.status === "prompt") onNewBot();
    } catch {
      // The reads failed: the roster as it is shows.
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="transcript-wrap">
      <div className="transcript" data-testid="transcript">
        <div className="empty first-bot" data-testid="first-bot">
          <div>
            <span className="b-preview" aria-hidden="true">
              <Character spec={{ body: "drop", color: "#ff6f9c", tilt: 0, look: [0.6, 0] }} />
            </span>
            <h1 tabIndex={-1}>Make your first bot</h1>
            <p>
              Give it a name and a picture, choose the account it runs on and how it runs commands.
            </p>
            {admin ? (
              <div className="empty-actions">
                <button
                  type="button"
                  className="button"
                  data-variant="primary"
                  disabled={checking}
                  autoFocus
                  onClick={() => void start()}
                >
                  New bot
                </button>
              </div>
            ) : (
              <div className="first-bot-below">
                <p>Creating a bot changes the gateway's settings, which needs admin access.</p>
                {reported && <p data-testid="main-policy">{reported}</p>}
                {/* The line above says why; the bar asks. */}
                <AdminBar connection={connection} info={info} need="" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** How often a shown note reads the bot's setting again: another viewer may have changed it. */
export const POLICY_READ_MS = 15_000;

/**
 * What a new bot's first task says above its composer, as read: the saved
 * setting, then the reported default policy, or that the setting couldn't be
 * confirmed, where it is, and what may be done. While shown, it reads both
 * facts again now and then.
 */
export function PolicyNote({ policy, canAdmin }: { policy: NewBotPolicy; canAdmin: boolean }) {
  const bridge = useBridge();
  const note = policyNote(policy);
  const settled = policy.status === "confirmed" || policy.status === "checking";
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => {
    const read = () => void bridge.send({ type: "refreshBotPolicies" }).catch(() => {});
    read();
    const timer = setInterval(read, POLICY_READ_MS);
    return () => clearInterval(timer);
  }, [bridge, policy.botId]);
  return (
    <div className="policy-note" role="status" data-testid="policy-note">
      {/* A setting read back carries the shield; one still being read, the clock. */}
      <Note
        tone={note.tone}
        {...(policy.status === "confirmed" && !note.tone ? { icon: <ShieldIcon /> } : {})}
      >
        {note.title && (
          <p>
            <b>{note.title}</b>
          </p>
        )}
        {note.lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {refusal && !settled && <p data-testid="policy-refusal">{refusal}</p>}
        {!settled && policy.retryable && canAdmin && (
          <div className="b-actions">
            <button
              type="button"
              className="button"
              data-variant="primary"
              data-size="sm"
              onClick={() => {
                setRefusal(null);
                // A refused write changes nothing on the gateway: the note says why.
                bridge
                  .send({ type: "retryBotPolicy", botId: policy.botId })
                  .catch((error: unknown) =>
                    setRefusal(error instanceof Error ? error.message : String(error)),
                  );
              }}
            >
              {policy.restrictive ? "Write it again" : "Write them again"}
            </button>
          </div>
        )}
      </Note>
    </div>
  );
}
