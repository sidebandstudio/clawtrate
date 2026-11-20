// Part 2 of the Work pane: artifacts and media. Cards in the conversation, an
// artifact in the pane, the card's menu, and the media viewer. It plugs into
// work.js through CT.work. docs/design/work-pane.md, sections 11 to 14.
//
// States from the address:
//   ?bot=juniper&task=j2          Juniper's research task, with every kind of card
//   ?artifact=a-report            an item open in the pane
//   ?artifactload=failed          the first opening of an item fails
//   ?viewer=a-usage               an item open in the viewer (also: page)
//   ?menu=artifact&menuitem=a-usage
//   ?thumbs=failed                the gateway's thumbnail fails to load

(function () {
  const CT = window.CT;
  const W = CT.work;
  const params = CT.params;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = CT.esc;
  const icon = (name, cls) => CT.icon(name, cls);

  // Pictures, drawn here. -------------------------------------------------------------------

  const growth = () =>
    `<svg viewBox="0 0 640 400" role="img" aria-label="Line chart: the transcode cache grew from 20 to 180 GB over six weeks">` +
    `<rect width="640" height="400" fill="#101112"/>` +
    `<text x="32" y="46" font-family="Figtree Variable, sans-serif" font-size="20" font-weight="600" fill="#f3f3f2">Transcode cache, last six weeks</text>` +
    [0, 1, 2, 3].map((i) => `<path d="M32 ${120 + i * 66}H608" stroke="rgba(255,255,255,.08)"/>`).join("") +
    `<path d="M40 320 L140 300 L240 268 L340 230 L440 178 L540 132 L600 112" fill="none" stroke="#3ee6c1" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<text x="40" y="360" font-family="Figtree Variable, sans-serif" font-size="13" fill="#9d9fa2">Oct 5</text>` +
    `<text x="560" y="360" font-family="Figtree Variable, sans-serif" font-size="13" fill="#9d9fa2">Nov 16</text></svg>`;

  const appsChart = () =>
    `<svg viewBox="0 0 640 400" role="img" aria-label="Chart: three lending apps compared by titles and wait time">` +
    `<rect width="640" height="400" fill="#fbfbfa"/>` +
    `<text x="32" y="46" font-family="Figtree Variable, sans-serif" font-size="20" font-weight="600" fill="#111213">Lending apps compared</text>` +
    [
      ["Shelfwise", 300, "#58c26f"],
      ["PageLoop", 220, "#a98bff"],
      ["Readmore", 150, "#ff8552"],
    ]
      .map(
        ([n, w, c], i) =>
          `<text x="32" y="${118 + i * 80}" font-family="Figtree Variable, sans-serif" font-size="15" fill="#111213">${n}</text>` +
          `<rect x="170" y="${100 + i * 80}" width="${w}" height="26" rx="8" fill="${c}"/>`,
      )
      .join("") +
    `</svg>`;

  const cover = () =>
    `<svg viewBox="0 0 400 520" role="img" aria-label="A book cover: abstract shapes in green and orange">` +
    `<rect width="400" height="520" fill="#1f2022"/><circle cx="130" cy="180" r="110" fill="#58c26f"/>` +
    `<rect x="190" y="250" width="170" height="170" rx="40" fill="#ff8552"/>` +
    `<text x="40" y="470" font-family="Figtree Variable, sans-serif" font-size="30" font-weight="600" fill="#f3f3f2">The Quiet Lake</text></svg>`;

  const poster = () =>
    `<svg viewBox="0 0 640 360" role="img" aria-label="Video poster: an e-book app's lending screen">` +
    `<rect width="640" height="360" fill="#16181b"/><rect x="200" y="30" width="240" height="300" rx="28" fill="#2a2c30"/>` +
    `<rect x="222" y="70" width="196" height="24" rx="8" fill="#5b8dff"/>` +
    [0, 1, 2, 3].map((i) => `<rect x="222" y="${112 + i * 48}" width="196" height="36" rx="10" fill="#3a3c40"/>`).join("") +
    `</svg>`;

  const pdfPage = (n, of) =>
    `<div class="pdf-page" role="img" aria-label="Page ${n} of ${of}"><p class="pdf-page-label">Page ${n} of ${of}</p><div class="pdf-sheet">` +
    `<div class="pdf-title">${n === 1 ? "Lending terms" : n === 2 ? "Holds and waits" : "Returns"}</div>` +
    Array.from({ length: 9 }, (_, i) => `<div class="pdf-line" style="width:${70 + ((i * 37 + n * 11) % 28)}%"></div>`).join("") +
    `</div></div>`;

  // The task's artifacts. download: bytes, url or unsupported (the gateway's mode).
  const A = {
    "a-report": { task: "o1", msg: "msg-report", kind: "file", name: "disk-report.md", typeWords: "Markdown", mime: "text/markdown", size: 37 * 1024 + 410, download: "bytes", time: "5:37 PM", icon: "file",
      content: "# Disk report, media-box\n\n## Found\n\n- Transcode cache: about 180 GB.\n- Container images: about 40 GB.\n- Rotated logs: about 6 GB.\n\n## Changed\n\n- Moved the cache to `transcode-cache.old`. The disk is at 61%.\n\n## Left\n\n- Remove the old cache on Monday, Nov 23.\n" },
    "a-usage": { task: "o1", msg: "msg-report", group: "g-o1", kind: "image", name: "usage.png", typeWords: "PNG image", mime: "image/png", size: 48230, download: "bytes", time: "5:37 PM", art: () => CT.chart() },
    "a-growth": { task: "o1", msg: "msg-report", group: "g-o1", kind: "image", name: "cache-growth.png", typeWords: "PNG image", mime: "image/png", size: 3250585, download: "url", time: "5:37 PM", thumbnail: true, art: growth },
    "a-terms": { task: "j2", msg: "msg-j-1", kind: "file", name: "lending-terms.pdf", typeWords: "PDF", mime: "application/pdf", size: 412 * 1024, download: "bytes", time: "3:02 PM", icon: "page", pages: 3 },
    "a-screens": { task: "j2", msg: "msg-j-1", kind: "file", name: "app-screens.zip", typeWords: "ZIP archive", mime: "application/zip", size: 8808038, download: "url", time: "3:02 PM", icon: "list" },
    "a-card": { task: "j2", msg: "msg-j-1", kind: "file", name: "library-card.pkpass", typeWords: "File", size: undefined, download: "unsupported", time: "3:02 PM", icon: "file" },
    // Listed by the gateway, but with no content it can send: a quiet tile, kept out of the viewer.
    "a-cover": { task: "j2", msg: "msg-j-2", group: "g-j2", kind: "image", name: "cover.jpg", typeWords: "JPEG image", mime: "image/jpeg", size: 214000, download: "unsupported", time: "3:04 PM", art: cover },
    // At an address that is not on the gateway: opened only in the browser, by the person's choice.
    "a-faq": { task: "j2", msg: "msg-j-1", kind: "file", name: "lending-faq.pdf", typeWords: "PDF", mime: "application/pdf", download: "url", external: "help.library.example", time: "3:02 PM", icon: "page" },
    "a-chart": { task: "j2", msg: "msg-j-2", group: "g-j2", kind: "image", name: "apps-compared.png", typeWords: "PNG image", mime: "image/png", size: 61200, download: "bytes", time: "3:04 PM", art: appsChart },
    "a-walk": { task: "j2", msg: "msg-j-2", group: "g-j2", kind: "video", name: "borrowing-walkthrough.mp4", typeWords: "MP4 video", mime: "video/mp4", size: 14 * 1024 * 1024, download: "url", time: "3:04 PM", duration: "1:12", art: poster },
    "a-note": { task: "j2", msg: "msg-j-2", kind: "audio", name: "voice-note.m4a", typeWords: "Audio", mime: "audio/mp4", size: 640 * 1024, download: "bytes", time: "3:04 PM", duration: "1:04" },
  };
  const byTask = (taskId) => Object.keys(A).filter((id) => A[id].task === taskId);
  // Only content on the gateway is fetched: in the transcript, or at an address there.
  const fetchable = (a) => a.download !== "unsupported" && !a.external;
  const loaded = new Set(); // items opened once already
  let failNext = params.get("artifactload") === "failed";

  const sub = (a) => (a.external ? `${a.typeWords} · from ${a.external}` : [a.typeWords, W.size(a.size)].filter(Boolean).join(" · "));

  // Cards -------------------------------------------------------------------------------------

  const more = (id, name) =>
    `<button type="button" class="icon-button artifact-more" data-variant="quiet" data-artifact-menu="${id}" aria-haspopup="menu" aria-expanded="false" aria-label="More for ${esc(name)}" title="More">${icon("more")}</button>`;

  function fileCard(id) {
    const a = A[id];
    const tile = a.kind === "audio" ? `<span class="artifact-tile" data-round="true">${icon("play")}</span>` : `<span class="artifact-tile">${icon(a.icon || "file")}</span>`;
    const spoken = `${a.name}, ${a.external ? `${a.typeWords}, from ${a.external}` : [a.typeWords, W.size(a.size)].filter(Boolean).join(", ")}. Open in the Work pane.`;
    return (
      `<div class="artifact" data-kind="${a.kind}" id="card-${id}" data-artifact="${id}">` +
      (a.kind === "audio"
        ? `<button type="button" class="artifact-play" data-play="${id}" aria-label="Play ${esc(a.name)}, ${a.duration}" aria-pressed="false">${tile}</button>` +
          `<button type="button" class="artifact-main" data-open-artifact="${id}" aria-label="${esc(spoken)}"><span class="artifact-text"><span class="artifact-name">${W.middle(a.name)}</span>` +
          `<span class="artifact-sub" id="sub-${id}">${sub(a)}</span></span></button>`
        : `<button type="button" class="artifact-main" data-open-artifact="${id}" aria-label="${esc(spoken)}">${tile}<span class="artifact-text">` +
          `<span class="artifact-name">${W.middle(a.name)}</span><span class="artifact-sub">${sub(a)}</span></span></button>`) +
      more(id, a.name) +
      `</div>`
    );
  }

  function mediaCell(id) {
    const a = A[id];
    // The thumbnail fails, or comes back as the original over 2 MB: no preview.
    const thumbFailed = (a.thumbnail && ["failed", "original"].includes(params.get("thumbs"))) || !fetchable(a);
    const quiet = (a.thumbnail && (thumbFailed || !thumbsReady)) || !fetchable(a);
    const inner = quiet
      ? `<span class="media-quiet">${icon("image")}<span>${esc(a.name)}</span><span>${thumbFailed ? "No preview" : W.size(a.size)}</span></span>`
      : fill(a.art());
    const play = a.kind === "video" ? `<span class="media-play" aria-hidden="true">${icon("play")}</span><span class="media-duration">${a.duration}</span>` : "";
    return (
      `<button type="button" class="media-cell" data-kind="${a.kind}" ${fetchable(a) ? `data-viewer="${id}"` : `data-open-artifact="${id}"`} data-artifact="${id}" id="card-${id}"${quiet && !thumbFailed ? ' aria-busy="true"' : ""}` +
      ` aria-label="${esc(`${a.name}, ${a.kind === "video" ? `video, ${a.duration}. Play` : "Open full size"}`)}">${inner}${play}</button>`
    );
  }
  let thumbsReady = false;
  // A cell is cropped to fill its square, as a photo grid is.
  const fill = (svg) => svg.replace("<svg ", '<svg preserveAspectRatio="xMidYMid slice" ');

  const grid = (ids, groupId) =>
    `<div class="media-grid" data-count="${ids.length}" data-group="${groupId}" id="grid-${groupId}">${ids.map(mediaCell).join("")}` +
    `<button type="button" class="icon-button media-more" data-variant="quiet" data-artifact-menu="${ids[0]}" aria-haspopup="menu" aria-expanded="false" aria-label="More for these ${ids.length} items" title="More">${icon("more")}</button></div>`;

  const linkCard = () =>
    `<div class="artifact" data-kind="link" id="card-link"><button type="button" class="artifact-main" data-link="https://library.example/ebooks" ` +
    `aria-label="Library e-books, library.example. Opens in your browser."><span class="artifact-tile">${icon("link")}</span>` +
    `<span class="artifact-text"><span class="artifact-name">Library e-books</span><span class="artifact-sub">library.example</span></span></button></div>`;

  const pageCard = () =>
    `<div class="artifact" data-kind="page" id="card-page"><button type="button" class="artifact-main" data-viewer="page" aria-label="E-book apps compared, page. Open">` +
    `<span class="artifact-tile">${icon("page")}</span><span class="artifact-text"><span class="artifact-name">E-book apps compared</span><span class="artifact-sub">Page</span></span>` +
    `<span class="artifact-open">Open</span></button></div>`;

  const holder = (msg, html) => `<div class="artifacts" data-msg="${msg}">${html}</div>`;

  // Otto's disk task gains the report and two charts after its second reply.
  W.afterSecond = (t) =>
    W.bubble("assistant", "<p>Here is the write-up, and the chart before and after with the cache's growth.</p>", true).replace('class="msg"', 'class="msg" id="msg-report"') +
    holder("msg-report", fileCard("a-report") + grid(["a-usage", "a-growth"], "g-o1"));

  function juniperTranscript() {
    return (
      CT.stamp("Today 3:01 PM") +
      W.turn("user", W.bubble("user", "Which e-book app does my library use, and is it any good?")) +
      W.turn(
        "assistant",
        W.bubble("assistant", "<p>Your library lends e-books through Shelfwise. I compared it with the other two apps libraries use, and made a page you can sort.</p>", true).replace('class="msg"', 'class="msg" id="msg-j-1"') +
          holder("msg-j-1", linkCard() + pageCard() + fileCard("a-terms") + fileCard("a-screens") + fileCard("a-card") + fileCard("a-faq")),
      ) +
      CT.stamp("Today 3:04 PM") +
      W.turn("user", W.bubble("user", "Show me what borrowing looks like.")) +
      W.turn(
        "assistant",
        W.bubble("assistant", "<p>Here are the screens, a short walkthrough, and a note on holds.</p>", true).replace('class="msg"', 'class="msg" id="msg-j-2"') +
          holder("msg-j-2", grid(["a-cover", "a-chart", "a-walk"], "g-j2") + fileCard("a-note")),
      )
    );
  }

  W.extendFixtures = (bots) => {
    const juniper = bots.find((b) => b.id === "juniper");
    const j2 = juniper.tasks.find((t) => t.id === "j2");
    j2.html = juniperTranscript();
  };

  // "Sent in chat" in the Files tab ---------------------------------------------------------------

  W.sentInChat = (b, t, st, q) => {
    const ids = byTask(t.id).filter((id) => !q || A[id].name.toLowerCase().includes(q));
    if (!ids.length) return "";
    return (
      `<h3>Sent in chat</h3><ul class="file-list">` +
      ids
        .map((id) => {
          const a = A[id];
          const thumb = a.art && !a.thumbnail ? `<span class="file-icon file-thumb">${fill(a.art())}</span>` : `<span class="file-icon">${icon(a.kind === "image" ? "image" : a.kind === "video" ? "video" : a.kind === "audio" ? "audio" : a.icon || "file")}</span>`;
          return (
            `<li><button type="button" class="file-row" data-open-artifact="${id}" data-key="a:${id}" aria-label="${esc(`${a.name}, sent ${a.time}${a.size ? `, ${W.size(a.size)}` : ""}`)}">` +
            `${thumb}<span class="file-name">${W.middle(a.name)}</span><time class="file-time">${a.time}</time>` +
            `<span class="file-sub">Sent ${a.time}${a.size ? ` · ${W.size(a.size)}` : ""}</span></button></li>`
          );
        })
        .join("") +
      `</ul>`
    );
  };

  // An artifact in the pane ------------------------------------------------------------------------

  W.artifactLevel = (b, t, st, level, head) => {
    const id = level.path;
    const a = A[id];
    const actions =
      (fetchable(a) ? `<button type="button" class="icon-button" data-variant="quiet" data-art="download" aria-label="Download ${esc(a.name)}" title="Download">${icon("download")}</button>` : "") +
      (fetchable(a) && (a.content || a.kind === "image")
        ? `<button type="button" class="icon-button" data-variant="quiet" data-art="copy" aria-label="${a.kind === "image" ? "Copy the image" : `Copy the text of ${esc(a.name)}`}" title="Copy">${icon("copy")}</button>`
        : "");
    const source = `<p class="reader-source"><span>Sent by ${b.name} at ${a.time}</span>${CT.linkButton("Show in chat", { attrs: `data-show-card="${id}"`, name: `Show ${a.name} in the chat` })}</p>`;
    const factsHtml = (why, button = "") =>
      `<dl class="facts reader-facts"><div><dt>Name</dt><dd><span>${esc(a.name)}</span>${CT.copyButton("name", a.name)}</dd></div>` +
      `<div><dt>Type</dt><dd>${a.mime || "Not reported"}</dd></div>` +
      `<div><dt>Size</dt><dd>${a.size ? W.size(a.size) : "Not reported"}</dd></div>` +
      `<div><dt>Sent</dt><dd>Today ${a.time}</dd></div></dl><p class="reader-why">${why}</p>${button}`;
    let body;
    if (level.state === "loading") body = `<p class="files-note" aria-busy="true">Loading ${esc(a.name)}…</p>`;
    else if (level.state === "failed")
      body = `<p class="files-alert" role="alert">Couldn't open ${esc(a.name)}. The gateway's download link expired before it was used.<button type="button" class="button" data-size="sm" data-art="retry">Try again</button></p>`;
    else if (a.external)
      body = factsHtml(
        `This file is at ${a.external}, outside the gateway. Opening it leaves the app, and it may have changed since it was sent.`,
        `<p><button type="button" class="button" data-art="browser" aria-label="Open ${esc(a.name)} at ${a.external} in your browser">${icon("external")}Open in your browser</button></p>`,
      );
    else if (a.download === "unsupported" && a.kind === "image")
      body = `<div class="media-quiet reader-quiet">${icon("image")}<span>${esc(a.name)}</span><span>No preview</span></div><p class="reader-why">The gateway lists this picture, but not its content, so it can't be shown or downloaded here.</p>`;
    else if (a.download === "unsupported")
      body = factsHtml("The gateway lists this item, but not its content, so it can't be opened or downloaded here.");
    else if (a.kind === "image")
      body =
        `<button type="button" class="reader-image" data-viewer="${id}" aria-label="Open ${esc(a.name)} full size">${a.art()}</button>` +
        "";
    else if (a.kind === "file" && a.content) {
      const view = level.view || "preview";
      level.view = view;
      body =
        `<div class="seg reader-views" role="tablist" aria-label="View">` +
        [["preview", "Preview"], ["source", "Source"]].map(([k, l]) => `<button type="button" role="tab" aria-selected="${k === view}" tabindex="${k === view ? 0 : -1}" data-fileview="${k}">${l}</button>`).join("") +
        `</div>` +
        (view === "preview" ? CT.markdown(a.content) : `<div class="code-view" tabindex="0" role="region" aria-label="${esc(a.name)}">${a.content.replace(/\n$/, "").split("\n").map((l, i) => `<div class="code-line"><span class="ln" aria-hidden="true">${i + 1}</span><span class="lc">${esc(l) || " "}</span></div>`).join("")}</div>`);
    } else if (a.pages) body = `<div class="pdf-pages">${Array.from({ length: a.pages }, (_, i) => `<button type="button" class="pdf-open" data-viewer="${id}" data-page="${i + 1}" aria-label="Open page ${i + 1} of ${a.pages} full size">${pdfPage(i + 1, a.pages)}</button>`).join("")}</div>`;
    else if (a.kind === "audio")
      body = `<div class="audio-player">${fileCard(id).replace(/ id="card-[^"]+"/, "").replace(/ id="sub-[^"]+"/, ` id="psub-${id}"`)}</div>`;
    else if (a.kind === "video") body = `<button type="button" class="reader-image" data-viewer="${id}" aria-label="Play ${esc(a.name)}">${a.art()}<span class="media-play" aria-hidden="true">${icon("play")}</span></button>`;
    else body = factsHtml("There's no preview for this kind of file.", `<p><button type="button" class="button" data-art="download">Download</button></p>`);

    const rawPart = CT.rawDisclosure({
      events: [
        [
          "Artifact, a sample in the app's own shape",
          JSON.stringify({ id: `artifact_${id.slice(2)}7Qe`, type: a.kind, title: a.name, mimeType: a.mime, sizeBytes: a.size, runId: "run_77d413", messageSeq: 14, source: "session-transcript", download: { mode: a.download } }, null, 2),
        ],
      ],
      ids: [["Artifact", `artifact_${id.slice(2)}7Qe`], ["Run", "run_77d413"]],
    });
    return (
      `<div class="files reader">${head(st, a.name, actions)}<p class="reader-meta">${sub(a)}</p>${source}` +
      `<div class="reader-body" id="reader-body">${body}</div>` +
      `<div class="card-actions artifact-raw">${rawPart.button}</div>${rawPart.panel}</div>`
    );
  };

  // Opening an item in the pane: loading, then the view; the first opening may fail.
  function openArtifact(id) {
    const level = { kind: "artifact", path: id, state: loaded.has(id) ? undefined : "loading" };
    W.openLevel(level);
    if (level.state === "loading") {
      setTimeout(() => {
        level.state = failNext ? "failed" : undefined;
        if (failNext) failNext = false;
        else loaded.add(id);
        W.rerender();
      }, 250);
    }
  }

  // Downloads, copy -----------------------------------------------------------------------------------

  // A picture saved or copied is a file of its own, so it carries the SVG namespace.
  const standalone = (svg) => svg.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ');

  // The name a download proposes: the record's title, with an extension from its
  // media type when the title has none. The title is not proof of an original name.
  const extensions = { "text/markdown": "md", "image/png": "png", "image/jpeg": "jpg", "application/pdf": "pdf", "application/zip": "zip", "audio/mp4": "m4a", "video/mp4": "mp4" };
  const fileName = (a) => (/\.[a-z0-9]{1,5}$/i.test(a.name) || !extensions[a.mime] ? a.name : `${a.name}.${extensions[a.mime]}`);

  function blobFor(a) {
    if (a.content) return new Blob([new TextEncoder().encode(a.content)], { type: a.mime });
    if (a.art) return new Blob([standalone(a.art())], { type: "image/svg+xml" });
    return new Blob([new TextEncoder().encode(`${a.name}: sample bytes\n`)], { type: a.mime || "application/octet-stream" });
  }
  function save(a, verb = "Downloaded") {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blobFor(a));
    link.download = fileName(a);
    document.body.appendChild(link);
    link.click();
    link.remove();
    CT.announce(`${verb} ${a.name}`);
  }
  function downloadAll(ids) {
    const can = ids.filter((id) => fetchable(A[id]));
    can.forEach((id) => save(A[id]));
    const left = ids.filter((id) => !fetchable(A[id]));
    CT.announce(`Downloaded ${can.length} of ${ids.length}` + (left.length ? `. ${left.map((id) => A[id].name).join(", ")} can't be downloaded.` : "."));
  }
  async function copyImage(a) {
    try {
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(standalone(a.art()))}`;
      await img.decode();
      const canvas = Object.assign(document.createElement("canvas"), { width: img.naturalWidth || 640, height: img.naturalHeight || 360 });
      canvas.getContext("2d").drawImage(img, 0, 0);
      const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      CT.announce("Copied the image");
      return true;
    } catch {
      CT.announce("Couldn't copy the image.");
      return false;
    }
  }

  // The card's menu -------------------------------------------------------------------------------------

  let menu = null;
  let menuOpener = null;
  function closeMenu(refocus = true) {
    if (!menu) return;
    menu.remove();
    menu = null;
    menuOpener?.setAttribute?.("aria-expanded", "false");
    if (refocus && menuOpener && document.contains(menuOpener)) menuOpener.focus();
    menuOpener = null;
  }
  function openMenu(id, opener, x, y) {
    closeMenu(false);
    const a = A[id];
    const siblings = a.group ? byTask(a.task).filter((k) => A[k].group === a.group) : [];
    const msgItems = byTask(a.task).filter((k) => A[k].msg === a.msg);
    const can = msgItems.filter((k) => fetchable(A[k])).length;
    const item = (label, attrs) => `<li role="none"><button type="button" class="menu-item" role="menuitem" ${attrs}>${label}</button></li>`;
    menu = document.createElement("ul");
    menu.className = "menu artifact-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", siblings.length > 1 && opener.classList.contains("media-more") ? "These items" : a.name);
    menu.innerHTML =
      item("Open", `data-mi="open" data-id="${id}"`) +
      (fetchable(a) ? item("Download", `data-mi="download" data-id="${id}"`) : "") +
      (a.external ? item(`Open in your browser`, `data-mi="browser" data-id="${id}" aria-label="Open ${esc(a.name)} at ${a.external} in your browser"`) : "") +
      (fetchable(a) && a.kind === "image" ? item("Copy image", `data-mi="copy-image" data-id="${id}"`) + item("Save image…", `data-mi="save" data-id="${id}"`) : "") +
      (fetchable(a) && a.kind === "video" ? item("Save video…", `data-mi="save" data-id="${id}"`) : "") +
      (fetchable(a) && a.content ? item("Copy text", `data-mi="copy-text" data-id="${id}"`) : "") +
      item("Show in Files", `data-mi="files" data-id="${id}"`) +
      (msgItems.length > 1 && can >= 2
        ? `<li class="menu-rule" role="separator"></li>` +
          item(can === msgItems.length ? `Download all ${msgItems.length}` : `Download ${can} of ${msgItems.length}`, `data-mi="all" data-msg="${a.msg}" data-task="${a.task}"`)
        : "");
    $(".app").appendChild(menu);
    const host = $(".app").getBoundingClientRect();
    menu.style.position = "absolute";
    menu.style.zIndex = "40";
    menu.style.left = `${Math.max(8, Math.min(x - host.left, host.width - 244))}px`;
    menu.style.top = `${Math.min(y - host.top, host.height - menu.offsetHeight - 8)}px`;
    menuOpener = opener;
    opener.setAttribute?.("aria-expanded", "true");
    $(".menu-item", menu).focus();
  }

  // The media viewer ---------------------------------------------------------------------------------------

  let viewer = null;
  let viewerOpener = null;
  let speed = "1×";
  function sequence(id) {
    if (id === "page") return ["page"];
    const a = A[id];
    if (a.pages) return [id];
    // An item with no content at the gateway is not offered in the viewer's sequence.
    return a.group ? byTask(a.task).filter((k) => A[k].group === a.group && fetchable(A[k])) : [id];
  }
  function stage(id, page) {
    if (id === "page") {
      return (
        `<div class="viewer-page"><div class="viewer-page-inner"><h2>E-book apps compared</h2><p>Sort by titles, wait time or cost. This is the page's content, shown from the gateway's canvas.</p>` +
        `<table><thead><tr><th>App</th><th>Titles</th><th>Typical wait</th></tr></thead><tbody><tr><td>Shelfwise</td><td>48,000</td><td>9 days</td></tr><tr><td>PageLoop</td><td>31,000</td><td>14 days</td></tr><tr><td>Readmore</td><td>22,000</td><td>6 days</td></tr></tbody></table></div></div>`
      );
    }
    const a = A[id];
    if (a.pages) return `<div class="viewer-pdf">${pdfPage(page || 1, a.pages)}</div>`;
    if (a.kind === "video") {
      return (
        `<div class="viewer-video">${a.art()}<div class="video-bar"><button type="button" class="icon-button" data-v="play" aria-label="Play" aria-pressed="false">${icon("play")}</button>` +
        `<div class="video-track" role="slider" tabindex="0" aria-label="Position" aria-valuemin="0" aria-valuemax="72" aria-valuenow="0" aria-valuetext="0:00 of 1:12"><span></span></div>` +
        `<span class="video-time">0:00 / ${a.duration}</span><button type="button" class="speed-button" data-v="speed" aria-haspopup="menu" aria-expanded="false" aria-label="Speed: ${speed}">${speed}</button></div></div>`
      );
    }
    return `<div class="viewer-image" data-zoom="fit" role="img" aria-label="${esc(a.name)}">${a.art()}</div>`;
  }
  function openViewer(id, opener, page) {
    // Where the Library and Pages page is loaded, a page opens through its gate (library.md, section 6), never in this viewer.
    if (id === "page" && CT.openPage) return CT.openPage("pj", opener);
    const ids = sequence(id);
    const i = ids.indexOf(id);
    viewerOpener = opener || document.activeElement;
    viewer?.remove();
    viewer = document.createElement("div");
    viewer.className = "viewer";
    viewer.dataset.theme = "dark";
    viewer.setAttribute("role", "dialog");
    viewer.setAttribute("aria-modal", "true");
    viewer.dataset.id = id;
    if (page) viewer.dataset.page = page;
    $(".app").appendChild(viewer);
    $(".shell").inert = true;
    renderViewer(ids, i);
    $('[data-v="close"]', viewer).focus();
  }
  function renderViewer(ids, i) {
    const id = ids[i];
    const a = A[id] || { name: "E-book apps compared" };
    const several = ids.length > 1;
    viewer.dataset.id = id;
    viewer.setAttribute("aria-label", `${a.name}${several ? `, ${i + 1} of ${ids.length}` : ""}`);
    const canFetch = a.download && fetchable(a);
    viewer.innerHTML =
      `<div class="viewer-bar"><div class="viewer-title"><strong>${esc(a.name)}</strong>${several ? `<span>${i + 1} of ${ids.length}</span>` : ""}</div>` +
      (canFetch ? `<button type="button" class="icon-button" data-v="download" aria-label="Download ${esc(a.name)}" title="Download (⌘S)">${icon("download")}</button>` : "") +
      (canFetch && a.kind === "image" ? `<button type="button" class="icon-button" data-v="copy" aria-label="Copy the image" title="Copy (⌘C)">${icon("copy")}</button>` : "") +
      `<button type="button" class="icon-button" data-v="close" aria-label="Close the viewer" title="Close (Esc)">${icon("x")}</button></div>` +
      `<div class="viewer-stage">${stage(id, +viewer.dataset.page || 1)}</div>` +
      (several
        ? `<button type="button" class="icon-button viewer-nav" data-v="prev" data-side="start" aria-label="Previous">${icon("back")}</button>` +
          `<button type="button" class="icon-button viewer-nav" data-v="next" data-side="end" aria-label="Next">${icon("chevron")}</button>` +
          `<div class="viewer-strip" role="group" aria-label="Items">${ids.map((k, n) => `<button type="button" class="viewer-thumb" data-v="go" data-n="${n}" aria-label="${esc(A[k].name)}" aria-current="${n === i}">${fill(A[k].art())}</button>`).join("")}</div>`
        : "");
    viewer.dataset.n = i;
    viewer._ids = ids;
  }
  function closeViewer() {
    if (!viewer) return;
    viewer.remove();
    viewer = null;
    $(".shell").inert = false;
    if (viewerOpener && document.contains(viewerOpener)) viewerOpener.focus();
  }
  function move(step) {
    const ids = viewer._ids;
    const n = (+viewer.dataset.n + step + ids.length) % ids.length;
    renderViewer(ids, n);
    $(`[data-v="${step > 0 ? "next" : "prev"}"]`, viewer)?.focus();
  }
  W.openViewer = (what, opener) => openViewer(what === "chart" ? "a-usage" : what, opener);

  // Audio: one recording plays at a time.
  let playing = null;
  function togglePlay(id, button) {
    if (playing && playing.id !== id) togglePlay(playing.id, playing.button);
    const on = button.getAttribute("aria-pressed") !== "true";
    $$(`[data-play="${id}"]`).forEach((b) => {
      b.setAttribute("aria-pressed", String(on));
      b.setAttribute("aria-label", `${on ? "Pause" : "Play"} ${A[id].name}, ${A[id].duration}`);
      $(".artifact-tile", b).innerHTML = icon(on ? "pause" : "play");
    });
    $$(`#sub-${id}, #psub-${id}`).forEach((s) => (s.innerHTML = on ? `<span class="audio-track"><span style="width:19%"></span></span>0:12 / ${A[id].duration}` : sub(A[id])));
    playing = on ? { id, button } : null;
  }

  // Link previews: fetched by the device on hover, never when drawn.
  let previewTimer = null;
  function showLinkPreview(card) {
    hideLinkPreview();
    const pop = document.createElement("div");
    pop.className = "link-preview";
    pop.setAttribute("role", "tooltip");
    pop.innerHTML = `<strong>Library e-books</strong><p>Borrow e-books and audiobooks with your library card. Holds, renewals and returns.</p><span>library.example/ebooks</span>`;
    $(".app").appendChild(pop);
    const r = card.getBoundingClientRect();
    const host = $(".app").getBoundingClientRect();
    pop.style.left = `${r.left - host.left}px`;
    pop.style.top = `${r.bottom - host.top + 6}px`;
  }
  const hideLinkPreview = () => $(".link-preview")?.remove();

  // Wiring ---------------------------------------------------------------------------------------------------

  document.addEventListener("click", async (event) => {
    const t = event.target;
    if (menu && !t.closest(".artifact-menu") && !t.closest("[data-artifact-menu]")) closeMenu(false);

    if (viewer && t.closest(".viewer")) {
      const v = t.closest("[data-v]")?.dataset.v;
      const id = viewer.dataset.id;
      if (v === "close") return closeViewer();
      if (v === "next") return move(1);
      if (v === "prev") return move(-1);
      if (v === "go") return renderViewer(viewer._ids, +t.closest("[data-v]").dataset.n);
      if (v === "download") return save(A[id]);
      if (v === "copy") return copyImage(A[id]);
      if (v === "play") {
        const b = t.closest("[data-v]");
        const on = b.getAttribute("aria-pressed") !== "true";
        b.setAttribute("aria-pressed", String(on));
        b.setAttribute("aria-label", on ? "Pause" : "Play");
        b.innerHTML = icon(on ? "pause" : "play");
        $(".video-time", viewer).textContent = `${on ? "0:03" : "0:03"} / ${A[id].duration}`;
        return;
      }
      if (v === "speed") {
        const b = t.closest("[data-v]");
        const m = document.createElement("ul");
        m.className = "menu speed-menu";
        m.setAttribute("role", "menu");
        m.setAttribute("aria-label", "Speed");
        m.innerHTML = ["0.5×", "1×", "1.5×", "2×"].map((s) => `<li role="none"><button type="button" class="menu-item" role="menuitemradio" aria-checked="${s === speed}" data-speed="${s}">${s}<span class="glyph" data-state="check"></span></button></li>`).join("");
        $(".video-bar", viewer).appendChild(m);
        b.setAttribute("aria-expanded", "true");
        return $('[aria-checked="true"]', m).focus();
      }
      const s = t.closest("[data-speed]");
      if (s) {
        speed = s.dataset.speed; // kept for the session
        $(".speed-menu", viewer)?.remove();
        const b = $('[data-v="speed"]', viewer);
        b.textContent = speed;
        b.setAttribute("aria-label", `Speed: ${speed}`);
        b.setAttribute("aria-expanded", "false");
        CT.announce(`Speed ${speed}`);
        return b.focus();
      }
      const img = t.closest(".viewer-image");
      if (img) img.dataset.zoom = img.dataset.zoom === "fit" ? "actual" : "fit";
      return;
    }

    const mi = t.closest(".artifact-menu [data-mi]");
    if (mi) {
      const id = mi.dataset.id;
      const what = mi.dataset.mi;
      const opener = menuOpener;
      closeMenu(what !== "open" && what !== "files");
      if (what === "open") return A[id].kind === "image" || A[id].kind === "video" ? openViewer(id, opener) : openArtifact(id);
      if (what === "download") return save(A[id]);
      if (what === "browser") return CT.toast(`Opens ${A[id].name} at ${A[id].external} in your browser. Nothing is fetched before that.`);
      if (what === "save") return save(A[id], "Saved");
      if (what === "copy-image") return copyImage(A[id]);
      if (what === "copy-text") {
        try {
          await navigator.clipboard.writeText(A[id].content);
          CT.announce(`Copied ${A[id].name}`);
        } catch {
          CT.announce("Couldn't copy.");
        }
        return;
      }
      if (what === "files") return showInFiles(id);
      if (what === "all") return downloadAll(byTask(mi.dataset.task).filter((k) => A[k].msg === mi.dataset.msg));
    }

    const menuButton = t.closest("[data-artifact-menu]");
    if (menuButton) {
      if (menu && menuOpener === menuButton) return closeMenu();
      const r = menuButton.getBoundingClientRect();
      return openMenu(menuButton.dataset.artifactMenu, menuButton, r.right - 232, r.bottom + 6);
    }
    const play = t.closest("[data-play]");
    if (play) return togglePlay(play.dataset.play, play);
    const openA = t.closest("[data-open-artifact]");
    if (openA) return openArtifact(openA.dataset.openArtifact);
    const view = t.closest("[data-viewer]");
    if (view) return openViewer(view.dataset.viewer, view, +view.dataset.page || undefined);
    const link = t.closest("[data-link]");
    if (link) return CT.toast(`Opens ${link.dataset.link} in your browser. Nothing is fetched before that.`);
    const showCard = t.closest("[data-show-card]");
    if (showCard) {
      const card = document.getElementById(`card-${showCard.dataset.showCard}`);
      if (!card) return;
      W.reveal(card, $(".artifact-main", card) || card);
      return CT.announce("Showing it in the chat");
    }
    const art = t.closest("#panel-files [data-art]")?.dataset.art;
    if (art) {
      const level = W.paneFor(W.current()).stack.at(-1);
      const a = A[level.path];
      if (art === "download") return save(a);
      if (art === "browser") return CT.toast(`Opens ${a.name} at ${a.external} in your browser. Nothing is fetched before that.`);
      if (art === "copy") {
        if (a.kind === "image") return copyImage(a);
        return W.copyText(a.content, a.name, t.closest("[data-art]"), ".code-view, .reader-preview");
      }
      if (art === "retry") {
        level.state = "loading";
        W.rerender();
        return setTimeout(() => {
          level.state = undefined;
          loaded.add(level.path);
          W.rerender();
          $("#files-title")?.focus();
        }, 250);
      }
    }
  });

  function showInFiles(id) {
    const st = W.paneFor(W.current());
    st.stack = [];
    window.app.setPanel(true);
    window.app.setTab("files");
    W.rerender(`a:${id}`);
    const row = $(`[data-key="a:${id}"]`);
    if (row) {
      row.scrollIntoView({ block: "center" });
      row.dataset.flash = "true";
      setTimeout(() => (row.dataset.flash = "false"), 1600);
      row.focus();
    }
  }

  document.addEventListener("contextmenu", (event) => {
    const card = event.target.closest("[data-artifact]");
    if (!card || event.target.closest("#panel-files")) return;
    event.preventDefault();
    openMenu(card.dataset.artifact, $(".artifact-more", card) || card, event.clientX, event.clientY);
  });

  document.addEventListener("pointerover", (event) => {
    const card = event.target.closest('[data-kind="link"]');
    clearTimeout(previewTimer);
    if (card) previewTimer = setTimeout(() => showLinkPreview(card), 500);
    else hideLinkPreview();
  });

  document.addEventListener(
    "keydown",
    (event) => {
      const t = event.target;
      if (viewer) {
        const speedMenu = $(".speed-menu", viewer);
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (speedMenu) {
            speedMenu.remove();
            return $('[data-v="speed"]', viewer).focus();
          }
          return closeViewer();
        }
        if (speedMenu && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          const items = $$(".menu-item", speedMenu);
          const i = items.indexOf(document.activeElement);
          return items[(i + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
        }
        if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && viewer._ids.length > 1 && !t.closest(".video-track")) {
          event.preventDefault();
          return move(event.key === "ArrowRight" ? 1 : -1);
        }
        if ((event.metaKey || event.ctrlKey) && event.key === "s" && A[viewer.dataset.id] && fetchable(A[viewer.dataset.id])) {
          event.preventDefault();
          return save(A[viewer.dataset.id], "Saved");
        }
        if (event.key === "Tab") {
          const items = $$("button, [tabindex='0']", viewer);
          const first = items[0];
          const last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
        return;
      }
      if (menu) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          return closeMenu();
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const items = $$(".menu-item", menu);
          const i = items.indexOf(document.activeElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (i + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          return items[next].focus();
        }
        if (event.key === "Tab") closeMenu(false);
      }
      const card = t.closest?.("[data-artifact]");
      if (card && !t.closest("#panel-files") && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
        event.preventDefault();
        const r = t.getBoundingClientRect();
        return openMenu(card.dataset.artifact, $(".artifact-more", card) || t, r.left + 20, r.bottom + 4);
      }
    },
    true,
  );

  // The gateway's thumbnail for a large picture arrives a moment after the card is drawn.
  W.ready = () => {
    if (params.get("thumbs") !== "failed")
      setTimeout(() => {
        thumbsReady = true;
        $$('.media-cell[aria-busy="true"]').forEach((cell) => {
          const tmp = document.createElement("div");
          tmp.innerHTML = mediaCell(cell.dataset.viewer);
          cell.replaceWith(tmp.firstElementChild);
        });
      }, params.get("thumbs") === "loading" ? 60000 : 600);
    const artifact = params.get("artifact");
    if (artifact && A[artifact]) setTimeout(() => openArtifact(artifact));
    const v = params.get("viewer");
    if (v && (A[v] || v === "page")) setTimeout(() => openViewer(v));
    if (params.get("menu") === "artifact") {
      setTimeout(() => {
        const id = params.get("menuitem") || "a-usage";
        const card = document.getElementById(`card-${id}`);
        card.scrollIntoView({ block: "center" });
        const opener = $(".artifact-more", card) || $(".media-more", card.closest(".media-grid")) || card;
        const r = opener.getBoundingClientRect();
        openMenu(id, opener, r.right - 232, r.bottom + 6);
      });
    }
  };

  W.artifacts = A;
  W.openArtifact = openArtifact;
})();
