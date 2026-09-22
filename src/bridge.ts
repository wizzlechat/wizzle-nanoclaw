import { randomUUID } from 'node:crypto';

import {
  MAX_FILE_BYTES,
  PROTOCOL_VERSION,
  Session,
  decodePacket,
  encodePacket,
  type Activity,
  type Agent,
  type BridgeMessage,
  type Capabilities,
  type ChatMessage,
  type Conversation,
  type FileMeta,
  type Packet,
  type QuestionOption,
  type SessionState,
} from '../../wizzle-protocol/src/index.ts';
import { RelayClient, type Logger } from './relay-client.ts';
import type { Transport } from './transport.ts';

export const BRIDGE_VERSION = '0.1.0';
export const SYSTEM_CONV = 'wizzle:system';
export const SYSTEM_AGENT: Agent = { id: 'system', name: 'System', status: 'idle', description: 'Approvals and host notices' };

const MAX_TEXT_CHARS = 32_000;
const MAX_UPLOADS = 16;
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const UPLOAD_TTL_MS = 10 * 60 * 1000;
const DEFAULT_HISTORY = 50;
const MAX_HISTORY = 200;
const MAX_TITLE_CHARS = 60;

export type HostAgent = { id: string; name: string; conv: string; status: Agent['status']; model?: string; description?: string; lastAt?: number };
export type HostHistory = { messages: ChatMessage[]; hasMore: boolean };
export type HostActivity = { running: boolean; tool?: string; toolStartedAt?: number; timeoutMs?: number };
export type HostQuestion = { title: string; question?: string; options: QuestionOption[] };
export type HostConversation = { conv: string; agentId: string; title: string; lastAt?: number; topic: boolean; createdAt?: number };
export type HostDeleted = { questionIds?: string[] };

// What the bridge needs from the runtime. The NanoClaw adapter implements it on the host DB.
export interface BridgeHost {
  readonly runtime: string;
  readonly runtimeVersion?: string;
  readonly hostName: string;
  listAgents(): Promise<HostAgent[]>;
  history(conv: string, limit: number): Promise<HostHistory>;
  activity(conv: string): Promise<HostActivity>;
  questionRender(questionId: string): Promise<HostQuestion | undefined>;
  createAgent?(name: string, description?: string): Promise<HostAgent>;
  listConversations?(): Promise<HostConversation[]>;
  createConversation?(agentId: string, title: string): Promise<HostConversation>;
  renameConversation?(conv: string, title: string): Promise<HostConversation>;
  deleteConversation?(conv: string): Promise<HostDeleted | void>;
}

export type InboundAttachment = { name: string; mimeType: string; size: number; data: string };
export type InboundText = { id: string; text: string; attachments?: InboundAttachment[] };

// Callbacks into the runtime's inbound path, filled in by the adapter's setup().
export type BridgeHooks = {
  onInbound(conv: string, message: InboundText): void;
  onAction(questionId: string, value: string): void;
};

export type OutboundFile = { filename: string; data: Uint8Array };
export type Outbound = { kind: string; content: unknown; files?: OutboundFile[] };

export type PairingLink = {
  id: string;
  relayUrl: string;
  pairingId: Uint8Array;
  relaySecret: Uint8Array;
  session: Session;
  transport: Transport;
  persist(state: SessionState): void;
  onPaired?(): void;
  reconnect?: { minMs: number; maxMs: number };
};

type Upload = { file: FileMeta; bytes: Uint8Array; at: number };
type Link = { id: string; client: RelayClient; uploads: Map<string, Upload>; uploadBytes: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mimeFor(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const table: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
    zip: 'application/zip',
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
  };
  return table[ext] ?? 'application/octet-stream';
}

export class WizzleBridge {
  private readonly host: BridgeHost;
  private readonly log: Logger;
  private readonly links = new Map<string, Link>();
  private readonly awaiting = new Set<string>();
  private readonly lastActivity = new Map<string, string>();
  private readonly questionConv = new Map<string, string>();
  private agents: HostAgent[] = [];
  private convs: HostConversation[] = [];
  private hooks: BridgeHooks | null = null;
  readonly capabilities: Capabilities;

