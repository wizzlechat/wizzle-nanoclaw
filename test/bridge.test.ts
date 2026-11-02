import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nodeCrypto } from '../../wizzle-protocol/src/crypto-node.ts';
import {
  MAX_FILE_BYTES,
  Session,
  deriveRelaySecret,
  fromUtf8,
  utf8,
  type WizzleMessage,
  type Secret,
  type SecretChanges,
  type SecretInput,
  type Task,
} from '../../wizzle-protocol/src/index.ts';
import {
  SYSTEM_CONV,
  WizzleBridge,
  type BridgeHost,
  type HostAgent,
  type HostConversation,
  type HostCreateAgent,
  type HostRoom,
  type HostRoomChanges,
  type InboundText,
} from '../src/bridge.ts';
import { FakeWizzle, FakeRelay, bridgeKeys, newPairing, silentLog, until } from './fake-relay.ts';

type Inbound = { conv: string; message: InboundText };

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

type Action = { questionId: string; value: string };

function fakeHost() {
  const requests: HostCreateAgent[] = [];
  const agents: HostAgent[] = [
    { id: 'g1', name: 'Andy', conv: 'wizzle:agent:g1', status: 'idle', model: 'opus' },
    { id: 'g2', name: 'Ops', conv: 'wizzle:agent:g2', status: 'running', lastAt: 1700000000000 },
  ];
  const activity = { running: true, tool: 'Bash' };
  const tasks: Task[] = [
    { id: 'briefing-1a2b', agentId: 'g1', name: 'briefing-1a2b', schedule: '0 9 * * 1-5', enabled: true, prompt: 'Morning briefing', runs: 3, failedRuns: 0 },
  ];
  const ran: string[] = [];
  const task = (taskId: string): Task => {
    const found = tasks.find((one) => one.id === taskId);
    if (!found) throw coded('unknown_task', `No task called "${taskId}"`);
    return found;
  };
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
    createAgent: async (request) => {
      requests.push(request);
      if (agents.some((a) => a.name.toLowerCase() === request.name.toLowerCase())) {
        throw coded('name_taken', `An agent is already called "${request.name}"`);
      }
      if (request.template !== undefined && request.template !== 'sales/sdr') {
        throw coded('unknown_template', `No template called "${request.template}"`);
      }
      const created: HostAgent = {
        id: `g${agents.length + 1}`,
        name: request.name,
        conv: `wizzle:agent:g${agents.length + 1}`,
        status: 'idle',
      };
      agents.push(created);
      return created;
    },
    listTemplates: async () => [
      { ref: 'sales/sdr', name: 'sdr', agentName: 'SDR', description: 'Outbound', version: '1.0.0', tasks: 2, mcpServers: 1, skills: 3 },
    ],
    listTasks: async () => tasks.map((one) => ({ ...one })),
    runTask: async (taskId) => void ran.push(task(taskId).id),
    pauseTask: async (taskId) => void (task(taskId).enabled = false),
    resumeTask: async (taskId) => void (task(taskId).enabled = true),
  };
  return { host, agents, requests, ran };
}

async function paired(built: { host: BridgeHost; agents: HostAgent[] } = fakeHost()) {
  const relay = new FakeRelay();
  const pairing = newPairing();
  const { host, agents } = built;
  const bridge = new WizzleBridge({ host, log: silentLog });
  const session = new Session(nodeCrypto, 'bridge', pairing.pairingId, bridgeKeys(pairing));
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
  const wizzle = new FakeWizzle(relay, pairing);
  await wizzle.connect();
  await wizzle.handshake();
  await until(() => session.ready && bridge.peerOnline);
  return { relay, pairing, bridge, wizzle, inbound, actions, agents, session };
}

test('sync answers with hello, agents, conversations, and the activity of a pending reply', async () => {
  const t = await paired();
  t.wizzle.send({ t: 'send', conv: 'wizzle:agent:g2', msgId: 'm1', text: 'status?' });
  await until(() => t.inbound.length === 1);
  t.wizzle.send({ t: 'sync' });
  const hello = await t.wizzle.nextOf('hello');
  assert.equal(hello.header.runtime, 'test');
  assert.equal(hello.header.host, 'box');
  const caps = hello.header.capabilities as Record<string, boolean>;
  assert.equal(caps.createAgent, true);
  assert.equal(caps.streaming, false);
  assert.equal(caps.topics, false);
  assert.equal(caps.clearSession, false);
  const agents = await t.wizzle.nextOf('agents');
  const list = agents.header.agents as Array<{ id: string; model?: string }>;
  assert.deepEqual(list.map((a) => a.id), ['g1', 'g2', 'system']);
  assert.equal(list[0]?.model, 'opus');
  const conversations = await t.wizzle.nextOf('conversations');
  const convs = conversations.header.conversations as Array<{ id: string; lastAt?: number }>;
  assert.deepEqual(convs.map((c) => c.id), ['wizzle:agent:g1', 'wizzle:agent:g2', SYSTEM_CONV]);
  assert.equal(convs[1]?.lastAt, 1700000000000);
  const activity = await t.wizzle.nextOf('activity');
  assert.deepEqual(activity.header.activity, { conv: 'wizzle:agent:g2', state: 'tool', tool: 'Bash' });
  t.bridge.stop();
});

test('the catalog carries the newest agent message of each conversation\'s history page', async () => {
  const built = fakeHost();
  built.host.history = async (conv, limit) => {
    assert.equal(limit, 50);
    if (conv === 'wizzle:agent:g2') throw new Error('mailbox gone');
    return {
      messages: [
        { conv, msgId: 'a1', role: 'agent', text: 'first', format: 'markdown', at: 2000 },
        { conv, msgId: 'u1', role: 'user', text: 'later', format: 'text', at: 3000 },
        { conv, msgId: 'a0', role: 'agent', text: 'older', format: 'markdown', at: 1000 },
      ],
      hasMore: false,
    };
  };
  const t = await paired(built);
  t.wizzle.send({ t: 'sync' });
  const conversations = await t.wizzle.nextOf('conversations');
  const convs = conversations.header.conversations as Array<{ id: string; lastAgentAt?: number }>;
  assert.deepEqual(convs.map((c) => [c.id, c.lastAgentAt]), [
    ['wizzle:agent:g1', 2000],
    ['wizzle:agent:g2', undefined],
    [SYSTEM_CONV, undefined],
  ]);
  t.bridge.stop();
});

test('send reaches the runtime and bad targets are rejected', async () => {
  const t = await paired();
  t.wizzle.send({ t: 'send', conv: 'wizzle:agent:g1', msgId: 'm1', text: 'hi there' });
  await until(() => t.inbound.length === 1);
  assert.equal(t.inbound[0]?.conv, 'wizzle:agent:g1');
  assert.equal(t.inbound[0]?.message.text, 'hi there');
  assert.match(t.inbound[0]?.message.id ?? '', /^wizzle-/);

  t.wizzle.send({ t: 'send', conv: 'wizzle:agent:nope', msgId: 'm2', text: 'x', id: 'req2' });
  const unknown = await t.wizzle.nextOf('error');
  assert.equal(unknown.header.code, 'unknown_conv');
  assert.equal(unknown.header.ref, 'req2');

  t.wizzle.send({ t: 'send', conv: SYSTEM_CONV, msgId: 'm3', text: 'x' });
  const readOnly = await t.wizzle.nextOf('error');
  assert.equal(readOnly.header.code, 'read_only');

  t.wizzle.send({ t: 'send', conv: 'wizzle:agent:g1', msgId: 'm4', text: '   ' });
  const empty = await t.wizzle.nextOf('error');
  assert.equal(empty.header.code, 'empty');
  assert.equal(t.inbound.length, 1);
  t.bridge.stop();
});

test('uploads attach to the next send as base64', async () => {
  const t = await paired();
  const bytes = utf8('file body');
  t.wizzle.send({ t: 'upload', uploadId: 'u1', file: { name: '../evil/notes.txt', mime: 'text/plain', size: bytes.length } }, bytes);
  t.wizzle.send({ t: 'send', conv: 'wizzle:agent:g1', msgId: 'm1', text: 'see file', attachments: ['u1'] });
  await until(() => t.inbound.length === 1);
  const att = t.inbound[0]?.message.attachments?.[0];
  assert.ok(att);
  assert.equal(att.name, '.._evil_notes.txt');
  assert.equal(att.mimeType, 'text/plain');
  assert.equal(att.size, bytes.length);
  assert.equal(Buffer.from(att.data, 'base64').toString(), 'file body');

  t.wizzle.send({ t: 'send', conv: 'wizzle:agent:g1', msgId: 'm2', text: 'again', attachments: ['u1'] });
  const missing = await t.wizzle.nextOf('error');
  assert.equal(missing.header.code, 'missing_upload');

  t.wizzle.send({ t: 'upload', uploadId: 'u2', file: { name: 'empty', mime: 'text/plain', size: 0 } }, new Uint8Array(0));
  const tooSmall = await t.wizzle.nextOf('error');
  assert.equal(tooSmall.header.code, 'too_large');
  t.bridge.stop();
});

