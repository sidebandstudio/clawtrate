// A task's name, written by a small model (#750). The device that sends a task's first message with
// text asks the gateway for a title with `sessions.title.prepare` (OpenClaw 2026.10.6 and 2026.11.10,
// scope `operator.write`): a one-off call with the title instruction and the message, no tools and
// no session of its own, which leaves nothing behind (no task, no message, no run). The gateway
// answers it with the small model of the provider of the `model` it is given (that provider's
// `defaultUtilityModel`), unless a utility model is set on the gateway (the bot's own
// `utilityModel`, else `agents.defaults.utilityModel`): that one is used instead of any model named,
// whatever the bot's provider (2026.10.6 `utility-model-Cuvv2ou2.mjs:62`; 2026.11.10
// `utility-model-BLcB-6eH.mjs:3`, `resolveUtilityModelSelectionForAgent`). It answers `null` when
// that small model is the `model` itself, when the provider has none, and when the call fails or
// gives no text. The name is kept in the task's `autoLabel`, so every device running
// Clawtrate shows it; a name the person or the bot gave (`label`) always comes first.

import { readCatalog, type CatalogModel } from "./accounts.ts";
import { asRecord, type RawRecord } from "./mapping.ts";

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
 *   themselves, a provider they chose instead): its own provider's alone. Clawtrate names no OpenAI
 *   or Anthropic model for that task; a utility model set on the gateway is used instead of any
 *   model the app names, whatever the bot's provider.
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

/** The rows of a task's history read fresh before an empty task is named (`onlyOwnRows`). */
export const FIRST_CHECK_ROWS = 40;

/**
 * Whether a task's history, read from the gateway just before its name is made, holds no person's
 * row but this client's own sends there (`own`: the ids of its messages with no text and of the
 * one with text; each row is stored as `<id>:user`). The history this client holds can be behind
 * the task's row, so another device's first message is looked for here too. A page cut short
 * (`hasMore`) or not read can't tell, and says no.
 */
export function onlyOwnRows(history: unknown, own: readonly string[]): boolean {
  const page = asRecord(history);
  if (!page || page.hasMore === true || !Array.isArray(page.messages)) return false;
  return page.messages.every((entry) => {
    const row = asRecord(entry);
    if (row?.role !== "user") return true;
    const stored = asRecord(row.__openclaw)?.idempotencyKey ?? row.idempotencyKey;
    return typeof stored === "string" && own.some((id) => stored === id || stored === `${id}:user`);
  });
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
  /** The bot's model as the client has it now: it can change while the name is made. */
  botModel: () => string | null;
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
    /** The session the task was created as, from the creation's answer. */
    sessionId: string | null;
    botId: string;
    text: string;
    /** This client's sends in the task, checked against its history first (`onlyOwnRows`). */
    ownSends?: readonly string[];
  },
): Promise<string | null> {
  const message = namingSource(task.text);
  if (!message || hasName(ctx.row())) return null;
  // Bound to the session the task was created as: a reset or a delete and recreate since gives
  // the key another session, which this name is not for, and the row read now could already be
  // that one. The gateway refuses the patch for a task deleted meanwhile, which a patch by key
  // alone would make again.
  const sessionId = task.sessionId;
  if (!sessionId) return null;
  if (task.ownSends) {
    try {
      const history = await ctx.request("chat.history", {
        sessionKey: task.key,
        limit: FIRST_CHECK_ROWS,
      });
      if (!onlyOwnRows(history, task.ownSends)) return null;
    } catch {
      // Not known to be the first: no name.
      return null;
    }
  }
  let catalogue: CatalogModel[] = [];
  try {
    // Only a bot whose provider may be named across needs the person's other providers.
    if (namesAcross(ctx.botModel()))
      catalogue = readCatalog(await ctx.request("models.list", { agentId: task.botId }));
  } catch {
    // Without the list, the bot's own provider still names it.
  }
  for (const model of namingCalls(ctx.botModel(), catalogue)) {
    if (hasName(ctx.row())) return null;
    // The bot moved meanwhile to a provider whose tasks no other provider names.
    if (model && !namesAcross(ctx.botModel())) continue;
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
    // The row now names another session: the task was reset or made again under this key.
    if (typeof row?.sessionId === "string" && row.sessionId !== sessionId) return null;
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
