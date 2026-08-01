// repo/extension/popup-confirm/confirm.js
const params = new URLSearchParams(location.search);
const url = params.get('url');
const requestId = params.get('requestId');

document.getElementById('message').textContent =
  `firefox-bridge wants to operate on a blacklisted site:\n${url}`;

function respond(choice) {
  browser.runtime.sendMessage({ type: 'confirmation-response', requestId, choice });
  window.close();
}

document.getElementById('once').addEventListener('click', () => respond('once'));
document.getElementById('session').addEventListener('click', () => respond('session'));
document.getElementById('deny').addEventListener('click', () => respond('denied'));