test('answers and approvals route to onAction, and an answer closes its question', async () => {
  const t = await paired();
  t.wizzle.send({ t: 'answer', questionId: 'q1', value: 'a' });
  t.wizzle.send({ t: 'resolve', approvalId: 'ap1', decision: 'allow' });
  await until(() => t.actions.length === 2);
  assert.deepEqual(t.actions, [
    { questionId: 'q1', value: 'a' },
    { questionId: 'ap1', value: 'allow' },
  ]);
  const resolved = await t.wizzle.nextOf('question_resolved');
  assert.equal(resolved.header.questionId, 'q1');
  assert.equal(resolved.header.value, 'a');
  t.bridge.stop();
});

test('history comes from the host with a clamped limit', async () => {
  const t = await paired();
  t.wizzle.send({ t: 'history', conv: 'wizzle:agent:g1', limit: 9999 });
  const history = await t.wizzle.nextOf('history');
  const messages = history.header.messages as Array<{ text: string }>;
  assert.equal(messages[0]?.text, 'limit 200');
  assert.equal(history.header.hasMore, true);
  t.wizzle.send({ t: 'history', conv: SYSTEM_CONV });
  const system = await t.wizzle.nextOf('history');
  assert.deepEqual(system.header.messages, []);
  t.bridge.stop();
});

test('deliver maps runtime output to packets', async () => {
  const t = await paired();
  const conv = 'wizzle:agent:g1';
  t.wizzle.send({ t: 'send', conv, msgId: 'm1', text: 'go' });
  await until(() => t.inbound.length === 1);

  const textId = await t.bridge.deliver(conv, { kind: 'chat', content: { text: 'reply **bold**' } });
  const message = await t.wizzle.nextOf('message');
  const body = message.header.message as { msgId: string; role: string; text: string; format: string };
  assert.equal(body.msgId, textId);
  assert.equal(body.role, 'agent');
  assert.equal(body.text, 'reply **bold**');
  assert.equal(body.format, 'markdown');
  const idle = await t.wizzle.nextOf('activity');
  assert.deepEqual(idle.header.activity, { conv, state: 'idle' });

  const questionId = await t.bridge.deliver(SYSTEM_CONV, {
    kind: 'chat',
    content: { type: 'ask_question', questionId: 'q1', title: 'ignored', question: 'ignored', options: [] },
  });
  assert.equal(questionId, 'q1');
  const question = await t.wizzle.nextOf('question');
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
  const edit = await t.wizzle.nextOf('edit');
  assert.equal(edit.header.conv, SYSTEM_CONV);
  assert.equal(edit.header.text, 'Chose A');
  assert.deepEqual(edit.header.terminal, { resolution: 'A' });
  const resolved = await t.wizzle.nextOf('question_resolved');
  assert.equal(resolved.header.questionId, 'q1');

  await t.bridge.deliver(conv, { kind: 'chat', content: { operation: 'reaction', messageId: 'abc', emoji: '👍' } });
  const reaction = await t.wizzle.nextOf('reaction');
  assert.equal(reaction.header.msgId, 'abc');

  await t.bridge.deliver(conv, { kind: 'chat', content: { card: { kind: 'x' }, fallbackText: 'plain' } });
  const card = await t.wizzle.nextOf('card');
  assert.equal(card.header.fallbackText, 'plain');

  const data = utf8('attachment bytes');
  await t.bridge.deliver(conv, { kind: 'chat', content: 'here you go', files: [{ filename: 'out.txt', data }] });
  await t.wizzle.nextOf('message');
  const file = await t.wizzle.nextOf('file');
  assert.deepEqual(file.header.file, { name: 'out.txt', mime: 'text/plain', size: data.length });
  assert.equal(fromUtf8(file.body), 'attachment bytes');

  await t.bridge.deliver(conv, { kind: 'chat', content: '', files: [{ filename: 'big.bin', data: new Uint8Array(MAX_FILE_BYTES + 1) }] });
  const note = await t.wizzle.nextOf('message');
  assert.match((note.header.message as { text: string }).text, /larger than 16 MiB/);
  t.bridge.stop();
});

test('live msgIds come from the runtime id, files get a suffix, and a missing id falls back to a UUID', async () => {
  const t = await paired();
  const conv = 'wizzle:agent:g1';
  const textId = await t.bridge.deliver(conv, { kind: 'chat', content: { text: 'one' }, id: 'row-1' });
  assert.equal(textId, 'row-1');
  const message = await t.wizzle.nextOf('message');
  assert.equal((message.header.message as { msgId: string }).msgId, 'row-1');

  await t.bridge.deliver(conv, { kind: 'chat', content: { card: { kind: 'x' }, fallbackText: 'plain' }, id: 'row-2' });
  const card = await t.wizzle.nextOf('card');
  assert.equal(card.header.msgId, 'row-2');

  const data = utf8('bytes');
  const firstId = await t.bridge.deliver(conv, {
    kind: 'chat',
    content: 'two files',
    id: 'row-3',
    files: [
      { filename: 'a.txt', data },
      { filename: 'b.txt', data },
    ],
  });
  assert.equal(firstId, 'row-3');
  assert.equal(((await t.wizzle.nextOf('message')).header.message as { msgId: string }).msgId, 'row-3');
  assert.equal((await t.wizzle.nextOf('file')).header.msgId, 'row-3:f0');
  assert.equal((await t.wizzle.nextOf('file')).header.msgId, 'row-3:f1');

  const onlyFiles = await t.bridge.deliver(conv, { kind: 'chat', content: '', id: 'row-4', files: [{ filename: 'c.txt', data }] });
  assert.equal(onlyFiles, 'row-4:f0');
  await t.wizzle.nextOf('file');

  const random = await t.bridge.deliver(conv, { kind: 'chat', content: 'no id' });
  assert.match(random ?? '', /^[0-9a-f-]{36}$/);
  t.bridge.stop();
});

test('send msgId is validated and reaches the runtime', async () => {
  const t = await paired();
  const conv = 'wizzle:agent:g1';
  t.wizzle.send({ t: 'send', conv, msgId: 'bad id!', text: 'x', id: 'v1' });
  const bad = await t.wizzle.nextOf('error');
  assert.equal(bad.header.code, 'bad_request');
  assert.equal(bad.header.ref, 'v1');
  t.wizzle.send({ t: 'send', conv, msgId: 'a'.repeat(65), text: 'x', id: 'v2' });
  const long = await t.wizzle.nextOf('error');
  assert.equal(long.header.code, 'bad_request');
  assert.equal(long.header.ref, 'v2');
  t.wizzle.send({ t: 'send', conv, msgId: '', text: 'x', id: 'v3' });
  const empty = await t.wizzle.nextOf('error');
  assert.equal(empty.header.code, 'bad_request');
  assert.equal(t.inbound.length, 0);

  t.wizzle.send({ t: 'send', conv, msgId: 'Wizzle_01-x', text: 'ok' });
  await until(() => t.inbound.length === 1);
  assert.equal(t.inbound[0]?.message.msgId, 'Wizzle_01-x');
  t.bridge.stop();
});

