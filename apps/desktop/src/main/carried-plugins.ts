// Where the app finds the OpenClaw plugins it carries (packaging/carried-plugins.ts
// packs them; issue #796). Nothing installs them yet.
//
// The list is built into the app's archive, so the signed app vouches for it on
// both platforms. Each tarball sits under the app's resources, outside the
// archive, because the gateway reads it with plain Node, which can't read
// inside an Electron archive. What the gateway stages from it is compared with
// the list's integrity before anything is enabled.

import { join } from "node:path";

/** Where packing writes the tarballs and the list, under apps/desktop. */
export const CARRIED_BUILD_DIR = "out/plugins";
/** The tarballs' folder under the packaged app's resources (`process.resourcesPath`). */
export const CARRIED_RESOURCES_DIR = "plugins";
export const CARRIED_LIST_NAME = "plugins.json";

/** What `plugins.inspect` reports as `declared`, group by group, each sorted. */
export type DeclaredSurface = {
  channels: string[];
  providers: string[];
  tools: string[];
  contracts: string[];
  hooks: string[];
  mcpServers: string[];
  cliCommands: string[];
  cliBackends: string[];
  skills: string[];
  dangerousConfigFlags: string[];
};

export type CarriedPlugin = {
  /** The package name, `@clawtrate/<plugin id>`. */
  name: string;
  /** Its exact version. */
  version: string;
  pluginId: string;
  /** The tarball's `sha512-…`, as `plugins.inspect` reports `source.integrity`. */
  integrity: string;
  /** The tarball's file name in the carried folder. */
  file: string;
  declared: DeclaredSurface;
};

export type CarriedList = { plugins: CarriedPlugin[] };

export type AppPlaces = {
  /** `app.isPackaged`. */
  packaged: boolean;
  /** `app.getAppPath()`: apps/desktop in development, the archive when packaged. */
  appPath: string;
  /** `process.resourcesPath`. */
  resourcesPath: string;
};

/**
 * The list's path and each tarball's folder. A development build reads both
 * from apps/desktop/out/plugins, written by `carried-plugins.ts pack`; a
 * packaged app reads the list from its archive and the tarballs from its
 * resources.
 */
export function carriedPlaces({ packaged, appPath, resourcesPath }: AppPlaces): {
  list: string;
  tarballs: string;
} {
  return {
    list: join(appPath, CARRIED_BUILD_DIR, CARRIED_LIST_NAME),
    tarballs: packaged
      ? join(resourcesPath, CARRIED_RESOURCES_DIR)
      : join(appPath, CARRIED_BUILD_DIR),
  };
}
