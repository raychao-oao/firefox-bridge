export const MAX_MESSAGE_BYTES = 1024 * 1024; // Firefox native messaging cap (1 MiB)

export function encodeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  // Account for 4-byte header: total frame (header + body) must not exceed MAX_MESSAGE_BYTES
  if (json.length + 4 > MAX_MESSAGE_BYTES) {
    throw new Error(`Encoded message (${json.length + 4} bytes total with header) exceeds MAX_MESSAGE_BYTES (${MAX_MESSAGE_BYTES})`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

export function createDecoder(onMessage) {
  let buffer = Buffer.alloc(0);

  function push(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (buffer.length < 4) return;
      const len = buffer.readUInt32LE(0);
      if (len > MAX_MESSAGE_BYTES) {
        throw new Error(`Incoming message length (${len}) exceeds MAX_MESSAGE_BYTES (${MAX_MESSAGE_BYTES})`);
      }
      if (buffer.length < 4 + len) return; // wait for more data
      const jsonBytes = buffer.subarray(4, 4 + len);
      buffer = buffer.subarray(4 + len);
      onMessage(JSON.parse(jsonBytes.toString('utf8')));
    }
  }

  return { push };
}
