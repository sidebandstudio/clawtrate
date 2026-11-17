// Which files a tool call names, read the way the gateway reads them when it
// lists a task's files (`sessions.files.list`): `read`, `write` and `edit` by
// their path argument, `apply_patch` by the files its patch adds, updates,
// deletes or moves to. Only these establish a file; nothing else does.

type RawRecord = Record<string, unknown>;

const record = (value: unknown): RawRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/** The file tools whose calls name a path, as the gateway's own file list reads them. */
export const FILE_TOOLS = ["read", "write", "edit", "apply_patch"] as const;
/** The file tools that change a file. */
export const CHANGE_TOOLS = ["write", "edit", "apply_patch"] as const;
/** The tool that runs commands: what it changes is not reported. */
export const COMMAND_TOOLS = ["exec"] as const;

/** At most this many paths are kept for one call. */
export const MAX_STEP_PATHS = 8;
/** A path a step keeps: an id, never cut; a longer one becomes a digest and matches no file. */
export const MAX_STEP_PATH_CHARS = 512;

export function isFileTool(name: string | null): boolean {
  return name !== null && (FILE_TOOLS as readonly string[]).includes(name.toLowerCase());
}
export function isChangeTool(name: string | null): boolean {
  return name !== null && (CHANGE_TOOLS as readonly string[]).includes(name.toLowerCase());
}
export function isCommandTool(name: string | null): boolean {
  return name !== null && (COMMAND_TOOLS as readonly string[]).includes(name.toLowerCase());
}

function pathArg(args: RawRecord): string | null {
  return (
    nonEmpty(args.path) ??
    nonEmpty(args.file_path) ??
    nonEmpty(args.filePath) ??
    nonEmpty(args.file)
  );
}

/** The paths a file tool's arguments name, in order, without repeats; empty for any other tool. */
export function filePathsOf(toolName: string | null, rawArgs: unknown): string[] {
  const name = toolName?.toLowerCase() ?? null;
  const args = record(rawArgs);
  if (!name || !args || !isFileTool(name)) return [];
  const paths: string[] = [];
  const add = (value: string | null | undefined) => {
    if (value && !paths.includes(value) && paths.length < MAX_STEP_PATHS) paths.push(value);
  };
  if (name !== "apply_patch") {
    add(pathArg(args));
    return paths;
  }
  if (typeof args.input === "string") {
    for (const match of args.input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm))
      add(match[1]?.trim());
    for (const match of args.input.matchAll(/^\*\*\* Move to: (.+)$/gm)) add(match[1]?.trim());
  }
  if (Array.isArray(args.changes)) {
    for (const each of args.changes) {
      const change = record(each);
      add(nonEmpty(change?.path));
      const kind = record(change?.kind);
      add(nonEmpty(kind?.move_path) ?? nonEmpty(kind?.movePath));
    }
  }
  return paths;
}
