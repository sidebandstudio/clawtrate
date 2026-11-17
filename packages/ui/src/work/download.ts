// Download (work-pane.md, section 6, F-319): exactly the bytes the reader
// supplied, under the file's own name. The desktop app saves through its main
// process; a browser downloads.

import type { ClawtrateBridge } from "@clawtrate/core";

export type DownloadOutcome =
  { ok: true; announcement: string } | { ok: false; announcement: string; detail: string | null };

function browserDownload(name: string, data: Uint8Array): void {
  const copy = new Uint8Array(data.length);
  copy.set(data);
  const url = URL.createObjectURL(new Blob([copy.buffer], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function downloadBytes(
  bridge: ClawtrateBridge,
  name: string,
  data: Uint8Array,
): Promise<DownloadOutcome | null> {
  if (!bridge.save) {
    browserDownload(name, data);
    return { ok: true, announcement: `Downloaded ${name}` };
  }
  const buffer = new ArrayBuffer(data.length);
  new Uint8Array(buffer).set(data);
  try {
    const result = await bridge.save({ name, data: buffer });
    if (result.status === "cancelled") return null;
    if (result.status === "saved") return { ok: true, announcement: `Downloaded ${result.name}` };
    const where =
      result.target === "unchanged"
        ? "The file that was there is unchanged."
        : result.target === "absent"
          ? "Nothing was saved."
          : result.target === "saved-anyway"
            ? "The file there now holds these bytes."
            : "The file there may be incomplete.";
    return {
      ok: result.target === "saved-anyway",
      announcement: `Couldn't save ${name}.`,
      detail: `${result.message} ${where}`,
    };
  } catch (error) {
    return {
      ok: false,
      announcement: `Couldn't save ${name}.`,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
