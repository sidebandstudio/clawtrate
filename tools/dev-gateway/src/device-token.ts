// Whether a gateway admits a device with a given device token: a connection as
// that device (its own key) with that token and no shared token, as a paired
// client connects. For checks that a re-pairing replaced a device's
// authorization, or kept it.

import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { GatewayClient } from "@openclaw/gateway-client";

export async function admitsDeviceToken(options: {
  url: string;
  /** The device's Ed25519 private key, PEM. */
  privateKeyPem: string;
  token: string;
  clientName: string;
  mode: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const publicKey = createPublicKey(createPrivateKey(options.privateKeyPem));
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const identity = {
    deviceId: createHash("sha256").update(raw).digest("hex"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: options.privateKeyPem,
  };
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (admitted: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void client.stopAndWait().catch(() => {});
      resolve(admitted);
    };
    const timer = setTimeout(() => settle(false), options.timeoutMs ?? 20_000);
    const client: GatewayClient = new GatewayClient({
      url: options.url,
      clientName: options.clientName,
      mode: options.mode,
      clientDisplayName: "Clawtrate device-token check",
      clientVersion: "0.0.0",
      platform: process.platform,
      role: "operator",
      scopes: ["operator.read"],
      caps: [],
      minProtocol: 4,
      maxProtocol: 4,
      deviceIdentity: identity,
      hostDeps: {
        signDevicePayload: (pem: string, payload: string) =>
          sign(null, Buffer.from(payload), createPrivateKey(pem)).toString("base64url"),
        publicKeyRawBase64UrlFromPem: (pem: string) =>
          createPublicKey(pem)
            .export({ type: "spki", format: "der" })
            .subarray(-32)
            .toString("base64url"),
        loadDeviceAuthToken: () => ({ token: options.token, scopes: ["operator.read"] }),
        storeDeviceAuthToken: () => {},
        clearDeviceAuthToken: () => {},
      },
      onConnectError: () => settle(false),
      onReconnectPaused: () => settle(false),
      onHelloOk: () => settle(true),
    } as ConstructorParameters<typeof GatewayClient>[0]);
    client.start();
  });
}
