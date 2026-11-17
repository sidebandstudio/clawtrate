import {
  createRemoteBridge,
  type AttachmentInfo,
  type ClawtrateBridge,
  type WebSocketLike,
} from "@clawtrate/core";

/**
 * Bridge over a WebSocket to the web preview host. The host keeps the gateway
 * connection and the device key; the browser only sees state and sends commands.
 */
export function createWebBridge(): Promise<ClawtrateBridge> {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${scheme}//${location.host}/bridge`;
  return createRemoteBridge({
    // The browser socket has every member the bridge uses; its handler types are only narrower.
    open: () => new WebSocket(url) as unknown as WebSocketLike,
    async attach(file) {
      // Files go on their own path; the bridge socket carries only small frames.
      const query = new URLSearchParams({
        name: file.name,
        type: file.type || "application/octet-stream",
      });
      const response = await fetch(`/attachments?${query}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/octet-stream" },
        body: file.data,
      });
      const body = (await response.json()) as AttachmentInfo | { error: string };
      if (!response.ok || "error" in body) {
        throw new Error("error" in body ? body.error : `Upload failed (${response.status})`);
      }
      return body;
    },
  });
}
