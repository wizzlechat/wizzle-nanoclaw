import {
  Session,
  derivePairedRelaySecret,
  derivePsk,
  deriveRelaySecret,
  encodeInvite,
  fromB64Url,
  newInvite,
  toB64Url,
  type CryptoProvider,
  type SessionKeys,
} from '../../wizzle-protocol/src/index.ts';
import type { WizzleBridge } from './bridge.ts';
import { encodeQr, renderQr } from './qr.ts';
import type { Logger } from './relay-client.ts';
import type { BridgeStore, StoredPairing } from './store.ts';
import type { Transport } from './transport.ts';

export const DEFAULT_RELAY_URL = 'wss://relay.wizzle.app';
export const INVITE_TTL_MS = 15 * 60 * 1000;
const LINK_ID = 'default';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// Plain ws only reaches a relay on this machine; anything else has to be wss.
export function isRelayUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === 'wss:' || (url.protocol === 'ws:' && LOOPBACK.has(url.hostname));
  } catch {
    return false;
  }
}

export function inviteText(url: string, expiresAt: number): string {
  const minutes = Math.max(0, Math.round((expiresAt * 1000 - Date.now()) / 60_000));
  return [
    '',
    'wizzle: scan this code with the wizzle app to pair it.',
    '',
    renderQr(encodeQr(url, { level: 'L' }), 'utf8'),
    '',
    `Or paste the invite into the app: ${url}`,
    '',
    `It works once and expires at ${new Date(expiresAt * 1000).toLocaleTimeString()} (in ${minutes} minutes).`,
    '',
  ].join('\n');
}

export type PairingState = 'none' | 'inviting' | 'paired';
export type IssuedInvite = { url: string; expiresAt: number };

export type PairingManagerOptions = {
  bridge: WizzleBridge;
  store: BridgeStore;
  crypto: CryptoProvider;
  transport: Transport;
  log: Logger;
  relay: string;
  name?: string;
  runtime?: string;
  // The host command that shows a new code, named in log lines and refusals.
  pairCommand?: string;
  ttlMs?: number;
  now?(): number;
  announce?(url: string, expiresAt: number): void;
  reconnect?: { minMs: number; maxMs: number };
};

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

