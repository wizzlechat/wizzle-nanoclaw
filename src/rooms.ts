import { randomUUID } from 'node:crypto';

import { ROOM_LIMITS, mentioned, type ChatMessage } from '../../wizzle-protocol/src/index.ts';
import { mimeFor, type InboundAttachment, type InboundText, type OutboundFile } from './bridge.ts';

// A room's conversation is `wizzle:room:<roomId>`; each member's channel adds `:<agentGroupId>`.
export const ROOM_PREFIX = 'wizzle:room:';
// Agent text passed to the other members carries this sender id, never the owner's.
export const AGENT_SENDER_PREFIX = 'wizzle-agent:';
// Content field marking a row the bridge wrote for the agents only; history leaves it out.
export const NOTE_FIELD = 'wizzleNote';
export const CONTINUE_TEXT = 'Continue. The handoff named you above, so pick it up.';

const ROOM_ID = /^[a-z0-9]{1,32}$/;
// Ids of agent messages already passed on, so a delivery retry is not passed on or counted twice.
const SEEN_MAX = 1000;

export function newRoomId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

export function roomConv(roomId: string): string {
  return `${ROOM_PREFIX}${roomId}`;
}

export function memberChannel(roomId: string, agentGroupId: string): string {
  return `${ROOM_PREFIX}${roomId}:${agentGroupId}`;
}

// A room conversation has no agent; a member channel names one.
export function parseRoom(id: string): { roomId: string; agentGroupId?: string } | undefined {
  if (!id.startsWith(ROOM_PREFIX)) return undefined;
  const rest = id.slice(ROOM_PREFIX.length);
  const cut = rest.indexOf(':');
  const roomId = cut < 0 ? rest : rest.slice(0, cut);
  if (!ROOM_ID.test(roomId)) return undefined;
  if (cut < 0) return { roomId };
  const agentGroupId = rest.slice(cut + 1);
  if (agentGroupId.length === 0 || agentGroupId.includes(':')) return undefined;
  return { roomId, agentGroupId };
}

export function isRoomConv(id: string): boolean {
  const parsed = parseRoom(id);
  return parsed !== undefined && parsed.agentGroupId === undefined;
}

export function isMemberChannel(id: string): boolean {
  return parseRoom(id)?.agentGroupId !== undefined;
}

// Merges messages by msgId, the first copy winning, oldest first and at most `max` of the newest.
export function mergeRoomMessages(lists: ChatMessage[][], max: number): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const list of lists) for (const message of list) if (!byId.has(message.msgId)) byId.set(message.msgId, message);
  return [...byId.values()].sort((a, b) => a.at - b.at).slice(-max);
}

export type RoomMember = { agentGroupId: string; name: string; channel: string };

// One message into one member's channel; isMention decides whether it wakes that member.
export type RoomInbound = {
  channel: string;
  id: string;
  isMention: boolean;
  text: string;
  sender: string;
  senderId: string;
  msgId: string;
  attachments?: InboundAttachment[];
  note?: string;
};

export type RoomHooks = {
  members(conv: string): Promise<RoomMember[]>;
  inject(message: RoomInbound): void;
  // A member was woken, so its typing and reply in the room are expected.
  expect(conv: string, speaker: string): void;
  hold(conv: string, held: string[]): void;
};

export type RoomOutbound = { id?: string; content: unknown; files?: OutboundFile[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The text other members see; questions, edits and reactions are not passed on.
function passedText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!isRecord(content)) return null;
  if (content.type === 'ask_question' || typeof content.operation === 'string') return null;
  if (content.card !== undefined) return typeof content.fallbackText === 'string' ? content.fallbackText : '';
  if (typeof content.text === 'string') return content.text;
  if (typeof content.markdown === 'string') return content.markdown;
  return null;
}

function attachmentsOf(files: OutboundFile[] | undefined): InboundAttachment[] {
  return (files ?? []).map((file) => ({
    name: file.filename,
    mimeType: mimeFor(file.filename),
    size: file.data.length,
    data: Buffer.from(file.data).toString('base64'),
  }));
}

// Fans owner and agent messages out to a room's member channels and caps agent to agent wakes.
export class RoomRouter {
  private readonly hooks: RoomHooks;
  private readonly owner: { sender: string; senderId: string };
  private readonly cap: number;
  private readonly handoffs = new Map<string, number>();
  private readonly held = new Map<string, string[]>();
  private readonly seen = new Set<string>();

