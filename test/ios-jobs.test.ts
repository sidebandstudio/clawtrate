// CI splits the iPhone Simulator checks across jobs by the lists in apps/mobile/simulator/jobs.ts
// (#415). A check in no list still runs, in the last job; one in two lists would run twice, and an
// entry that starts no check, or several, is a mistake.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JOBS,
  PAIRING,
  SUITE,
  jobPattern,
  jobProblems,
  startsOnItsOwn,
  unlisted,
} from "../apps/mobile/simulator/jobs.ts";
import { listVitest } from "./parity.ts";

const ROOT = join(import.meta.dirname, "..");
/** Collecting the one Simulator file takes seconds idle; leave room for a loaded machine. */
const LISTING = 240_000;

/** The checks a job's pattern selects, as Vitest matches it: against "<block> > <title>". */
const selected = (pattern: string, titles: readonly string[]) =>
  titles.filter((title) => new RegExp(pattern).test(`${SUITE} > ${title}`));

describe("the iOS job lists", () => {
  it(
    "name each Simulator check at most once and nothing else, and the jobs run each check once",
    async () => {
      const checks = await listVitest(ROOT, join(ROOT, "apps/mobile/simulator"));
      expect(checks.every((path) => path.length === 2 && path[0] === SUITE)).toBe(true);
      const titles = checks.map((path) => path[1]!);
      expect(titles.length).toBeGreaterThan(10);
      expect(jobProblems(titles)).toEqual([]);
      const left = unlisted(titles);
      // Not a failure: it runs in the last job until someone places it.
      if (left.length > 0)
        console.log(`In no list yet, so in the last iOS job: ${left.join("; ")}`);
      const runs = JOBS.flatMap((_, i) => selected(jobPattern(i + 1), titles));
      expect([...runs].sort()).toEqual([...titles].sort());
      // The first two checks set the app up themselves, and the first after them doesn't.
      expect(titles.slice(0, 2).every((title) => startsOnItsOwn(title))).toBe(true);
      expect(startsOnItsOwn(titles[2]!)).toBe(false);
      // The second is the pairing check, which ends in the session the others start from.
      expect(titles.filter((title) => title.startsWith(PAIRING))).toEqual([titles[1]]);
    },
    LISTING,
  );

  it("are the ones CI's iOS workflow runs, one job each", () => {
    const ios = readFileSync(join(ROOT, ".github/workflows/ios.yml"), "utf8");
    const job = ios.slice(ios.indexOf("\n  simulator:\n"), ios.indexOf("\n  report:\n"));
    expect(job).toContain(`job: [${JOBS.map((_, i) => i + 1).join(", ")}]`);
    expect(job).toContain("fail-fast: false");
    expect(job).toContain("pattern=$(node apps/mobile/simulator/jobs.ts ${{ matrix.job }})");
    expect(job).toContain(
      'pnpm mobile:check --bail=1 --reporter=verbose --testNamePattern="$pattern"',
    );
    expect(ios).toContain("RESULT: ${{ needs.simulator.result }}");
  });

  it("run a check in no list in the last job, and in no other", () => {
    const titles = ["A: one", "B: two", "C: three", "new check", "D: four"];
    const jobs = [["A:"], ["B:", "D:"], ["C:"]];
    expect(jobProblems(titles, jobs, [], {})).toEqual([]);
    expect(unlisted(titles, jobs)).toEqual(["new check"]);
    expect(selected(jobPattern(1, jobs), titles)).toEqual(["A: one"]);
    expect(selected(jobPattern(2, jobs), titles)).toEqual(["B: two", "D: four"]);
    expect(selected(jobPattern(3, jobs), titles)).toEqual(["C: three", "new check"]);
    expect(() => jobPattern(4, jobs)).toThrow(/3 iOS jobs/);
    // A title's own pattern characters match only themselves.
    expect(selected(jobPattern(1, [["a (b)?"], []]), ["a (b)? c", "a b c"])).toEqual(["a (b)? c"]);
  });

  it("find a check in two lists, an entry that starts no check or several, and a pair kept apart", () => {
    const titles = ["A: one", "B: two", "on iPhone, x", "on iPhone, y"];
    expect(jobProblems(titles, [["A:"], ["A: o", "B:"]], [], {})).toEqual([
      `"A: one…" is in both job 1 and job 2`,
    ]);
    expect(jobProblems(titles, [["A:", "B:", "Gone:"]], [], {})).toEqual([
      `job 1 names "Gone:", which starts no check`,
    ]);
    expect(jobProblems(titles, [["on iPhone"]], ["Gone:"], {})).toEqual([
      `job 1 names "on iPhone", which starts 2 checks`,
      `OWN_START names "Gone:", which starts no check`,
    ]);
    expect(jobProblems(titles, [["A:"], ["B:"]], [], { "B:": "A:" })).toEqual([
      `"B:" starts where "A:" leaves the app: keep them in one job`,
    ]);
    expect(jobProblems(titles, [["B:", "A:"]], [], { "B:": "A:" })).toEqual([]);
    expect(jobProblems(titles, [["A:", "B:"]], [], { "A:": "B:" })).toEqual([
      `"A:" starts where "B:" leaves the app: keep them in one job`,
    ]);
  });
});
