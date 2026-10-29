import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { nodeCrypto } from '../../wizzle-protocol/src/crypto-node.ts';
import { derivePairedRelaySecret, deriveRelaySecret, fromB64Url, parseInvite, toB64Url } from '../../wizzle-protocol/src/index.ts';
import { WizzleBridge, type BridgeHost } from '../src/bridge.ts';
import { DEFAULT_RELAY_URL, PairingManager, inviteText, isRelayUrl, type PairingManagerOptions } from '../src/pairing.ts';
import { encodeQr } from '../src/qr.ts';
import { BridgeStore } from '../src/store.ts';
import { FakeWizzle, FakeRelay, silentLog, until, type TestPairing } from './fake-relay.ts';

const host = {
  runtime: 'test',
  hostName: 'box',
  listAgents: async () => [],
  history: async () => ({ messages: [], hasMore: false }),
  activity: async () => ({ running: false }),
  questionRender: async () => undefined,
} as unknown as BridgeHost;

const running: Array<() => void> = [];
afterEach(() => {
  for (const stop of running.splice(0)) stop();
});

function setup(extra: Partial<PairingManagerOptions> = {}, store = new BridgeStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wizzle-pairing-')), 'wizzle'))) {
  const relay = new FakeRelay();
  const bridge = new WizzleBridge({ host, log: silentLog });
  const announced: string[] = [];
  const manager = new PairingManager({
    bridge,
    store,
    crypto: nodeCrypto,
    transport: relay.transport,
    log: silentLog,
    relay: 'wss://relay.example.com',
    name: 'box',
    runtime: 'nanoclaw',
    announce: (url) => void announced.push(url),
    reconnect: { minMs: 5, maxMs: 10 },
    ...extra,
  });
  bridge.start({ onInbound: () => undefined, onAction: () => undefined });
  running.push(() => {
    manager.stop();
    bridge.stop();
  });
  return { relay, bridge, store, manager, announced };
}

// What wizzle learns from the QR code, plus a static key of its own.
function scan(url: string): TestPairing {
  const invite = parseInvite(url);
  return {
    pairingId: invite.pairingId,
    secret: invite.secret,
    bridge: { publicKey: invite.bridgeKey, privateKey: new Uint8Array(32) },
    wizzle: nodeCrypto.x25519KeyPair(),
  };
}

test('an issued invite pairs one wizzle, pins it, and rotates the relay secret', async () => {
  const t = setup();
  const issued = t.manager.issue(false);
  assert.equal(t.manager.state, 'inviting');
  assert.deepEqual(t.announced, [issued.url]);
  const invite = parseInvite(issued.url);
  assert.equal(invite.relay, 'wss://relay.example.com');
  assert.equal(invite.expiresAt, issued.expiresAt);
  assert.ok(issued.expiresAt * 1000 > Date.now() + 14 * 60_000);
  t.relay.expectedSecret = toB64Url(deriveRelaySecret(nodeCrypto, invite.secret));
  await until(() => t.bridge.connected);

  const pairing = scan(issued.url);
  const wizzle = new FakeWizzle(t.relay, pairing);
  await wizzle.connect();
  await wizzle.handshake();
  await until(() => t.manager.state === 'paired' && t.relay.rekeys.length === 1);
  assert.equal(t.store.loadPairing()?.wizzleKey, toB64Url(pairing.wizzle.publicKey));
  const bridgePrivate = fromB64Url(t.store.loadPairing()?.bridgePrivate ?? '');
  const paired = derivePairedRelaySecret(nodeCrypto, pairing.pairingId, bridgePrivate, pairing.wizzle.publicKey);
  assert.equal(t.relay.expectedSecret, toB64Url(paired));
  wizzle.disconnect();
});

