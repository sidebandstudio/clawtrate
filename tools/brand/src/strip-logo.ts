// Removes provenance, text and camera metadata chunks from the logo in place.
//
//   node tools/brand/src/strip-logo.ts      (or: pnpm brand:strip)
//
// Run it after replacing assets/brand/logo.png, then `pnpm brand:icons`.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LOGO_PATH } from "./make-icons.ts";
import { listChunks, METADATA_CHUNKS, stripMetadataChunks } from "./png.ts";

function main(): void {
  const before = readFileSync(LOGO_PATH);
  const found = listChunks(before).filter((type) =>
    (METADATA_CHUNKS as readonly string[]).includes(type),
  );
  if (found.length === 0) {
    console.log("The logo has no metadata chunks.");
    return;
  }
  writeFileSync(LOGO_PATH, stripMetadataChunks(before));
  console.log(`Removed ${found.join(", ")} from the logo. Now run \`pnpm brand:icons\`.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
