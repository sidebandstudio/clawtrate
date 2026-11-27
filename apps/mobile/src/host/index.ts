// The iOS host: what `packages/core/src/host.ts` asks for, from React Native
// and Expo's native modules. The same core runs here as in Electron and Node.

import type { ClawtrateHost } from "@clawtrate/core";
import { requireNativeModule } from "expo";
import { getRandomBytes, randomUUID } from "expo-crypto";
import { Directory, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { Settings, Share } from "react-native";
import { approvalInstructionsFor, devGatewayHint, type DevGatewayHint } from "./dev-gateway.ts";
import { createHostFetch, type NativeFetch } from "./fetch.ts";
import { createSocketFactory, type WebSocketConstructor } from "./socket.ts";
import { createKeychainSigner } from "./signer.ts";
import { createKeychainStore } from "./store.ts";
import { createSecrets, learningStore, type Secrets } from "./secrets.ts";
import { createShareFile, type ShareFile, type ShareSystem } from "./share.ts";

export const APP_VERSION = "0.1.0";
/** The name this device gives the gateway when it pairs. */
export const DEVICE_NAME = "Clawtrate iPhone";

/**
 * A mark in the app's user defaults, which iOS deletes with the app; the
 * Keychain is not deleted with it. A saved gateway found without the mark was
 * saved by an earlier install, so the app asks before it reconnects to it.
 */
export const INSTALL_MARK = "ClawtrateInstalled";

export type IosHost = {
  host: ClawtrateHost;
  devGateway: DevGatewayHint | null;
  secrets: Secrets;
  /** This install has run before: a saved gateway is its own choice. */
  installedBefore: boolean;
  markInstalled: () => void;
  /** Offer a file a bot handed over in the share sheet (F-115). */
  shareFile: ShareFile;
};

/** The app's own folder in its cache for files offered to the share sheet: nothing else is in it. */
const SHARE_FOLDER = "clawtrate-share";

/**
 * The share sheet over a folder of the app's own in its cache (`expo-file-system`), each file in
 * a folder of its own so two names never meet. React Native's `Share` takes a file address on
 * iOS and settles once the sheet closes, with the activity chosen, if any.
 */
function iosShareSystem(): ShareSystem {
  const root = () => new Directory(Paths.cache, SHARE_FOLDER);
  return {
    clear: () => {
      const folder = root();
      if (folder.exists) folder.delete();
    },
    folder: () => {
      const parent = root();
      parent.create({ intermediates: true, idempotent: true });
      const folder = parent.createDirectory(randomUUID());
      return {
        write: async (name, bytes) => {
          const file = folder.createFile(name, null);
          await file.write(bytes);
          return file.uri;
        },
        remove: () => folder.delete(),
      };
    },
    sheet: async (uri) => {
      const closed = await Share.share({ url: uri });
      return {
        completed: closed.action === Share.sharedAction,
        activityType: closed.action === Share.sharedAction ? (closed.activityType ?? null) : null,
      };
    },
  };
}

export function createIosHost(): IosHost {
  const accessible = SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY;
  const devGateway = devGatewayHint((key) => Settings.get(key));
  const secrets = createSecrets();
  return {
    devGateway,
    secrets,
    installedBefore: Settings.get(INSTALL_MARK) === "1",
    markInstalled: () => Settings.set({ [INSTALL_MARK]: "1" }),
    shareFile: createShareFile(iosShareSystem()),
    host: {
      createWebSocket: createSocketFactory(WebSocket as unknown as WebSocketConstructor),
      storage: learningStore(createKeychainStore(SecureStore, accessible), secrets),
      signer: createKeychainSigner(SecureStore, accessible, getRandomBytes),
      client: { displayName: DEVICE_NAME, version: APP_VERSION, platform: "ios" },
      randomId: randomUUID,
      approvalInstructions: approvalInstructionsFor(devGateway),
      fetch: createHostFetch(requireNativeModule<NativeFetch>("ClawtrateFetch")),
      log: (level, message) => {
        // Only problems reach the console, and never a credential the gateway sent back.
        if (level === "warn" || level === "error")
          console[level](`[core] ${secrets.redact(message)}`);
      },
    },
  };
}
