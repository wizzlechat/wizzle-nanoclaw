import {
  FRAME_ACK,
  FRAME_DATA,
  FRAME_HS,
  MAX_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  decodeControl,
  decodeFrame,
  encodeControl,
  equal,
  toB64Url,
  type Session,
  type SessionState,
} from '../../wizzle-protocol/src/index.ts';
import type { Transport, TransportConn } from './transport.ts';

export type Logger = {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
};

export type RelayClientOptions = {
  transport: Transport;
  relayUrl: string;
  pairingId: Uint8Array;
  relaySecret: Uint8Array;
  session: Session;
  persist(state: SessionState): void;
  log: Logger;
  onPacket(plaintext: Uint8Array): void;
  onPaired?(): void;
  onPeer?(online: boolean): void;
  onFatal?(code: string, message: string): void;
  reconnect?: { minMs: number; maxMs: number };
};

export type RelayClientState = 'stopped' | 'connecting' | 'open' | 'ready';

type Pending = { epoch: Uint8Array; seq: bigint; bytes: Uint8Array };

const MAX_OUTBOX_FRAMES = 256;
const MAX_OUTBOX_BYTES = 64 * 1024 * 1024;

// One relay connection for one pairing: hello, reconnects, sealing, and resend until acked.
export class RelayClient {
  private readonly opts: RelayClientOptions;
  private conn: TransportConn | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private outbox: Pending[] = [];
  private outboxBytes = 0;
  state: RelayClientState = 'stopped';
  peerOnline = false;

  constructor(opts: RelayClientOptions) {
    this.opts = opts;
  }

  get session(): Session {
    return this.opts.session;
  }

  start(): void {
    if (this.state !== 'stopped') return;
    this.connect();
  }

  stop(): void {
    this.state = 'stopped';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const conn = this.conn;
    this.conn = null;
    conn?.close();
  }

  // Seals and queues a packet. Returns false while no epoch exists yet.
  send(plaintext: Uint8Array): boolean {
    const session = this.opts.session;
    if (!session.ready) return false;
    const bytes = session.seal(plaintext);
    if (bytes.length > MAX_FRAME_BYTES) throw new Error('frame exceeds relay limit');
    // The counter is persisted before the frame leaves so a crash never reuses a nonce.
    this.opts.persist(session.exportState());
    const frame = decodeFrame(bytes);
    this.outbox.push({ epoch: frame.epoch, seq: frame.seq, bytes });
    this.outboxBytes += bytes.length;
    while (this.outbox.length > MAX_OUTBOX_FRAMES || this.outboxBytes > MAX_OUTBOX_BYTES) {
      const dropped = this.outbox.shift();
      if (!dropped) break;
      this.outboxBytes -= dropped.bytes.length;
      this.opts.log.warn('wizzle: outbox full, dropping oldest unacked frame', { seq: dropped.seq.toString() });
    }
    if (this.state === 'ready') this.conn?.sendBinary(bytes);
    return true;
  }

  private connect(): void {
    this.state = 'connecting';
    this.peerOnline = false;
    let conn: TransportConn | null = null;
    conn = this.opts.transport.connect(this.opts.relayUrl, {
      onOpen: () => {
        if (this.conn !== conn) return;
        this.state = 'open';
        conn?.sendText(
          encodeControl({
            t: 'hello',
            v: RELAY_PROTOCOL_VERSION,
            pairing: toB64Url(this.opts.pairingId),
            role: 'bridge',
            secret: toB64Url(this.opts.relaySecret),
          }),
        );
      },
      onText: (text) => {
        if (this.conn === conn) this.handleControl(text);
      },
      onBinary: (bytes) => {
        if (this.conn === conn) this.handleFrame(bytes);
      },
      onClose: (code, reason) => {
        if (this.conn !== conn) return;
        this.conn = null;
        this.peerOnline = false;
        this.opts.onPeer?.(false);
        if (this.state === 'stopped') return;
        this.opts.log.warn('wizzle: relay connection closed', { code, reason });
        this.scheduleReconnect();
      },
    });
    this.conn = conn;
  }

  private scheduleReconnect(): void {
    const { minMs, maxMs } = this.opts.reconnect ?? { minMs: 1000, maxMs: 30_000 };
    const base = Math.min(maxMs, minMs * 2 ** Math.min(this.attempts, 10));
    const delay = Math.round(base * (0.5 + Math.random() * 0.5));
    this.attempts += 1;
    this.state = 'connecting';
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.state !== 'stopped') this.connect();
    }, delay);
  }

  private handleControl(text: string): void {
    let msg;
    try {
      msg = decodeControl(text);
    } catch {
      this.opts.log.warn('wizzle: ignoring malformed relay control message');
      return;
    }
    switch (msg.t) {
      case 'welcome':
        this.state = 'ready';
        this.attempts = 0;
        this.peerOnline = msg.peer;
        this.opts.log.info('wizzle: relay ready', { peer: msg.peer, buffered: msg.buffered });
        for (const pending of this.outbox) this.conn?.sendBinary(pending.bytes);
        this.opts.onPeer?.(msg.peer);
        return;
      case 'peer':
        this.peerOnline = msg.online;
        this.opts.onPeer?.(msg.online);
        return;
      case 'error':
        this.opts.log.error('wizzle: relay error', { code: msg.code, message: msg.message });
        if (msg.code === 'auth' || msg.code === 'revoked') {
          this.stop();
          this.opts.onFatal?.(msg.code, msg.message);
        }
        return;
      default:
        return;
    }
  }

  private handleFrame(bytes: Uint8Array): void {
    let frame;
    try {
      frame = decodeFrame(bytes);
    } catch {
      this.opts.log.warn('wizzle: ignoring malformed frame');
      return;
    }
    const session = this.opts.session;
    if (frame.type === FRAME_HS) {
      let reply: Uint8Array | null;
      try {
        reply = session.handleHandshake(frame);
      } catch (err) {
        this.opts.log.warn('wizzle: rejected handshake frame', { err });
        return;
      }
      this.opts.persist(session.exportState());
      if (reply) this.conn?.sendBinary(reply);
      return;
    }
    if (frame.type === FRAME_ACK) {
      this.trimOutbox(frame.epoch, frame.seq);
      return;
    }
    if (frame.type !== FRAME_DATA) return;
    const result = session.open(frame);
    switch (result.kind) {
      case 'data':
        this.opts.persist(session.exportState());
        this.sendAck();
        this.opts.onPacket(result.plaintext);
        return;
      case 'confirm':
        this.opts.persist(session.exportState());
        if (result.reply) this.conn?.sendBinary(result.reply);
        this.sendAck();
        this.opts.log.info('wizzle: phone session established');
        this.opts.onPaired?.();
        return;
      case 'duplicate':
        this.sendAck();
        return;
      case 'unknownEpoch':
        this.opts.log.warn('wizzle: frame for unknown epoch dropped');
        return;
      case 'badTag':
        this.opts.log.warn('wizzle: frame failed authentication');
        return;
      default:
        return;
    }
  }

  private sendAck(): void {
    const ack = this.opts.session.ack();
    if (ack) this.conn?.sendBinary(ack);
  }

  private trimOutbox(epoch: Uint8Array, seq: bigint): void {
    const kept: Pending[] = [];
    let bytes = 0;
    for (const pending of this.outbox) {
      if (equal(pending.epoch, epoch) && pending.seq <= seq) continue;
      kept.push(pending);
      bytes += pending.bytes.length;
    }
    this.outbox = kept;
    this.outboxBytes = bytes;
  }
}
