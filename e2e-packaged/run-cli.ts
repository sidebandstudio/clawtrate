import { pathToFileURL } from "node:url";

export async function runCli(args: string[]) {
  process.argv = [process.execPath, ...args];
  await import(pathToFileURL(args[0]!).href);
}
