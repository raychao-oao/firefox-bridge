import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { registerTools } from '../src/tools.js';

function makeFakeServer() {
  const registrations = new Map();
  return {
    registrations,
    registerTool(name, config, handler) {
      registrations.set(name, { config, handler });
    },
  };
}

function makeFakeBridgeClient(result) {
  const calls = [];
  return {
    calls,
    async call(payload) {
      calls.push(payload);
      return result;
    },
  };
}

test('select_option is registered with the expected input schema keys', () => {
  const server = makeFakeServer();
  const bridgeClient = makeFakeBridgeClient({ ok: true });
  registerTools(server, bridgeClient);

  const registration = server.registrations.get('select_option');
  assert.ok(registration, 'select_option should be registered');
  assert.equal(typeof registration.config.description, 'string');
  const schema = registration.config.inputSchema;
  assert.ok(schema.tabId);
  assert.ok(schema.selector);
  assert.ok(schema.text);
  assert.ok(schema.frameId);
  assert.ok(schema.expectedDomEpoch);

  const shape = z.object(schema);

  const validResult = shape.safeParse({ tabId: 1, selector: '#x', text: 'hello' });
  assert.equal(validResult.success, true);
  assert.equal(validResult.data.frameId, undefined);
  assert.equal(validResult.data.expectedDomEpoch, undefined);

  const invalidResult = shape.safeParse({ tabId: 'not-a-number', selector: '#x', text: 'hello' });
  assert.equal(invalidResult.success, false);
});

test('select_option forwards to bridgeClient.call with type "select_option" and wraps a success result', async () => {
  const server = makeFakeServer();
  const fakeResult = { ok: true, value: '6', text: 'CPU X', changed: true };
  const bridgeClient = makeFakeBridgeClient(fakeResult);
  registerTools(server, bridgeClient);

  const { handler } = server.registrations.get('select_option');
  const response = await handler({ tabId: 1, selector: '#cpu', text: 'CPU X' });

  assert.equal(bridgeClient.calls.length, 1);
  assert.deepEqual(bridgeClient.calls[0], {
    type: 'select_option',
    tabId: 1,
    selector: '#cpu',
    text: 'CPU X',
    frameId: undefined,
    expectedDomEpoch: undefined,
  });

  assert.deepEqual(response, {
    content: [{ type: 'text', text: JSON.stringify(fakeResult) }],
    isError: false,
  });
});

test('select_option wraps a failure result with isError: true', async () => {
  const server = makeFakeServer();
  const failResult = { ok: false, error: 'ambiguous_match', matches: [] };
  const bridgeClient = makeFakeBridgeClient(failResult);
  registerTools(server, bridgeClient);

  const { handler } = server.registrations.get('select_option');
  const response = await handler({ tabId: 1, selector: '#cpu', text: 'Intel' });

  assert.equal(response.isError, true);
  assert.equal(response.content[0].text, JSON.stringify(failResult));
});

test('request_tab_selection is registered with a required reason parameter', () => {
  const server = makeFakeServer();
  const bridgeClient = makeFakeBridgeClient({ ok: true, requestId: 'req-1' });
  registerTools(server, bridgeClient);

  const registration = server.registrations.get('request_tab_selection');
  assert.ok(registration, 'request_tab_selection should be registered');
  const schema = registration.config.inputSchema;
  assert.ok(schema.reason);

  const shape = z.object(schema);
  assert.equal(shape.safeParse({}).success, false, 'reason must be required');
  assert.equal(shape.safeParse({ reason: 'checking pricing page' }).success, true);
});

test('request_tab_selection forwards to bridgeClient.call with type "request_tab_selection"', async () => {
  const server = makeFakeServer();
  const fakeResult = { ok: true, requestId: 'req-1' };
  const bridgeClient = makeFakeBridgeClient(fakeResult);
  registerTools(server, bridgeClient);

  const { handler } = server.registrations.get('request_tab_selection');
  const response = await handler({ reason: 'checking pricing page' });

  assert.equal(bridgeClient.calls.length, 1);
  assert.deepEqual(bridgeClient.calls[0], { type: 'request_tab_selection', reason: 'checking pricing page' });
  assert.deepEqual(response, {
    content: [{ type: 'text', text: JSON.stringify(fakeResult) }],
    isError: false,
  });
});

