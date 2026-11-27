// The pairing checks: what a pending request's id binds, and who may decide it, on the running
// OpenClaw version (docs/design/setup-effortless.md §5). Clawtrate approves another device by
// request id after reading the request again; that is sound only while the gateway keeps a
// request's key, role and scopes fixed under one id. That is a property of OpenClaw's code, not
// a documented contract, so these checks hold it on each version the development gateway runs.
//
// Each ask is one connect with a key of its own and the instance's shared token, ended at the
// gateway's PAIRING_REQUIRED answer. The approver holds Clawtrate's six. Every request and
// pairing a check makes is decided or removed before it ends.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { GatewayClient, type DeviceIdentity } from "@openclaw/gateway-client";
import { FULL_SCOPES } from "../../../packages/core/src/scopes.ts";
import type { OperatorSession } from "./operator.ts";

type JsonRecord = Record<string, unknown>;
const rec = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" ? (value as JsonRecord) : {};
const list = (value: unknown): JsonRecord[] => (Array.isArray(value) ? value.map(rec) : []);

export class PairingCheckFailure extends Error {}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new PairingCheckFailure(message);
}

export type PairingHarness = {
  /** Holds Clawtrate's six scopes. */
  admin: OperatorSession;
  /** A paired client with the scopes given, approved through the tool. */
  open: (label: string, scopes: string[]) => Promise<OperatorSession>;
  url: string;
  token: string;
};

