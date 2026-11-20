// The fixture's Settings → Permissions (docs/design/controls.md sections 7 to
// 9): the rules plugin's state, the routines' grants and the gateway machine's
// allowlist, and a page of the audit log with what the rules plugin's decision
// record says caused each call, answered as the engine would. Every grant,
// command, path, id and record here is made up.
//
// Address parameters:
//   rules=running|absent|stopped|failed|lost|old|unchecked
//                                                the rules plugin (default running; stopped: it
//                                                answers that it enforces nothing; failed: its
//                                                status fails; lost: its rules file is lost)
//   saved=empty|error|loading|more|expiring      saved approvals (default: two grants and two entries;
//                                                more: three more, one of a routine that is gone;
//                                                expiring: the live grant ends a minute from now)
//   revoke=refused|gone                          how Revoke goes: the gateway refuses, or lists no such grant
//   remove=changed|hidden                        Remove finds the entry edited in place after the
//                                                confirmation opened, or moved past the rows shown
//   saved=long                                   two entries whose long patterns share their shown start
// A hello later than the scene's (connectedAt in the future) reads the file as another revision.
//   audit=empty|off|error|loading|end|older-error|fail-once
//                                                activity (default: a page with older ones after it;
//                                                older-error: an older page fails; fail-once: the
//                                                first page fails once)

import {
  auditCallId,
  sha256Hex,
  utf8Bytes,
  type ActivityPage,
  type ActivityRow,
  type AllowlistEntry,
  type BridgeCommand,
  type ClawtrateState,
  type RoutineGrant,
  type RulesPluginState,
  type SavedApprovals,
} from "@clawtrate/core";
import { OPEN_TASK } from "./data.ts";

export type PermissionParams = {
  rules: string | null;
  saved: string | null;
  revoke: string | null;
  remove: string | null;
  audit: string | null;
};

export const NO_PERMISSION_PARAMS: PermissionParams = {
  rules: null,
  saved: null,
  revoke: null,
  remove: null,
  audit: null,
};

