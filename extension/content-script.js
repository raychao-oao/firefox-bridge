// repo/extension/content-script.js
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
