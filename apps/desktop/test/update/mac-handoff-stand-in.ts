// Exercise the loopback transfer with a local reader. Electron's ShipIt request
// cannot carry the archive proof through installation, so this stays in tests.
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { open } from "node:fs/promises";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { VerifiedArtifact } from "../../src/main/update/install.ts";

export async function stageAtLoopback(
  file: VerifiedArtifact,
  stage: (url: string) => Promise<void>,
) {
  const handle = await open(file.path, "r");
  try {
    const body = Buffer.alloc(file.size);
    if ((await handle.stat()).size !== body.length) throw Error("Changed length");
    let offset = 0;
    while (offset < body.length) {
      const { bytesRead } = await handle.read(body, offset, body.length - offset);
      if (!bytesRead) throw Error("Short archive");
      offset += bytesRead;
    }
    if (createHash("sha512").update(body).digest("base64") !== file.sha512)
      throw Error("Changed bytes");
    const prefix = "/" + randomUUID();
    const sha256 = createHash("sha256").update(body).digest("hex");
    const listener = createServer((req, res) => {
      if (req.method === "GET" && req.url === prefix + "/feed")
        res.end(JSON.stringify({ url: origin + prefix + "/archive", size: body.length, sha256 }));
      else if (req.method === "GET" && req.url === prefix + "/archive") res.end(body);
      else res.writeHead(404).end();
    });
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const origin = "http://127.0.0.1:" + (listener.address() as AddressInfo).port;
    try {
      await stage(origin + prefix + "/feed");
    } finally {
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  } finally {
    await handle.close();
  }
}