test('get_tab_selection is registered with a required requestId parameter', () => {
  const server = makeFakeServer();
  const bridgeClient = makeFakeBridgeClient({ ok: true, status: 'pending' });
  registerTools(server, bridgeClient);

  const registration = server.registrations.get('get_tab_selection');
  assert.ok(registration, 'get_tab_selection should be registered');
  const schema = registration.config.inputSchema;
  assert.ok(schema.requestId);

  const shape = z.object(schema);
  assert.equal(shape.safeParse({}).success, false, 'requestId must be required');
  assert.equal(shape.safeParse({ requestId: 'req-1' }).success, true);
});

test('get_tab_selection sends the requestId under the wire field selectionRequestId, not requestId, using the default call() timeout', async () => {
  const server = makeFakeServer();
  const fakeResult = { ok: true, status: 'pending' };
  // A bespoke fake here, not makeFakeBridgeClient() -- that shared helper's
  // call(payload) only records its first parameter, so it can't tell the
  // difference between call(payload) and call(payload, someOverride). This
  // test specifically needs to prove NO second argument is ever passed
  // (i.e. no per-call timeout override survived from the earlier,
  // rejected held-open design) -- record every argument via `...args`.
  const calls = [];
  const bridgeClient = {
    calls,
    async call(...args) {
      calls.push(args);
      return fakeResult;
    },
  };
  registerTools(server, bridgeClient);

  const { handler } = server.registrations.get('get_tab_selection');
  const response = await handler({ requestId: 'req-1' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1, 'must call bridgeClient.call() with exactly one argument -- no per-call timeout override');
  assert.deepEqual(calls[0][0], { type: 'get_tab_selection', selectionRequestId: 'req-1' });
  assert.ok(
    !Object.prototype.hasOwnProperty.call(calls[0][0], 'requestId'),
    'must not send under the colliding key "requestId" -- BridgeClient.call() would silently overwrite it with its own transport ID'
  );
  assert.deepEqual(response, {
    content: [{ type: 'text', text: JSON.stringify(fakeResult) }],
    isError: false,
  });
});

test('add_webmcp_whitelist is registered with a required hostname parameter', () => {
  const server = makeFakeServer();
  const bridgeClient = makeFakeBridgeClient({ ok: true, hostname: 'ai-lab.oao.tw' });
  registerTools(server, bridgeClient);

  const registration = server.registrations.get('add_webmcp_whitelist');
  assert.ok(registration, 'add_webmcp_whitelist should be registered');
  const schema = registration.config.inputSchema;
  assert.ok(schema.hostname);

  const shape = z.object(schema);
  assert.equal(shape.safeParse({}).success, false, 'hostname must be required');
  assert.equal(shape.safeParse({ hostname: 'ai-lab.oao.tw' }).success, true);
});

test('add_webmcp_whitelist forwards to bridgeClient.call with type "add_webmcp_whitelist"', async () => {
  const server = makeFakeServer();
  const fakeResult = { ok: true, hostname: 'ai-lab.oao.tw' };
  const bridgeClient = makeFakeBridgeClient(fakeResult);
  registerTools(server, bridgeClient);

  const { handler } = server.registrations.get('add_webmcp_whitelist');
  const response = await handler({ hostname: 'ai-lab.oao.tw' });

  assert.equal(bridgeClient.calls.length, 1);
  assert.deepEqual(bridgeClient.calls[0], { type: 'add_webmcp_whitelist', hostname: 'ai-lab.oao.tw' });
  assert.deepEqual(response, {
    content: [{ type: 'text', text: JSON.stringify(fakeResult) }],
    isError: false,
  });
});

test('remove_webmcp_whitelist forwards to bridgeClient.call with type "remove_webmcp_whitelist"', async () => {
  const server = makeFakeServer();
  const fakeResult = { ok: true, hostname: 'ai-lab.oao.tw' };
  const bridgeClient = makeFakeBridgeClient(fakeResult);
  registerTools(server, bridgeClient);

  const { handler } = server.registrations.get('remove_webmcp_whitelist');
  const response = await handler({ hostname: 'ai-lab.oao.tw' });

  assert.equal(bridgeClient.calls.length, 1);
  assert.deepEqual(bridgeClient.calls[0], { type: 'remove_webmcp_whitelist', hostname: 'ai-lab.oao.tw' });
  assert.equal(response.isError, false);
});

test('webmcp_list_tools is registered with a required tabId parameter', () => {
  const server = makeFakeServer();
  const bridgeClient = makeFakeBridgeClient({ ok: true, documentId: 'doc-1', tools: [] });
  registerTools(server, bridgeClient);

  const registration = server.registrations.get('webmcp_list_tools');
  assert.ok(registration, 'webmcp_list_tools should be registered');
  const schema = registration.config.inputSchema;
  assert.ok(schema.tabId);

  const shape = z.object(schema);
  assert.equal(shape.safeParse({}).success, false, 'tabId must be required');
  assert.equal(shape.safeParse({ tabId: 1 }).success, true);
});

test('webmcp_list_tools forwards to bridgeClient.call with type "webmcp_list_tools"', async () => {
  const server = makeFakeServer();
  const fakeResult = {
    ok: true,
    documentId: 'doc-1',
    tools: [{ name: 'shelters.search', title: '查詢避難收容處所' }],
  };
  const bridgeClient = makeFakeBridgeClient(fakeResult);
  registerTools(server, bridgeClient);

  const { handler } = server.registrations.get('webmcp_list_tools');
  const response = await handler({ tabId: 1 });

  assert.equal(bridgeClient.calls.length, 1);
  assert.deepEqual(bridgeClient.calls[0], { type: 'webmcp_list_tools', tabId: 1 });
  assert.deepEqual(response, {
    content: [{ type: 'text', text: JSON.stringify(fakeResult) }],
    isError: false,
  });
});

test('webmcp_call_tool is registered with required tabId/toolName/documentId parameters and an optional arguments object', () => {
  const server = makeFakeServer();
  const bridgeClient = makeFakeBridgeClient({ ok: true, result: {} });
  registerTools(server, bridgeClient);

  const registration = server.registrations.get('webmcp_call_tool');
  assert.ok(registration, 'webmcp_call_tool should be registered');
  const schema = registration.config.inputSchema;
  assert.ok(schema.tabId);
  assert.ok(schema.toolName);
  assert.ok(schema.documentId);
  assert.ok(schema.arguments);

  const shape = z.object(schema);
  assert.equal(shape.safeParse({ tabId: 1, toolName: 'shelters.search', documentId: 'doc-1' }).success, true);
  assert.equal(shape.safeParse({ tabId: 1, toolName: 'shelters.search' }).success, false, 'documentId must be required');
});

test('webmcp_call_tool forwards to bridgeClient.call with type "webmcp_call_tool"', async () => {
  const server = makeFakeServer();
  const fakeResult = { ok: true, result: { count: 60 } };
  const bridgeClient = makeFakeBridgeClient(fakeResult);
  registerTools(server, bridgeClient);

  const { handler } = server.registrations.get('webmcp_call_tool');
  const response = await handler({
    tabId: 1,
    toolName: 'shelters.search',
    documentId: 'doc-1',
    arguments: { city: '新竹市', category: '避難收容處所' },
  });

  assert.equal(bridgeClient.calls.length, 1);
  assert.deepEqual(bridgeClient.calls[0], {
    type: 'webmcp_call_tool',
    tabId: 1,
    toolName: 'shelters.search',
    documentId: 'doc-1',
    arguments: { city: '新竹市', category: '避難收容處所' },
  });
  assert.deepEqual(response, {
    content: [{ type: 'text', text: JSON.stringify(fakeResult) }],
    isError: false,
  });
});

test('webmcp_call_tool wraps a stale_registration failure with isError: true', async () => {
  const server = makeFakeServer();
  const failResult = { ok: false, error: 'stale_registration' };
  const bridgeClient = makeFakeBridgeClient(failResult);
  registerTools(server, bridgeClient);

  const { handler } = server.registrations.get('webmcp_call_tool');
  const response = await handler({ tabId: 1, toolName: 'shelters.search', documentId: 'stale-doc', arguments: {} });

  assert.equal(response.isError, true);
  assert.equal(response.content[0].text, JSON.stringify(failResult));
});
