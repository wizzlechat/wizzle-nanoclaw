// wizzle channel: the wizzle app paired to this NanoClaw install through the wizzle relay.
// Installed at src/channels/wizzle.ts in NanoClaw; the core sits in src/channels/wizzle-adapter/.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { dispatch } from '../cli/dispatch.js';
import { register } from '../cli/registry.js';
import { DATA_DIR, INSTALL_SLUG, TEMPLATES_DIR } from '../config.js';
import { isContainerRunning, killContainer } from '../container-runner.js';
import { getAgentGroup, getAgentGroupByFolder, getAllAgentGroups } from '../db/agent-groups.js';
import { getDb, hasTable } from '../db/connection.js';
import { getContainerConfig } from '../db/container-configs.js';
import {
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  getMessagingGroupsByAgentGroup,
  getMessagingGroupsByChannel,
} from '../db/messaging-groups.js';
import {
  deletePendingApproval,
  deletePendingQuestion,
  deleteSession,
  findSessionForAgent,
  findTaskSessions,
  getSession,
  getSessionsByAgentGroup,
} from '../db/sessions.js';
import { readEnvFile } from '../env.js';
import { configuredGatewayProviderKind } from '../gateway-providers/index.js';
import { groupFolderExistsOnDisk, resolveGroupFolderPath } from '../group-folder.js';
import { readGroupPersona, stageGroupPersona } from '../group-persona.js';
import { log } from '../log.js';
import { requestWake, type WakeReason } from '../request-wake.js';
import {
  destroySessionMailbox,
  resolveSession,
  sessionDir,
  withExistingMailboxSession,
  writeSessionMessage,
} from '../session-manager.js';
import { ensureTemplateLocal } from '../templates/library.js';
import { PLUGIN_MANIFEST_FILE, parsePluginManifest, type PluginManifest } from '../templates/manifest.js';
import { resolveLocalTemplate } from '../templates/local-dir.js';
import { parseTemplate, type Template } from '../templates/parse.js';
import { isValidTimezone } from '../timezone.js';
import type { AgentGroup, MessagingGroup, Session as AgentSession } from '../types.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { resolveQuestionRender } from './question-render-registry.js';
import {
  BridgeStore,
  DEFAULT_RELAY_URL,
  INVITE_TTL_MS,
  NOTE_FIELD,
  PairingManager,
  ROOM_ARCHIVE_MAX,
  RoomRouter,
  SYSTEM_CONV,
  WizzleBridge,
  historyMessages,
  inviteText,
  isRelayUrl,
  isRoomConv,
  memberChannel,
  mergeRoomMessages,
  newRoomId,
  parseRoom,
  parseTimestamp,
  roomConv,
  roomHistoryMessages,
  taskEchoOrigins,
  webSocketTransport,
} from './wizzle/index.js';
import type {
  BridgeHooks,
  BridgeHost,
  HostActivity,
  HostAgent,
  HostConversation,
  HostCreateAgent,
  HostDeleted,
  HostHistory,
  HostQuestion,
  HostRoom,
  HostRoomChanges,
  InboundAttachment,
  IssuedInvite,
  MailboxRow,
  RoomInbound,
  RoomMember,
  RoomSessionRows,
} from './wizzle/index.js';
import { nodeCrypto } from './wizzle/protocol/crypto-node.js';
import {
  mentionHandle,
  type QuestionOption,
  type Secret,
  type SecretChanges,
  type SecretInjection,
  type SecretInput,
  type SecretType,
  type Task,
  type TemplateInfo,
} from './wizzle/protocol/index.js';

export const CHANNEL_TYPE = 'wizzle';
export const OWNER_USER_ID = 'wizzle:owner';
const PLATFORM_PREFIX = 'wizzle:agent:';
const CONVERSATION_NAME = 'Wizzle';
const SENDER_NAME = 'Wizzle';
const TOPIC_SLUG_MAX = 40;
const MAX_CONV_CHARS = 200;
const CONTAINER_STOP_MS = 10_000;
const AGENT_STOP_MS = 15_000;
const MAX_AGENT_NAME = 60;
const MAX_FOLDER_CHARS = 63;
const FOLDER_SUFFIX_MAX = 9;
const ONBOARDING_TIMEOUT_S = 1800;
const RESERVED_AGENT_NAMES = new Set(['system']);
const SYSTEM_AGENT_ID = 'system';
const ONECLI_TIMEOUT_MS = 10_000;
const SECRET_TYPES: SecretType[] = ['generic', 'anthropic', 'openai'];
const PROJECT_ROOT = path.dirname(DATA_DIR);
const VERSION_FILE = path.join(PROJECT_ROOT, '.claude', 'skills', 'add-wizzle', 'VERSION');
const UPDATE_LOG = path.join(DATA_DIR, 'wizzle', 'update.log');
const UPDATE_RESULT = path.join(DATA_DIR, 'wizzle', 'update-result.json');
const DEFAULT_INSTALL_URL = 'https://wizzle.app/install.sh';

const WIZZLE_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  // Room channels are wired engage_mode 'mention'; the default and topic wirings stay 'pattern'.
  mentions: 'platform',
};

export function platformIdForAgent(agentGroupId: string): string {
  return `${PLATFORM_PREFIX}${agentGroupId}`;
}

export function topicPlatformId(agentGroupId: string, slug: string): string {
  return `${PLATFORM_PREFIX}${agentGroupId}:${slug}`;
}

// Splits a wizzle conversation id. A slug means a topic; no slug means the agent's default.
export function parseConv(conv: string): { agentGroupId: string; slug?: string } | undefined {
  if (!conv.startsWith(PLATFORM_PREFIX)) return undefined;
  const rest = conv.slice(PLATFORM_PREFIX.length);
  const cut = rest.indexOf(':');
  if (cut < 0) return rest.length > 0 ? { agentGroupId: rest } : undefined;
  const agentGroupId = rest.slice(0, cut);
  const slug = rest.slice(cut + 1);
  if (agentGroupId.length === 0 || slug.length === 0 || slug.includes(':')) return undefined;
  return { agentGroupId, slug };
}

export function isTopicConv(conv: string): boolean {
  return parseConv(conv)?.slug !== undefined;
}

export function slugForTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, TOPIC_SLUG_MAX)
    .replace(/-+$/, '');
}

// Host errors carrying a code reach wizzle as that error code.
function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function folderForAgentName(name: string): string {
  const folder = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 63)
    .replace(/[-_]+$/, '');
  if (!folder) throw new Error('Agent name needs at least one letter or digit');
  return folder;
}

async function hostCommand(command: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await dispatch({ id: `wizzle-${randomUUID()}`, command, args }, { caller: 'host' });
  if (!response.ok) throw new Error(`${command} failed: ${response.error.message}`);
  return response.data;
}

function parseAgentGroup(value: unknown): AgentGroup {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.folder !== 'string') {
    throw new Error('groups-create returned an invalid agent group');
  }
  return {
    id: value.id,
    name: value.name,
    folder: value.folder,
    agent_provider: typeof value.agent_provider === 'string' ? value.agent_provider : null,
    created_at: typeof value.created_at === 'string' ? value.created_at : new Date().toISOString(),
  };
}

function isWizzleGroup(group: MessagingGroup): boolean {
  return group.channel_type === CHANNEL_TYPE && (group.instance ?? group.channel_type) === CHANNEL_TYPE;
}

// Neither a topic nor a room channel is the default, so the setup wiring `wizzle:wizzle` still counts as one.
function isDefaultWizzleGroup(group: MessagingGroup): boolean {
  return isWizzleGroup(group) && !isTopicConv(group.platform_id) && parseRoom(group.platform_id) === undefined;
}

// The agent's conversation is whatever wizzle messaging group is wired to it, created on demand.
async function ensureConversation(agent: AgentGroup): Promise<string> {
  const wired = (await getMessagingGroupsByAgentGroup(agent.id)).find(isDefaultWizzleGroup);
  if (wired) return wired.platform_id;
  const platformId = platformIdForAgent(agent.id);
  await hostCommand('messaging-groups-create', {
    channel_type: CHANNEL_TYPE,
    instance: CHANNEL_TYPE,
    platform_id: platformId,
    name: CONVERSATION_NAME,
    is_group: 0,
  });
  await hostCommand('wirings-create', {
    channel_type: CHANNEL_TYPE,
    instance: CHANNEL_TYPE,
    platform_id: platformId,
    agent_group_id: agent.id,
  });
  return platformId;
}

export async function ensureWizzleConversations(): Promise<void> {
  for (const agent of await getAllAgentGroups()) {
    try {
      await ensureConversation(agent);
    } catch (err) {
      log.warn('wizzle: could not wire agent to the wizzle conversation', { agent: agent.id, err });
    }
  }
}

export type ConversationTarget = { agentGroupId: string; session: AgentSession | undefined };

