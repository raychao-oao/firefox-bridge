// repo/extension/content-script.js
//
// Guard against double-injection: manifest.json auto-injects this on every
// new navigation, but background.js also injects it on demand into tabs
// that predate the extension loading (see forwardToContentScript). If both
// paths ever fire for the same document, a second copy of this listener
// would double-handle every click/type/read_page message.
if (window.__firefoxBridgeContentScriptInstalled) {
  // Already loaded in this page -- do nothing.
} else {
  window.__firefoxBridgeContentScriptInstalled = true;

  // Selector-guessing from outside the page is unreliable (no visibility into
  // the DOM), so list_elements tags each candidate with a stable data
  // attribute and hands back a selector keyed on it -- the caller (an LLM
  // driving `click`/`type`) gets a selector guaranteed to match exactly the
  // element it inspected, no guessing.
  let fbIdCounter = 0;

  browser.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
    if (msg.type === 'click') {
      const el = document.querySelector(msg.selector);
      if (!el) return Promise.resolve({ ok: false, error: 'element_not_found' });
      el.click();
      return Promise.resolve({ ok: true });
    }

    if (msg.type === 'type') {
      const el = document.querySelector(msg.selector);
      if (!el) return Promise.resolve({ ok: false, error: 'element_not_found' });
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(
        el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value'
      )?.set;
      if (setter) {
        setter.call(el, msg.text);
      } else {
        el.value = msg.text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return Promise.resolve({ ok: true });
    }

    if (msg.type === 'read_page') {
      // Truncated so a huge page can't produce a response that blows past the
      // 1 MiB native-messaging cap on the extension -> host hop.
      const MAX_TEXT_CHARS = 500000;
      const full = document.body ? document.body.innerText : '';
      if (full.length > MAX_TEXT_CHARS) {
        return Promise.resolve({
          ok: true,
          text: full.slice(0, MAX_TEXT_CHARS),
          truncated: true,
          totalLength: full.length,
        });
      }
      return Promise.resolve({ ok: true, text: full, truncated: false });
    }

    if (msg.type === 'list_elements') {
      // Interactive-element candidates only -- a page-wide "*" scan would
      // both blow past MAX_ELEMENTS instantly and return mostly noise
      // (click/type only ever target things a user could actually interact
      // with).
      const CANDIDATE_SELECTOR =
        'a, button, input, select, textarea, [onclick], [role="button"], [role="link"], [role="menuitem"], [role="tab"], summary';
      // Caps the response well under the 1 MiB native-messaging frame limit
      // even on a link-heavy page; excess candidates are dropped, not
      // paginated -- MVP scope, revisit if this proves too small in practice.
      const MAX_ELEMENTS = 300;
      const candidates = Array.from(document.querySelectorAll(CANDIDATE_SELECTOR));
      const elements = [];
      for (const el of candidates) {
        if (elements.length >= MAX_ELEMENTS) break;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue; // hidden/detached, not clickable
        if (!el.dataset.fbId) {
          fbIdCounter += 1;
          el.dataset.fbId = String(fbIdCounter);
        }
        const label =
          (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 100);
        elements.push({
          selector: `[data-fb-id="${el.dataset.fbId}"]`,
          tag: el.tagName.toLowerCase(),
          text: label,
          type: el.getAttribute('type') || undefined,
          href: el.getAttribute('href') || undefined,
        });
      }
      return Promise.resolve({
        ok: true,
        elements,
        totalCandidates: candidates.length,
        truncated: candidates.length > elements.length,
      });
    }

    return false; // not handled by this listener
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.__firefoxBridge !== 'console') return;
    browser.runtime.sendMessage({
      type: 'console-message',
      level: event.data.level,
      args: event.data.args,
      timestamp: event.data.timestamp,
    });
  });
}
