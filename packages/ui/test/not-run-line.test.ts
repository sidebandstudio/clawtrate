// The line under a message the gateway couldn't run (#663, F-480): the gateway's reason in plain
// words, and the ways forward, each kind as the gateway says it; nothing it didn't say.

import { newRun, type Run } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { requestBotSettings, setBotSettingsOpener } from "../src/bots/settings-request.ts";
import { endingOf, notRunWords } from "../src/live.ts";

const NOW = 1_795_000_000_000;

/** A run this client followed, failed with the gateway's words and nothing reported started. */
const failed = (message: string, change: Partial<Run> = {}): Run => ({
  ...newRun("run-1", { state: "running", origin: "local", bound: true }, NOW),
  state: "failed",
  outcomeKnown: true,
  endedAt: NOW + 300,
  error: { message, kind: null },
  ...change,
});

/** What the line says, and the ways forward before Try again: as the card draws them. */
function words(run: Run): string {
  const ending = endingOf(run);
  if (ending?.kind !== "not-run" && ending?.kind !== "not-started")
    return `not a not-run line: ${ending?.kind ?? "none"}`;
  const said = notRunWords(ending, "Otto");
  const ways = said.ways.map((way) => (way === "model" ? "Change model" : "Change account"));
  return [said.title, said.reason, ...ways].join(" | ");
}

describe("#663: a message the gateway couldn't run says so, and why", () => {
  it("F-480: a model that needs an API key on a sign-in account: why, and the model and account", () => {
    const run = failed(
      'Auth profile "acme:default" uses oauth auth, but acme/acme-responses requires an Acme API key profile.',
    );
    expect(words(run)).toBe(
      "The gateway couldn't run this message | Otto is set to a model that needs a provider API key, but the account it uses is a sign-in. Choose a model that works with that sign-in, or add an API key. | Change model | Change account",
    );
  });

  it("F-480: each kind the gateway names has its own sentence and ways forward", () => {
    const of = (message: string) => {
      const ending = endingOf(failed(message));
      expect(ending?.kind).toBe("not-run");
      return notRunWords(ending as Extract<typeof ending, { kind: "not-run" }>, "Otto");
    };
    expect(
      of(
        "This saved login isn't available. Choose another login under Models in the OpenClaw app or run `openclaw configure`.",
      ),
    ).toEqual({
      title: "The gateway couldn't run this message",
      reason: "The account Otto is set to isn't available on the gateway. Choose another account.",
      ways: ["account"],
    });
    expect(of('Error: Auth profile "acme:work" is not configured for globex.').ways).toEqual([
      "account",
      "model",
    ]);
    expect(of("Unknown model: nope/dev-1. Run `openclaw models list`.")).toMatchObject({
      reason: "The gateway doesn't know Otto's model. Choose another model.",
      ways: ["model"],
    });
    expect(
      of('No API key found for provider "globex". Auth store: /somewhere/auth.json.').reason,
    ).toBe(
      "The gateway found no account it can use for the provider of Otto's model. Add an account, or choose another model.",
    );
  });

  it("an account-kind reason other than the two read whole keeps the gateway's own remedy", () => {
    expect(
      words(
        failed(
          'Auth profile "acme:me" uses oauth auth, but acme/acme-responses requires token-sharing consent. Sign in again and enable sharing, or explicitly choose another inference credential.',
        ),
      ),
    ).toBe(
      'The gateway couldn\'t run this message | The gateway said: Auth profile "acme:me" uses oauth auth, but acme/acme-responses requires token-sharing consent. Sign in again and enable sharing, or explicitly choose another inference credential.',
    );
  });

  it("anything else is the gateway's own words, with Try again; a reason it didn't keep is not made up", () => {
    expect(words(failed("Error: The session is locked by another device."))).toBe(
      "The gateway couldn't run this message | The gateway said: The session is locked by another device.",
    );
    // 2026.11.10's history, after a reload, for a message it failed at dispatch.
    expect(
      words(
        failed("Your request couldn't be completed.", {
          origin: "history",
          error: { message: "Your request couldn't be completed.", kind: null, beforeReply: true },
        }),
      ),
    ).toBe("The gateway couldn't run this message | The gateway didn't say why.");
  });

  it("a message the gateway accepted and then ended with no run and no word", () => {
    const silent: Run = {
      ...newRun("run-1", { state: "running", origin: "local", bound: true }, NOW),
      state: "completed",
      outcomeKnown: false,
      endedAt: NOW + 9_000,
    };
    expect(words(silent)).toBe(
      "The gateway didn't start a run for this message | It didn't say why.",
    );
  });

  it("a run that started and then failed keeps its own card", () => {
    const started = failed("401 Invalid API key", { reportedStartAt: NOW + 10 });
    expect(endingOf(started)).toEqual({ kind: "failed", reason: "401 Invalid API key" });
    expect(words(started)).toBe("not a not-run line: failed");
    // History's run of a failed turn has no start of its own: only the gateway's row says it never ran.
    expect(endingOf(failed("401 Invalid API key", { origin: "history" }))?.kind).toBe("failed");
  });

  it("Change model and Change account open the bot's settings on that part", () => {
    const opened: string[] = [];
    const forget = setBotSettingsOpener(() => opened.push("settings"));
    requestBotSettings("otto", "account");
    expect(opened).toEqual(["settings"]);
    forget();
    requestBotSettings("otto", "model");
    expect(opened).toEqual(["settings"]);
  });
});
