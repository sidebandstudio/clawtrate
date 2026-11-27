// A task's name, written by a small model (#750). The device that sends a task's first message with
// text asks the gateway for a title with `sessions.title.prepare` (OpenClaw 2026.10.6 and 2026.11.10,
// scope `operator.write`): a one-off call with the title instruction and the message, no tools and
// no session of its own, which leaves nothing behind (no task, no message, no run). The gateway
// answers it with the small model of the provider of the `model` it is given (that provider's
// `defaultUtilityModel`), or with the model its own `agents.defaults.utilityModel` names. It answers
// `null` when that small model is the `model` itself, when the provider has none, and when the call
// fails or gives no text. The name is kept in the task's `autoLabel`, so every device running
// Clawtrate shows it; a name the person or the bot gave (`label`) always comes first.

import { readCatalog, type CatalogModel } from "./accounts.ts";
import { asRecord, type RawRecord } from "./mapping.ts";
import type { TranscriptItem } from "./types.ts";

/**
 * Who writes a task's name, in order of preference: each provider with the ids of its small model
 * (the one its OpenClaw plugin names `defaultUtilityModel`: 2026.10.6 and 2026.11.10 name these two
 * providers only). Adding a provider is one line. The ids are here only so that the model the call
 * names is never the small one itself, which the gateway answers with no title.
 */
export const NAMING_MODELS: readonly { provider: string; small: readonly string[] }[] = [
  { provider: "openai", small: ["gpt-6-luna", "gpt-5.6-luna"] },
  { provider: "anthropic", small: ["claude-haiku-5-5"] },
];

/** The most title calls one task's name makes: one per provider above (the bot's own is one). */
export const MAX_NAMING_CALLS = NAMING_MODELS.length;
/** The longest message the gateway takes for a title (`SessionsTitlePrepareParams.message`). */
export const MAX_NAMING_SOURCE_CHARS = 1000;
/** The longest name kept, as the gateway cuts a title (`DASHBOARD_SESSION_TITLE_MAX_CHARS`). */
export const MAX_TASK_NAME_CHARS = 60;

function providerOf(model: string | null): string | null {
  const slash = model?.indexOf("/") ?? -1;
  return slash > 0 ? model!.slice(0, slash).toLowerCase() : null;
}

/** Whether a bot's provider is one of those above, which may name each other's tasks. */
export function namesAcross(botModel: string | null): boolean {
  const own = providerOf(botModel);
  return NAMING_MODELS.some(({ provider }) => provider === own);
}

/**
 * The calls to try for a name, in order. Each call is a `model` to name, or null for none (the
 * gateway then uses the bot's own provider's small model).
 * - A bot on a provider above: for each provider above that the person has connected, a model of it
 *   (none for the bot's own); its person's words may go to the other one, on their own account.
 * - A bot on any other provider, or one whose provider isn't known (a model the person runs
 *   themselves, a provider they chose instead): its own provider's alone, so the words go to no
 *   company the bot doesn't talk to.
 */
export function namingCalls(
  botModel: string | null,
  catalogue: readonly CatalogModel[],
): (string | null)[] {
  if (!namesAcross(botModel)) return [null];
  const own = providerOf(botModel);
  const calls: (string | null)[] = [];
  for (const { provider, small } of NAMING_MODELS) {
    if (provider === own) {
      if (!calls.includes(null)) calls.push(null);
      continue;
    }
    const model = catalogue.find(
      (each) => each.provider === provider && each.available && !small.includes(each.id),
    );
    if (model) calls.push(`${model.provider}/${model.id}`);
  }
  return calls;
}

/**
 * Whether a message this client sends now is still the first with text in a task it made: each
 * person's row in the task's history is one of this client's messages with no text (`textless`,
 * their ids; the gateway stores each under `<id>:user`). With none sent yet, a last-message preview
 * on the task's row is someone else's message too; once this client has sent one, the preview can be
 * that message or the bot's reply to it.
 */
export function firstWithText(
  items: readonly TranscriptItem[],
  textless: readonly string[],
  preview: unknown,
): boolean {
  const ours = (key: string | undefined) =>
    key !== undefined && textless.some((id) => key === id || key === `${id}:user`);
  if (items.some((item) => item.role === "user" && !ours(item.idempotencyKey))) return false;
  return textless.length > 0 || !preview;
}

/** Whether a task has a name already: one the person or the bot gave, or one made before. */
export function hasName(row: RawRecord | null): boolean {
  return (
    (typeof row?.label === "string" && row.label.trim() !== "") ||
    (typeof row?.autoLabel === "string" && row.autoLabel.trim() !== "")
  );
}

/** The message a name is made from: the person's own words, cut to what the gateway takes. */
export function namingSource(text: string): string {
  const chars = [...text.trim()];
  let out = "";
  for (const char of chars) {
    if (out.length + char.length > MAX_NAMING_SOURCE_CHARS) break;
    out += char;
  }
  return out;
}

export type NamingContext = {
  request: (method: string, params: unknown) => Promise<unknown>;
  /** The task's row as the client has it now, or null. */
  row: () => RawRecord | null;
};

/**
 * Make a task's name and keep it on the gateway. Answers the name kept, or null: when the task
 * has one already (asked before each call and before it is kept), or when no call gave a title.
 * Nothing it meets is shown to anyone: a refused, failed or empty call goes on to the next.
 */
export async function nameTask(
  ctx: NamingContext,
  task: {
    key: string;
    /** The session the task was created as, from the creation's answer, else its row's. */
    sessionId: string | null;
    botId: string;
    botModel: string | null;
    text: string;
  },
): Promise<string | null> {
  const message = namingSource(task.text);
  if (!message || hasName(ctx.row())) return null;
  let catalogue: CatalogModel[] = [];
  try {
    // Only a bot whose provider may be named across needs the person's other providers.
    if (namesAcross(task.botModel))
      catalogue = readCatalog(await ctx.request("models.list", { agentId: task.botId }));
  } catch {
    // Without the list, the bot's own provider still names it.
  }
  for (const model of namingCalls(task.botModel, catalogue)) {
    if (hasName(ctx.row())) return null;
    let title: string | null = null;
    try {
      const answer = asRecord(
        await ctx.request("sessions.title.prepare", {
          agentId: task.botId,
          message,
          ...(model ? { model } : {}),
        }),
      );
      title = typeof answer?.title === "string" ? answer.title.trim() : null;
    } catch {
      // Refused or failed: the next one.
    }
    if (!title) continue;
    const row = ctx.row();
    if (hasName(row)) return null;
    // Bound to the task's own session: the gateway refuses it for a task deleted meanwhile, which a
    // patch by key alone would make again.
    const sessionId = task.sessionId ?? (typeof row?.sessionId === "string" ? row.sessionId : null);
    if (!sessionId) return null;
    const name = [...title].slice(0, MAX_TASK_NAME_CHARS).join("");
    try {
      await ctx.request("sessions.patch", {
        key: task.key,
        autoLabel: name,
        expectedSessionId: sessionId,
      });
      return name;
    } catch {
      return null;
    }
  }
  return null;
}
