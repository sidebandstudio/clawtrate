// An in-memory gateway for the link check (e2e-desktop/links.spec.ts), behind a
// WebSocket on 127.0.0.1 the app connects to: two bots with a chat each and one
// with none, on a connection that may write. Nothing here reaches another host.
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { FakeGateway, helloOk } from "../../../packages/core/test/fake-gateway.ts";

/** The gateway's public identity, as `gateway.identity.get` gives it. */
export const GATEWAY_ID = "5ca1ab1e".repeat(8);

export async function linkGateway() {
  const gateway = new FakeGateway();
  gateway.connectReply = () => ({
    ok: true,
    payload: helloOk(["operator.read", "operator.write"]),
  });
  gateway.handlers["gateway.identity.get"] = () => ({ deviceId: GATEWAY_ID });
  gateway.handlers["agents.list"] = () => ({
    defaultId: "marlow",
    agents: [
      { id: "marlow", identity: { name: "Marlow" } },
      { id: "otto", identity: { name: "Otto" } },
      { id: "quill", identity: { name: "Quill" } },
    ],
  });
  const now = Date.now();
  const sessions = [
    { key: "agent:marlow:main", agentId: "marlow", label: "Intro review", updatedAt: now },
    { key: "agent:otto:main", agentId: "otto", label: "Release notes", updatedAt: now - 1000 },
  ];
  gateway.handlers["sessions.subscribe"] = () => ({
    subscribed: true,
    list: { sessions, hasMore: false },
  });
  gateway.handlers["sessions.list"] = () => ({ sessions, hasMore: false });

  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const url = "ws://127.0.0.1:" + (server.address() as AddressInfo).port;
  let refusing = false;
  server.on("connection", (peer: WebSocket) => {
    if (refusing) return peer.terminate();
    const socket = gateway.createWebSocket(url);
    socket.onmessage = ({ data }) => peer.send(data as string);
    socket.onclose = () => peer.terminate();
    peer.on("message", (data) => socket.send(data.toString()));
    peer.on("close", () => socket.close());
  });
  return {
    url,
    gateway,
    /** Drop every connection and refuse new ones, or accept them again. */
    refuse(on: boolean) {
      refusing = on;
      if (on) for (const peer of server.clients) peer.terminate();
    },
    async close() {
      for (const peer of server.clients) peer.terminate();
      const closed = once(server, "close");
      server.close();
      await closed;
    },
  };
}
