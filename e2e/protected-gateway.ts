// A protected address for this run's development gateway (#469):
// `wss://gateway.clawtrate.test:<port>`, a TLS proxy of the test's own in front
// of the gateway's loopback port, with a throwaway self-signed certificate that
// `openssl` makes in a temporary folder. A host given `env` resolves that name
// to loopback and trusts that certificate, and nothing else changes in it: the
// product's own rule sees an address that is `wss://` and not loopback.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:tls";
import { pathToFileURL } from "node:url";
import { PROTECTED_HOST } from "./protected-gateway-preload.ts";

export async function protectedGateway(gatewayPort: number) {
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-protected-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      ...["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1"],
      ...["-keyout", key, "-out", cert, "-subj", `/CN=${PROTECTED_HOST}`],
      ...["-addext", `subjectAltName=DNS:${PROTECTED_HOST}`],
    ],
    { stdio: "ignore" },
  );
  const sockets = new Set<Socket>();
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (socket) => {
    const upstream = connect(gatewayPort, "127.0.0.1");
    for (const each of [socket, upstream]) {
      sockets.add(each);
      each.on("close", () => sockets.delete(each));
      each.on("error", () => {
        socket.destroy();
        upstream.destroy();
      });
    }
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const preload = join(import.meta.dirname, "protected-gateway-preload.ts");
  return {
    url: `wss://${PROTECTED_HOST}:${port}`,
    /** The test's own name resolution and certificate, for the host it is given to alone. */
    env: {
      NODE_EXTRA_CA_CERTS: cert,
      // A file URL, so a checkout path with a space stays one option.
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`.trim(),
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