test('a paired wizzle is only replaced on request, which revokes it at the relay', async () => {
  const t = setup();
  const first = t.manager.issue(false);
  await until(() => t.bridge.connected);
  const wizzle = new FakeWizzle(t.relay, scan(first.url));
  await wizzle.connect();
  await wizzle.handshake();
  await until(() => t.manager.state === 'paired');
  assert.throws(() => t.manager.issue(false), (err: Error & { code?: string }) => err.code === 'paired');
  const second = t.manager.issue(true);
  await until(() => wizzle.control.some((m) => m.t === 'error' && m.code === 'revoked'));
  assert.equal(t.relay.revoked, 1);
  assert.equal(t.manager.state, 'inviting');
  assert.notEqual(parseInvite(second.url).pairingId.join(), parseInvite(first.url).pairingId.join());
  assert.equal(t.store.loadPairing()?.wizzleKey, undefined);
});

test('an invite nobody scans expires, is revoked, and leaves nothing on disk', async () => {
  // Expiry is whole seconds, so 1.5 s leaves at least half a second to connect first.
  const t = setup({ ttlMs: 1500 });
  t.manager.issue(false);
  await until(() => t.bridge.connected);
  await until(() => t.manager.state === 'none', 3000);
  assert.equal(t.relay.revoked, 1);
  assert.equal(t.store.loadPairing(), null);
  assert.equal(t.bridge.connected, false);
});

test('start resumes a paired install quietly and a pending invite loudly, and drops an expired one', async () => {
  const first = setup();
  const issued = first.manager.issue(false);
  await until(() => first.bridge.connected);
  const wizzle = new FakeWizzle(first.relay, scan(issued.url));
  await wizzle.connect();
  await wizzle.handshake();
  await until(() => first.manager.state === 'paired');
  wizzle.disconnect();
  first.manager.stop();

  const resumed = setup({}, first.store);
  resumed.manager.start();
  assert.equal(resumed.manager.state, 'paired');
  assert.deepEqual(resumed.announced, []);
  await until(() => resumed.bridge.connected);
  assert.equal(resumed.relay.hellos[0], toB64Url(derivePairedRelaySecret(nodeCrypto, scan(issued.url).pairingId, fromB64Url(first.store.loadPairing()?.bridgePrivate ?? ''), fromB64Url(first.store.loadPairing()?.wizzleKey ?? ''))));
  resumed.manager.stop();

  const pending = setup();
  const url = pending.manager.issue(false).url;
  pending.manager.stop();
  const again = setup({}, pending.store);
  again.manager.start();
  assert.equal(again.manager.state, 'inviting');
  assert.deepEqual(again.announced, [url]);
  again.manager.stop();

  const later = setup({ now: () => Date.now() + 60 * 60_000 }, pending.store);
  later.manager.start();
  assert.equal(later.manager.state, 'none');
  assert.equal(pending.store.loadPairing(), null);
});

test('wizzle that removes the bridge resets it to unpaired', async () => {
  const t = setup();
  const issued = t.manager.issue(false);
  await until(() => t.bridge.connected);
  const wizzle = new FakeWizzle(t.relay, scan(issued.url));
  await wizzle.connect();
  await wizzle.handshake();
  await until(() => t.manager.state === 'paired');
  wizzle.revoke();
  await until(() => t.manager.state === 'none');
  assert.equal(t.store.loadPairing(), null);
});

test('relay urls must be wss unless the relay is on this machine', () => {
  assert.ok(isRelayUrl(DEFAULT_RELAY_URL));
  assert.ok(isRelayUrl('wss://relay.example.com:8443/ws'));
  assert.ok(isRelayUrl('ws://127.0.0.1:7373'));
  assert.ok(isRelayUrl('ws://localhost:7373'));
  assert.ok(!isRelayUrl('ws://192.168.1.84:7373'));
  assert.ok(!isRelayUrl('https://relay.example.com'));
  assert.ok(!isRelayUrl('not a url'));
});

test('a real invite fits the terminal QR code', () => {
  const t = setup({ relay: DEFAULT_RELAY_URL, name: 'a8784661' });
  const issued = t.manager.issue(false);
  assert.doesNotThrow(() => encodeQr(issued.url, { level: 'L' }));
  const text = inviteText(issued.url, issued.expiresAt);
  assert.ok(text.includes(issued.url));
  assert.match(text, /in 15 minutes/);
});
