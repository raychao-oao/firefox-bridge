// repo/firefox-bridge-bot/scripts/read-url-fast.js
import { z } from 'zod';

export default {
  name: 'read_url_fast',
  description:
    'Read up to 10 URLs fast: opens one private browsing window, visits ' +
    "URLs in batches of `concurrency` (default 3, max 5) within that same " +
    "window, extracts each page's content via Firefox's Reader View engine " +
    '(falling back to raw visible text for non-article pages), then closes ' +
    'the window automatically. Fully rule-based -- no AI judgment happens ' +
    "mid-run. A single URL's failure (unreachable, extraction failure) is " +
    "recorded in that URL's own result slot (at the same index as its " +
    'position in the input `urls` array, regardless of completion order) ' +
    "and does not abort the rest of the batch. Requires the extension's " +
    '"Run in Private Windows" toggle enabled in about:addons -- without it, ' +
    'this returns a top-level {ok:false, error:"private_window_access_denied"} ' +
    'before opening anything (this is a setup failure, distinct from a ' +
    'per-URL failure inside `results`). A successful result entry may also ' +
    'carry `truncated: true` (content was cut at ~500,000 chars) and/or ' +
    "`urlPending: true` (the tab's navigation hadn't been confirmed committed " +
    'when it was read, so the content may be stale or incomplete). Every ' +
    'response (success or failure) also carries `startedAt`/`finishedAt` ' +
    '(ISO timestamps) and `durationMs`, covering the full call from connect ' +
    'through cleanup.',
  inputSchema: {
    urls: z.array(z.string().url()).min(1).max(10),
    concurrency: z.number().int().min(1).max(5).optional(),
  },

  async run({ urls, concurrency = 3 }, bridge) {
    // Opened BLANK (no `url`) deliberately -- open_private_window does not
    // wait for navigation to commit the way acquire_tab does (up to 3s), so
    // special-casing the first URL through openPrivateWindow({url}) let the
    // first URL in a batch be read before it had actually navigated there,
    // silently producing {ok:true, source:'page', text:''}. Routing every
    // URL (including the first) through acquireTab() gives every URL the
    // same 3s commit-wait guarantee. (Found in final whole-branch review.)
    const opened = await bridge.openPrivateWindow({});
    if (!opened.ok) {
      // Setup failure: there is no window/session to continue with, so this
      // is a top-level failure, not a per-URL one. index.js turns this
      // `topLevelError` field into the top-level {ok:false, error} shape.
      return { topLevelError: opened.error };
    }

    const { windowId } = opened;
    const results = new Array(urls.length);
    // Every tab opened this run -- the initial blank one plus every URL tab
    // -- is closed together at the very end, in one sweep. Concurrent tabs
    // can't reuse the "close the previous tab once the next one is read"
    // chaining the sequential version used, since multiple tabs are alive
    // at once; keeping the blank tab alive the whole run instead of
    // special-casing its closure keeps the window's tab count >=1 at all
    // times with no extra bookkeeping.
    const tabIdsToClose = [opened.tabId];

    async function readUrl(url, index) {
      const acquired = await bridge.acquireTab({ url, windowId });
      if (!acquired.ok) {
        results[index] = { url, ok: false, error: acquired.error };
        return;
      }
      const tabId = acquired.tabId;
      tabIdsToClose.push(tabId);

      // Non-fatal: a network-idle timeout does not abort this URL, the
      // script just proceeds to read whatever is there.
      await bridge.waitForNetworkIdle(tabId, { timeoutMs: 8000 });

      const article = await bridge.readArticle(tabId, { frameId: 0 });
      if (article.ok) {
        results[index] = {
          url,
          ok: true,
          source: 'article',
          title: article.title,
          text: article.text,
          truncated: article.truncated,
          totalLength: article.totalLength,
          urlPending: acquired.urlPending,
        };
      } else if (article.error === 'not_an_article') {
        const page = await bridge.readPage(tabId, { frameId: 0 });
        if (page.ok) {
          results[index] = {
            url,
            ok: true,
            source: 'page',
            text: page.text,
            truncated: page.truncated,
            totalLength: page.totalLength,
            urlPending: acquired.urlPending,
          };
        } else {
          results[index] = { url, ok: false, error: page.error };
        }
      } else {
        results[index] = { url, ok: false, error: article.error };
      }
    }

    // Batched concurrency, not a live work-stealing pool: batch N+1 doesn't
    // start until every URL in batch N has finished. Simpler than a real
    // pool (no extra queueing/slot-refill logic, no dependency), at the
    // cost of a slow URL in a batch holding up already-finished siblings in
    // the same batch. Acceptable at this concurrency ceiling (<=5).
    for (let i = 0; i < urls.length; i += concurrency) {
      const batch = urls.slice(i, i + concurrency).map((url, j) => readUrl(url, i + j));
      await Promise.all(batch);
    }

    // Closing order doesn't matter -- whichever tab happens to close last
    // takes the private window down with it.
    await Promise.all(tabIdsToClose.map((tabId) => bridge.closeTab(tabId)));

    return { results };
  },
};
