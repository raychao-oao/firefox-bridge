// repo/firefox-bridge-bot/scripts/get-weather.js
import { z } from 'zod';

// CWA (中央氣象署) 縣市預報頁面的 CID 代碼 -- 從
// https://www.cwa.gov.tw/V8/C/W/County/index.html 的縣市預報列表真實連結
// 逐一核對取得，verified 2026-08-19. 這頁是唯一一個對每個縣市給出真實
// <a href="...CID=...">（而不是首頁那種 javascript:void(0) 的 SPA 點擊）
// 的地方，其他頁面不要拿來猜 CID。
const CITY_TO_CID = {
  基隆市: '10017',
  臺北市: '63',
  新北市: '65',
  桃園市: '68',
  新竹市: '10018',
  新竹縣: '10004',
  苗栗縣: '10005',
  臺中市: '66',
  彰化縣: '10007',
  南投縣: '10008',
  雲林縣: '10009',
  嘉義市: '10020',
  嘉義縣: '10010',
  臺南市: '67',
  高雄市: '64',
  屏東縣: '10013',
  宜蘭縣: '10002',
  花蓮縣: '10015',
  臺東縣: '10014',
  澎湖縣: '10016',
  金門縣: '09020',
  連江縣: '09007',
};
const CITY_NAMES = Object.keys(CITY_TO_CID);

// Accepts common variants without forcing the caller to know the exact
// official name: trims whitespace, normalizes 台->臺 (CWA's own site always
// uses 臺), and if given a bare county name without 市/縣 (e.g. "新竹")
// resolves it only when exactly one CITY_NAMES entry starts with it --
// "新竹" alone is genuinely ambiguous (新竹市 vs 新竹縣) and must fail with
// both options rather than silently guessing.
function resolveCity(input) {
  const normalized = input.trim().replace(/台/g, '臺');
  if (CITY_TO_CID[normalized]) return { name: normalized, cid: CITY_TO_CID[normalized] };
  const matches = CITY_NAMES.filter((name) => name.startsWith(normalized));
  if (matches.length === 1) return { name: matches[0], cid: CITY_TO_CID[matches[0]] };
  return { ambiguous: matches.length > 1 ? matches : null };
}

// The county page's short-term forecast widget always renders exactly these
// three period labels in this order, each followed by "低-高\n降雨機率\nN%\n
// 舒適度描述" -- verified 2026-08-19 against 新竹市 (CID=10018). This is a
// text-extraction regex over read_page's plain-text output (the widget is
// Vue-rendered, not present in raw HTML, so this only works because the
// bridge reads the live post-render DOM), not an HTML/DOM parse -- fragile
// to a CWA copy change, but the labels are semantic/functional strings
// unlikely to be reworded casually.
const PERIOD_PATTERN = /(今晚明晨|明日白天|明日晚上)\n(\d+) ?- ?(\d+)\n降雨機率\n(\d+)%\n([^\n]+)/g;

// The one-line overall description sits right before "看更多" in the same
// widget, e.g. "多雲時陰短暫陣雨或雷雨，天氣整體舒適，但仍有降雨機率" --
// verified 2026-08-19, same page.
const SUMMARY_PATTERN = /\n([^\n]+)\n看更多\n/;

// Sun/moon times block: fixed 4-line label group followed by 4 HH:MM values
// in the same order -- verified 2026-08-19, same page. The 4 labels
// (日出時刻/日沒時刻/月出時刻/月沒時刻) sit in a narrow table cell that CWA's
// layout sometimes soft-wraps mid-word (e.g. "日出\n\n\n時刻" instead of
// "日出時刻") depending on the private window's actual pixel width at
// render time -- observed both forms across back-to-back fetches of the
// SAME page, not a one-off. `gap` tolerates arbitrary whitespace/newlines
// between every character so either rendering matches.
function gap(s) {
  return s.split('').join('\\s*');
}
const SUN_MOON_PATTERN = new RegExp(
  `${gap('日出時刻')}\\s*${gap('日沒時刻')}\\s*${gap('月出時刻')}\\s*${gap('月沒時刻')}` +
    '\\s*(\\d{2}:\\d{2})\\s*(\\d{2}:\\d{2})\\s*(\\d{2}:\\d{2})\\s*(\\d{2}:\\d{2})'
);

