// The relay route end to end, in Node, on loopback: core's client as the phone, through
// RelaySocket and a relay stand-in, to a connector stand-in that bridges to a named
// development gateway the way the connector must (its own upgrade, `X-Forwarded-For` always
// set, no `Origin`). It proves a first pairing that waits for approval, a hello with exactly
// the scopes asked for, and request round trips inside the end-to-end channel.
//
//   pnpm dev-gateway start --instance <name> --trust-loopback-proxy --no-seed
//   node test/relay-e2e.ts --instance <name> [--checkout <the checkout that started it>]
//
// `--trust-loopback-proxy` comes with R0 (#255). Without it the gateway refuses the
// connector's forwarded upgrade with 403, and this check fails at the connector. Everything
// listens on 127.0.0.1 only. The default instance and its ports are refused. The phone's
// device is removed from the gateway at the end.

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { WebSocket as WsSocket, WebSocketServer, type RawData } from "ws";
import {
  EnrollmentOffer,
  generateKeyPair,
  isSendableCloseCode,
  relayIdFromKey,
  Responder,
  toBase64Url,
  type ChannelEvent,
  type GateCheck,
} from "../packages/relay-protocol/src/index.ts";
import { ClawtrateClient } from "../packages/core/src/client.ts";
import { createFileSigner, createFileStore } from "../packages/core/src/node/index.ts";
import { encodeRelayCode, parseRelayCode } from "../packages/core/src/relay/code.ts";
import type { RelayRoute } from "../packages/core/src/relay/route.ts";
import type { RelayTransport } from "../packages/core/src/relay/socket.ts";
import { instancePorts, openInstance, readDevConnection } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import { FORBIDDEN_PORTS } from "../e2e/ports.ts";

const { values } = parseArgs({
  options: { instance: { type: "string" }, checkout: { type: "string" } },
});
const name = values.instance;
if (!name) throw new Error("--instance <name> is required; the default instance is never used");
const inst = openInstance(name, {
  ...(values.checkout
    ? { checkout: values.checkout, runRoot: join(values.checkout, "tools/dev-gateway/.run") }
    : {}),
});
const { gatewayPort } = instancePorts(inst);
if (FORBIDDEN_PORTS.includes(gatewayPort) || gatewayPort === 18789) {
  throw new Error(`refusing gateway port ${gatewayPort}`);
}
const connection = readDevConnection(inst.connectionFile);
if (!connection) throw new Error(`instance ${name} has no connection file; start it first`);

const log = (line: string) => console.log(`relay-e2e: ${line}`);
const XFF = "192.0.2.1";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`check failed: ${message}`);
}

