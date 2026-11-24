// The Real update workflow's summary job (.github/workflows/real-update.yml):
//
//   node e2e-packaged/real-update/summary.ts <results folder> <image>...
//
// Reads <results>/real-update-<image>/result.json for each image, writes
// real-update-summary.json and the step summary, and exits 1 only when the run failed: a pass
// and an inconclusive run both exit 0, and the JSON's `verdict` says which; an inconclusive run
// also prints a warning annotation.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { summarize, summaryMarkdown, type ImageResult } from "./verdict.ts";

const [folder, ...images] = process.argv.slice(2);
if (!folder || images.length === 0) throw new Error("usage: summary.ts <results> <image>...");
const read = (image: string): ImageResult | null => {
  try {
    return JSON.parse(
      readFileSync(join(folder, `real-update-${image}`, "result.json"), "utf8"),
    ) as ImageResult;
  } catch {
    return null;
  }
};
const summary = summarize(
  process.env.PREVIOUS ?? "",
  process.env.CANDIDATE ?? "",
  Object.fromEntries(images.map((image) => [image, read(image)])),
);
writeFileSync("real-update-summary.json", JSON.stringify(summary, null, 2) + "\n");
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(summary));
console.log(JSON.stringify(summary, null, 2));
// A green run that isn't a pass says so on the run's page.
if (summary.verdict === "inconclusive")
  console.log(
    `::warning title=Real update inconclusive::The feed offered a newer release than ${summary.candidate}, so it was not tested. Read verdict in real-update-summary.json.`,
  );
process.exitCode = summary.verdict === "failed" ? 1 : 0;
