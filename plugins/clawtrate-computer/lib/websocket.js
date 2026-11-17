// The server side of the stream's WebSocket (RFC 6455), with no
// dependencies. A viewer only receives; the only frames it may send are
// control frames (close, ping, pong), each at most 125 bytes and masked.

import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Answer a WebSocket upgrade request, or return false when it is not one. */
export function acceptUpgrade(req, socket) {
  const key = req.headers?.["sec-websocket-key"];
  const upgrade = String(req.headers?.upgrade ?? "").toLowerCase();
  if (upgrade !== "websocket" || typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
    return false;
  }
  if (String(req.headers?.["sec-websocket-version"] ?? "13") !== "13") return false;
  const accept = createHash("sha1")
    .update(key + GUID)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return true;
}

/** Refuse an upgrade with a plain HTTP status and end the socket. */
export function refuseUpgrade(socket, status, text) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** One unmasked server frame. */
export function frame(opcode, payload) {
  const length = payload.length;
  let head;
  if (length < 126) {
    head = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([head, payload]);
}

export const textFrame = (value) => frame(0x1, Buffer.from(JSON.stringify(value)));
export const binaryFrame = (bytes) => frame(0x2, bytes);
export function closeFrame(code, reason) {
  const text = Buffer.from(String(reason).slice(0, 100));
  const body = Buffer.alloc(2 + text.length);
  body.writeUInt16BE(code, 0);
  text.copy(body, 2);
  return frame(0x8, body);
}

/**
 * Reads the frames a viewer sends. `onFrame({opcode, payload})` gets each
 * complete control frame; any data frame, unmasked frame, fragment or
 * oversized frame is reported to `onError(code, reason)` once.
 */
export function frameReader(onFrame, onError) {
  let buffer = Buffer.alloc(0);
  let failed = false;
  const fail = (code, reason) => {
    if (failed) return;
    failed = true;
    buffer = Buffer.alloc(0);
    onError(code, reason);
  };
  return (chunk) => {
    if (failed) return;
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      const length = buffer[1] & 0x7f;
      if (!masked) return fail(1002, "unmasked frame");
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) return fail(1003, "view_only");
      if (![0x8, 0x9, 0xa].includes(opcode)) return fail(1002, "unknown opcode");
      if (!fin || length > 125) return fail(1002, "bad control frame");
      if (buffer.length < 6 + length) return;
      const mask = buffer.subarray(2, 6);
      const payload = Buffer.from(buffer.subarray(6, 6 + length));
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(6 + length);
      onFrame({ opcode, payload });
    }
  };
}
