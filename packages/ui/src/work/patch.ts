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
