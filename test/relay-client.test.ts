import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nodeCrypto } from '../../wizzle-protocol/src/crypto-node.ts';
import {
  Session,
  derivePairedRelaySecret,
  deriveRelaySecret,
  encodePacket,
  fromUtf8,
  toB64Url,
  type SessionState,
} from '../../wizzle-protocol/src/index.ts';
import { RelayClient } from '../src/relay-client.ts';
import { FakeWizzle, FakeRelay, bridgeKeys, collectingLog, newPairing, silentLog, until, type TestPairing } from './fake-relay.ts';

function note(text: string): Uint8Array {
  return encodePacket({ id: text, t: 'message', message: { conv: 'c', msgId: text, role: 'agent', text, format: 'text', at: 1 } });
}

function bridgeClient(relay: FakeRelay, pairing: TestPairing, extra: Partial<ConstructorParameters<typeof RelayClient>[0]> = {}) {
  const states: SessionState[] = [];
  const packets: string[] = [];
  let paired = 0;
  const fatal: string[] = [];
  const session = new Session(nodeCrypto, 'bridge', pairing.pairingId, bridgeKeys(pairing));
  const client = new RelayClient({
    transport: relay.transport,
    relayUrl: 'fake',
    pairingId: pairing.pairingId,
    relaySecret: deriveRelaySecret(nodeCrypto, pairing.secret),
    session,
    persist: (state) => void states.push(state),
    log: silentLog,
    onPacket: (plaintext) => void packets.push(fromUtf8(plaintext)),
    onPaired: () => void (paired += 1),
    onFatal: (code) => void fatal.push(code),
    reconnect: { minMs: 5, maxMs: 10 },
    ...extra,
  });
  return { client, session, states, packets, fatal, paired: () => paired };
}

test('hello, handshake, and a round trip through the relay', async () => {
  const relay = new FakeRelay();
  const pairing = newPairing();
  const bridge = bridgeClient(relay, pairing);
  bridge.client.start();
  await until(() => bridge.client.state === 'ready');
  assert.equal(bridge.session.ready, false);
  assert.equal(bridge.client.send(note('too early')), false);

  const wizzle = new FakeWizzle(relay, pairing);
  await wizzle.connect();
  await until(() => bridge.client.peerOnline);
  await wizzle.handshake();
  await until(() => bridge.session.ready && bridge.paired() === 1);

  assert.equal(bridge.client.send(note('hello wizzle')), true);
  await until(() => wizzle.received.length === 1);
  assert.equal(wizzle.received[0]?.header.id, 'hello wizzle');
  wizzle.received.length = 0;

  wizzle.send({ t: 'sync' });
  await until(() => bridge.packets.length === 1);
  assert.match(bridge.packets[0] ?? '', /"t":"sync"/);
  bridge.client.stop();
  wizzle.disconnect();
});

test('persists the counter before a frame leaves', async () => {
  const relay = new FakeRelay();
  const pairing = newPairing();
  const bridge = bridgeClient(relay, pairing);
  bridge.client.start();
  await until(() => bridge.client.state === 'ready');
  const wizzle = new FakeWizzle(relay, pairing);
  await wizzle.connect();
  await wizzle.handshake();
  await until(() => bridge.session.ready);
  const before = bridge.states.length;
  bridge.client.send(note('x'));
  const last = bridge.states[bridge.states.length - 1];
  assert.ok(bridge.states.length > before);
  assert.ok(last);
  const sendEpoch = last.epochs.find((e) => e.id === last.send);
  assert.ok(sendEpoch);
  assert.equal(sendEpoch.sendSeq, '2');
  bridge.client.stop();
  wizzle.disconnect();
});

test('resends unacked frames after a reconnect and stops once acked', async () => {
  const relay = new FakeRelay();
  const pairing = newPairing();
  const log = collectingLog();
  const bridge = bridgeClient(relay, pairing, { log });
  bridge.client.start();
  await until(() => bridge.client.state === 'ready');
  const wizzle = new FakeWizzle(relay, pairing);
  wizzle.autoAck = false;
  await wizzle.connect();
  await wizzle.handshake();
  await until(() => bridge.session.ready);

  relay.drop('bridge');
  await until(() => bridge.client.state === 'connecting');
  assert.equal(bridge.client.send(note('while offline')), true);
  await until(() => bridge.client.state === 'ready');
  await until(() => wizzle.received.length === 1);
  const framesAfterFirst = wizzle.dataFrames;

  // No ack yet, so a second reconnect resends the same frame and wizzle rejects the duplicate.
  relay.drop('bridge');
  await until(() => bridge.client.state === 'connecting');
  await until(() => bridge.client.state === 'ready');
  await until(() => wizzle.dataFrames === framesAfterFirst + 1);
  assert.equal(wizzle.received.length, 1);

  const ack = wizzle.session.ack();
  assert.ok(ack);
  wizzle.autoAck = true;
  wizzle.send({ t: 'sync' });
  await until(() => bridge.packets.length === 1);
  const conn = (wizzle as unknown as { conn: { sendBinary(b: Uint8Array): void } }).conn;
  conn.sendBinary(ack);
  await new Promise((resolve) => setTimeout(resolve, 10));

  relay.drop('bridge');
  await until(() => bridge.client.state === 'connecting');
  await until(() => bridge.client.state === 'ready');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(wizzle.dataFrames, framesAfterFirst + 1);
  assert.ok(log.lines.some((l) => l.startsWith('warn wizzle: relay connection closed')));
  bridge.client.stop();
  wizzle.disconnect();
});

