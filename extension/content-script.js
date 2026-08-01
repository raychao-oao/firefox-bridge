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
    return Promise.resolve({ ok: true, text: document.body.innerText });
  }

  return false; // not handled by this listener
});
