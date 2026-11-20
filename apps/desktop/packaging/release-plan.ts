import { artifactFormat } from "./candidate-format.ts";
import { feedAddresses, localFeedAddress } from "./candidate-addresses.ts";
import { lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MAX_DOWNLOAD_BYTES, MAX_FEED_BYTES } from "../src/main/update/engine.ts";
import {
  FEED_FORMAT,
  FILE_KEYS,
  parseFeed,
  parseReleaseDate,
  type FileKey,
} from "../src/main/update/feed.ts";
import { isNewer, parseVersion, versionTrack } from "../src/main/update/version.ts";
import { artifactName, makeFeed, sha512Base64 } from "./feed.ts";

function fullCommit(commit: string) {
  return /^[0-9a-f]{40}$/.test(commit) && commit.length === 40;
}

export interface Candidate {
  dir: string;
  track: string;
  version: string;
  commit: string;
  buildDate: string;
  feedUrl: string;
  otherFeedUrl?: string;
  currentFeed?: string;
  otherFeed?: string;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function json(path: string) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > MAX_FEED_BYTES) return {};
  try {
    return object(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

const ownerChecks =
  "This plan does not establish that the files may be published. Signing, notarization and updating in place are verified by the owner on each system, as the runbook says.";
export function plan(candidate: Candidate) {
  const { dir, track, version, commit, buildDate, feedUrl } = candidate;
  const parsed = parseVersion(version);
  const issues: string[] = [];
  const files = [];
  const validTrack = track === "stable" || track === "nightly";
  const validCommit = fullCommit(commit);
  const validDate = parseReleaseDate(buildDate) === buildDate;
  if (!validTrack || !parsed || versionTrack(parsed) !== track)
    issues.push("Version and track must match.");
  if (!validCommit) issues.push("Expected a full source commit.");
  if (!validDate) issues.push("Expected a UTC build date.");
  const address = localFeedAddress(feedUrl);
  const addresses = feedAddresses(track, feedUrl, candidate.otherFeedUrl);
  if (!addresses) issues.push("Expected distinct, canonical HTTPS feed addresses.");

  const compared: string[] = [];
  if (
    parsed?.length === 5 &&
    validDate &&
    String(parsed[3]) !== buildDate.slice(0, 10).replaceAll("-", "")
  )
    issues.push("Nightly version day differs from the UTC build date.");
  if (validTrack && parsed) {
    for (const [name, path, endpoint] of [
      [track, candidate.currentFeed, feedUrl],
      [track === "stable" ? "nightly" : "stable", candidate.otherFeed, candidate.otherFeedUrl],
    ] as const) {
      if (path === undefined) continue;
      const doc = json(path);
      // An unconfigured other track can still supply a local comparison file.
      const first = Object.values(object(doc.files))[0];
      const url = endpoint ?? object(first).url;
      const origin = typeof url === "string" ? localFeedAddress(url) : null;
      const previous = origin && parseFeed(JSON.stringify(doc), origin, null, undefined, name);
      if (!previous?.ok) {
        issues.push(name + ": invalid published comparison feed.");
        continue;
      }
      compared.push(name);
      if (doc.version === version) issues.push(name + ": feed already names this version.");
      else if (!isNewer(parsed, previous.feed.version))
        issues.push(name + ": candidate must be newer than the supplied release.");
    }
  }
  const comparison = compared.length
    ? "Compared with the supplied " + compared.join(" and ") + " feed."
    : "The version was not compared with any published release.";

  const allowed = new Set(["update-feed.json", "release-plan.json"]);
  const feed = json(join(dir, "update-feed.json"));
  if (feed.format !== FEED_FORMAT) issues.push("Missing or invalid feed format.");
  if (feed.track !== track) issues.push("Feed track differs.");
  if (feed.version !== version) issues.push("Feed version differs.");
  if (feed.sourceCommit !== commit) issues.push("Feed source commit differs.");
  if (feed.releaseDate !== buildDate) issues.push("Feed build date differs.");
  const entries = object(feed.files);
  if (Object.keys(entries).some((key) => !FILE_KEYS.some((expected) => expected === key)))
    issues.push("Feed contains an unexpected system.");

  for (const key of FILE_KEYS) {
    const receiptName = key + ".json";
    allowed.add(receiptName);
    const receipt = json(join(dir, receiptName));
    const hasReceipt = Object.keys(receipt).length > 0;
    const hashes = object(receipt.feedAddresses);
    if (
      hasReceipt &&
      (!addresses || hashes.stable !== addresses.stable || hashes.nightly !== addresses.nightly)
    )
      issues.push(key + ": feed address pair differs in the build record.");
    if (hasReceipt && receipt.commit !== commit)
      issues.push(key + ": missing or different source commit.");
    if (hasReceipt && receipt.buildDate !== buildDate)
      issues.push(key + ": missing or different build date.");
    if (!parsed) continue;
    const name = artifactName(version, key);
    allowed.add(name);
    const entry = object(entries[key]);
    const hasEntry = Object.keys(entry).length > 0;
    if (!hasEntry) issues.push(key + ": missing feed entry.");
    if (hasEntry && address && entry.url !== new URL(version + "/" + name, address).href)
      issues.push(key + ": address differs from the expected versioned file.");
    if (receipt.name !== name) issues.push(key + ": missing or wrong build receipt.");
    const path = join(dir, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      issues.push(key + ": missing regular file for this version.");
      continue;
    }
    const size = stat.size;
    if (!size || size > MAX_DOWNLOAD_BYTES)
      issues.push(key + ": artifact is empty or exceeds the download limit.");
    const sha512 = size <= MAX_DOWNLOAD_BYTES ? sha512Base64(path) : null;
    if (hasEntry && entry.size !== size) issues.push(key + ": feed size differs.");
    if (hasEntry && entry.sha512 !== sha512) issues.push(key + ": feed digest differs.");
    if (hasReceipt && receipt.sha512 !== sha512)
      issues.push(key + ": bytes differ from the build record.");
    const format = size > 0 && size <= MAX_DOWNLOAD_BYTES ? artifactFormat(key, path) : null;
    if (!format) issues.push(key + ": invalid artifact format or architecture.");
    files.push({ name, size, sha512, format, signing: "not checked by this plan" });
  }
  if (
    readdirSync(dir, { withFileTypes: true }).some(
      (file) => !file.isFile() || !allowed.has(file.name),
    )
  )
    issues.push("The candidate folder contains unexpected entries.");
  return {
    track: validTrack ? track : null,
    version: parsed ? version : null,
    commit: validCommit ? commit : null,
    buildDate: validDate ? buildDate : null,
    feedAddresses: addresses,
    files,
    verdict: issues.length ? "refused" : "complete and consistent",
    issues,
    ownerChecks,
    comparison,
  };
}

/** Assemble once. Rechecks read the retained feed without repairing it. */
export function assemble(candidate: Candidate) {
  const { dir, version, buildDate, commit, feedUrl } = candidate;
  if (
    !parseVersion(version) ||
    !fullCommit(commit) ||
    parseReleaseDate(buildDate) !== buildDate ||
    !feedAddresses(candidate.track, feedUrl, candidate.otherFeedUrl)
  )
    return;
  for (const key of FILE_KEYS) {
    const stat = lstatSync(join(dir, artifactName(version, key)), { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || !stat.size || stat.size > MAX_DOWNLOAD_BYTES)) return;
  }
  const feed = makeFeed({
    dir,
    version,
    releaseDate: buildDate,
    folder: new URL(version + "/", feedUrl).href,
  });
  writeFileSync(
    join(dir, "update-feed.json"),
    JSON.stringify({ ...feed, sourceCommit: commit }, null, 2) + "\n",
    { flag: "wx" },
  );
}

export function runPlan(args: string[], print = console.log) {
  const [
    mode,
    dir,
    track,
    version,
    commit,
    buildDate,
    feedUrl,
    otherFeedUrl,
    currentFeed,
    otherFeed,
  ] = args;
  if (
    !(mode === "assemble" || mode === "check") ||
    !dir ||
    !track ||
    !version ||
    !commit ||
    !buildDate ||
    !feedUrl ||
    args.length > 10
  ) {
    console.error(
      "Usage: release-plan.ts assemble|check DIR TRACK VERSION COMMIT ISO_DATE TRACK_URL [OTHER_URL|-] [CURRENT_FEED|-] [OTHER_FEED|-]",
    );
    return 1;
  }
  try {
    const candidate = {
      dir,
      track,
      version,
      commit,
      buildDate,
      feedUrl,
      ...(currentFeed && currentFeed !== "-" ? { currentFeed } : {}),
      ...(otherFeed && otherFeed !== "-" ? { otherFeed } : {}),
      ...(otherFeedUrl && otherFeedUrl !== "-" ? { otherFeedUrl } : {}),
    };
    if (mode === "assemble") assemble(candidate);
    const record = plan(candidate);
    const output = join(dir, "release-plan.json");
    writeFileSync(output + ".tmp", JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    renameSync(output + ".tmp", output);
    print(
      [record.track, record.version, record.verdict].join(" ") +
        "\n" +
        [record.ownerChecks, record.comparison, ...record.issues].join("\n"),
    );
    return record.issues.length ? 1 : 0;
  } catch {
    console.error("Could not read the candidate or write a fresh record.");
    return 1;
  }
}

if (import.meta.main) process.exitCode = runPlan(process.argv.slice(2));
