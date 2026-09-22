import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nodeCrypto } from '../../wizzle-protocol/src/crypto-node.ts';
import { MAX_FILE_BYTES, Session, derivePsk, deriveRelaySecret, fromUtf8, utf8 } from '../../wizzle-protocol/src/index.ts';
import { SYSTEM_CONV, WizzleBridge, type BridgeHost, type HostAgent, type HostConversation, type InboundText } from '../src/bridge.ts';
import { FakePhone, FakeRelay, newPairing, silentLog, until } from './fake-relay.ts';

type Inbound = { conv: string; message: InboundText };
type Action = { questionId: string; value: string };

function fakeHost() {
  const agents: HostAgent[] = [
    { id: 'g1', name: 'Andy', conv: 'wizzle:agent:g1', status: 'idle', model: 'opus' },
    { id: 'g2', name: 'Ops', conv: 'wizzle:agent:g2', status: 'running', lastAt: 1700000000000 },
  ];
  const activity = { running: true, tool: 'Bash' };
  const host: BridgeHost = {
    runtime: 'test',
    runtimeVersion: '9',
    hostName: 'box',
    listAgents: async () => [...agents],
    history: async (conv, limit) => ({
      messages: [{ conv, msgId: 'h1', role: 'user', text: `limit ${limit}`, format: 'text', at: 1 }],
      hasMore: true,
    }),
    activity: async (conv) => (conv === 'wizzle:agent:g2' ? activity : { running: false }),
    questionRender: async (questionId) =>
      questionId === 'q1' ? { title: 'Pick one', question: 'Which?', options: [{ label: 'A', value: 'a', style: 'primary' }] } : undefined,
    createAgent: async (name) => {
      const created: HostAgent = { id: `g${agents.length + 1}`, name, conv: `wizzle:agent:g${agents.length + 1}`, status: 'idle' };
      agents.push(created);
      return created;
    },
  };
  return { host, agents };
}

async function paired(built: { host: BridgeHost; agents: HostAgent[] } = fakeHost()) {
  const relay = new FakeRelay();
  const pairing = newPairing();
  const { host, agents } = built;
  const bridge = new WizzleBridge({ host, log: silentLog });
  const session = new Session(nodeCrypto, 'bridge', pairing.pairingId, derivePsk(nodeCrypto, pairing.secret));
  const inbound: Inbound[] = [];
  const actions: Action[] = [];
  bridge.addPairing({
    id: 'default',
    relayUrl: 'fake',
    pairingId: pairing.pairingId,
    relaySecret: deriveRelaySecret(nodeCrypto, pairing.secret),
    session,
    transport: relay.transport,
    persist: () => undefined,
    reconnect: { minMs: 5, maxMs: 10 },
  });
  bridge.start({
    onInbound: (conv, message) => void inbound.push({ conv, message }),
    onAction: (questionId, value) => void actions.push({ questionId, value }),
  });
  await until(() => bridge.connected);
  const phone = new FakePhone(relay, pairing.pairingId, pairing.secret);
  await phone.connect();
  await phone.handshake();
  await until(() => session.ready && bridge.peerOnline);
  return { relay, bridge, phone, inbound, actions, agents, session };
}

test('sync answers with hello, agents, conversations, and running activity', async () => {
  const t = await paired();
  t.phone.send({ t: 'sync' });
  const hello = await t.phone.nextOf('hello');
  assert.equal(hello.header.runtime, 'test');
  assert.equal(hello.header.host, 'box');
  const caps = hello.header.capabilities as Record<string, boolean>;
  assert.equal(caps.createAgent, true);
  assert.equal(caps.streaming, false);
  assert.equal(caps.topics, false);
  const agents = await t.phone.nextOf('agents');
  const list = agents.header.agents as Array<{ id: string; model?: string }>;
  assert.deepEqual(list.map((a) => a.id), ['g1', 'g2', 'system']);
  assert.equal(list[0]?.model, 'opus');
  const conversations = await t.phone.nextOf('conversations');
  const convs = conversations.header.conversations as Array<{ id: string; lastAt?: number }>;
  assert.deepEqual(convs.map((c) => c.id), ['wizzle:agent:g1', 'wizzle:agent:g2', SYSTEM_CONV]);
  assert.equal(convs[1]?.lastAt, 1700000000000);
  const activity = await t.phone.nextOf('activity');
  assert.deepEqual(activity.header.activity, { conv: 'wizzle:agent:g2', state: 'tool', tool: 'Bash' });
  t.bridge.stop();
});

