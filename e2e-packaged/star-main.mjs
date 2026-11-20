// Development Electron test entry. Only this process sees the synthetic installation.
import { app, shell } from "electron";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = fs.realpathSync(process.env.CLAWTRATE_STAR_TEST_DIR);
const desktop = join(import.meta.dirname, "../apps/desktop");
app.setAppPath(desktop);
const listed = "/opt/homebrew/bin/gh";
const localLink = join(root, "gh");
const standIn = fs.realpathSync(localLink);
const { lstatSync, readlinkSync } = fs;
fs.lstatSync = (path, ...options) => {
  if (path === listed) return lstatSync(localLink, ...options);
  if (["/opt", "/opt/homebrew", "/opt/homebrew/bin"].includes(path))
    return lstatSync(root, ...options);
  return lstatSync(path, ...options);
};
fs.readlinkSync = (path, ...options) =>
  readlinkSync(path === listed ? localLink : path, ...options);
const spawn = childProcess.spawn;
childProcess.spawn = (file, ...options) => {
  if (file !== standIn) throw new Error("Only the test executable can run");
  return spawn(file, ...options);
};
syncBuiltinESMExports();
shell.openExternal = async (url) => {
  fs.appendFileSync(join(root, "opened"), url + "\n");
  if (fs.existsSync(join(root, "refuse"))) throw new Error("Test opener refused");
};
await import(pathToFileURL(join(desktop, "out/main/index.js")));
