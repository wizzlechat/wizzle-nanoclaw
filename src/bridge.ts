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
  type Secret,
  type SecretChanges,
  type SecretInjection,
  type SecretInput,
  type SecretType,
  type SessionState,
  type TemplateInfo,
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
const MAX_PURPOSE_CHARS = 4000;
// OneCLI's own limits on a secret's fields.
const MAX_SECRET_NAME = 255;
const MAX_SECRET_FIELD = 1000;
const MAX_SECRET_VALUE = 10_000;
const MAX_AGENT_SECRETS = 64;
const SECRET_TYPES: SecretType[] = ['generic', 'anthropic', 'openai'];
const MSG_ID = /^[A-Za-z0-9_-]{1,64}$/;
// NanoClaw refreshes typing every 4 seconds while the agent works; this long without one means it stopped.
const ACTIVITY_SILENCE_MS = 12_000;

export type HostAgent = { id: string; name: string; conv: string; status: Agent['status']; model?: string; description?: string; lastAt?: number };
export type HostHistory = { messages: ChatMessage[]; hasMore: boolean };
export type HostActivity = { running: boolean; tool?: string; toolStartedAt?: number; timeoutMs?: number };
export type HostQuestion = { title: string; question?: string; options: QuestionOption[] };
export type HostConversation = { conv: string; agentId: string; title: string; lastAt?: number; topic: boolean; createdAt?: number };
export type HostDeleted = { questionIds?: string[] };
// Everything the phone can put in one create_agent, already validated by the bridge.
export type HostCreateAgent = { name: string; purpose?: string; template?: string; copyFrom?: string; timezone?: string; secrets?: string[] };

// What the bridge needs from the runtime. The NanoClaw adapter implements it on the host DB.
export interface BridgeHost {
  readonly runtime: string;
  readonly runtimeVersion?: string;
  readonly hostName: string;
  listAgents(): Promise<HostAgent[]>;
  history(conv: string, limit: number): Promise<HostHistory>;
  activity(conv: string): Promise<HostActivity>;
  questionRender(questionId: string): Promise<HostQuestion | undefined>;
  createAgent?(request: HostCreateAgent): Promise<HostAgent>;
  listTemplates?(): Promise<TemplateInfo[]>;
  listConversations?(): Promise<HostConversation[]>;
  createConversation?(agentId: string, title: string): Promise<HostConversation>;
  renameConversation?(conv: string, title: string): Promise<HostConversation>;
  deleteConversation?(conv: string): Promise<HostDeleted | void>;
  // Drops the conversation's session, so its history and the agent's context go and the conversation stays.
  clearConversation?(conv: string): Promise<HostDeleted | void>;
  // Pause answers with the open questions it cancelled, so the phone can close them.
  pauseAgent?(agentId: string): Promise<HostDeleted | void>;
  resumeAgent?(agentId: string): Promise<void>;
  restartAgent?(agentId: string, message?: string): Promise<void>;
  deleteAgent?(agentId: string, removeWorkspace: boolean): Promise<HostDeleted | void>;
  // The credential vault; a value goes in and never comes back out.
  listSecrets?(): Promise<Secret[]>;
  createSecret?(input: SecretInput): Promise<Secret>;
  updateSecret?(secretId: string, changes: SecretChanges): Promise<Secret>;
  deleteSecret?(secretId: string): Promise<void>;
  listAgentSecrets?(agentId: string): Promise<string[]>;
  attachSecret?(agentId: string, secretId: string): Promise<void>;
  detachSecret?(agentId: string, secretId: string): Promise<void>;
}

export type InboundAttachment = { name: string; mimeType: string; size: number; data: string };
// msgId is the phone's own id for the message, kept so history can hand it back.
export type InboundText = { id: string; msgId: string; text: string; attachments?: InboundAttachment[] };

// Callbacks into the runtime's inbound path, filled in by the adapter's setup().
export type BridgeHooks = {
  onInbound(conv: string, message: InboundText): void;
  onAction(questionId: string, value: string): void;
};

export type OutboundFile = { filename: string; data: Uint8Array };
// id is the runtime's own id for the message; it becomes the msgId so history and live rows match.
export type Outbound = { kind: string; content: unknown; files?: OutboundFile[]; id?: string };