// Every CWA warning-type bulletin page (陸上強風特報, 解除豪雨特報, etc, all
// under /V8/C/P/Warning/*.html) shares this one thing regardless of the
// specific type: a "發佈時間：<ts>" line followed by free text, ending at
// "回總覽" -- verified 2026-08-19 against two STRUCTURALLY DIFFERENT
// templates: 陸上強風特報 (has internal 一/二/三 numbered sub-sections:
// 概述/特報區域/注意事項) and 解除豪雨特報 (a plain cancellation notice with
// no sub-sections at all, since a "lifted" advisory has nothing region-
// specific left to say). Don't assume the 一/二/三 sub-structure exists --
// only 發佈時間...回總覽 is common across warning types; other types (e.g.
// typhoon-specific pages under /V8/C/P/Typhoon/, not /Warning/) are
// deliberately out of scope, not attempted here.
const BULLETIN_PATTERN = /發佈時間：([\d/: ]+)\n\n([\s\S]*?)\n\n回總覽/;
// Optional finer-grained field, present on SOME warning types (e.g. 陸上強
// 風特報 lists exactly which counties are covered) but absent on others
// (e.g. 解除豪雨特報's cancellation notice has no region breakdown at all)
// -- only used to enrich `regions` when it parses; absence is not an error,
// affectsThisCity below still works off the full bulletin text either way.
const REGIONS_PATTERN = /二、特報區域\n([\s\S]*?)\n\n三、/;

function parseAlertBulletin(text, cityFullName) {
  const m = text.match(BULLETIN_PATTERN);
  if (!m) return null;
  const regionsMatch = m[2].match(REGIONS_PATTERN);
  return {
    issuedAt: m[1],
    text: m[2],
    regions: regionsMatch ? regionsMatch[1].trim() : null,
    affectsThisCity: m[2].includes(cityFullName),
  };
}

// Currently-active nationwide alert links -- these show up (with real
// hrefs, not javascript:void(0)) in a small dynamic list inside the site's
// global top-nav "警特報" menu, present on EVERY CWA page regardless of
// which county you're looking at -- verified 2026-08-19 across the
// homepage, a county page, and a warning bulletin page itself, all showing
// the same two active links. This means no extra navigation is needed to
// discover what's currently active: the county page already open for the
// forecast fetch carries this nav on it too. Scoped to /V8/C/P/Warning/ --
// deliberately excludes /V8/C/P/Typhoon/TY_NEWS.html, which is a permanent
// nav item present even with zero active typhoons, not a signal of one.
const ALERT_LINK_PATTERN = /^\/V8\/C\/P\/Warning\/\w+\.html$/;
// Sane upper bound on how many alert bulletin pages one get_weather call
// will fetch -- normal conditions show 0-3; this just stops a genuinely
// unusual multi-hazard day from turning one tool call into a long fetch
// fan-out. If ever hit, the caller sees fewer alerts than are truly active,
// not a silent truncation -- alertsTruncated on the result says so.
const MAX_ALERTS_TO_FETCH = 6;

function parseForecast(text) {
  const periods = [...text.matchAll(PERIOD_PATTERN)].map((m) => ({
    period: m[1],
    tempLow: Number(m[2]),
    tempHigh: Number(m[3]),
    rainChance: Number(m[4]),
    comfort: m[5],
  }));
  const summaryMatch = text.match(SUMMARY_PATTERN);
  const sunMoonMatch = text.match(SUN_MOON_PATTERN);
  return {
    periods,
    summary: summaryMatch ? summaryMatch[1] : null,
    sunrise: sunMoonMatch ? sunMoonMatch[1] : null,
    sunset: sunMoonMatch ? sunMoonMatch[2] : null,
    moonrise: sunMoonMatch ? sunMoonMatch[3] : null,
    moonset: sunMoonMatch ? sunMoonMatch[4] : null,
  };
}

