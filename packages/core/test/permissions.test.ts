// Settings → Permissions in the engine (permissions.ts): the rules plugin's
// state, the routines' grants and the allowlist read back after Revoke and
// Remove, and Activity's join to the rules plugin's decision record. Gateway
// answers are shaped as OpenClaw 2026.10.6 gave them on a development instance.

import { describe, expect, it } from "vitest";
import { parseBridgeCommand } from "../src/bridge.ts";
import {
  ACTIVITY_PAGE_RECORDS,
  activityRows,
  auditCallId,
  DECISIONS_PER_RUN,
  MAX_ACTIVITY_ID,
  MAX_ALLOWLIST_LISTED,
  MAX_GRANTS_LISTED,
  MAX_PERMISSION_NAME,
  MAX_PERMISSION_TEXT,
  allowlistOf,
  approvalsSnapshot,
  fitJson,
  jsonChars,
  readActivity,
  readRulesPlugin,
  readSavedApprovals,
  removeAllowlistEntry,
  revokeGrant,
  type LoadedCall,
  type PermissionsContext,
} from "../src/permissions.ts";
import { APPROVALS_TIER_SCOPES, INTERACTIVE_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { grantingGateway, openTask } from "./client-harness.ts";
import { helloOk, until } from "./fake-gateway.ts";

/** The web host's result frame (`MAX_RESULT_CHARS` in apps/desktop/src/web-host/server.ts). */
const MAX_RESULT_CHARS = 262_144;

type Handler = (params: Record<string, unknown>) => unknown;

/** A gateway that answers from handlers and records every call. */
function fake(handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const ctx: PermissionsContext = {
    now: () => 1_795_098_000_000,
    request: async (method, params) => {
      calls.push({ method, params: params as Record<string, unknown> });
      const handler = handlers[method];
      if (!handler) throw Object.assign(new Error(`unknown method: ${method}`), {});
      return handler(params as Record<string, unknown>);
    },
  };
  return { ctx, calls, methods: () => calls.map((each) => each.method) };
}

const missing = (scope: string) =>
  Object.assign(new Error(`missing scope: ${scope}`), {
    details: { code: "MISSING_SCOPE", missingScope: scope },
  });

const grant = (patch: Record<string, unknown> = {}) => ({
  grantId: "169b7524-976f-4383-a41e-4fa2be4be60c",
  mintedByApprovalId: "26ba25b7-af5b-4ed5-9edb-544834533d9c",
  agentId: "otto",
  cronJobId: "f50d084f-3330-48d1-9813-ced8ccdf3c0e",
  cronJobName: "Weekly cleanup",
  command: "ls",
  cwd: "/srv/otto",
  createdAtMs: 1_795_098_145_829,
  expiresAtMs: 1_795_184_545_828,
  revokedAtMs: null,
  revokedBy: null,
  lastUsedAtMs: null,
  useCount: 0,
  ...patch,
});

const approvalsFile = (allowlist: unknown[]) => ({
  path: "state#exec_approvals_config",
  exists: true,
  file: { version: 1, defaults: {}, agents: { otto: { allowlist } } },
  hash: `hash-${allowlist.length}`,
});

/** What the page sends for a file it showed: its revision and the digest of the whole file. */
const shownOf = (answer: unknown) => {
  const snapshot = approvalsSnapshot(answer);
  if ("invalid" in snapshot) throw new Error(snapshot.invalid);
  return { shownHash: snapshot.hash, shownDigest: snapshot.digest };
};

const LS_ENTRY = {
  pattern: "/bin/ls",
  id: "4b7eec06-af1c-4726-9737-865a4b63db4b",
  source: "allow-always",
  argPattern: "sha256:cwd-argv:v1:aa32119de349b6d0d5116c70cd1363d1",
  lastUsedAt: 1_795_098_491_606,
};
const NODE_ENTRY = {
  pattern: "=node-command:c7b68ac37f364473",
  id: "7d5521b0-d028-4a51-b70d-41894f9ad848",
  source: "allow-always",
  lastUsedAt: 1_795_098_485_950,
};

describe("F-178: the rules plugin's state, from its status method", () => {
  const status = (patch: Record<string, unknown> = {}) => ({
    plugin: "clawtrate-tool-rules",
    version: "1.0.0",
    rulesSchema: 1,
    rules: { state: "read", readAt: 1 },
    enforcing: "rules",
    hook: { registered: true, lastCallAt: 1_795_097_954_930 },
    ...patch,
  });

  it("is unavailable when the hello did not list its methods, and nothing is asked", async () => {
    const gateway = fake({});
    expect(await readRulesPlugin(gateway.ctx, false)).toEqual({ state: "unavailable" });
    expect(gateway.calls).toEqual([]);
  });

  it("is running only with a registered hook, and says what it enforces apart from it", async () => {
    const running = await readRulesPlugin(
      fake({ "clawtrate-tool-rules.status": () => status() }).ctx,
      true,
    );
    expect(running).toMatchObject({
      state: "running",
      lastCallAt: 1_795_097_954_930,
      enforcing: "rules",
    });
    const none = await readRulesPlugin(
      fake({
        "clawtrate-tool-rules.status": () =>
          status({ rules: { state: "none" }, enforcing: "nothing" }),
      }).ctx,
      true,
    );
    expect(none).toMatchObject({ state: "running", enforcing: "nothing" });
    const lost = await readRulesPlugin(
      fake({
        "clawtrate-tool-rules.status": () =>
          status({
            rules: { state: "lost", reason: "x", keptCopyReadAt: 7 },
            enforcing: "kept-copy",
          }),
      }).ctx,
      true,
    );
    expect(lost).toMatchObject({ state: "running", enforcing: "kept-copy", keptCopyReadAt: 7 });
  });

  it("an answer that it enforces nothing is that answer, not silence; only a failed status is stopped", async () => {
    for (const answer of [
      () => status({ hook: { registered: false, lastCallAt: null }, enforcing: "not-enforced" }),
      () => status({ enforcing: "not-enforced" }),
    ]) {
      const read = await readRulesPlugin(fake({ "clawtrate-tool-rules.status": answer }).ctx, true);
      expect(read).toMatchObject({ state: "not-enforcing", answeredAt: 1_795_098_000_000 });
    }
    const failed = await readRulesPlugin(
      fake({
        "clawtrate-tool-rules.status": () => {
          throw new Error("unknown method: clawtrate-tool-rules.status");
        },
      }).ctx,
      true,
    );
    expect(failed).toEqual({
      state: "stopped",
      reason: "unknown method: clawtrate-tool-rules.status",
    });
  });

  it("is old below 1.0.0", async () => {
    const read = await readRulesPlugin(
      fake({ "clawtrate-tool-rules.status": () => status({ version: "0.9.0" }) }).ctx,
      true,
    );
    expect(read).toEqual({ state: "old", version: "0.9.0" });
  });
});

describe("F-178: saved approvals, as the gateway lists them", () => {
  it("reads grants only with approvals and the allowlist only with admin, and says which is missing", async () => {
    const gateway = fake({});
    const read = await readSavedApprovals(gateway.ctx, { canApprove: false, canAdmin: false });
    expect(read.grants).toEqual({ status: "needs-approvals" });
    expect(read.allowlist).toEqual({ status: "needs-admin" });
    expect(gateway.calls).toEqual([]);
  });

  it("takes a refusal for a missing scope as below that scope, not as no approvals", async () => {
    const gateway = fake({
      "exec.approval.grants.list": () => {
        throw missing("operator.approvals");
      },
      "exec.approvals.get": () => {
        throw missing("operator.admin");
      },
    });
    const read = await readSavedApprovals(gateway.ctx, { canApprove: true, canAdmin: true });
    expect(read.grants).toEqual({ status: "needs-approvals" });
    expect(read.allowlist).toEqual({ status: "needs-admin" });
  });

  it("lists a routine's grant with what it is bound to, its times and its use, and a revoked one stays listed", async () => {
    const gateway = fake({
      "exec.approval.grants.list": () => ({
        grants: [
          grant({ useCount: 1, lastUsedAtMs: 1_795_098_202_388 }),
          grant({ grantId: "g2", cronJobName: null, revokedAtMs: 5, revokedBy: "A device" }),
        ],
      }),
      "exec.approvals.get": () => approvalsFile([LS_ENTRY, NODE_ENTRY]),
    });
    const read = await readSavedApprovals(gateway.ctx, { canApprove: true, canAdmin: true });
    expect(read.grants).toMatchObject({
      status: "ready",
      more: false,
      items: [
        {
          routineName: "Weekly cleanup",
          command: "ls",
          cwd: "/srv/otto",
          createdAtMs: 1_795_098_145_829,
          expiresAtMs: 1_795_184_545_828,
          useCount: 1,
          revokedAtMs: null,
        },
        { grantId: "g2", routineName: null, revokedAtMs: 5 },
      ],
    });
    // Who revoked it is the gateway's record of a device, not shown.
    expect(JSON.stringify(read.grants)).not.toContain("A device");
    expect(
      gateway.calls.find((each) => each.method === "exec.approval.grants.list")?.params,
    ).toEqual({
      limit: MAX_GRANTS_LISTED + 1,
    });
    // An "Always allow" on `ls` left two entries in the file; both are listed, in its own terms.
    expect(read.allowlist).toMatchObject({
      status: "ready",
      omitted: 0,
      hash: "hash-2",
      items: [
        {
          agentId: "otto",
          pattern: "/bin/ls",
          argPattern: LS_ENTRY.argPattern,
          fromAlwaysAllow: true,
          addedAt: null,
        },
        { agentId: "otto", pattern: NODE_ENTRY.pattern, argPattern: null },
      ],
    });
  });

  it("a tool entry's last use is read from the file, and is null only when the file records none", async () => {
    const read = await readSavedApprovals(
      fake({
        "exec.approval.grants.list": () => ({ grants: [] }),
        "exec.approvals.get": () => ({
          ...approvalsFile([]),
          file: {
            version: 1,
            agents: {
              otto: {
                mcpTools: [
                  {
                    server: "coder",
                    tool: "send",
                    source: "allow-always",
                    addedAt: 5,
                    lastUsedAt: 9,
                  },
                  { server: "coder", tool: "read", source: "allow-always", addedAt: 5 },
                ],
              },
            },
          },
        }),
      }).ctx,
      { canApprove: true, canAdmin: true },
    );
    if (read.allowlist.status !== "ready") throw new Error("not ready");
    expect(
      read.allowlist.items.map((each) => [each.pattern, each.lastUsedAt, each.entryId]),
    ).toEqual([
      ["coder__send", 9, null],
      ["coder__read", null, null],
    ]);
  });

  it("says only what was read: an answer with no list fails, and rows that can't be shown are counted", async () => {
    const read = (grants: unknown, file: unknown) =>
      readSavedApprovals(
        fake({
          "exec.approval.grants.list": () => grants,
          "exec.approvals.get": () => file,
        }).ctx,
        { canApprove: true, canAdmin: true },
      );
    // A misleading empty reply, and a file answer with no revision: neither is an empty list.
    const empty = await read({}, { ...approvalsFile([LS_ENTRY]), hash: undefined });
    expect(empty.grants).toMatchObject({ status: "failed" });
    expect(empty.allowlist).toMatchObject({ status: "failed" });
    // Rows that can't be shown are counted, also when none is shown.
    const omittedOnly = await read(
      { grants: [{ grantId: "no-routine" }] },
      approvalsFile([{ pattern: "" }, { pattern: "" }]),
    );
    expect(omittedOnly.grants).toMatchObject({ status: "ready", items: [], omitted: 1 });
    expect(omittedOnly.allowlist).toMatchObject({ status: "ready", items: [], omitted: 2 });
  });

  it("judges each entry's Remove on the bot's whole list: shared, overlong or control ids, every bot, no id", async () => {
    const filler = Array.from({ length: MAX_ALLOWLIST_LISTED - 1 }, (_, i) => ({
      pattern: `/opt/tool-${i}`,
      id: `filler-${i}`,
    }));
    const file = {
      ...approvalsFile([]),
      file: {
        version: 1,
        agents: {
          otto: {
            allowlist: [
              ...filler,
              // Shown as the 60th row; its twin is past the display cap.
              { pattern: "/usr/bin/true", id: "shared" },
              { pattern: "/usr/bin/false", id: "shared" },
            ],
          },
          pip: {
            allowlist: [
              { pattern: "/usr/bin/a", id: "x".repeat(513) },
              { pattern: "/usr/bin/b", id: "tab\there" },
              { pattern: "/usr/bin/c" },
              { pattern: "/usr/bin/d", id: "fine" },
            ],
            mcpTools: [{ server: "coder", tool: "send", source: "allow-always", addedAt: 1 }],
          },
          "*": { allowlist: [{ pattern: "/usr/bin/uptime", id: "every-1" }] },
        },
      },
    };
    const { allowlist } = await readSavedApprovals(
      fake({
        "exec.approval.grants.list": () => ({ grants: [] }),
        "exec.approvals.get": () => file,
      }).ctx,
      { canApprove: true, canAdmin: true },
    );
    if (allowlist.status !== "ready") throw new Error("not ready");
    expect(allowlist.items.at(-1)).toMatchObject({ entryId: "shared", removal: "unidentified" });
    expect(allowlist.items.slice(0, -1).every((each) => each.removal === "ok")).toBe(true);
    // Past the cap: Pip's five and every bot's one are counted, the twin too.
    expect(allowlist.omitted).toBe(1 + 5 + 1);
    const pip = allowlistOf({
      agents: { pip: file.file.agents.pip, "*": file.file.agents["*"] },
    }).items.map((each) => [each.pattern, each.removal]);
    expect(pip).toEqual([
      ["/usr/bin/a", "unidentified"],
      ["/usr/bin/b", "unidentified"],
      ["/usr/bin/c", "no-id"],
      ["/usr/bin/d", "ok"],
      ["coder__send", "no-id"],
      ["/usr/bin/uptime", "every-bot"],
    ]);
  });

  it("a grant says only what the gateway gave: an unreadable binding, no use count, no routine name read", async () => {
    const { grants } = await readSavedApprovals(
      fake({
        "exec.approval.grants.list": () => ({
          grants: [
            grant({ command: undefined, useCount: undefined }),
            grant({ grantId: "g2", cronJobName: undefined }),
            grant({ grantId: "g3", cronJobName: null, useCount: 0 }),
          ],
        }),
      }).ctx,
      { canApprove: true, canAdmin: false },
    );
    if (grants.status !== "ready") throw new Error("not ready");
    expect(
      grants.items.map((each) => [each.command, each.useCount, each.routineName, each.routineGone]),
    ).toEqual([
      ["(unreadable)", null, "Weekly cleanup", false],
      ["ls", 0, null, false],
      ["ls", 0, null, true],
    ]);
  });

  it("a revoke answered not-found whose read afterwards fails gives both", async () => {
    const result = await revokeGrant(
      fake({
        "exec.approval.grants.revoke": () => ({ outcome: "not-found" }),
        "exec.approval.grants.list": () => {
          throw new Error("socket closed");
        },
      }).ctx,
      grant().grantId,
    );
    expect(result).toMatchObject({ answer: "not-found", grant: null, readError: "socket closed" });
  });

  it("is bounded where it enters: grants, entries and their text", async () => {
    const long = "x".repeat(5000);
    const gateway = fake({
      "exec.approval.grants.list": () => ({
        grants: Array.from({ length: 500 }, (_, i) =>
          grant({ grantId: `g${i}`, command: long, cwd: long, cronJobName: long }),
        ),
      }),
      "exec.approvals.get": () =>
        approvalsFile(
          Array.from({ length: 300 }, (_, i) => ({
            ...LS_ENTRY,
            id: `e${i}`,
            pattern: long,
            argPattern: long,
            commandText: long,
          })),
        ),
    });
    const read = await readSavedApprovals(gateway.ctx, { canApprove: true, canAdmin: true });
    if (read.grants.status !== "ready" || read.allowlist.status !== "ready")
      throw new Error("not ready");
    expect(read.grants.items).toHaveLength(MAX_GRANTS_LISTED);
    expect(read.grants.more).toBe(true);
    expect(read.grants.items[0]!.command).toHaveLength(MAX_PERMISSION_TEXT);
    expect(read.grants.items[0]!.routineName).toHaveLength(MAX_PERMISSION_NAME);
    expect(read.allowlist.items).toHaveLength(MAX_ALLOWLIST_LISTED);
    expect(read.allowlist.omitted).toBe(300 - MAX_ALLOWLIST_LISTED);
    // The whole answer fits one result frame of the web host.
    expect(JSON.stringify(read).length).toBeLessThan(MAX_RESULT_CHARS);
  });
});

describe("F-178: Revoke and Remove say only what the read back shows", () => {
  it("revoke answers the gateway's own outcome and the grant as listed afterwards", async () => {
    let revoked: number | null = null;
    const gateway = fake({
      "exec.approval.grants.revoke": () => {
        if (revoked !== null) return { outcome: "already-revoked" };
        revoked = 1_795_098_206_804;
        return { outcome: "revoked" };
      },
      "exec.approval.grants.list": () => ({ grants: [grant({ revokedAtMs: revoked })] }),
    });
    const first = await revokeGrant(gateway.ctx, grant().grantId);
    expect(first).toMatchObject({
      answer: "revoked",
      error: null,
      grant: { revokedAtMs: 1_795_098_206_804 },
    });
    expect(gateway.methods()).toEqual(["exec.approval.grants.revoke", "exec.approval.grants.list"]);
    const again = await revokeGrant(gateway.ctx, grant().grantId);
    expect(again.answer).toBe("already-revoked");
    const unknown = await revokeGrant(
      fake({
        "exec.approval.grants.revoke": () => ({ outcome: "not-found" }),
        "exec.approval.grants.list": () => ({ grants: [] }),
      }).ctx,
      "00000000-0000-0000-0000-000000000000",
    );
    expect(unknown).toMatchObject({ answer: "not-found", grant: null });
  });

  it("a refused revoke reports the grant as the gateway still lists it, active", async () => {
    const read = await revokeGrant(
      fake({
        "exec.approval.grants.revoke": () => {
          throw new Error("approval store unavailable");
        },
        "exec.approval.grants.list": () => ({ grants: [grant()] }),
      }).ctx,
      grant().grantId,
    );
    expect(read).toMatchObject({
      answer: null,
      error: "approval store unavailable",
      grant: { revokedAtMs: null },
    });
  });

  /** A gateway whose approvals file changes only by `set` with its current hash, as the gateway's does. */
  const approvalsGateway = (start: ReturnType<typeof approvalsFile>) => {
    let file = start;
    let revision = 0;
    const gateway = fake({
      "exec.approvals.get": () => file,
      "exec.approvals.set": (params) => {
        if (params.baseHash !== file.hash)
          throw new Error(
            "exec approvals changed since last load; re-run exec.approvals.get and retry",
          );
        revision += 1;
        file = { ...file, file: params.file as typeof file.file, hash: `written-${revision}` };
        return file;
      },
    });
    return {
      ...gateway,
      file: () => file,
      /** Another administrator's write, between the page's read and the person's Remove. */
      edit: (allowlist: unknown[]) => {
        revision += 1;
        file = { ...approvalsFile(allowlist), hash: `edited-${revision}` };
      },
    };
  };

  it("remove writes the shown revision without exactly that entry, and names it from the file", async () => {
    const gateway = approvalsGateway(approvalsFile([LS_ENTRY, NODE_ENTRY]));
    const result = await removeAllowlistEntry(gateway.ctx, {
      agentId: "otto",
      entryId: LS_ENTRY.id,
      ...shownOf(approvalsFile([LS_ENTRY, NODE_ENTRY])),
    });
    expect(result).toMatchObject({
      outcome: "removed",
      removed: { agentId: "otto", pattern: "/bin/ls" },
    });
    expect(gateway.methods()).toEqual([
      "exec.approvals.get",
      "exec.approvals.set",
      "exec.approvals.get",
    ]);
    expect(gateway.calls[1]!.params.baseHash).toBe("hash-2");
    expect(gateway.file().file.agents.otto.allowlist).toEqual([NODE_ENTRY]);
  });

  it("an entry edited in place under the same id after the confirmation opened is not removed", async () => {
    const shownFile = approvalsFile([LS_ENTRY, NODE_ENTRY]);
    const shown = { agentId: "otto", entryId: LS_ENTRY.id, ...shownOf(shownFile) };
    const withOther = (allowlist: unknown[], other: unknown[]) => ({
      ...approvalsFile(allowlist),
      file: {
        version: 1,
        defaults: {},
        agents: { otto: { allowlist }, pip: { allowlist: other } },
      },
    });
    const PIP_ENTRY = { pattern: "/usr/bin/uptime", id: "pip-1" };
    // What another administrator may have written by the time the person confirms. The gateway's
    // hash is held as shown in the first three: only the whole file's digest tells them apart.
    const cases: Array<[string, unknown, unknown]> = [
      [
        "pattern, same hash",
        {
          ...approvalsFile([{ ...LS_ENTRY, pattern: "/usr/bin/true" }, NODE_ENTRY]),
          hash: "hash-2",
        },
        "/usr/bin/true",
      ],
      [
        "argument pattern, same hash",
        {
          ...approvalsFile([{ ...LS_ENTRY, argPattern: "sha256:other" }, NODE_ENTRY]),
          hash: "hash-2",
        },
        "/bin/ls",
      ],
      [
        "another bot's entry removed, same hash",
        { ...withOther([LS_ENTRY, NODE_ENTRY], []), hash: "hash-2" },
        "/bin/ls",
      ],
      [
        "reordered",
        { ...approvalsFile([NODE_ENTRY, LS_ENTRY]), hash: "reordered" },
        NODE_ENTRY.pattern,
      ],
      ["deleted", { ...approvalsFile([NODE_ENTRY]), hash: "deleted" }, NODE_ENTRY.pattern],
      [
        "replaced",
        { ...approvalsFile([]), file: { version: 1, agents: { pip: { allowlist: [PIP_ENTRY] } } } },
        PIP_ENTRY.pattern,
      ],
    ];
    // The shown file itself had Pip's entry in the third case.
    for (const [what, now, first] of cases) {
      const base = what.startsWith("another")
        ? withOther([LS_ENTRY, NODE_ENTRY], [PIP_ENTRY])
        : shownFile;
      const target = { ...shown, ...shownOf(base) };
      const gateway = fake({
        "exec.approvals.get": () => now,
        "exec.approvals.set": () => {
          throw new Error("no write may be sent");
        },
      });
      const result = await removeAllowlistEntry(gateway.ctx, target);
      expect(result.outcome, what).toBe("changed");
      expect(result.removed, what).toBeNull();
      expect(gateway.methods(), what).toEqual(["exec.approvals.get"]);
      // The file as it is now, to ask the person again from.
      if (result.allowlist.status !== "ready") throw new Error(`${what}: not ready`);
      expect(result.allowlist.items[0]?.pattern, what).toBe(first);
    }
  });

  it("an id that two entries share is refused, and nothing is written", async () => {
    const gateway = approvalsGateway(
      approvalsFile([
        { ...LS_ENTRY, pattern: "/usr/bin/true" },
        { ...LS_ENTRY, pattern: "/usr/bin/false" },
      ]),
    );
    const result = await removeAllowlistEntry(gateway.ctx, {
      agentId: "otto",
      entryId: LS_ENTRY.id,
      ...shownOf(
        approvalsFile([
          { ...LS_ENTRY, pattern: "/usr/bin/true" },
          { ...LS_ENTRY, pattern: "/usr/bin/false" },
        ]),
      ),
    });
    expect(result.outcome).toBe("ambiguous");
    expect(gateway.methods()).toEqual(["exec.approvals.get"]);
    expect(gateway.file().file.agents.otto.allowlist).toHaveLength(2);
  });

  it("a removal is confirmed against the whole file: an entry past the display limit is still listed", async () => {
    const filler = Array.from({ length: MAX_ALLOWLIST_LISTED }, (_, index) => ({
      pattern: `/opt/tool-${index}`,
      id: `filler-${index}`,
    }));
    const gateway = fake({
      // The first read is the shown revision; the write is refused, and the read
      // afterwards has the entry moved past the 60 entries kept for display.
      "exec.approvals.get": () =>
        gateway.methods().includes("exec.approvals.set")
          ? { ...approvalsFile([...filler, LS_ENTRY]), hash: "moved" }
          : approvalsFile([LS_ENTRY]),
      "exec.approvals.set": () => {
        throw new Error(
          "exec approvals changed since last load; re-run exec.approvals.get and retry",
        );
      },
    });
    const result = await removeAllowlistEntry(gateway.ctx, {
      agentId: "otto",
      entryId: LS_ENTRY.id,
      ...shownOf(approvalsFile([LS_ENTRY])),
    });
    if (result.allowlist.status !== "ready") throw new Error("not ready");
    expect(result.allowlist.items.some((each) => each.entryId === LS_ENTRY.id)).toBe(false);
    expect(result).toMatchObject({
      outcome: "still-listed",
      removed: null,
      error: expect.stringContaining("changed since last load"),
    });
  });

  it("a removal is confirmed against the whole file: Removed only for an accepted write and a complete read-back of that file", async () => {
    const shownFile = approvalsFile([LS_ENTRY, NODE_ENTRY]);
    const target = { agentId: "otto", entryId: LS_ENTRY.id, ...shownOf(shownFile) };
    const writtenFile = { ...approvalsFile([NODE_ENTRY]), hash: "written" };
    /** The shown file, a write answered with `reply`, then the read afterwards. */
    const attempt = (after: () => unknown, reply: unknown = writtenFile) => {
      const gateway = fake({
        "exec.approvals.get": () =>
          gateway.methods().includes("exec.approvals.set") ? after() : shownFile,
        "exec.approvals.set": () => reply,
      });
      return removeAllowlistEntry(gateway.ctx, target).then((result) => ({ result, gateway }));
    };
    const reads: Array<[string, () => unknown, unknown?]> = [
      [
        "lost read",
        () => {
          throw new Error("socket closed");
        },
      ],
      ["absent file", () => ({ path: "p", exists: true, hash: "written" })],
      ["flagged partial", () => ({ ...writtenFile, hasMore: true })],
      ["missing hash", () => ({ ...writtenFile, hash: undefined })],
      [
        "a valid-looking subset under the write's hash",
        () => ({ ...writtenFile, file: { version: 1 } }),
      ],
      ["an incomplete write answer", () => writtenFile, { ...writtenFile, file: undefined }],
    ];
    for (const [what, after, reply] of reads) {
      const { result } = await attempt(after, reply ?? writtenFile);
      expect(result.outcome, what).not.toBe("removed");
      expect(result.removed, what).toBeNull();
    }
    // A complete read after the accepted write, of the file it wrote: Removed, naming the entry.
    const { result, gateway } = await attempt(() => writtenFile);
    expect(result).toMatchObject({
      outcome: "removed",
      removed: { agentId: "otto", pattern: "/bin/ls" },
    });
    expect(gateway.methods()).toEqual([
      "exec.approvals.get",
      "exec.approvals.set",
      "exec.approvals.get",
    ]);
  });

  it("two operators removing at once: the refused one never says Removed, and different entries both survive their own write", async () => {
    // One file, changed only by a write naming its current hash, as the gateway's is.
    const shared = approvalsGateway(approvalsFile([LS_ENTRY, NODE_ENTRY]));
    const shown = shownOf(approvalsFile([LS_ENTRY, NODE_ENTRY]));
    // Both read the same revision; the first write wins.
    const first = await removeAllowlistEntry(shared.ctx, {
      agentId: "otto",
      entryId: LS_ENTRY.id,
      ...shown,
    });
    expect(first.outcome).toBe("removed");
    /** A second device that read the shown revision before the first device wrote. */
    const staleDevice = () => {
      const device = fake({
        "exec.approvals.get": () =>
          device.methods().includes("exec.approvals.set")
            ? shared.file()
            : approvalsFile([LS_ENTRY, NODE_ENTRY]),
        "exec.approvals.set": (params) => {
          if (params.baseHash !== shared.file().hash)
            throw new Error(
              "exec approvals changed since last load; re-run exec.approvals.get and retry",
            );
          return shared.file();
        },
      });
      return device;
    };
    // The second device, same entry: refused, and never Removed though the entry is gone.
    const second = await removeAllowlistEntry(staleDevice().ctx, {
      agentId: "otto",
      entryId: LS_ENTRY.id,
      ...shown,
    });
    expect(second.outcome).toBe("not-confirmed");
    expect(second.removed).toBeNull();
    expect(second.error).toContain("changed since last load");
    // Different entries: the later write is refused, and the entry it meant to remove remains.
    const other = await removeAllowlistEntry(staleDevice().ctx, {
      agentId: "otto",
      entryId: NODE_ENTRY.id,
      ...shown,
    });
    expect(other.outcome).toBe("still-listed");
    expect(shared.file().file.agents.otto.allowlist).toEqual([NODE_ENTRY]);
  });

  it("an entry the shown revision does not have is not written", async () => {
    const gateway = approvalsGateway(approvalsFile([NODE_ENTRY]));
    const result = await removeAllowlistEntry(gateway.ctx, {
      agentId: "otto",
      entryId: LS_ENTRY.id,
      ...shownOf(approvalsFile([NODE_ENTRY])),
    });
    expect(result.outcome).toBe("not-listed");
    expect(gateway.methods()).toEqual(["exec.approvals.get"]);
  });
});

// Activity ------------------------------------------------------------------------------

const event = (patch: Record<string, unknown>) => ({
  schemaVersion: 1,
  sequence: 1,
  eventId: `e-${String(patch.toolCallId ?? "x")}-${String(patch.action ?? "")}`,
  sourceSequence: 1,
  occurredAt: 1_795_098_505_636,
  redaction: "metadata_only",
  agentId: "otto",
  sessionKey: "agent:otto:dashboard:3e1273ad",
  runId: "run-1",
  kind: "tool_action",
  toolName: "read",
  action: "tool.action.finished",
  status: "succeeded",
  eventType: "tool_action",
  actor: { type: "agent", id: "otto" },
  ...patch,
});
const BLOCKED_CALL = auditCallId("call_read_agents");
const ROUTINE_CALL = auditCallId("call_908f30483c89266b");

describe("F-324: Activity, from the audit log and what joins to it", () => {
  it("groups a call's start and end into one row, newest first, with the audit record's own status", () => {
    const rows = activityRows([
      event({
        toolCallId: BLOCKED_CALL,
        status: "blocked",
        errorCode: "tool_blocked",
        occurredAt: 30,
      }),
      event({
        toolCallId: BLOCKED_CALL,
        action: "tool.action.started",
        status: "started",
        occurredAt: 20,
      }),
      event({
        toolCallId: ROUTINE_CALL,
        runId: "run-2",
        action: "tool.action.started",
        status: "started",
        occurredAt: 10,
      }),
      { kind: "agent_run", eventId: "x", agentId: "otto", runId: "run-1", occurredAt: 5 },
    ]);
    expect(rows.map((row) => [row.callId, row.status, row.at, row.startedAt])).toEqual([
      [BLOCKED_CALL, "blocked", 30, 20],
      [ROUTINE_CALL, "started", 10, 10],
    ]);
  });

  it("the audit log hashes a call id as sha256 of the id (seen on a development gateway)", () => {
    expect(auditCallId("call_908f30483c89266b")).toBe(
      "sha256:782f053ae44cfe3f8cc165aabb5249a580240f9b672b11f037451487a558747d",
    );
  });

  const decisions = (records: Record<string, unknown>[], hasMore = false) => ({
    records,
    hasMore,
    retention: { days: 30, maxRecords: 50000 },
  });
  const record = (patch: Record<string, unknown>) => ({
    id: "fd01881abee3db14",
    at: 1,
    agentId: "otto",
    sessionKey: "agent:otto:dashboard:3e1273ad",
    runId: "run-1",
    callId: BLOCKED_CALL,
    tool: "read",
    rules: "read",
    decision: "block",
    source: { kind: "rule", scope: "otto", ruleId: "8d86d46e8ae5", version: 1, action: "never" },
    answer: null,
    answeredAt: null,
    ...patch,
  });
  const rules = (version: number) => ({
    rulesSchema: 1,
    scopes: {
      otto: {
        version: 2,
        fallback: false,
        rules: [
          {
            id: "8d86d46e8ae5",
            version,
            action: "never",
            tools: ["read"],
            target: { kind: "path", pattern: "AGENTS*.md" },
          },
        ],
      },
    },
  });

  it("a cause is Recorded only from a decision record of the same run and call, naming the version it had", async () => {
    const gateway = fake({
      "audit.activity.list": () => ({
        events: [
          event({ toolCallId: BLOCKED_CALL, status: "blocked", errorCode: "tool_blocked" }),
          event({
            toolCallId: ROUTINE_CALL,
            runId: "run-2",
            toolName: "exec",
            status: "failed",
            errorCode: "tool_failed",
          }),
        ],
        nextCursor: "108",
      }),
      "config.get": () => ({ config: {} }),
      "clawtrate-tool-rules.decisions.list": (params) =>
        params.runId === "run-1"
          ? decisions([
              record({}),
              record({ id: "other-run", runId: "run-1", callId: ROUTINE_CALL }),
            ])
          : decisions([]),
      "clawtrate-tool-rules.get": () => rules(2),
    });
    const page = await readActivity(
      gateway.ctx,
      { cursor: null, agentId: null, status: null },
      { rulesListed: true, loaded: new Map() },
    );
    expect(page.nextCursor).toBe("108");
    expect(page.recording).toBe("on");
    const [blocked, routine] = page.rows;
    expect(blocked!.cause).toEqual({
      kind: "recorded",
      decision: "block",
      answer: null,
      recordId: "fd01881abee3db14",
      source: {
        kind: "rule",
        rule: {
          scope: "otto",
          ruleId: "8d86d46e8ae5",
          version: 1,
          action: "never",
          now: { version: 2, tools: ["read"], pattern: "AGENTS*.md" },
        },
      },
    });
    // A record of the same call id under another run does not join: nothing joins, so not recorded.
    expect(routine!.cause).toEqual({ kind: "not-recorded" });
    expect(
      gateway.calls
        .filter((each) => each.method.endsWith("decisions.list"))
        .map((each) => each.params),
    ).toEqual([
      { runId: "run-1", limit: DECISIONS_PER_RUN },
      { runId: "run-2", limit: DECISIONS_PER_RUN },
    ]);
    expect(gateway.calls[0]!.params).toEqual({ kind: "tool_action", limit: ACTIVITY_PAGE_RECORDS });
  });

  it("an ask's record gives the answer the gateway passed on, and a decision of none is no cause", async () => {
    const gateway = fake({
      "audit.activity.list": () => ({
        events: [
          event({
            toolCallId: BLOCKED_CALL,
            toolName: "write",
            status: "failed",
            errorCode: "tool_failed",
          }),
          event({ toolCallId: ROUTINE_CALL, toolName: "exec" }),
        ],
      }),
      "config.get": () => ({ config: {} }),
      "clawtrate-tool-rules.decisions.list": () =>
        decisions([
          record({ decision: "ask", source: { kind: "fallback", scope: "*" }, answer: "deny" }),
          record({ id: "n", callId: ROUTINE_CALL, decision: "none", source: null }),
        ]),
      "clawtrate-tool-rules.get": () => rules(1),
    });
    const page = await readActivity(
      gateway.ctx,
      { cursor: null, agentId: null, status: null },
      { rulesListed: true, loaded: new Map() },
    );
    expect(page.rows[0]!.cause).toMatchObject({
      kind: "recorded",
      decision: "ask",
      answer: "deny",
      source: { kind: "fallback", scope: "*" },
    });
    expect(page.rows[1]!.cause).toEqual({ kind: "not-recorded" });
    expect(page.nextCursor).toBeNull();
  });

  it("says a cause was not read when a run's records were not all read, or could not be read", async () => {
    const many = await readActivity(
      fake({
        "audit.activity.list": () => ({ events: [event({ toolCallId: BLOCKED_CALL })] }),
        "config.get": () => ({ config: {} }),
        "clawtrate-tool-rules.decisions.list": () => decisions([], true),
      }).ctx,
      { cursor: null, agentId: null, status: null },
      { rulesListed: true, loaded: new Map() },
    );
    expect(many.rows[0]!.cause.kind).toBe("not-read");
    const failing = await readActivity(
      fake({
        "audit.activity.list": () => ({ events: [event({ toolCallId: BLOCKED_CALL })] }),
        "config.get": () => ({ config: {} }),
        "clawtrate-tool-rules.decisions.list": () => {
          throw new Error("missing scope: operator.admin");
        },
      }).ctx,
      { cursor: null, agentId: null, status: null },
      { rulesListed: true, loaded: new Map() },
    );
    expect(failing.rows[0]!.cause).toEqual({
      kind: "not-read",
      reason: "missing scope: operator.admin",
    });
    expect(failing.decisionsUnread).toBe("missing scope: operator.admin");
  });

  it("while the plugin says its decision record is failing, a call with no record says its cause was not read", async () => {
    const page = await readActivity(
      fake({
        "audit.activity.list": () => ({
          events: [
            event({ toolCallId: BLOCKED_CALL, status: "blocked" }),
            event({ toolCallId: ROUTINE_CALL }),
          ],
        }),
        "config.get": () => ({ config: {} }),
        "clawtrate-tool-rules.decisions.list": () =>
          decisions([
            record({
              decision: "block",
              source: { kind: "rule", scope: "otto", ruleId: "r1", version: 1, action: "never" },
            }),
          ]),
        "clawtrate-tool-rules.get": () => ({ scopes: {} }),
        "clawtrate-tool-rules.status": () => ({
          version: "1.0.0",
          decisions: { state: "failing", reason: "the decision record cannot be read (EACCES)" },
        }),
      }).ctx,
      { cursor: null, agentId: null, status: null },
      { rulesListed: true, loaded: new Map() },
    );
    // A record that was read still counts; a missing one may be in the file it could not read.
    expect(page.rows.map((row) => row.cause.kind)).toEqual(["recorded", "not-read"]);
    expect(page.rows[1]!.cause).toEqual({
      kind: "not-read",
      reason: "Clawtrate's rules plugin says the decision record cannot be read (EACCES).",
    });
  });

  it("without the plugin's methods nothing is joined and the plugin is not asked", async () => {
    const gateway = fake({
      "audit.activity.list": () => ({ events: [event({ toolCallId: BLOCKED_CALL })] }),
      "config.get": () => ({ config: { logging: { audit: { enabled: false } } } }),
    });
    const page = await readActivity(
      gateway.ctx,
      { cursor: "68", agentId: "otto", status: "blocked" },
      { rulesListed: false, loaded: new Map() },
    );
    expect(page.rows[0]!.cause).toEqual({ kind: "not-recorded" });
    expect(page.recording).toBe("off");
    expect(gateway.methods()).toEqual(["audit.activity.list", "config.get"]);
    expect(gateway.calls[0]!.params).toEqual({
      kind: "tool_action",
      limit: ACTIVITY_PAGE_RECORDS,
      cursor: "68",
      agentId: "otto",
      status: "blocked",
    });
  });

  it("Show in chat is offered only for a call a loaded task holds, matched by the audit log's hash", async () => {
    const page = await readActivity(
      fake({
        "audit.activity.list": () => ({
          events: [
            event({ toolCallId: BLOCKED_CALL }),
            event({ toolCallId: ROUTINE_CALL, runId: "run-2" }),
          ],
        }),
        "config.get": () => ({ config: {} }),
      }).ctx,
      { cursor: null, agentId: null, status: null },
      {
        rulesListed: false,
        loaded: new Map([
          [
            BLOCKED_CALL,
            [
              {
                key: "agent:otto:dashboard:3e1273ad",
                callId: "call_read_agents",
                runId: "run-1",
                kind: "history",
              },
            ],
          ],
        ]),
      },
    );
    expect(page.rows.map((row) => row.inChat)).toEqual([
      { key: "agent:otto:dashboard:3e1273ad", callId: "call_read_agents", runId: "run-1" },
      null,
    ]);
  });

  it("Show in chat opens the row's own call: matched by its task and run, and withheld when that can't be told apart", async () => {
    const TASK_A = "agent:otto:task-a";
    const TASK_B = "agent:otto:task-b";
    const read = (loaded: Map<string, LoadedCall[]>) =>
      readActivity(
        fake({
          "audit.activity.list": () => ({
            events: [event({ toolCallId: BLOCKED_CALL, sessionKey: TASK_A, runId: "run-a" })],
          }),
          "config.get": () => ({ config: {} }),
        }).ctx,
        { cursor: null, agentId: null, status: null },
        { rulesListed: false, loaded },
      ).then((page) => page.rows[0]!.inChat);
    const drawn = (key: string, runId: string | null, kind: LoadedCall["kind"]): LoadedCall => ({
      key,
      callId: "call_1",
      runId,
      kind,
    });
    const at = (...calls: LoadedCall[]) => new Map([[BLOCKED_CALL, calls]]);
    const target = { key: TASK_A, callId: "call_1", runId: "run-a" };
    // The same call id in another task is never this row's call.
    expect(await read(at(drawn(TASK_B, "run-a", "step")))).toBeNull();
    // A history block that names no run is never enough, nor a step of another run.
    expect(await read(at(drawn(TASK_A, null, "history")))).toBeNull();
    expect(await read(at(drawn(TASK_A, "run-b", "step")))).toBeNull();
    // Two drawings of one kind in the row's run can't be told apart.
    expect(
      await read(at(drawn(TASK_A, "run-a", "step"), drawn(TASK_A, "run-a", "step"))),
    ).toBeNull();
    // A known step beside a history block of another run, or of no recorded run.
    expect(
      await read(at(drawn(TASK_A, "run-a", "step"), drawn(TASK_A, "run-b", "history"))),
    ).toBeNull();
    expect(
      await read(at(drawn(TASK_A, "run-a", "step"), drawn(TASK_A, null, "history"))),
    ).toBeNull();
    // One exact step; one history block the gateway tagged with the run; the two of them together.
    expect(await read(at(drawn(TASK_A, "run-a", "step")))).toEqual(target);
    expect(await read(at(drawn(TASK_A, "run-a", "history")))).toEqual(target);
    expect(
      await read(at(drawn(TASK_A, "run-a", "step"), drawn(TASK_A, "run-a", "history"))),
    ).toEqual(target);
  });

  it("two audit records with the same run and call in two tasks are two rows", async () => {
    const page = await readActivity(
      fake({
        "audit.activity.list": () => ({
          events: [
            event({ eventId: "e-a", toolCallId: BLOCKED_CALL, sessionKey: "agent:otto:task-a" }),
            event({ eventId: "e-b", toolCallId: BLOCKED_CALL, sessionKey: "agent:otto:task-b" }),
          ],
        }),
        "config.get": () => ({ config: {} }),
      }).ctx,
      { cursor: null, agentId: null, status: null },
      { rulesListed: false, loaded: new Map() },
    );
    expect(page.rows.map((row) => row.sessionKey)).toEqual([
      "agent:otto:task-a",
      "agent:otto:task-b",
    ]);
  });

  it("a page is bounded where it enters and fits one result frame", async () => {
    const long = "y".repeat(5000);
    const id = "z".repeat(MAX_ACTIVITY_ID - 3);
    const page = await readActivity(
      fake({
        "audit.activity.list": () => ({
          events: Array.from({ length: 500 }, (_, i) =>
            event({
              eventId: `${id}${i}`,
              toolCallId: `${id}${i}`,
              runId: `${id}${i}`,
              sessionKey: id,
              toolName: long,
              agentId: "a".repeat(MAX_PERMISSION_NAME),
            }),
          ),
          nextCursor: long,
        }),
        "config.get": () => ({ config: {} }),
        "clawtrate-tool-rules.decisions.list": () => decisions([]),
      }).ctx,
      { cursor: null, agentId: null, status: null },
      { rulesListed: true, loaded: new Map() },
    );
    expect(page.rows).toHaveLength(ACTIVITY_PAGE_RECORDS);
    expect(page.rows[0]!.toolName).toHaveLength(MAX_PERMISSION_NAME);
    expect(JSON.stringify(page).length).toBeLessThan(MAX_RESULT_CHARS);
    // An id too long to keep whole is not cut into another record's: its record is left out.
    const cut = await readActivity(
      fake({
        "audit.activity.list": () => ({
          events: [event({ toolCallId: `${long}1` }), event({ toolCallId: `${long}2` })],
        }),
        "config.get": () => ({ config: {} }),
      }).ctx,
      { cursor: null, agentId: null, status: null },
      { rulesListed: false, loaded: new Map() },
    );
    expect(cut.rows).toEqual([]);
  });
});

describe("F-178 F-324: every answer fits its result frame once serialized", () => {
  // Characters that grow when JSON escapes them: a control character takes six, a
  // backslash and a quote two each. Bounds on length alone let such text outgrow the frame.
  const heavy = '\u0001\\"'.repeat(300);
  const heavyId = (i: number) => `${"\u0001".repeat(40)}${i}`;
  /** The frame less the envelope the web host wraps a result in. */
  const FRAME = MAX_RESULT_CHARS - 512;

  it("measures a string as JSON writes it, and cuts it to that measure", () => {
    expect(jsonChars("a\\b\u0001")).toBe(1 + 2 + 1 + 6);
    expect(fitJson(heavy, 100).length).toBeLessThan(100);
    expect(jsonChars(fitJson(heavy, 100))).toBeLessThanOrEqual(100);
    expect(fitJson("plain", 100)).toBe("plain");
  });

  it("saved approvals, a revoke and a removal, with text full of escapes", async () => {
    const entries = Array.from({ length: 300 }, (_, i) => ({
      ...LS_ENTRY,
      id: heavyId(i),
      pattern: heavy,
      argPattern: heavy,
      commandText: heavy,
    }));
    const grants = Array.from({ length: 500 }, (_, i) =>
      grant({
        grantId: heavyId(i),
        cronJobId: heavyId(i),
        agentId: "\u0001".repeat(21),
        command: heavy,
        cwd: heavy,
        cronJobName: heavy,
      }),
    );
    const file = {
      ...approvalsFile(entries),
      file: {
        version: 1,
        agents: {
          ["\u0001".repeat(21)]: {
            allowlist: entries,
            mcpTools: entries.map(() => ({ server: heavy, tool: heavy, source: "allow-always" })),
          },
        },
      },
      hash: "h",
    };
    const gateway = fake({
      "exec.approval.grants.list": () => ({ grants }),
      "exec.approval.grants.revoke": () => {
        throw new Error(heavy);
      },
      "exec.approvals.get": () => file,
      "exec.approvals.set": () => {
        throw new Error(heavy);
      },
    });
    const read = await readSavedApprovals(gateway.ctx, { canApprove: true, canAdmin: true });
    expect(JSON.stringify(read).length).toBeLessThan(FRAME);
    const revoked = await revokeGrant(gateway.ctx, heavyId(0));
    expect(JSON.stringify(revoked).length).toBeLessThan(FRAME);
    const removed = await removeAllowlistEntry(gateway.ctx, {
      agentId: "\u0001".repeat(21),
      entryId: heavyId(0),
      ...shownOf(file),
    });
    expect(removed.outcome).toBe("still-listed");
    expect(JSON.stringify(removed).length).toBeLessThan(FRAME);
  }, 60_000);

  it("a Saved approvals answer with both lists at their longest fits the host's frame, rows leaving from the end and counted", async () => {
    const word = (size: number) => '\\"'.repeat(size);
    // Distinct ids of the longest kept escaped length (511 of 512), and a bot id of 128.
    const longId = (i: number) => String(i).padStart(3, "0") + "\\".repeat(254);
    const bot = "a".repeat(MAX_PERMISSION_NAME);
    const grants = Array.from({ length: MAX_GRANTS_LISTED }, (_, i) =>
      grant({
        grantId: longId(i),
        cronJobId: longId(i),
        agentId: bot,
        cronJobName: word(32),
        command: word(128),
        cwd: word(128),
        expiresAtMs: 1,
        revokedAtMs: 1,
        lastUsedAtMs: 1,
        useCount: 10,
      }),
    );
    const entries = Array.from({ length: MAX_ALLOWLIST_LISTED }, (_, i) => ({
      id: longId(i),
      pattern: word(128),
      argPattern: word(64),
      commandText: word(64),
      lastUsedAt: 1,
    }));
    const read = (grantList: unknown[], entryList: unknown[]) =>
      readSavedApprovals(
        fake({
          "exec.approval.grants.list": () => ({ grants: grantList }),
          "exec.approvals.get": () => ({
            path: "p",
            exists: true,
            hash: "revision",
            file: { version: 1, agents: { [bot]: { allowlist: entryList } } },
          }),
        }).ctx,
        { canApprove: true, canAdmin: true },
      );
    const value = await read(grants, entries);
    if (value.grants.status !== "ready" || value.allowlist.status !== "ready")
      throw new Error("not ready");
    expect(JSON.stringify({ type: "result", id: 1, ok: true, value }).length).toBeLessThanOrEqual(
      MAX_RESULT_CHARS,
    );
    // Every entry is shown or counted, and what is shown is whole and in the file's order.
    expect(value.allowlist.omitted).toBeGreaterThan(0);
    expect(value.allowlist.items.length + value.allowlist.omitted).toBe(MAX_ALLOWLIST_LISTED);
    value.allowlist.items.forEach((each, i) => expect(each.entryId).toBe(longId(i)));
    value.grants.items.forEach((each, i) => expect(each.grantId).toBe(longId(i)));
    if (value.grants.items.length < MAX_GRANTS_LISTED) expect(value.grants.more).toBe(true);
    // The revision and digest stay the whole file's.
    expect(value.allowlist).toMatchObject({ hash: "revision" });
    // With the UUIDs the gateway makes, every one of the 140 rows is shown.
    const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const normal = await read(
      grants.map((each, i) => ({ ...each, grantId: uuid(i), cronJobId: uuid(i) })),
      entries.map((each, i) => ({ ...each, id: uuid(i) })),
    );
    if (normal.grants.status !== "ready" || normal.allowlist.status !== "ready")
      throw new Error("not ready");
    expect(normal.grants.items).toHaveLength(MAX_GRANTS_LISTED);
    expect(normal.allowlist.items).toHaveLength(MAX_ALLOWLIST_LISTED);
    expect(normal.allowlist.omitted).toBe(0);
  }, 60_000);

  it("an Activity page, joined to records and rules full of escapes", async () => {
    const page = await readActivity(
      fake({
        "audit.activity.list": () => ({
          events: Array.from({ length: 500 }, (_, i) =>
            event({
              eventId: heavyId(i),
              toolCallId: heavyId(i),
              runId: heavyId(i),
              sessionKey: heavyId(0),
              toolName: heavy,
              agentId: "\u0001".repeat(21),
            }),
          ),
          nextCursor: heavy,
        }),
        "config.get": () => ({ config: {} }),
        "clawtrate-tool-rules.decisions.list": (params) => ({
          records: Array.from({ length: 500 }, (_, i) => ({
            id: heavyId(i),
            runId: params.runId,
            callId: params.runId,
            decision: "block",
            source: {
              kind: "rule",
              scope: heavy,
              ruleId: heavy,
              version: 1,
              action: "never",
            },
          })),
          hasMore: false,
        }),
        "clawtrate-tool-rules.get": () => ({
          scopes: {
            [heavy]: {
              rules: [
                {
                  id: heavy,
                  version: 1,
                  tools: [heavy, heavy, heavy, heavy, heavy],
                  target: { pattern: heavy },
                },
              ],
            },
          },
        }),
      }).ctx,
      { cursor: null, agentId: null, status: null },
      {
        rulesListed: true,
        loaded: new Map(
          Array.from({ length: 500 }, (_, i) => [
            heavyId(i),
            [{ key: heavyId(0), callId: heavyId(i), runId: heavyId(i), kind: "step" as const }],
          ]),
        ),
      },
    );
    expect(page.rows).toHaveLength(ACTIVITY_PAGE_RECORDS);
    expect(JSON.stringify(page).length).toBeLessThan(FRAME);
  });
});

describe("F-178 F-324: the bridge's Permissions commands", () => {
  it("are validated before they reach the client", () => {
    expect(
      parseBridgeCommand({
        type: "readActivity",
        cursor: "68",
        agentId: "otto",
        status: "blocked",
      }),
    ).toEqual({
      type: "readActivity",
      cursor: "68",
      agentId: "otto",
      status: "blocked",
    });
    expect(() =>
      parseBridgeCommand({ type: "readActivity", cursor: null, agentId: null, status: "denied" }),
    ).toThrow(/invalid status/);
    expect(() => parseBridgeCommand({ type: "revokeGrant", grantId: "" })).toThrow(
      /invalid grant id/,
    );
    const remove = {
      type: "removeAllowlistEntry",
      agentId: "otto",
      entryId: "e1",
      shownHash: "h1",
      shownDigest: "a".repeat(64),
      connectedAt: 1_795_098_000_000,
      gatewayId: "gw-1",
      gatewayUrl: "ws://127.0.0.1:19480",
    };
    expect(parseBridgeCommand(remove)).toEqual(remove);
    expect(parseBridgeCommand({ ...remove, gatewayId: null })).toEqual({
      ...remove,
      gatewayId: null,
    });
    expect(() => parseBridgeCommand({ ...remove, shownHash: undefined })).toThrow(
      /invalid file revision/,
    );
    for (const shownDigest of [undefined, "A".repeat(64), "a".repeat(63), "g".repeat(64)])
      expect(() => parseBridgeCommand({ ...remove, shownDigest })).toThrow(/invalid file digest/);
    for (const connectedAt of [undefined, -1, 1.5, "1"])
      expect(() => parseBridgeCommand({ ...remove, connectedAt })).toThrow(
        /invalid connection time/,
      );
    expect(() => parseBridgeCommand({ ...remove, gatewayUrl: "" })).toThrow(
      /invalid gateway address/,
    );
    expect(parseBridgeCommand({ type: "requestAccess", tier: "approvals" })).toEqual({
      type: "requestAccess",
      tier: "approvals",
    });
  });
});

describe("F-178: approvals access is asked for alone, and only when asked", () => {
  it("from a read-only connection requests exactly read and approvals, nothing else, and the client reads the grants once it holds them", async () => {
    const gateway = grantingGateway();
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-3" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => new Promise(() => {});
    gateway.handlers["exec.approval.grants.list"] = () => ({ grants: [grant()] });
    gateway.connectReply = (params) => {
      const { scopes } = params as { scopes: string[] };
      const hello = helloOk(scopes, "device-token");
      return {
        ok: true,
        payload: { ...hello, features: { methods: ["clawtrate-tool-rules.status"], events: [] } },
      };
    };
    gateway.handlers["clawtrate-tool-rules.status"] = () => ({
      version: "1.0.0",
      enforcing: "nothing",
      rules: { state: "none" },
      hook: { registered: true, lastCallAt: null },
    });
    const { client } = await openTask({ gateway, held: READ_SCOPES });
    expect(client.state.connection.scopes).toEqual(["operator.read"]);
    expect(await client.readRulesPlugin()).toMatchObject({
      state: "running",
      enforcing: "nothing",
    });
    expect((await client.readSavedApprovals()).grants).toEqual({ status: "needs-approvals" });
    expect(gateway.calls("exec.approval.grants.list")).toEqual([]);
    await expect(client.revokeGrant("g")).rejects.toThrow(/needs approvals access/);
    await client.requestAccess("approvals");
    await until(() => client.state.connection.upgrade.status === "pending");
    // From read only, exactly read and approvals: not the power to send, stop or answer questions.
    expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([
      { scopes: ["operator.read", "operator.approvals"] },
    ]);
    expect(APPROVALS_TIER_SCOPES).toEqual(["operator.read", "operator.approvals"]);
    // A later request for the interactive tier asks again, for the wider set.
    await client.requestAccess("interactive");
    await until(() => gateway.calls("device.scopes.requestUpgrade").length === 2);
    expect(gateway.calls("device.scopes.requestUpgrade")[1]).toEqual({
      scopes: [...INTERACTIVE_SCOPES],
    });
    client.stop();
  });
});