export async function targetFor(conv: string): Promise<ConversationTarget | undefined> {
  const group = await getMessagingGroupByPlatform(CHANNEL_TYPE, conv, CHANNEL_TYPE);
  if (!group) return undefined;
  const wiring = (await getMessagingGroupAgents(group.id))[0];
  if (!wiring) return undefined;
  return { agentGroupId: wiring.agent_group_id, session: await findSessionForAgent(wiring.agent_group_id, group.id, null) };
}

async function sessionFor(agentGroupId: string, conv: string): Promise<AgentSession | undefined> {
  const group = await getMessagingGroupByPlatform(CHANNEL_TYPE, conv, CHANNEL_TYPE);
  return group ? findSessionForAgent(agentGroupId, group.id, null) : undefined;
}

// A task's delivery lives in its own session's outbox; the echo in the conversation keeps only the first 500 characters.
async function taskDeliveries(agentGroupId: string, ids: string[], limit: number): Promise<Map<string, MailboxRow>> {
  const wanted = new Set(ids);
  const found = new Map<string, MailboxRow>();
  if (wanted.size === 0) return found;
  for (const session of await findTaskSessions(agentGroupId, true)) {
    const rows = await withExistingMailboxSession(agentGroupId, session.id, (mailbox) => mailbox.getOutboundHistory(limit));
    for (const row of rows ?? []) if (wanted.has(row.id)) found.set(row.id, row);
    if (found.size === wanted.size) break;
  }
  return found;
}

function toQuestionOptions(options: Array<{ label: string; value: string; style?: string }>): QuestionOption[] {
  return options.map((option) => ({
    label: option.label,
    value: option.value,
    ...(option.style === 'primary' || option.style === 'danger' || option.style === 'default' ? { style: option.style } : {}),
  }));
}

// Nothing cascades in the schema, so a topic's rows come off in FK order.
async function clearPendingForSession(sessionId: string): Promise<string[]> {
  const db = getDb();
  const ids: string[] = [];
  const questions = await db.all<{ question_id: string }>('SELECT question_id FROM pending_questions WHERE session_id = ?', sessionId);
  for (const row of questions) {
    ids.push(row.question_id);
    await deletePendingQuestion(row.question_id);
  }
  if (await hasTable(db, 'pending_approvals')) {
    const approvals = await db.all<{ approval_id: string }>('SELECT approval_id FROM pending_approvals WHERE session_id = ?', sessionId);
    for (const row of approvals) {
      ids.push(row.approval_id);
      await deletePendingApproval(row.approval_id);
    }
  }
  return ids;
}