  constructor(opts: { hooks: RoomHooks; owner: { sender: string; senderId: string }; cap?: number }) {
    this.hooks = opts.hooks;
    this.owner = opts.owner;
    this.cap = opts.cap ?? ROOM_LIMITS.handoffs;
  }

  // Every member gets the owner's message; only the ones it names wake, and the handoff count starts over.
  async fromOwner(conv: string, message: InboundText): Promise<string[]> {
    const members = await this.hooks.members(conv);
    this.release(conv);
    const woken = mentioned(message.text, members.map((m) => ({ id: m.agentGroupId, name: m.name })));
    for (const member of members) {
      const wake = woken.includes(member.agentGroupId);
      this.hooks.inject({
        channel: member.channel,
        id: message.id,
        isMention: wake,
        text: message.text,
        sender: this.owner.sender,
        senderId: this.owner.senderId,
        msgId: message.msgId,
        ...(message.attachments && { attachments: message.attachments }),
      });
      if (wake) this.hooks.expect(conv, member.agentGroupId);
    }
    return woken;
  }

  // An agent's message goes to every other member under its own id; the ones it names wake until the cap.
  async fromAgent(conv: string, speaker: string, out: RoomOutbound): Promise<string[]> {
    if (out.id === undefined || this.seen.has(out.id)) return [];
    const text = passedText(out.content);
    const attachments = attachmentsOf(out.files);
    if ((text === null || text.length === 0) && attachments.length === 0) return [];
    this.remember(out.id);
    const members = await this.hooks.members(conv);
    const from = members.find((m) => m.agentGroupId === speaker);
    if (!from) return [];
    const named = mentioned(text ?? '', members.map((m) => ({ id: m.agentGroupId, name: m.name }))).filter((id) => id !== speaker);
    const woken: string[] = [];
    const held: string[] = [];
    for (const member of members) {
      if (member.agentGroupId === speaker) continue;
      let wake = false;
      if (named.includes(member.agentGroupId)) {
        const count = this.handoffs.get(conv) ?? 0;
        if (count < this.cap) {
          this.handoffs.set(conv, count + 1);
          wake = true;
          woken.push(member.agentGroupId);
        } else {
          held.push(member.agentGroupId);
        }
      }
      this.hooks.inject({
        channel: member.channel,
        id: out.id,
        isMention: wake,
        text: text ?? '',
        sender: from.name,
        senderId: `${AGENT_SENDER_PREFIX}${speaker}`,
        msgId: out.id,
        ...(attachments.length > 0 && { attachments }),
      });
      if (wake) this.hooks.expect(conv, member.agentGroupId);
    }
    if (held.length > 0) {
      const all = [...new Set([...(this.held.get(conv) ?? []), ...held])];
      this.held.set(conv, all);
      this.hooks.hold(conv, all);
    }
    return woken;
  }

  // Wakes the held members that are still in the room and starts the count again.
  async continue(conv: string): Promise<string[]> {
    const held = this.held.get(conv) ?? [];
    this.release(conv);
    if (held.length === 0) return [];
    const members = await this.hooks.members(conv);
    const woken: string[] = [];
    for (const member of members) {
      if (!held.includes(member.agentGroupId)) continue;
      const id = `wizzle-continue-${randomUUID()}`;
      this.hooks.inject({
        channel: member.channel,
        id,
        isMention: true,
        text: CONTINUE_TEXT,
        sender: this.owner.sender,
        senderId: this.owner.senderId,
        msgId: id,
        note: 'continue',
      });
      this.hooks.expect(conv, member.agentGroupId);
      woken.push(member.agentGroupId);
    }
    return woken;
  }

  heldIn(conv: string): string[] {
    return this.held.get(conv) ?? [];
  }

  // A cleared or deleted room starts with no count and no hold.
  forget(conv: string): void {
    this.handoffs.delete(conv);
    if (this.held.delete(conv)) this.hooks.hold(conv, []);
  }

  private release(conv: string): void {
    this.handoffs.set(conv, 0);
    if (this.held.delete(conv)) this.hooks.hold(conv, []);
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size <= SEEN_MAX) return;
    const oldest = this.seen.values().next().value;
    if (oldest !== undefined) this.seen.delete(oldest);
  }
}