test('send reaches the runtime and bad targets are rejected', async () => {
  const t = await paired();
  t.phone.send({ t: 'send', conv: 'wizzle:agent:g1', msgId: 'm1', text: 'hi there' });
  await until(() => t.inbound.length === 1);
  assert.equal(t.inbound[0]?.conv, 'wizzle:agent:g1');
  assert.equal(t.inbound[0]?.message.text, 'hi there');
  assert.match(t.inbound[0]?.message.id ?? '', /^wizzle-/);

  t.phone.send({ t: 'send', conv: 'wizzle:agent:nope', msgId: 'm2', text: 'x', id: 'req2' });
  const unknown = await t.phone.nextOf('error');
  assert.equal(unknown.header.code, 'unknown_conv');
  assert.equal(unknown.header.ref, 'req2');

  t.phone.send({ t: 'send', conv: SYSTEM_CONV, msgId: 'm3', text: 'x' });
  const readOnly = await t.phone.nextOf('error');
  assert.equal(readOnly.header.code, 'read_only');

  t.phone.send({ t: 'send', conv: 'wizzle:agent:g1', msgId: 'm4', text: '   ' });
  const empty = await t.phone.nextOf('error');
  assert.equal(empty.header.code, 'empty');
  assert.equal(t.inbound.length, 1);
  t.bridge.stop();
});

test('uploads attach to the next send as base64', async () => {
  const t = await paired();
  const bytes = utf8('file body');
  t.phone.send({ t: 'upload', uploadId: 'u1', file: { name: '../evil/notes.txt', mime: 'text/plain', size: bytes.length } }, bytes);
  t.phone.send({ t: 'send', conv: 'wizzle:agent:g1', msgId: 'm1', text: 'see file', attachments: ['u1'] });
  await until(() => t.inbound.length === 1);
  const att = t.inbound[0]?.message.attachments?.[0];
  assert.ok(att);
  assert.equal(att.name, '.._evil_notes.txt');
  assert.equal(att.mimeType, 'text/plain');
  assert.equal(att.size, bytes.length);
  assert.equal(Buffer.from(att.data, 'base64').toString(), 'file body');

  t.phone.send({ t: 'send', conv: 'wizzle:agent:g1', msgId: 'm2', text: 'again', attachments: ['u1'] });
  const missing = await t.phone.nextOf('error');
  assert.equal(missing.header.code, 'missing_upload');

  t.phone.send({ t: 'upload', uploadId: 'u2', file: { name: 'empty', mime: 'text/plain', size: 0 } }, new Uint8Array(0));
  const tooSmall = await t.phone.nextOf('error');
  assert.equal(tooSmall.header.code, 'too_large');
  t.bridge.stop();
});

test('answers and approvals route to onAction', async () => {
  const t = await paired();
  t.phone.send({ t: 'answer', questionId: 'q1', value: 'a' });
  t.phone.send({ t: 'resolve', approvalId: 'ap1', decision: 'allow' });
  await until(() => t.actions.length === 2);
  assert.deepEqual(t.actions, [
    { questionId: 'q1', value: 'a' },
    { questionId: 'ap1', value: 'allow' },
  ]);
  t.bridge.stop();
});

test('history comes from the host with a clamped limit', async () => {
  const t = await paired();
  t.phone.send({ t: 'history', conv: 'wizzle:agent:g1', limit: 9999 });
  const history = await t.phone.nextOf('history');
  const messages = history.header.messages as Array<{ text: string }>;
  assert.equal(messages[0]?.text, 'limit 200');
  assert.equal(history.header.hasMore, true);
  t.phone.send({ t: 'history', conv: SYSTEM_CONV });
  const system = await t.phone.nextOf('history');
  assert.deepEqual(system.header.messages, []);
  t.bridge.stop();
});