async function openclaw(args: string[]): Promise<string> {
  const result = await inst.runner.run(args);
  if (result.status !== 0) throw new Error(`openclaw ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

async function waitFor(what: string, test: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// The connector's keys, its allowlist and one offer.
const registrationKey = randomBytes(32);
const relayId = relayIdFromKey(registrationKey);
const connectorKey = generateKeyPair();
const enrolled: Uint8Array[] = [];
const enrollSecret = new Uint8Array(randomBytes(32));
const offer = new EnrollmentOffer(enrollSecret, Date.now() + 600_000);

const gate = {
  check(phoneKey: Uint8Array, enroll: Uint8Array | undefined): GateCheck {
    if (enrolled.some((key) => Buffer.compare(key, phoneKey) === 0)) return "enrolled";
    if (enroll === undefined) return "not_enrolled";
    return offer.matches(enroll, Date.now()) ? { eligible: offer } : "enrollment_refused";
  },
};

/**
 * One relayed session at the connector: the responder, then, once the phone is admitted, its
 * own socket to the gateway, built here with X-Forwarded-For and without Origin.
 */
function connectorSession(session: WsSocket): void {
  const channel = new Responder({ relayId, staticKey: connectorKey, gate });
  let gatewaySocket: WsSocket | null = null;
  const toPhone = (frames: Uint8Array[]) => {
    for (const frame of frames) session.send(frame);
  };
  const end = () => {
    channel.abort();
    gatewaySocket?.close();
    session.close();
  };
  const openGateway = () => {
    const socket = new WsSocket(`ws://127.0.0.1:${gatewayPort}`, {
      headers: {
        "X-Forwarded-For": XFF,
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "relay.example.test",
      },
    });
    gatewaySocket = socket;
    socket.on("message", (data: RawData) => {
      if (channel.currentState === "open") toPhone(channel.sendText(data.toString()));
    });
    socket.on("close", (code: number, reason: Buffer) => {
      if (channel.currentState !== "open") return;
      toPhone([channel.close(isSendableCloseCode(code) ? code : 1011, reason.toString())]);
      session.close();
    });
    socket.on("unexpected-response", (_request, response: IncomingMessage) => {
      log(`the gateway refused the connector's upgrade: HTTP ${response.statusCode}`);
      end();
    });
    socket.on("error", () => end());
  };
  session.on("message", (data: RawData, isBinary: boolean) => {
    // The relay's own messages, and frames racing a close that already ended the channel.
    if (!isBinary || channel.currentState === "closed") return;
    let events: ChannelEvent[];
    try {
      events = channel.receive(new Uint8Array(data as Buffer));
    } catch (error) {
      log(`connector refused a frame: ${String(error)}`);
      end();
      return;
    }
    for (const event of events) {
      if (event.type === "send") toPhone([event.frame]);
      else if (event.type === "admit") {
        const attempt = channel.beginAdmission(event.admission);
        let result: "enrolled" | "enrollment_refused" = "enrolled";
        if (attempt.live && attempt.candidate !== null) {
          if ((attempt.candidate as EnrollmentOffer).spend(Date.now())) {
            enrolled.push(attempt.phoneKey);
          } else result = "enrollment_refused";
        }
        const settled = channel.settle(attempt, result);
        if (settled.frame) toPhone([settled.frame]);
        if (settled.admitted) openGateway();
      } else if (event.type === "text") {
        const socket = gatewaySocket;
        if (socket?.readyState === WsSocket.OPEN) socket.send(event.text);
        else socket?.once("open", () => socket.send(event.text));
      } else if (event.type === "close") gatewaySocket?.close(event.code, event.reason);
    }
  });
  session.on("close", () => {
    channel.abort();
    gatewaySocket?.close();
  });
}

// The relay stand-in: /v1/dial/<relayId> for the phone, /v1/session/<relayId>/<session> for
// the connector, spliced; binary messages pass unchanged.
const server = createServer();
const wss = new WebSocketServer({ noServer: true });
const dials = new Map<string, WsSocket>();
let relayPort = 0;
server.on("upgrade", (request, socket, head) => {
  const path = request.url ?? "";
  wss.handleUpgrade(request, socket, head, (ws) => {
    const dial = path.match(/^\/v1\/dial\/([a-z2-7]{26})$/);
    const sessionPath = path.match(/^\/v1\/session\/([a-z2-7]{26})\/([A-Za-z0-9_-]{22})$/);
    if (dial && dial[1] === relayId) {
      const session = toBase64Url(new Uint8Array(randomBytes(16)));
      dials.set(session, ws);
      // The relay tells the connector, which opens its session socket.
      const leg = new WsSocket(`ws://127.0.0.1:${relayPort}/v1/session/${relayId}/${session}`);
      leg.on("open", () => connectorSession(leg));
    } else if (sessionPath && sessionPath[1] === relayId && dials.has(sessionPath[2]!)) {
      const phone = dials.get(sessionPath[2]!)!;
      dials.delete(sessionPath[2]!);
      phone.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) ws.send(data);
      });
      ws.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) phone.send(data);
      });
      phone.on("close", () => ws.close());
      ws.on("close", () => phone.close());
      phone.send('{"t":"open"}');
      ws.send('{"t":"open"}');
    } else ws.close(1008, "unknown");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
