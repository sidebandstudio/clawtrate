// The files the `#attach` scenario writes into a bot's workspace and hands over
// with `MEDIA:` lines at the end of its answer: a small two-page PDF and a text
// note. Everything is made here; nothing is copied from anywhere.

/** Where the scenario writes them, relative to the bot's workspace. */
export const ATTACH_PDF_PATH = "reports/reviews-draft.pdf";
export const ATTACH_TEXT_PATH = "reports/reviews.txt";
/** What the bot says above its `MEDIA:` lines. */
export const ATTACH_TEXT = "Both reviews are in this two-page draft.";
export const ATTACH_NOTE = "Lake loop: easy, 6 km.\nRidge path: steep start, 11 km.\n";

/**
 * A two-page PDF with one line of text on each page, written out with its
 * cross-reference offsets, so a reader opens it. ASCII only, so the bot's
 * `write` tool can write it as text.
 */
export function reviewsDraftPdf(): string {
  const page = (content: number) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 7 0 R >> >> /Contents ${content} 0 R >>`;
  const stream = (text: string) => {
    const body = `BT /F1 14 Tf 24 120 Td (${text}) Tj ET`;
    return `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
  };
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    page(5),
    page(6),
    stream("Lake loop review"),
    stream("Ridge path review"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}
