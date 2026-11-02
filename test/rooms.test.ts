import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONTINUE_TEXT,
  RoomRouter,
  isMemberChannel,
  isRoomConv,
  memberChannel,
  mergeRoomMessages,
  newRoomId,
  parseRoom,
  roomConv,
  type RoomInbound,
  type RoomMember,
} from '../src/rooms.ts';

const CONV = roomConv('r1');
const OWNER = { sender: 'Wizzle', senderId: 'wizzle:owner' };

function room(names = ['Scout', 'Quill', 'Ada'], cap?: number) {
  const members: RoomMember[] = names.map((name, i) => ({ agentGroupId: `g${i + 1}`, name, channel: memberChannel('r1', `g${i + 1}`) }));
  const injected: RoomInbound[] = [];
  const expected: string[] = [];
  const holds: string[][] = [];
  const router = new RoomRouter({
    owner: OWNER,
    ...(cap !== undefined && { cap }),
    hooks: {
      members: async () => members,
      inject: (message) => void injected.push(message),
      expect: (_conv, speaker) => void expected.push(speaker),
      hold: (_conv, held) => void holds.push(held),
    },
  });
  return { router, members, injected, expected, holds };
}

function agentOf(message: RoomInbound): string | undefined {
  return parseRoom(message.channel)?.agentGroupId;
}

function woken(injected: RoomInbound[]): Array<string | undefined> {
  return injected.filter((m) => m.isMention).map(agentOf);
}

test('room ids: a room conversation has no agent, a member channel names one', () => {
  assert.equal(CONV, 'wizzle:room:r1');
  assert.equal(memberChannel('r1', 'ag-7'), 'wizzle:room:r1:ag-7');
  assert.deepEqual(parseRoom('wizzle:room:r1'), { roomId: 'r1' });
  assert.deepEqual(parseRoom('wizzle:room:r1:ag-7'), { roomId: 'r1', agentGroupId: 'ag-7' });
  assert.equal(isRoomConv('wizzle:room:r1'), true);
  assert.equal(isRoomConv('wizzle:room:r1:ag-7'), false);
  assert.equal(isMemberChannel('wizzle:room:r1:ag-7'), true);
  for (const bad of ['wizzle:agent:g1', 'wizzle:room:', 'wizzle:room:R1', 'wizzle:room:r1:', 'wizzle:room:r1:a:b']) {
    assert.equal(parseRoom(bad), undefined, bad);
  }
  assert.match(newRoomId(), /^[a-z0-9]{16}$/);
});

test('the owner reaches every member under one id, and only the members it names wake', async () => {
  const t = room();
  const named = await t.router.fromOwner(CONV, { id: 'wizzle-1', msgId: 'p1', text: '@Quill draft it' });
  assert.deepEqual(named, ['g2']);
  assert.deepEqual(t.injected.map(agentOf), ['g1', 'g2', 'g3']);
  for (const message of t.injected) {
    assert.equal(message.id, 'wizzle-1');
    assert.equal(message.msgId, 'p1');
    assert.equal(message.senderId, 'wizzle:owner');
    assert.equal(message.sender, 'Wizzle');
  }
  assert.deepEqual(woken(t.injected), ['g2']);
  assert.deepEqual(t.expected, ['g2']);
});

test('an owner message naming nobody wakes nobody, and @all wakes everyone', async () => {
  const t = room();
  await t.router.fromOwner(CONV, { id: 'wizzle-1', msgId: 'p1', text: 'just so you all know' });
  assert.deepEqual(woken(t.injected), []);
  assert.equal(t.injected.length, 3);
  await t.router.fromOwner(CONV, { id: 'wizzle-2', msgId: 'p2', text: '@all stand up' });
  assert.deepEqual(woken(t.injected), ['g1', 'g2', 'g3']);
});

test('the owner\'s files go to every member', async () => {
  const t = room();
  const attachments = [{ name: 'a.txt', mimeType: 'text/plain', size: 2, data: 'aGk=' }];
  await t.router.fromOwner(CONV, { id: 'wizzle-1', msgId: 'p1', text: '', attachments });
  assert.equal(t.injected.length, 3);
  for (const message of t.injected) assert.deepEqual(message.attachments, attachments);
});

test('an agent message goes to the other members under its messages_out id and its own sender id', async () => {
  const t = room();
  const named = await t.router.fromAgent(CONV, 'g1', { id: 'out-1', content: { text: 'Found it. @Ada over to you, @Scout notes' } });
  assert.deepEqual(named, ['g3']);
  assert.deepEqual(t.injected.map(agentOf), ['g2', 'g3']);
  for (const message of t.injected) {
    assert.equal(message.id, 'out-1');
    assert.equal(message.msgId, 'out-1');
    assert.equal(message.sender, 'Scout');
    assert.equal(message.senderId, 'wizzle-agent:g1');
    assert.notEqual(message.senderId, 'wizzle:owner');
  }
  assert.deepEqual(woken(t.injected), ['g3']);
  assert.deepEqual(t.expected, ['g3']);
});

test('a delivery without an id, a repeated id, or from a non-member is not passed on', async () => {
  const t = room();
  assert.deepEqual(await t.router.fromAgent(CONV, 'g1', { content: { text: '@Quill go' } }), []);
  assert.equal(t.injected.length, 0);
  await t.router.fromAgent(CONV, 'g1', { id: 'out-1', content: { text: '@Quill go' } });
  await t.router.fromAgent(CONV, 'g1', { id: 'out-1', content: { text: '@Quill go' } });
  assert.equal(t.injected.length, 2);
  assert.deepEqual(t.expected, ['g2']);
  await t.router.fromAgent(CONV, 'g9', { id: 'out-2', content: { text: '@Quill go' } });
  assert.equal(t.injected.length, 2);
});

