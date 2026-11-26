// The guide checks: Clawtrate's guides as a marked section at the top of a bot's AGENTS.md
// (packages/core/src/guides.ts, #532, #544, #628), on the scenario check's instance, with the account
// checks' admin client. Each check asserts from the gateway's own answers and from the scripted
// model's record of the system prompt each session's latest request carried. Pip's file is put
// back as it was at the end, whatever happens.

import { randomUUID } from "node:crypto";
import { VOICE_GUIDE, WHERE_GUIDE } from "../../../packages/core/src/guide-text.ts";
import {
  applyGuidesChange,
  findSection,
  GUIDES_FILE,
  GUIDES_SECTION,
} from "../../../packages/core/src/guides.ts";
import { mapSessionRow } from "../../../packages/core/src/mapping.ts";
import { SYSTEM_PROMPT_PATH } from "./fake-provider.ts";
import { HAND_OFF } from "./scenarios.ts";
import type { OperatorSession } from "./operator.ts";

type JsonRecord = Record<string, unknown>;
const rec = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" ? (value as JsonRecord) : {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class GuideCheckFailure extends Error {}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new GuideCheckFailure(message);
}

export type GuideHarness = {
  admin: OperatorSession;
  /** The instance's scripted model, `http://127.0.0.1:<port>`. */
  providerUrl: string;
};

/** The bot whose file the checks change. */
const BOT = "pip";
/** The bot that starts a task of its own in the check that needs one. */
const PARTNER = "otto";

const count = (text: string, part: string) => text.split(part).length - 1;

async function readFile(
  h: GuideHarness,
  agentId = BOT,
): Promise<{ content: string; hash: string }> {
  const file = rec(
    rec(await h.admin.request("agents.files.get", { agentId, name: GUIDES_FILE })).file,
  );
  expect(typeof file.content === "string" && typeof file.hash === "string", "no AGENTS.md");
  return { content: file.content as string, hash: file.hash as string };
}

/** The system prompt of a session's latest model request, waiting for one that has `want`. */
async function promptOf(h: GuideHarness, key: string, want = "Where you live"): Promise<string> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const answer = (await (
      await fetch(`${h.providerUrl}${SYSTEM_PROMPT_PATH}?session=${encodeURIComponent(key)}`)
    ).json()) as { system: string | null };
    if (answer.system?.includes(want) || Date.now() > deadline) {
      expect(answer.system, `the scripted model saw no request for ${key}`);
      return answer.system;
    }
    await sleep(500);
  }
}

/** Each guide is in the prompt exactly once, and so is the section's first marker. */
function once(prompt: string, where: string): void {
  for (const [name, text] of [
    ["the voice guide", VOICE_GUIDE],
    ["the task guide", WHERE_GUIDE],
    ["the section's first line", GUIDES_SECTION.split("\n")[0]!],
  ] as const)
    expect(count(prompt, text) === 1, `${name} is in ${where} ${count(prompt, text)} times`);
}

export type GuideCheck = { name: string; run(h: GuideHarness, world: World): Promise<void> };
type World = { original: { content: string; hash: string } | null };