  constructor(opts: { host: BridgeHost; log: Logger; capabilities?: Partial<Capabilities> }) {
    this.host = opts.host;
    this.log = opts.log;
    this.capabilities = {
      streaming: false,
      questions: true,
      approvals: true,
      tasks: false,
      files: true,
      history: true,
      clearSession: false,
      abort: false,
      createAgent: typeof opts.host.createAgent === 'function',
      topics:
        typeof opts.host.listConversations === 'function' &&
        typeof opts.host.createConversation === 'function' &&
        typeof opts.host.renameConversation === 'function' &&
        typeof opts.host.deleteConversation === 'function',
      ...opts.capabilities,
    };
  }

  addPairing(pairing: PairingLink): RelayClient {
    const link: Link = { id: pairing.id, client: null as unknown as RelayClient, uploads: new Map(), uploadBytes: 0 };
    const options = {
      transport: pairing.transport,
      relayUrl: pairing.relayUrl,
      pairingId: pairing.pairingId,
      relaySecret: pairing.relaySecret,
      session: pairing.session,
      persist: pairing.persist,
      log: this.log,
      onPacket: (plaintext: Uint8Array) => {
        void this.handlePacket(link, plaintext).catch((err: unknown) => {
          this.log.error('wizzle: packet handler failed', { err });
        });
      },
      onFatal: (code: string, message: string) => {
        this.log.error('wizzle: pairing disabled by relay', { pairing: pairing.id, code, message });
      },
      ...(pairing.onPaired && { onPaired: pairing.onPaired }),
      ...(pairing.reconnect && { reconnect: pairing.reconnect }),
    };
    link.client = new RelayClient(options);
    this.links.set(pairing.id, link);
    if (this.hooks) link.client.start();
    return link.client;
  }

  start(hooks: BridgeHooks): void {
    this.hooks = hooks;
    for (const link of this.links.values()) link.client.start();
  }

  stop(): void {
    for (const link of this.links.values()) link.client.stop();
    this.hooks = null;
  }

  get connected(): boolean {
    for (const link of this.links.values()) if (link.client.state === 'ready') return true;
    return false;
  }

  get peerOnline(): boolean {
    for (const link of this.links.values()) if (link.client.peerOnline) return true;
    return false;
  }

  // Runtime output for one conversation. Returns the id the runtime may edit or react to later.
  async deliver(conv: string, message: Outbound): Promise<string | undefined> {
    await this.announceConv(conv);
    const at = Date.now();
    const content = message.content;
    let firstId: string | undefined;
    const emit = (packet: BridgeMessage, body?: Uint8Array) => {
      const id = randomUUID();
      this.broadcast({ ...packet, id } as Packet<BridgeMessage>, body);
      return id;
    };
    const finishTurn = () => {
      this.awaiting.delete(conv);
      this.sendActivity({ conv, state: 'idle' });
    };

    if (isRecord(content) && content.type === 'ask_question' && typeof content.questionId === 'string') {
      const questionId = content.questionId;
      const render = await this.host.questionRender(questionId);
      const fallbackOptions = Array.isArray(content.options) ? content.options : [];
      const options: QuestionOption[] = (render?.options ?? fallbackOptions.map(normalizeOption).filter(Boolean)) as QuestionOption[];
      const question = {
        conv,
        questionId,
        question: render?.question ?? (typeof content.question === 'string' ? content.question : ''),
        options,
        ...(render?.title ? { title: render.title } : typeof content.title === 'string' ? { title: content.title } : {}),
      };
      this.questionConv.set(questionId, conv);
      emit({ t: 'question', question });
      finishTurn();
      return questionId;
    }

    if (isRecord(content) && content.operation === 'edit' && typeof content.messageId === 'string') {
      const target = this.questionConv.get(content.messageId) ?? conv;
      const terminal = isRecord(content.terminalCard) && typeof content.terminalCard.resolution === 'string'
        ? { resolution: content.terminalCard.resolution }
        : undefined;
      const text = typeof content.text === 'string' ? content.text : (terminal?.resolution ?? '');
      emit({ t: 'edit', conv: target, msgId: content.messageId, text, format: 'markdown', ...(terminal && { terminal }) });
      if (terminal) {
        this.questionConv.delete(content.messageId);
        emit({ t: 'question_resolved', questionId: content.messageId, value: terminal.resolution });
      }
      return undefined;
    }

    if (isRecord(content) && content.operation === 'reaction' && typeof content.messageId === 'string') {
      if (typeof content.emoji === 'string') {
        emit({ t: 'reaction', conv, msgId: content.messageId, emoji: content.emoji, op: 'add' });
      }
      return undefined;
    }

    if (isRecord(content) && content.card !== undefined) {
      const fallbackText = typeof content.fallbackText === 'string' ? content.fallbackText : '';
      const msgId = randomUUID();
      emit({ t: 'card', conv, msgId, card: content.card, fallbackText, at });
      firstId ??= msgId;
    } else {
      const text = extractText(content);
      if (text !== null && text.length > 0) {
        const msgId = randomUUID();
        emit({ t: 'message', message: { conv, msgId, role: 'agent', text, format: 'markdown', at } });
        firstId ??= msgId;
      }
    }

    for (const file of message.files ?? []) {
      if (file.data.length > MAX_FILE_BYTES) {
        emit({
          t: 'message',
          message: { conv, msgId: randomUUID(), role: 'system', text: `Attachment ${file.filename} skipped: larger than 16 MiB.`, format: 'text', at },
        });
        continue;
      }
      const msgId = randomUUID();
      const meta: FileMeta = { name: file.filename, mime: mimeFor(file.filename), size: file.data.length };
      emit({ t: 'file', conv, msgId, file: meta, at }, file.data);
      firstId ??= msgId;
    }

    if (firstId !== undefined) finishTurn();
    return firstId;
  }

