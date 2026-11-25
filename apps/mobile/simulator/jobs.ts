// The Simulator checks each of CI's iOS jobs runs (#415): the checks its list below names, and
// for the last job also every check no list names, so a new check runs before anyone places it.
// An entry is the start of a check's title, its parity ids where it has them. Each job builds,
// boots and seeds on its own, then runs its checks in the file's order. The lists balance the
// checks by how long each took on GitHub's runner. Checks registered only on one device form
// (the iPhone Duo's) stay out of the lists: CI's jobs run on an iPhone, where they don't exist.
//
//   node apps/mobile/simulator/jobs.ts <job>   prints that job's Vitest --testNamePattern

/** The describe block the checks are in: Vitest matches a pattern against "<block> > <title>". */
export const SUITE = "the iOS app";

/** Each job's checks, in job order. Minutes are from one run on GitHub's runner. */
export const JOBS: readonly (readonly string[])[] = [
  [
    "F-001 F-009 F-263:", // 23
    "F-002 F-003 F-009:", // 23, waits for a pairing request to expire
    "on iPhone, the app switcher shows the privacy cover", // 3
    "on iPhone, the app switcher covers Settings", // 5
    "on iPhone, a dropped connection", // 9
  ],
  [
    "F-015 F-017 F-019:", // 5
    "F-427:", // 6
    "F-063 F-065:", // 24, waits ten minutes after its first message for a stamp
    "F-020 F-323:", // 18
  ],
  [
    "on iPhone at the largest text size", // 10
    "F-519:", // 17
    "on iPhone, Settings shows", // 18
    "on iPhone, a bot whose tasks the gateway failed", // 11
  ],
  [
    "on iPhone, a paired gateway that repeats", // 15
    "on iPhone, a long bot name", // 23
    "F-017:",
  ],
];

/** The pairing check: it sets the app up itself and ends in the paired session. */
export const PAIRING = "F-002 F-003 F-009:";

/**
 * The checks that set the app up themselves. Every other check starts where the pairing check
 * leaves the app: paired read-only through the check's proxy, on Home. A job without the
 * pairing check pairs that way first (ios.test.ts).
 */
export const OWN_START: readonly string[] = [
  "F-001 F-009 F-263:", // launches the app fresh
  PAIRING, // starts on the address screen the welcome check leaves
  "on iPhone, a paired gateway that repeats",
  "on iPhone, a bot whose tasks the gateway failed",
  "on iPhone, a long bot name",
  "F-017:",
];

/** A check that starts where another leaves the app, so both run in one job, in this order. */
export const FOLLOWS: Readonly<Record<string, string>> = {
  [PAIRING]: "F-001 F-009 F-263:",
};

const names = (entry: string, title: string) => title.startsWith(entry);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a check sets the app up itself, rather than starting from a paired session. */
export function startsOnItsOwn(title: string, ownStart = OWN_START): boolean {
  return ownStart.some((entry) => names(entry, title));
}

/** What is wrong with the lists, given the titles of the checks: an empty list, an entry that
 * names no check, or more than one, a check in two lists, or a pair FOLLOWS keeps together that is
 * apart. */
export function jobProblems(
  titles: readonly string[],
  jobs = JOBS,
  ownStart = OWN_START,
  follows = FOLLOWS,
): string[] {
  const problems: string[] = [];
  const named = (entry: string, where: string) => {
    const found = titles.filter((title) => names(entry, title));
    if (found.length === 0) problems.push(`${where} names "${entry}", which starts no check`);
    if (found.length > 1)
      problems.push(`${where} names "${entry}", which starts ${found.length} checks`);
    return found;
  };
  const jobOf = new Map<string, number>();
  jobs.forEach((entries, i) => {
    if (entries.length === 0) problems.push(`job ${i + 1} names no checks`);
    for (const entry of entries)
      for (const title of named(entry, `job ${i + 1}`)) {
        const first = jobOf.get(title);
        if (first !== undefined)
          problems.push(`"${title.slice(0, 60)}…" is in both job ${first} and job ${i + 1}`);
        else jobOf.set(title, i + 1);
      }
  });
  for (const entry of ownStart) named(entry, "OWN_START");
  for (const [later, earlier] of Object.entries(follows)) {
    const [a] = named(earlier, "FOLLOWS");
    const [b] = named(later, "FOLLOWS");
    if (!a || !b) continue;
    const job = (title: string) => jobOf.get(title) ?? jobs.length;
    if (job(a) !== job(b) || titles.indexOf(a) > titles.indexOf(b))
      problems.push(`"${later}" starts where "${earlier}" leaves the app: keep them in one job`);
  }
  return problems;
}

/** The checks no list names: they run with the last job. */
export function unlisted(titles: readonly string[], jobs = JOBS): string[] {
  return titles.filter((title) => !jobs.flat().some((entry) => names(entry, title)));
}

/** Vitest's --testNamePattern for job `job` (from 1): its own checks, or for the last job every
 * check no other job names, which takes in the checks no list names. */
export function jobPattern(job: number, jobs = JOBS): string {
  if (!Number.isInteger(job) || job < 1 || job > jobs.length)
    throw new Error(`there are ${jobs.length} iOS jobs; ${job} is not one of them`);
  // An empty list selects nothing: an empty group would select every check.
  const any = (entries: readonly string[]) =>
    entries.length === 0 ? "(?!)" : `(?:${entries.map(escape).join("|")})`;
  const start = `^${escape(SUITE)} > `;
  if (job < jobs.length) return `${start}${any(jobs[job - 1]!)}`;
  const others = jobs.slice(0, -1).flat();
  return others.length === 0 ? start : `${start}(?!${any(others)})`;
}

if (import.meta.main) console.log(jobPattern(Number(process.argv[2])));
