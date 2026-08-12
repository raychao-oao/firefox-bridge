// repo/extension/options/options.js
async function loadAndRender() {
  const { blacklist = [] } = await browser.storage.local.get('blacklist');
  const list = document.getElementById('blacklist-items');
  list.innerHTML = '';
  for (const hostname of blacklist) {
    const li = document.createElement('li');
    li.textContent = hostname + ' ';
    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => removeHostname(hostname));
    li.appendChild(removeBtn);
    list.appendChild(li);
  }
}

// PolicyGate.isBlacklisted() compares against new URL(url).hostname — a bare
// hostname like "www.example.com", never a full URL. Storing anything else
// (a pasted "https://www.example.com/") makes the entry silently never match.
function normalizeHostname(value) {
  try {
    const hasScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value);
    const url = new URL(hasScheme ? value : `http://${value}`);
    return url.hostname || null;
  } catch {
    return null;
  }
}

async function addHostname(hostname) {
  const { blacklist = [] } = await browser.storage.local.get('blacklist');
  if (!blacklist.includes(hostname)) {
    await browser.storage.local.set({ blacklist: [...blacklist, hostname] });
  }
  await loadAndRender();
}

async function removeHostname(hostname) {
  const { blacklist = [] } = await browser.storage.local.get('blacklist');
  await browser.storage.local.set({ blacklist: blacklist.filter((h) => h !== hostname) });
  await loadAndRender();
}

document.getElementById('add-hostname').addEventListener('click', () => {
  const input = document.getElementById('new-hostname');
  const errorEl = document.getElementById('hostname-error');
  const value = input.value.trim();
  if (!value) return;

  const hostname = normalizeHostname(value);
  if (!hostname) {
    errorEl.textContent = `"${value}" doesn't look like a valid hostname.`;
    errorEl.style.display = '';
    return;
  }

  errorEl.style.display = 'none';
  addHostname(hostname);
  input.value = '';
});

loadAndRender();

async function loadAndRenderDialogWhitelist() {
  const { dialogWhitelist = [] } = await browser.storage.local.get('dialogWhitelist');
  const list = document.getElementById('dialog-whitelist-items');
  list.innerHTML = '';
  for (const hostname of dialogWhitelist) {
    const li = document.createElement('li');
    li.textContent = hostname + ' ';
    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => removeDialogHostname(hostname));
    li.appendChild(removeBtn);
    list.appendChild(li);
  }
}

async function addDialogHostname(hostname) {
  const { dialogWhitelist = [] } = await browser.storage.local.get('dialogWhitelist');
  if (!dialogWhitelist.includes(hostname)) {
    await browser.storage.local.set({ dialogWhitelist: [...dialogWhitelist, hostname] });
  }
  await loadAndRenderDialogWhitelist();
}

async function removeDialogHostname(hostname) {
  const { dialogWhitelist = [] } = await browser.storage.local.get('dialogWhitelist');
  await browser.storage.local.set({ dialogWhitelist: dialogWhitelist.filter((h) => h !== hostname) });
  await loadAndRenderDialogWhitelist();
}

document.getElementById('add-dialog-hostname').addEventListener('click', () => {
  const input = document.getElementById('new-dialog-hostname');
  const errorEl = document.getElementById('dialog-hostname-error');
  const value = input.value.trim();
  if (!value) return;

  const hostname = normalizeHostname(value);
  if (!hostname) {
    errorEl.textContent = `"${value}" doesn't look like a valid hostname.`;
    errorEl.style.display = '';
    return;
  }

  errorEl.style.display = 'none';
  addDialogHostname(hostname);
  input.value = '';
});

loadAndRenderDialogWhitelist();