  // Runtime typing signal. Only sent while a phone is online, and only when it changes.
  async typing(conv: string, status?: string, statusKind?: 'auto' | 'agent'): Promise<void> {
    if (!this.awaiting.has(conv) && statusKind !== 'agent') return;
    if (!this.peerOnline) return;
    const host = await this.host.activity(conv);
    const activity: Activity = {
      conv,
      state: host.tool ? 'tool' : 'thinking',
      ...(host.tool && { tool: host.tool }),
      ...(statusKind === 'agent' && status && { label: status }),
      ...(host.toolStartedAt && { startedAt: host.toolStartedAt }),
      ...(host.timeoutMs && { timeoutMs: host.timeoutMs }),
    };
    this.sendActivity(activity);
  }

  private sendActivity(activity: Activity): void {
    const key = JSON.stringify(activity);
    if (this.lastActivity.get(activity.conv) === key) return;
    this.lastActivity.set(activity.conv, key);
    if (!this.peerOnline) return;
    this.broadcast({ ...activity_packet(activity), id: randomUUID() });
  }

  private broadcast(packet: Packet<BridgeMessage>, body?: Uint8Array): void {
    const bytes = encodePacket(packet, body);
    for (const link of this.links.values()) link.client.send(bytes);
  }

  private reply(link: Link, packet: BridgeMessage, body?: Uint8Array): void {
    link.client.send(encodePacket({ ...packet, id: randomUUID() } as Packet<BridgeMessage>, body));
  }

  private fail(link: Link, ref: string | undefined, code: string, message: string): void {
    this.reply(link, { t: 'error', ...(ref !== undefined && { ref }), code, message });
  }

  // A host error carrying a code answers with it; anything else uses the fallback.
  private failHost(link: Link, ref: string | undefined, err: unknown, fallback: string, message: string): void {
    const code = isRecord(err) && typeof err.code === 'string' ? err.code : fallback;
    this.fail(link, ref, code, err instanceof Error && err.message ? err.message : message);
  }

  private async refreshAgents(): Promise<HostAgent[]> {
    this.agents = await this.host.listAgents();
    return this.agents;
  }

  // Without listConversations the catalog stays one conversation per agent.
  private async refreshConvs(agents?: HostAgent[]): Promise<HostConversation[]> {
    if (this.host.listConversations) {
      this.convs = await this.host.listConversations();
      return this.convs;
    }
    const list = agents ?? (await this.refreshAgents());
    this.convs = list.map((a) => ({ conv: a.conv, agentId: a.id, title: a.name, topic: false, ...(a.lastAt && { lastAt: a.lastAt }) }));
    return this.convs;
  }

  private async knownConv(conv: string): Promise<boolean> {
    if (conv === SYSTEM_CONV) return true;
    if (this.convs.some((c) => c.conv === conv)) return true;
    return (await this.refreshConvs()).some((c) => c.conv === conv);
  }

