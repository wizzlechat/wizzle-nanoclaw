import assert from 'node:assert/strict';
import { test } from 'node:test';

import { historyMessages, taskEchoOrigins, type MailboxRow } from '../src/history.ts';

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
  sender: 'Phone',
  senderId: 'wizzle:owner',
  echo: { surface: 'dm-thread', label: 'another thread' },
});
const phone = row('in-1', '2026-10-22T13:00:00.000Z', { text: 'What is today', sender: 'Phone', senderId: 'wizzle:owner', msgId: 'p1' });
const note = row('in-2', '2026-10-22T13:30:00.000Z', { text: 'Agent paused', sender: 'system', senderId: 'system' });

test('only task delivery echoes name an original', () => {
  assert.deepEqual(taskEchoOrigins([phone, taskEcho, siblingEcho, note]), ['msg-1']);
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

test('other echoes are left out and the phone, system and agent rows keep their roles', () => {
  const reply = row('out-1', '2026-10-22T13:00:05.000Z', { text: 'Here it is' });
  const edit = row('out-2', '2026-10-22T13:00:06.000Z', { text: 'Here it is!', operation: 'edit' });
  const messages = historyMessages(CONV, [siblingEcho, note, phone], [edit, reply], new Map());
  assert.deepEqual(
    messages.map((m) => [m.msgId, m.role, m.text]),
    [
      ['p1', 'user', 'What is today'],
      ['out-1', 'agent', 'Here it is'],
      ['in-2', 'system', 'Agent paused'],
    ],
  );
});
