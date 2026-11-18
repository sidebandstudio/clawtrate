// A watch over one bot's browser: the plugin's own connection to the browser
// itself, attached to every tab, with page events on. It tells a take
// whether anything the plugin can see is still unresolved in that browser: a
// download in progress, or a tab still loading a page (including one whose
// page events Chromium holds back because a navigation is pending).
//
// It changes nothing in the browser: `Target.setAutoAttach` without pausing
// new tabs, and `Page.enable` on each tab. It never sets the download
// behaviour, which the gateway's own client owns.

import { openBrowserCdp } from "./cdp.js";

/**
 * Open a watch on `bot`'s browser. Resolves once it is attached to the tabs
 * open now; rejects with a CdpError when the browser cannot be watched.
 * `onChange` is called whenever what it sees changes.
 */
export async function watchBrowser(bot, options = {}) {
  const { onChange = () => {} } = options;
  const cdp = await openBrowserCdp(bot, options);
  /** sessionId -> { targetId, loading: Set<frameId>, enabling: boolean } */
  const tabs = new Map();
  /** download guid -> sessionId */
  const downloads = new Map();
  const changed = () => {
    try {
      onChange();
    } catch {
      // a listener's failure must not stop the watch
    }
  };

  cdp.on((message) => {
    const { method, params = {}, sessionId } = message;
    if (method === "Target.attachedToTarget") {
      const info = params.targetInfo ?? {};
      if (info.type !== "page" || typeof params.sessionId !== "string") return;
      const tab = { targetId: info.targetId, loading: new Set(), enabling: true };
      tabs.set(params.sessionId, tab);
      changed();
      // Chromium answers this only once a pending navigation in the tab has
      // ended, so until then the tab counts as loading.
      cdp
        .send("Page.enable", {}, { sessionId: params.sessionId })
        .then(
          () => (tab.enabling = false),
          () => {
            // A tab that cannot be watched stays unresolved until it goes.
          },
        )
        .finally(changed);
      return;
    }
    if (method === "Target.detachedFromTarget") {
      if (tabs.delete(params.sessionId)) {
        // A closed tab's downloads can no longer be observed through it.
        for (const [guid, owner] of downloads)
          if (owner === params.sessionId) downloads.delete(guid);
        changed();
      }
      return;
    }
    const tab = tabs.get(sessionId);
    if (!tab) return;
    if (method === "Page.frameStartedLoading") tab.loading.add(params.frameId);
    else if (method === "Page.frameStoppedLoading") tab.loading.delete(params.frameId);
    else if (method === "Page.downloadWillBegin") downloads.set(params.guid, sessionId);
    else if (method === "Page.downloadProgress") {
      if (params.state === "inProgress") downloads.set(params.guid, sessionId);
      else downloads.delete(params.guid);
    } else return;
    changed();
  });
  cdp.onClose(changed);

  try {
    await cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  } catch (error) {
    cdp.close();
    throw error;
  }

  return {
    get closed() {
      return cdp.closed;
    },
    /**
     * What is unresolved now, or null: "download" while a download is in
     * progress, "loading" while a tab is loading; "closed" once the watch has
     * lost the browser.
     */
    unresolved() {
      if (cdp.closed) return "closed";
      if (downloads.size > 0) return "download";
      for (const tab of tabs.values()) if (tab.enabling || tab.loading.size > 0) return "loading";
      return null;
    },
    onClose: (fn) => cdp.onClose(fn),
    close: () => cdp.close(),
  };
}
