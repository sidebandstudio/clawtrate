// Electron's fs reads any file whose name ends in .asar as a folder of its contents. An
// update tree can hold one: the inspection helper unpacks the downloaded Clawtrate.app,
// with its Contents/Resources/app.asar, to check it. A recursive remove through Electron's
// fs then descends into that archive and fails with ENOTEMPTY (#383). The update code
// removes its folders through Electron's original-fs instead, which is Node's own and
// treats an .asar as the file it is. Outside Electron, in unit tests, that is node:fs.

import { createRequire } from "node:module";
import type * as FileSystem from "node:fs";

const require = createRequire(import.meta.url);
const plain = (
  process.versions.electron ? require("original-fs") : require("node:fs")
) as typeof FileSystem;

/** `rm` that never reads an .asar file as a folder. */
export const rm = plain.promises.rm;
