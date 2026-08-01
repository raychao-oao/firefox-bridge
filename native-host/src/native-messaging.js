// Firefox native messaging cap (1 MiB). This is a hard protocol limit on the
// Firefox <-> native-host hop and cannot be raised.
export const MAX_MESSAGE_BYTES = 1024 * 1024;

// The unix-socket hop (mcp-server <-> native-host) reuses the same framing for
// convenience but is NOT subject to Firefox's cap — it only needs a sanity
// bound so a corrupt/hostile length prefix can't cause unbounded buffering.
// Screenshot payloads redeemed via `payload-read` legitimately exceed 1 MiB.
export const MAX_SOCKET_MESSAGE_BYTES = 64 * 1024 * 1024;

export function encodeMessage(obj, { maxBytes = MAX_MESSAGE_BYTES } = {}) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  // Account for 4-byte header: total frame (header + body) must not exceed maxBytes
  if (json.length + 4 > maxBytes) {
    throw new Error(`Encoded message (${json.length + 4} bytes total with header) exceeds MAX_MESSAGE_BYTES (${maxBytes})`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

export function createDecoder(onMessage, { maxBytes = MAX_MESSAGE_BYTES } = {}) {
  let buffer = Buffer.alloc(0);

  function push(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (buffer.length < 4) return;
      const len = buffer.readUInt32LE(0);
      if (len > maxBytes) {
        throw new Error(`Incoming message length (${len}) exceeds MAX_MESSAGE_BYTES (${maxBytes})`);
      }
      if (buffer.length < 4 + len) return; // wait for more data
      const jsonBytes = buffer.subarray(4, 4 + len);
      buffer = buffer.subarray(4 + len);
      onMessage(JSON.parse(jsonBytes.toString('utf8')));
    }
  }

  return { push };
}
