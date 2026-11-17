// Copying has to work where the preview is actually used: plain http from
// another machine, which is not a secure context, so `navigator.clipboard`
// is missing there.

export type CopyResult = "copied" | "manual";

function copyWithSelection(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** Copy text, falling back to a selection copy; "manual" means the user must press the shortcut. */
export async function copyText(text: string): Promise<CopyResult> {
  if (globalThis.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return "copied";
    } catch {
      // Permission denied or document not focused; try the fallback.
    }
  }
  return copyWithSelection(text) ? "copied" : "manual";
}

/** Select an element's text so the user can copy it with the keyboard. */
export function selectContents(element: Element): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
