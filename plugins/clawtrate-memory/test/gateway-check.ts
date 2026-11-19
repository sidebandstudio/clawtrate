import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openInstance, openOperator } from "../../../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../../../tools/dev-gateway/src/operator.ts";
import { sha256 } from "../lib/files.js";

const instance = openInstance("memplugin");
const path = join(instance.stateDir, "shared-memory-check");
const freshInstance =
  "The memory check needs a fresh memplugin instance. Reset your test instance with pnpm dev-gateway reset --instance memplugin and start it again.";
assert.equal(lstatSync(path, { throwIfNoEntry: false }), undefined, freshInstance);
const change = "plugin.clawtrate-memory.changed";
const agentId = "main";
const note = { agentId, path: "memory/plugin-check/note.md" };
const body = "clawtratecheckquartz";
const request = <T = Record<string, unknown>>(
  op: OperatorSession,
  method: string,
  params: object,
) => op.request<T>(`clawtrate-memory.${method}`, params);
const clients: OperatorSession[] = [];

try {
  const admin = await openOperator(
    instance,
    "Memory check admin",
    ["operator.admin", "operator.read", "operator.write"],
    [],
  );
  clients.push(admin);
  const reader = await openOperator(instance, "Memory check reader", ["operator.read"], []);
  clients.push(reader);
  const writer = await openOperator(
    instance,
    "Memory check writer",
    ["operator.read", "operator.write"],
    [],
  );
  clients.push(writer);
  const approvals = await openOperator(
    instance,
    "Memory check approvals",
    ["operator.approvals"],
    [],
  );
  clients.push(approvals);
  for (const [method, params] of [
    ["list", { agentId }],
    ["read", note],
  ] as const) {
    await assert.rejects(request(approvals, method, params), /missing scope: operator.read/);
  }
  assert.deepEqual((await request(reader, "list", { agentId })).files, [], freshInstance);
  const task = await admin.request<{ key: string }>("sessions.create", { agentId });
  const firstTurn = await admin.send(task.key, "#text");
  assert.equal((await admin.terminal(String(firstTurn.runId))).state, "final");
  assert.deepEqual((await request(reader, "list", { agentId })).files, []);

  const marker = reader.lastSeq;
  const { hash } = await request(admin, "write", { ...note, content: body, expectedHash: null });
  assert.equal(hash, sha256(body));
  assert.deepEqual(
    (await reader.waitFor(change, ({ event }) => event === change, 10_000, marker)).payload,
    {},
  );
  const file = await request(reader, "read", note);
  assert.equal(file.content, body);
  assert.equal(file.hash, hash);
  assert.equal(file.loadedIntoNewTasks, false);
  assert.equal(file.searchable, "unconfirmed");
  assert.equal((file.savedBy as { hash: string }).hash, hash);
  assert.deepEqual((await request(reader, "list", { agentId })).files, [
    {
      path: note.path,
      hash,
      size: body.length,
      modifiedAt: file.modifiedAt,
      loadedIntoNewTasks: false,
      searchable: "unconfirmed",
      savedBy: file.savedBy,
    },
  ]);

  await mkdir(path);
  const { hash: baseHash } = await admin.request("config.get", {});
  await admin.request("config.patch", {
    baseHash,
    raw: JSON.stringify({ memory: { search: { enabled: true, extraPaths: [path] } } }),
  });
  let sharedRoot: string | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const { folders } = await request<{
        folders: { sharedRoot: string; searchConfiguredFor: string[] }[];
      }>(reader, "list", {});
      sharedRoot = folders[0]?.sharedRoot;
      if (sharedRoot) {
        assert.ok(folders[0]?.searchConfiguredFor.includes(agentId));
        break;
      }
    } catch (error) {
      if (!(error instanceof Error) || !/configuration changed/.test(error.message)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(sharedRoot, "the running gateway applied the configured shared folder");
  const item = { sharedRoot, path: "example.md" };
  const copy = { item, agents: [agentId], expectedHashes: { [agentId]: null } };
  for (const op of [reader, writer]) {
    for (const [method, params] of [
      ["write", { ...note, content: "ignored", expectedHash: hash }],
      ["delete", { ...note, expectedHash: hash }],
      ["copy", copy],
      ["uncopy", copy],
    ] as const) {
      await assert.rejects(request(op, method, params), /missing scope: operator.admin/);
    }
  }

  await request(admin, "write", { ...item, content: "Shared example", expectedHash: null });
  assert.equal((await request(reader, "read", item)).content, "Shared example");
  assert.equal(
    (await request<{ files: unknown[] }>(reader, "list", { sharedRoot })).files.length,
    1,
  );
  await assert.rejects(
    request(admin, "write", { ...note, content: "stale", expectedHash: null }),
    (error: { details?: unknown }) => {
      assert.deepEqual(error.details, { currentHash: hash });
      return true;
    },
  );

  const before = await admin.request<{ file: { hash?: string; content?: string } }>(
    "agents.files.get",
    { agentId, name: "MEMORY.md" },
  );
  const copied = await request<{ sourceId: string; results: { copied: boolean; hash: string }[] }>(
    admin,
    "copy",
    { ...copy, expectedHashes: { [agentId]: before.file.hash ?? null } },
  );
  assert.equal(copied.results[0]?.copied, true);
  const root = await admin.request<{ file: { hash: string; content: string } }>(
    "agents.files.get",
    { agentId, name: "MEMORY.md" },
  );
  assert.equal(root.file.hash, copied.results[0]?.hash);
  assert.ok(root.file.content.includes(copied.sourceId));
  const removed = await request<{ results: { uncopied: boolean }[] }>(admin, "uncopy", {
    ...copy,
    expectedHashes: { [agentId]: root.file.hash },
  });
  assert.equal(removed.results[0]?.uncopied, true);
  const after = await admin.request<{ file: { content?: string } }>("agents.files.get", {
    agentId,
    name: "MEMORY.md",
  });
  assert.equal(after.file.content ?? "", before.file.content ?? "");

  const search = await reader.request<{
    hits: { reference: { id: string; revision?: string }; excerpt: string }[];
  }>("memory.search", { agentId, query: body, version: 2 });
  const hit = search.hits.find(({ reference }) => reference.id === note.path);
  assert.ok(hit && hit.excerpt.includes(body), "the backend returned an excerpt by search");
  assert.equal(hit.reference.revision, undefined);
  assert.equal((await request(reader, "read", note)).searchable, "unconfirmed");

  const run = await admin.send(task.key, "#remember");
  assert.equal((await admin.terminal(String(run.runId))).state, "final");
  const toolPath = "memory/2026-11-17.md";
  const toolNote = await request(reader, "read", { agentId, path: toolPath });
  assert.equal(typeof toolNote.content, "string");
  assert.equal(toolNote.savedBy, undefined);

  // The hook has no RPC for unversioned receipts. Inspect just its named test store.
  using database = new DatabaseSync(join(instance.stateDir, "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  const lookup = database.prepare(
    "SELECT value_json FROM plugin_state_entries WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
  );
  let receipt: unknown;
  for (let i = 0; i < 20; i += 1) {
    const row = lookup.get("clawtrate-memory", "savers", sha256(`${agentId}\0${toolPath}`));
    if (typeof row?.value_json === "string") {
      receipt = JSON.parse(row.value_json);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.deepEqual(receipt, {
    agentId,
    kind: "bot",
    sessionKey: task.key,
    path: toolPath,
    at: (receipt as { at?: number })?.at,
  });
  assert.equal(typeof (receipt as { at: number }).at, "number");
  await request(admin, "delete", { ...note, expectedHash: hash });
  await assert.rejects(request(reader, "read", note), /does not exist/);
  console.log(
    "Memory methods, search receipts, tool observation, invalidation and scope refusals passed.",
  );
} finally {
  await Promise.all(clients.map((client) => client.close()));
}
