// The parse worker: the lexer, `json5` and the extraction rules run here,
// under the reader's resource limits and deadline (settings-reader.ts).

import { parentPort, workerData } from "node:worker_threads";
import { extractSettings } from "./settings-extract.ts";

const { text, profile } = workerData as { text: string; profile: "default" | "clawtrate" };
parentPort?.postMessage(extractSettings(text, profile));