export default {
  name: 'get_weather',
  description:
    '查詢中央氣象署（CWA）官網某縣市的天氣預報與目前全國有效警特報 -- 今晚明晨/明日白天/' +
    '明日晚上三時段的溫度範圍、降雨機率、舒適度描述，加上整體天氣概述、日出日沒時刻，以及' +
    '`alerts` 陣列（目前全國生效中的警特報，例如陸上強風特報、豪雨特報，每則附發布時間、' +
    '全文、涵蓋區域，並用 `affectsThisCity` 標示是否影響所查詢的縣市 -- 沒有任何警特報生' +
    '效時 alerts 是空陣列，不代表查詢失敗）。一次呼叫涵蓋開頁、等待Vue渲染、擷取、關頁，' +
    '不需要AI手動操作瀏覽器。`city` 接受22個縣市的正式全名（例如' +
    `${CITY_NAMES.slice(0, 3).join('、')}...），或不含市/縣的簡稱（例如「臺南」會解析成` +
    '「臺南市」）-- 簡稱若有歧義（例如「新竹」同時對應新竹市與新竹縣）會回傳' +
    'ambiguous_city 錯誤並列出候選，不會自行猜測。天氣預報解析失敗（例如CWA改版導致文字' +
    '結構不符預期）時仍會回傳 {ok:true} 但 periods 為空陣列，並附上 rawText 供人工檢查，' +
    '不會假裝有資料；單則警特報解析失敗時該筆 alerts 項目會標示 ok:false 並附 rawText，' +
    '不影響其餘結果。目前只涵蓋 /V8/C/P/Warning/ 路徑下的警特報類型，颱風專屬公告' +
    '（/V8/C/P/Typhoon/）不在此範圍內。',
  inputSchema: {
    city: z
      .string()
      .describe('縣市名稱，例如"臺北市"、"台北"、"新竹市"（簡稱若歧義會報錯並列出選項）'),
  },

  async run(input, bridge) {
    const resolved = resolveCity(input.city);
    if (resolved.ambiguous) {
      return { topLevelError: `ambiguous_city: ${resolved.ambiguous.join('、')}` };
    }
    if (!resolved.name) {
      return { topLevelError: `unknown_city: ${input.city}` };
    }
    const { name: cityName, cid } = resolved;

    const opened = await bridge.openPrivateWindow({
      url: `https://www.cwa.gov.tw/V8/C/W/County/County.html?CID=${cid}`,
    });
    if (!opened.ok) {
      return { topLevelError: opened.error };
    }
    const { windowId, tabId: countyTabId } = opened;
    const tabIdsToClose = [countyTabId];

    // Not a static page -- the forecast widget is Vue-rendered client-side,
    // so read_page immediately after navigation would see an empty shell.
    await bridge.waitForNetworkIdle(countyTabId, { timeoutMs: 8000 });

    // Discover currently-active alert links from the county page's own nav
    // -- see ALERT_LINK_PATTERN's comment for why no separate navigation is
    // needed for this.
    const elementsResult = await bridge.listElements({ tabId: countyTabId, filter: { tag: 'a' } });
    const navLinks = elementsResult.ok ? (elementsResult.frames ?? []).flatMap((f) => f.elements ?? []) : [];
    const seenAlertLinks = new Map(); // href -> link text (alert type name)
    for (const el of navLinks) {
      if (el.href && ALERT_LINK_PATTERN.test(el.href) && !seenAlertLinks.has(el.href)) {
        seenAlertLinks.set(el.href, el.text || '');
      }
    }
    const activeAlertLinks = [...seenAlertLinks.entries()];
    const alertsTruncated = activeAlertLinks.length > MAX_ALERTS_TO_FETCH;

    const page = await bridge.readPage(countyTabId, { frameId: 0 });
    if (!page.ok || !page.text) {
      await Promise.all(tabIdsToClose.map((id) => bridge.closeTab(id)));
      return { topLevelError: page.ok ? 'empty_page_response' : page.error };
    }
    const parsed = parseForecast(page.text);

    const alerts = [];
    for (const [href, typeName] of activeAlertLinks.slice(0, MAX_ALERTS_TO_FETCH)) {
      const url = new URL(href, 'https://www.cwa.gov.tw').toString();
      const acquired = await bridge.acquireTab({ url, windowId });
      if (!acquired.ok) {
        alerts.push({ type: typeName, ok: false, error: acquired.error });
        continue;
      }
      tabIdsToClose.push(acquired.tabId);
      await bridge.waitForNetworkIdle(acquired.tabId, { timeoutMs: 8000 });
      const alertPage = await bridge.readPage(acquired.tabId, { frameId: 0 });
      if (!alertPage.ok || !alertPage.text) {
        alerts.push({ type: typeName, ok: false, error: alertPage.ok ? 'empty_page_response' : alertPage.error });
        continue;
      }
      const bulletin = parseAlertBulletin(alertPage.text, cityName);
      alerts.push(
        bulletin
          ? { type: typeName, ok: true, ...bulletin }
          : { type: typeName, ok: false, error: 'unparseable_bulletin', rawText: alertPage.text }
      );
    }

    await Promise.all(tabIdsToClose.map((id) => bridge.closeTab(id)));

    return {
      city: cityName,
      sourceUrl: `https://www.cwa.gov.tw/V8/C/W/County/County.html?CID=${cid}`,
      ...parsed,
      rawText: parsed.periods.length === 0 ? page.text : undefined,
      alerts,
      alertsTruncated,
    };
  },
};