test('questions, edits and reactions stay put, a card passes its fallback text and files pass as attachments', async () => {
  const t = room(['Scout', 'Quill']);
  await t.router.fromAgent(CONV, 'g1', { id: 'q1', content: { type: 'ask_question', questionId: 'q1', question: '@Quill?' } });
  await t.router.fromAgent(CONV, 'g1', { id: 'e1', content: { operation: 'edit', messageId: 'x', text: '@Quill' } });
  await t.router.fromAgent(CONV, 'g1', { id: 'x1', content: { operation: 'reaction', messageId: 'x', emoji: 'ok' } });
  assert.equal(t.injected.length, 0);
  await t.router.fromAgent(CONV, 'g1', { id: 'c1', content: { card: { type: 'card' }, fallbackText: 'Card for @Quill' } });
  assert.equal(t.injected[0]?.text, 'Card for @Quill');
  assert.equal(t.injected[0]?.isMention, true);
  await t.router.fromAgent(CONV, 'g1', { id: 'f1', content: { text: '' }, files: [{ filename: 'plan.pdf', data: new Uint8Array([1, 2]) }] });
  assert.deepEqual(t.injected[1]?.attachments, [{ name: 'plan.pdf', mimeType: 'application/pdf', size: 2, data: 'AQI=' }]);
  assert.equal(t.injected[1]?.isMention, false);
});

test('a member naming itself does not wake itself', async () => {
  const t = room(['Scout', 'Quill']);
  await t.router.fromAgent(CONV, 'g1', { id: 'out-1', content: { text: '@Scout will handle it' } });
  assert.deepEqual(woken(t.injected), []);
});

test('past the handoff cap the named agent is held, told to the app, and the owner\'s next message starts over', async () => {
  const t = room(['Scout', 'Quill', 'Ada']);
  for (let n = 0; n < 6; n += 1) {
    const [speaker, text] = n % 2 === 0 ? ['g1', '@Quill your turn'] : ['g2', '@Scout your turn'];
    assert.equal((await t.router.fromAgent(CONV, speaker, { id: `out-${n}`, content: { text } })).length, 1);
  }
  assert.deepEqual(t.holds, []);
  const before = t.injected.length;
  assert.deepEqual(await t.router.fromAgent(CONV, 'g1', { id: 'out-6', content: { text: '@Quill and @Ada again' } }), []);
  const held = t.injected.slice(before);
  assert.deepEqual(held.map(agentOf), ['g2', 'g3']);
  assert.equal(held.every((m) => !m.isMention), true);
  assert.deepEqual(t.holds, [['g2', 'g3']]);
  assert.deepEqual(t.router.heldIn(CONV), ['g2', 'g3']);

  await t.router.fromOwner(CONV, { id: 'wizzle-9', msgId: 'p9', text: 'carry on without anyone' });
  assert.deepEqual(t.holds, [['g2', 'g3'], []]);
  assert.deepEqual(await t.router.fromAgent(CONV, 'g1', { id: 'out-7', content: { text: '@Quill go' } }), ['g2']);
});

test('continue wakes the held members with a note and starts the count again', async () => {
  const t = room(['Scout', 'Quill'], 1);
  await t.router.fromAgent(CONV, 'g1', { id: 'out-1', content: { text: '@Quill go' } });
  await t.router.fromAgent(CONV, 'g2', { id: 'out-2', content: { text: '@Scout back to you' } });
  assert.deepEqual(t.router.heldIn(CONV), ['g1']);
  const before = t.injected.length;
  assert.deepEqual(await t.router.continue(CONV), ['g1']);
  const [note] = t.injected.slice(before);
  assert.equal(note?.channel, memberChannel('r1', 'g1'));
  assert.equal(note?.isMention, true);
  assert.equal(note?.text, CONTINUE_TEXT);
  assert.equal(note?.note, 'continue');
  assert.equal(note?.senderId, 'wizzle:owner');
  assert.equal(note?.id, note?.msgId);
  assert.deepEqual(t.holds, [['g1'], []]);
  assert.deepEqual(t.router.heldIn(CONV), []);
  assert.deepEqual(await t.router.fromAgent(CONV, 'g1', { id: 'out-3', content: { text: '@Quill one more' } }), ['g2']);
  assert.deepEqual(await t.router.continue(CONV), []);
});

test('forget drops the count and the hold of a cleared room', async () => {
  const t = room(['Scout', 'Quill'], 0);
  await t.router.fromAgent(CONV, 'g1', { id: 'out-1', content: { text: '@Quill go' } });
  assert.deepEqual(t.router.heldIn(CONV), ['g2']);
  t.router.forget(CONV);
  assert.deepEqual(t.router.heldIn(CONV), []);
  assert.deepEqual(t.holds, [['g2'], []]);
});

test('merged room messages keep the first copy of each id, oldest first, up to the cap', () => {
  const conv = CONV;
  const own = [{ conv, msgId: 'a', role: 'agent' as const, text: 'own', format: 'markdown' as const, at: 2, speaker: 'g1' }];
  const copies = [
    { conv, msgId: 'a', role: 'agent' as const, text: 'copy', format: 'markdown' as const, at: 3, speaker: 'g1' },
    { conv, msgId: 'b', role: 'user' as const, text: 'mine', format: 'text' as const, at: 1 },
  ];
  assert.deepEqual(mergeRoomMessages([own, copies], 10).map((m) => [m.msgId, m.text]), [
    ['b', 'mine'],
    ['a', 'own'],
  ]);
  assert.deepEqual(mergeRoomMessages([own, copies], 1).map((m) => m.msgId), ['a']);
});
