// repo/firefox-bridge-bot/scripts/read-news.js
import { z } from 'zod';

// Known LTN (自由時報) category listing slugs -- verified 2026-08-12. Most
// live under news.ltn.com.tw/list/breakingnews/{slug}; "business" (財經) is
// its own subdomain (ec.ltn.com.tw) with a differently-shaped article URL,
// verified separately the same day. Other subdomain-only sections (體育
// sports.ltn.com.tw, 娛樂 ent.ltn.com.tw, ...) are NOT covered -- add them
// the same way as "business" once verified, don't guess the URL shape.
//
// Each entry's urlPattern is pinned to that category's own path/domain --
// a category listing page mixes in "熱門"/trending links from OTHER
// categories alongside its own (found 2026-08-12 testing category:
// "politics", which returned an unrelated world-news and society-news
// article among 5 matches before this was pinned down). "all"/"popular"
// have no single category to pin to, so they keep a broader (but still
// news.ltn.com.tw-scoped) pattern.
const LTN_CATEGORY_CONFIG = {
  all: {
    listingUrl: 'https://news.ltn.com.tw/list/breakingnews/all',
    urlPattern: '^https://news\\.ltn\\.com\\.tw/news/[a-zA-Z]+/breakingnews/\\d+$',
  },
  popular: {
    listingUrl: 'https://news.ltn.com.tw/list/breakingnews/popular',
    urlPattern: '^https://news\\.ltn\\.com\\.tw/news/[a-zA-Z]+/breakingnews/\\d+$',
  },
  politics: {
    listingUrl: 'https://news.ltn.com.tw/list/breakingnews/politics',
    urlPattern: '^https://news\\.ltn\\.com\\.tw/news/politics/breakingnews/\\d+$',
  },
  world: {
    listingUrl: 'https://news.ltn.com.tw/list/breakingnews/world',
    urlPattern: '^https://news\\.ltn\\.com\\.tw/news/world/breakingnews/\\d+$',
  },
  society: {
    listingUrl: 'https://news.ltn.com.tw/list/breakingnews/society',
    urlPattern: '^https://news\\.ltn\\.com\\.tw/news/society/breakingnews/\\d+$',
  },
  life: {
    listingUrl: 'https://news.ltn.com.tw/list/breakingnews/life',
    urlPattern: '^https://news\\.ltn\\.com\\.tw/news/life/breakingnews/\\d+$',
  },
  local: {
    listingUrl: 'https://news.ltn.com.tw/list/breakingnews/local',
    urlPattern: '^https://news\\.ltn\\.com\\.tw/news/local/breakingnews/\\d+$',
  },
  novelty: {
    listingUrl: 'https://news.ltn.com.tw/list/breakingnews/novelty',
    urlPattern: '^https://news\\.ltn\\.com\\.tw/news/novelty/breakingnews/\\d+$',
  },
  // 財經 -- own subdomain, own article path shape (/article/breakingnews/id
  // instead of /news/{cat}/breakingnews/id), and hot-news widget links carry
  // a ?utm_campaign=... query string that the pattern must still match.
  business: {
    listingUrl: 'https://ec.ltn.com.tw/list/breakingnews',
    urlPattern: '^https://ec\\.ltn\\.com\\.tw/article/breakingnews/\\d+(\\?.*)?$',
  },
};
// Matches LTN's real article URL shapes across every subdomain -- used only
// for keyword search, where results legitimately span multiple subdomains
// (news.ltn.com.tw/news/politics/breakingnews/123, ec.ltn.com.tw/article/
// breakingnews/123, 3c.ltn.com.tw/news/123, talk.ltn.com.tw/article/
// breakingnews/123, ...). Verified 2026-08-12 against a keyword search
// result page.
const LTN_SEARCH_ARTICLE_PATTERN =
  '^https://[a-z0-9]+\\.ltn\\.com\\.tw/(article|news)/(\\d+|[a-zA-Z]+/breakingnews/\\d+)$';

