import type { ChatMessage, ChatRole } from '../../wizzle-protocol/src/index.ts';

// One mailbox row as the runtime's history readers return it.
export type MailboxRow = { id: string; timestamp: string; kind: string; content: string };

// The runtime copies a message into a conversation's other sessions as `<original id>:echo:<session>`.
const ECHO_MARK = ':echo:';
const TASK_DELIVERY = 'task-delivery';

type RowContent = { text: string; senderId?: string; msgId?: string; operation?: string; echo?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseTimestamp(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

function rowContent(content: string): RowContent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content.length > 0 ? { text: content } : null;
  }
  if (typeof parsed === 'string') return parsed.length > 0 ? { text: parsed } : null;
  if (!isRecord(parsed)) return null;
  const text = typeof parsed.text === 'string' ? parsed.text : typeof parsed.markdown === 'string' ? parsed.markdown : null;
  if (text === null || text.length === 0) return null;
  return {
    text,
    ...(typeof parsed.senderId === 'string' && { senderId: parsed.senderId }),
    ...(typeof parsed.msgId === 'string' && { msgId: parsed.msgId }),
    ...(typeof parsed.operation === 'string' && { operation: parsed.operation }),
    ...(isRecord(parsed.echo) && { echo: typeof parsed.echo.surface === 'string' ? parsed.echo.surface : '' }),
  };
}

// The row id is the stable msgId; only a core without it falls back to the old timestamp ids.
function historyId(row: { id?: string }, fallback: string): string {
  return typeof row.id === 'string' && row.id.length > 0 ? row.id : fallback;
}

function echoOrigin(id: string): string | null {
  const at = id.indexOf(ECHO_MARK);
  return at > 0 ? id.slice(0, at) : null;
}

// Original ids of the scheduled task deliveries echoed into this conversation.
export function taskEchoOrigins(inbound: MailboxRow[]): string[] {
  const ids: string[] = [];
  for (const row of inbound) {
    const origin = echoOrigin(row.id);
    if (origin && rowContent(row.content)?.echo === TASK_DELIVERY) ids.push(origin);
  }
  return ids;
}

// An echo is a copy of a message that lives in another session: a task delivery shows as the agent's
// message under its original id and full text from `delivered`, and any other echo is left out.
export function historyMessages(
  conv: string,
  inbound: MailboxRow[],
  outbound: MailboxRow[],
  delivered: ReadonlyMap<string, MailboxRow>,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const row of inbound) {
    if (row.kind !== 'chat' && row.kind !== 'chat-sdk') continue;
    const content = rowContent(row.content);
    const at = parseTimestamp(row.timestamp);
    if (!content || at === undefined) continue;
    if (content.echo !== undefined) {
      const origin = echoOrigin(row.id);
      if (content.echo !== TASK_DELIVERY || !origin) continue;
      const original = delivered.get(origin);
      const full = original ? rowContent(original.content) : null;
      const sentAt = original ? parseTimestamp(original.timestamp) : undefined;
      messages.push({ conv, msgId: origin, role: 'agent', text: full?.text ?? content.text, format: 'markdown', at: sentAt ?? at });
      continue;
    }
    const role: ChatRole = content.senderId === 'system' ? 'system' : 'user';
    const msgId = content.msgId ?? historyId(row, `in-${row.timestamp}-${messages.length}`);
    messages.push({ conv, msgId, role, text: content.text, format: 'text', at });
  }
  for (const row of outbound) {
    if (row.kind === 'system' || row.kind === 'task_log') continue;
    const content = rowContent(row.content);
    const at = parseTimestamp(row.timestamp);
    // Edits and reactions carry an operation; they changed a message rather than being one.
    if (!content || content.operation !== undefined || at === undefined) continue;
    const msgId = historyId(row, `out-${row.timestamp}-${messages.length}`);
    messages.push({ conv, msgId, role: 'agent', text: content.text, format: 'markdown', at });
  }
  messages.sort((a, b) => a.at - b.at);
  return messages;
}
