// The image checks: the gateway's image_generate tool with the stand-in image
// provider (scripted-images.ts), asserted from the gateway's answers.
// `pnpm scenarios` runs them on the computer checks' instance, which it starts
// with `--with-images` as well. docs/research/image-generation.md says what
// they establish.
//
// Clients: one paired operator with read and write, and one read-only.

import type { OperatorSession } from "./operator.ts";
import { IMAGE_MODEL_ID, scriptedPicture, type ImageRequestRecord } from "./scripted-images.ts";
import { IMAGE_PROMPT } from "./scenarios.ts";
import { IMAGE_FAILED_REPLY, IMAGE_READY_REPLY } from "./scripts.ts";

type JsonRecord = Record<string, unknown>;
const rec = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" ? (value as JsonRecord) : {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ImageCheckFailure extends Error {}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ImageCheckFailure(message);
}
const show = (value: unknown) => JSON.stringify(value)?.slice(0, 300) ?? String(value);
function same(actual: unknown, expected: unknown, what: string): void {
  expect(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${what}: expected ${show(expected)}, got ${show(actual)}`,
  );
}

export type ImageContext = {
  /** Read and write, with tool events. */
  writer: OperatorSession;
  /** Read only. */
  reader: OperatorSession;
  /** The gateway's own HTTP origin, for the addresses `artifacts.download` names. */
  gatewayOrigin: string;
  /** The stand-in image provider's origin. */
  imagesOrigin: string;
  stamp: string;
};

type ImageCheck = { name: string; covers: string[]; run: (ctx: ImageContext) => Promise<void> };

/** The id of the run the gateway starts in the task once the image task has ended. */
const completionRun = (taskId: string, outcome: "ok" | "error") =>
  `image_generate:${taskId}:${outcome}:agent-loop`;

async function standInRequests(ctx: ImageContext): Promise<ImageRequestRecord[]> {
  const answer = await fetch(`${ctx.imagesOrigin}/scripted/images/requests`);
  return ((await answer.json()) as { requests: ImageRequestRecord[] }).requests;
}

/** Send a directive to a new task of Juniper's and follow it to the completion turn. */
async function imageRun(
  ctx: ImageContext,
  tag: string,
  directive: string,
  outcome: "ok" | "error",
) {
  const op = ctx.writer;
  const key = `agent:main:image-${tag}-${ctx.stamp}`;
  await op.request("sessions.messages.subscribe", { key });
  const from = op.lastSeq;
  const sent = rec(await op.send(key, directive));
  const runId = String(sent.runId);
  const end = await op.terminal(runId, 120_000);
  same(end.state, "final", `the ${directive} run's end`);
  const result = op
    .runEvents(runId)
    .map((event) => rec(rec(event.payload).data))
    .find((data) => data.name === "image_generate" && data.phase === "result");
  expect(result, `the ${directive} run has no image_generate result`);
  const details = rec(rec(result.result).details);
  same([details.async, details.status], [true, "started"], "the tool's answer");
  const taskId = String(details.taskId);
  expect(/^tool:image_generate:[0-9a-f-]{36}$/.test(taskId), `task id ${taskId}`);
  const completion = await op.terminal(completionRun(taskId, outcome), 120_000);
  same(completion.sessionKey, key, "the completion run's task");
  expect(
    op.events.some((event) => event.seq > from && rec(event.payload).runId === completion.runId),
    "the completion run's events",
  );
  return { key, taskId, completion };
}

/** The task's history, read again until `found` finds what it waits for (at most 30 s). */
async function historyUntil<T>(
  ctx: ImageContext,
  key: string,
  found: (messages: JsonRecord[]) => T | undefined,
): Promise<{ value: T | undefined; messages: JsonRecord[] }> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const history = rec(await ctx.writer.request("chat.history", { sessionKey: key, limit: 50 }));
    const messages = (history.messages as JsonRecord[]) ?? [];
    const value = found(messages);
    if (value !== undefined || Date.now() > deadline) return { value, messages };
    await sleep(500);
  }
}

const imageBlocks = (messages: JsonRecord[]) =>
  messages.flatMap((m) =>
    m.role === "assistant" && Array.isArray(m.content)
      ? (m.content as JsonRecord[]).filter((part) => part.type === "image")
      : [],
  );

/** A finished image task the provider failed: the bot's words, and no picture. */
function failureCheck(
  kind: "refuse" | "fail" | "hang",
  name: string,
  outcome: ImageRequestRecord["outcome"],
): ImageCheck {
  return {
    name,
    covers: [`#image-${kind}`],
    async run(ctx) {
      const { key, completion } = await imageRun(ctx, kind, `#image-${kind}`, "error");
      const text = (rec(completion.message).content as JsonRecord[] | undefined)?.[0]?.text;
      same(text, IMAGE_FAILED_REPLY, "the completion turn's reply");
      const { messages } = await historyUntil(ctx, key, (m) =>
        m.some((x) => (x.content as JsonRecord[])?.[0]?.text === IMAGE_FAILED_REPLY)
          ? true
          : undefined,
      );
      same(imageBlocks(messages), [], "pictures in the task");
      const asked = (await standInRequests(ctx)).filter((r) =>
        r.prompt?.includes(`[scripted: ${kind}]`),
      );
      expect(asked.length > 0, `the stand-in received no ${kind} request`);
      same(asked.at(-1)!.outcome, outcome, "the stand-in's outcome");
    },
  };
}