export function permissionParams(params: URLSearchParams): PermissionParams {
  return {
    rules: params.get("rules"),
    saved: params.get("saved"),
    revoke: params.get("revoke"),
    remove: params.get("remove"),
    audit: params.get("audit"),
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** An answer that never comes: the page stays as it is while a read is under way. */
const never = <T>() => new Promise<T>(() => {});

function plugin(now: number, params: PermissionParams): Promise<RulesPluginState> {
  switch (params.rules) {
    case "absent":
      return Promise.resolve({ state: "unavailable" });
    case "stopped":
      return Promise.resolve({
        state: "not-enforcing",
        answeredAt: now - MINUTE,
        lastCallAt: null,
      });
    case "failed":
      return Promise.resolve({
        state: "stopped",
        reason: "The gateway didn't answer within 60 seconds.",
      });
    case "lost":
      return Promise.resolve({
        state: "running",
        answeredAt: now - MINUTE,
        lastCallAt: now - 2 * MINUTE,
        enforcing: "ask-every-call",
        keptCopyReadAt: null,
      });
    case "old":
      return Promise.resolve({ state: "old", version: "0.9.0" });
    case "unchecked":
      return never();
    default:
      return Promise.resolve({
        state: "running",
        answeredAt: now - MINUTE,
        lastCallAt: now - 2 * MINUTE,
        enforcing: "rules",
        keptCopyReadAt: null,
      });
  }
}

function grants(now: number, params: PermissionParams): RoutineGrant[] {
  if (params.saved === "empty") return [];
  const list: RoutineGrant[] = [
    {
      grantId: "3f2a8c10-6b4e-4d2a-9f31-0c7e5b2d8a14",
      agentId: "otto",
      routineId: "7d1e4b20-1c3f-4a8e-b6d2-5e9f0a3c7b61",
      routineName: "Weekly cleanup",
      command: "du -sh /srv/media",
      cwd: "/srv/media",
      createdAtMs: now - 4 * DAY,
      expiresAtMs: now + 26 * DAY,
      revokedAtMs: null,
      lastUsedAtMs: now - 14 * HOUR,
      useCount: 4,
    },
    {
      grantId: "9c41d7e2-2a5b-4f0c-8e63-b1d0f4a72c95",
      agentId: "otto",
      routineId: "c2a7f915-3d4e-4b1a-a0f8-6e2d9b5c1f37",
      routineName: "Nightly backup check",
      command: "ls /srv/backups",
      cwd: "/srv/backups",
      createdAtMs: now - 12 * DAY,
      expiresAtMs: now - 2 * DAY,
      revokedAtMs: null,
      lastUsedAtMs: now - 3 * DAY,
      useCount: 9,
    },
  ];
  if (params.saved === "expiring") list[0] = { ...list[0]!, expiresAtMs: now + MINUTE };
  if (params.saved === "more")
    for (let i = 0; i < 3; i += 1)
      list.push({
        ...list[0]!,
        grantId: `5e0b${i}a3c-7d14-4c8e-92f6-3a1d8e4b0c7${i}`,
        // The last one's routine is gone: the gateway lists the grant with no routine name.
        routineName: i === 2 ? null : `Disk report ${i + 1}`,
        command: `df -h /srv/disk${i + 1}`,
        cwd: null,
        createdAtMs: now - (5 + i) * DAY,
        expiresAtMs: null,
        lastUsedAtMs: null,
        useCount: 0,
      });
  return list;
}

function entries(now: number, params: PermissionParams): AllowlistEntry[] {
  if (params.saved === "empty") return [];
  return [
    {
      agentId: "otto",
      entryId: "4b7e0c06-af1c-4726-9737-865a4b63db4b",
      kind: "command",
      pattern: "/bin/ls",
      argPattern: "sha256:cwd-argv:v1:aa32119de349b6d0d5116c70cd1363d1",
      commandText: null,
      fromAlwaysAllow: true,
      lastUsedAt: now - 6 * MINUTE,
      addedAt: null,
      shownWhole: true,
    },
    {
      agentId: "otto",
      entryId: null,
      kind: "tool",
      pattern: "coder__send_message",
      argPattern: null,
      commandText: null,
      fromAlwaysAllow: true,
      lastUsedAt: null,
      addedAt: now - 3 * DAY,
      shownWhole: true,
    },
    // Two patterns longer than the page shows, alike in all it shows: neither can be confirmed.
    ...(params.saved === "long"
      ? [0, 1].map((index): AllowlistEntry => ({
          agentId: "otto",
          entryId: `long-${index}`,
          kind: "command",
          // As the engine shows them: cut to 512, so their different ends are not shown.
          pattern: `/opt/tools/${"report-".repeat(71)}`,
          argPattern: null,
          commandText: null,
          fromAlwaysAllow: false,
          lastUsedAt: null,
          addedAt: null,
          shownWhole: false,
        }))
      : []),
  ];
}

type Log = Omit<ActivityRow, "inChat" | "callId" | "id"> & { call: string | null };

function log(now: number): Log[] {
  const rule = (
    action: "never" | "ask" | "allow",
    version: number,
    nowVersion: number | null,
    pattern: string,
    tools: string[],
  ) => ({
    kind: "rule" as const,
    rule: {
      scope: "otto",
      ruleId: "8d86d46e8ae5",
      version,
      action,
      now: nowVersion === null ? null : { version: nowVersion, tools, pattern },
    },
  });
  const otto = { agentId: "otto", sessionKey: OPEN_TASK };
  return [
    {
      ...otto,
      at: now - 7 * MINUTE,
      startedAt: now - 7 * MINUTE,
      runId: "run-7c1e-disk-1",
      call: "c5",
      toolName: "read",
      status: "succeeded",
      recordId: "a1f0c3d2-0001",
      cause: { kind: "not-recorded" },
    },
    {
      ...otto,
      sessionKey: "agent:otto:secrets-check",
      at: now - 21 * MINUTE,
      startedAt: now - 21 * MINUTE,
      runId: "run-3b9d-secrets",
      call: "s1",
      toolName: "write",
      status: "blocked",
      recordId: "a1f0c3d2-0003",
      cause: {
        kind: "recorded",
        decision: "block",
        source: rule("never", 1, 2, "secrets/**", ["write"]),
        answer: null,
        recordId: "e7c21b94d03a6f58",
      },
    },
    {
      agentId: "otto",
      sessionKey: "agent:otto:cron:7d1e4b20-1c3f-4a8e-b6d2-5e9f0a3c7b61:run:1",
      at: now - 14 * HOUR,
      startedAt: now - 14 * HOUR,
      runId: "run-5a2c-cron",
      call: "r1",
      toolName: "exec",
      status: "succeeded",
      recordId: "a1f0c3d2-0004",
      cause: { kind: "not-recorded" },
    },
    {
      agentId: "pip",
      sessionKey: "agent:pip:week",
      at: now - 15 * HOUR,
      startedAt: now - 15 * HOUR,
      runId: "run-2e8f-pip",
      call: "p1",
      toolName: "write",
      status: "failed",
      recordId: "a1f0c3d2-0005",
      cause: {
        kind: "recorded",
        decision: "ask",
        source: { kind: "fallback", scope: "*" },
        answer: "deny",
        recordId: "b3d1a7c09e2f4a61",
      },
    },
    {
      agentId: "main",
      sessionKey: "agent:main:heat-pump",
      at: now - 16 * HOUR,
      startedAt: now - 16 * HOUR,
      runId: "run-9f1a-juniper",
      call: "j1",
      toolName: "web_search",
      status: "started",
      recordId: "a1f0c3d2-0006",
      cause: { kind: "not-read", reason: "Its decision record didn't answer within 60 seconds." },
    },
    {
      ...otto,
      at: now - DAY - 3 * HOUR + 4 * MINUTE,
      startedAt: now - DAY - 3 * HOUR + 4 * MINUTE,
      runId: "run-7c1e-disk-0",
      call: "c3",
      toolName: "write",
      status: "succeeded",
      recordId: "a1f0c3d2-0002",
      cause: {
        kind: "recorded",
        decision: "ask",
        source: rule("ask", 1, 1, "notes/**", ["write"]),
        answer: "allow-once",
        recordId: "fd01881abee3db14",
      },
    },
  ];
}

function older(now: number): Log[] {
  return [
    {
      agentId: "marlow",
      sessionKey: "agent:marlow:main",
      at: now - 2 * DAY,
      startedAt: now - 2 * DAY,
      runId: "run-4d6b-marlow",
      call: "m1",
      toolName: "sessions_send",
      status: "succeeded",
      recordId: "a1f0c3d2-0007",
      cause: { kind: "not-recorded" },
    },
  ];
}

/** Rows as the engine gives them: a call a loaded task holds is "Show in chat". */
function rows(state: ClawtrateState, logs: Log[], agentId: string | null, status: string | null) {
  const loaded = new Set<string>();
  for (const [key, transcript] of Object.entries(state.transcripts))
    for (const item of transcript.items)
      for (const block of item.blocks)
        if (block.kind === "tool-call") loaded.add(`${key}\u0000${block.callId}`);
  return logs
    .filter((each) => (!agentId || each.agentId === agentId) && (!status || each.status === status))
    .map(({ call, ...each }): ActivityRow => {
      const callId = call ? auditCallId(call) : null;
      const inChat =
        call && each.sessionKey && loaded.has(`${each.sessionKey}\u0000${call}`)
          ? { key: each.sessionKey, callId: call }
          : null;
      return { ...each, id: `${each.runId}\u0000${callId ?? each.recordId}`, callId, inChat };
    });
}

/**
 * The Permissions commands, answered on the fixture's state. Returns undefined
 * for a command that is not one of them.
 */
/** Activity pages read so far in this page's life: the fixture's own cursor. */
let activityReads = 0;

export function permissionCommand(
  command: BridgeCommand,
  get: () => ClawtrateState,
  now: number,
  params: PermissionParams,
  revoked: Map<string, number>,
  removed: Set<string>,
  /** Runs an answer later, or once a test that holds answers releases them. */
  later: (run: () => void) => void = (run) => run(),
): Promise<unknown> | undefined {
  const connection = () => get().connection;
  const grantList = (): SavedApprovals["grants"] => ({
    status: "ready",
    items: grants(now, params).map((grant) =>
      revoked.has(grant.grantId) ? { ...grant, revokedAtMs: revoked.get(grant.grantId)! } : grant,
    ),
    more: params.saved === "more",
  });
  // With `remove=changed`, another admin edits the first entry in place, under the same id,
  // once the person has confirmed its removal: the file is then another revision.
  const edited = () => removed.has("edited");
  const revision = () => {
    const base = edited() ? "fixture-hash-2" : "fixture-hash";
    const at = connection().connectedAt;
    return at !== null && at > now ? `${base}@${at}` : base;
  };
  const allowlist = (): SavedApprovals["allowlist"] =>
    connection().canAdmin
      ? {
          status: "ready",
          items: entries(now, params)
            .filter((each) => !removed.has(each.entryId ?? ""))
            .map((each, index) =>
              edited() && index === 0
                ? { ...each, pattern: "/usr/bin/true", argPattern: null }
                : each,
            ),
          omitted: 0,
          hash: revision(),
          snapshotDigest: sha256Hex(utf8Bytes(revision())),
        }
      : { status: "needs-admin" };
  switch (command.type) {
    case "readRulesPlugin":
      return plugin(now, params);
    case "readSavedApprovals": {
      if (params.saved === "loading") return never();
      if (params.saved === "error")
        return Promise.reject(new Error("The gateway didn't answer within 60 seconds."));
      const value: SavedApprovals = {
        readAt: now,
        grants: connection().canApprove ? grantList() : { status: "needs-approvals" },
        allowlist: allowlist(),
      };
      return Promise.resolve(value);
    }
    case "revokeGrant": {
      const { grantId } = command;
      if (params.revoke === "refused")
        return Promise.resolve({
          answer: null,
          error: "The gateway refused the request: approval store unavailable.",
          grant:
            (grantList() as { items: RoutineGrant[] }).items.find(
              (each) => each.grantId === grantId,
            ) ?? null,
          readError: null,
          grants: grantList(),
        });
      if (params.revoke === "gone") {
        const list = grantList() as { status: "ready"; items: RoutineGrant[]; more: boolean };
        const items = list.items.filter((each) => each.grantId !== grantId);
        return Promise.resolve({
          answer: "not-found",
          error: null,
          grant: null,
          readError: null,
          grants: { ...list, items },
        });
      }
      revoked.set(grantId, Date.now());
      const list = grantList() as { status: "ready"; items: RoutineGrant[]; more: boolean };
      return Promise.resolve({
        answer: "revoked",
        error: null,
        grant: list.items.find((each) => each.grantId === grantId) ?? null,
        readError: null,
        grants: list,
      });
    }
    case "removeAllowlistEntry": {
      if (params.remove === "hidden") {
        // Another admin's write moved this entry past the rows the page shows: a new revision.
        removed.add(command.entryId);
        removed.add("edited-hidden");
        return Promise.resolve({
          outcome: "changed",
          removed: null,
          error: null,
          allowlist: allowlist(),
        });
      }
      if (params.remove === "changed" && !removed.has("edited")) {
        removed.add("edited");
        return Promise.resolve({
          outcome: "changed",
          removed: null,
          error: null,
          allowlist: allowlist(),
        });
      }
      const shown = allowlist();
      const entry =
        shown.status === "ready"
          ? shown.items.find(
              (each) => each.agentId === command.agentId && each.entryId === command.entryId,
            )
          : undefined;
      if (
        shown.status !== "ready" ||
        shown.hash !== command.shownHash ||
        shown.snapshotDigest !== command.shownDigest
      )
        return Promise.resolve({
          outcome: "changed",
          removed: null,
          error: null,
          allowlist: shown,
        });
      removed.add(command.entryId);
      return Promise.resolve({
        outcome: "removed",
        removed: entry ? { agentId: entry.agentId, pattern: entry.pattern } : null,
        error: null,
        allowlist: allowlist(),
      });
    }
    case "readActivity": {
      if (params.audit === "loading") return never();
      if (params.audit === "error")
        return Promise.reject(new Error("The gateway didn't answer within 60 seconds."));
      const first = command.cursor === null;
      // `fail-once`: the first page's first read fails, and Try again reads it.
      if (first && params.audit === "fail-once" && !removed.has("audit-failed")) {
        removed.add("audit-failed");
        return Promise.reject(new Error("The gateway didn't answer within 60 seconds."));
      }
      // `older-error`: an older page fails, as a delayed answer a test can hold.
      if (!first && params.audit === "older-error")
        return new Promise((_, reject) =>
          later(() => reject(new Error("The gateway didn't answer within 60 seconds."))),
        );
      if (first) activityReads += 1;
      const logs =
        params.audit === "empty" || params.audit === "off" ? [] : first ? log(now) : older(now);
      const page: ActivityPage = {
        readAt: now,
        rows: rows(get(), logs, command.agentId, command.status),
        // Each first page names its own cursor, so a test can tell which page Show older continues.
        nextCursor:
          first && !["empty", "off", "end"].includes(params.audit ?? "")
            ? `older-${activityReads}`
            : null,
        recording: params.audit === "off" ? "off" : "on",
        decisionsUnread: null,
      };
      // An older page is a delayed answer a test can hold, to answer after a newer question.
      return first ? Promise.resolve(page) : new Promise((resolve) => later(() => resolve(page)));
    }
    default:
      return undefined;
  }
}