// killContainer never fires onExit when nothing is running, so the caller checks first.
function stopContainer(sessionId: string, reason = 'wizzle topic deleted', ms = CONTAINER_STOP_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    killContainer(sessionId, reason, () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// Stops the container, then takes the session's pending rows, mailbox, files and row; the wiring is the caller's.
async function dropSession(agentGroupId: string, session: AgentSession, busy: string, reason: string): Promise<string[]> {
  if (isContainerRunning(session.id) && !(await stopContainer(session.id, reason))) throw coded('busy', busy);
  const questionIds = await clearPendingForSession(session.id);
  await destroySessionMailbox(agentGroupId, session.id);
  const dir = sessionDir(agentGroupId, session.id);
  // Docker's mount points here are root's and stay; everything else is the chat's.
  for (const name of fs.readdirSync(dir)) {
    const entry = path.join(dir, name);
    if (fs.lstatSync(entry).uid === process.getuid!()) fs.rmSync(entry, { recursive: true, force: true });
  }
  await deleteSession(session.id);
  return questionIds;
}

// wirings-create writes a companion agent_destinations row; wirings-delete does not remove it.
async function removeCompanionDestination(agentGroupId: string, messagingGroupId: string): Promise<void> {
  if (!(await hasTable(getDb(), 'agent_destinations'))) return;
  const rows = await hostCommand('destinations-list', { agent_group_id: agentGroupId });
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (!isRecord(row) || row.target_type !== 'channel' || row.target_id !== messagingGroupId) continue;
    if (typeof row.local_name !== 'string') continue;
    await hostCommand('destinations-remove', { agent_group_id: agentGroupId, local_name: row.local_name });
  }
}

async function wizzleGroupsFor(agentGroupId: string): Promise<MessagingGroup[]> {
  return (await getMessagingGroupsByAgentGroup(agentGroupId)).filter(isWizzleGroup);
}

function sameTitle(a: string | null, b: string): boolean {
  return (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();
}

async function toHostConversation(agent: AgentGroup, group: MessagingGroup): Promise<HostConversation> {
  const topic = isTopicConv(group.platform_id);
  const session = await findSessionForAgent(agent.id, group.id, null);
  const lastAt = parseTimestamp(session?.last_active);
  const createdAt = parseTimestamp(group.created_at);
  return {
    conv: group.platform_id,
    agentId: agent.id,
    title: topic ? (group.name ?? group.platform_id) : agent.name,
    topic,
    ...(lastAt !== undefined && { lastAt }),
    ...(createdAt !== undefined && { createdAt }),
  };
}

// A room is its members' wired channels, in the order they joined; the first channel's name is its title.
type RoomSeat = { agent: AgentGroup; group: MessagingGroup };

async function roomSeats(roomId?: string): Promise<Map<string, RoomSeat[]>> {
  const rooms = new Map<string, RoomSeat[]>();
  for (const group of await getMessagingGroupsByChannel(CHANNEL_TYPE)) {
    const parsed = isWizzleGroup(group) ? parseRoom(group.platform_id) : undefined;
    const agentGroupId = parsed?.agentGroupId;
    if (!parsed || agentGroupId === undefined || (roomId !== undefined && parsed.roomId !== roomId)) continue;
    const wired = (await getMessagingGroupAgents(group.id)).some((wiring) => wiring.agent_group_id === agentGroupId);
    const agent = wired ? await getAgentGroup(agentGroupId) : undefined;
    if (!agent) continue;
    const seats = rooms.get(parsed.roomId) ?? [];
    seats.push({ agent, group });
    rooms.set(parsed.roomId, seats);
  }
  for (const seats of rooms.values()) {
    seats.sort((a, b) => a.group.created_at.localeCompare(b.group.created_at) || a.agent.id.localeCompare(b.agent.id));
  }
  return rooms;
}

async function seatsOf(conv: string): Promise<{ roomId: string; seats: RoomSeat[] }> {
  const parsed = parseRoom(conv);
  if (!parsed || parsed.agentGroupId !== undefined) throw coded('unknown_conv', 'No such room');
  const seats = (await roomSeats(parsed.roomId)).get(parsed.roomId) ?? [];
  if (seats.length === 0) throw coded('unknown_conv', 'No such room');
  return { roomId: parsed.roomId, seats };
}

async function toHostRoom(roomId: string, seats: RoomSeat[]): Promise<HostRoom> {
  let lastAt: number | undefined;
  for (const { agent, group } of seats) {
    const at = parseTimestamp((await findSessionForAgent(agent.id, group.id, null))?.last_active);
    if (at !== undefined && (lastAt === undefined || at > lastAt)) lastAt = at;
  }
  const createdAt = parseTimestamp(seats[0]?.group.created_at);
  return {
    conv: roomConv(roomId),
    title: seats[0]?.group.name ?? 'Room',
    members: seats.map((seat) => seat.agent.id),
    ...(lastAt !== undefined && { lastAt }),
    ...(createdAt !== undefined && { createdAt }),
  };
}

export async function listRooms(): Promise<HostRoom[]> {
  const out: HostRoom[] = [];
  for (const [roomId, seats] of await roomSeats()) out.push(await toHostRoom(roomId, seats));
  return out.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
}

export async function roomMembers(conv: string): Promise<RoomMember[]> {
  const parsed = parseRoom(conv);
  if (!parsed || parsed.agentGroupId !== undefined) return [];
  const seats = (await roomSeats(parsed.roomId)).get(parsed.roomId) ?? [];
  return seats.map(({ agent, group }) => ({ agentGroupId: agent.id, name: agent.name, channel: group.platform_id }));
}

async function roomAgents(ids: string[]): Promise<AgentGroup[]> {
  const agents: AgentGroup[] = [];
  for (const id of ids) {
    if (id === SYSTEM_AGENT_ID) throw coded('bad_request', 'System cannot join a room');
    const agent = await getAgentGroup(id);
    if (!agent) throw coded('unknown_agent', 'No such agent');
    agents.push(agent);
  }
  return agents;
}

// Wired 'mention', a member wakes only when named; 'accumulate' keeps the rest it is sent as context.
async function seatAgent(roomId: string, agent: AgentGroup, title: string): Promise<void> {
  const platformId = memberChannel(roomId, agent.id);
  await hostCommand('messaging-groups-create', {
    channel_type: CHANNEL_TYPE,
    instance: CHANNEL_TYPE,
    platform_id: platformId,
    name: title,
    is_group: 1,
  });
  await hostCommand('wirings-create', {
    channel_type: CHANNEL_TYPE,
    instance: CHANNEL_TYPE,
    platform_id: platformId,
    agent_group_id: agent.id,
    engage_mode: 'mention',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
  });
}

// The same steps as deleting a topic, for one member's channel.
async function unseat(roomId: string, agent: AgentGroup): Promise<string[]> {
  const group = await getMessagingGroupByPlatform(CHANNEL_TYPE, memberChannel(roomId, agent.id), CHANNEL_TYPE);
  if (!group) return [];
  const session = await findSessionForAgent(agent.id, group.id, null);
  const busy = `${agent.name} is still working in this room, try again in a moment`;
  const questionIds = session ? await dropSession(agent.id, session, busy, 'wizzle room member removed') : [];
  await removeCompanionDestination(agent.id, group.id);
  for (const wiring of await getMessagingGroupAgents(group.id)) await hostCommand('wirings-delete', { id: wiring.id });
  await hostCommand('messaging-groups-delete', { id: group.id });
  return questionIds;
}

async function seatRows(seat: RoomSeat, limit: number): Promise<RoomSessionRows | undefined> {
  const session = await findSessionForAgent(seat.agent.id, seat.group.id, null);
  if (!session) return undefined;
  const rows = await withExistingMailboxSession(seat.agent.id, session.id, (mailbox) => ({
    inbound: mailbox.getInboundHistory(limit),
    outbound: mailbox.getOutboundHistory(limit),
  }));
  if (!rows) return undefined;
  const delivered = await taskDeliveries(seat.agent.id, taskEchoOrigins(rows.inbound), limit);
  return { agentGroupId: seat.agent.id, inbound: rows.inbound, outbound: rows.outbound, delivered };
}

// A member leaving takes its session, so what it saw is kept and the room's history still shows it.
async function archiveSeat(store: BridgeStore, roomId: string, seat: RoomSeat): Promise<void> {
  const rows = await seatRows(seat, ROOM_ARCHIVE_MAX);
  if (!rows) return;
  const seen = roomHistoryMessages(roomConv(roomId), [rows], [], ROOM_ARCHIVE_MAX);
  store.saveRoomArchive(roomId, mergeRoomMessages([store.loadRoomArchive(roomId), seen], ROOM_ARCHIVE_MAX));
}

function roomNote(title: string, seats: RoomSeat[], self: string): string {
  const names = seats.map(({ agent }) => {
    const handle = mentionHandle(agent.name);
    const label = handle === agent.name ? `@${handle}` : `@${handle} (${agent.name})`;
    return agent.id === self ? `${label}, that is you` : label;
  });
  return [
    `This is the wizzle room "${title}". Members: ${names.join('; ')}. The owner writes here as ${SENDER_NAME}.`,
    'You wake only when a message names you with @ or says @all; everything else said here reaches you as context. Follow the wizzle-rooms skill.',
  ].join('\n');
}

// Written as context only, so it never wakes anyone; history leaves it out.
async function writeRoomNotes(roomId: string): Promise<void> {
  const seats = (await roomSeats(roomId)).get(roomId) ?? [];
  const title = seats[0]?.group.name ?? 'Room';
  for (const seat of seats) {
    try {
      const { session } = await resolveSession(seat.agent.id, seat.group.id, null, 'shared');
      await writeSessionMessage(seat.agent.id, session.id, {
        id: `wizzle-room-note-${randomUUID()}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: seat.group.platform_id,
        channelType: CHANNEL_TYPE,
        threadId: null,
        content: JSON.stringify({ text: roomNote(title, seats, seat.agent.id), sender: 'system', senderId: 'system', [NOTE_FIELD]: 'members' }),
        trigger: false,
      });
    } catch (err) {
      log.warn('wizzle: could not write the room note', { room: roomId, agent: seat.agent.id, err });
    }
  }
}

export async function createRoom(title: string, ids: string[]): Promise<HostRoom> {
  const agents = await roomAgents(ids);
  const roomId = newRoomId();
  let seated = 0;
  try {
    for (const agent of agents) {
      await seatAgent(roomId, agent, title);
      seated += 1;
    }
  } catch (err) {
    // The member that failed may have its channel without a wiring, so it is taken down as well.
    for (const agent of agents.slice(0, seated + 1)) {
      await unseat(roomId, agent).catch((undo: unknown) => log.warn('wizzle: could not undo a room member', { room: roomId, agent: agent.id, err: undo }));
    }
    throw coded('create_failed', err instanceof Error ? err.message : 'The room was not created');
  }
  await writeRoomNotes(roomId);
  return toHostRoom(roomId, (await roomSeats(roomId)).get(roomId) ?? []);
}

async function updateRoom(store: BridgeStore, conv: string, changes: HostRoomChanges): Promise<HostRoom> {
  const { roomId, seats } = await seatsOf(conv);
  const title = changes.title ?? seats[0]?.group.name ?? 'Room';
  if (changes.title !== undefined) {
    for (const seat of seats) await hostCommand('messaging-groups-update', { id: seat.group.id, name: changes.title });
  }
  const members = changes.members;
  if (members !== undefined) {
    const wanted = await roomAgents(members);
    for (const seat of seats) {
      if (members.includes(seat.agent.id)) continue;
      await archiveSeat(store, roomId, seat);
      await unseat(roomId, seat.agent);
    }
    for (const agent of wanted) if (!seats.some((seat) => seat.agent.id === agent.id)) await seatAgent(roomId, agent, title);
  }
  await writeRoomNotes(roomId);
  return toHostRoom(roomId, (await roomSeats(roomId)).get(roomId) ?? []);
}

async function deleteRoom(rooms: RoomDeps, conv: string): Promise<HostDeleted> {
  const { roomId, seats } = await seatsOf(conv);
  const questionIds: string[] = [];
  for (const seat of seats) questionIds.push(...(await unseat(roomId, seat.agent)));
  rooms.store.dropRoomArchive(roomId);
  rooms.router.forget(conv);
  return { questionIds };
}

// Every member's room session goes, then fresh notes, so the next message finds the members listed again.
async function clearRoom(rooms: RoomDeps, conv: string): Promise<HostDeleted> {
  const { roomId, seats } = await seatsOf(conv);
  const live: Array<{ seat: RoomSeat; session: AgentSession }> = [];
  for (const seat of seats) {
    const session = await findSessionForAgent(seat.agent.id, seat.group.id, null);
    if (session) live.push({ seat, session });
  }
  let tasks = 0;
  for (const { seat, session } of live) {
    tasks += (await withExistingMailboxSession(seat.agent.id, session.id, (mailbox) => mailbox.listLiveTasks().length)) ?? 0;
  }
  if (tasks > 0) {
    const one = tasks === 1;
    throw coded('has_tasks', `This room holds ${tasks} scheduled ${one ? 'task' : 'tasks'}; cancel ${one ? 'it' : 'them'} before clearing.`);
  }
  const questionIds: string[] = [];
  for (const { seat, session } of live) {
    const busy = `${seat.agent.name} is still working in this room, try again in a moment`;
    questionIds.push(...(await dropSession(seat.agent.id, session, busy, 'wizzle room cleared')));
  }
  rooms.store.dropRoomArchive(roomId);
  rooms.router.forget(conv);
  await writeRoomNotes(roomId);
  return { questionIds };
}

async function roomHistory(store: BridgeStore, conv: string, limit: number): Promise<HostHistory> {
  const parsed = parseRoom(conv);
  if (!parsed) return { messages: [], hasMore: false };
  const sessions: RoomSessionRows[] = [];
  let full = false;
  for (const seat of (await roomSeats(parsed.roomId)).get(parsed.roomId) ?? []) {
    const rows = await seatRows(seat, limit);
    if (!rows) continue;
    sessions.push(rows);
    if (rows.inbound.length >= limit || rows.outbound.length >= limit) full = true;
  }
  const messages = roomHistoryMessages(conv, sessions, store.loadRoomArchive(parsed.roomId), ROOM_ARCHIVE_MAX);
  return { messages: messages.slice(-limit), hasMore: full || messages.length > limit };
}

async function sessionActivity(agentGroupId: string, session: AgentSession | undefined): Promise<HostActivity> {
  if (!session) return { running: false };
  const state = await withExistingMailboxSession(agentGroupId, session.id, (mailbox) => mailbox.getContainerState());
  const toolStartedAt = parseTimestamp(state?.toolStartedAt);
  return {
    running: session.container_status === 'running',
    ...(state?.currentTool && { tool: state.currentTool }),
    ...(toolStartedAt !== undefined && { toolStartedAt }),
    ...(state?.toolDeclaredTimeoutMs && { timeoutMs: state.toolDeclaredTimeoutMs }),
  };
}

async function roomActivity(conv: string, speaker: string | undefined): Promise<HostActivity> {
  const parsed = parseRoom(conv);
  if (!parsed || speaker === undefined) return { running: false };
  const group = await getMessagingGroupByPlatform(CHANNEL_TYPE, memberChannel(parsed.roomId, speaker), CHANNEL_TYPE);
  return sessionActivity(speaker, group ? await findSessionForAgent(speaker, group.id, null) : undefined);
}

// Two taps on Create must not race for the same folder or display name.
let createChain: Promise<unknown> = Promise.resolve();

function serializeCreate<T>(run: () => Promise<T>): Promise<T> {
  const next = createChain.then(run, run);
  createChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function trimFolder(base: string, max: number): string {
  return base.slice(0, max).replace(/[-_]+$/, '');
}

// Suffixes the folder rather than touching whatever already holds the name.
async function freeFolder(base: string): Promise<string> {
  for (let suffix = 1; suffix <= FOLDER_SUFFIX_MAX; suffix += 1) {
    const folder = suffix === 1 ? base : `${trimFolder(base, MAX_FOLDER_CHARS - 2)}-${suffix}`;
    if (await getAgentGroupByFolder(folder)) continue;
    if (groupFolderExistsOnDisk(folder)) continue;
    return folder;
  }
  throw coded('create_failed', `Folders "${base}" through "${base}-${FOLDER_SUFFIX_MAX}" are all taken`);
}

async function assertNameFree(name: string): Promise<void> {
  if (name.length === 0) throw coded('bad_request', 'An agent needs a name');
  if (name.length > MAX_AGENT_NAME) throw coded('bad_request', `An agent name is at most ${MAX_AGENT_NAME} characters`);
  if (RESERVED_AGENT_NAMES.has(name.toLowerCase())) throw coded('bad_request', `"${name}" is reserved for host notices`);
  const taken = (await getAllAgentGroups()).some((group) => group.name.trim().toLowerCase() === name.toLowerCase());
  if (taken) throw coded('name_taken', `An agent is already called "${name}"`);
}

function readManifest(dir: string): PluginManifest | null {
  try {
    return parsePluginManifest(JSON.parse(fs.readFileSync(path.join(dir, PLUGIN_MANIFEST_FILE), 'utf8')));
  } catch {
    return null;
  }
}

function toTemplateInfo(ref: string, template: Template, manifest: PluginManifest | null): TemplateInfo {
  return {
    ref,
    name: template.name,
    ...(template.agentName && { agentName: template.agentName }),
    ...(manifest?.description && { description: manifest.description }),
    ...(manifest?.version && { version: manifest.version }),
    tasks: template.tasks.length,
    mcpServers: Object.keys(template.mcpServers).length,
    skills: template.skills.length,
  };
}

// The installed templates, then the public library's. Library copies land in templates/<category>/<name>.
export async function listTemplates(): Promise<TemplateInfo[]> {
  return [...installedTemplates(), ...(await libraryTemplates())];
}

// A missing templates directory is an install without templates, not a failure.
function installedTemplates(): TemplateInfo[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(TEMPLATES_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: TemplateInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(TEMPLATES_DIR, entry.name);
    if (!fs.existsSync(path.join(dir, PLUGIN_MANIFEST_FILE))) continue;
    try {
      out.push(toTemplateInfo(entry.name, parseTemplate(dir), readManifest(dir)));
    } catch (err) {
      log.warn('wizzle: template skipped, it does not parse', { ref: entry.name, err });
    }
  }
  return out;
}

// templates-list caches the index for five minutes; a library it cannot reach lists nothing.
async function libraryTemplates(): Promise<TemplateInfo[]> {
  let rows: unknown;
  try {
    rows = await hostCommand('templates-list', { registry: true });
  } catch (err) {
    log.warn('wizzle: the template library could not be listed', { err });
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const out: TemplateInfo[] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.ref !== 'string' || typeof row.name !== 'string') continue;
    // The library files every template as <category>/<template>.
    const cut = row.ref.indexOf('/');
    if (cut < 1) continue;
    const library = { category: row.ref.slice(0, cut), downloaded: row.local === true };
    const description = typeof row.description === 'string' && row.description.length > 0 ? row.description : undefined;
    out.push({ ...(downloadedTemplate(row.ref) ?? { ref: row.ref, name: row.name, ...(description && { description }) }), ...library });
  }
  return out;
}

function downloadedTemplate(ref: string): TemplateInfo | undefined {
  const dir = path.join(TEMPLATES_DIR, ref);
  if (!fs.existsSync(path.join(dir, PLUGIN_MANIFEST_FILE))) return undefined;
  try {
    return toTemplateInfo(ref, parseTemplate(dir), readManifest(dir));
  } catch (err) {
    log.warn('wizzle: downloaded template skipped, it does not parse', { ref, err });
    return undefined;
  }
}

// A library template is fetched before anything is created, so a failed download leaves nothing behind.
async function fetchTemplate(ref: string): Promise<void> {
  try {
    await ensureTemplateLocal(ref);
  } catch (err) {
    throw coded('unknown_template', err instanceof Error ? err.message : `No template called "${ref}"`);
  }
}

function loadTemplate(ref: string): Template {
  try {
    return parseTemplate(resolveLocalTemplate(ref));
  } catch (err) {
    throw coded('unknown_template', err instanceof Error ? err.message : `No template called "${ref}"`);
  }
}

// Everything a copy carries except packages, which need an image rebuild.
async function copyConfig(sourceId: string, targetId: string, timezone: string | undefined): Promise<string[]> {
  const row = await getContainerConfig(sourceId);
  if (!row) return [];
  const args: Record<string, unknown> = { id: targetId };
  const scalars: Array<[string, unknown]> = [
    ['provider', row.provider],
    ['model', row.model],
    ['effort', row.effort],
    ['speed', row.speed],
    ['assistant_name', row.assistant_name],
    ['max_messages_per_prompt', row.max_messages_per_prompt],
    ['cli_scope', row.cli_scope],
  ];
  for (const [key, value] of scalars) if (value !== null && value !== undefined) args[key] = value;
  if (timezone === undefined && row.timezone) args.timezone = row.timezone;
  if (Object.keys(args).length > 1) {
    try {
      await hostCommand('groups-config-update', args);
    } catch (err) {
      log.warn('wizzle: could not copy the container config to the new agent', { source: sourceId, err });
    }
  }
  const servers = parseJsonRecord(row.mcp_servers);
  for (const [name, config] of Object.entries(servers)) {
    if (!isRecord(config)) continue;
    try {
      await hostCommand('groups-config-add-mcp-server', {
        id: targetId,
        name,
        ...(typeof config.command === 'string' && { command: config.command }),
        ...(typeof config.url === 'string' && { url: config.url }),
        ...(Array.isArray(config.args) && { args: JSON.stringify(config.args) }),
        ...(isRecord(config.env) && { env: JSON.stringify(config.env) }),
        ...(isRecord(config.headers) && { headers: JSON.stringify(config.headers) }),
      });
    } catch (err) {
      log.warn('wizzle: could not copy an MCP server to the new agent', { server: name, err });
    }
  }
  return [...parseJsonList(row.packages_apt), ...parseJsonList(row.packages_npm)];
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonList(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((one): one is string => typeof one === 'string') : [];
  } catch {
    return [];
  }
}

// stageGroupPersona refuses to overwrite, so a template's own persona always wins.
function seedPersona(folder: string, text: string): void {
  try {
    stageGroupPersona(resolveGroupFolderPath(folder), text);
  } catch (err) {
    log.warn('wizzle: could not write the new agent persona', { folder, err });
  }
}

function readPersona(folder: string): string | null {
  try {
    return readGroupPersona(resolveGroupFolderPath(folder));
  } catch {
    return null;
  }
}

// Keys go straight to OneCLI, so only an install whose gateway is OneCLI offers them.
function usesOneCli(): boolean {
  try {
    return configuredGatewayProviderKind() === 'onecli';
  } catch {
    return false;
  }
}

// OneCLI's REST API, at the address and key NanoClaw's own OneCLI gateway uses.
async function onecli(method: string, route: string, body?: unknown): Promise<unknown> {
  const base = (envValue('ONECLI_URL') || 'https://api.onecli.sh').replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  const apiKey = envValue('ONECLI_API_KEY');
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (process.env.ONECLI_PROJECT_ID) headers['X-Project-Id'] = process.env.ONECLI_PROJECT_ID;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${base}${route}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(ONECLI_TIMEOUT_MS),
    });
  } catch (err) {
    throw Object.assign(coded('keys_unavailable', 'OneCLI could not be reached'), { cause: err });
  }
  const parsed: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (res.ok) return parsed;
  // A refused body answers { error: text }, any other failure { error: { message } }.
  const error = isRecord(parsed) ? parsed.error : undefined;
  const message =
    typeof error === 'string' ? error : isRecord(error) && typeof error.message === 'string' ? error.message : `OneCLI answered ${res.status}`;
  const code = res.status === 404 ? 'not_found' : res.status < 500 ? 'bad_request' : 'keys_failed';
  throw Object.assign(coded(code, message), { status: res.status });
}

function onecliRows(body: unknown): unknown[] {
  const rows = Array.isArray(body) ? body : isRecord(body) ? body.data : undefined;
  if (!Array.isArray(rows)) throw coded('keys_failed', 'OneCLI did not answer with a list');
  return rows;
}

function toInjection(raw: unknown): SecretInjection | undefined {
  if (!isRecord(raw)) return undefined;
  const text = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : undefined);
  const headerName = text('headerName');
  if (headerName) return { headerName, ...(text('valueFormat') && { valueFormat: text('valueFormat') }) };
  const paramName = text('paramName');
  if (paramName) return { paramName, ...(text('paramFormat') && { paramFormat: text('paramFormat') }) };
  const pathTemplate = text('pathTemplate');
  if (pathTemplate) return { pathTemplate };
  const pathRegex = text('pathRegex');
  const pathReplacement = text('pathReplacement');
  if (pathRegex && pathReplacement) return { pathRegex, pathReplacement };
  return undefined;
}

// A tasks-list row: the series id doubles as the name, and a task without a cron expression runs once.
function toTask(row: unknown): Task | undefined {
  if (!isRecord(row) || typeof row.series_id !== 'string' || typeof row.agent_group_id !== 'string') return undefined;
  const lastRunAt = parseTimestamp(typeof row.last_run === 'string' ? row.last_run : undefined);
  const nextRunAt = parseTimestamp(typeof row.next_run === 'string' ? row.next_run : undefined);
  return {
    id: row.series_id,
    agentId: row.agent_group_id,
    name: row.series_id,
    schedule: typeof row.recurrence === 'string' && row.recurrence.length > 0 ? row.recurrence : 'once',
    enabled: row.status === 'pending',
    ...(typeof row.prompt === 'string' && { prompt: row.prompt }),
    ...(typeof row.runs === 'number' && { runs: row.runs }),
    ...(typeof row.failed_runs === 'number' && { failedRuns: row.failed_runs }),
    ...(lastRunAt !== undefined && { lastRunAt }),
    ...(nextRunAt !== undefined && { nextRunAt }),
  };
}

// Without a group, tasks-list reads every active session, so tasks scheduled from a chat before ncl tasks list too.
export async function listTasks(): Promise<Task[]> {
  const rows = await hostCommand('tasks-list', {});
  return (Array.isArray(rows) ? rows : []).map(toTask).filter((task): task is Task => task !== undefined);
}

// The host finds the series by id across sessions; an unknown id is its "no live task matched" error.
export async function runTask(taskId: string): Promise<void> {
  await hostCommand('tasks-run', { id: taskId });
}

export async function pauseTask(taskId: string): Promise<void> {
  await hostCommand('tasks-pause', { id: taskId });
}

export async function resumeTask(taskId: string): Promise<void> {
  await hostCommand('tasks-resume', { id: taskId });
}

// Only what wizzle shows; OneCLI never lists a value.
function toSecret(row: unknown): Secret | undefined {
  if (!isRecord(row) || typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.hostPattern !== 'string') return undefined;
  const type = SECRET_TYPES.find((one) => one === row.type);
  if (!type) return undefined;
  const injection = toInjection(row.injectionConfig);
  const createdAt = parseTimestamp(typeof row.createdAt === 'string' ? row.createdAt : undefined);
  return {
    id: row.id,
    name: row.name,
    type,
    host: row.hostPattern,
    ...(typeof row.pathPattern === 'string' && row.pathPattern.length > 0 && { path: row.pathPattern }),
    ...(injection && { injection }),
    ...(createdAt !== undefined && { createdAt }),
  };
}

export async function listSecrets(): Promise<Secret[]> {
  return onecliRows(await onecli('GET', '/v1/secrets'))
    .map(toSecret)
    .filter((secret): secret is Secret => secret !== undefined);
}

async function savedSecret(secretId: string): Promise<Secret> {
  const secret = (await listSecrets()).find((one) => one.id === secretId);
  if (!secret) throw coded('keys_failed', 'OneCLI saved the key but does not list it');
  return secret;
}

async function createSecret(input: SecretInput): Promise<Secret> {
  const created = await onecli('POST', '/v1/secrets', {
    name: input.name,
    type: input.type,
    value: input.value,
    hostPattern: input.host,
    ...(input.path !== undefined && { pathPattern: input.path }),
    ...(input.injection !== undefined && { injectionConfig: input.injection }),
  });
  if (!isRecord(created) || typeof created.id !== 'string') throw coded('keys_failed', 'OneCLI did not return the new key');
  return savedSecret(created.id);
}

async function updateSecret(secretId: string, changes: SecretChanges): Promise<Secret> {
  await onecli('PATCH', `/v1/secrets/${encodeURIComponent(secretId)}`, {
    ...(changes.name !== undefined && { name: changes.name }),
    ...(changes.host !== undefined && { hostPattern: changes.host }),
    ...(changes.path !== undefined && { pathPattern: changes.path }),
    ...(changes.injection !== undefined && { injectionConfig: changes.injection }),
    ...(changes.value !== undefined && { value: changes.value }),
  });
  return savedSecret(secretId);
}

async function keyGroup(agentId: string): Promise<AgentGroup> {
  if (agentId === SYSTEM_AGENT_ID) throw coded('bad_request', 'The System agent has no keys');
  const group = await getAgentGroup(agentId);
  if (!group) throw coded('unknown_agent', 'No such agent');
  return group;
}

// A group's OneCLI agent has the group id as its identifier and is made on its first spawn, or here.
async function findOnecliAgent(group: AgentGroup): Promise<string | undefined> {
  const agent = onecliRows(await onecli('GET', '/v1/agents')).find((one) => isRecord(one) && one.identifier === group.id);
  return isRecord(agent) && typeof agent.id === 'string' ? agent.id : undefined;
}

async function ensureOnecliAgent(group: AgentGroup): Promise<string> {
  const found = await findOnecliAgent(group);
  if (found) return found;
  try {
    await onecli('POST', '/v1/agents', { name: group.name, identifier: group.id });
  } catch (err) {
    // 409 is a spawn that made it first.
    if (!(isRecord(err) && err.status === 409)) throw err;
  }
  const made = await findOnecliAgent(group);
  if (!made) throw coded('keys_failed', `OneCLI has no agent for ${group.name}`);
  return made;
}

function grantPath(onecliAgentId: string, secretId: string): string {
  return `/v1/agents/${encodeURIComponent(onecliAgentId)}/grants/secrets/${encodeURIComponent(secretId)}`;
}

async function listAgentSecrets(agentId: string): Promise<string[]> {
  const agent = await findOnecliAgent(await keyGroup(agentId));
  if (!agent) return [];
  const grants = await onecli('GET', `/v1/agents/${encodeURIComponent(agent)}/grants`);
  const secrets = isRecord(grants) && Array.isArray(grants.secrets) ? grants.secrets : [];
  return secrets.flatMap((grant) => (isRecord(grant) && typeof grant.secretId === 'string' ? [grant.secretId] : []));
}

async function attachSecret(agentId: string, secretId: string): Promise<void> {
  await onecli('PUT', grantPath(await ensureOnecliAgent(await keyGroup(agentId)), secretId));
}

async function detachSecret(agentId: string, secretId: string): Promise<void> {
  const agent = await findOnecliAgent(await keyGroup(agentId));
  if (agent) await onecli('DELETE', grantPath(agent, secretId));
}

async function deleteSecret(secretId: string): Promise<void> {
  await onecli('DELETE', `/v1/secrets/${encodeURIComponent(secretId)}`);
}

// Names by id, or null when OneCLI cannot be reached and the create goes ahead without checking.
async function vaultNames(): Promise<Map<string, string> | null> {
  try {
    return new Map((await listSecrets()).map((secret) => [secret.id, secret.name]));
  } catch (err) {
    log.warn('wizzle: the vault could not be read before creating an agent', { err });
    return null;
  }
}

// Answers the ids that did not attach; the agent exists either way.
async function attachKeys(group: AgentGroup, secretIds: string[]): Promise<string[]> {
  let agent: string;
  try {
    agent = await ensureOnecliAgent(group);
  } catch (err) {
    log.warn('wizzle: the new agent has no OneCLI agent to attach keys to', { agent: group.id, err });
    return secretIds;
  }
  const failed: string[] = [];
  for (const secretId of secretIds) {
    try {
      await onecli('PUT', grantPath(agent, secretId));
    } catch (err) {
      log.warn('wizzle: a key did not attach to the new agent', { agent: group.id, secretId, err });
      failed.push(secretId);
    }
  }
  return failed;
}

function onboardingText(name: string, purpose: string, pausedTasks: string[]): string {
  const lines = [
    `You are ${name}. You were created from the owner's wizzle app a moment ago and this is your first turn.`,
    'The owner wrote this purpose for you:',
    '',
    purpose,
    '',
    'Set yourself up now, in this order.',
    '',
    `1. Ask at most three questions with ask_user_question, one at a time, waiting for each answer before you ask the next. Pass timeout: ${ONBOARDING_TIMEOUT_S}. If one times out, choose a sensible default, carry on, and say which default you chose.`,
    '2. Write what you learned into instructions.prepend.md in your workspace. That file is your standing persona and is read on every spawn.',
    '3. Put anything you must never forget into memory/.',
    '4. If the purpose needs a package or an MCP server, request it through the self-customize skill and carry on without waiting for the approval.',
    '5. Create the recurring tasks the purpose implies.',
    '6. Finish with exactly one message to the owner saying what you are and what you will do next.',
  ];
  if (pausedTasks.length > 0) {
    lines.push(
      '',
      `Your template already created these tasks, paused: ${pausedTasks.join(', ')}. Enable the ones the purpose needs and leave the rest alone.`,
    );
  }
  return lines.join('\n');
}

// The host writes straight into the mailbox, so no sender policy applies to it.
async function startOnboarding(group: AgentGroup, conv: string, text: string, reason: WakeReason = 'agent-created'): Promise<void> {
  const messagingGroup = await getMessagingGroupByPlatform(CHANNEL_TYPE, conv, CHANNEL_TYPE);
  if (!messagingGroup) throw new Error(`no messaging group for ${conv}`);
  const wiring = (await getMessagingGroupAgents(messagingGroup.id))[0];
  const { session } = await resolveSession(group.id, messagingGroup.id, null, wiring?.session_mode ?? 'shared');
  await writeSessionMessage(group.id, session.id, {
    id: `wizzle-onboard-${randomUUID()}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: conv,
    channelType: CHANNEL_TYPE,
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = await getSession(session.id);
  if (fresh) await requestWake(fresh, reason);
}

function settingUpText(name: string, skippedPackages: string[]): string {
  const first = `Setting up. ${name} is reading your purpose and will ask a few questions.`;
  if (skippedPackages.length === 0) return first;
  return `${first} Packages were not copied (${skippedPackages.join(', ')}); ask ${name} to install the ones it needs.`;
}

type Notify = (conv: string, text: string) => void;

// What rooms need beyond the host DB: the archive of members that left, and the router fanning messages out.
export type RoomDeps = { store: BridgeStore; router: RoomRouter };

export async function createAgent(request: HostCreateAgent, notify: Notify): Promise<HostAgent> {
  const name = request.name.trim();
  await assertNameFree(name);
  const purpose = request.purpose?.trim();
  const timezone = request.timezone?.trim() || undefined;
  if (timezone && !isValidTimezone(timezone)) throw coded('bad_request', `${timezone} is not an IANA timezone id`);
  if (request.copyFrom === SYSTEM_AGENT_ID) throw coded('bad_request', 'System is not an agent you can copy');
  const secretIds = request.secrets ?? [];
  const names = secretIds.length > 0 ? await vaultNames() : null;
  const gone = names ? secretIds.filter((id) => !names.has(id)) : [];
  if (gone.length > 0) throw coded('unknown_secret', `${gone.length === 1 ? 'A key you picked is' : 'Keys you picked are'} no longer in the vault`);

  let group: AgentGroup;
  let pausedTasks: string[] = [];
  let skippedPackages: string[] = [];

  if (request.template !== undefined) {
    await fetchTemplate(request.template);
    const template = loadTemplate(request.template);
    pausedTasks = template.tasks.map((task) => task.name);
    group = parseAgentGroup(
      await hostCommand('groups-create', { template: request.template, name, new: true, ...(timezone && { timezone }) }),
    );
  } else {
    let base: string;
    try {
      base = folderForAgentName(name);
    } catch (err) {
      throw coded('bad_request', err instanceof Error ? err.message : 'That name has no letters or digits');
    }
    const folder = await freeFolder(base);
    const source = request.copyFrom === undefined ? null : await getAgentGroup(request.copyFrom);
    if (request.copyFrom !== undefined && !source) throw coded('unknown_agent', 'No such agent to copy from');
    group = parseAgentGroup(await hostCommand('groups-create', { folder, name, ...(timezone && { timezone }) }));
    if (source) {
      skippedPackages = await copyConfig(source.id, group.id, timezone);
      const persona = readPersona(source.folder);
      if (persona) seedPersona(group.folder, persona);
    }
  }

  if (purpose && !readPersona(group.folder)) seedPersona(group.folder, `# ${name}\n\n${purpose}\n`);

  const conv = await ensureConversation(group);
  const agent: HostAgent = { id: group.id, name: group.name, conv, status: 'idle' };
  // Before onboarding, so the first spawn already carries the keys.
  const unattached = secretIds.length > 0 ? await attachKeys(group, secretIds) : [];
  if (unattached.length > 0) {
    const list = unattached.map((id) => names?.get(id) ?? id).join(', ');
    notify(conv, `${group.name} was created without these keys, which could not be attached: ${list}. Attach them from ${group.name}'s Keys.`);
  }
  if (!purpose) return agent;

  try {
    await startOnboarding(group, conv, onboardingText(group.name, purpose, pausedTasks));
    notify(conv, settingUpText(group.name, skippedPackages));
  } catch (err) {
    log.warn('wizzle: the new agent was created but onboarding did not start', { agent: group.id, err });
    notify(conv, `${group.name} was created, but it could not be woken to read your purpose. Send it a message to start it.`);
  }
  return agent;
}

export function createHost(notify: Notify, rooms?: RoomDeps): BridgeHost {
  return {
    runtime: 'nanoclaw',
    bridgeVersion: installedVersion(),
    hostName: INSTALL_SLUG,

    async listAgents(): Promise<HostAgent[]> {
      const agents: HostAgent[] = [];
      for (const group of await getAllAgentGroups()) {
        let conv: string;
        try {
          conv = await ensureConversation(group);
        } catch (err) {
          log.warn('wizzle: agent has no wizzle conversation, hidden from the wizzle app', { agent: group.id, err });
          continue;
        }
        const session = await sessionFor(group.id, conv);
        const config = await getContainerConfig(group.id);
        const lastAt = parseTimestamp(session?.last_active);
        agents.push({
          id: group.id,
          name: group.name,
          conv,
          status: group.paused_at ? 'paused' : session?.container_status === 'running' ? 'running' : 'idle',
          ...(config?.model && { model: config.model }),
          ...(lastAt !== undefined && { lastAt }),
        });
      }
      return agents;
    },

    async history(conv, limit): Promise<HostHistory> {
      if (rooms && isRoomConv(conv)) return roomHistory(rooms.store, conv, limit);
      const target = await targetFor(conv);
      if (!target?.session) return { messages: [], hasMore: false };
      const rows = await withExistingMailboxSession(target.agentGroupId, target.session.id, (mailbox) => ({
        inbound: mailbox.getInboundHistory(limit),
        outbound: mailbox.getOutboundHistory(limit),
      }));
      if (!rows) return { messages: [], hasMore: false };
      const delivered = await taskDeliveries(target.agentGroupId, taskEchoOrigins(rows.inbound), limit);
      const messages = historyMessages(conv, rows.inbound, rows.outbound, delivered);
      const hasMore = rows.inbound.length >= limit || rows.outbound.length >= limit || messages.length > limit;
      return { messages: messages.slice(-limit), hasMore };
    },

    async activity(conv, speaker): Promise<HostActivity> {
      if (isRoomConv(conv)) return roomActivity(conv, speaker);
      const target = await targetFor(conv);
      return target ? sessionActivity(target.agentGroupId, target.session) : { running: false };
    },

    async questionRender(questionId): Promise<HostQuestion | undefined> {
      const render = await resolveQuestionRender(questionId);
      if (!render) return undefined;
      return { title: render.title, ...(render.question && { question: render.question }), options: toQuestionOptions(render.options) };
    },

    createAgent(request): Promise<HostAgent> {
      return serializeCreate(() => createAgent(request, notify));
    },

    listTemplates,

    listTasks,
    runTask,
    pauseTask,
    resumeTask,

    ...(usesOneCli() && { listSecrets, createSecret, updateSecret, deleteSecret, listAgentSecrets, attachSecret, detachSecret }),

    ...(rooms && {
      listRooms,
      createRoom,
      updateRoom: (conv: string, changes: HostRoomChanges) => updateRoom(rooms.store, conv, changes),
      deleteRoom: (conv: string) => deleteRoom(rooms, conv),
      async continueRoom(conv: string): Promise<void> {
        await rooms.router.continue(conv);
      },
    }),

    async listConversations(): Promise<HostConversation[]> {
      const out: HostConversation[] = [];
      for (const agent of await getAllAgentGroups()) {
        let defaultConv: string;
        try {
          defaultConv = await ensureConversation(agent);
        } catch (err) {
          log.warn('wizzle: agent has no wizzle conversation, hidden from the wizzle app', { agent: agent.id, err });
          continue;
        }
        const groups = await wizzleGroupsFor(agent.id);
        const rows: HostConversation[] = [];
        for (const group of groups) {
          if (!isTopicConv(group.platform_id) && group.platform_id !== defaultConv) continue;
          rows.push(await toHostConversation(agent, group));
        }
        rows.sort((a, b) => Number(a.topic) - Number(b.topic) || (b.lastAt ?? 0) - (a.lastAt ?? 0));
        out.push(...rows);
      }
      return out;
    },

    async createConversation(agentId, title): Promise<HostConversation> {
      const agent = await getAgentGroup(agentId);
      if (!agent) throw coded('unknown_agent', 'No such agent');
      const name = title.trim();
      const slug = slugForTitle(name);
      if (!slug) throw coded('bad_request', 'That title has no letters or digits');
      const existing = await wizzleGroupsFor(agentId);
      if (existing.some((g) => isTopicConv(g.platform_id) && sameTitle(g.name, name))) {
        throw coded('name_taken', `This agent already has a topic called "${name}"`);
      }
      const taken = new Set(existing.map((g) => g.platform_id));
      let platformId = topicPlatformId(agentId, slug);
      for (let n = 2; taken.has(platformId) && n <= 9; n += 1) platformId = topicPlatformId(agentId, `${slug}-${n}`);
      if (taken.has(platformId)) throw coded('name_taken', 'Too many topics with a similar name on this agent');
      if (platformId.length > MAX_CONV_CHARS) throw coded('bad_request', 'That title makes too long a conversation id');
      await hostCommand('messaging-groups-create', {
        channel_type: CHANNEL_TYPE,
        instance: CHANNEL_TYPE,
        platform_id: platformId,
        name,
        is_group: 0,
      });
      await hostCommand('wirings-create', {
        channel_type: CHANNEL_TYPE,
        instance: CHANNEL_TYPE,
        platform_id: platformId,
        agent_group_id: agentId,
      });
      const group = await getMessagingGroupByPlatform(CHANNEL_TYPE, platformId, CHANNEL_TYPE);
      if (!group) throw coded('create_failed', 'The topic was not created');
      return toHostConversation(agent, group);
    },

    async renameConversation(conv, title): Promise<HostConversation> {
      const parsed = parseConv(conv);
      if (!parsed?.slug) throw coded('read_only', 'Only a topic can be renamed');
      const group = await getMessagingGroupByPlatform(CHANNEL_TYPE, conv, CHANNEL_TYPE);
      if (!group) throw coded('unknown_conv', 'No such conversation');
      const agentGroupId = (await getMessagingGroupAgents(group.id))[0]?.agent_group_id ?? parsed.agentGroupId;
      const agent = await getAgentGroup(agentGroupId);
      if (!agent) throw coded('unknown_agent', 'No such agent');
      const name = title.trim();
      const siblings = await wizzleGroupsFor(agentGroupId);
      if (siblings.some((g) => g.id !== group.id && isTopicConv(g.platform_id) && sameTitle(g.name, name))) {
        throw coded('name_taken', `This agent already has a topic called "${name}"`);
      }
      await hostCommand('messaging-groups-update', { id: group.id, name });
      return toHostConversation(agent, { ...group, name });
    },

    async deleteConversation(conv): Promise<HostDeleted> {
      const parsed = parseConv(conv);
      if (!parsed?.slug) throw coded('read_only', 'Only a topic can be deleted');
      const group = await getMessagingGroupByPlatform(CHANNEL_TYPE, conv, CHANNEL_TYPE);
      if (!group) throw coded('unknown_conv', 'No such conversation');
      const wirings = await getMessagingGroupAgents(group.id);
      const agentGroupId = wirings[0]?.agent_group_id ?? parsed.agentGroupId;
      const session = await findSessionForAgent(agentGroupId, group.id, null);
      const questionIds = session
        ? await dropSession(agentGroupId, session, 'That topic is still running, try again in a moment', 'wizzle topic deleted')
        : [];
      await removeCompanionDestination(agentGroupId, group.id);
      for (const wiring of wirings) await hostCommand('wirings-delete', { id: wiring.id });
      await hostCommand('messaging-groups-delete', { id: group.id });
      return { questionIds };
    },

    // The wiring and messaging group stay, so the next message opens a fresh session.
    async clearConversation(conv): Promise<HostDeleted> {
      if (rooms && isRoomConv(conv)) return clearRoom(rooms, conv);
      const target = await targetFor(conv);
      if (!target) throw coded('unknown_conv', 'No such conversation');
      const { agentGroupId, session } = target;
      if (!session) return { questionIds: [] };
      // Tasks scheduled before ncl tasks live in the chat session that made them and would go with it.
      const tasks = (await withExistingMailboxSession(agentGroupId, session.id, (mailbox) => mailbox.listLiveTasks().length)) ?? 0;
      if (tasks > 0) {
        const one = tasks === 1;
        throw coded('has_tasks', `This chat holds ${tasks} scheduled ${one ? 'task' : 'tasks'}; cancel ${one ? 'it' : 'them'} before clearing.`);
      }
      return { questionIds: await dropSession(agentGroupId, session, 'The agent is still running, try again in a moment', 'wizzle conversation cleared') };
    },

    // Open questions and approvals go too: an answer would wake the paused agent.
    async pauseAgent(agentId): Promise<HostDeleted> {
      const group = await lifecycleGroup(agentId);
      await hostCommand('groups-pause', { id: group.id });
      const questionIds: string[] = [];
      for (const session of await getSessionsByAgentGroup(group.id)) questionIds.push(...(await clearPendingForSession(session.id)));
      return { questionIds };
    },

    async resumeAgent(agentId): Promise<void> {
      const group = await lifecycleGroup(agentId);
      await hostCommand('groups-resume', { id: group.id });
    },

    async restartAgent(agentId, message): Promise<void> {
      const group = await lifecycleGroup(agentId);
      if (group.paused_at) throw coded('bad_request', `Resume ${group.name} before restarting it`);
      const result = await hostCommand('groups-restart', { id: group.id, ...(message !== undefined && { message }) });
      const restarted = isRecord(result) && typeof result.restarted === 'number' ? result.restarted : 0;
      if (restarted === 0 && isRecord(result) && typeof result.error === 'string') throw coded('restart_failed', result.error);
      // groups-restart only reaches running containers, so an idle agent gets the message as a fresh wake.
      if (restarted === 0 && message !== undefined) {
        await startOnboarding(group, await ensureConversation(group), message, 'cli');
      }
    },

    async deleteAgent(agentId, removeWorkspace): Promise<HostDeleted> {
      const group = await lifecycleGroup(agentId);
      const wasPaused = Boolean(group.paused_at);
      await hostCommand('groups-pause', { id: group.id });
      const sessions = await getSessionsByAgentGroup(group.id);
      const running = sessions.filter((session) => isContainerRunning(session.id));
      const stopped = await Promise.all(running.map((session) => stopContainer(session.id, 'wizzle agent deleted', AGENT_STOP_MS)));
      if (stopped.includes(false)) {
        if (!wasPaused) await hostCommand('groups-resume', { id: group.id });
        throw coded('busy', `${group.name} is still stopping, try again in a moment`);
      }
      const questionIds: string[] = [];
      for (const session of sessions) questionIds.push(...(await clearPendingForSession(session.id)));
      const wizzleGroups = await wizzleGroupsFor(group.id);
      // Its rooms keep what it said there; groups-delete then takes its room channels with the rest.
      const leftRooms: string[] = [];
      if (rooms) {
        for (const [roomId, seats] of await roomSeats()) {
          const seat = seats.find((one) => one.agent.id === group.id);
          if (!seat) continue;
          leftRooms.push(roomId);
          await archiveSeat(rooms.store, roomId, seat);
        }
      }
      try {
        await hostCommand('groups-delete', { id: group.id });
      } catch (err) {
        throw coded('delete_failed', err instanceof Error ? err.message : 'groups-delete failed');
      }
      // groups-delete took the sessions and wirings, so a wizzle group left with no wiring can go.
      for (const messagingGroup of wizzleGroups) {
        if ((await getMessagingGroupAgents(messagingGroup.id)).length > 0) continue;
        try {
          await hostCommand('messaging-groups-delete', { id: messagingGroup.id });
        } catch (err) {
          log.warn('wizzle: could not remove a deleted agent\'s conversation', { conv: messagingGroup.platform_id, err });
        }
      }
      for (const roomId of leftRooms) {
        if (((await roomSeats(roomId)).get(roomId) ?? []).length > 0) await writeRoomNotes(roomId);
        else rooms?.store.dropRoomArchive(roomId);
      }
      if (removeWorkspace) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        moveAside(resolveGroupFolderPath(group.folder), stamp);
        moveAside(path.join(DATA_DIR, 'v2-sessions', group.id), stamp);
      }
      return { questionIds };
    },

    // wizzle.sh backs up what it changes, installs the latest bundle, rebuilds and restarts this host.
    async updateBridge(ended): Promise<void> {
      fs.mkdirSync(path.dirname(UPDATE_LOG), { recursive: true });
      fs.rmSync(UPDATE_RESULT, { force: true });
      const out = fs.openSync(UPDATE_LOG, 'a');
      const child = spawn('bash', ['-lc', 'curl -fsSL "$WIZZLE_INSTALL_URL" | bash -s -- --dir "$WIZZLE_NANOCLAW_DIR" --yes'], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          WIZZLE_INSTALL_URL: envValue('WIZZLE_INSTALL_URL') ?? DEFAULT_INSTALL_URL,
          WIZZLE_NANOCLAW_DIR: PROJECT_ROOT,
          PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
        },
        // Its own process group, so the host restart it runs does not take it down with the host.
        detached: true,
        stdio: ['ignore', out, out],
      });
      fs.closeSync(out);
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
      child.once('exit', (code, signal) => {
        ended(takeUpdateResult() ?? `The Wizzle update stopped (${signal ?? `exit ${code}`}) without a result. Its log is ${UPDATE_LOG}.`);
      });
    },
  };
}

async function lifecycleGroup(agentId: string): Promise<AgentGroup> {
  if (agentId === SYSTEM_AGENT_ID) throw coded('bad_request', 'The System agent cannot be paused, restarted or deleted');
  const group = await getAgentGroup(agentId);
  if (!group) throw coded('unknown_agent', 'No such agent');
  return group;
}

// Renamed, never erased: the folder keeps the agent's work, and the new name frees the old one.
function moveAside(dir: string, stamp: string): void {
  if (!fs.existsSync(dir)) return;
  try {
    fs.renameSync(dir, `${dir}.deleted-${stamp}`);
  } catch (err) {
    log.warn('wizzle: could not move a deleted agent\'s folder aside', { dir, err });
  }
}

function envValue(name: string): string | undefined {
  return process.env[name] ?? readEnvFile([name])[name];
}

function installedVersion(): string {
  try {
    return fs.readFileSync(VERSION_FILE, 'utf8').trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

// What the install script left for the app, taken so it is shown once.
function takeUpdateResult(): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(UPDATE_RESULT, 'utf8');
  } catch {
    return null;
  }
  fs.rmSync(UPDATE_RESULT, { force: true });
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.message === 'string') return parsed.message;
  } catch {
    // Reported below as unreadable.
  }
  return `The Wizzle update left an unreadable result. Its log is ${UPDATE_LOG}.`;
}

function relayUrl(): string | null {
  const configured = envValue('WIZZLE_RELAY_URL') ?? DEFAULT_RELAY_URL;
  return isRelayUrl(configured) ? configured : null;
}

function inviteTtlMs(): number {
  const minutes = Number(envValue('WIZZLE_INVITE_TTL_MINUTES'));
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes * 60_000 : INVITE_TTL_MS;
}

// The invite goes to stdout for interactive starts and to data/wizzle/invite.txt for the service.
function announceInvite(store: BridgeStore, url: string, expiresAt: number): void {
  const text = inviteText(url, expiresAt);
  store.saveInvite(`${text}\n`);
  process.stdout.write(`${text}\n`);
}

let pairings: PairingManager | null = null;

// Runs in the service over the host-only ncl socket, so the QR prints in the operator's terminal.
register<{ replace: boolean }, IssuedInvite>({
  name: 'wizzle-pair',
  description: 'Show a one-time QR code that pairs the wizzle app with this install. --replace unpairs the current wizzle app first.',
  access: 'hidden',
  hostOnly: true,
  parseArgs: (raw) => ({ replace: raw.replace === true || raw.replace === 'true' }),
  handler: async ({ replace }) => {
    if (!pairings) throw coded('unavailable', 'The wizzle channel is not running. Check WIZZLE_RELAY_URL in .env and restart.');
    return pairings.issue(replace);
  },
  formatHuman: (issued) => inviteText(issued.url, issued.expiresAt),
});

function toAttachments(attachments: InboundAttachment[]): Array<Record<string, unknown>> {
  return attachments.map((a) => ({ type: 'file', name: a.name, mimeType: a.mimeType, size: a.size, data: a.data }));
}

// isGroup matches the room channel's row; an agent's text keeps its own sender id, never the owner's.
function injectRoomMessage(config: ChannelSetup | null, message: RoomInbound): void {
  if (!config) {
    log.warn('wizzle: a room message arrived before the channel started', { channel: message.channel });
    return;
  }
  const content: Record<string, unknown> = { text: message.text, sender: message.sender, senderId: message.senderId, msgId: message.msgId };
  if (message.note) content[NOTE_FIELD] = message.note;
  if (message.attachments) content.attachments = toAttachments(message.attachments);
  config.onInbound(message.channel, null, {
    id: message.id,
    kind: 'chat',
    content,
    timestamp: new Date().toISOString(),
    isMention: message.isMention,
    isGroup: true,
  });
}

function createAdapter(): ChannelAdapter | null {
  const relay = relayUrl();
  if (!relay) {
    log.warn('wizzle: WIZZLE_RELAY_URL must be a wss:// URL (ws:// only for a relay on this machine), channel disabled');
    return null;
  }
  let bridge: WizzleBridge;
  let channel: ChannelSetup | null = null;
  const store = new BridgeStore(path.join(DATA_DIR, 'wizzle'));
  const router = new RoomRouter({
    owner: { sender: SENDER_NAME, senderId: OWNER_USER_ID },
    hooks: {
      members: roomMembers,
      inject: (message) => injectRoomMessage(channel, message),
      expect: (conv, speaker) => bridge.expect(conv, speaker),
      hold: (conv, held) => bridge.holdRoom(conv, held),
    },
  });
  const host = createHost((conv, text) => bridge.notify(conv, text), { store, router });
  bridge = new WizzleBridge({ host, log });
  const manager = new PairingManager({
    bridge,
    store,
    crypto: nodeCrypto,
    transport: webSocketTransport,
    log,
    relay,
    name: INSTALL_SLUG,
    runtime: 'nanoclaw',
    ttlMs: inviteTtlMs(),
    announce: (url, expiresAt) => announceInvite(store, url, expiresAt),
  });

  return {
    name: CHANNEL_TYPE,
    channelType: CHANNEL_TYPE,
    supportsThreads: false,
    defaults: WIZZLE_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      channel = config;
      manager.start();
      pairings = manager;

      await ensureWizzleConversations();

      const hooks: BridgeHooks = {
        onInbound(conv, message) {
          if (isRoomConv(conv)) {
            void router.fromOwner(conv, message).catch((err: unknown) => log.warn('wizzle: a room message was not passed on', { conv, err }));
            return;
          }
          const content: Record<string, unknown> = { text: message.text, sender: SENDER_NAME, senderId: OWNER_USER_ID, msgId: message.msgId };
          if (message.attachments) content.attachments = toAttachments(message.attachments);
          void config.onInbound(conv, null, {
            id: message.id,
            kind: 'chat',
            content,
            timestamp: new Date().toISOString(),
            isGroup: false,
          });
        },
        onAction(questionId, value) {
          config.onAction(questionId, value, OWNER_USER_ID);
        },
      };
      bridge.start(hooks);
      const outcome = takeUpdateResult();
      if (outcome !== null) bridge.notify(SYSTEM_CONV, outcome);
      log.info('wizzle: channel started', { relay, pairing: manager.state });
    },

    async teardown(): Promise<void> {
      channel = null;
      pairings = null;
      manager.stop();
      bridge.stop();
    },

    isConnected(): boolean {
      return bridge.connected;
    },

    // Host-initiated DMs (approval cards) land in wizzle's System conversation.
    async openDM(): Promise<string> {
      return SYSTEM_CONV;
    },

    // A member channel's output shows in its room under that member, then goes on to the other members.
    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const outbound = {
        kind: message.kind,
        content: message.content,
        ...(message.id !== undefined && { id: message.id }),
        ...(message.files && { files: message.files.map((f) => ({ filename: f.filename, data: new Uint8Array(f.data) })) }),
      };
      const seat = parseRoom(platformId);
      if (seat?.agentGroupId === undefined) return bridge.deliver(platformId, outbound);
      const conv = roomConv(seat.roomId);
      const delivered = await bridge.deliver(conv, { ...outbound, speaker: seat.agentGroupId });
      // Without a messages_out id a copy could land twice, so such a delivery stays in the room only.
      if (message.id !== undefined) {
        await router
          .fromAgent(conv, seat.agentGroupId, outbound)
          .catch((err: unknown) => log.warn('wizzle: a room message was not passed on', { conv, err }));
      }
      return delivered;
    },

    async setTyping(platformId, _threadId, status, statusKind): Promise<void> {
      const seat = parseRoom(platformId);
      if (seat?.agentGroupId !== undefined) await bridge.typing(roomConv(seat.roomId), status, statusKind, seat.agentGroupId);
      else await bridge.typing(platformId, status, statusKind);
    },
  };
}

registerChannelAdapter(CHANNEL_TYPE, { factory: createAdapter, defaults: WIZZLE_DEFAULTS });
