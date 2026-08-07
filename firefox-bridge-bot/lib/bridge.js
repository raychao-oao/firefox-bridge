// repo/firefox-bridge-bot/lib/bridge.js
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bridgeDir, bridgeSocketPath } from '@firefox-bridge/native-host/src/bridge-dir.js';
import {
  encodeMessage,
  createDecoder,
  MAX_SOCKET_MESSAGE_BYTES,
} from '@firefox-bridge/native-host/src/native-messaging.js';

const SOCKET_FRAME_OPTS = { maxBytes: MAX_SOCKET_MESSAGE_BYTES };
// One-shot connections don't need to track the native-host's own long-poll
// budget as tightly as mcp-server's persistent client does -- 100s covers
// every existing action's worst case (including the 90s host-side bound
// mcp-server/src/bridge-client.js documents) with margin.
const REQUEST_TIMEOUT_MS = 100_000;

// Actions whose successful response hands back a NEW tab this call opened
// (as opposed to e.g. list_tabs, which is purely informational) -- tracked
// so closeAllOpenedTabs() can sweep up anything a script forgot to close.
const TAB_OPENING_ACTIONS = new Set(['open_private_window', 'acquire_tab']);

export async function connectBridge({ socketDir = bridgeDir() } = {}) {
  const socketPath = bridgeSocketPath(socketDir);
  const tokenPath = path.join(socketDir, 'token');
  const token = (await readFile(tokenPath, 'utf8')).trim();

  const socket = net.createConnection(socketPath);
  const pending = new Map(); // requestId -> {resolve, reject, timer}
  const openedTabIds = new Set();
  let authWaiter = null; // set below, cleared once auth-ok arrives
  // Tracks whether the socket is still usable for new writes. Checked by
  // call() so a post-disconnect action (e.g. the cleanup sweep running
  // after a mid-script connection loss) fails FAST instead of silently
  // queuing a request that can only ever resolve via REQUEST_TIMEOUT_MS
  // (100s) -- found by use-codex plan review: socket.write() on a closed
  // socket does not throw synchronously, so without this flag a lost
  // connection could stall cleanup for up to 100s per tracked tab.
  let connected = true;

  function handleMessage(msg) {
    if (authWaiter && msg.type === 'auth-ok') {
      const waiter = authWaiter;
      authWaiter = null;
      waiter();
      return;
    }
    const waiter = pending.get(msg.requestId);
    if (waiter) {
      clearTimeout(waiter.timer);
      pending.delete(msg.requestId);
      waiter.resolve(msg);
    }
  }

  const decoder = createDecoder((msg) => handleMessage(msg), SOCKET_FRAME_OPTS);
  socket.on('data', (chunk) => {
    try {
      decoder.push(chunk);
    } catch (err) {
      // A framing error means the stream is unusable -- same treatment as
      // mcp-server/src/bridge-client.js: drop the connection rather than
      // throw out of a 'data' handler.
      process.stderr.write(`firefox-bridge-bot: framing error, dropping connection: ${err.message}\n`);
      socket.destroy();
    }
  });
  socket.on('close', () => {
    connected = false;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('bridge connection lost'));
    }
    pending.clear();
  });

  await new Promise((resolve, reject) => {
    let settled = false;
    socket.once('connect', () => {
      socket.write(encodeMessage({ type: 'auth', token }, SOCKET_FRAME_OPTS));
    });
    socket.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    socket.once('close', () => {
      if (settled) return;
      settled = true;
      reject(new Error('bridge authentication failed'));
    });
    authWaiter = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
  });

  function call(payload) {
    if (!connected) {
      return Promise.reject(new Error('bridge connection lost'));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve({ ok: false, error: 'request_timeout' });
      }, REQUEST_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      pending.set(requestId, { resolve, reject, timer });
      try {
        socket.write(encodeMessage({ ...payload, requestId }, SOCKET_FRAME_OPTS));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(err);
      }
    });
  }

  // Every action helper resolves with the bridge's raw {ok, ...} response,
  // even when ok is false -- never throws for an action-level failure, only
  // for a transport failure (call()'s own promise rejecting). This is a
  // deliberate convention: it lets scripts branch on `result.error` inline
  // without wrapping every call in try/catch.
  async function action(type, params) {
    const result = await call({ type, ...params });
    if (result.ok && TAB_OPENING_ACTIONS.has(type) && typeof result.tabId === 'number') {
      openedTabIds.add(result.tabId);
    }
    return result;
  }

  return {
    openPrivateWindow: (params) => action('open_private_window', params),
    acquireTab: (params) => action('acquire_tab', params),
    releaseTab: (tabId) => action('release_tab', { tabId }),
    async closeTab(tabId) {
      const result = await action('close_tab', { tabId });
      // Only untrack on CONFIRMED success -- found by use-codex plan review:
      // deleting unconditionally means a failed close_tab (tab still open)
      // silently drops out of closeAllOpenedTabs()'s sweep, defeating the
      // exact orphaned-window scenario the cleanup design exists to catch.
      if (result.ok) openedTabIds.delete(tabId);
      return result;
    },
    navigate: (tabId, url) => action('navigate', { tabId, url }),
    waitFor: (params) => action('wait_for', params),
    waitForNetworkIdle: (tabId, { timeoutMs } = {}) =>
      action('wait_for', { tabId, networkIdle: true, timeoutMs }),
    readArticle: (tabId, { frameId = 0 } = {}) => action('read_article', { tabId, frameId }),
    readPage: (tabId, { frameId = 0 } = {}) => action('read_page', { tabId, frameId }),
    click: (params) => action('click', params),
    type: (params) => action('type', params),
    hover: (params) => action('hover', params),
    listElements: (params) => action('list_elements', params),
    listFrames: (tabId) => action('list_frames', { tabId }),
    scrollTo: (params) => action('scroll_to', params),
    dragAndDrop: (params) => action('drag_and_drop', params),
    pressKey: (params) => action('press_key', params),
    listTabs: () => action('list_tabs', {}),
    listContainers: () => action('list_containers', {}),
    createContainer: (params) => action('create_container', params),
    searchHistory: (query) => action('search_history', { query }),
    goBack: (tabId) => action('go_back', { tabId }),
    goForward: (tabId) => action('go_forward', { tabId }),
    discardTab: (tabIds) => action('discard_tab', { tabIds }),
    startConsole: (tabId) => action('start_console', { tabId }),
    getConsole: (tabId) => action('get_console', { tabId }),
    startNetwork: (tabId) => action('start_network', { tabId }),
    getNetwork: (tabId) => action('get_network', { tabId }),
    addBookmark: (params) => action('add_bookmark', params),
    listBookmarks: (params) => action('list_bookmarks', params),
    searchBookmarks: (query) => action('search_bookmarks', { query }),
    toBeDeleted: (params) => action('to_be_deleted', params),
    // screenshot and upload_file are deliberately NOT here -- see the
    // "Deliberately excluded" note in this task's Interfaces block above.

    async closeAllOpenedTabs() {
      for (const tabId of [...openedTabIds]) {
        try {
          await action('close_tab', { tabId });
        } catch {
          // Best-effort: a transport failure here just means cleanup
          // couldn't run, not something this sweep can recover from.
        }
        openedTabIds.delete(tabId);
      }
    },

    disconnect() {
      socket.destroy();
    },
  };
}
