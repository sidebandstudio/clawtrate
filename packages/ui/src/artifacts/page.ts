// A bot's Page made inert (docs/design/library.md, section 6, "What the
// builder does"): parsed aside, where nothing runs and nothing is fetched,
// then stripped of everything that can run, navigate, submit or load, with
// its links turned into their words and their addresses collected. This is
// the "Clawtrate version" an export saves. Pages are not drawn yet on any
// platform (the gate in `page-view.tsx`).

/** What the inert Page may do once drawn: nothing but show itself. */
export const PAGE_POLICY =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";

/** The most of a Page Clawtrate reads, draws or exports: 5 MiB of UTF-8. */
export const MAX_PAGE_BYTES = 5_242_880;

/** A `data:` picture kept in the Page: one of these types, matching its bytes, at most 2 MiB. */
const MAX_INLINE_PICTURE_BYTES = 2_097_152;
const PICTURE_SIGNATURES: Record<string, (bytes: Uint8Array) => boolean> = {
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46,
  "image/webp": (b) =>
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57,
};

/** Elements that navigate, embed, run or hint: removed with what they hold. */
const REMOVED = [
  "script",
  "noscript",
  "base",
  "link",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "portal",
  "template",
  "applet",
  "meta",
  "video",
  "audio",
  "source",
  "track",
  "svg",
  "math",
  "dialog",
];

/** Attributes that hold an address, a script, or a navigation. */
const ADDRESS_ATTRIBUTES = [
  "href",
  "action",
  "formaction",
  "ping",
  "srcdoc",
  "src",
  "srcset",
  "poster",
  "data",
  "background",
  "xlink:href",
  "lowsrc",
  "dynsrc",
  "longdesc",
  "cite",
  "manifest",
  "target",
  "formtarget",
  "download",
];

/** A `data:` picture of an allowed type whose bytes match it, small enough; otherwise null. */
function inlinePicture(value: string): string | null {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(
    value.trim(),
  );
  if (!match) return null;
  const type = match[1]!.toLowerCase();
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(match[2]!.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length > MAX_INLINE_PICTURE_BYTES) return null;
  return PICTURE_SIGNATURES[type]?.(bytes)
    ? `data:${type};base64,${match[2]!.replace(/\s+/g, "")}`
    : null;
}

/** An address as one canonical `http:` or `https:` address, or null. */
function canonical(address: string): string | null {
  try {
    const url = new URL(address.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export type InertPage = {
  /** The framed form: what an export's "Clawtrate version" saves, and what would be drawn. */
  html: string;
  /** How many scripts were removed. */
  scripts: number;
  /** Each link's canonical address, once, in the order of the Page. */
  links: string[];
};

/**
 * A Page as Clawtrate shows it: parsed by `DOMParser` (a parsed document
 * runs no script and loads nothing), every script, hint, embed and navigable
 * element removed, every address and event attribute removed, forms
 * unwrapped with their controls kept inert, links turned into their words,
 * only bounded matching `data:` pictures kept, and the policy first in its
 * head.
 */
export function inertPage(source: string): InertPage {
  const page = new DOMParser().parseFromString(source, "text/html");
  const scripts = page.querySelectorAll("script").length;
  for (const element of page.querySelectorAll(REMOVED.join(","))) element.remove();
  const links: string[] = [];
  // Links become their own words, in the style of the sentence around them.
  for (const link of [...page.querySelectorAll("a, area")]) {
    const address = canonical(link.getAttribute("href") ?? "");
    if (address && !links.includes(address)) links.push(address);
    const span = page.createElement("span");
    span.append(...link.childNodes);
    link.replaceWith(span);
  }
  // Forms are unwrapped; a submit button becomes a plain button.
  for (const form of [...page.querySelectorAll("form")]) {
    const div = page.createElement("div");
    div.append(...form.childNodes);
    form.replaceWith(div);
  }
  for (const button of page.querySelectorAll("button")) button.setAttribute("type", "button");
  for (const input of page.querySelectorAll("input")) {
    const type = (input.getAttribute("type") ?? "").toLowerCase();
    if (type === "submit" || type === "image" || type === "reset")
      input.setAttribute("type", "button");
  }
  // No style travels: what CSS can reach is more than a check of its text can prove.
  for (const style of [...page.querySelectorAll("style")]) style.remove();
  for (const element of page.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) element.removeAttribute(attribute.name);
      else if (name === "style") element.removeAttribute(attribute.name);
      else if (name === "src" && element.tagName === "IMG") {
        const kept = inlinePicture(attribute.value);
        if (kept) element.setAttribute("src", kept);
        else element.removeAttribute("src");
      } else if (ADDRESS_ATTRIBUTES.includes(name) || name.startsWith("xlink:"))
        element.removeAttribute(attribute.name);
    }
  }
  // A picture whose address was taken out shows its alternative text.
  for (const image of [...page.querySelectorAll("img:not([src])")]) {
    image.replaceWith(page.createTextNode(image.getAttribute("alt") ?? ""));
  }
  const policy = page.createElement("meta");
  policy.setAttribute("http-equiv", "Content-Security-Policy");
  policy.setAttribute("content", PAGE_POLICY);
  page.head.prepend(policy);
  return { html: `<!doctype html>${page.documentElement.outerHTML}`, scripts, links };
}

/** The file name an export proposes: the title's last part, nothing a file system reads as a path. */
export function pageFileName(title: string): string {
  const last = title.split(/[\\/]/).pop() ?? title;
  const base =
    [...last]
      .map((char) => (/[<>:"|?*]/.test(char) || char.charCodeAt(0) < 0x20 ? "-" : char))
      .join("")
      .trim() || "Page";
  return `${base}.html`;
}
