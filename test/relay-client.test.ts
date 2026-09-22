import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nodeCrypto } from '../../wizzle-protocol/src/crypto-node.ts';
import { Session, derivePsk, deriveRelaySecret, encodePacket, fromUtf8, type SessionState } from '../../wizzle-protocol/src/index.ts';
import { RelayClient } from '../src/relay-client.ts';
import { FakePhone, FakeRelay, collectingLog, newPairing, silentLog, until } from './fake-relay.ts';

function note(text: string): Uint8Array {
  return encodePacket({ id: text, t: 'message', message: { conv: 'c', msgId: text, role: 'agent', text, format: 'text', at: 1 } });
}

function bridgeClient(relay: FakeRelay, pairing: { pairingId: Uint8Array; secret: Uint8Array }, extra: Partial<ConstructorParameters<typeof RelayClient>[0]> = {}) {
  const states: SessionState[] = [];
  const packets: string[] = [];
  let paired = 0;
  const fatal: string[] = [];
  const session = new Session(nodeCrypto, 'bridge', pairing.pairingId, derivePsk(nodeCrypto, pairing.secret));
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

  const phone = new FakePhone(relay, pairing.pairingId, pairing.secret);
  await phone.connect();
  await until(() => bridge.client.peerOnline);
  await phone.handshake();
  await until(() => bridge.session.ready && bridge.paired() === 1);

  assert.equal(bridge.client.send(note('hello phone')), true);
  await until(() => phone.received.length === 1);
  assert.equal(phone.received[0]?.header.id, 'hello phone');
  phone.received.length = 0;

  phone.send({ t: 'sync' });
  await until(() => bridge.packets.length === 1);
  assert.match(bridge.packets[0] ?? '', /"t":"sync"/);
  bridge.client.stop();
  phone.disconnect();
});

test('persists the counter before a frame leaves', async () => {
  const relay = new FakeRelay();
  const pairing = newPairing();
  const bridge = bridgeClient(relay, pairing);
  bridge.client.start();
  await until(() => bridge.client.state === 'ready');
  const phone = new FakePhone(relay, pairing.pairingId, pairing.secret);
  await phone.connect();
  await phone.handshake();
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
  phone.disconnect();
});

test('resends unacked frames after a reconnect and stops once acked', async () => {
  const relay = new FakeRelay();
  const pairing = newPairing();
  const log = collectingLog();
  const bridge = bridgeClient(relay, pairing, { log });
  bridge.client.start();
  await until(() => bridge.client.state === 'ready');
  const phone = new FakePhone(relay, pairing.pairingId, pairing.secret);
  phone.autoAck = false;
  await phone.connect();
  await phone.handshake();
  await until(() => bridge.session.ready);

  relay.drop('bridge');
  await until(() => bridge.client.state === 'connecting');
  assert.equal(bridge.client.send(note('while offline')), true);
  await until(() => bridge.client.state === 'ready');
  await until(() => phone.received.length === 1);
  const framesAfterFirst = phone.dataFrames;

  // No ack yet, so a second reconnect resends the same frame and the phone rejects the duplicate.
  relay.drop('bridge');
  await until(() => bridge.client.state === 'connecting');
  await until(() => bridge.client.state === 'ready');
  await until(() => phone.dataFrames === framesAfterFirst + 1);
  assert.equal(phone.received.length, 1);

  const ack = phone.session.ack();
  assert.ok(ack);
  phone.autoAck = true;
  phone.send({ t: 'sync' });
  await until(() => bridge.packets.length === 1);
  const conn = (phone as unknown as { conn: { sendBinary(b: Uint8Array): void } }).conn;
  conn.sendBinary(ack);
  await new Promise((resolve) => setTimeout(resolve, 10));

  relay.drop('bridge');
  await until(() => bridge.client.state === 'connecting');
  await until(() => bridge.client.state === 'ready');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(phone.dataFrames, framesAfterFirst + 1);
  assert.ok(log.lines.some((l) => l.startsWith('warn wizzle: relay connection closed')));
  bridge.client.stop();
  phone.disconnect();
});

test('frames buffered by the relay while the phone is offline arrive on reconnect', async () => {
  const relay = new FakeRelay();
  const pairing = newPairing();
  const bridge = bridgeClient(relay, pairing);
  bridge.client.start();
  await until(() => bridge.client.state === 'ready');
  const phone = new FakePhone(relay, pairing.pairingId, pairing.secret);
  await phone.connect();
  await phone.handshake();
  await until(() => bridge.session.ready);
  phone.disconnect();
  await until(() => !bridge.client.peerOnline);
  bridge.client.send(note('a'));
  bridge.client.send(note('b'));
  await until(() => relay.bufferedFor('phone') === 2);

  const state = phone.session.exportState();
  const again = new FakePhone(relay, pairing.pairingId, pairing.secret, state);
  await again.connect();
  await until(() => again.received.length === 2);
  assert.equal(relay.bufferedFor('phone'), 0);
  bridge.client.stop();
  again.disconnect();
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
