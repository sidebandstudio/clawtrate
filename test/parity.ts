// The parity check: docs/parity.md against the checks that name its rows. A
// check names rows by starting its title with their ids, for example
// `test("F-013 F-015: ...")`.

export const STATUSES = ["todo", "done", "desktop done", "gap"] as const;

export type ParityRow = { id: string; platform: string; status: string };

/** The rows of the table: every line that starts with "| F-". */
export function parseTable(markdown: string): ParityRow[] {
  return markdown
    .split("\n")
    .filter((line) => /^\| F-\d{3} \|/.test(line))
    .map((line) => {
      const cells = line.split("|").map((cell) => cell.trim());
      // A row starts and ends with a pipe, so the first and last cells are empty.
      return { id: cells[1]!, platform: cells[3]!, status: cells.at(-2)! };
    });
}

/** The ids at the start of each check title in a test file's source. */
export function checkIds(source: string): string[] {
  const titles = /\b(?:test|it|describe)(?:\.\w+)*\(\s*[`'"]((?:F-\d{3}[ ,]*)+):/g;
  const ids: string[] = [];
  for (const match of source.matchAll(titles)) ids.push(...match[1]!.match(/F-\d{3}/g)!);
  return ids;
}

/** Everything wrong with the table and the checks that name it. */
export function parityProblems(rows: ParityRow[], named: Set<string>): string[] {
  const problems: string[] = [];
  const ids = new Set(rows.map((row) => row.id));
  for (const row of rows) {
    if (!(STATUSES as readonly string[]).includes(row.status)) {
      problems.push(`${row.id}: unknown status "${row.status}"`);
    }
    if (row.status === "desktop done" && row.platform !== "both") {
      problems.push(`${row.id}: "desktop done" is only for rows whose platform is both`);
    }
    if ((row.status === "done" || row.status === "desktop done") && !named.has(row.id)) {
      problems.push(`${row.id}: marked ${row.status}, but no check names it`);
    }
  }
  for (const id of named)
    if (!ids.has(id)) problems.push(`${id}: a check names it, but the table has no such row`);
  return problems;
}