// The one pairing of this install: its invite and expiry, the pinned wizzle, and the secret the relay knows it by.
export class PairingManager {
  private readonly opts: PairingManagerOptions;
  private pairing: StoredPairing | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: PairingManagerOptions) {
    this.opts = opts;
  }

  get state(): PairingState {
    if (!this.pairing) return 'none';
    return this.pairing.wizzleKey ? 'paired' : 'inviting';
  }

  // Resumes what is on disk. An invite nobody scanned in time is thrown away.
  start(): void {
    const stored = this.opts.store.loadPairing();
    if (!stored) return;
    if (!stored.wizzleKey && stored.expiresAt * 1000 <= this.now()) {
      this.opts.store.clear();
      this.opts.log.info(`wizzle: the pending invite expired, run ${this.pairCommand} for a new one`);
      return;
    }
    if (stored.relay !== this.opts.relay) {
      this.opts.log.warn(`wizzle: the relay URL changed since pairing, wizzle still dials the old one; run ${this.pairCommand} --replace`, {
        paired: stored.relay,
        configured: this.opts.relay,
      });
    }
    this.open(stored);
    if (!stored.wizzleKey) this.opts.announce?.(this.inviteUrl(stored), stored.expiresAt);
  }

  // A new invite replaces a pending one; replacing a paired wizzle app cuts it off, so that needs replace.
  issue(replace: boolean): IssuedInvite {
    if (this.pairing?.wizzleKey && !replace) {
      throw coded('paired', `A wizzle app is already paired. Run ${this.pairCommand} --replace to unpair it and show a new code.`);
    }
    this.close(true);
    const { crypto } = this.opts;
    const own = crypto.x25519KeyPair();
    const expiresAt = Math.floor((this.now() + (this.opts.ttlMs ?? INVITE_TTL_MS)) / 1000);
    const invite = newInvite(crypto, {
      relay: this.opts.relay,
      bridgeKey: own.publicKey,
      expiresAt,
      ...(this.opts.name !== undefined && { name: this.opts.name }),
      ...(this.opts.runtime !== undefined && { runtime: this.opts.runtime }),
    });
    const pairing: StoredPairing = {
      relay: invite.relay,
      pairingId: toB64Url(invite.pairingId),
      secret: toB64Url(invite.secret),
      bridgePublic: toB64Url(own.publicKey),
      bridgePrivate: toB64Url(own.privateKey),
      expiresAt,
      createdAt: new Date(this.now()).toISOString(),
      ...(invite.name !== undefined && { name: invite.name }),
      ...(invite.runtime !== undefined && { runtime: invite.runtime }),
    };
    this.opts.store.clear();
    this.opts.store.savePairing(pairing);
    this.open(pairing);
    const url = this.inviteUrl(pairing);
    this.opts.announce?.(url, expiresAt);
    return { url, expiresAt };
  }

  // Shutdown only: the relay keeps the pairing so the next start resumes it.
  stop(): void {
    this.close(false);
  }

  // The relay forgets the pairing and the store is emptied; false when there was none.
  unpair(): boolean {
    const had = this.pairing !== null || this.opts.store.loadPairing() !== null;
    this.close(true);
    this.opts.store.clear();
    return had;
  }

  private get pairCommand(): string {
    return this.opts.pairCommand ?? 'ncl wizzle pair';
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private inviteUrl(pairing: StoredPairing): string {
    return encodeInvite({
      relay: pairing.relay,
      pairingId: fromB64Url(pairing.pairingId),
      secret: fromB64Url(pairing.secret),
      bridgeKey: fromB64Url(pairing.bridgePublic),
      expiresAt: pairing.expiresAt,
      ...(pairing.name !== undefined && { name: pairing.name }),
      ...(pairing.runtime !== undefined && { runtime: pairing.runtime }),
    });
  }

  private open(pairing: StoredPairing): void {
    const { crypto, store, log } = this.opts;
    this.pairing = pairing;
    const pairingId = fromB64Url(pairing.pairingId);
    const secret = fromB64Url(pairing.secret);
    const keys: SessionKeys = {
      psk: derivePsk(crypto, secret),
      own: { publicKey: fromB64Url(pairing.bridgePublic), privateKey: fromB64Url(pairing.bridgePrivate) },
      peer: pairing.wizzleKey ? fromB64Url(pairing.wizzleKey) : null,
    };
    let session: Session;
    try {
      session = new Session(crypto, 'bridge', pairingId, keys, store.loadSession() ?? undefined);
    } catch {
      log.warn('wizzle: stored session state unusable, starting fresh');
      session = new Session(crypto, 'bridge', pairingId, keys);
    }
    this.opts.bridge.addPairing({
      id: LINK_ID,
      relayUrl: this.opts.relay,
      pairingId,
      relaySecret: deriveRelaySecret(crypto, secret),
      pairedSecret: () => this.pairedSecret(),
      session,
      transport: this.opts.transport,
      persist: (state) => store.saveSession(state),
      onPaired: () => this.paired(session),
      onFatal: (code) => this.fatal(code),
      ...(this.opts.reconnect && { reconnect: this.opts.reconnect }),
    });
    if (!pairing.wizzleKey) this.armExpiry();
  }

  // Read from the stored pin, so the relay is only told to rekey once the pin is on disk.
  private pairedSecret(): Uint8Array | null {
    const pairing = this.pairing;
    if (!pairing?.wizzleKey) return null;
    return derivePairedRelaySecret(this.opts.crypto, fromB64Url(pairing.pairingId), fromB64Url(pairing.bridgePrivate), fromB64Url(pairing.wizzleKey));
  }

  private paired(session: Session): void {
    const wizzle = session.peerKey;
    if (!wizzle || !this.pairing) return;
    const key = toB64Url(wizzle);
    if (this.pairing.wizzleKey !== key) {
      this.opts.store.markPaired(key);
      this.pairing = { ...this.pairing, wizzleKey: key, pairedAt: new Date(this.now()).toISOString() };
      this.opts.log.info('wizzle: paired');
    }
    this.clearExpiry();
    this.opts.store.clearInvite();
  }

  private fatal(code: string): void {
    if (code === 'revoked') {
      this.opts.log.warn(`wizzle: the wizzle app removed this bridge, run ${this.pairCommand} to pair again`);
      this.close(false);
      this.opts.store.clear();
      return;
    }
    this.opts.log.error(`wizzle: the relay refused this pairing, run ${this.pairCommand} --replace`, { code });
  }

  private armExpiry(): void {
    this.clearExpiry();
    const pairing = this.pairing;
    if (!pairing) return;
    this.expiry = setTimeout(() => {
      this.expiry = null;
      if (this.pairing?.pairingId !== pairing.pairingId || this.pairing.wizzleKey) return;
      this.opts.log.info(`wizzle: the invite expired unused, run ${this.pairCommand} for a new one`);
      this.close(true);
      this.opts.store.clear();
    }, Math.max(0, pairing.expiresAt * 1000 - this.now()));
    this.expiry.unref?.();
  }

  private clearExpiry(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
  }

  private close(revoke: boolean): void {
    this.clearExpiry();
    this.opts.bridge.removePairing(LINK_ID, revoke);
    this.pairing = null;
  }
}
