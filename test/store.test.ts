import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { BridgeStore, ROOM_ARCHIVE_MAX } from '../src/store.ts';

const RECORD = { relay: 'wss://r', pairingId: 'abc', secret: 'def', bridgePublic: 'pub', bridgePrivate: 'priv', expiresAt: 1_900_000_000, createdAt: '2026-01-01T00:00:00.000Z' };

function tempStore(): BridgeStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizzle-store-'));
  return new BridgeStore(path.join(dir, 'wizzle'));
}

test('pairing round trip with private file modes', () => {
  const store = tempStore();
  assert.equal(store.loadPairing(), null);
  store.savePairing(RECORD);
  const loaded = store.loadPairing();
  assert.equal(loaded?.pairingId, 'abc');
  assert.equal(loaded?.pairedAt, undefined);
  const mode = fs.statSync(path.join(store.dir, 'pairing.json')).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal(fs.statSync(store.dir).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(store.dir), ['pairing.json']);
});

test('markPaired pins wizzle key once', () => {
  const store = tempStore();
  store.markPaired('wizzle');
  assert.equal(store.loadPairing(), null);
  store.savePairing(RECORD);
  store.markPaired('wizzle');
  const first = store.loadPairing();
  assert.ok(first?.pairedAt);
  assert.equal(first?.wizzleKey, 'wizzle');
  store.markPaired('wizzle');
  assert.equal(store.loadPairing()?.pairedAt, first?.pairedAt);
});

test('a pairing without static keys reads as none', () => {
  const store = tempStore();
  const { bridgePublic: _pub, bridgePrivate: _priv, expiresAt: _exp, ...old } = RECORD;
  fs.mkdirSync(store.dir, { recursive: true });
  fs.writeFileSync(path.join(store.dir, 'pairing.json'), JSON.stringify(old));
  assert.equal(store.loadPairing(), null);
});

test('session state round trip and clear', () => {
  const store = tempStore();
  assert.equal(store.loadSession(), null);
  const state = { epochs: [{ id: 'e', sendKey: 'k', recvKey: 'r', sendSeq: '3', recvSeq: '1' }], send: 'e' };
  store.saveSession(state);
  assert.deepEqual(store.loadSession(), state);
  store.savePairing(RECORD);
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

test('a room archive round trips, keeps the newest messages and goes with its room', () => {
  const store = tempStore();
  assert.deepEqual(store.loadRoomArchive('r1'), []);
  const messages = Array.from({ length: ROOM_ARCHIVE_MAX + 5 }, (_, i) => ({
    conv: 'wizzle:room:r1',
    msgId: `m${i}`,
    role: 'agent' as const,
    text: `said ${i}`,
    format: 'markdown' as const,
    at: i,
    speaker: 'g3',
  }));
  store.saveRoomArchive('r1', messages);
  const loaded = store.loadRoomArchive('r1');
  assert.equal(loaded.length, ROOM_ARCHIVE_MAX);
  assert.equal(loaded[0]?.msgId, 'm5');
  assert.equal(fs.statSync(path.join(store.dir, 'rooms', 'r1.json')).mode & 0o777, 0o600);
  store.dropRoomArchive('r1');
  assert.deepEqual(store.loadRoomArchive('r1'), []);
  store.dropRoomArchive('r1');
  assert.throws(() => store.loadRoomArchive('../pairing'), /bad room id/);
});