relayPort = (server.address() as { port: number }).port;
const relayOrigin = `ws://127.0.0.1:${relayPort}`;
log(`relay stand-in on ${relayOrigin}, gateway ${name} on port ${gatewayPort}`);

// The pairing code, with an OpenClaw setup code made for this route's dial address.
const route: RelayRoute = {
  kind: "relay",
  relayOrigin,
  relayId,
  connectorKey: toBase64Url(connectorKey.publicKey),
};
const dialUrl = `${relayOrigin}/v1/dial/${relayId}`;
const qr = parseJsonOutput<{ setupCode: string }>(
  await openclaw(["qr", "--json", "--url", dialUrl]),
);
const text = encodeRelayCode({
  route,
  enroll: enrollSecret,
  expiresAtMs: offer.expiresAtMs,
  setupCode: qr.setupCode,
});
const code = parseRelayCode(text, Date.now(), { allowLoopbackWs: true });

// The phone: core's client with a file store and key of its own, and Node's own WebSocket.
const dataDir = mkdtempSync(join(tmpdir(), "clawtrate-relay-e2e-"));
const phoneKey = generateKeyPair();
const transports: RelayTransport[] = [];
const client = new ClawtrateClient({
  createWebSocket: () => {
    throw new Error("a relay route never dials directly");
  },
  storage: createFileStore(join(dataDir, "state.json")),
  signer: createFileSigner(join(dataDir, "device-key.pem")),
  client: { displayName: "Clawtrate Relay E2E", version: "0.0.0", platform: "node" },
  relay: {
    createTransport: (url) => {
      const socket = new WebSocket(url) as unknown as RelayTransport;
      transports.push(socket);
      return socket;
    },
    loadStaticKey: async () => phoneKey,
    allowLoopbackWs: true,
  },
});
let deviceId: string | null = null;
try {
  await client.start();
  await client.connectRelay(code);
  await waitFor("the pairing request", () => client.state.connection.status === "pairing");
  const pairing = client.state.connection.pairing!;
  deviceId = client.state.connection.deviceId;
  log(`waiting for approval: request ${pairing.requestId}, scopes ${pairing.requestedScopes}`);
  check(enrolled.length === 1, "the connector enrolled the phone's key");
  check(Buffer.compare(enrolled[0]!, phoneKey.publicKey) === 0, "it enrolled this phone's key");
  check(offer.used, "the enrollment offer was spent");
  await openclaw(["devices", "approve", pairing.requestId]);
  await waitFor("hello", () => client.state.connection.status === "connected");
  const scopes = client.state.connection.requestedScopes;
  log(`hello on the relay route, scopes ${scopes.join(", ")}`);
  check(scopes.join(",") === "operator.read", "hello with exactly operator.read");
  check(!client.state.connection.canWrite, "read only");
  await waitFor("the bot list", () => client.state.discovery.status === "ready");
  log(`round trip: ${client.state.bots.length} bot(s) listed through the channel`);
  check(client.state.bots.length > 0, "a request answered through the channel");

  const devices = parseJsonOutput<{
    paired?: { deviceId: string; approvedVia?: string; remoteIp?: string }[];
  }>(await openclaw(["devices", "list", "--json"]));
  const paired = devices.paired?.find((device) => device.deviceId === deviceId);
  log(`the gateway's record: ${JSON.stringify(paired)}`);
  check(paired !== undefined, "the gateway paired the device");
  check(paired.approvedVia !== "silent", "the pairing was approved, not silent");
  // The gateway took the connector's forwarded address: the connection came through a trusted
  // proxy, not as a local one.
  check(paired.remoteIp === XFF, `the gateway saw the forwarded address ${XFF}`);
  check(transports.length >= 1, "the phone dialed the relay");
  log("PASS");
} finally {
  client.stop();
  if (deviceId) await openclaw(["devices", "remove", deviceId]).catch(() => {});
  wss.close();
  server.close();
  server.closeAllConnections();
  rmSync(dataDir, { recursive: true, force: true });
}