test('deliver and notify ask the relay to wake wizzle only while it is away', async () => {
  const t = await paired();
  const conv = 'wizzle:agent:g1';
  await t.bridge.deliver(conv, { kind: 'chat', content: 'seen live' });
  t.bridge.notify(conv, 'also live');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(t.relay.wakes, 0);

  t.wizzle.disconnect();
  await until(() => !t.bridge.peerOnline);
  await t.bridge.deliver(conv, { kind: 'chat', content: 'text' });
  await until(() => t.relay.wakes === 1);
  await t.bridge.deliver(conv, { kind: 'chat', content: { operation: 'edit', messageId: 'm', text: 'edited' } });
  await t.bridge.deliver(conv, { kind: 'chat', content: { operation: 'reaction', messageId: 'm', emoji: '👍' } });
  await t.bridge.typing(conv);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(t.relay.wakes, 1);
  await t.bridge.deliver(conv, { kind: 'chat', content: { card: { kind: 'x' }, fallbackText: 'plain' } });
  await until(() => t.relay.wakes === 2);
  await t.bridge.deliver(conv, { kind: 'chat', content: '', files: [{ filename: 'a.txt', data: utf8('a') }] });
  await until(() => t.relay.wakes === 3);
  await t.bridge.deliver(SYSTEM_CONV, { kind: 'chat', content: { type: 'ask_question', questionId: 'q1', options: [] } });
  await until(() => t.relay.wakes === 4);
  await t.bridge.deliver(conv, { kind: 'chat', content: 'text and file', files: [{ filename: 'b.txt', data: utf8('b') }] });
  await until(() => t.relay.wakes === 5);
  t.bridge.notify(conv, 'host line');
  await until(() => t.relay.wakes === 6);
  await t.bridge.deliver(conv, {
    kind: 'chat',
    content: { operation: 'edit', messageId: 'q1', terminalCard: { resolution: 'A' } },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(t.relay.wakes, 6);

  const again = new FakeWizzle(t.relay, t.pairing, t.wizzle.session.exportState());
  await again.connect();
  await until(() => t.bridge.peerOnline);
  await t.bridge.deliver(conv, { kind: 'chat', content: 'back' });
  await until(() => again.received.some((p) => p.header.t === 'message' && (p.header.message as { text: string }).text === 'back'));
  assert.equal(t.relay.wakes, 6);
  t.bridge.stop();
  again.disconnect();
});

test('typing sends activity only while a reply is pending', async () => {
  const t = await paired();
  await t.bridge.typing('wizzle:agent:g2');
  t.wizzle.send({ t: 'send', conv: 'wizzle:agent:g2', msgId: 'm1', text: 'go' });
  await until(() => t.inbound.length === 1);
  await t.bridge.typing('wizzle:agent:g2');
  await t.bridge.typing('wizzle:agent:g2');
  await t.bridge.typing('wizzle:agent:g2', 'Reading docs', 'agent');
  const first = await t.wizzle.nextOf('activity');
  assert.deepEqual(first.header.activity, { conv: 'wizzle:agent:g2', state: 'tool', tool: 'Bash' });
  const labeled = await t.wizzle.nextOf('activity');
  assert.deepEqual(labeled.header.activity, { conv: 'wizzle:agent:g2', state: 'tool', tool: 'Bash', label: 'Reading docs' });
  assert.equal(t.wizzle.received.length, 0);
  t.bridge.stop();
});

test('create_agent, unsupported requests, and unknown types', async () => {
  const built = fakeHost();
  const t = await paired(built);
  t.wizzle.send({ t: 'create_agent', name: '  Writer  ', purpose: 'Draft the weekly note.', template: 'sales/sdr', timezone: 'Europe/Lisbon' });
  const agent = await t.wizzle.nextOf('agent');
  assert.deepEqual(agent.header.agent, { id: 'g3', name: 'Writer', status: 'idle' });
  const agents = await t.wizzle.nextOf('agents');
  assert.equal((agents.header.agents as unknown[]).length, 4);
  await t.wizzle.nextOf('conversations');
  assert.deepEqual(built.requests[0], {
    name: 'Writer',
    purpose: 'Draft the weekly note.',
    template: 'sales/sdr',
    timezone: 'Europe/Lisbon',
  });

  t.wizzle.send({ t: 'abort', conv: 'wizzle:agent:g1' });
  const unsupported = await t.wizzle.nextOf('error');
  assert.equal(unsupported.header.code, 'unsupported');

  t.wizzle.send({ t: 'bogus' } as never);
  const unknown = await t.wizzle.nextOf('error');
  assert.equal(unknown.header.code, 'unknown');
  t.bridge.stop();
});

test('a host error code and the request ref reach wizzle unchanged', async () => {
  const built = fakeHost();
  const t = await paired(built);
  t.wizzle.send({ t: 'create_agent', name: 'andy', id: 'c1' });
  const taken = await t.wizzle.nextOf('error');
  assert.equal(taken.header.code, 'name_taken');
  assert.equal(taken.header.ref, 'c1');
  assert.match(String(taken.header.message), /already called/);

  t.wizzle.send({ t: 'create_agent', name: 'Scout', template: 'nope', id: 'c2' });
  const missing = await t.wizzle.nextOf('error');
  assert.equal(missing.header.code, 'unknown_template');
  assert.equal(missing.header.ref, 'c2');
  assert.equal(built.requests.length, 2);
  t.bridge.stop();
});

test('create_agent rejects a blank name, a purpose over the cap, and both start points at once', async () => {
  const built = fakeHost();
  const t = await paired(built);
  t.wizzle.send({ t: 'create_agent', name: '   ', id: 'b1' });
  const blank = await t.wizzle.nextOf('error');
  assert.equal(blank.header.code, 'bad_request');
  assert.equal(blank.header.ref, 'b1');

  t.wizzle.send({ t: 'create_agent', name: 'Scout', purpose: 'x'.repeat(4001), id: 'b2' });
  const long = await t.wizzle.nextOf('error');
  assert.equal(long.header.code, 'too_long');

  t.wizzle.send({ t: 'create_agent', name: 'Scout', template: 'sales/sdr', copyFrom: 'g1', id: 'b3' });
  const both = await t.wizzle.nextOf('error');
  assert.equal(both.header.code, 'bad_request');
  assert.equal(built.requests.length, 0);
  t.bridge.stop();
});

test('an older wizzle sending only description still gets a purpose', async () => {
  const built = fakeHost();
  const t = await paired(built);
  t.wizzle.send({ t: 'create_agent', name: 'Scout', description: 'Watch the build.' });
  await t.wizzle.nextOf('agent');
  assert.deepEqual(built.requests[0], { name: 'Scout', purpose: 'Watch the build.' });
  t.bridge.stop();
});

test('tasks are listed, each change answers with the list, and a host without the methods refuses', async () => {
  const built = fakeHost();
  const t = await paired(built);
  t.wizzle.send({ t: 'sync' });
  const hello = await t.wizzle.nextOf('hello');
  assert.equal((hello.header.capabilities as Record<string, boolean>).tasks, true);
  t.wizzle.send({ t: 'tasks', id: 'k1' });
  const listed = await t.wizzle.nextOf('tasks');
  assert.equal(listed.header.ref, 'k1');
  assert.deepEqual(listed.header.tasks, [
    { id: 'briefing-1a2b', agentId: 'g1', name: 'briefing-1a2b', schedule: '0 9 * * 1-5', enabled: true, prompt: 'Morning briefing', runs: 3, failedRuns: 0 },
  ]);
  t.wizzle.send({ t: 'pause_task', taskId: 'briefing-1a2b', id: 'k2' });
  const paused = await t.wizzle.nextOf('tasks');
  assert.equal(paused.header.ref, 'k2');
  assert.equal((paused.header.tasks as Task[])[0]?.enabled, false);
  t.wizzle.send({ t: 'resume_task', taskId: 'briefing-1a2b', id: 'k3' });
  const resumed = await t.wizzle.nextOf('tasks');
  assert.equal(resumed.header.ref, 'k3');
  assert.equal((resumed.header.tasks as Task[])[0]?.enabled, true);
  t.wizzle.send({ t: 'run_task', taskId: 'briefing-1a2b', id: 'k4' });
  const ran = await t.wizzle.nextOf('tasks');
  assert.equal(ran.header.ref, 'k4');
  assert.deepEqual(built.ran, ['briefing-1a2b']);
  t.wizzle.send({ t: 'run_task', taskId: 'gone-0000', id: 'k5' });
  const missing = await t.wizzle.nextOf('error');
  assert.equal(missing.header.code, 'unknown_task');
  assert.equal(missing.header.ref, 'k5');
  t.wizzle.send({ t: 'pause_task', id: 'k6' } as never);
  const bare = await t.wizzle.nextOf('error');
  assert.equal(bare.header.code, 'bad_request');
  t.bridge.stop();

  const without = fakeHost();
  delete without.host.runTask;
  const plain = await paired(without);
  plain.wizzle.send({ t: 'sync' });
  const plainHello = await plain.wizzle.nextOf('hello');
  assert.equal((plainHello.header.capabilities as Record<string, boolean>).tasks, false);
  plain.wizzle.send({ t: 'tasks', id: 'k7' });
  const refused = await plain.wizzle.nextOf('error');
  assert.equal(refused.header.code, 'unsupported');
  assert.equal(refused.header.ref, 'k7');
  plain.bridge.stop();
});

test('templates are listed when the host has the method and refused when it has not', async () => {
  const t = await paired();
  t.wizzle.send({ t: 'sync' });
  const hello = await t.wizzle.nextOf('hello');
  assert.equal((hello.header.capabilities as Record<string, boolean>).templates, true);
  t.wizzle.send({ t: 'templates' });
  const listed = await t.wizzle.nextOf('templates');
  assert.deepEqual(listed.header.templates, [
    { ref: 'sales/sdr', name: 'sdr', agentName: 'SDR', description: 'Outbound', version: '1.0.0', tasks: 2, mcpServers: 1, skills: 3 },
  ]);
  t.bridge.stop();

  const bare = fakeHost();
  delete bare.host.createAgent;
  delete bare.host.listTemplates;
  const plain = await paired(bare);
  plain.wizzle.send({ t: 'sync' });
  const plainHello = await plain.wizzle.nextOf('hello');
  const caps = plainHello.header.capabilities as Record<string, boolean>;
  assert.equal(caps.templates, false);
  assert.equal(caps.createAgent, false);
  plain.wizzle.send({ t: 'templates', id: 't1' });
  const noTemplates = await plain.wizzle.nextOf('error');
  assert.equal(noTemplates.header.code, 'unsupported');
  assert.equal(noTemplates.header.ref, 't1');
  plain.wizzle.send({ t: 'create_agent', name: 'Scout', id: 't2' });
  const noCreate = await plain.wizzle.nextOf('error');
  assert.equal(noCreate.header.code, 'unsupported');
  plain.bridge.stop();
});

test('notify reaches wizzle as a system message', async () => {
  const t = await paired();
  t.bridge.notify('wizzle:agent:g1', 'Setting up. Andy is reading your purpose.');
  const message = await t.wizzle.nextOf('message');
  const body = message.header.message as { conv: string; role: string; text: string; format: string };
  assert.equal(body.conv, 'wizzle:agent:g1');
  assert.equal(body.role, 'system');
  assert.equal(body.format, 'text');
  assert.equal(body.text, 'Setting up. Andy is reading your purpose.');
  t.bridge.stop();
});

test('deliver announces a conversation wired after the last catalog', async () => {
  const t = await paired();
  t.wizzle.send({ t: 'sync' });
  await t.wizzle.nextOf('conversations');
  t.agents.push({ id: 'g3', name: 'Late', conv: 'wizzle:wizzle', status: 'idle' });

  await t.bridge.deliver('wizzle:wizzle', { kind: 'chat', content: 'hello from a new wiring' });
  const catalog = await t.wizzle.nextOf('conversations');
  const conversations = catalog.header.conversations as Array<{ id: string; agentId: string }>;
  assert.ok(conversations.some((c) => c.id === 'wizzle:wizzle' && c.agentId === 'g3'));
  const message = await t.wizzle.nextOf('message');
  assert.equal((message.header.message as { conv: string }).conv, 'wizzle:wizzle');
  await t.wizzle.nextOf('activity');

  await t.bridge.deliver('wizzle:wizzle', { kind: 'chat', content: 'second' });
  const next = await t.wizzle.next();
  assert.equal(next.header.t, 'message');
  t.bridge.stop();
});

function topicHost() {
  const base = fakeHost();
  const convs: HostConversation[] = [
    { conv: 'wizzle:agent:g1', agentId: 'g1', title: 'Andy', topic: false },
    { conv: 'wizzle:agent:g2', agentId: 'g2', title: 'Ops', topic: false, lastAt: 1700000000000 },
  ];
  const find = (conv: string) => convs.find((c) => c.conv === conv);
  const cleared: string[] = [];
  const host: BridgeHost = {
    ...base.host,
    listConversations: async () => convs.map((c) => ({ ...c })),
    createConversation: async (agentId, title) => {
      if (!base.agents.some((a) => a.id === agentId)) throw coded('unknown_agent', 'No such agent');
      if (convs.some((c) => c.agentId === agentId && c.title === title)) throw coded('name_taken', 'That name is taken');
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (slug.length === 0) throw coded('bad_request', 'That title has no usable characters');
      const created: HostConversation = { conv: `wizzle:agent:${agentId}:${slug}`, agentId, title, topic: true, createdAt: 1700000001000 };
      convs.push(created);
      return created;
    },
    renameConversation: async (conv, title) => {
      const found = find(conv);
      if (!found) throw coded('unknown_conv', 'No such conversation');
      if (!found.topic) throw coded('read_only', 'The default conversation cannot be renamed');
      found.title = title;
      return { ...found };
    },
    deleteConversation: async (conv) => {
      const found = find(conv);
      if (!found) throw coded('unknown_conv', 'No such conversation');
      if (!found.topic) throw coded('read_only', 'The default conversation cannot be deleted');
      convs.splice(convs.indexOf(found), 1);
      return { questionIds: ['q1'] };
    },
    clearConversation: async (conv) => {
      const found = find(conv);
      if (!found) throw coded('unknown_conv', 'No such conversation');
      if (found.agentId === 'g2') throw coded('has_tasks', 'This chat holds 1 scheduled task');
      cleared.push(conv);
      return { questionIds: ['q2'] };
    },
  };
  return { host, agents: base.agents, convs, cleared };
}

test('topics are unsupported when the host has no conversation methods', async () => {
  const t = await paired();
  t.wizzle.send({ t: 'create_conversation', agentId: 'g1', title: 'Roadmap', id: 'r1' });
  const create = await t.wizzle.nextOf('error');
  assert.equal(create.header.code, 'unsupported');
  assert.equal(create.header.ref, 'r1');
  t.wizzle.send({ t: 'rename_conversation', conv: 'wizzle:agent:g1', title: 'Plans' });
  assert.equal((await t.wizzle.nextOf('error')).header.code, 'unsupported');
  t.wizzle.send({ t: 'delete_conversation', conv: 'wizzle:agent:g1' });
  assert.equal((await t.wizzle.nextOf('error')).header.code, 'unsupported');
  t.wizzle.send({ t: 'clear', conv: 'wizzle:agent:g1' });
  assert.equal((await t.wizzle.nextOf('error')).header.code, 'unsupported');
  t.bridge.stop();
});

test('a topic host lists two conversations for one agent and accepts a send to the topic', async () => {
  const t = await paired(topicHost());
  t.wizzle.send({ t: 'sync' });
  const hello = await t.wizzle.nextOf('hello');
  assert.equal((hello.header.capabilities as Record<string, boolean>).topics, true);
  const first = await t.wizzle.nextOf('conversations');
  assert.deepEqual((first.header.conversations as Array<{ id: string }>).map((c) => c.id), [
    'wizzle:agent:g1',
    'wizzle:agent:g2',
    SYSTEM_CONV,
  ]);

  t.wizzle.send({ t: 'create_conversation', agentId: 'g1', title: 'Roadmap' });
  const created = await t.wizzle.nextOf('conversation');
  assert.deepEqual(created.header.conversation, {
    id: 'wizzle:agent:g1:roadmap',
    agentId: 'g1',
    title: 'Roadmap',
    topic: true,
    createdAt: 1700000001000,
  });
  const catalog = await t.wizzle.nextOf('conversations');
  const rows = catalog.header.conversations as Array<{ id: string; agentId: string; topic?: boolean }>;
  assert.deepEqual(rows.filter((c) => c.agentId === 'g1').map((c) => c.id), ['wizzle:agent:g1', 'wizzle:agent:g1:roadmap']);
  assert.equal(rows.find((c) => c.id === 'wizzle:agent:g1')?.topic, undefined);

  t.wizzle.send({ t: 'send', conv: 'wizzle:agent:g1:roadmap', msgId: 'm1', text: 'plan it' });
  await until(() => t.inbound.length === 1);
  assert.equal(t.inbound[0]?.conv, 'wizzle:agent:g1:roadmap');
  t.bridge.stop();
});

test('rename keeps the conversation id and delete clears the topic and its questions', async () => {
  const built = topicHost();
  const t = await paired(built);
  t.wizzle.send({ t: 'create_conversation', agentId: 'g1', title: 'Roadmap' });
  await t.wizzle.nextOf('conversations');

  t.wizzle.send({ t: 'rename_conversation', conv: 'wizzle:agent:g1:roadmap', title: 'Plans' });
  const renamed = await t.wizzle.nextOf('conversation');
  assert.deepEqual(renamed.header.conversation, {
    id: 'wizzle:agent:g1:roadmap',
    agentId: 'g1',
    title: 'Plans',
    topic: true,
    createdAt: 1700000001000,
  });
  const afterRename = await t.wizzle.nextOf('conversations');
  assert.ok((afterRename.header.conversations as Array<{ id: string; title: string }>).some((c) => c.id === 'wizzle:agent:g1:roadmap' && c.title === 'Plans'));

  t.wizzle.send({ t: 'delete_conversation', conv: 'wizzle:agent:g1:roadmap' });
  const resolved = await t.wizzle.nextOf('question_resolved');
  assert.equal(resolved.header.questionId, 'q1');
  const gone = await t.wizzle.nextOf('conversation_deleted');
  assert.equal(gone.header.conv, 'wizzle:agent:g1:roadmap');
  const afterDelete = await t.wizzle.nextOf('conversations');
  assert.ok(!(afterDelete.header.conversations as Array<{ id: string }>).some((c) => c.id === 'wizzle:agent:g1:roadmap'));
  assert.equal(built.convs.length, 2);
  t.bridge.stop();
});

test('topic requests are validated and host codes pass through with the ref', async () => {
  const t = await paired(topicHost());
  t.wizzle.send({ t: 'create_conversation', agentId: 'g1', title: '   ', id: 'r1' });
  const blank = await t.wizzle.nextOf('error');
  assert.equal(blank.header.code, 'bad_request');
  assert.equal(blank.header.ref, 'r1');

  t.wizzle.send({ t: 'create_conversation', agentId: 'g1', title: 'x'.repeat(61) });
  assert.equal((await t.wizzle.nextOf('error')).header.code, 'bad_request');

  t.wizzle.send({ t: 'create_conversation', agentId: 'g1', title: '???' });
  assert.equal((await t.wizzle.nextOf('error')).header.code, 'bad_request');

  t.wizzle.send({ t: 'create_conversation', agentId: 'nope', title: 'Roadmap', id: 'r2' });
  const unknownAgent = await t.wizzle.nextOf('error');
  assert.equal(unknownAgent.header.code, 'unknown_agent');
  assert.equal(unknownAgent.header.ref, 'r2');

  t.wizzle.send({ t: 'create_conversation', agentId: 'g1', title: 'Roadmap' });
  await t.wizzle.nextOf('conversations');
  t.wizzle.send({ t: 'create_conversation', agentId: 'g1', title: 'Roadmap' });
  assert.equal((await t.wizzle.nextOf('error')).header.code, 'name_taken');
  t.wizzle.send({ t: 'create_conversation', agentId: 'g2', title: 'Roadmap' });
  await t.wizzle.nextOf('conversation');
  await t.wizzle.nextOf('conversations');

  t.wizzle.send({ t: 'rename_conversation', conv: 'wizzle:agent:g1', title: 'Nope' });
  assert.equal((await t.wizzle.nextOf('error')).header.code, 'read_only');
  t.wizzle.send({ t: 'delete_conversation', conv: SYSTEM_CONV });
  assert.equal((await t.wizzle.nextOf('error')).header.code, 'read_only');
  t.wizzle.send({ t: 'delete_conversation', conv: 'wizzle:agent:g1:missing' });
  assert.equal((await t.wizzle.nextOf('error')).header.code, 'unknown_conv');
  t.bridge.stop();
});

test('clear keeps the conversation, closes its questions and passes host codes through', async () => {
  const built = topicHost();
  const t = await paired(built);
  t.wizzle.send({ t: 'sync' });
  const hello = await t.wizzle.nextOf('hello');
  assert.equal((hello.header.capabilities as Record<string, boolean>).clearSession, true);
  await t.wizzle.nextOf('conversations');

  t.wizzle.send({ t: 'clear', conv: 'wizzle:agent:g1' });
  const resolved = await t.wizzle.nextOf('question_resolved');
  assert.equal(resolved.header.questionId, 'q2');
  const session = await t.wizzle.nextOf('session');
  assert.equal(session.header.conv, 'wizzle:agent:g1');
  assert.equal(session.header.event, 'cleared');
  const catalog = await t.wizzle.nextOf('conversations');
  assert.ok((catalog.header.conversations as Array<{ id: string }>).some((c) => c.id === 'wizzle:agent:g1'));
  assert.deepEqual(built.cleared, ['wizzle:agent:g1']);

  t.wizzle.send({ t: 'clear', conv: 'wizzle:agent:g2', id: 'c1' });
  const refused = await t.wizzle.nextOf('error');
  assert.equal(refused.header.code, 'has_tasks');
  assert.equal(refused.header.ref, 'c1');
  t.wizzle.send({ t: 'clear', conv: SYSTEM_CONV });
  assert.equal((await t.wizzle.nextOf('error')).header.code, 'read_only');
  t.wizzle.send({ t: 'clear', conv: 'wizzle:agent:g1:missing' });
  assert.equal((await t.wizzle.nextOf('error')).header.code, 'unknown_conv');
  t.bridge.stop();
});

test('deliver announces a topic created after the last catalog', async () => {
  const built = topicHost();
  const t = await paired(built);
  t.wizzle.send({ t: 'sync' });
  await t.wizzle.nextOf('conversations');
  built.convs.push({ conv: 'wizzle:agent:g1:notes', agentId: 'g1', title: 'Notes', topic: true });

  await t.bridge.deliver('wizzle:agent:g1:notes', { kind: 'chat', content: 'first word in a new topic' });
  const catalog = await t.wizzle.nextOf('conversations');
  assert.ok((catalog.header.conversations as Array<{ id: string }>).some((c) => c.id === 'wizzle:agent:g1:notes'));
  const message = await t.wizzle.nextOf('message');
  assert.equal((message.header.message as { conv: string }).conv, 'wizzle:agent:g1:notes');
  t.bridge.stop();
});

function lifecycleHost() {
  const base = topicHost();
  const calls: string[] = [];
  const agent = (id: string) => base.agents.find((a) => a.id === id);
  const host: BridgeHost = {
    ...base.host,
    pauseAgent: async (agentId) => {
      calls.push(`pause ${agentId}`);
      const found = agent(agentId);
      if (found) found.status = 'paused';
      return { questionIds: ['q1'] };
    },
    resumeAgent: async (agentId) => {
      calls.push(`resume ${agentId}`);
      const found = agent(agentId);
      if (found) found.status = 'idle';
    },
    restartAgent: async (agentId, message) => {
      calls.push(message === undefined ? `restart ${agentId}` : `restart ${agentId} ${message}`);
      if (agentId === 'g2') throw coded('restart_failed', 'the session runtime cannot restart');
    },
    deleteAgent: async (agentId, removeWorkspace) => {
      calls.push(`delete ${agentId} ${removeWorkspace}`);
      base.agents.splice(base.agents.findIndex((a) => a.id === agentId), 1);
      for (const c of base.convs.filter((one) => one.agentId === agentId)) base.convs.splice(base.convs.indexOf(c), 1);
      return {};
    },
  };
  return { host, agents: base.agents, convs: base.convs, calls };
}

test('lifecycle and delete are unsupported without the host methods', async () => {
  const t = await paired(topicHost());
  t.wizzle.send({ t: 'sync' });
  const hello = await t.wizzle.nextOf('hello');
  const capabilities = hello.header.capabilities as Record<string, boolean>;
  assert.equal(capabilities.lifecycle, false);
  assert.equal(capabilities.deleteAgent, false);
  const packets: WizzleMessage[] = [
    { t: 'pause_agent', agentId: 'g1' },
    { t: 'resume_agent', agentId: 'g1' },
    { t: 'restart_agent', agentId: 'g1' },
    { t: 'delete_agent', agentId: 'g1', removeWorkspace: true },
  ];
  for (const packet of packets) {
    t.wizzle.send({ ...packet, id: 'r1' });
    const refused = await t.wizzle.nextOf('error');
    assert.equal(refused.header.code, 'unsupported');
    assert.equal(refused.header.ref, 'r1');
  }
  t.bridge.stop();
});

test('pause closes open questions and broadcasts the paused agent, and a send to it is refused', async () => {
  const built = lifecycleHost();
  const t = await paired(built);
  t.wizzle.send({ t: 'sync' });
  const hello = await t.wizzle.nextOf('hello');
  assert.equal((hello.header.capabilities as Record<string, boolean>).lifecycle, true);
  assert.equal((hello.header.capabilities as Record<string, boolean>).deleteAgent, true);
  await t.wizzle.nextOf('conversations');

  t.wizzle.send({ t: 'pause_agent', agentId: 'g1' });
  assert.equal((await t.wizzle.nextOf('question_resolved')).header.questionId, 'q1');
  const paused = await t.wizzle.nextOf('agent');
  assert.deepEqual(paused.header.agent, { id: 'g1', name: 'Andy', status: 'paused', model: 'opus' });

  t.wizzle.send({ t: 'send', conv: 'wizzle:agent:g1', msgId: 'm1', text: 'hello', id: 's1' });
  const refused = await t.wizzle.nextOf('error');
  assert.equal(refused.header.code, 'paused');
  assert.equal(refused.header.ref, 's1');
  assert.equal(refused.header.message, 'Andy is paused. Resume it to send messages.');
  assert.equal(t.inbound.length, 0);

  t.wizzle.send({ t: 'restart_agent', agentId: 'g1', id: 'x1' });
  const early = await t.wizzle.nextOf('error');
  assert.equal(early.header.code, 'bad_request');
  assert.equal(early.header.message, 'Resume Andy before restarting it');

  t.wizzle.send({ t: 'resume_agent', agentId: 'g1' });
  assert.equal(((await t.wizzle.nextOf('agent')).header.agent as { status: string }).status, 'idle');
  t.wizzle.send({ t: 'send', conv: 'wizzle:agent:g1', msgId: 'm2', text: 'hello again' });
  await until(() => t.inbound.length === 1);
  assert.deepEqual(built.calls, ['pause g1', 'resume g1']);
  t.bridge.stop();
});

test('a send is refused when the host paused the agent after the last catalog', async () => {
  const built = lifecycleHost();
  const t = await paired(built);
  t.wizzle.send({ t: 'sync' });
  await t.wizzle.nextOf('conversations');
  const target = built.agents.find((a) => a.id === 'g1');
  if (target) target.status = 'paused';
  t.wizzle.send({ t: 'send', conv: 'wizzle:agent:g1', msgId: 'm1', text: 'hello' });
  assert.equal((await t.wizzle.nextOf('error')).header.code, 'paused');
  t.bridge.stop();
});

test('restart passes the message, broadcasts the agent, and host codes come back with the ref', async () => {
  const built = lifecycleHost();
  const t = await paired(built);
  t.wizzle.send({ t: 'restart_agent', agentId: 'g1', message: '  check the tool  ' });
  assert.equal(((await t.wizzle.nextOf('agent')).header.agent as { id: string }).id, 'g1');
  t.wizzle.send({ t: 'restart_agent', agentId: 'g2', id: 'r2' });
  const failed = await t.wizzle.nextOf('error');
  assert.equal(failed.header.code, 'restart_failed');
  assert.equal(failed.header.ref, 'r2');
  assert.deepEqual(built.calls, ['restart g1 check the tool', 'restart g2']);
  t.bridge.stop();
});

test('lifecycle packets are validated before the host is called', async () => {
  const built = lifecycleHost();
  const t = await paired(built);
  t.wizzle.send({ t: 'pause_agent', agentId: 'nope', id: 'u1' });
  const unknown = await t.wizzle.nextOf('error');
  assert.equal(unknown.header.code, 'unknown_agent');
  assert.equal(unknown.header.ref, 'u1');
  t.wizzle.send({ t: 'pause_agent' } as unknown as WizzleMessage);
  assert.equal((await t.wizzle.nextOf('error')).header.code, 'bad_request');
  t.wizzle.send({ t: 'delete_agent', agentId: 'system', removeWorkspace: true });
  assert.equal((await t.wizzle.nextOf('error')).header.code, 'bad_request');
  t.wizzle.send({ t: 'delete_agent', agentId: 'g1' } as unknown as WizzleMessage);
  assert.equal((await t.wizzle.nextOf('error')).header.code, 'bad_request');
  assert.deepEqual(built.calls, []);
  t.bridge.stop();
});

test('delete emits agent_deleted, then a catalog without the agent or its topics', async () => {
  const built = lifecycleHost();
  built.convs.push({ conv: 'wizzle:agent:g1:roadmap', agentId: 'g1', title: 'Roadmap', topic: true });
  const t = await paired(built);
  t.wizzle.send({ t: 'sync' });
  await t.wizzle.nextOf('conversations');

  t.wizzle.send({ t: 'delete_agent', agentId: 'g1', removeWorkspace: false });
  assert.equal((await t.wizzle.nextOf('agent_deleted')).header.agentId, 'g1');
  const agents = await t.wizzle.nextOf('agents');
  assert.deepEqual((agents.header.agents as Array<{ id: string }>).map((a) => a.id), ['g2', 'system']);
  const catalog = await t.wizzle.nextOf('conversations');
  assert.deepEqual((catalog.header.conversations as Array<{ id: string }>).map((c) => c.id), ['wizzle:agent:g2', SYSTEM_CONV]);
  assert.deepEqual(built.calls, ['delete g1 false']);

  t.wizzle.send({ t: 'send', conv: 'wizzle:agent:g1', msgId: 'm1', text: 'hello' });
  assert.equal((await t.wizzle.nextOf('error')).header.code, 'unknown_conv');
  t.bridge.stop();
});

function keyHost() {
  const built = fakeHost();
  const vault: Secret[] = [{ id: 's1', name: 'GitHub', type: 'generic', host: 'api.github.com', injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' } }];
  const grants = new Map<string, Set<string>>([['g1', new Set(['s1'])]]);
  const values = new Map<string, string>([['s1', 'ghp_old']]);
  Object.assign(built.host, {
    listSecrets: async () => vault.map((secret) => ({ ...secret })),
    createSecret: async (input: SecretInput) => {
      if (input.host.includes('://')) throw coded('bad_request', 'Enter a hostname, not a URL');
      const { value, ...shown } = input;
      const secret: Secret = { id: `s${vault.length + 1}`, ...shown };
      vault.push(secret);
      values.set(secret.id, value);
      return secret;
    },
    updateSecret: async (secretId: string, changes: SecretChanges) => {
      const secret = vault.find((one) => one.id === secretId);
      if (!secret) throw coded('unknown_secret', 'No such key');
      if (changes.value !== undefined) values.set(secretId, changes.value);
      if (changes.name !== undefined) secret.name = changes.name;
      if (changes.path === null) delete secret.path;
      return { ...secret };
    },
    deleteSecret: async (secretId: string) => {
      const at = vault.findIndex((one) => one.id === secretId);
      if (at === -1) throw coded('unknown_secret', 'No such key');
      vault.splice(at, 1);
    },
    listAgentSecrets: async (agentId: string) => [...(grants.get(agentId) ?? [])],
    attachSecret: async (agentId: string, secretId: string) => {
      if (!vault.some((one) => one.id === secretId)) throw coded('unknown_secret', 'No such key');
      grants.set(agentId, new Set([...(grants.get(agentId) ?? []), secretId]));
    },
    detachSecret: async (agentId: string, secretId: string) => void grants.get(agentId)?.delete(secretId),
  });
  return { ...built, vault, grants, values };
}

test('keys are unsupported without the host methods, and a create with keys is refused', async () => {
  const t = await paired();
  t.wizzle.send({ t: 'sync' });
  assert.equal((((await t.wizzle.nextOf('hello')).header.capabilities) as Record<string, boolean>).keys, false);
  for (const packet of [
    { t: 'secrets' },
    { t: 'delete_secret', secretId: 's1' },
    { t: 'agent_secrets', agentId: 'g1' },
    { t: 'attach_secret', agentId: 'g1', secretId: 's1' },
  ] as WizzleMessage[]) {
    t.wizzle.send({ ...packet, id: 'u1' });
    const refused = await t.wizzle.nextOf('error');
    assert.equal(refused.header.code, 'unsupported');
    assert.equal(refused.header.ref, 'u1');
  }
  t.wizzle.send({ t: 'create_agent', name: 'Scout', secrets: ['s1'] });
  assert.equal((await t.wizzle.nextOf('error')).header.code, 'unsupported');
  t.bridge.stop();
});

test('the vault is listed, and every change answers the asker and reaches wizzle', async () => {
  const built = keyHost();
  const t = await paired(built);
  const seen: string[] = [];
  const next = t.wizzle.next.bind(t.wizzle);
  t.wizzle.next = async () => {
    const packet = await next();
    seen.push(JSON.stringify(packet.header));
    return packet;
  };
  t.wizzle.send({ t: 'sync' });
  assert.equal((((await t.wizzle.nextOf('hello')).header.capabilities) as Record<string, boolean>).keys, true);
  t.wizzle.send({ t: 'secrets' });
  assert.deepEqual((await t.wizzle.nextOf('secrets')).header.secrets, built.vault);

  const input: SecretInput = { name: 'Bot', type: 'generic', host: 'api.telegram.org', injection: { pathTemplate: '/bot{value}' }, value: '123:abc ' };
  t.wizzle.send({ t: 'create_secret', secret: input, id: 'c1' });
  const saved = await t.wizzle.nextOf('secret');
  assert.equal(saved.header.ref, 'c1');
  assert.deepEqual(saved.header.secret, { id: 's2', name: 'Bot', type: 'generic', host: 'api.telegram.org', injection: { pathTemplate: '/bot{value}' } });
  assert.equal(built.values.get('s2'), '123:abc ');
  assert.deepEqual(((await t.wizzle.nextOf('secrets')).header.secrets as Secret[]).map((s) => s.id), ['s1', 's2']);

  t.wizzle.send({ t: 'update_secret', secretId: 's1', changes: { name: 'GitHub main', value: 'ghp_new' }, id: 'c2' });
  const updated = await t.wizzle.nextOf('secret');
  assert.equal(updated.header.ref, 'c2');
  assert.equal((updated.header.secret as Secret).name, 'GitHub main');
  assert.equal(built.values.get('s1'), 'ghp_new');
  await t.wizzle.nextOf('secrets');

  t.wizzle.send({ t: 'delete_secret', secretId: 's2' });
  assert.equal((await t.wizzle.nextOf('secret_deleted')).header.secretId, 's2');
  assert.deepEqual(((await t.wizzle.nextOf('secrets')).header.secrets as Secret[]).map((s) => s.id), ['s1']);
  assert.equal(seen.some((header) => header.includes('ghp_new') || header.includes('123:abc')), false);
  t.bridge.stop();
});

test('key requests are validated before the host is called, and host codes come back with the ref', async () => {
  const built = keyHost();
  const t = await paired(built);
  const refusals: Array<[WizzleMessage, string]> = [
    [{ t: 'create_secret', secret: { name: 'X', type: 'generic', host: 'a.com', value: '' } }, 'bad_request'],
    [{ t: 'create_secret', secret: { name: 'X', type: 'other' as never, host: 'a.com', value: 'v' } }, 'bad_request'],
    [{ t: 'create_secret', secret: { name: 'X', type: 'generic', host: 'a.com', value: 'v', injection: { headerName: 'A', paramName: 'b' } as never } }, 'bad_request'],
    [{ t: 'update_secret', secretId: 's1', changes: {} }, 'bad_request'],
    [{ t: 'update_secret', secretId: ' ', changes: { name: 'Y' } }, 'bad_request'],
    [{ t: 'update_secret', secretId: 's1', changes: { injection: { pathRegex: '^/x' } as never } }, 'bad_request'],
    [{ t: 'create_secret', secret: { name: 'X', type: 'generic', host: 'https://a.com', value: 'v', injection: { paramName: 'key' } } }, 'bad_request'],
    [{ t: 'delete_secret', secretId: 's9' }, 'unknown_secret'],
    [{ t: 'agent_secrets', agentId: 'system' }, 'bad_request'],
    [{ t: 'agent_secrets', agentId: 'g9' }, 'unknown_agent'],
    [{ t: 'attach_secret', agentId: 'g1' } as never, 'bad_request'],
    [{ t: 'attach_secret', agentId: 'g2', secretId: 's9' }, 'unknown_secret'],
    [{ t: 'create_agent', name: 'Scout', secrets: ['s1', 3] as never }, 'bad_request'],
  ];
  for (const [packet, code] of refusals) {
    t.wizzle.send({ ...packet, id: 'v1' });
    const refused = await t.wizzle.nextOf('error');
    assert.equal(refused.header.code, code, JSON.stringify(packet));
    assert.equal(refused.header.ref, 'v1');
  }
  assert.equal(built.vault.length, 1);
  assert.equal(built.requests.length, 0);
  t.bridge.stop();
});

test('an agent\'s keys are listed, attached and detached, and a create carries the picked keys', async () => {
  const built = keyHost();
  const t = await paired(built);
  t.wizzle.send({ t: 'agent_secrets', agentId: 'g2' });
  const listed = await t.wizzle.nextOf('agent_secrets');
  assert.equal(listed.header.agentId, 'g2');
  assert.deepEqual(listed.header.secretIds, []);
  t.wizzle.send({ t: 'attach_secret', agentId: 'g2', secretId: 's1' });
  const attached = await t.wizzle.nextOf('agent_secrets');
  assert.equal(attached.header.agentId, 'g2');
  assert.deepEqual(attached.header.secretIds, ['s1']);
  t.wizzle.send({ t: 'detach_secret', agentId: 'g1', secretId: 's1' });
  assert.deepEqual((await t.wizzle.nextOf('agent_secrets')).header.secretIds, []);

  t.wizzle.send({ t: 'create_agent', name: 'Scout', template: 'sales/sdr', secrets: [' s1 ', 's1', 's2'] });
  await t.wizzle.nextOf('agent');
  assert.deepEqual(built.requests[0], { name: 'Scout', template: 'sales/sdr', secrets: ['s1', 's2'] });
  t.bridge.stop();
});

const ROOM = 'wizzle:room:r1';

function roomHost() {
  const built = fakeHost();
  const rooms: HostRoom[] = [{ conv: ROOM, title: 'Launch plan', members: ['g1', 'g2'], createdAt: 1700000002000 }];
  const continued: string[] = [];
  const updates: Array<{ conv: string; changes: HostRoomChanges }> = [];
  const cleared: string[] = [];
  const created: Array<{ title: string; members: string[] }> = [];
  Object.assign(built.host, {
    listRooms: async () => rooms.map((room) => ({ ...room, members: [...room.members] })),
    createRoom: async (title: string, members: string[]) => {
      created.push({ title, members });
      if (title === 'Refused') throw coded('create_failed', 'The host said no');
      const room: HostRoom = { conv: `wizzle:room:r${rooms.length + 1}`, title, members };
      rooms.push(room);
      return { ...room };
    },
    updateRoom: async (conv: string, changes: HostRoomChanges) => {
      updates.push({ conv, changes });
      const room = rooms.find((one) => one.conv === conv) as HostRoom;
      if (changes.title) room.title = changes.title;
      if (changes.members) room.members = changes.members;
      return { ...room, members: [...room.members] };
    },
    deleteRoom: async (conv: string) => {
      rooms.splice(rooms.findIndex((one) => one.conv === conv), 1);
      return { questionIds: ['q9'] };
    },
    continueRoom: async (conv: string) => void continued.push(conv),
    clearConversation: async (conv: string) => {
      cleared.push(conv);
      return { questionIds: [] };
    },
  } satisfies Partial<BridgeHost>);
  return { ...built, rooms, continued, updates, cleared, created };
}

test('rooms are unsupported without the room methods', async () => {
  const t = await paired();
  t.wizzle.send({ t: 'sync' });
  const hello = await t.wizzle.nextOf('hello');
  assert.equal((hello.header.capabilities as Record<string, boolean>).rooms, false);
  t.wizzle.send({ t: 'create_room', title: 'Ops', members: ['g1', 'g2'], id: 'c1' });
  const refused = await t.wizzle.nextOf('error');
  assert.equal(refused.header.code, 'unsupported');
  assert.equal(refused.header.ref, 'c1');
  t.bridge.stop();
});

test('a room host lists its rooms after the conversations', async () => {
  const built = roomHost();
  built.host.history = async (conv) => ({
    messages: conv === ROOM ? [{ conv, msgId: 'a1', role: 'agent', text: 'hi', format: 'markdown', at: 5000, speaker: 'g2' }] : [],
    hasMore: false,
  });
  const t = await paired(built);
  t.wizzle.send({ t: 'sync' });
  const hello = await t.wizzle.nextOf('hello');
  assert.equal((hello.header.capabilities as Record<string, boolean>).rooms, true);
  const conversations = await t.wizzle.nextOf('conversations');
  assert.equal((conversations.header.conversations as Array<{ id: string }>).some((c) => c.id === ROOM), false);
  const rooms = await t.wizzle.nextOf('rooms');
  assert.deepEqual(rooms.header.rooms, [{ id: ROOM, title: 'Launch plan', members: ['g1', 'g2'], createdAt: 1700000002000, lastAgentAt: 5000 }]);
  t.bridge.stop();
});

test('create_room answers with the room under its ref, then every app gets the catalog', async () => {
  const built = roomHost();
  const t = await paired(built);
  t.wizzle.send({ t: 'create_room', title: ' Ops ', members: ['g2', 'g1'], id: 'c1' });
  const room = await t.wizzle.nextOf('room');
  assert.equal(room.header.ref, 'c1');
  assert.deepEqual(room.header.room, { id: 'wizzle:room:r2', title: 'Ops', members: ['g2', 'g1'] });
  const rooms = await t.wizzle.nextOf('rooms');
  assert.deepEqual((rooms.header.rooms as Array<{ id: string }>).map((r) => r.id), [ROOM, 'wizzle:room:r2']);
  assert.deepEqual(built.created, [{ title: 'Ops', members: ['g2', 'g1'] }]);
  t.bridge.stop();
});

test('room requests are validated before the host is called, and host codes come back with the ref', async () => {
  const built = roomHost();
  const t = await paired(built);
  const refusal = async (packet: WizzleMessage & { id: string }) => {
    t.wizzle.send(packet);
    const error = await t.wizzle.nextOf('error');
    assert.equal(error.header.ref, packet.id);
    return error.header.code;
  };
  assert.equal(await refusal({ t: 'create_room', title: 'Ops', members: ['g1'], id: 'a' }), 'bad_request');
  assert.equal(await refusal({ t: 'create_room', title: 'Ops', members: ['g1', 'g1'], id: 'b' }), 'bad_request');
  assert.equal(await refusal({ t: 'create_room', title: 'Ops', members: ['g1', 'system'], id: 'c' }), 'bad_request');
  assert.equal(await refusal({ t: 'create_room', title: 'Ops', members: ['g1', 'g9'], id: 'd' }), 'unknown_agent');
  assert.equal(await refusal({ t: 'create_room', title: '  ', members: ['g1', 'g2'], id: 'e' }), 'bad_request');
  assert.equal(await refusal({ t: 'create_room', title: 'x'.repeat(61), members: ['g1', 'g2'], id: 'f' }), 'bad_request');
  assert.equal(await refusal({ t: 'create_room', title: 'Ops', members: Array.from({ length: 9 }, (_, i) => `g${i}`), id: 'g' }), 'bad_request');
  assert.deepEqual(built.created, []);
  assert.equal(await refusal({ t: 'create_room', title: 'Refused', members: ['g1', 'g2'], id: 'h' }), 'create_failed');
  assert.equal(await refusal({ t: 'update_room', conv: 'wizzle:room:nope', title: 'X', id: 'i' }), 'unknown_conv');
  assert.equal(await refusal({ t: 'update_room', conv: ROOM, id: 'j' }), 'bad_request');
  assert.equal(await refusal({ t: 'update_room', conv: ROOM, members: ['g1'], id: 'k' }), 'bad_request');
  assert.equal(await refusal({ t: 'delete_room', conv: 'wizzle:agent:g1', id: 'l' }), 'unknown_conv');
  assert.equal(await refusal({ t: 'continue_room', conv: 'wizzle:room:nope', id: 'm' }), 'unknown_conv');
  assert.deepEqual(built.updates, []);
  t.bridge.stop();
});

test('update, continue, clear and delete reach the host for a room', async () => {
  const built = roomHost();
  const t = await paired(built);
  t.wizzle.send({ t: 'update_room', conv: ROOM, title: 'Launch', id: 'u1' });
  const renamed = await t.wizzle.nextOf('room');
  assert.equal(renamed.header.ref, 'u1');
  assert.equal((renamed.header.room as { title: string }).title, 'Launch');
  t.wizzle.send({ t: 'update_room', conv: ROOM, members: ['g1', 'g2', 'g2'], id: 'u2' });
  assert.equal((await t.wizzle.nextOf('error')).header.code, 'bad_request');
  assert.deepEqual(built.updates, [{ conv: ROOM, changes: { title: 'Launch' } }]);

  t.wizzle.send({ t: 'continue_room', conv: ROOM });
  await until(() => built.continued.length === 1);
  assert.deepEqual(built.continued, [ROOM]);

  t.wizzle.send({ t: 'clear', conv: ROOM });
  const session = await t.wizzle.nextOf('session');
  assert.equal(session.header.conv, ROOM);
  assert.equal(session.header.event, 'cleared');
  assert.deepEqual(built.cleared, [ROOM]);

  t.wizzle.send({ t: 'delete_room', conv: ROOM });
  const resolved = await t.wizzle.nextOf('question_resolved');
  assert.equal(resolved.header.questionId, 'q9');
  const deleted = await t.wizzle.nextOf('room_deleted');
  assert.equal(deleted.header.conv, ROOM);
  const rooms = await t.wizzle.nextOf('rooms');
  assert.deepEqual(rooms.header.rooms, []);
  t.bridge.stop();
});

test('a send to a room reaches the runtime, and only a woken member\'s typing shows, under its speaker', async () => {
  const built = roomHost();
  built.host.activity = async (_conv, speaker) => (speaker === 'g2' ? { running: true, tool: 'Bash' } : { running: false });
  const t = await paired(built);
  t.wizzle.send({ t: 'send', conv: ROOM, msgId: 'p1', text: '@Ops go' });
  await until(() => t.inbound.length === 1);
  assert.equal(t.inbound[0]?.conv, ROOM);
  await t.bridge.typing(ROOM, undefined, undefined, 'g2');
  await t.bridge.typing(ROOM);
  t.bridge.expect(ROOM, 'g2');
  await t.bridge.typing(ROOM, undefined, undefined, 'g2');
  const activity = await t.wizzle.nextOf('activity');
  assert.deepEqual(activity.header.activity, { conv: ROOM, state: 'tool', tool: 'Bash', speaker: 'g2' });
  await t.bridge.deliver(ROOM, { kind: 'chat', content: { text: 'done' }, id: 'out-1', speaker: 'g2' });
  const message = await t.wizzle.nextOf('message');
  assert.deepEqual(message.header.message, { conv: ROOM, msgId: 'out-1', role: 'agent', text: 'done', format: 'markdown', at: (message.header.message as { at: number }).at, speaker: 'g2' });
  const idle = await t.wizzle.nextOf('activity');
  assert.deepEqual(idle.header.activity, { conv: ROOM, state: 'idle', speaker: 'g2' });
  await t.bridge.typing(ROOM, undefined, undefined, 'g2');
  assert.equal(t.wizzle.received.length, 0);
  t.bridge.stop();
});

test('room output carries its speaker on files, cards and questions', async () => {
  const t = await paired(roomHost());
  await t.bridge.deliver(ROOM, { kind: 'chat', content: { text: 'see file' }, id: 'o1', speaker: 'g1', files: [{ filename: 'a.pdf', data: utf8('pdf') }] });
  assert.equal(((await t.wizzle.nextOf('message')).header.message as { speaker?: string }).speaker, 'g1');
  const file = await t.wizzle.nextOf('file');
  assert.equal(file.header.speaker, 'g1');
  assert.equal(file.header.msgId, 'o1:f0');
  await t.bridge.deliver(ROOM, { kind: 'chat', content: { card: { type: 'card' }, fallbackText: 'card' }, id: 'o2', speaker: 'g2' });
  assert.equal((await t.wizzle.nextOf('card')).header.speaker, 'g2');
  await t.bridge.deliver(ROOM, { kind: 'chat', content: { type: 'ask_question', questionId: 'q1' }, speaker: 'g2' });
  const question = await t.wizzle.nextOf('question');
  assert.equal((question.header.question as { speaker?: string }).speaker, 'g2');
  await t.bridge.deliver(ROOM, { kind: 'chat', content: { operation: 'edit', messageId: 'o2', text: 'fixed' }, speaker: 'g2' });
  assert.equal((await t.wizzle.nextOf('edit')).header.speaker, 'g2');
  t.bridge.stop();
});

test('a room hold reaches wizzle, is replayed on sync, and an empty list clears it once', async () => {
  const t = await paired(roomHost());
  t.bridge.holdRoom(ROOM, ['g2']);
  assert.deepEqual((await t.wizzle.nextOf('room_hold')).header.held, ['g2']);
  t.wizzle.send({ t: 'sync' });
  await t.wizzle.nextOf('rooms');
  const replay = await t.wizzle.next();
  assert.equal(replay.header.t, 'room_hold');
  assert.deepEqual(replay.header.held, ['g2']);
  t.bridge.holdRoom(ROOM, []);
  assert.deepEqual((await t.wizzle.nextOf('room_hold')).header.held, []);
  t.bridge.holdRoom(ROOM, []);
  t.bridge.notify(ROOM, 'after the hold');
  assert.equal((await t.wizzle.next()).header.t, 'message');
  t.bridge.stop();
});
