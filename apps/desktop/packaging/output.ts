// Where electron-builder writes a build: `apps/desktop/dist` for ordinary
// packaging and candidates, or, for a beta release, an absolute folder inside
// that release's private signing folder, which no other entry point writes to.
// A beta never writes to or removes anything in `apps/desktop/dist`.

import { isAbsolute, join } from "node:path";

export const OUTPUT_VARIABLE = "CLAWTRATE_PACKAGE_OUTPUT";

export interface PackageOutput {
  /** The folder itself. */
  readonly path: string;
  /** The directory given to electron-builder and named in its signature checks. */
  readonly label: string;
}

/** The output folder for `appDir` under `env`; a set variable must be an absolute path. */
export function packageOutput(
  env: Record<string, string | undefined>,
  appDir = join(import.meta.dirname, ".."),
): PackageOutput {
  const given = env[OUTPUT_VARIABLE]?.trim();
  if (!given) return { path: join(appDir, "dist"), label: "dist" };
  if (!isAbsolute(given)) throw new Error(`${OUTPUT_VARIABLE} must be an absolute path.`);
  return { path: given, label: given };
}
