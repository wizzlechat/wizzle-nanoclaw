// wizzle channel: a phone paired to this NanoClaw install through the wizzle relay.
// Lives at src/channels/wizzle.ts in the fork; the core sits in src/channels/wizzle/.
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { dispatch } from '../cli/dispatch.js';
import { DATA_DIR, INSTALL_SLUG } from '../config.js';
import { getAgentGroupByFolder, getAllAgentGroups } from '../db/agent-groups.js';
import { getContainerConfig } from '../db/container-configs.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform, getMessagingGroupsByAgentGroup } from '../db/messaging-groups.js';
import { findSessionForAgent } from '../db/sessions.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { withExistingMailboxSession } from '../session-manager.js';
import type { AgentGroup, MessagingGroup, Session as AgentSession } from '../types.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { resolveQuestionRender } from './question-render-registry.js';
import { BridgeStore, SYSTEM_CONV, WizzleBridge, encodeQr, renderQr, webSocketTransport } from './wizzle/index.js';
import type { BridgeHooks, BridgeHost, HostActivity, HostAgent, HostHistory, HostQuestion } from './wizzle/index.js';
import { nodeCrypto } from './wizzle/protocol/crypto-node.js';
import {
  Session,
  derivePsk,
  deriveRelaySecret,
  encodeInvite,
  fromB64Url,
  newInvite,
  toB64Url,
  type ChatMessage,
  type QuestionOption,
} from './wizzle/protocol/index.js';

export const CHANNEL_TYPE = 'wizzle';
export const OWNER_USER_ID = 'wizzle:owner';
const PLATFORM_PREFIX = 'wizzle:agent:';
const CONVERSATION_NAME = 'Phone';
const SENDER_NAME = 'Phone';

const WIZZLE_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  mentions: 'never',
};

