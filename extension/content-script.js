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
  //
  // IDs must be globally unique DOM-wide, not just within one script
  // instance: the extension (and so this script) can reload without the
  // page reloading, which would reset an in-memory counter to 0 while
  // already-tagged elements keep their old data-fb-id attributes --
  // colliding with the fresh counter's output and making one selector match
  // two unrelated elements.
  //
  // crypto.randomUUID() would sidestep this with no state to lose, but it
  // throws on any insecure-context page (plain http://, e.g. a router admin
  // UI at http://10.0.0.1) -- confirmed live, "crypto.randomUUID is not a
  // function". getRandomValues() has no such restriction, so build the ID
  // from that instead.
  function fbGenerateId() {
    const bytes = new Uint8Array(9);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

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
      if (el.tagName === 'SELECT') {
        // A <select>'s native value setter isn't on HTMLInputElement's
        // prototype -- calling that setter via .call() on a select throws
        // ("Illegal invocation"). Selects also don't fire 'input', only
        // 'change'. msg.text must match an <option>'s value attribute (or
        // its text content, if the option has no value attribute) -- use
        // list_elements on the select itself to see the available `options`.
        const matchByValue = Array.from(el.options).some((o) => o.value === msg.text);
        if (!matchByValue) {
          const byText = Array.from(el.options).find((o) => o.textContent.trim() === msg.text);
          if (!byText) return Promise.resolve({ ok: false, error: 'option_not_found' });
          el.value = byText.value;
        } else {
          el.value = msg.text;
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return Promise.resolve({ ok: true });
      }
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
      const semanticCandidates = document.querySelectorAll(CANDIDATE_SELECTOR);
      // Some UIs (this Netgear router admin panel included) bind clicks via
      // JS to plain li/span/div with no semantic tag, role, or onclick
      // attribute -- invisible to the selector above. `cursor: pointer` is
      // an imperfect but effective heuristic for "a human would click this".
      // Capped separately so a pathological page can't make this scan itself
      // the bottleneck.
      const HEURISTIC_SCAN_CAP = 3000;
      const heuristicPool = document.querySelectorAll('li, span, div');
      const heuristicCandidates = [];
      for (let i = 0; i < heuristicPool.length && i < HEURISTIC_SCAN_CAP; i += 1) {
        const el = heuristicPool[i];
        if (getComputedStyle(el).cursor === 'pointer') heuristicCandidates.push(el);
      }
      const candidates = [...new Set([...semanticCandidates, ...heuristicCandidates])];
      const elements = [];
      for (const el of candidates) {
        if (elements.length >= MAX_ELEMENTS) break;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue; // hidden/detached, not clickable
        if (!el.dataset.fbId) {
          el.dataset.fbId = fbGenerateId();
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
          // A <select>'s value setter needs the option's `value` (falling
          // back to its text) verbatim -- expose both since HTML often
          // leaves `value` implicit (defaults to the option's text content).
          options:
            el.tagName === 'SELECT'
              ? Array.from(el.options).map((o) => ({ value: o.value, text: o.textContent.trim() }))
              : undefined,
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