// PTS (公視新聞網) category IDs -- verified 2026-08-12 against news.pts.org.tw's
// own nav. Unlike LTN, PTS article URLs are just news.pts.org.tw/article/{id}
// with NO category segment in the path, so urlPattern can't be pinned per
// category the way LTN's can -- every PTS category shares the same pattern
// and relies on the listing page itself being on-topic (spot-checked
// category/1 "政治" on 2026-08-12: all listed headlines were genuinely
// political, no cross-category "熱門" mixing like LTN had -- but this is an
// empirical observation, not a structural guarantee like LTN's URL pinning).
// No keyword search wired up -- /search?query= returned no result links when
// tried 2026-08-12 (likely client-side rendered); revisit if actually needed.
const PTS_ARTICLE_PATTERN = '^https://news\\.pts\\.org\\.tw/article/\\d+$';
const PTS_CATEGORY_IDS = {
  politics: 1,
  environment: 3,
  world: 4, // 全球
  life: 5,
  edu_tech: 6, // 文教科技
  society: 7,
  cross_strait: 9, // 兩岸
  business: 10, // 產經
  local: 11,
  welfare: 12, // 社福人權
};
const PTS_CATEGORY_CONFIG = {
  all: { listingUrl: 'https://news.pts.org.tw/dailynews', urlPattern: PTS_ARTICLE_PATTERN },
  ...Object.fromEntries(
    Object.entries(PTS_CATEGORY_IDS).map(([name, id]) => [
      name,
      { listingUrl: `https://news.pts.org.tw/category/${id}`, urlPattern: PTS_ARTICLE_PATTERN },
    ])
  ),
};

// Real RSS feeds, verified 2026-08-13 (firefox-bridge v0.3.10 added XML/RSS
// serialization support to read_page/read_article -- before that these were
// unreadable, see [[mcp_firefox_bridge_setup]]). Feed mode is strictly
// better than the scrape config above where it's available: a feed's <item>
// list IS the article set, no "熱門"/trending cross-category links mixed in
// (the reason LTN's scrape urlPattern had to be pinned per-category in the
// first place), and it comes with a real pubDate for free.
//
// LTN: /rss/{category}.xml exists for every LTN_CATEGORY_CONFIG slug except
// "popular" (confirmed 404 -- LTN doesn't publish a popular/trending feed).
// "business" is served from the news.ltn.com.tw feed even though its actual
// article links point at ec.ltn.com.tw, same cross-subdomain shape as the
// scrape config.
const LTN_FEED_CATEGORIES = {
  all: 'https://news.ltn.com.tw/rss/all.xml',
  politics: 'https://news.ltn.com.tw/rss/politics.xml',
  world: 'https://news.ltn.com.tw/rss/world.xml',
  society: 'https://news.ltn.com.tw/rss/society.xml',
  life: 'https://news.ltn.com.tw/rss/life.xml',
  local: 'https://news.ltn.com.tw/rss/local.xml',
  novelty: 'https://news.ltn.com.tw/rss/novelty.xml',
  business: 'https://news.ltn.com.tw/rss/business.xml',
};
// PTS only publishes one feed, no per-category variant found (tried several
// URL shapes 2026-08-13, all 404) -- category requests other than "all"
// fall back to the scrape config below.
const PTS_FEED_CATEGORIES = {
  all: 'https://news.pts.org.tw/xml/newsfeed.xml',
};

// Per-source category maps + optional keyword-search resolver. `category`
// names are shared across sources where they mean the same thing (politics,
// world, society, life, local, business, all) so callers don't need to
// remember which source uses which label; each source only recognizes the
// categories present in its own config, so an unsupported combination
// (e.g. source:"pts" + category:"novelty") resolves to null below.
const SOURCES = {
  ltn: {
    categories: LTN_CATEGORY_CONFIG,
    feeds: LTN_FEED_CATEGORIES,
    keywordUrl: (kw) => `https://search.ltn.com.tw/list?keyword=${encodeURIComponent(kw)}&sort=date&type=all`,
    searchPattern: LTN_SEARCH_ARTICLE_PATTERN,
  },
  pts: {
    categories: PTS_CATEGORY_CONFIG,
    feeds: PTS_FEED_CATEGORIES,
    keywordUrl: null,
    searchPattern: null,
  },
};
// Union of every category name valid for at least one source -- the zod
// enum below; resolveSource() is what actually enforces per-source validity.
const ALL_CATEGORIES = [...new Set(Object.values(SOURCES).flatMap((s) => Object.keys(s.categories)))];

