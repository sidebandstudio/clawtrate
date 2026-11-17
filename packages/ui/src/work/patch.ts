// A unified patch as the change view draws it (work-pane.md, section 7): hunks
// with their position, and each line with its sign and its old and new numbers.

export type PatchLine = {
  kind: "add" | "del" | "same";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};
export type Hunk = { oldStart: number; newStart: number; newEnd: number; lines: PatchLine[] };

/** The hunks of a patch; header lines ("---", "+++", "diff", "index") are left out. */
export function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let hunk: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (head) {
      oldLine = Number(head[1]);
      newLine = Number(head[3]);
      const count = head[4] === undefined ? 1 : Number(head[4]);
      hunk = {
        oldStart: oldLine,
        newStart: newLine,
        newEnd: newLine + Math.max(count, 1) - 1,
        lines: [],
      };
      hunks.push(hunk);
      continue;
    }
    if (!hunk || raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: raw.slice(1), oldLine: null, newLine: newLine++ });
    } else if (raw.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: raw.slice(1), oldLine: oldLine++, newLine: null });
    } else if (raw.startsWith(" ")) {
      hunk.lines.push({ kind: "same", text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return hunks;
}

/** Added and removed lines in a patch: "+4 −1". */
export function patchCounts(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks)
    for (const line of hunk.lines) {
      if (line.kind === "add") added += 1;
      else if (line.kind === "del") removed += 1;
    }
  return { added, removed };
}

/**
 * The numbered form of a change the gateway's history keeps (`details.diff`):
 * "+3 text" added as line 3, "-3 text" removed from line 3, " 4 text"
 * unchanged at line 4, and a line of "..." between distant parts. Unchanged
 * and added lines are numbered in the new file, removed lines in the old one.
 */
export function parseNumberedDiff(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let hunk: Hunk | null = null;
  const start = (line: number) => {
    hunk = { oldStart: line, newStart: line, newEnd: line, lines: [] };
    hunks.push(hunk);
    return hunk;
  };
  for (const raw of diff.split("\n")) {
    if (/^\s*\.\.\.\s*$/.test(raw)) {
      hunk = null;
      continue;
    }
    const match = /^([+\- ])\s*(\d+) ?(.*)$/.exec(raw);
    if (!match) continue;
    const number = Number(match[2]);
    const current: Hunk = hunk ?? start(number);
    const kind = match[1] === "+" ? "add" : match[1] === "-" ? "del" : "same";
    current.lines.push({
      kind,
      text: match[3] ?? "",
      oldLine: kind === "add" ? null : number,
      newLine: kind === "del" ? null : number,
    });
    if (kind !== "del") current.newEnd = Math.max(current.newEnd, number);
  }
  return hunks;
}
