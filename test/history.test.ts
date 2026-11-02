import assert from 'node:assert/strict';
import { test } from 'node:test';

import { historyMessages, roomHistoryMessages, taskEchoOrigins, type MailboxRow } from '../src/history.ts';

const CONV = 'wizzle:agent:g1';
const AGENT = 'ag-1';

function row(id: string, timestamp: string, content: unknown, kind = 'chat'): MailboxRow {
  return { id, timestamp, kind, content: JSON.stringify(content) };
}

const briefing = 'Good morning. '.repeat(60);
const taskEcho = row('msg-1:echo:sess-chat', '2026-10-22T14:01:02.364Z', {
  text: `${briefing.slice(0, 500)}…`,
  sender: 'Nano Daily',
  senderId: AGENT,
  echo: { surface: 'task-delivery', label: 'this DM, posted by your scheduled task' },
});
const siblingEcho = row('msg-2:echo:sess-chat', '2026-10-22T15:00:00.000Z', {
  text: 'said in another thread',
  sender: 'Wizzle',
  senderId: 'wizzle:owner',
  echo: { surface: 'dm-thread', label: 'another thread' },
});
const wizzle = row('in-1', '2026-10-22T13:00:00.000Z', { text: 'What is today', sender: 'Wizzle', senderId: 'wizzle:owner', msgId: 'p1' });
const note = row('in-2', '2026-10-22T13:30:00.000Z', { text: 'Agent paused', sender: 'system', senderId: 'system' });

test('only task delivery echoes name an original', () => {
  assert.deepEqual(taskEchoOrigins([wizzle, taskEcho, siblingEcho, note]), ['msg-1']);
});

test('a task delivery echo is the agent message under its original id and full text', () => {
  const original = row('msg-1', '2026-10-22T14:01:01.658Z', { text: briefing });
  const messages = historyMessages(CONV, [taskEcho], [], new Map([['msg-1', original]]));
  assert.deepEqual(messages, [
    { conv: CONV, msgId: 'msg-1', role: 'agent', text: briefing, format: 'markdown', at: Date.parse('2026-10-22T14:01:01.658Z') },
  ]);
});

test('without its original the echo text stands in, still as the agent', () => {
  const [message] = historyMessages(CONV, [taskEcho], [], new Map());
  assert.equal(message?.role, 'agent');
  assert.equal(message?.msgId, 'msg-1');
  assert.equal(message?.text.endsWith('…'), true);
});

test('other echoes are left out and wizzle, system and agent rows keep their roles', () => {
  const reply = row('out-1', '2026-10-22T13:00:05.000Z', { text: 'Here it is' });
  const edit = row('out-2', '2026-10-22T13:00:06.000Z', { text: 'Here it is!', operation: 'edit' });
  const messages = historyMessages(CONV, [siblingEcho, note, wizzle], [edit, reply], new Map());
  assert.deepEqual(
    messages.map((m) => [m.msgId, m.role, m.text]),
    [
      ['p1', 'user', 'What is today'],
      ['out-1', 'agent', 'Here it is'],
      ['in-2', 'system', 'Agent paused'],
    ],
  );
});

const ROOM = 'wizzle:room:r1';
const owner = row('wizzle-1:g1', '2026-10-22T16:00:00.000Z', { text: '@Scout find it', sender: 'Wizzle', senderId: 'wizzle:owner', msgId: 'p1' });
const roomNote = row('wizzle-room-note-1', '2026-10-22T15:59:00.000Z', {
  text: 'This is the wizzle room',
  sender: 'system',
  senderId: 'system',
  wizzleNote: 'members',
});

test('a bridge note is left out of plain history too', () => {
  assert.deepEqual(historyMessages(CONV, [roomNote, wizzle], [], new Map()).map((m) => m.msgId), ['p1']);
});

test('room history merges the member sessions, drops copies by msgId and sets the speaker', () => {
  const scout = {
    agentGroupId: 'g1',
    inbound: [
      roomNote,
      owner,
      row('out-b:g1', '2026-10-22T16:00:09.000Z', { text: 'Drafted', sender: 'Quill', senderId: 'wizzle-agent:g2', msgId: 'out-b' }),
      row('wizzle-continue-1:g1', '2026-10-22T16:00:10.000Z', { text: 'Continue.', senderId: 'wizzle:owner', msgId: 'c1', wizzleNote: 'continue' }),
    ],
    outbound: [row('out-a', '2026-10-22T16:00:05.000Z', { text: 'Found it. @Quill draft it' })],
    delivered: new Map<string, MailboxRow>(),
  };
  const quill = {
    agentGroupId: 'g2',
    inbound: [
      { ...owner, id: 'wizzle-1:g2' },
      row('out-a:g2', '2026-10-22T16:00:06.000Z', { text: 'Found it. @Quill draft it', sender: 'Scout', senderId: 'wizzle-agent:g1', msgId: 'out-a' }),
    ],
    outbound: [row('out-b', '2026-10-22T16:00:08.000Z', { text: 'Drafted' })],
    delivered: new Map<string, MailboxRow>(),
  };
  const archived = [
    { conv: ROOM, msgId: 'out-c', role: 'agent' as const, text: 'I left', format: 'markdown' as const, at: Date.parse('2026-10-22T16:00:07.000Z'), speaker: 'g3' },
    { conv: ROOM, msgId: 'p1', role: 'user' as const, text: '@Scout find it', format: 'text' as const, at: Date.parse('2026-10-22T16:00:00.000Z') },
  ];
  const messages = roomHistoryMessages(ROOM, [scout, quill], archived, 100);
  assert.deepEqual(
    messages.map((m) => [m.msgId, m.role, m.speaker, m.text]),
    [
      ['p1', 'user', undefined, '@Scout find it'],
      ['out-a', 'agent', 'g1', 'Found it. @Quill draft it'],
      ['out-c', 'agent', 'g3', 'I left'],
      ['out-b', 'agent', 'g2', 'Drafted'],
    ],
  );
  assert.equal(messages[1]?.at, Date.parse('2026-10-22T16:00:05.000Z'));
  assert.equal(messages.every((m) => m.conv === ROOM), true);
});

test('a member\'s copy stands in for a speaker whose own session is gone', () => {
  const quill = {
    agentGroupId: 'g2',
    inbound: [row('out-a:g2', '2026-10-22T16:00:06.000Z', { text: 'From Scout', sender: 'Scout', senderId: 'wizzle-agent:g1', msgId: 'out-a' })],
    outbound: [],
    delivered: new Map<string, MailboxRow>(),
  };
  assert.deepEqual(roomHistoryMessages(ROOM, [quill], [], 100), [
    { conv: ROOM, msgId: 'out-a', role: 'agent', text: 'From Scout', format: 'markdown', at: Date.parse('2026-10-22T16:00:06.000Z'), speaker: 'g1' },
  ]);
});