type Key = DeviceIdentity & { publicKey: string };
function newKey(): Key {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    deviceId: createHash("sha256").update(raw).digest("hex"),
    publicKey: raw.toString("base64url"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

type Ask = {
  scopes?: string[];
  role?: string;
  name?: string;
  /** A browser origin: the gateway records one only for its browser copilot client. */
  origin?: string;
  /** Without the shared token: the device token kept in `tokens` alone. */
  deviceTokenOnly?: boolean;
  tokens?: Map<string, { token: string; scopes: string[] }>;
  /** Keep the connection open and hand it back. */
  keep?: (client: GatewayClient, events: JsonRecord[]) => void;
};
/** The gateway's browser copilot client, the one whose browser origin a request records. */
const COPILOT = {
  clientName: "openclaw-browser-copilot" as const,
  caps: ["run-tool-bindings", "session-scoped-events"],
};
type Asked =
  | { kind: "pending"; requestId: string }
  | { kind: "hello"; scopes: string[] }
  | { kind: "refused"; code: string };

/** One connect as `key`, ended at the gateway's first answer. */
function ask(h: PairingHarness, key: Key, options: Ask = {}): Promise<Asked> {
  const tokens = options.tokens ?? new Map<string, { token: string; scopes: string[] }>();
  const events: JsonRecord[] = [];
  const copilot = options.origin !== undefined;
  return new Promise((resolve) => {
    let settled = false;
    const client: GatewayClient = new GatewayClient({
      url: h.url,
      ...(options.deviceTokenOnly ? {} : { token: h.token }),
      clientName: copilot ? COPILOT.clientName : "gateway-client",
      mode: "ui",
      clientDisplayName: options.name ?? "Clawtrate pairing check",
      clientVersion: "0.0.0",
      platform: process.platform,
      role: options.role ?? "operator",
      scopes: options.scopes ?? [...FULL_SCOPES],
      caps: copilot ? COPILOT.caps : [],
      minProtocol: 4,
      maxProtocol: 4,
      deviceIdentity: key,
      ...(options.origin ? { origin: options.origin } : {}),
      hostDeps: {
        signDevicePayload: (pem, payload) =>
          sign(null, Buffer.from(payload), createPrivateKey(pem)).toString("base64url"),
        publicKeyRawBase64UrlFromPem: (pem) =>
          createPublicKey(pem)
            .export({ type: "spki", format: "der" })
            .subarray(-32)
            .toString("base64url"),
        loadDeviceAuthToken: ({ deviceId, role }) => tokens.get(`${deviceId}:${role}`) ?? null,
        storeDeviceAuthToken: ({ deviceId, role, token, scopes }) =>
          void tokens.set(`${deviceId}:${role}`, { token, scopes }),
        clearDeviceAuthToken: ({ deviceId, role }) => void tokens.delete(`${deviceId}:${role}`),
      },
      onConnectError: (error) => {
        const details = rec((error as { details?: unknown }).details);
        const code = String(details.code ?? (error as { code?: unknown }).code ?? "unknown");
        finish(
          code === "PAIRING_REQUIRED" && typeof details.requestId === "string"
            ? { kind: "pending", requestId: details.requestId }
            : { kind: "refused", code },
        );
      },
      onEvent: (frame) => void events.push({ event: frame.event, payload: frame.payload }),
      onReconnectPaused: () => finish({ kind: "refused", code: "paused" }),
      onHelloOk: (hello) => {
        if (options.keep && !settled) {
          settled = true;
          clearTimeout(timer);
          options.keep(client, events);
          resolve({ kind: "hello", scopes: scopesOf(hello) });
          return;
        }
        finish({ kind: "hello", scopes: scopesOf(hello) });
      },
    });
    const timer = setTimeout(() => finish({ kind: "refused", code: "no answer" }), 20_000);
    function finish(value: Asked) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void client.stopAndWait({ timeoutMs: 5_000 }).catch(() => {});
      resolve(value);
    }
    client.start();
  });
}
const scopesOf = (hello: unknown) =>
  (Array.isArray(rec(rec(hello).auth).scopes) ? (rec(rec(hello).auth).scopes as string[]) : [])
    .slice()
    .sort();

async function pendingId(h: PairingHarness, key: Key, options: Ask = {}): Promise<string> {
  const asked = await ask(h, key, options);
  expect(asked.kind === "pending", `expected a pending request, got ${JSON.stringify(asked)}`);
  return asked.requestId;
}

async function listed(h: PairingHarness) {
  const answer = rec(await h.admin.request("device.pair.list", {}));
  return { pending: list(answer.pending), paired: list(answer.paired) };
}
const sorted = (value: unknown) =>
  (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []).sort();
const same = (a: unknown, b: readonly string[]) =>
  JSON.stringify(sorted(a)) === JSON.stringify([...b].sort());

/** The gateway's refusal, as its message. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new PairingCheckFailure("the gateway accepted it");
}

/** Every request and pairing a check made, decided or removed at its end. */
type World = { keys: Key[] };
async function tidy(h: PairingHarness, world: World): Promise<void> {
  const { pending, paired } = await listed(h);
  const mine = new Set(world.keys.map((key) => key.deviceId));
  for (const row of pending)
    if (mine.has(String(row.deviceId)))
      await h.admin.request("device.pair.reject", { requestId: row.requestId }).catch(() => {});
  for (const row of paired)
    if (mine.has(String(row.deviceId)))
      await h.admin.request("device.pair.remove", { deviceId: row.deviceId }).catch(() => {});
  world.keys = [];
}
const key = (world: World) => {
  const made = newKey();
  world.keys.push(made);
  return made;
};

export type PairingCheck = { name: string; run(h: PairingHarness, world: World): Promise<void> };

export const PAIRING_CHECKS: PairingCheck[] = [
  {
    name: "a refresh keeps the id, the key and the scopes; only the reported fields move",
    async run(h, world) {
      const k = key(world);
      const first = await pendingId(h, k, { name: "Before" });
      expect((await pendingId(h, k, { name: "After" })) === first, "the same ask made a new id");
      expect(
        (await pendingId(h, k, { name: "After", scopes: ["operator.read"] })) === first,
        "a smaller ask made a new id",
      );
      const row = (await listed(h)).pending.find((each) => each.requestId === first);
      expect(row, "the request is not listed");
      expect(row.publicKey === k.publicKey && row.deviceId === k.deviceId, "another key");
      expect(same(row.scopes, FULL_SCOPES), `scopes moved to ${JSON.stringify(row.scopes)}`);
      expect(same(row.roles, ["operator"]) && row.role === "operator", "the role moved");
      expect(row.displayName === "After", `reported name ${String(row.displayName)}`);
    },
  },
  {
    name: "more scopes, another role or another origin make a new id, and the old one ends",
    async run(h, world) {
      const k = key(world);
      const after = h.admin.lastSeq;
      const read = await pendingId(h, k, { scopes: ["operator.read"] });
      const six = await pendingId(h, k);
      expect(six !== read, "more scopes kept the id");
      await h.admin.waitFor(
        "the superseded request's end",
        (e) =>
          e.event === "device.pair.resolved" &&
          rec(e.payload).requestId === read &&
          rec(e.payload).decision === "rejected",
        20_000,
        after,
      );
      const node = await ask(h, k, { role: "node", scopes: [] });
      expect(node.kind !== "pending" || node.requestId !== six, "another role kept the id");
      // A browser origin, as the gateway records one: the same keeps the id, another doesn't.
      const o = key(world);
      const [first, second] = ["a", "b"].map((c) => `chrome-extension://${c.repeat(32)}`);
      const plain = await pendingId(h, o, { origin: first! });
      expect(
        (await pendingId(h, o, { origin: first! })) === plain,
        "the same origin made a new id",
      );
      const moved = await pendingId(h, o, { origin: second! });
      expect(moved !== plain, "another origin kept the id");
      const rows = (await listed(h)).pending;
      expect(
        rows.find((each) => each.requestId === moved)?.browserOrigin === second,
        "the new id doesn't hold the new origin",
      );
      expect(!rows.some((each) => each.requestId === plain), "the first origin's id is listed");
      const { pending } = await listed(h);
      for (const row of pending.filter((each) => each.deviceId === k.deviceId))
        expect(row.requestId !== read, "the superseded id is still listed");
    },
  },
  {
    name: "a decision on an id that ended approves nothing",
    async run(h, world) {
      const k = key(world);
      const read = await pendingId(h, k, { scopes: ["operator.read"] });
      const six = await pendingId(h, k);
      const message = await refusal(() =>
        h.admin.request("device.pair.approve", { requestId: read }),
      );
      expect(/unknown requestId/i.test(message), `refused as ${message}`);
      const { pending, paired } = await listed(h);
      expect(!paired.some((each) => each.deviceId === k.deviceId), "the device was paired");
      expect(
        pending.some((each) => each.requestId === six),
        "the live request is gone",
      );
    },
  },
  {
    name: "the six approve a request for the six and one for fewer, exactly as asked",
    async run(h, world) {
      for (const scopes of [[...FULL_SCOPES], ["operator.read"]]) {
        const k = key(world);
        const requestId = await pendingId(h, k, { scopes });
        await h.admin.request("device.pair.approve", { requestId });
        const device = (await listed(h)).paired.find((each) => each.deviceId === k.deviceId);
        expect(device, "not paired");
        expect(device.publicKey === k.publicKey, "paired with another key");
        expect(same(device.roles, ["operator"]), `roles ${JSON.stringify(device.roles)}`);
        expect(same(device.scopes, scopes), `scopes ${JSON.stringify(device.scopes)}`);
        const tokens = list(device.tokens);
        expect(
          tokens.length === 1 && tokens[0]!.role === "operator" && same(tokens[0]!.scopes, scopes),
          `tokens ${JSON.stringify(tokens.map((t) => [t.role, t.scopes]))}`,
        );
        const again = await ask(h, k, { scopes });
        expect(
          again.kind === "hello" && same(again.scopes, scopes),
          `the next connect got ${JSON.stringify(again)}`,
        );
      }
    },
  },
  {
    name: "on its device token without admin a device is told of requests but lists and decides only its own",
    async run(h, world) {
      // Paired with read and pairing, then connected on its device token alone, as Clawtrate is.
      const own = key(world);
      const tokens = new Map<string, { token: string; scopes: string[] }>();
      const scopes = ["operator.read", "operator.pairing"];
      await h.admin.request("device.pair.approve", {
        requestId: await pendingId(h, own, { scopes, tokens }),
      });
      expect((await ask(h, own, { scopes, tokens })).kind === "hello", "not paired");
      let client: GatewayClient | null = null;
      let events: JsonRecord[] = [];
      const asked = await ask(h, own, {
        scopes,
        tokens,
        deviceTokenOnly: true,
        keep: (c, e) => ((client = c), (events = e)),
      });
      expect(asked.kind === "hello" && client, `its device token got ${JSON.stringify(asked)}`);
      const pairer = client as GatewayClient;
      try {
        const k = key(world);
        const requestId = await pendingId(h, k);
        const deadline = Date.now() + 20_000;
        while (
          !events.some(
            (e) => e.event === "device.pair.requested" && rec(e.payload).requestId === requestId,
          )
        ) {
          expect(Date.now() < deadline, "no device.pair.requested event");
          await new Promise((r) => setTimeout(r, 200));
        }
        const seen = list(rec(await pairer.request("device.pair.list", {})).pending);
        expect(!seen.some((each) => each.requestId === requestId), "it lists another's request");
        const message = await refusal(() => pairer.request("device.pair.approve", { requestId }));
        expect(/denied/i.test(message), `refused as ${message}`);
        expect(
          !(await listed(h)).paired.some((each) => each.deviceId === k.deviceId),
          "the device was paired",
        );
      } finally {
        await pairer.stopAndWait({ timeoutMs: 5_000 }).catch(() => {});
      }
    },
  },
  {
    name: "after a rejection the waiting device's next connect files a new id",
    async run(h, world) {
      const k = key(world);
      const first = await pendingId(h, k);
      await h.admin.request("device.pair.reject", { requestId: first });
      expect((await pendingId(h, k)) !== first, "the rejected id came back");
    },
  },
  {
    name: "nothing bounds pending requests: twenty keys are twenty requests",
    async run(h, world) {
      const ids = new Set<string>();
      for (let i = 0; i < 20; i += 1) ids.add(await pendingId(h, key(world)));
      const listedIds = new Set((await listed(h)).pending.map((each) => String(each.requestId)));
      expect(
        [...ids].every((id) => listedIds.has(id)),
        "a request is missing from the list",
      );
    },
  },
];

export async function runPairingChecks(
  h: PairingHarness,
  options: { log?: (line: string) => void } = {},
): Promise<{ passed: number; failed: number }> {
  const log = options.log ?? console.log;
  let passed = 0;
  let failed = 0;
  for (const check of PAIRING_CHECKS) {
    const world: World = { keys: [] };
    try {
      await check.run(h, world);
      passed += 1;
      log(`ok    ${check.name}`);
    } catch (error) {
      failed += 1;
      log(`FAIL  ${check.name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await tidy(h, world).catch((error: unknown) => log(`note  not tidied: ${String(error)}`));
    }
  }
  return { passed, failed };
}
