// Writes the update feed for the artifacts in apps/desktop/dist. It uploads
// nothing: the owner publishes the feed and the files on one HTTPS host.
//
//   node packaging/feed.ts https://updates.example/clawtrate/
//
// The feed names each artifact of this version that exists in dist (the macOS
// zips and the Windows installer) at the given folder, with its size and
// SHA-512, and the release date from SOURCE_DATE_EPOCH or now. Give the build
// the same SOURCE_DATE_EPOCH. docs/decisions.md, "Updates and release
// signing", has the format.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAddressProblem } from "../src/main/update/address.ts";
import { FEED_FORMAT, FILE_EXTENSION, FILE_KEYS, type FileKey } from "../src/main/update/feed.ts";
import { PRODUCT_NAME } from "./config.ts";
import { releaseDate, type Env } from "./update-defines.ts";

export interface FeedDocument {
  format: number;
  version: string;
  releaseDate: string;
  files: Partial<Record<FileKey, { url: string; size: number; sha512: string }>>;
}

/** The artifact's file name, as `artifactName` in config.ts makes it. */
export function artifactName(version: string, key: FileKey): string {
  return `${PRODUCT_NAME}-${version}-${key}.${FILE_EXTENSION[key]}`;
}

export function sha512Base64(path: string): string {
  return createHash("sha512").update(readFileSync(path)).digest("base64");
}

/** The feed for the artifacts of `version` found in `dir`, served from `folder`. */
export function makeFeed(options: {
  version: string;
  releaseDate: string;
  folder: string;
  dir: string;
}): FeedDocument {
  const base = new URL(options.folder);
  base.search = "";
  base.hash = "";
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const files: FeedDocument["files"] = {};
  for (const key of FILE_KEYS) {
    const name = artifactName(options.version, key);
    const path = join(options.dir, name);
    if (!existsSync(path)) continue;
    const artifact = statSync(path);
    if (!artifact.isFile() || artifact.size === 0) {
      throw new Error(`${key} must be a non-empty artifact.`);
    }
    files[key] = {
      url: new URL(encodeURIComponent(name), base).href,
      size: artifact.size,
      sha512: sha512Base64(path),
    };
  }
  return { format: FEED_FORMAT, version: options.version, releaseDate: options.releaseDate, files };
}

function main(argv: string[], env: Env): void {
  const folder = argv[0];
  const problem = folder ? buildAddressProblem(folder) : "is missing";
  if (!folder || problem) {
    console.error(
      `usage: node packaging/feed.ts <https address of the folder> (the address ${problem})`,
    );
    process.exit(2);
  }
  const appDir = join(import.meta.dirname, "..");
  const { version } = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as {
    version: string;
  };
  const dir = join(appDir, "dist");
  const feed = makeFeed({ version, releaseDate: releaseDate(env, new Date()), folder, dir });
  if (Object.keys(feed.files).length === 0) {
    console.error(
      `No artifacts of ${version} in dist. Run pnpm package:mac or pnpm package:win first.`,
    );
    process.exit(1);
  }
  const out = join(dir, "update-feed.json");
  writeFileSync(out, `${JSON.stringify(feed, null, 2)}\n`);
  console.log(`${out}: ${Object.keys(feed.files).join(", ")}`);
}

if (import.meta.main) main(process.argv.slice(2), process.env);