test('frames buffered by the relay while wizzle is offline arrive on reconnect', async () => {
  const relay = new FakeRelay();
  const pairing = newPairing();
  const bridge = bridgeClient(relay, pairing);
  bridge.client.start();
  await until(() => bridge.client.state === 'ready');
  const wizzle = new FakeWizzle(relay, pairing);
  await wizzle.connect();
  await wizzle.handshake();
  await until(() => bridge.session.ready);
  wizzle.disconnect();
  await until(() => !bridge.client.peerOnline);
  bridge.client.send(note('a'));
  bridge.client.send(note('b'));
  await until(() => relay.bufferedFor('wizzle') === 2);

  const state = wizzle.session.exportState();
  const again = new FakeWizzle(relay, pairing, state);
  await again.connect();
  await until(() => again.received.length === 2);
  assert.equal(relay.bufferedFor('wizzle'), 0);
  bridge.client.stop();
  again.disconnect();
});

test('wake goes to the relay only while wizzle is offline, and waits for the next welcome when not attached', async () => {
  const relay = new FakeRelay();
  const pairing = newPairing();
  const bridge = bridgeClient(relay, pairing);
  bridge.client.start();
  await until(() => bridge.client.state === 'ready');
  const wizzle = new FakeWizzle(relay, pairing);
  await wizzle.connect();
  await wizzle.handshake();
  await until(() => bridge.session.ready && bridge.client.peerOnline);

  bridge.client.requestPush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(relay.wakes, 0);

  wizzle.disconnect();
  await until(() => !bridge.client.peerOnline);
  bridge.client.requestPush();
  await until(() => relay.wakes === 1);

  relay.drop('bridge');
  await until(() => bridge.client.state === 'connecting');
  bridge.client.requestPush();
  assert.equal(relay.wakes, 1);
  await until(() => bridge.client.state === 'ready');
  await until(() => relay.wakes === 2);

  relay.drop('bridge');
  await until(() => bridge.client.state === 'connecting');
  await until(() => bridge.client.state === 'ready');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(relay.wakes, 2);
  bridge.client.stop();
});

test('a pending wake is dropped when wizzle is back by the next welcome', async () => {
  const relay = new FakeRelay();
  const pairing = newPairing();
  const bridge = bridgeClient(relay, pairing, { reconnect: { minMs: 40, maxMs: 40 } });
  bridge.client.start();
  await until(() => bridge.client.state === 'ready');
  const wizzle = new FakeWizzle(relay, pairing);
  await wizzle.connect();
  await wizzle.handshake();
  await until(() => bridge.session.ready);
  wizzle.disconnect();
  await until(() => !bridge.client.peerOnline);

  relay.drop('bridge');
  await until(() => bridge.client.state === 'connecting');
  bridge.client.requestPush();
  const again = new FakeWizzle(relay, pairing, wizzle.session.exportState());
  await again.connect();
  await until(() => bridge.client.state === 'ready' && bridge.client.peerOnline);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(relay.wakes, 0);
  bridge.client.stop();
  again.disconnect();
});

