import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { BridgeStore } from '../src/store.ts';

function tempStore(): BridgeStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizzle-store-'));
  return new BridgeStore(path.join(dir, 'wizzle'));
}

test('pairing round trip with private file modes', () => {
  const store = tempStore();
  assert.equal(store.loadPairing(), null);
  store.savePairing({ relay: 'wss://r', pairingId: 'abc', secret: 'def', createdAt: '2026-01-01T00:00:00.000Z' });
  const loaded = store.loadPairing();
  assert.equal(loaded?.pairingId, 'abc');
  assert.equal(loaded?.pairedAt, undefined);
  const mode = fs.statSync(path.join(store.dir, 'pairing.json')).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal(fs.statSync(store.dir).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(store.dir), ['pairing.json']);
});

test('markPaired stamps once', () => {
  const store = tempStore();
  store.markPaired();
  assert.equal(store.loadPairing(), null);
  store.savePairing({ relay: 'wss://r', pairingId: 'abc', secret: 'def', createdAt: '2026-01-01T00:00:00.000Z' });
  store.markPaired();
  const first = store.loadPairing()?.pairedAt;
  assert.ok(first);
  store.markPaired();
  assert.equal(store.loadPairing()?.pairedAt, first);
});

test('session state round trip and clear', () => {
  const store = tempStore();
  assert.equal(store.loadSession(), null);
  const state = { epochs: [{ id: 'e', sendKey: 'k', recvKey: 'r', sendSeq: '3', recvSeq: '1' }], send: 'e' };
  store.saveSession(state);
  assert.deepEqual(store.loadSession(), state);
  store.savePairing({ relay: 'wss://r', pairingId: 'abc', secret: 'def', createdAt: '2026-01-01T00:00:00.000Z' });
  store.clear();
  assert.equal(store.loadSession(), null);
  assert.equal(store.loadPairing(), null);
  store.clear();
});

test('invite text is kept until cleared', () => {
  const store = tempStore();
  store.saveInvite('scan me\n');
  assert.equal(fs.readFileSync(store.inviteFile, 'utf8'), 'scan me\n');
  assert.equal(fs.statSync(store.inviteFile).mode & 0o777, 0o600);
  store.clearInvite();
  assert.equal(fs.existsSync(store.inviteFile), false);
  store.clearInvite();
  store.saveInvite('again\n');
  store.clear();
  assert.equal(fs.existsSync(store.inviteFile), false);
});
