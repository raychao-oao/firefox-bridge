// repo/extension/bookmark-helpers.js
//
// Pure functions with no browser.* dependency, shared by add_bookmark/
// list_bookmarks/search_bookmarks handlers in background.js. Loaded as a
// plain background-page global there (see manifest.json's background.scripts
// — must be listed before background.js). Also require()'d directly from
// native-host/test/bookmark-helpers.test.js via createRequire, same dual-mode
// pattern as policy-gate.js in this directory.

function parseFolderPath(folder) {
  if (typeof folder !== 'string') return [];
  return folder
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function isIPv4PrivateOrLoopback(hostname) {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8 (loopback, not just 127.0.0.1)
  return false;
}

function isIPv6PrivateOrLoopback(hostname) {
  if (hostname === '::1') return true; // loopback
  if (/^f[cd]/.test(hostname)) return true; // fc00::/7 (unique local address)
  if (/^fe[89ab]/.test(hostname)) return true; // fe80::/10 (link-local)
  return false;
}

function isPrivateAddress(hostname) {
  if (typeof hostname !== 'string') return false;
  const h = hostname.toLowerCase();
  if (h === 'localhost') return true;
  if (h.includes(':')) return isIPv6PrivateOrLoopback(h);
  return isIPv4PrivateOrLoopback(h);
}

function needsTitleWarning(title, url, hostname) {
  const t = String(title).trim().toLowerCase();
  if (t === '') return true;
  if (t === String(url).trim().toLowerCase()) return true;
  if (t === String(hostname).trim().toLowerCase()) return true;
  return false;
}

if (typeof module !== 'undefined') {
  module.exports = { parseFolderPath, isPrivateAddress, needsTitleWarning };
}