test('the outbox is resent when wizzle comes back and wizzle drops the repeat', async () => {
  const relay = new FakeRelay();
  const pairing = newPairing();
  const bridge = bridgeClient(relay, pairing);
  bridge.client.start();
  await until(() => bridge.client.state === 'ready');
  const wizzle = new FakeWizzle(relay, pairing);
  wizzle.autoAck = false;
  await wizzle.connect();
  await wizzle.handshake();
  await until(() => bridge.session.ready);
  bridge.client.send(note('unacked'));
  await until(() => wizzle.received.length === 1);
  wizzle.disconnect();
  await until(() => !bridge.client.peerOnline);

  const again = new FakeWizzle(relay, pairing, wizzle.session.exportState());
  await again.connect();
  await until(() => bridge.client.peerOnline);
  await until(() => again.dataFrames === 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(again.dataFrames, 1);
  assert.equal(again.received.length, 0);
  bridge.client.stop();
  again.disconnect();
});

test('a replayed wizzle frame is dropped silently: no log, no new handshake', async () => {
  const relay = new FakeRelay();
  const pairing = newPairing();
  const log = collectingLog();
  const bridge = bridgeClient(relay, pairing, { log });
  bridge.client.start();
  await until(() => bridge.client.state === 'ready');
  const wizzle = new FakeWizzle(relay, pairing);
  await wizzle.connect();
  await wizzle.handshake();
  await until(() => bridge.session.ready && bridge.paired() === 1);
  const before = log.lines.length;

  const frame = wizzle.session.seal(encodePacket({ id: 'once', t: 'sync' }));
  const conn = (wizzle as unknown as { conn: { sendBinary(b: Uint8Array): void } }).conn;
  conn.sendBinary(frame);
  await until(() => bridge.packets.length === 1);
  conn.sendBinary(frame);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(bridge.packets.length, 1);
  assert.equal(bridge.paired(), 1);
  assert.equal(log.lines.length, before);
  bridge.client.stop();
  wizzle.disconnect();
});

test('an auth error from the relay stops the client for good', async () => {
  const relay = new FakeRelay();
  relay.expectedSecret = 'not-this-one';
  const pairing = newPairing();
  const bridge = bridgeClient(relay, pairing);
  bridge.client.start();
  await until(() => bridge.fatal.length === 1);
  assert.equal(bridge.fatal[0], 'auth');
  assert.equal(bridge.client.state, 'stopped');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(relay.connections, 1);
});

function secrets(pairing: TestPairing) {
  return {
    invite: deriveRelaySecret(nodeCrypto, pairing.secret),
    paired: derivePairedRelaySecret(nodeCrypto, pairing.pairingId, pairing.bridge.privateKey, pairing.wizzle.publicKey),
  };
}

test('pinning wizzle rotates the relay secret and later connects use the paired one', async () => {
  const relay = new FakeRelay();
  const pairing = newPairing();
  const { invite, paired } = secrets(pairing);
  relay.expectedSecret = toB64Url(invite);
  let pinned = false;
  const bridge = bridgeClient(relay, pairing, { pairedSecret: () => (pinned ? paired : null), onPaired: () => void (pinned = true) });
  bridge.client.start();
  await until(() => bridge.client.state === 'ready');
  const wizzle = new FakeWizzle(relay, pairing);
  await wizzle.connect();
  await wizzle.handshake();
  await until(() => relay.rekeys.length === 1);
  assert.equal(relay.rekeys[0], toB64Url(paired));
  assert.equal(relay.expectedSecret, toB64Url(paired));
  relay.drop('bridge');
  await until(() => relay.hellos.length === 3 && bridge.client.state === 'ready');
  assert.deepEqual(relay.hellos, [toB64Url(invite), toB64Url(invite), toB64Url(paired)]);
  assert.equal(relay.rekeys.length, 1);
  assert.deepEqual(bridge.fatal, []);
  bridge.client.stop();
  wizzle.disconnect();
});

test('a relay that missed the rekey gets the invite secret once and the rekey again', async () => {
  const relay = new FakeRelay();
  const pairing = newPairing();
  const { invite, paired } = secrets(pairing);
  relay.expectedSecret = toB64Url(invite);
  const bridge = bridgeClient(relay, pairing, { pairedSecret: () => paired });
  bridge.client.start();
  await until(() => bridge.client.state === 'ready' && relay.rekeys.length === 1);
  assert.deepEqual(relay.hellos, [toB64Url(paired), toB64Url(invite)]);
  assert.equal(relay.expectedSecret, toB64Url(paired));
  assert.deepEqual(bridge.fatal, []);
  bridge.client.stop();
});

test('revoke tells the relay, which cuts off wizzle, and stops the client', async () => {
  const relay = new FakeRelay();
  const pairing = newPairing();
  const bridge = bridgeClient(relay, pairing);
  bridge.client.start();
  await until(() => bridge.client.state === 'ready');
  const wizzle = new FakeWizzle(relay, pairing);
  await wizzle.connect();
  await until(() => bridge.client.peerOnline);
  bridge.client.revoke();
  await until(() => wizzle.control.some((m) => m.t === 'error' && m.code === 'revoked'));
  assert.equal(relay.revoked, 1);
  assert.equal(bridge.client.state, 'stopped');
});