test('deliver maps runtime output to packets', async () => {
  const t = await paired();
  const conv = 'wizzle:agent:g1';
  t.phone.send({ t: 'send', conv, msgId: 'm1', text: 'go' });
  await until(() => t.inbound.length === 1);

  const textId = await t.bridge.deliver(conv, { kind: 'chat', content: { text: 'reply **bold**' } });
  const message = await t.phone.nextOf('message');
  const body = message.header.message as { msgId: string; role: string; text: string; format: string };
  assert.equal(body.msgId, textId);
  assert.equal(body.role, 'agent');
  assert.equal(body.text, 'reply **bold**');
  assert.equal(body.format, 'markdown');
  const idle = await t.phone.nextOf('activity');
  assert.deepEqual(idle.header.activity, { conv, state: 'idle' });

  const questionId = await t.bridge.deliver(SYSTEM_CONV, {
    kind: 'chat',
    content: { type: 'ask_question', questionId: 'q1', title: 'ignored', question: 'ignored', options: [] },
  });
  assert.equal(questionId, 'q1');
  const question = await t.phone.nextOf('question');
  assert.deepEqual(question.header.question, {
    conv: SYSTEM_CONV,
    questionId: 'q1',
    question: 'Which?',
    options: [{ label: 'A', value: 'a', style: 'primary' }],
    title: 'Pick one',
  });

  await t.bridge.deliver('wizzle:agent:g2', {
    kind: 'chat',
    content: { operation: 'edit', messageId: 'q1', text: 'Chose A', terminalCard: { title: 'Pick one', question: 'Which?', resolution: 'A' } },
  });
  const edit = await t.phone.nextOf('edit');
  assert.equal(edit.header.conv, SYSTEM_CONV);
  assert.equal(edit.header.text, 'Chose A');
  assert.deepEqual(edit.header.terminal, { resolution: 'A' });
  const resolved = await t.phone.nextOf('question_resolved');
  assert.equal(resolved.header.questionId, 'q1');

  await t.bridge.deliver(conv, { kind: 'chat', content: { operation: 'reaction', messageId: 'abc', emoji: '👍' } });
  const reaction = await t.phone.nextOf('reaction');
  assert.equal(reaction.header.msgId, 'abc');

  await t.bridge.deliver(conv, { kind: 'chat', content: { card: { kind: 'x' }, fallbackText: 'plain' } });
  const card = await t.phone.nextOf('card');
  assert.equal(card.header.fallbackText, 'plain');

  const data = utf8('attachment bytes');
  await t.bridge.deliver(conv, { kind: 'chat', content: 'here you go', files: [{ filename: 'out.txt', data }] });
  await t.phone.nextOf('message');
  const file = await t.phone.nextOf('file');
  assert.deepEqual(file.header.file, { name: 'out.txt', mime: 'text/plain', size: data.length });
  assert.equal(fromUtf8(file.body), 'attachment bytes');

  await t.bridge.deliver(conv, { kind: 'chat', content: '', files: [{ filename: 'big.bin', data: new Uint8Array(MAX_FILE_BYTES + 1) }] });
  const note = await t.phone.nextOf('message');
  assert.match((note.header.message as { text: string }).text, /larger than 16 MiB/);
  t.bridge.stop();
});

test('typing sends activity only while a reply is pending', async () => {
  const t = await paired();
  await t.bridge.typing('wizzle:agent:g2');
  t.phone.send({ t: 'send', conv: 'wizzle:agent:g2', msgId: 'm1', text: 'go' });
  await until(() => t.inbound.length === 1);
  await t.bridge.typing('wizzle:agent:g2');
  await t.bridge.typing('wizzle:agent:g2');
  await t.bridge.typing('wizzle:agent:g2', 'Reading docs', 'agent');
  const first = await t.phone.nextOf('activity');
  assert.deepEqual(first.header.activity, { conv: 'wizzle:agent:g2', state: 'tool', tool: 'Bash' });
  const labeled = await t.phone.nextOf('activity');
  assert.deepEqual(labeled.header.activity, { conv: 'wizzle:agent:g2', state: 'tool', tool: 'Bash', label: 'Reading docs' });
  assert.equal(t.phone.received.length, 0);
  t.bridge.stop();
});

test('create_agent, unsupported requests, and unknown types', async () => {
  const t = await paired();
  t.phone.send({ t: 'create_agent', name: 'Writer' });
  const agent = await t.phone.nextOf('agent');
  assert.deepEqual(agent.header.agent, { id: 'g3', name: 'Writer', status: 'idle' });
  const agents = await t.phone.nextOf('agents');
  assert.equal((agents.header.agents as unknown[]).length, 4);
  await t.phone.nextOf('conversations');

  t.phone.send({ t: 'tasks' });
  const unsupported = await t.phone.nextOf('error');
  assert.equal(unsupported.header.code, 'unsupported');

  t.phone.send({ t: 'bogus' } as never);
  const unknown = await t.phone.nextOf('error');
  assert.equal(unknown.header.code, 'unknown');
  t.bridge.stop();
});

test('deliver announces a conversation wired after the last catalog', async () => {
  const t = await paired();
  t.phone.send({ t: 'sync' });
  await t.phone.nextOf('conversations');
  t.agents.push({ id: 'g3', name: 'Late', conv: 'wizzle:phone', status: 'idle' });

  await t.bridge.deliver('wizzle:phone', { kind: 'chat', content: 'hello from a new wiring' });
  const catalog = await t.phone.nextOf('conversations');
  const conversations = catalog.header.conversations as Array<{ id: string; agentId: string }>;
  assert.ok(conversations.some((c) => c.id === 'wizzle:phone' && c.agentId === 'g3'));
  const message = await t.phone.nextOf('message');
  assert.equal((message.header.message as { conv: string }).conv, 'wizzle:phone');
  await t.phone.nextOf('activity');

  await t.bridge.deliver('wizzle:phone', { kind: 'chat', content: 'second' });
  const next = await t.phone.next();
  assert.equal(next.header.t, 'message');
  t.bridge.stop();
});
