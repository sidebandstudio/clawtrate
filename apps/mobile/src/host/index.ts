// The iOS host: what `packages/core/src/host.ts` asks for, from React Native
// and Expo's native modules. The same core runs here as in Electron and Node.

import type { ClawtrateHost } from "@clawtrate/core";
import { requireNativeModule } from "expo";
import { getRandomBytes, randomUUID } from "expo-crypto";
import { Directory, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { Settings } from "react-native";
import { approvalInstructionsFor, devGatewayHint, type DevGatewayHint } from "./dev-gateway.ts";
import { createHostFetch, type NativeFetch } from "./fetch.ts";
import { createSocketFactory, type WebSocketConstructor } from "./socket.ts";
import { createKeychainSigner } from "./signer.ts";
import { createKeychainStore } from "./store.ts";
import { createSecrets, learningStore, type Secrets } from "./secrets.ts";
import { createSharing, type ShareFile, type SheetEnd, type ShareSystem } from "./share.ts";

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

/** What modules/clawtrate-share gives JavaScript: the sheet for one file, settled exactly once. */
type NativeShare = {
  share(id: string, uri: string): Promise<{ end: SheetEnd["end"]; activityType: string }>;
  cancel(id: string): Promise<void>;
};

/**
 * The share sheet over a folder of the app's own in its cache (`expo-file-system`), each file in
 * a folder of its own so two names never meet. The sheet is the app's own native module, which
 * settles every way the sheet ends (modules/clawtrate-share).
 */
function iosShareSystem(native: NativeShare): ShareSystem {
  const root = () => new Directory(Paths.cache, SHARE_FOLDER);
  return {
    newName: randomUUID,
    list: () => {
      const parent = root();
      return parent.exists ? parent.list().map((each) => each.name) : [];
    },
    write: async (folder, name, bytes) => {
      const parent = root();
      parent.create({ intermediates: true, idempotent: true });
      const file = parent.createDirectory(folder).createFile(name, null);
      await file.write(bytes);
      return file.uri;
    },
    remove: (folder) => {
      const each = new Directory(root(), folder);
      if (each.exists) each.delete();
    },
    sheet: async (id, uri) => {
      const { end, activityType } = await native.share(id, uri);
      if (end === "completed" || end === "dismissed")
        return { end, activityType: activityType || null };
      return { end } as SheetEnd;
    },
    cancel: (id) => void native.cancel(id).catch(() => {}),
    later: (work) => void setTimeout(work, 2_000),
  };
}

export function createIosHost(): IosHost {
  const accessible = SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY;
  const devGateway = devGatewayHint((key) => Settings.get(key));
  const secrets = createSecrets();
  const sharing = createSharing(iosShareSystem(requireNativeModule<NativeShare>("ClawtrateShare")));
  // What a run closed with the sheet open, or a delete that failed, left: gone before anything else.
  sharing.sweep();
  return {
    devGateway,
    secrets,
    installedBefore: Settings.get(INSTALL_MARK) === "1",
    markInstalled: () => Settings.set({ [INSTALL_MARK]: "1" }),
    shareFile: sharing.share,
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