export function platformIdForAgent(agentGroupId: string): string {
  return `${PLATFORM_PREFIX}${agentGroupId}`;
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

// The agent's conversation is whatever wizzle messaging group is wired to it, created on demand.
async function ensureConversation(agent: AgentGroup): Promise<string> {
  const wired = (await getMessagingGroupsByAgentGroup(agent.id)).find(isWizzleGroup);
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

type ConversationTarget = { agentGroupId: string; session: AgentSession | undefined };

async function targetFor(conv: string): Promise<ConversationTarget | undefined> {
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

function parseTimestamp(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

function historyText(content: string): { text: string; sender?: string } | null {
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
  return typeof parsed.sender === 'string' ? { text, sender: parsed.sender } : { text };
}

function toQuestionOptions(options: Array<{ label: string; value: string; style?: string }>): QuestionOption[] {
  return options.map((option) => ({
    label: option.label,
    value: option.value,
    ...(option.style === 'primary' || option.style === 'danger' || option.style === 'default' ? { style: option.style } : {}),
  }));
}

function createHost(): BridgeHost {
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
          status: session?.container_status === 'running' ? 'running' : 'idle',
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
      const messages: ChatMessage[] = [];
      for (const row of rows.inbound) {
        if (row.kind !== 'chat' && row.kind !== 'chat-sdk') continue;
        const parsed = historyText(row.content);
        const at = parseTimestamp(row.timestamp);
        if (!parsed || at === undefined) continue;
        messages.push({ conv, msgId: `in-${row.timestamp}-${messages.length}`, role: 'user', text: parsed.text, format: 'text', at });
      }
      for (const row of rows.outbound) {
        if (row.kind === 'system' || row.kind === 'task_log') continue;
        const parsed = historyText(row.content);
        const at = parseTimestamp(row.timestamp);
        if (!parsed || at === undefined) continue;
        messages.push({ conv, msgId: `out-${row.timestamp}-${messages.length}`, role: 'agent', text: parsed.text, format: 'markdown', at });
      }
      messages.sort((a, b) => a.at - b.at);
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

    async createAgent(name): Promise<HostAgent> {
      const folder = folderForAgentName(name);
      const existing = await getAgentGroupByFolder(folder);
      if (existing) throw new Error(`An agent already uses the folder "${folder}"`);
      const group = parseAgentGroup(await hostCommand('groups-create', { folder, name }));
      const conv = await ensureConversation(group);
      return { id: group.id, name: group.name, conv, status: 'idle' };
    },
  };
}

function relayUrl(): string | null {
  const fromEnv = process.env.WIZZLE_RELAY_URL ?? readEnvFile(['WIZZLE_RELAY_URL']).WIZZLE_RELAY_URL;
  if (!fromEnv) return null;
  try {
    const url = new URL(fromEnv);
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return null;
  } catch {
    return null;
  }
  return fromEnv;
}

// The invite goes to stdout for interactive starts and to data/wizzle/invite.txt for the service.
function announceInvite(store: BridgeStore, url: string): void {
  const text = [
    '',
    'wizzle: scan this code with the wizzle app to pair your phone.',
    '',
    renderQr(encodeQr(url, { level: 'L' }), 'utf8'),
    '',
    `Or paste the invite into the app: ${url}`,
    '',
  ].join('\n');
  store.saveInvite(`${text}\n`);
  process.stdout.write(`${text}\n`);
}

function createAdapter(): ChannelAdapter | null {
  const relay = relayUrl();
  if (!relay) {
    log.warn('wizzle: WIZZLE_RELAY_URL is not set to a ws(s) URL, channel disabled');
    return null;
  }
  const bridge = new WizzleBridge({ host: createHost(), log });
  const store = new BridgeStore(path.join(DATA_DIR, 'wizzle'));

  return {
    name: CHANNEL_TYPE,
    channelType: CHANNEL_TYPE,
    supportsThreads: false,
    defaults: WIZZLE_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      let pairing = store.loadPairing();
      if (!pairing) {
        const invite = newInvite(nodeCrypto, relay, { name: INSTALL_SLUG, runtime: 'nanoclaw' });
        pairing = {
          relay,
          pairingId: toB64Url(invite.pairingId),
          secret: toB64Url(invite.secret),
          name: INSTALL_SLUG,
          runtime: 'nanoclaw',
          createdAt: new Date().toISOString(),
        };
        store.savePairing(pairing);
      }
      const pairingId = fromB64Url(pairing.pairingId);
      const secret = fromB64Url(pairing.secret);
      const stored = store.loadSession();
      const session = new Session(nodeCrypto, 'bridge', pairingId, derivePsk(nodeCrypto, secret), stored ?? undefined);

      bridge.addPairing({
        id: 'default',
        relayUrl: pairing.relay,
        pairingId,
        relaySecret: deriveRelaySecret(nodeCrypto, secret),
        session,
        transport: webSocketTransport,
        persist: (state) => store.saveSession(state),
        onPaired: () => {
          store.markPaired();
          store.clearInvite();
          log.info('wizzle: phone paired');
        },
      });

      if (session.ready) {
        store.clearInvite();
      } else {
        const invite = { relay: pairing.relay, pairingId, secret, name: INSTALL_SLUG, runtime: 'nanoclaw' };
        announceInvite(store, encodeInvite(invite));
      }

      await ensureWizzleConversations();

      const hooks: BridgeHooks = {
        onInbound(conv, message) {
          const content: Record<string, unknown> = { text: message.text, sender: SENDER_NAME, senderId: OWNER_USER_ID };
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
      log.info('wizzle: relay client started', { relay: pairing.relay, paired: session.ready });
    },

    async teardown(): Promise<void> {
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
        ...(message.files && { files: message.files.map((f) => ({ filename: f.filename, data: new Uint8Array(f.data) })) }),
      });
    },

    async setTyping(platformId, _threadId, status, statusKind): Promise<void> {
      await bridge.typing(platformId, status, statusKind);
    },
  };
}

registerChannelAdapter(CHANNEL_TYPE, { factory: createAdapter, defaults: WIZZLE_DEFAULTS });
