// Give Electron its normal connected sidebar using the in-memory gateway's sample replies.
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { FakeGateway } from "../../../../packages/core/test/fake-gateway.ts";

export async function sidebarGateway() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const url = "ws://127.0.0.1:" + (server.address() as AddressInfo).port;
  const gateway = new FakeGateway();
  server.on("connection", (peer) => {
    const socket = gateway.createWebSocket(url);
    socket.onmessage = ({ data }) => {
      if (typeof data !== "string") throw new Error("Expected a gateway text frame");
      peer.send(data);
    };
    peer.on("message", (data) => socket.send(data.toString()));
    peer.on("close", () => socket.close());
  });
  return {
    url,
    async close() {
      for (const peer of server.clients) peer.terminate();
      const closed = once(server, "close");
      server.close();
      await closed;
    },
  };
}