// Keyword search has no feed equivalent (LTN doesn't publish one for
// search results) so it always resolves to scrape mode. A category with a
// feed resolves to feed mode; otherwise it falls back to scrape mode --
// this is why LTN's "popular" and every PTS category but "all" still work,
// just via the older listing-page-scrape path.
function resolveSource({ source, category, keyword }) {
  const src = SOURCES[source];
  if (!src) return null;
  if (keyword) {
    if (!src.keywordUrl) return null;
    return { mode: 'scrape', listingUrl: src.keywordUrl(keyword), urlPattern: src.searchPattern };
  }
  const cat = category || 'all';
  if (src.feeds?.[cat]) return { mode: 'feed', feedUrl: src.feeds[cat] };
  if (src.categories[cat]) return { mode: 'scrape', ...src.categories[cat] };
  return null;
}

// Minimal regex-based RSS 2.0 / Atom parser -- no DOM parser is available
// here (this runs in the MCP server process, not in-page), and read_page's
// XMLSerializer output is well-formed enough that hand-rolled tag
// extraction is reliable in practice. Atom (PTS) uses <entry> with
// <link rel="alternate" href="..."/>; RSS 2.0 (LTN) uses <item> with
// <link>URL as text content</link>. Both wrap text fields in CDATA
// sometimes and not other times, so extractTag() unwraps CDATA if present.
function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  if (!m) return null;
  let content = m[1].trim();
  const cdata = content.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) content = cdata[1];
  return decodeEntities(content.trim()) || null;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseFeedItems(xmlText, feedUrl) {
  const isAtom = /<entry[\s>]/.test(xmlText) && !/<item[\s>]/.test(xmlText);
  const blockTag = isAtom ? 'entry' : 'item';
  const blocks = [...xmlText.matchAll(new RegExp(`<${blockTag}[^>]*>([\\s\\S]*?)</${blockTag}>`, 'g'))].map(
    (m) => m[1]
  );
  return blocks
    .map((block) => {
      const title = extractTag(block, 'title');
      let link = null;
      if (isAtom) {
        const m =
          block.match(/<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["']/) ||
          block.match(/<link\b[^>]*\bhref=["']([^"']+)["']/);
        link = m ? m[1] : null;
      } else {
        link = extractTag(block, 'link');
      }
      if (!link) return null;
      let resolvedUrl;
      try {
        resolvedUrl = new URL(link, feedUrl).toString();
      } catch {
        return null;
      }
      return {
        url: resolvedUrl,
        title,
        pubDate: extractTag(block, 'pubDate') || extractTag(block, 'updated') || extractTag(block, 'published'),
        description: extractTag(block, 'description') || extractTag(block, 'summary'),
      };
    })
    .filter(Boolean);
}

export default {
  name: 'read_news',
  description:
    'Find news article links, then bulk-read up to `maxArticles` of them -- one ' +
    'tool call covers discovery through full text, no AI-in-the-loop between ' +
    'finding URLs and reading them. Three ways to point it at articles, tried ' +
    'in this order: (1) `feedUrl` -- any RSS 2.0 or Atom feed URL, parsed ' +
    'directly (title/link/pubDate/description per item), no link-guessing ' +
    'needed since a feed already IS the article list; (2) `source`+' +
    '`category`/`keyword` -- built-in sources are source:"ltn" (自由時報, ' +
    `categories [${Object.keys(LTN_CATEGORY_CONFIG).join(', ')}], plus free-text ` +
    '`keyword` search) and source:"pts" (公視新聞網, categories ' +
    `[${Object.keys(PTS_CATEGORY_CONFIG).join(', ')}], no keyword search yet); ` +
    'internally each category resolves to feed mode where a real RSS feed ' +
    `exists (ltn: every category except "popular"; pts: only "all") and falls ` +
    'back to scrape mode otherwise -- feed mode is preferred automatically ' +
    'since it has no cross-category mixing and gives real pubDates, this is ' +
    'not something the caller needs to choose; (3) manual `listingUrl`+' +
    '`urlPattern` (scrape mode) for any other site without an RSS feed -- ' +
    "`urlPattern` is a JS regex tested against each link's fully-resolved " +
    'absolute URL, filtering out nav/category/login/ad links entirely in ' +
    "code, not by an AI eyeballing the raw link list. Note PTS's own scrape-" +
    'mode categories (i.e. anything but "all") have no category segment in ' +
    'their article URLs, so that fallback path is weaker than LTN\'s (relies ' +
    'on the listing page itself being on-topic, not a URL-structural ' +
    'guarantee). Whichever mode resolves, step 2 opens one private window and ' +
    'bulk-reads the surviving links the same way `read_url_fast` does (Reader ' +
    'View extraction, plain-text fallback, batched concurrency). Each result ' +
    'carries `listingTitle` (feed/listing-page title) alongside whatever ' +
    "title the article page itself reports, plus `pubDate`/`description` " +
    'when the source was a feed. Returns {ok:true, matchedCount, ' +
    'articles:[...]} on success, or a top-level {ok:false, error} for setup ' +
    'failures (unknown source/category, bad feed/listing URL, zero items ' +
    'found, private-window access denied).',
  inputSchema: {
    source: z.enum(['ltn', 'pts']).optional().describe('Built-in source to resolve a feed or listingUrl/urlPattern from.'),
    category: z
      .enum(ALL_CATEGORIES)
      .optional()
      .describe(
        'Only used with a built-in `source` when keyword is not given. Defaults to "all". ' +
          'Must be one of the categories that source actually supports (ltn vs pts support ' +
          'different subsets) -- an unsupported combination resolves to an error, not a fallback.'
      ),
    keyword: z.string().optional().describe('Only used with source:"ltn" (pts has no keyword search yet) -- free-text search, takes priority over category. Always scrape mode, no feed equivalent.'),
    feedUrl: z.string().url().optional().describe('Manual override: any RSS 2.0 or Atom feed URL. Takes priority over source and listingUrl/urlPattern.'),
    listingUrl: z.string().url().optional().describe('Manual override (scrape mode): any listing/search page URL. Pair with urlPattern. Ignored if feedUrl or source is given.'),
    urlPattern: z
      .string()
      .optional()
      .describe(
        'Manual override (scrape mode): JS regex source (no slashes/flags) tested against each ' +
          "link's absolute URL. Required alongside listingUrl."
      ),
    maxArticles: z.number().int().min(1).max(10).optional(),
    concurrency: z.number().int().min(1).max(5).optional(),
  },

  async run(input, bridge) {
    const { maxArticles = 8, concurrency = 3 } = input;

    let resolved;
    if (input.feedUrl) {
      resolved = { mode: 'feed', feedUrl: input.feedUrl };
    } else if (input.source) {
      resolved = resolveSource(input);
    } else if (input.listingUrl && input.urlPattern) {
      resolved = { mode: 'scrape', listingUrl: input.listingUrl, urlPattern: input.urlPattern };
    } else {
      resolved = null;
    }
    if (!resolved) {
      return { topLevelError: 'unresolved_source_or_missing_manual_params' };
    }

    // One private window for the whole run -- opened once here, every tab
    // (feed/listing page + every article) lives in it, and everything
    // closes together in one sweep at the end. Keeps the feed/listing fetch
    // out of the user's real browsing session/history too, same as the
    // article reads.
    const opened = await bridge.openPrivateWindow({});
    if (!opened.ok) {
      return { topLevelError: opened.error };
    }
    const { windowId } = opened;
    const tabIdsToClose = [opened.tabId];

    // entries: [{ url, listingTitle, pubDate, description }]
    let entries;

    if (resolved.mode === 'feed') {
      const { feedUrl } = resolved;
      const feedTab = await bridge.acquireTab({ url: feedUrl, windowId });
      if (!feedTab.ok) {
        await Promise.all(tabIdsToClose.map((tabId) => bridge.closeTab(tabId)));
        return { topLevelError: feedTab.error };
      }
      tabIdsToClose.push(feedTab.tabId);

      const page = await bridge.readPage(feedTab.tabId, { frameId: 0 });
      if (!page.ok || !page.text) {
        await Promise.all(tabIdsToClose.map((tabId) => bridge.closeTab(tabId)));
        return { topLevelError: page.ok ? 'empty_feed_response' : page.error };
      }

      const items = parseFeedItems(page.text, feedUrl);
      if (items.length === 0) {
        await Promise.all(tabIdsToClose.map((tabId) => bridge.closeTab(tabId)));
        return { topLevelError: 'no_feed_items_found' };
      }
      // Dedup by URL (feeds don't usually repeat an item, but be safe).
      const seen = new Map();
      for (const it of items) {
        if (!seen.has(it.url)) {
          seen.set(it.url, { url: it.url, listingTitle: it.title || '', pubDate: it.pubDate, description: it.description });
        }
      }
      entries = [...seen.values()].slice(0, maxArticles);
    } else {
      const { listingUrl, urlPattern } = resolved;
      let pattern;
      try {
        pattern = new RegExp(urlPattern);
      } catch {
        await Promise.all(tabIdsToClose.map((tabId) => bridge.closeTab(tabId)));
        return { topLevelError: 'invalid_url_pattern' };
      }

      const listing = await bridge.acquireTab({ url: listingUrl, windowId });
      if (!listing.ok) {
        await Promise.all(tabIdsToClose.map((tabId) => bridge.closeTab(tabId)));
        return { topLevelError: listing.error };
      }
      tabIdsToClose.push(listing.tabId);

      const elementsResult = await bridge.listElements({ tabId: listing.tabId, filter: { tag: 'a' } });
      if (!elementsResult.ok) {
        await Promise.all(tabIdsToClose.map((tabId) => bridge.closeTab(tabId)));
        return { topLevelError: elementsResult.error };
      }

      // listElements with no frameId returns {frames: [...]}; flatten every
      // frame's elements into one list before filtering -- a listing page's
      // headlines are sometimes inside an iframe, not just the top document.
      const allLinks = (elementsResult.frames ?? []).flatMap((f) => f.elements ?? []);

      // Resolve every href against listingUrl (list_elements can return
      // relative hrefs) and keep only ones matching urlPattern, deduped by
      // resolved URL -- a listing page often links the same article twice
      // (image + headline).
      const seen = new Map(); // resolvedUrl -> listingTitle
      for (const el of allLinks) {
        if (!el.href) continue;
        let resolvedUrl;
        try {
          resolvedUrl = new URL(el.href, listingUrl).toString();
        } catch {
          continue;
        }
        if (!pattern.test(resolvedUrl)) continue;
        if (!seen.has(resolvedUrl)) {
          seen.set(resolvedUrl, el.text || '');
        }
      }

      entries = [...seen.entries()].slice(0, maxArticles).map(([url, listingTitle]) => ({ url, listingTitle }));
      if (entries.length === 0) {
        await Promise.all(tabIdsToClose.map((tabId) => bridge.closeTab(tabId)));
        return { topLevelError: 'no_links_matched_pattern' };
      }
    }

    const results = new Array(entries.length);

    async function readOne(entry, index) {
      const { url, listingTitle, pubDate, description } = entry;
      const acquired = await bridge.acquireTab({ url, windowId });
      if (!acquired.ok) {
        results[index] = { url, listingTitle, pubDate, description, ok: false, error: acquired.error };
        return;
      }
      const tabId = acquired.tabId;
      tabIdsToClose.push(tabId);

      await bridge.waitForNetworkIdle(tabId, { timeoutMs: 8000 });

      const article = await bridge.readArticle(tabId, { frameId: 0 });
      if (article.ok) {
        results[index] = {
          url,
          listingTitle,
          pubDate,
          description,
          ok: true,
          source: 'article',
          title: article.title,
          text: article.text,
          truncated: article.truncated,
          totalLength: article.totalLength,
          urlPending: acquired.urlPending,
        };
        return;
      }
      if (article.error === 'not_an_article') {
        const page = await bridge.readPage(tabId, { frameId: 0 });
        if (page.ok) {
          results[index] = {
            url,
            listingTitle,
            pubDate,
            description,
            ok: true,
            source: 'page',
            text: page.text,
            truncated: page.truncated,
            totalLength: page.totalLength,
            urlPending: acquired.urlPending,
          };
          return;
        }
        results[index] = { url, listingTitle, pubDate, description, ok: false, error: page.error };
        return;
      }
      results[index] = { url, listingTitle, pubDate, description, ok: false, error: article.error };
    }

    for (let i = 0; i < entries.length; i += concurrency) {
      const batch = entries.slice(i, i + concurrency).map((entry, j) => readOne(entry, i + j));
      await Promise.all(batch);
    }

    await Promise.all(tabIdsToClose.map((tabId) => bridge.closeTab(tabId)));

    return { mode: resolved.mode, matchedCount: entries.length, articles: results };
  },
};
