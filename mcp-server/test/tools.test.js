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
