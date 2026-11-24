// The real update check's decisions, apart from the Mac they run on, so unit tests can run them
// (test/real-update-verdict.test.ts). check.ts and summary.ts use them on the hosted job.

/** An image's answer. `inconclusive`: the run couldn't test the candidate it was given. */
export type Verdict = "passed" | "failed" | "inconclusive";

/**
 * Whether the feed's offer is the candidate this run checks. The app reads the live feed itself,
 * so a release published while the run goes, or a candidate the feed no longer offers, makes the
 * offer differ: the check then can't say whether the candidate updates in place, which is
 * inconclusive, never a pass and never a failure.
 */
export function offerVerdict(
  offered: string,
  expected: string | undefined,
): { verdict: "proceed" } | { verdict: "inconclusive"; reason: string } {
  if (!expected || offered === expected) return { verdict: "proceed" };
  return { verdict: "inconclusive", reason: `offered ${offered}, expected ${expected}` };
}

/** The time left until `deadline` (from `Date.now()`), never below zero. */
export function remaining(deadline: number, now = Date.now()): number {
  return Math.max(0, deadline - now);
}

/**
 * Settles with `work`, or rejects once `ms` pass without an answer; `abandon` then runs, so the
 * caller can drop what it was waiting on. The timer never outlives the call.
 */
export async function withinLimit<T>(
  what: string,
  ms: number,
  work: Promise<T>,
  abandon: () => void = () => {},
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abandon();
      reject(new Error(`no answer within ${ms} ms to ${what}`));
    }, ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** What an image's result.json says, as far as the summary needs it. */
export interface ImageResult {
  verdict?: Verdict;
  outcome?: string;
  error?: string;
  system?: string;
  offeredVersion?: string;
  installedVersion?: string;
  downloaded?: { install?: unknown };
}

export interface ImageSummary {
  verdict: Verdict;
  passed: boolean;
  outcome: string;
  system: string | null;
  offered: string | null;
  installed: string | null;
  install: unknown;
}

export interface Summary {
  previous: string;
  candidate: string;
  verdict: Verdict;
  passed: boolean;
  images: Record<string, ImageSummary>;
}

/** One image's line in the summary. A missing or unreadable result is a failure. */
export function summarizeImage(result: ImageResult | null): ImageSummary {
  const verdict: Verdict =
    result?.verdict === "passed" || result?.verdict === "inconclusive" ? result.verdict : "failed";
  return {
    verdict,
    passed: verdict === "passed",
    outcome: result?.outcome ?? result?.error ?? "no result",
    system: /ProductVersion:\s*(\S+)/.exec(result?.system ?? "")?.[1] ?? null,
    offered: result?.offeredVersion ?? null,
    installed: result?.installedVersion ?? null,
    install: result?.downloaded?.install ?? {},
  };
}

/**
 * The run's answer: failed if any image failed, else inconclusive if any was, else passed. The
 * summary job exits non-zero only for failed.
 */
export function summarize(
  previous: string,
  candidate: string,
  results: Record<string, ImageResult | null>,
): Summary {
  const images = Object.fromEntries(
    Object.entries(results).map(([image, result]) => [image, summarizeImage(result)]),
  );
  const verdicts = Object.values(images).map((each) => each.verdict);
  const verdict: Verdict =
    verdicts.length === 0 || verdicts.includes("failed")
      ? "failed"
      : verdicts.includes("inconclusive")
        ? "inconclusive"
        : "passed";
  return { previous, candidate, verdict, passed: verdict === "passed", images };
}

/** The step summary: the run's answer, then one line per image. */
export function summaryMarkdown(summary: Summary): string {
  const word = { passed: "passed", failed: "FAILED", inconclusive: "inconclusive" }[
    summary.verdict
  ];
  return [
    `Real update ${summary.previous} to ${summary.candidate}: ${word}`,
    "",
    ...Object.entries(summary.images).map(
      ([image, each]) =>
        `- ${image} (${each.system ?? "unknown macOS"}): ${each.verdict}, ${each.outcome}`,
    ),
    "",
  ].join("\n");
}