export const IMAGE_CHECKS: ImageCheck[] = [
  {
    name: "a bot's picture arrives in a later turn of the task, as an artifact",
    covers: ["#image"],
    async run(ctx) {
      const { key, completion } = await imageRun(ctx, "picture", "#image", "ok");
      const text = (rec(completion.message).content as JsonRecord[] | undefined)?.[0]?.text;
      same(text, IMAGE_READY_REPLY, "the completion turn's text, its MEDIA line taken out");
      const picture = scriptedPicture();
      const { value: block } = await historyUntil(ctx, key, (m) => imageBlocks(m)[0]);
      expect(block, "no image block in the task's history");
      same(
        [block.mimeType, block.width, block.height, block.sizeBytes],
        ["image/png", 1024, 1024, picture.length],
        "the image block",
      );
      expect(
        /^artifact_managed_image_/.test(String(block.artifactId)),
        `id ${show(block.artifactId)}`,
      );
      const listed = rec(
        await ctx.writer.request("artifacts.list", { sessionKey: key, messageRole: "assistant" }),
      );
      const record = ((listed.artifacts as JsonRecord[]) ?? []).find(
        (a) => a.id === block.artifactId,
      );
      expect(record, `artifacts.list does not list it: ${show(listed)}`);
      same(
        [record.type, record.mimeType, record.sizeBytes, rec(record.download).mode],
        ["image", "image/png", picture.length, "url"],
        "the artifact record",
      );
      const download = rec(
        await ctx.writer.request("artifacts.download", { sessionKey: key, artifactId: record.id }),
      );
      const address = String(download.url ?? "");
      expect(address.startsWith("/api/chat/media/outgoing/"), `download address ${address}`);
      const fetched = Buffer.from(
        await (await fetch(`${ctx.gatewayOrigin}${address}`)).arrayBuffer(),
      );
      expect(fetched.equals(picture), "the downloaded bytes are not the stand-in's picture");
      const [request] = (await standInRequests(ctx)).filter((r) => r.prompt === IMAGE_PROMPT);
      expect(request, "the stand-in received no request for the picture");
      same(
        [request.authorized, request.model, request.n, request.size],
        [true, IMAGE_MODEL_ID, 1, "1024x1024"],
        "what the gateway asked the stand-in",
      );
    },
  },
  failureCheck("refuse", "a picture the provider refuses ends in the bot's words alone", "refuse"),
  failureCheck(
    "fail",
    "a picture the provider fails to make ends in the bot's words alone",
    "fail",
  ),
  failureCheck(
    "hang",
    "a picture the provider never answers ends after the call's timeout",
    "hang",
  ),
  {
    name: "tools.invoke makes a picture at once and names a path on the gateway's machine",
    covers: [],
    async run(ctx) {
      const key = `agent:main:image-invoke-${ctx.stamp}`;
      const params = { name: "image_generate", args: { prompt: IMAGE_PROMPT }, sessionKey: key };
      const answer = rec(await ctx.writer.request("tools.invoke", params, 60_000));
      same([answer.ok, answer.toolName], [true, "image_generate"], "the invoke answer");
      const details = rec(rec(answer.output).details);
      const [attachment] = (details.attachments as JsonRecord[]) ?? [];
      same(
        [details.count, attachment?.type, attachment?.mimeType, attachment?.sizeBytes],
        [1, "image", "image/png", scriptedPicture().length],
        "the invoke's attachment",
      );
      const path = String(attachment?.path ?? "");
      expect(path.includes("/media/tool-image-generation/"), `the attachment's path ${path}`);
      same(details.async, undefined, "a background task on a task with no history");
      const history = rec(await ctx.writer.request("chat.history", { sessionKey: key, limit: 5 }));
      same(history.messages, [], "the invoked task's history");
      const refused = await ctx.reader.request("tools.invoke", params).then(
        () => "answered",
        (error: unknown) => String(error),
      );
      expect(/missing scope: operator\.write/.test(refused), `a read-only invoke: ${refused}`);
    },
  },
];

export async function runImageChecks(
  ctx: ImageContext,
  log: (line: string) => void = console.log,
): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;
  for (const check of IMAGE_CHECKS) {
    try {
      await check.run(ctx);
      passed += 1;
      log(`ok    ${check.name}`);
    } catch (error) {
      failed += 1;
      log(`FAIL  ${check.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { passed, failed };
}
