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
  const value = input.value.trim();
  if (value) {
    addHostname(value);
    input.value = '';
  }
});

loadAndRender();
