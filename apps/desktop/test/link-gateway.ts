// An in-memory gateway for the link check (e2e-desktop/links.spec.ts), behind a
// WebSocket on 127.0.0.1 the app connects to: bots with a chat each, one with
// none, and one with two, the newest marked unread. It grants what a connection
// asks for, and approves an access request at once, so a new device that asks
// may write. Nothing here reaches another host.
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { FakeGateway, helloOk } from "../../../packages/core/test/fake-gateway.ts";

/** The gateway's public identity, as `gateway.identity.get` gives it. */
export const GATEWAY_ID = "5ca1ab1e".repeat(8);

export async function linkGateway() {
  const gateway = new FakeGateway();
  gateway.connectReply = (params) => {
    const { scopes, auth } = params as { scopes: string[]; auth?: { deviceToken?: string } };
    return { ok: true, payload: helloOk(scopes, auth?.deviceToken ?? "device-token") };
  };
  let upgrade: string[] = [];
  gateway.handlers["device.scopes.requestUpgrade"] = (params) => {
    upgrade = (params as { scopes: string[] }).scopes;
    return { requestId: "access" };
  };
  gateway.handlers["device.scopes.waitUpgrade"] = () => ({
    status: "approved",
    requestId: "access",
    deviceToken: "upgraded",
    scopes: upgrade,
  });
  gateway.handlers["gateway.identity.get"] = () => ({ deviceId: GATEWAY_ID });
  gateway.handlers["agents.list"] = () => ({
    defaultId: "marlow",
    agents: [
      { id: "marlow", identity: { name: "Marlow" } },
      { id: "otto", identity: { name: "Otto" } },
      { id: "quill", identity: { name: "Quill" } },
      { id: "wren", identity: { name: "Wren" } },
    ],
  });
  const now = Date.now();
  const sessions = [
    { key: "agent:marlow:main", agentId: "marlow", label: "Intro review", updatedAt: now },
    { key: "agent:otto:main", agentId: "otto", label: "Release notes", updatedAt: now - 1000 },
    { key: "agent:wren:main", agentId: "wren", label: "Older notes", updatedAt: now - 3000 },
    {
      key: "agent:wren:review",
      agentId: "wren",
      label: "Newer review",
      updatedAt: now - 2000,
      unread: true,
      markedUnreadAt: now - 2000,
    },
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
    /** Delete a chat, as another device would. */
    remove(key: string) {
      const index = sessions.findIndex((each) => each.key === key);
      const [gone] = sessions.splice(index, 1);
      gateway.emit("sessions.changed", {
        sessionKey: key,
        agentId: gone!.agentId,
        reason: "deleted",
      });
    },
    async close() {
      for (const peer of server.clients) peer.terminate();
      const closed = once(server, "close");
      server.close();
      await closed;
    },
  };
}
