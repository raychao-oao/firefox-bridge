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

  function fbBase64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // Canonical "what a real user sees" text for an <option>: option.label is
  // the HTML-standard displayed text (an explicit label attribute if set,
  // else the option's own default label -- already whitespace-collapsed per
  // spec). The extra \s+ replace adds Unicode whitespace normalization (e.g.
  // NBSP) on top of the standard's ASCII-only collapse. Shared between
  // list_elements' <select> options serialization and select_option's
  // matching so the two never disagree about an option's text.
  function fbOptionDisplayText(option) {
    return (option.label || '').trim().replace(/\s+/gu, ' ');
  }

  // press_key's best-effort code/keyCode/which mapping for common control
  // keys -- KeyboardEvent's constructor dictionary defaults `code`/`keyCode`
  // to empty/0, which the modern `key`-only idiom never needed, but a lot of
  // real-world page code (and jQuery's normalised `event.which`) still
  // branches on the legacy fields. Not exhaustive by design: it covers the
  // tool's stated primary use case (Escape/Enter/Tab/arrows/single chars),
  // anything else keeps the KeyboardEventInit defaults.
  const KEY_CODE_MAP = {
    Enter: { code: 'Enter', keyCode: 13 },
    Escape: { code: 'Escape', keyCode: 27 },
    Tab: { code: 'Tab', keyCode: 9 },
    Backspace: { code: 'Backspace', keyCode: 8 },
    Delete: { code: 'Delete', keyCode: 46 },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    ' ': { code: 'Space', keyCode: 32 },
  };

  // domEpoch identifies "this DOM instance" -- scoped per content-script
  // execution, i.e. per FRAME (this project's manifest.json has
  // content_scripts.all_frames: true, so an iframe's domEpoch is
  // independent of its parent's). Generated once at script-install time,
  // reusing the same random-id generator as data-fb-id, since a fresh
  // navigation always re-executes this script (the double-injection guard
  // at the top of this file is what makes that true).
  //
  // Rotating on bfcache restoration matters: Firefox can restore a page
  // from bfcache WITHOUT re-running content-script.js at all -- the exact
  // same mechanism list_elements' password-exclusion logic elsewhere in
  // this file already has to account for. event.persisted === true is
  // Firefox's own signal for "this pageshow came from bfcache, not a fresh
  // load." Without this listener, a caller's expectedDomEpoch would
  // incorrectly still match after a back-navigation a user would consider
  // a real page change.
  let domEpoch = fbGenerateId();
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) domEpoch = fbGenerateId();
  });

  browser.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
    if (msg.type === 'click') {
      if (msg.expectedDomEpoch !== undefined && msg.expectedDomEpoch !== domEpoch) {
        return Promise.resolve({ ok: false, error: 'stale_selector' });
      }
      const el = document.querySelector(msg.selector);
      if (!el) return Promise.resolve({ ok: false, error: 'element_not_found' });
      // domChanged is a deliberately coarse, best-effort signal (any
      // childList/attribute mutation counts -- ads, clocks, and lazy-load
      // can all trigger a false positive) -- not a precise diff. Good
      // enough to tell an agent "something happened," per the design
      // spec's own framing.
      let domChanged = false;
      const observer = new MutationObserver(() => { domChanged = true; });
      // document.body can be null (e.g. a standalone XML/SVG document, or an
      // element matched inside <head>) -- same guard as read_page's
      // `document.body ? ... : ''` above. Without it, observer.observe(null,
      // ...) throws and click fails outright where el.click() alone would
      // have worked. On a null body there's nothing to observe, so
      // domChanged honestly stays false.
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      }
      el.click();
      return new Promise((resolve) => {
        setTimeout(() => {
          observer.disconnect();
          resolve({ ok: true, domChanged });
        }, 300);
      });
    }

    if (msg.type === 'upload_file') {
      let el;
      try {
        el = document.querySelector(msg.selector);
      } catch (err) {
        return Promise.resolve({ ok: false, error: 'invalid_selector' });
      }
      if (!el) return Promise.resolve({ ok: false, error: 'element_not_found' });
      // el.type (the IDL attribute), not el.getAttribute('type') -- HTML
      // input types are case-insensitive (type="FILE" is still a file
      // input), and el.type already normalizes to lowercase, unlike a raw
      // getAttribute read. Found by use-codex plan review.
      if (el.tagName.toLowerCase() !== 'input' || el.type !== 'file') {
        return Promise.resolve({ ok: false, error: 'not_a_file_input' });
      }
      // Standard "assign a File to an <input type=file>" pattern: construct
      // a DataTransfer, add the File to it, assign its FileList to el.files.
      // This assignment alone does NOT fire `change` (per spec), so both
      // change and input are dispatched explicitly afterward.
      const file = new File([fbBase64ToBytes(msg.dataBase64)], msg.fileName, {
        type: msg.mimeType || 'application/octet-stream',
      });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return Promise.resolve({ ok: true });
    }

    if (msg.type === 'type') {
      if (msg.expectedDomEpoch !== undefined && msg.expectedDomEpoch !== domEpoch) {
        return Promise.resolve({ ok: false, error: 'stale_selector' });
      }
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
      if (el.isContentEditable) {
        // Checked directly here (not the stricter isEditableRoot restriction
        // list_elements uses for labeling) -- type should still work on any
        // genuinely editable element, including one editable only by
        // inheriting from an ancestor. No native value setter applies to a
        // contenteditable -- select all of its existing content (a Range,
        // not Selection.selectAllChildren, because Range.selectNodeContents
        // is well-defined even when el has zero child nodes, e.g. an empty
        // chat box) then let execCommand replace the selection and insert
        // msg.text in one call. This fires the browser's native
        // beforeinput/input events with inputType:'insertText', which is
        // what framework-bound contenteditable widgets (Angular's
        // ContentEditable directive, etc.) actually listen for -- a
        // synthetic `new Event('input')` carries no inputType and would not
        // match a beforeinput-gated handler. execCommand is deprecated
        // web-platform-wide but remains fully functional in Firefox for
        // exactly this (unformatted text insertion into a contenteditable)
        // -- this project targets Firefox only, so no fallback is needed.
        // Its boolean return value is checked (not assumed) since it can
        // report failure without throwing.
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        const inserted = document.execCommand('insertText', false, msg.text);
        if (!inserted) {
          return Promise.resolve({ ok: false, error: 'contenteditable_insert_failed' });
        }
        return Promise.resolve({ ok: true });
      }
      if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
        return Promise.resolve({ ok: false, error: 'not_typable' });
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

    if (msg.type === 'select_option') {
      if (msg.expectedDomEpoch !== undefined && msg.expectedDomEpoch !== domEpoch) {
        return Promise.resolve({ ok: false, error: 'stale_selector' });
      }
      let el;
      try {
        el = document.querySelector(msg.selector);
      } catch (err) {
        return Promise.resolve({ ok: false, error: 'invalid_selector' });
      }
      if (!el) return Promise.resolve({ ok: false, error: 'element_not_found' });
      if (el.tagName !== 'SELECT') {
        return Promise.resolve({ ok: false, error: 'not_a_select' });
      }
      // Deliberately no el.focus() here (unlike `type`) -- avoids firing unrelated
      // focus/blur handlers, and no ecosystem this needs to support requires focus
      // for a select's value change to be observed.
      if (el.multiple) {
        return Promise.resolve({ ok: false, error: 'multiple_select_not_supported' });
      }
      if (el.matches(':disabled')) {
        return Promise.resolve({ ok: false, error: 'select_disabled' });
      }

      const normalizedQuery = (msg.text || '').trim().replace(/\s+/gu, ' ');
      if (normalizedQuery === '') {
        return Promise.resolve({ ok: false, error: 'empty_text' });
      }

      const options = Array.from(el.options).map((o, index) => ({
        index,
        value: o.value,
        text: fbOptionDisplayText(o),
        disabled: o.matches(':disabled'),
      }));
      const MAX_AMBIGUOUS_MATCHES = 20;
      const ambiguous = (matches) => Promise.resolve({
        ok: false,
        error: 'ambiguous_match',
        matches: matches.slice(0, MAX_AMBIGUOUS_MATCHES),
        ...(matches.length > MAX_AMBIGUOUS_MATCHES ? { matchesTruncated: true } : {}),
      });

      // Two-tier match: exact text first (checked for ambiguity on its own
      // before ever trying substring), then substring only if there was no
      // exact match at all. A duplicate-text pair at either tier is reported
      // as ambiguous_match, never silently resolved to "the first one" --
      // silently picking one for a caller who couldn't tell two options
      // apart from the text alone would be a real selection-error risk on
      // pages like coolpc.com.tw's estimate page.
      const exactMatches = options.filter((o) => o.text === normalizedQuery);
      let matched;
      if (exactMatches.length === 1) {
        matched = exactMatches[0];
      } else if (exactMatches.length > 1) {
        return ambiguous(exactMatches);
      } else {
        const substringMatches = options.filter((o) => o.text.includes(normalizedQuery));
        if (substringMatches.length === 1) {
          matched = substringMatches[0];
        } else if (substringMatches.length > 1) {
          return ambiguous(substringMatches);
        } else {
          return Promise.resolve({ ok: false, error: 'option_not_found' });
        }
      }

      if (matched.disabled) {
        return Promise.resolve({ ok: false, error: 'option_disabled' });
      }

      if (el.selectedIndex === matched.index) {
        // No-op: mirrors what a real user re-selecting the already-selected
        // option would produce -- no new input/change.
        return Promise.resolve({ ok: true, value: matched.value, text: matched.text, changed: false });
      }

      // selectedIndex, not `el.value = matched.value` -- the HTML standard
      // defines the value setter as selecting the FIRST option with that
      // value, which would silently select the wrong option if two options
      // share a value.
      el.selectedIndex = matched.index;
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      // Re-read after dispatch rather than trusting the assignment above --
      // a synchronous change handler (a controlled-component re-render, the
      // page's own onchange logic, or code that clears/replaces the select
      // entirely) could have changed the selection again, or left nothing
      // selected, before this returns. Do NOT fall back to `matched` here:
      // if el.options[el.selectedIndex] is now undefined (selectedIndex was
      // reset to -1, or the options list was cleared), that means nothing is
      // actually selected anymore, and claiming `matched`'s old value/text
      // would be reporting a false success. Report null in that case instead
      // -- still ok:true (the selection attempt itself did happen and did
      // dispatch real events), but honest about the current state.
      const finalOption = el.options[el.selectedIndex];
      return Promise.resolve({
        ok: true,
        value: finalOption ? finalOption.value : null,
        text: finalOption ? fbOptionDisplayText(finalOption) : null,
        changed: true,
      });
    }

    if (msg.type === 'hover') {
      let el;
      try {
        el = document.querySelector(msg.selector);
      } catch (err) {
        return Promise.resolve({ ok: false, error: 'invalid_selector' });
      }
      if (!el) return Promise.resolve({ ok: false, error: 'element_not_found' });
      // Both MouseEvent AND PointerEvent variants: some components (especially
      // ones also supporting touch) listen for pointerover/pointerenter/
      // pointermove instead of the legacy mouse events -- dispatching only
      // one family would silently miss the other. mouseenter/pointerenter do
      // NOT bubble per spec, dispatched directly on the target either way.
      // pointerId/isPrimary/pointerType are set explicitly because pointer-
      // aware components commonly guard on `if (!e.isPrimary) return` or
      // `if (e.pointerType !== 'mouse') ...` -- the PointerEventInit defaults
      // (pointerId: 0, isPrimary: false, pointerType: '') fail both guards,
      // which would silently degrade this dispatch to mouse-events-only.
      // MouseEvent's constructor ignores these extra fields, so the same
      // init object is safe to share with the MouseEvent dispatches below.
      const bubblingInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        pointerId: 1,
        isPrimary: true,
        pointerType: 'mouse',
      };
      const enterInit = {
        bubbles: false,
        cancelable: false,
        view: window,
        pointerId: 1,
        isPrimary: true,
        pointerType: 'mouse',
      };
      el.dispatchEvent(new PointerEvent('pointerover', bubblingInit));
      el.dispatchEvent(new MouseEvent('mouseover', bubblingInit));
      el.dispatchEvent(new PointerEvent('pointerenter', enterInit));
      el.dispatchEvent(new MouseEvent('mouseenter', enterInit));
      el.dispatchEvent(new PointerEvent('pointermove', bubblingInit));
      el.dispatchEvent(new MouseEvent('mousemove', bubblingInit));
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

    if (msg.type === 'read_article') {
      if (typeof Readability === 'undefined') {
        return Promise.resolve({ ok: false, error: 'readability_unavailable' });
      }
      const MAX_TEXT_CHARS = 500000; // same cap read_page uses
      let article;
      try {
        article = new Readability(document.cloneNode(true), { maxElemsToParse: 100000 }).parse();
      } catch (err) {
        return Promise.resolve({ ok: false, error: `readability_parse_failed: ${err.message}` });
      }
      if (!article) {
        return Promise.resolve({ ok: false, error: 'not_an_article' });
      }
      const full = article.textContent || '';
      const truncated = full.length > MAX_TEXT_CHARS;
      return Promise.resolve({
        ok: true,
        title: article.title,
        byline: article.byline,
        siteName: article.siteName,
        excerpt: article.excerpt,
        text: truncated ? full.slice(0, MAX_TEXT_CHARS) : full,
        truncated,
        totalLength: full.length,
      });
    }

    if (msg.type === 'list_elements') {
      // Interactive-element candidates only -- a page-wide "*" scan would
      // both blow past MAX_ELEMENTS instantly and return mostly noise
      // (click/type only ever target things a user could actually interact
      // with).
      const CANDIDATE_SELECTOR =
        'a, button, input, select, textarea, [onclick], [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], summary, tr, th, [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""]';
      // Caps the response well under the 1 MiB native-messaging frame limit
      // even on a link-heavy page; excess candidates are dropped, not
      // paginated -- MVP scope, revisit if this proves too small in practice.
      const MAX_ELEMENTS = 300;

      // Empty-string filter fields are treated the same as omitted (no
      // constraint from that field) -- not rejected, not "match nothing."
      // A caller passing filter: {text: ''} gets the same result as
      // omitting filter.text entirely.
      const filter = msg.filter || {};
      // scanRoot narrows WHERE the candidate queries run -- container-scoping
      // happens at the query level (not a post-hoc filter of the final
      // array) so that a page with 500+ interactive elements doesn't lose a
      // filtered-for element to the MAX_ELEMENTS cap being consumed by
      // unrelated, earlier-sorted candidates outside the container.
      let scanRoot = document;
      if (filter.container) {
        let matched;
        try {
          matched = document.querySelector(filter.container);
        } catch (err) {
          return Promise.resolve({ ok: false, error: 'invalid_container_selector' });
        }
        if (!matched) {
          // Valid selector, legitimately no match right now (e.g. that part
          // of the page hasn't rendered yet) -- a normal empty result, not
          // an error. Deliberately distinct from the invalid-selector case
          // above: a typo'd CSS syntax gets a structured error a caller
          // can't miss; a selector that's fine but currently matches
          // nothing gets the same shape as "no candidates here."
          return Promise.resolve({ ok: true, elements: [], totalCandidates: 0, truncated: false, domEpoch });
        }
        scanRoot = matched;
      }

      const semanticCandidates = scanRoot.querySelectorAll(CANDIDATE_SELECTOR);
      // Some UIs (this Netgear router admin panel included) bind clicks via
      // JS to plain li/span/div with no semantic tag, role, or onclick
      // attribute -- invisible to the selector above. `cursor: pointer` is
      // an imperfect but effective heuristic for "a human would click this".
      // Capped separately so a pathological page can't make this scan itself
      // the bottleneck.
      const HEURISTIC_SCAN_CAP = 3000;
      const heuristicPool = scanRoot.querySelectorAll('li, span, div');
      const heuristicCandidates = [];
      for (let i = 0; i < heuristicPool.length && i < HEURISTIC_SCAN_CAP; i += 1) {
        const el = heuristicPool[i];
        if (getComputedStyle(el).cursor === 'pointer') heuristicCandidates.push(el);
      }
      const candidatesBeforeFilter = [...new Set([...semanticCandidates, ...heuristicCandidates])];
      // text/tag/type filtering happens here, BEFORE candidates reaches the
      // MAX_ELEMENTS loop below -- this is what makes filter narrow the
      // candidate set rather than just post-filter the final array.
      const candidates = candidatesBeforeFilter.filter((el) => {
        if (filter.tag && el.tagName.toLowerCase() !== filter.tag.toLowerCase()) return false;
        if (filter.type) {
          const elType = (el.getAttribute('type') || '').toLowerCase();
          if (elType !== filter.type.toLowerCase()) return false;
        }
        if (filter.text) {
          // Full, untruncated label -- matches the same fallback chain the
          // existing per-element label computation below uses, but without
          // the eventual .slice(0, 100). A match that only occurs after
          // character 100 of a long label must still be found here.
          //
          // NOTE (maintenance risk, accepted -- flagged by use-codex plan
          // review): this label computation is intentionally duplicated
          // from the per-element loop below, not extracted into a shared
          // helper. The two copies are correct and consistent as of this
          // batch (same fallback chain, same trim/whitespace normalization,
          // same password/hidden/file exclusion), but a future change to
          // label-building logic must update BOTH copies, or filtering and
          // the returned `text` field can silently disagree. Not fixed in
          // this batch (extracting a shared helper would touch more of the
          // existing, already-reviewed list_elements loop than this batch's
          // scope warrants) -- if label logic changes again, revisit this.
          const isValueExcluded = ['password', 'hidden', 'file'].includes(
            (el.getAttribute('type') || '').toLowerCase()
          );
          const fullLabel = (
            el.innerText || (isValueExcluded ? '' : el.value) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || ''
          ).trim().replace(/\s+/g, ' ');
          if (!fullLabel.toLowerCase().includes(filter.text.toLowerCase())) return false;
        }
        return true;
      });
      // A password/hidden/file input's .value can hold a real credential or
      // secret (typed by the user, autofilled by Firefox's password manager
      // between list_elements calls, or a CSRF/session token embedded by the
      // page) -- never let it reach the label OR the new state.value field.
      // ONE shared, case-insensitive check for both: HTML's `type` attribute
      // is case-insensitive (`type="PASSWORD"` is still a password input),
      // so `.toLowerCase()` it once and reuse the normalized value everywhere
      // rather than repeating a case-sensitive `=== 'password'` comparison
      // in two places that could drift out of sync.
      const VALUE_EXCLUDED_TYPES = new Set(['password', 'hidden', 'file']);
      // readOnly is only meaningful on text-like inputs -- reading it on a
      // checkbox/radio/button/file input is safe (never throws) but always
      // reports a meaningless `false`, which would look like a real signal.
      // Framed as a denylist (per the design spec's own "不含
      // checkbox/radio/button/submit/reset/file" exclusion wording) rather
      // than an allowlist, so newly-invented input types (date/month/week/
      // time/datetime-local, and the typeless case) are readonly-applicable
      // by default instead of silently falling through as "not applicable".
      const READONLY_INAPPLICABLE_TYPES = new Set([
        'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'hidden', 'color', 'range',
      ]);
      // Caps state.value so a page with a large <textarea>/CMS editor can't
      // blow the response past the 1 MiB native-messaging frame limit (see
      // the MAX_ELEMENTS comment above and read_page's 500,000-char cap for
      // the same protocol constraint).
      const MAX_VALUE_CHARS = 500;
      const elements = [];
      // Tracks only "the MAX_ELEMENTS cap actually cut candidates off" --
      // distinct from candidates.length > elements.length, which is also
      // true whenever hidden/detached elements get filtered out below and
      // was previously (mis)used as the truncation signal, making
      // `truncated: true` on nearly every real page.
      let cappedByLimit = false;
      for (const el of candidates) {
        if (elements.length >= MAX_ELEMENTS) {
          cappedByLimit = true;
          break;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue; // hidden/detached, not clickable
        if (!el.dataset.fbId) {
          el.dataset.fbId = fbGenerateId();
        }
        const tagName = el.tagName.toLowerCase();
        const rawType = el.getAttribute('type');
        const normalizedType = (rawType || '').toLowerCase();
        // Shared with state.value below -- a file input's .value ("local
        // filename/fake path") must not leak into the label any more than a
        // password/hidden input's value should.
        const isValueExcluded = VALUE_EXCLUDED_TYPES.has(normalizedType);
        const label =
          (el.innerText || (isValueExcluded ? '' : el.value) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 100);

        // Every element gets a `state` object -- never omitted, `{}` when
        // nothing applies (see the design spec's "state 物件的存在性契約").
        const state = {};
        if (tagName === 'input' && (normalizedType === 'checkbox' || normalizedType === 'radio')) {
          state.checked = el.checked;
        }
        // isEditableRoot requires BOTH that el's OWN contenteditable attribute
        // is directly set to an editable value AND that the browser confirms
        // it's actually live-editable (el.isContentEditable). el.isContentEditable
        // alone is not enough -- it also returns true for an unrelated element
        // (e.g. a <button>) that merely inherits editability by sitting inside
        // a contenteditable ancestor, which must NOT be mislabeled as a
        // text-entry field. hasAttribute() is checked separately (not just
        // getAttribute() ?? '') because an element with NO contenteditable
        // attribute at all and one with contenteditable="" (a valid spelling
        // of "true") would otherwise both normalize to the same empty string
        // -- live-verification against a nested <button> inside a
        // contenteditable ancestor caught this collapsing the two cases and
        // mislabeling the button as an editable root.
        const hasOwnContentEditable = el.hasAttribute('contenteditable');
        const rawContentEditable = hasOwnContentEditable
          ? el.getAttribute('contenteditable').toLowerCase()
          : null;
        const isEditableRoot =
          el.isContentEditable &&
          hasOwnContentEditable &&
          (rawContentEditable === 'true' || rawContentEditable === 'plaintext-only' || rawContentEditable === '');
        if (
          (tagName === 'input' && !isValueExcluded) ||
          tagName === 'textarea' ||
          tagName === 'select' ||
          isEditableRoot
        ) {
          const rawValue = isEditableRoot ? el.innerText : (el.value ?? '');
          state.value = rawValue.slice(0, MAX_VALUE_CHARS);
          if (rawValue.length > MAX_VALUE_CHARS) state.valueTruncated = true;
        }
        if (tagName === 'input' || tagName === 'select' || tagName === 'textarea' || tagName === 'button') {
          state.disabled = el.disabled;
        }
        if ((tagName === 'input' && !READONLY_INAPPLICABLE_TYPES.has(normalizedType)) || tagName === 'textarea') {
          state.readonly = el.readOnly;
        }
        if (isEditableRoot) {
          state.contentEditable = true;
        }
        if (el.hasAttribute('aria-expanded')) {
          state.ariaExpanded = el.getAttribute('aria-expanded');
        }
        if (el.hasAttribute('aria-checked')) {
          state.ariaChecked = el.getAttribute('aria-checked');
        }

        elements.push({
          selector: `[data-fb-id="${el.dataset.fbId}"]`,
          tag: tagName,
          text: label,
          type: rawType || undefined,
          href: el.getAttribute('href') || undefined,
          // `value` is the option's form value (what `type`'s <select>
          // handling matches against first). `text` is the canonical
          // DISPLAYED label -- see fbOptionDisplayText above -- which is
          // what `select_option`'s text matching (and a human reading this
          // list) actually compares against.
          options:
            tagName === 'select'
              ? Array.from(el.options).map((o) => ({ value: o.value, text: fbOptionDisplayText(o) }))
              : undefined,
          state,
        });
      }
      return Promise.resolve({
        ok: true,
        elements,
        totalCandidates: candidates.length,
        truncated: cappedByLimit,
        domEpoch,
      });
    }

    if (msg.type === 'wait_for') {
      const POLL_INTERVAL_MS = 100;
      const deadline = Date.now() + (msg.timeoutMs ?? 5000);
      return new Promise((resolve) => {
        const poll = () => {
          if (msg.selector) {
            if (document.querySelector(msg.selector)) {
              resolve({ ok: true, matched: true, timedOut: false });
              return;
            }
          } else if (msg.textGone) {
            // document.body can be null very early in a document's life
            // (matches read_page's existing `document.body ? ... : ''`
            // guard elsewhere in this file) -- treat "no body at all" as
            // the text trivially being gone, not as an error.
            if (!document.body || !document.body.innerText.includes(msg.textGone)) {
              resolve({ ok: true, matched: true, timedOut: false });
              return;
            }
          }
          if (Date.now() >= deadline) {
            resolve({ ok: true, matched: false, timedOut: true });
            return;
          }
          setTimeout(poll, POLL_INTERVAL_MS);
        };
        poll();
      });
    }

    if (msg.type === 'press_key') {
      if (typeof msg.key !== 'string' || msg.key.length === 0) {
        return Promise.resolve({ ok: false, error: 'invalid_key' });
      }
      let target;
      // msg.selector !== undefined (not a truthiness check on msg.selector)
      // -- an explicitly-passed empty string must be treated the same as any
      // other selector-based tool (invalid_selector via querySelector's own
      // syntax error, or element_not_found), not silently redirected to
      // activeElement the way a falsy check would. Found by use-codex plan
      // review: an earlier draft's `if (msg.selector)` made an empty-string
      // selector behave inconsistently with every other selector-taking tool
      // in this codebase.
      if (msg.selector !== undefined) {
        try {
          target = document.querySelector(msg.selector);
        } catch (err) {
          return Promise.resolve({ ok: false, error: 'invalid_selector' });
        }
        if (!target) return Promise.resolve({ ok: false, error: 'element_not_found' });
      } else {
        // No selector: target whatever currently has focus in THIS frame.
        // There's no sensible fallback search here (no way to know which
        // frame "should" have focus), so this path is always single-frame
        // (see background.js's routing for this case).
        target = document.activeElement || document.body;
        // Mirrors the click handler's document.body null-guard: on a
        // standalone XML/SVG document there may be neither an active element
        // nor a body, and dispatching on a null target would throw
        // synchronously -- surfacing as a misleading content_script_unreachable
        // transport error instead of "nothing focusable here."
        if (!target) return Promise.resolve({ ok: false, error: 'no_active_element' });
      }
      const modifiers = msg.modifiers || {};
      // Best-effort code/keyCode/which -- see KEY_CODE_MAP above for scope.
      let code = '';
      let keyCode = 0;
      if (KEY_CODE_MAP[msg.key]) {
        ({ code, keyCode } = KEY_CODE_MAP[msg.key]);
      } else if (msg.key.length === 1) {
        const upper = msg.key.toUpperCase();
        keyCode = upper.charCodeAt(0);
        code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(upper) ? `Digit${upper}` : '';
      }
      const eventInit = {
        key: msg.key,
        code,
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
        shiftKey: !!modifiers.shift,
        ctrlKey: !!modifiers.ctrl,
        altKey: !!modifiers.alt,
        metaKey: !!modifiers.meta,
      };
      // Synthetic (dispatchEvent) KeyboardEvents are always isTrusted:false --
      // Firefox does not run native keyboard default actions (form
      // submission on Enter, native dialog dismissal on Escape) for these.
      // JS keydown/keyup listeners on the page DO see them, which is this
      // tool's actual use case. keypress only for single-character keys,
      // matching real browsers' legacy keypress behavior for printable keys.
      target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
      if (msg.key.length === 1) target.dispatchEvent(new KeyboardEvent('keypress', eventInit));
      target.dispatchEvent(new KeyboardEvent('keyup', eventInit));
      return Promise.resolve({ ok: true });
    }

    if (msg.type === 'scroll_to') {
      let el;
      try {
        el = document.querySelector(msg.selector);
      } catch (err) {
        // document.querySelector THROWS on a syntactically invalid selector
        // (e.g. an unclosed bracket) rather than returning null -- distinct
        // from "valid selector, no match," same distinction list_elements'
        // filter.container already makes for the same underlying reason.
        return Promise.resolve({ ok: false, error: 'invalid_selector' });
      }
      if (!el) return Promise.resolve({ ok: false, error: 'element_not_found' });
      // block:'center' rather than the browser default ('start') lowers the
      // odds a sticky header/footer covers the element right after
      // scrolling. behavior:'instant' matches this project's existing
      // no-animation-delay convention for every other operation.
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      return Promise.resolve({ ok: true });
    }

    if (msg.type === 'drag_and_drop') {
      let source;
      try {
        source = document.querySelector(msg.sourceSelector);
      } catch (err) {
        return Promise.resolve({ ok: false, error: 'invalid_source_selector' });
      }
      if (!source) return Promise.resolve({ ok: false, error: 'source_not_found' });
      let target;
      try {
        target = document.querySelector(msg.targetSelector);
      } catch (err) {
        return Promise.resolve({ ok: false, error: 'invalid_target_selector' });
      }
      if (!target) return Promise.resolve({ ok: false, error: 'target_not_found' });

      // This only works for elements using the native HTML5 Drag and Drop API
      // (draggable="true" + dragstart/dragover/drop listeners) -- many modern
      // UI libraries simulate drag with mousedown/mousemove/mouseup instead
      // (especially ones supporting touch), and those will NOT respond to
      // these DragEvents at all. dragoverAccepted/dropHandled below are how a
      // caller can tell "nothing responded" apart from "it worked."
      const dt = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const dragoverEvent = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
      target.dispatchEvent(dragoverEvent);
      const dropEvent = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
      target.dispatchEvent(dropEvent);
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));

      // Per the HTML5 DnD spec, a target must call preventDefault() on
      // dragover to indicate it accepts the drop -- reading defaultPrevented
      // back turns "were these events dispatched" into "did anything actually
      // handle them," instead of a blind ok:true either way.
      return Promise.resolve({
        ok: true,
        dragoverAccepted: dragoverEvent.defaultPrevented,
        dropHandled: dropEvent.defaultPrevented,
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
