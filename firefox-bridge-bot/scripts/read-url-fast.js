// repo/firefox-bridge-bot/scripts/read-url-fast.js
import { z } from 'zod';

export default {
  name: 'read_url_fast',
  description:
    'Read up to 10 URLs fast: opens one private browsing window, visits each ' +
    "URL in turn (reusing the same window), extracts each page's content via " +
    "Firefox's Reader View engine (falling back to raw visible text for " +
    'non-article pages), then closes the window automatically. Fully ' +
    'rule-based -- no AI judgment happens mid-run. A single URL\'s failure ' +
    "(unreachable, extraction failure) is recorded in that URL's own result " +
    "slot and does not abort the rest of the batch. Requires the extension's " +
    '"Run in Private Windows" toggle enabled in about:addons -- without it, ' +
    'this returns a top-level {ok:false, error:"private_window_access_denied"} ' +
    'before opening anything (this is a setup failure, distinct from a ' +
    'per-URL failure inside `results`).',
  inputSchema: { urls: z.array(z.string().url()).min(1).max(10) },

  async run({ urls }, bridge) {
    const opened = await bridge.openPrivateWindow({ url: urls[0] });
    if (!opened.ok) {
      // Setup failure: there is no window/session to continue with, so this
      // is a top-level failure, not a per-URL one. index.js turns this
      // `topLevelError` field into the top-level {ok:false, error} shape.
      return { topLevelError: opened.error };
    }

    const { windowId } = opened;
    const results = [];
    // Starts undefined -- there is no "previous tab" until the first URL
    // has actually been read. (Found by use-codex plan review: an earlier
    // draft initialized this to opened.tabId and closed-then-advanced
    // immediately after acquireTab, before waiting/reading the new tab --
    // that closed tabs out of order relative to when their content was
    // actually extracted. The correct order is acquire -> wait/read -> close
    // the PREVIOUS tab -> advance previousTabId, so a tab is only ever
    // closed after its own content has been captured.)
    let previousTabId;

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      let tabId;

      if (i === 0) {
        tabId = opened.tabId;
      } else {
        const acquired = await bridge.acquireTab({ url, windowId });
        if (!acquired.ok) {
          // previousTabId deliberately NOT touched here -- the previously
          // opened tab is still the most recent live one, nothing new
          // exists yet to close it in favor of.
          results.push({ url, ok: false, error: acquired.error });
          continue;
        }
        tabId = acquired.tabId;
      }

      // Non-fatal: a network-idle timeout does not abort this URL, the
      // script just proceeds to read whatever is there.
      await bridge.waitForNetworkIdle(tabId, { timeoutMs: 8000 });

      const article = await bridge.readArticle(tabId, { frameId: 0 });
      if (article.ok) {
        results.push({ url, ok: true, source: 'article', title: article.title, text: article.text });
      } else if (article.error === 'not_an_article') {
        const page = await bridge.readPage(tabId, { frameId: 0 });
        if (page.ok) {
          results.push({ url, ok: true, source: 'page', text: page.text });
        } else {
          results.push({ url, ok: false, error: page.error });
        }
      } else {
        results.push({ url, ok: false, error: article.error });
      }

      // Close the PREVIOUS tab only now that THIS tab's content has been
      // fully captured, so the window always has >=1 tab alive and nothing
      // is ever closed before its own read completes.
      if (previousTabId !== undefined) {
        await bridge.closeTab(previousTabId);
      }
      previousTabId = tabId;
    }

    // Close the last remaining tab -- this also closes the private window,
    // since it's the window's last tab.
    await bridge.closeTab(previousTabId);

    return { results };
  },
};