export type PairingLink = {
  id: string;
  relayUrl: string;
  pairingId: Uint8Array;
  relaySecret: Uint8Array;
  pairedSecret?(): Uint8Array | null;
  session: Session;
  transport: Transport;
  persist(state: SessionState): void;
  onPaired?(): void;
  onFatal?(code: string, message: string): void;
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
  private readonly silence = new Map<string, ReturnType<typeof setTimeout>>();
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
      clearSession: typeof opts.host.clearConversation === 'function',
      abort: false,
      createAgent: typeof opts.host.createAgent === 'function',
      templates: typeof opts.host.listTemplates === 'function',
      topics:
        typeof opts.host.listConversations === 'function' &&
        typeof opts.host.createConversation === 'function' &&
        typeof opts.host.renameConversation === 'function' &&
        typeof opts.host.deleteConversation === 'function',
      lifecycle:
        typeof opts.host.pauseAgent === 'function' &&
        typeof opts.host.resumeAgent === 'function' &&
        typeof opts.host.restartAgent === 'function',
      deleteAgent: typeof opts.host.deleteAgent === 'function',
      keys: [
        opts.host.listSecrets,
        opts.host.createSecret,
        opts.host.updateSecret,
        opts.host.deleteSecret,
        opts.host.listAgentSecrets,
        opts.host.attachSecret,
        opts.host.detachSecret,
      ].every((method) => typeof method === 'function'),
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
        pairing.onFatal?.(code, message);
      },
      ...(pairing.pairedSecret && { pairedSecret: pairing.pairedSecret }),
      ...(pairing.onPaired && { onPaired: pairing.onPaired }),
      ...(pairing.reconnect && { reconnect: pairing.reconnect }),
    };
    link.client = new RelayClient(options);
    this.links.set(pairing.id, link);
    if (this.hooks) link.client.start();
    return link.client;
  }

  // With revoke the relay forgets the pairing and the phone is cut off; without it only this side stops.
  removePairing(id: string, revoke: boolean): void {
    const link = this.links.get(id);
    if (!link) return;
    this.links.delete(id);
    if (revoke) link.client.revoke();
    else link.client.stop();
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
    let wake = false;
    const emit = (packet: BridgeMessage, body?: Uint8Array) => {
      const id = randomUUID();
      this.broadcast({ ...packet, id } as Packet<BridgeMessage>, body);
      if (packet.t === 'message' || packet.t === 'card' || packet.t === 'file') wake = true;
      return id;
    };
    const finishTurn = () => {
      this.awaiting.delete(conv);
      this.clearSilence(conv);
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
      this.wakePhone();
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
      const msgId = message.id ?? randomUUID();
      emit({ t: 'card', conv, msgId, card: content.card, fallbackText, at });
      firstId ??= msgId;
    } else {
      const text = extractText(content);
      if (text !== null && text.length > 0) {
        const msgId = message.id ?? randomUUID();
        emit({ t: 'message', message: { conv, msgId, role: 'agent', text, format: 'markdown', at } });
        firstId ??= msgId;
      }
    }

    (message.files ?? []).forEach((file, index) => {
      if (file.data.length > MAX_FILE_BYTES) {
        emit({
          t: 'message',
          message: { conv, msgId: randomUUID(), role: 'system', text: `Attachment ${file.filename} skipped: larger than 16 MiB.`, format: 'text', at },
        });
        return;
      }
      const msgId = message.id !== undefined ? `${message.id}:f${index}` : randomUUID();
      const meta: FileMeta = { name: file.filename, mime: mimeFor(file.filename), size: file.data.length };
      emit({ t: 'file', conv, msgId, file: meta, at }, file.data);
      firstId ??= msgId;
    });

    if (firstId !== undefined) finishTurn();
    if (wake) this.wakePhone();
    return firstId;
  }

  // A host authored line in one conversation. The phone shows it as a system row.
  notify(conv: string, text: string): void {
    const message: ChatMessage = { conv, msgId: randomUUID(), role: 'system', text, format: 'text', at: Date.now() };
    this.broadcast({ t: 'message', message, id: randomUUID() });
    this.wakePhone();
  }

  // One push request per link whose phone is away; the relay decides whether to push.
  private wakePhone(): void {
    for (const link of this.links.values()) if (!link.client.peerOnline) link.client.requestPush();
  }

  // Runtime typing signal. Only sent while a phone is online, and only when it changes.
  async typing(conv: string, status?: string, statusKind?: 'auto' | 'agent'): Promise<void> {
    if (!this.awaiting.has(conv) && statusKind !== 'agent') return;
    if (!this.peerOnline) return;
    const host = await this.host.activity(conv);
    // The reply can be delivered during the read; a "thinking" sent after its idle would never clear.
    if (!this.awaiting.has(conv) && statusKind !== 'agent') return;
    const activity: Activity = {
      conv,
      state: host.tool ? 'tool' : 'thinking',
      ...(host.tool && { tool: host.tool }),
      ...(statusKind === 'agent' && status && { label: status }),
      ...(host.toolStartedAt && { startedAt: host.toolStartedAt }),
      ...(host.timeoutMs && { timeoutMs: host.timeoutMs }),
    };
    this.sendActivity(activity);
    this.armSilence(conv);
  }

  // Only an activity that reached a phone counts as sent, so a repeat after a reconnect is not swallowed.
  private sendActivity(activity: Activity): void {
    if (!this.peerOnline) return;
    const key = JSON.stringify(activity);
    if (this.lastActivity.get(activity.conv) === key) return;
    this.lastActivity.set(activity.conv, key);
    this.broadcast({ ...activity_packet(activity), id: randomUUID() });
  }

  // A turn that ends without a reply (a reaction, an edit) sends no idle, so typing going quiet stands in for it.
  private armSilence(conv: string): void {
    this.clearSilence(conv);
    const timer = setTimeout(() => {
      this.silence.delete(conv);
      this.sendActivity({ conv, state: 'idle' });
    }, ACTIVITY_SILENCE_MS);
    timer.unref?.();
    this.silence.set(conv, timer);
  }

  private clearSilence(conv: string): void {
    clearTimeout(this.silence.get(conv));
    this.silence.delete(conv);
  }

  // A new turn, or the end of one, starts the conversation's activity over.
  private resetActivity(conv: string): void {
    this.lastActivity.delete(conv);
    this.clearSilence(conv);
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
    const conversations: Conversation[] = [];
    for (const conv of await this.refreshConvs(agents)) {
      const lastAgentAt = await this.lastAgentAt(conv.conv);
      conversations.push({ ...toConversation(conv), ...(lastAgentAt !== undefined && { lastAgentAt }) });
    }
    conversations.push({ id: SYSTEM_CONV, agentId: SYSTEM_AGENT.id, title: SYSTEM_AGENT.name });
    this.reply(link, { t: 'conversations', conversations });
  }

  // Read from the page a phone's history request gets, so a phone holding that page never needs to ask again.
  private async lastAgentAt(conv: string): Promise<number | undefined> {
    let messages: ChatMessage[];
    try {
      messages = (await this.host.history(conv, DEFAULT_HISTORY)).messages;
    } catch (err) {
      this.log.warn('wizzle: history unreadable for the catalog', { conv, err });
      return undefined;
    }
    let at: number | undefined;
    for (const message of messages) if (message.role === 'agent' && (at === undefined || message.at > at)) at = message.at;
    return at;
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
        // Only a reply still pending is activity; a running container can sit idle for half an hour.
        for (const conv of [...this.awaiting]) {
          const host = await this.host.activity(conv);
          if (!host.running) continue;
          const activity: Activity = { conv, state: host.tool ? 'tool' : 'thinking', ...(host.tool && { tool: host.tool }) };
          this.reply(link, activity_packet(activity));
          this.lastActivity.set(conv, JSON.stringify(activity));
          this.armSilence(conv);
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
        if (!MSG_ID.test(msgId)) {
          this.fail(link, ref, 'bad_request', 'msgId is 1 to 64 characters of letters, digits, _ or -');
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
        // Fresh, because the agent may have been paused from the host CLI since the last catalog.
        const ownerId = this.convs.find((c) => c.conv === conv)?.agentId;
        const owner = (await this.refreshAgents()).find((a) => a.id === ownerId);
        if (owner?.status === 'paused') {
          this.fail(link, ref, 'paused', `${owner.name} is paused. Resume it to send messages.`);
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
        const message: InboundText = { id: `wizzle-${randomUUID()}`, msgId, text, ...(attachments.length > 0 && { attachments }) };
        hooks.onInbound(conv, message);
        this.awaiting.add(conv);
        this.resetActivity(conv);
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
        if (!this.host.createAgent) {
          this.fail(link, ref, 'unsupported', 'Agent creation is not available');
          return;
        }
        const name = typeof header.name === 'string' ? header.name.trim() : '';
        if (name.length === 0) {
          this.fail(link, ref, 'bad_request', 'create_agent needs a name');
          return;
        }
        // `description` is what an older phone calls the purpose.
        const rawPurpose = optionalText(header.purpose) ?? optionalText(header.description);
        if (rawPurpose !== undefined && rawPurpose.length > MAX_PURPOSE_CHARS) {
          this.fail(link, ref, 'too_long', `A purpose is at most ${MAX_PURPOSE_CHARS} characters`);
          return;
        }
        const template = optionalText(header.template);
        const copyFrom = optionalText(header.copyFrom);
        if (template !== undefined && copyFrom !== undefined) {
          this.fail(link, ref, 'bad_request', 'create_agent takes a template or a copyFrom, not both');
          return;
        }
        const secrets = secretIds(header.secrets);
        if (secrets === null) {
          this.fail(link, ref, 'bad_request', `secrets is a list of at most ${MAX_AGENT_SECRETS} secret ids`);
          return;
        }
        if (secrets.length > 0 && !this.capabilities.keys) {
          this.fail(link, ref, 'unsupported', 'Keys are not available');
          return;
        }
        const request: HostCreateAgent = {
          name,
          ...(rawPurpose !== undefined && { purpose: rawPurpose }),
          ...(template !== undefined && { template }),
          ...(copyFrom !== undefined && { copyFrom }),
          ...(optionalText(header.timezone) !== undefined && { timezone: optionalText(header.timezone) as string }),
          ...(secrets.length > 0 && { secrets }),
        };
        try {
          const created = await this.host.createAgent(request);
          this.reply(link, { t: 'agent', agent: toAgent(created) });
          await this.broadcastCatalog();
        } catch (err) {
          this.log.warn('wizzle: agent creation failed', { err });
          this.failHost(link, ref, err, 'create_failed', 'Agent creation failed');
        }
        return;
      }
      case 'templates': {
        if (!this.host.listTemplates) {
          this.fail(link, ref, 'unsupported', 'Templates are not available');
          return;
        }
        try {
          this.reply(link, { t: 'templates', templates: await this.host.listTemplates() });
        } catch (err) {
          this.log.warn('wizzle: listing templates failed', { err });
          this.failHost(link, ref, err, 'create_failed', 'Templates could not be listed');
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
          this.resetActivity(conv);
          this.broadcast({ t: 'conversation_deleted', conv, id: randomUUID() });
          await this.broadcastCatalog();
        } catch (err) {
          this.log.warn('wizzle: topic delete failed', { err });
          this.failHost(link, ref, err, 'delete_failed', 'Topic delete failed');
        }
        return;
      }
      case 'clear': {
        if (!this.host.clearConversation) {
          this.fail(link, ref, 'unsupported', 'Clearing a conversation is not available');
          return;
        }
        const conv = header.conv;
        if (typeof conv !== 'string' || conv.length === 0) {
          this.fail(link, ref, 'bad_request', 'clear needs conv');
          return;
        }
        if (conv === SYSTEM_CONV) {
          this.fail(link, ref, 'read_only', 'The System conversation cannot be cleared');
          return;
        }
        if (!(await this.knownConv(conv))) {
          this.fail(link, ref, 'unknown_conv', 'No such conversation');
          return;
        }
        try {
          const result = await this.host.clearConversation(conv);
          for (const questionId of result?.questionIds ?? []) {
            this.questionConv.delete(questionId);
            this.broadcast({ t: 'question_resolved', questionId, id: randomUUID() });
          }
          this.awaiting.delete(conv);
          this.resetActivity(conv);
          this.broadcast({ t: 'session', conv, event: 'cleared', id: randomUUID() });
          await this.broadcastCatalog();
        } catch (err) {
          this.log.warn('wizzle: conversation clear failed', { err });
          this.failHost(link, ref, err, 'clear_failed', 'Clearing the conversation failed');
        }
        return;
      }
      case 'pause_agent':
      case 'resume_agent':
      case 'restart_agent': {
        const agent = await this.lifecycleTarget(link, ref, header.t, header.agentId);
        if (!agent) return;
        try {
          if (header.t === 'pause_agent') {
            const result = await this.host.pauseAgent?.(agent.id);
            this.closeQuestions(result?.questionIds ?? []);
            for (const c of this.convs) if (c.agentId === agent.id) this.settle(c.conv);
          } else if (header.t === 'resume_agent') {
            await this.host.resumeAgent?.(agent.id);
          } else {
            if (agent.status === 'paused') {
              this.fail(link, ref, 'bad_request', `Resume ${agent.name} before restarting it`);
              return;
            }
            const message = optionalText(header.message);
            if (message !== undefined && message.length > MAX_TEXT_CHARS) {
              this.fail(link, ref, 'too_long', `Messages are limited to ${MAX_TEXT_CHARS} characters`);
              return;
            }
            await this.host.restartAgent?.(agent.id, message);
          }
          const fresh = (await this.refreshAgents()).find((a) => a.id === agent.id);
          if (fresh) this.broadcast({ t: 'agent', agent: toAgent(fresh), id: randomUUID() });
        } catch (err) {
          this.log.warn('wizzle: agent lifecycle failed', { t: header.t, agentId: agent.id, err });
          const fallback = header.t === 'restart_agent' ? 'restart_failed' : 'lifecycle_failed';
          this.failHost(link, ref, err, fallback, `${agent.name} could not be changed`);
        }
        return;
      }
      case 'delete_agent': {
        if (typeof header.removeWorkspace !== 'boolean') {
          this.fail(link, ref, 'bad_request', 'delete_agent needs agentId and removeWorkspace');
          return;
        }
        const agent = await this.lifecycleTarget(link, ref, header.t, header.agentId);
        if (!agent) return;
        try {
          const result = await this.host.deleteAgent?.(agent.id, header.removeWorkspace);
          this.closeQuestions(result?.questionIds ?? []);
          for (const c of this.convs) if (c.agentId === agent.id) this.settle(c.conv);
          for (const [questionId, conv] of this.questionConv) {
            if (this.convs.some((c) => c.conv === conv && c.agentId === agent.id)) this.questionConv.delete(questionId);
          }
          this.convs = this.convs.filter((c) => c.agentId !== agent.id);
          this.agents = this.agents.filter((a) => a.id !== agent.id);
          this.broadcast({ t: 'agent_deleted', agentId: agent.id, id: randomUUID() });
          await this.broadcastCatalog();
        } catch (err) {
          this.log.warn('wizzle: agent delete failed', { agentId: agent.id, err });
          this.failHost(link, ref, err, 'delete_failed', `${agent.name} could not be deleted`);
        }
        return;
      }
      case 'secrets':
      case 'create_secret':
      case 'update_secret':
      case 'delete_secret':
        await this.handleSecret(link, ref, header);
        return;
      case 'agent_secrets':
      case 'attach_secret':
      case 'detach_secret':
        await this.handleAgentSecret(link, ref, header);
        return;
      case 'abort':
      case 'tasks':
      case 'run_task':
        this.fail(link, ref, 'unsupported', `${header.t} is not supported by this runtime yet`);
        return;
      default:
        this.fail(link, ref, 'unknown', `Unknown packet type ${header.t}`);
    }
  }

  private async handleSecret(link: Link, ref: string | undefined, header: Record<string, unknown>): Promise<void> {
    const host = this.host;
    if (!this.capabilities.keys || !host.listSecrets || !host.createSecret || !host.updateSecret || !host.deleteSecret) {
      this.fail(link, ref, 'unsupported', 'Keys are not available');
      return;
    }
    try {
      if (header.t === 'secrets') {
        this.reply(link, { t: 'secrets', secrets: await host.listSecrets() });
        return;
      }
      if (header.t === 'create_secret') {
        const input = secretInput(header.secret);
        if (typeof input === 'string') {
          this.fail(link, ref, 'bad_request', input);
          return;
        }
        this.reply(link, { t: 'secret', ...(ref !== undefined && { ref }), secret: await host.createSecret(input) });
        await this.broadcastSecrets();
        return;
      }
      const secretId = optionalText(header.secretId);
      if (secretId === undefined) {
        this.fail(link, ref, 'bad_request', `${String(header.t)} needs secretId`);
        return;
      }
      if (header.t === 'update_secret') {
        const changes = secretChanges(header.changes);
        if (typeof changes === 'string') {
          this.fail(link, ref, 'bad_request', changes);
          return;
        }
        this.reply(link, { t: 'secret', ...(ref !== undefined && { ref }), secret: await host.updateSecret(secretId, changes) });
        await this.broadcastSecrets();
        return;
      }
      await host.deleteSecret(secretId);
      this.broadcast({ t: 'secret_deleted', secretId, id: randomUUID() });
      await this.broadcastSecrets();
    } catch (err) {
      this.log.warn('wizzle: key request failed', { t: header.t, err });
      this.failHost(link, ref, err, 'keys_failed', 'The key request failed');
    }
  }

  private async handleAgentSecret(link: Link, ref: string | undefined, header: Record<string, unknown>): Promise<void> {
    const host = this.host;
    if (!this.capabilities.keys || !host.listAgentSecrets || !host.attachSecret || !host.detachSecret) {
      this.fail(link, ref, 'unsupported', 'Keys are not available');
      return;
    }
    const agentId = optionalText(header.agentId);
    if (agentId === undefined) {
      this.fail(link, ref, 'bad_request', `${String(header.t)} needs agentId`);
      return;
    }
    if (agentId === SYSTEM_AGENT.id) {
      this.fail(link, ref, 'bad_request', 'The System agent has no keys');
      return;
    }
    const agent = (await this.refreshAgents()).find((a) => a.id === agentId);
    if (!agent) {
      this.fail(link, ref, 'unknown_agent', 'No such agent');
      return;
    }
    try {
      if (header.t === 'agent_secrets') {
        this.reply(link, { t: 'agent_secrets', agentId, secretIds: await host.listAgentSecrets(agentId) });
        return;
      }
      const secretId = optionalText(header.secretId);
      if (secretId === undefined) {
        this.fail(link, ref, 'bad_request', `${String(header.t)} needs agentId and secretId`);
        return;
      }
      if (header.t === 'attach_secret') await host.attachSecret(agentId, secretId);
      else await host.detachSecret(agentId, secretId);
      this.broadcast({ t: 'agent_secrets', agentId, secretIds: await host.listAgentSecrets(agentId), id: randomUUID() });
    } catch (err) {
      this.log.warn('wizzle: agent key request failed', { t: header.t, agentId, err });
      this.failHost(link, ref, err, 'keys_failed', `${agent.name}'s keys could not be changed`);
    }
  }

  // Every phone sees the vault change; a listing that fails here leaves the phones' copy until they ask again.
  private async broadcastSecrets(): Promise<void> {
    try {
      this.broadcast({ t: 'secrets', secrets: (await this.host.listSecrets?.()) ?? [], id: randomUUID() });
    } catch (err) {
      this.log.warn('wizzle: listing keys after a change failed', { err });
    }
  }

  // Checks the capability and the agent for a lifecycle packet; answers the phone itself on a refusal.
  private async lifecycleTarget(link: Link, ref: string | undefined, t: string, agentId: unknown): Promise<HostAgent | null> {
    const methods: Record<string, unknown> = {
      pause_agent: this.host.pauseAgent,
      resume_agent: this.host.resumeAgent,
      restart_agent: this.host.restartAgent,
      delete_agent: this.host.deleteAgent,
    };
    const flag = t === 'delete_agent' ? this.capabilities.deleteAgent : this.capabilities.lifecycle;
    if (!flag || typeof methods[t] !== 'function') {
      this.fail(link, ref, 'unsupported', `${t} is not supported by this runtime`);
      return null;
    }
    if (typeof agentId !== 'string' || agentId.length === 0) {
      this.fail(link, ref, 'bad_request', `${t} needs agentId`);
      return null;
    }
    if (agentId === SYSTEM_AGENT.id) {
      this.fail(link, ref, 'bad_request', 'The System agent cannot be paused, restarted or deleted');
      return null;
    }
    const agent = (await this.refreshAgents()).find((a) => a.id === agentId);
    if (!agent) {
      this.fail(link, ref, 'unknown_agent', 'No such agent');
      return null;
    }
    return agent;
  }

  private closeQuestions(questionIds: string[]): void {
    for (const questionId of questionIds) {
      this.questionConv.delete(questionId);
      this.broadcast({ t: 'question_resolved', questionId, id: randomUUID() });
    }
  }

  // A stopped agent will not finish its turn, so the conversation stops waiting on it.
  private settle(conv: string): void {
    this.awaiting.delete(conv);
    this.resetActivity(conv);
  }

  private markAwaitingForQuestion(questionId: string): void {
    const conv = this.questionConv.get(questionId);
    if (!conv) return;
    this.awaiting.add(conv);
    this.resetActivity(conv);
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

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

// Undefined is no list; null is a list the bridge refuses.
function secretIds(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_AGENT_SECRETS) return null;
  const ids = value.map(optionalText);
  if (ids.some((id) => id === undefined || id.length > MAX_SECRET_FIELD)) return null;
  return [...new Set(ids as string[])];
}

function boundedText(value: unknown, max: number): string | undefined {
  const text = optionalText(value);
  return text !== undefined && text.length <= max ? text : undefined;
}

// Exactly one of OneCLI's four shapes; a string is the reason it is refused.
function secretInjection(value: unknown): SecretInjection | string {
  if (!isRecord(value)) return 'injection must be an object';
  const keys = Object.keys(value).sort().join(',');
  const field = (name: string) => boundedText(value[name], MAX_SECRET_FIELD);
  const format = (name: string) => (value[name] === undefined ? undefined : field(name));
  if (keys === 'headerName' || keys === 'headerName,valueFormat') {
    const headerName = field('headerName');
    const valueFormat = format('valueFormat');
    if (headerName === undefined || (value.valueFormat !== undefined && valueFormat === undefined)) return 'A header needs a name';
    return { headerName, ...(valueFormat !== undefined && { valueFormat }) };
  }
  if (keys === 'paramName' || keys === 'paramFormat,paramName') {
    const paramName = field('paramName');
    const paramFormat = format('paramFormat');
    if (paramName === undefined || (value.paramFormat !== undefined && paramFormat === undefined)) return 'A parameter needs a name';
    return { paramName, ...(paramFormat !== undefined && { paramFormat }) };
  }
  if (keys === 'pathTemplate') {
    const pathTemplate = field('pathTemplate');
    return pathTemplate === undefined ? 'A path template cannot be empty' : { pathTemplate };
  }
  if (keys === 'pathRegex,pathReplacement') {
    const pathRegex = field('pathRegex');
    const pathReplacement = field('pathReplacement');
    if (pathRegex === undefined || pathReplacement === undefined) return 'A path regex needs a pattern and a replacement';
    return { pathRegex, pathReplacement };
  }
  return 'injection is a header, a parameter, a path template or a path regex';
}

function secretInput(value: unknown): SecretInput | string {
  if (!isRecord(value)) return 'create_secret needs a secret';
  const name = boundedText(value.name, MAX_SECRET_NAME);
  const host = boundedText(value.host, MAX_SECRET_FIELD);
  const type = SECRET_TYPES.find((one) => one === value.type);
  // The value is kept as typed; a key can end in whitespace.
  const secret = typeof value.value === 'string' && value.value.length > 0 && value.value.length <= MAX_SECRET_VALUE ? value.value : undefined;
  if (name === undefined || host === undefined || type === undefined || secret === undefined) {
    return `A key needs a name, a type, a host and a value of at most ${MAX_SECRET_VALUE} characters`;
  }
  const path = value.path === undefined ? undefined : boundedText(value.path, MAX_SECRET_FIELD);
  if (value.path !== undefined && path === undefined) return 'path must be text';
  const injection = value.injection === undefined ? undefined : secretInjection(value.injection);
  if (typeof injection === 'string') return injection;
  return { name, type, host, value: secret, ...(path !== undefined && { path }), ...(injection !== undefined && { injection }) };
}

function secretChanges(value: unknown): SecretChanges | string {
  if (!isRecord(value)) return 'update_secret needs changes';
  const changes: SecretChanges = {};
  if (value.name !== undefined) {
    const name = boundedText(value.name, MAX_SECRET_NAME);
    if (name === undefined) return `A name is 1 to ${MAX_SECRET_NAME} characters`;
    changes.name = name;
  }
  if (value.host !== undefined) {
    const host = boundedText(value.host, MAX_SECRET_FIELD);
    if (host === undefined) return 'A host cannot be empty';
    changes.host = host;
  }
  if (value.path !== undefined) {
    const path = value.path === null ? null : boundedText(value.path, MAX_SECRET_FIELD);
    if (path === undefined) return 'path is text or null';
    changes.path = path;
  }
  if (value.injection !== undefined) {
    const injection = value.injection === null ? null : secretInjection(value.injection);
    if (typeof injection === 'string') return injection;
    changes.injection = injection;
  }
  if (value.value !== undefined) {
    if (typeof value.value !== 'string' || value.value.length === 0 || value.value.length > MAX_SECRET_VALUE) {
      return `A value is 1 to ${MAX_SECRET_VALUE} characters`;
    }
    changes.value = value.value;
  }
  return Object.keys(changes).length > 0 ? changes : 'update_secret changes nothing';
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