export const GUIDE_CHECKS: GuideCheck[] = [
  {
    name: "the section goes at the top of AGENTS.md, and nothing else in it changes",
    async run(h, world) {
      world.original = await readFile(h);
      const request = (method: string, params: unknown) => h.admin.request(method, params);
      // Clawtrate's own change, as after a connect with admin access, kept to Pip: nothing asked.
      const { errors } = await applyGuidesChange(request, null, { action: "auto", bot: BOT });
      expect(errors.length === 0, `the write failed: ${errors.join("; ")}`);
      const after = await readFile(h);
      expect(
        after.content === `${GUIDES_SECTION}\n${world.original.content}`,
        "the file isn't the section followed by what was there",
      );
      expect(findSection(after.content).kind === "ours", "the section doesn't read as Clawtrate's");
    },
  },
  {
    name: "a bot's conversation gets each guide exactly once on its next turn, with no restart",
    async run(h) {
      const key = `agent:${BOT}:guides-${randomUUID().slice(0, 8)}`;
      await h.admin.request("sessions.messages.subscribe", { key });
      const sent = await h.admin.send(key, "#text");
      await h.admin.terminal(String(sent.runId));
      once(await promptOf(h, key), "the conversation's prompt");
    },
  },
  {
    name: "a routine's run gets each guide exactly once",
    async run(h) {
      const added = rec(
        await h.admin.request("cron.add", {
          name: `guide check ${Date.now().toString(36)}`,
          agentId: BOT,
          schedule: { kind: "every", everyMs: 3_600_000 },
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "#text" },
          delivery: { mode: "none" },
        }),
      );
      const id = String(added.id);
      try {
        await h.admin.request("cron.run", { id, mode: "force" });
        let entry: JsonRecord | undefined;
        const deadline = Date.now() + 90_000;
        while (!entry) {
          expect(Date.now() < deadline, "the routine's run did not finish within 90 seconds");
          await sleep(1000);
          const runs = rec(await h.admin.request("cron.runs", { id, limit: 1 }));
          entry = ((runs.entries ?? []) as JsonRecord[]).find((e) => e.action === "finished");
        }
        const key = String(entry.sessionKey);
        expect(key.startsWith(`agent:${BOT}:cron:${id}`), `the run's session is ${key}`);
        // The model request names the routine's session, `agent:<bot>:cron:<id>`, without the
        // run's own suffix that `cron.runs` adds.
        once(await promptOf(h, key.replace(/:run:[^:]+$/, "")), "the routine's prompt");
      } finally {
        await h.admin.request("cron.remove", { id });
      }
    },
  },
  {
    // Otto: the scenario checks already gave Pip and Marlow a task with `#hand-off`'s label, and a
    // bot's labels are its own and unique. Otto's file is put back as it was at the end.
    name: "a task a bot starts carries the guide in its own first turn, and is the task the person opens",
    async run(h) {
      const request = (method: string, params: unknown) => h.admin.request(method, params);
      const original = await readFile(h, PARTNER);
      try {
        const { errors } = await applyGuidesChange(request, null, {
          action: "auto",
          bot: PARTNER,
        });
        expect(errors.length === 0, `the write failed: ${errors.join("; ")}`);
        const key = `agent:${PARTNER}:guides-hand-off-${randomUUID().slice(0, 8)}`;
        await h.admin.request("sessions.messages.subscribe", { key });
        const sent = await h.admin.send(key, "#hand-off");
        await h.admin.terminal(String(sent.runId));
        // The task it started, as Clawtrate lists a bot's tasks.
        const listed = rec(
          await h.admin.request("sessions.list", {
            excludeCron: true,
            excludeSubagents: true,
            includeDerivedTitles: true,
            includeLastMessage: true,
          }),
        );
        const rows = (Array.isArray(listed.sessions) ? listed.sessions : []).map(rec);
        const row = rows.find((each) => each.spawnedBy === key && each.label === HAND_OFF.label);
        expect(row, "the started task is not in the task list");
        const child = String(row.key);
        // The task the sidebar shows for it is this one: under Otto, titled by its label.
        const task = mapSessionRow(row);
        expect(
          task?.key === child && task.botId === PARTNER && task.title === HAND_OFF.label,
          `the sidebar's task for it is ${JSON.stringify(task && [task.key, task.botId, task.title])}`,
        );
        // Its own first turn, the brief, carried each guide exactly once.
        once(await promptOf(h, child), "the started task's prompt");
        // Its end reports back in the conversation it came from: wait for that before going on.
        const deadline = Date.now() + 60_000;
        for (;;) {
          const history = rec(
            await h.admin.request("chat.history", { sessionKey: key, limit: 50 }),
          );
          const said = JSON.stringify(history.messages ?? []);
          if (said.includes(`${HAND_OFF.label} finished.`)) break;
          expect(Date.now() < deadline, "the started task's end didn't report back in 60 seconds");
          await sleep(1000);
        }
      } finally {
        const now = await readFile(h, PARTNER).catch(() => null);
        if (now && now.content !== original.content)
          await h.admin.request("agents.files.set", {
            agentId: PARTNER,
            name: GUIDES_FILE,
            content: original.content,
            expectedHash: now.hash,
          });
      }
    },
  },
  {
    name: "a write held to a hash the file no longer has is refused, and the file stays",
    async run(h, world) {
      const now = await readFile(h);
      const refused = await h.admin
        .request("agents.files.set", {
          agentId: BOT,
          name: GUIDES_FILE,
          content: "overwritten",
          expectedHash: world.original!.hash,
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(refused, "the stale write was accepted");
      expect(
        rec(rec(refused).details).type === "agent_file_conflict",
        `the refusal wasn't a conflict: ${String(refused)}`,
      );
      expect((await readFile(h)).hash === now.hash, "the file changed after the refusal");
    },
  },
  {
    name: "turning it off gives the file back byte for byte, with its earlier hash",
    async run(h, world) {
      const request = (method: string, params: unknown) => h.admin.request(method, params);
      // Off takes the section out of every bot: each other bot's file is put back as it was.
      const listed = rec(await h.admin.request("agents.list", {})).agents;
      const others = (Array.isArray(listed) ? listed : [])
        .map((agent) => String(rec(agent).id))
        .filter((id) => id !== BOT);
      // Each one is read first: one that can't be read can't be put back, so nothing is turned
      // off. A missing file stays missing: turning it off only takes the section out of a file.
      const before = new Map<string, string>();
      for (const id of others) {
        const file = rec(
          rec(await h.admin.request("agents.files.get", { agentId: id, name: GUIDES_FILE })).file,
        );
        if (file.missing === true) continue;
        expect(typeof file.content === "string", `${id}'s AGENTS.md couldn't be read before`);
        before.set(id, file.content as string);
      }
      try {
        const { errors } = await applyGuidesChange(request, null, { action: "switch", on: false });
        expect(errors.length === 0, `the removal failed: ${errors.join("; ")}`);
        const after = await readFile(h);
        expect(after.content === world.original!.content, "the file isn't what it was");
        expect(after.hash === world.original!.hash, "the file's hash isn't what it was");
        world.original = null;
      } finally {
        // Every file is tried, whatever one of them does; then any that wasn't put back fails.
        const left: string[] = [];
        for (const [id, content] of before) {
          try {
            const now = await readFile(h, id);
            if (now.content !== content)
              await h.admin.request("agents.files.set", {
                agentId: id,
                name: GUIDES_FILE,
                content,
                expectedHash: now.hash,
              });
          } catch (error) {
            left.push(`${id} (${String(error)})`);
          }
        }
        expect(left.length === 0, `not put back as they were: ${left.join(", ")}`);
      }
    },
  },
];

/** Run every guide check in order; whatever fails, Pip's file is put back as it was. */
export async function runGuideChecks(
  h: GuideHarness,
  options: { log?: (line: string) => void } = {},
): Promise<{ passed: number; failed: number }> {
  const log = options.log ?? console.log;
  const world: World = { original: null };
  let passed = 0;
  let failed = 0;
  try {
    for (const check of GUIDE_CHECKS) {
      try {
        await check.run(h, world);
        passed += 1;
        log(`ok    ${check.name}`);
      } catch (error) {
        failed += 1;
        log(`FAIL  ${check.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    if (world.original) {
      const now = await readFile(h).catch(() => null);
      if (now && now.content !== world.original.content)
        await h.admin
          .request("agents.files.set", {
            agentId: BOT,
            name: GUIDES_FILE,
            content: world.original.content,
            expectedHash: now.hash,
          })
          .catch((error: unknown) =>
            log(`note  Pip's AGENTS.md was not put back: ${String(error)}`),
          );
    }
  }
  return { passed, failed };
}
