// The decision behind .github/workflows/pr-ai-disclosure.yml. The workflow passes in the pull
// request's author from the event payload, its current body, and GitHub's Markdown renderer.

export const failure =
  "End the PR body with AI: MODEL via HARNESS, one line per contributing pair. If no AI contributed, end with No AI used.";

// Dependabot rewrites its own body on every rebase, so its pull requests count as "No AI used.".
// Only GitHub's own bot account matches. A person's account has the type "User", and GitHub keeps
// logins that end in "[bot]" for apps.
export function isDependabot(user) {
  return user?.login === "dependabot[bot]" && user?.type === "Bot";
}

const placeholder = /^(?:model|harness|none|n\/?a|unknown|unspecified|not specified|tbd|todo)$/i;

function named(value) {
  return (
    /[\p{L}\p{N}]/u.test(value) && !placeholder.test(value) && !/[[\]]|&(?:lt|gt);/.test(value)
  );
}

// Returns the failure message, or undefined when the pull request passes.
export async function checkDisclosure({ author, body, render }) {
  if (isDependabot(author)) return undefined;
  // CodeSmith appends its own footer after the author's last paragraph.
  const text = (body ?? "").replace(
    /<!-- codesmith:footer -->[\s\S]*?<!-- \/codesmith:footer -->/g,
    "",
  );
  const html = await render(text || " ");
  const visible = html
    .trimEnd()
    .replace(/<\/?code>/g, "")
    .replace(/<br\s*\/?>\n?/g, "\n");
  const footer = visible.match(/(?:^|\n)<p>([^<>]*)<\/p>$/)?.[1]?.trim();
  if (footer === "No AI used.") return undefined;
  const complete = footer?.split(/\r?\n/).every((line) => {
    const pair = /^AI:\s*(.+?)\s+via\s+(.+)$/i.exec(line.trim());
    return pair && named(pair[1].trim()) && named(pair[2].trim());
  });
  return complete ? undefined : failure;
}