  // A conversation wired after the last catalog is announced before its first message.
  private async announceConv(conv: string): Promise<void> {
    if (conv === SYSTEM_CONV || this.convs.some((c) => c.conv === conv)) return;
    if (!(await this.refreshConvs()).some((c) => c.conv === conv)) return;
    for (const link of this.links.values()) await this.sendCatalog(link);
  }

  private async sendCatalog(link: Link): Promise<void> {
    const agents = await this.refreshAgents();
    this.reply(link, { t: 'agents', agents: [...agents.map(toAgent), SYSTEM_AGENT] });
    const conversations: Conversation[] = (await this.refreshConvs(agents)).map(toConversation);
    conversations.push({ id: SYSTEM_CONV, agentId: SYSTEM_AGENT.id, title: SYSTEM_AGENT.name });
    this.reply(link, { t: 'conversations', conversations });
  }

  private async broadcastCatalog(): Promise<void> {
    for (const link of this.links.values()) await this.sendCatalog(link);
  }

  private async handlePacket(link: Link, plaintext: Uint8Array): Promise<void> {
    let decoded;
    try {
      decoded = decodePacket(plaintext);
    } catch (err) {
      this.log.warn('wizzle: malformed packet from phone', { err });
      return;
    }
    const { header, body } = decoded;
    const ref = typeof header.id === 'string' ? header.id : undefined;
    const hooks = this.hooks;
    if (!hooks) return;

    switch (header.t) {
      case 'sync': {
        this.reply(link, {
          t: 'hello',
          protocol: PROTOCOL_VERSION,
          runtime: this.host.runtime,
          ...(this.host.runtimeVersion && { runtimeVersion: this.host.runtimeVersion }),
          bridgeVersion: BRIDGE_VERSION,
          host: this.host.hostName,
          capabilities: this.capabilities,
        });
        await this.sendCatalog(link);
        for (const agent of this.agents) {
          if (agent.status !== 'running') continue;
          const host = await this.host.activity(agent.conv);
          if (!host.running) continue;
          this.reply(link, activity_packet({ conv: agent.conv, state: host.tool ? 'tool' : 'thinking', ...(host.tool && { tool: host.tool }) }));
        }
        return;
      }
      case 'send': {
        const conv = header.conv;
        const text = header.text;
        const msgId = header.msgId;
        if (typeof conv !== 'string' || typeof text !== 'string' || typeof msgId !== 'string') {
          this.fail(link, ref, 'bad_request', 'send needs conv, msgId, and text');
          return;
        }
        if (text.length > MAX_TEXT_CHARS) {
          this.fail(link, ref, 'too_long', `Messages are limited to ${MAX_TEXT_CHARS} characters`);
          return;
        }
        if (!(await this.knownConv(conv))) {
          this.fail(link, ref, 'unknown_conv', 'No such conversation');
          return;
        }
        if (conv === SYSTEM_CONV) {
          this.fail(link, ref, 'read_only', 'No agent is wired to the System conversation');
          return;
        }
        const attachments: InboundAttachment[] = [];
        const ids = Array.isArray(header.attachments) ? header.attachments : [];
        for (const uploadId of ids) {
          const upload = typeof uploadId === 'string' ? link.uploads.get(uploadId) : undefined;
          if (!upload) {
            this.fail(link, ref, 'missing_upload', 'Attachment was not uploaded');
            return;
          }
          attachments.push({
            name: upload.file.name,
            mimeType: upload.file.mime,
            size: upload.bytes.length,
            data: Buffer.from(upload.bytes).toString('base64'),
          });
        }
        for (const uploadId of ids) this.dropUpload(link, uploadId as string);
        if (text.trim().length === 0 && attachments.length === 0) {
          this.fail(link, ref, 'empty', 'Nothing to send');
          return;
        }
        const message: InboundText = { id: `wizzle-${randomUUID()}`, text, ...(attachments.length > 0 && { attachments }) };
        hooks.onInbound(conv, message);
        this.awaiting.add(conv);
        this.lastActivity.delete(conv);
        return;
      }
      case 'upload': {
        const uploadId = header.uploadId;
        const file = header.file;
        if (typeof uploadId !== 'string' || !isRecord(file) || typeof file.name !== 'string' || typeof file.mime !== 'string') {
          this.fail(link, ref, 'bad_request', 'upload needs uploadId and file');
          return;
        }
        if (body.length === 0 || body.length > MAX_FILE_BYTES) {
          this.fail(link, ref, 'too_large', 'Uploads are limited to 16 MiB');
          return;
        }
        this.pruneUploads(link);
        if (link.uploads.size >= MAX_UPLOADS || link.uploadBytes + body.length > MAX_UPLOAD_BYTES) {
          this.fail(link, ref, 'limit', 'Too many pending uploads');
          return;
        }
        const name = file.name.replace(/[/\\]/g, '_').slice(0, 200) || 'attachment';
        link.uploads.set(uploadId, { file: { name, mime: file.mime, size: body.length }, bytes: body, at: Date.now() });
        link.uploadBytes += body.length;
        return;
      }
      case 'answer': {
        const questionId = header.questionId;
        const value = header.value;
        if (typeof questionId !== 'string' || (typeof value !== 'string' && !Array.isArray(value))) {
          this.fail(link, ref, 'bad_request', 'answer needs questionId and value');
          return;
        }
        hooks.onAction(questionId, typeof value === 'string' ? value : value.map(String).join(','));
        this.markAwaitingForQuestion(questionId);
        return;
      }
      case 'resolve': {
        const approvalId = header.approvalId;
        const decision = header.decision;
        if (typeof approvalId !== 'string' || typeof decision !== 'string') {
          this.fail(link, ref, 'bad_request', 'resolve needs approvalId and decision');
          return;
        }
        hooks.onAction(approvalId, decision);
        this.markAwaitingForQuestion(approvalId);
        return;
      }
      case 'history': {
        const conv = header.conv;
        if (typeof conv !== 'string' || !(await this.knownConv(conv))) {
          this.fail(link, ref, 'unknown_conv', 'No such conversation');
          return;
        }
        const requested = typeof header.limit === 'number' ? Math.floor(header.limit) : DEFAULT_HISTORY;
        const limit = Math.max(1, Math.min(MAX_HISTORY, requested));
        const history = conv === SYSTEM_CONV ? { messages: [], hasMore: false } : await this.host.history(conv, limit);
        this.reply(link, { t: 'history', conv, messages: history.messages, hasMore: history.hasMore });
        return;
      }
      case 'create_agent': {
        const name = header.name;
        if (!this.host.createAgent || typeof name !== 'string' || name.trim().length === 0) {
          this.fail(link, ref, 'unsupported', 'Agent creation is not available');
          return;
        }
        try {
          const created = await this.host.createAgent(name.trim(), typeof header.description === 'string' ? header.description : undefined);
          this.reply(link, { t: 'agent', agent: toAgent(created) });
          await this.sendCatalog(link);
        } catch (err) {
          this.log.warn('wizzle: agent creation failed', { err });
          this.fail(link, ref, 'create_failed', err instanceof Error ? err.message : 'Agent creation failed');
        }
        return;
      }
      case 'create_conversation': {
        if (!this.host.createConversation) {
          this.fail(link, ref, 'unsupported', 'Topics are not available');
          return;
        }
        const agentId = header.agentId;
        const title = typeof header.title === 'string' ? header.title.trim() : '';
        if (typeof agentId !== 'string' || agentId.length === 0) {
          this.fail(link, ref, 'bad_request', 'create_conversation needs agentId and title');
          return;
        }
        if (title.length === 0 || title.length > MAX_TITLE_CHARS) {
          this.fail(link, ref, 'bad_request', `A title is 1 to ${MAX_TITLE_CHARS} characters`);
          return;
        }
        try {
          const created = await this.host.createConversation(agentId, title);
          this.broadcast({ t: 'conversation', conversation: toConversation(created), id: randomUUID() });
          await this.broadcastCatalog();
        } catch (err) {
          this.log.warn('wizzle: topic creation failed', { err });
          this.failHost(link, ref, err, 'create_failed', 'Topic creation failed');
        }
        return;
      }
      case 'rename_conversation': {
        if (!this.host.renameConversation) {
          this.fail(link, ref, 'unsupported', 'Topics are not available');
          return;
        }
        const conv = header.conv;
        const title = typeof header.title === 'string' ? header.title.trim() : '';
        if (typeof conv !== 'string' || conv.length === 0) {
          this.fail(link, ref, 'bad_request', 'rename_conversation needs conv and title');
          return;
        }
        if (title.length === 0 || title.length > MAX_TITLE_CHARS) {
          this.fail(link, ref, 'bad_request', `A title is 1 to ${MAX_TITLE_CHARS} characters`);
          return;
        }
        if (conv === SYSTEM_CONV) {
          this.fail(link, ref, 'read_only', 'The System conversation cannot be renamed');
          return;
        }
        if (!(await this.knownConv(conv))) {
          this.fail(link, ref, 'unknown_conv', 'No such conversation');
          return;
        }
        try {
          const renamed = await this.host.renameConversation(conv, title);
          this.broadcast({ t: 'conversation', conversation: toConversation(renamed), id: randomUUID() });
          await this.broadcastCatalog();
        } catch (err) {
          this.log.warn('wizzle: topic rename failed', { err });
          this.failHost(link, ref, err, 'rename_failed', 'Topic rename failed');
        }
        return;
      }
      case 'delete_conversation': {
        if (!this.host.deleteConversation) {
          this.fail(link, ref, 'unsupported', 'Topics are not available');
          return;
        }
        const conv = header.conv;
        if (typeof conv !== 'string' || conv.length === 0) {
          this.fail(link, ref, 'bad_request', 'delete_conversation needs conv');
          return;
        }
        if (conv === SYSTEM_CONV) {
          this.fail(link, ref, 'read_only', 'The System conversation cannot be deleted');
          return;
        }
        if (!(await this.knownConv(conv))) {
          this.fail(link, ref, 'unknown_conv', 'No such conversation');
          return;
        }
        try {
          const result = await this.host.deleteConversation(conv);
          for (const questionId of result?.questionIds ?? []) {
            this.questionConv.delete(questionId);
            this.broadcast({ t: 'question_resolved', questionId, id: randomUUID() });
          }
          this.awaiting.delete(conv);
          this.lastActivity.delete(conv);
          this.broadcast({ t: 'conversation_deleted', conv, id: randomUUID() });
          await this.broadcastCatalog();
        } catch (err) {
          this.log.warn('wizzle: topic delete failed', { err });
          this.failHost(link, ref, err, 'delete_failed', 'Topic delete failed');
        }
        return;
      }
      case 'clear':
      case 'abort':
      case 'tasks':
      case 'run_task':
        this.fail(link, ref, 'unsupported', `${header.t} is not supported by this runtime yet`);
        return;
      default:
        this.fail(link, ref, 'unknown', `Unknown packet type ${header.t}`);
    }
  }

