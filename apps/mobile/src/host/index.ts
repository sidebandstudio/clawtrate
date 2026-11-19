// The iOS host: what `packages/core/src/host.ts` asks for, from React Native
// and Expo's native modules. The same core runs here as in Electron and Node.

import type { ClawtrateHost } from "@clawtrate/core";
import { getRandomBytes, randomUUID } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Settings } from "react-native";
import { approvalInstructionsFor, devGatewayHint, type DevGatewayHint } from "./dev-gateway.ts";
import { createSocketFactory, type WebSocketConstructor } from "./socket.ts";
import { createKeychainSigner } from "./signer.ts";
import { createKeychainStore } from "./store.ts";
import { createSecrets, learningStore, type Secrets } from "./secrets.ts";

export const APP_VERSION = "0.1.0";
/** The name this device gives the gateway when it pairs. */
export const DEVICE_NAME = "Clawtrate iPhone";

export type IosHost = {
  host: ClawtrateHost;
  devGateway: DevGatewayHint | null;
  secrets: Secrets;
};

export function createIosHost(): IosHost {
  const accessible = SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY;
  const devGateway = devGatewayHint((key) => Settings.get(key));
  const secrets = createSecrets();
  return {
    devGateway,
    secrets,
    host: {
      createWebSocket: createSocketFactory(WebSocket as unknown as WebSocketConstructor),
      storage: learningStore(createKeychainStore(SecureStore, accessible), secrets),
      signer: createKeychainSigner(SecureStore, accessible, getRandomBytes),
      client: { displayName: DEVICE_NAME, version: APP_VERSION, platform: "ios" },
      randomId: randomUUID,
      approvalInstructions: approvalInstructionsFor(devGateway),
      log: (level, message) => {
        // Only problems reach the console, and never a credential the gateway sent back.
        if (level === "warn" || level === "error")
          console[level](`[core] ${secrets.redact(message)}`);
      },
    },
  };
}
