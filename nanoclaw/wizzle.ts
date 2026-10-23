// wizzle channel: a phone paired to this NanoClaw install through the wizzle relay.
// Lives at src/channels/wizzle.ts in the fork; the core sits in src/channels/wizzle/.
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
import { getMessagingGroupAgents, getMessagingGroupByPlatform, getMessagingGroupsByAgentGroup } from '../db/messaging-groups.js';
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
  PairingManager,
  SYSTEM_CONV,
  WizzleBridge,
  historyMessages,
  inviteText,
  isRelayUrl,
  parseTimestamp,
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
  IssuedInvite,
  MailboxRow,
} from './wizzle/index.js';
import { nodeCrypto } from './wizzle/protocol/crypto-node.js';
import { type QuestionOption, type TemplateInfo } from './wizzle/protocol/index.js';

export const CHANNEL_TYPE = 'wizzle';
export const OWNER_USER_ID = 'wizzle:owner';
const PLATFORM_PREFIX = 'wizzle:agent:';
const CONVERSATION_NAME = 'Phone';
const SENDER_NAME = 'Phone';
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

const WIZZLE_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  mentions: 'never',
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

// Host errors carrying a code reach the phone as that error code.
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

// A topic is never the default, so the setup wiring `wizzle:phone` still counts as one.
function isDefaultWizzleGroup(group: MessagingGroup): boolean {
  return isWizzleGroup(group) && !isTopicConv(group.platform_id);
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
      log.warn('wizzle: could not wire agent to the phone conversation', { agent: agent.id, err });
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

// A missing templates directory is an install without templates, not a failure.
export async function listTemplates(): Promise<TemplateInfo[]> {
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

function onboardingText(name: string, purpose: string, pausedTasks: string[]): string {
  const lines = [
    `You are ${name}. You were created from the owner's phone a moment ago and this is your first turn.`,
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

export async function createAgent(request: HostCreateAgent, notify: Notify): Promise<HostAgent> {
  const name = request.name.trim();
  await assertNameFree(name);
  const purpose = request.purpose?.trim();
  const timezone = request.timezone?.trim() || undefined;
  if (timezone && !isValidTimezone(timezone)) throw coded('bad_request', `${timezone} is not an IANA timezone id`);
  if (request.copyFrom === SYSTEM_AGENT_ID) throw coded('bad_request', 'System is not an agent you can copy');

  let group: AgentGroup;
  let pausedTasks: string[] = [];
  let skippedPackages: string[] = [];

  if (request.template !== undefined) {
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

export function createHost(notify: Notify): BridgeHost {
  return {
    runtime: 'nanoclaw',
    hostName: INSTALL_SLUG,

    async listAgents(): Promise<HostAgent[]> {
      const agents: HostAgent[] = [];
      for (const group of await getAllAgentGroups()) {
        let conv: string;
        try {
          conv = await ensureConversation(group);
        } catch (err) {
          log.warn('wizzle: agent has no phone conversation, hidden from the phone', { agent: group.id, err });
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

    async activity(conv): Promise<HostActivity> {
      const target = await targetFor(conv);
      if (!target?.session) return { running: false };
      const state = await withExistingMailboxSession(target.agentGroupId, target.session.id, (mailbox) => mailbox.getContainerState());
      const toolStartedAt = parseTimestamp(state?.toolStartedAt);
      return {
        running: target.session.container_status === 'running',
        ...(state?.currentTool && { tool: state.currentTool }),
        ...(toolStartedAt !== undefined && { toolStartedAt }),
        ...(state?.toolDeclaredTimeoutMs && { timeoutMs: state.toolDeclaredTimeoutMs }),
      };
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

    async listConversations(): Promise<HostConversation[]> {
      const out: HostConversation[] = [];
      for (const agent of await getAllAgentGroups()) {
        let defaultConv: string;
        try {
          defaultConv = await ensureConversation(agent);
        } catch (err) {
          log.warn('wizzle: agent has no phone conversation, hidden from the phone', { agent: agent.id, err });
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
      let questionIds: string[] = [];
      if (session) {
        if (isContainerRunning(session.id) && !(await stopContainer(session.id))) {
          throw coded('busy', 'That topic is still running, try again in a moment');
        }
        questionIds = await clearPendingForSession(session.id);
        await destroySessionMailbox(agentGroupId, session.id);
        fs.rmSync(sessionDir(agentGroupId, session.id), { recursive: true, force: true });
        await deleteSession(session.id);
      }
      await removeCompanionDestination(agentGroupId, group.id);
      for (const wiring of wirings) await hostCommand('wirings-delete', { id: wiring.id });
      await hostCommand('messaging-groups-delete', { id: group.id });
      return { questionIds };
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
      if (removeWorkspace) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        moveAside(resolveGroupFolderPath(group.folder), stamp);
        moveAside(path.join(DATA_DIR, 'v2-sessions', group.id), stamp);
      }
      return { questionIds };
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
  description: 'Show a one-time QR code that pairs the wizzle phone app with this install. --replace unpairs the current phone first.',
  access: 'hidden',
  hostOnly: true,
  parseArgs: (raw) => ({ replace: raw.replace === true || raw.replace === 'true' }),
  handler: async ({ replace }) => {
    if (!pairings) throw coded('unavailable', 'The wizzle channel is not running. Check WIZZLE_RELAY_URL in .env and restart.');
    return pairings.issue(replace);
  },
  formatHuman: (issued) => inviteText(issued.url, issued.expiresAt),
});

function createAdapter(): ChannelAdapter | null {
  const relay = relayUrl();
  if (!relay) {
    log.warn('wizzle: WIZZLE_RELAY_URL must be a wss:// URL (ws:// only for a relay on this machine), channel disabled');
    return null;
  }
  let bridge: WizzleBridge;
  const host = createHost((conv, text) => bridge.notify(conv, text));
  bridge = new WizzleBridge({ host, log });
  const store = new BridgeStore(path.join(DATA_DIR, 'wizzle'));
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
      manager.start();
      pairings = manager;

      await ensureWizzleConversations();

      const hooks: BridgeHooks = {
        onInbound(conv, message) {
          const content: Record<string, unknown> = { text: message.text, sender: SENDER_NAME, senderId: OWNER_USER_ID, msgId: message.msgId };
          if (message.attachments) {
            content.attachments = message.attachments.map((a) => ({
              type: 'file',
              name: a.name,
              mimeType: a.mimeType,
              size: a.size,
              data: a.data,
            }));
          }
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
      log.info('wizzle: channel started', { relay, pairing: manager.state });
    },

    async teardown(): Promise<void> {
      pairings = null;
      manager.stop();
      bridge.stop();
    },

    isConnected(): boolean {
      return bridge.connected;
    },

    // Host-initiated DMs (approval cards) land in the phone's System conversation.
    async openDM(): Promise<string> {
      return SYSTEM_CONV;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      return bridge.deliver(platformId, {
        kind: message.kind,
        content: message.content,
        ...(message.id !== undefined && { id: message.id }),
        ...(message.files && { files: message.files.map((f) => ({ filename: f.filename, data: new Uint8Array(f.data) })) }),
      });
    },

    async setTyping(platformId, _threadId, status, statusKind): Promise<void> {
      await bridge.typing(platformId, status, statusKind);
    },
  };
}

registerChannelAdapter(CHANNEL_TYPE, { factory: createAdapter, defaults: WIZZLE_DEFAULTS });