  private markAwaitingForQuestion(questionId: string): void {
    const conv = this.questionConv.get(questionId);
    if (!conv) return;
    this.awaiting.add(conv);
    this.lastActivity.delete(conv);
  }

  private dropUpload(link: Link, uploadId: string): void {
    const upload = link.uploads.get(uploadId);
    if (!upload) return;
    link.uploads.delete(uploadId);
    link.uploadBytes -= upload.bytes.length;
  }

  private pruneUploads(link: Link): void {
    const cutoff = Date.now() - UPLOAD_TTL_MS;
    for (const [id, upload] of link.uploads) if (upload.at < cutoff) this.dropUpload(link, id);
  }
}

function activity_packet(activity: Activity): BridgeMessage {
  return { t: 'activity', activity };
}

function toConversation(conv: HostConversation): Conversation {
  return {
    id: conv.conv,
    agentId: conv.agentId,
    title: conv.title,
    ...(conv.lastAt && { lastAt: conv.lastAt }),
    ...(conv.topic && { topic: true }),
    ...(conv.createdAt && { createdAt: conv.createdAt }),
  };
}

function toAgent(agent: HostAgent): Agent {
  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    ...(agent.description && { description: agent.description }),
    ...(agent.model && { model: agent.model }),
  };
}

function normalizeOption(raw: unknown): QuestionOption | null {
  if (typeof raw === 'string') return { label: raw, value: raw };
  if (!isRecord(raw) || typeof raw.label !== 'string') return null;
  const value = typeof raw.value === 'string' ? raw.value : raw.label;
  const style = raw.style === 'primary' || raw.style === 'danger' || raw.style === 'default' ? raw.style : undefined;
  return { label: raw.label, value, ...(style && { style }) };
}

export function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!isRecord(content)) return null;
  if (typeof content.text === 'string') return content.text;
  if (typeof content.markdown === 'string') return content.markdown;
  return null;
}
