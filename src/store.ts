import fs from 'node:fs';
import path from 'node:path';

import type { ChatMessage, SessionState } from '../../wizzle-protocol/src/index.ts';

// The most messages a room keeps from members that left it.
export const ROOM_ARCHIVE_MAX = 2000;
const ROOM_FILE = /^[a-z0-9]{1,32}$/;

// Byte fields are base64url. expiresAt is the invite's unix seconds; wizzleKey is set once wizzle is pinned.
export type StoredPairing = {
  relay: string;
  pairingId: string;
  secret: string;
  bridgePublic: string;
  bridgePrivate: string;
  expiresAt: number;
  name?: string;
  runtime?: string;
  createdAt: string;
  pairedAt?: string;
  wizzleKey?: string;
};

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// The file and then its folder are flushed, so after a power cut the new file is there, never a torn or older one.
function writeText(file: string, text: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  syncDir(dir);
}

function syncDir(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeJson(file: string, value: unknown): void {
  writeText(file, `${JSON.stringify(value)}\n`);
}

function removeFile(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

// Pairing secret, session counters, and the pending invite for one bridge, under the runtime's data dir.
export class BridgeStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private get pairingFile(): string {
    return path.join(this.dir, 'pairing.json');
  }

  private get sessionFile(): string {
    return path.join(this.dir, 'session.json');
  }

  get inviteFile(): string {
    return path.join(this.dir, 'invite.txt');
  }

  // A pairing from before static keys has no bridge key and reads as no pairing.
  loadPairing(): StoredPairing | null {
    const stored = readJson<StoredPairing>(this.pairingFile);
    if (!stored || typeof stored.pairingId !== 'string' || typeof stored.secret !== 'string') return null;
    if (typeof stored.bridgePublic !== 'string' || typeof stored.bridgePrivate !== 'string' || typeof stored.expiresAt !== 'number') return null;
    return stored;
  }

  savePairing(pairing: StoredPairing): void {
    writeJson(this.pairingFile, pairing);
  }

  markPaired(wizzleKey: string): void {
    const pairing = this.loadPairing();
    if (!pairing || pairing.wizzleKey === wizzleKey) return;
    this.savePairing({ ...pairing, pairedAt: new Date().toISOString(), wizzleKey });
  }

  loadSession(): SessionState | null {
    const state = readJson<SessionState>(this.sessionFile);
    if (!state || !Array.isArray(state.epochs)) return null;
    return state;
  }

  saveSession(state: SessionState): void {
    writeJson(this.sessionFile, state);
  }

  // The invite (QR plus URL) stays on disk until wizzle pairs, so setup can show it.
  saveInvite(text: string): void {
    writeText(this.inviteFile, text);
  }

  clearInvite(): void {
    removeFile(this.inviteFile);
  }

  clear(): void {
    for (const file of [this.pairingFile, this.sessionFile, this.inviteFile]) removeFile(file);
  }

  private roomFile(roomId: string): string {
    if (!ROOM_FILE.test(roomId)) throw new Error(`bad room id ${roomId}`);
    return path.join(this.dir, 'rooms', `${roomId}.json`);
  }

  // What members that left a room said there, kept so the room's history still shows it.
  loadRoomArchive(roomId: string): ChatMessage[] {
    const stored = readJson<{ messages?: unknown }>(this.roomFile(roomId));
    return Array.isArray(stored?.messages) ? (stored.messages as ChatMessage[]) : [];
  }

  saveRoomArchive(roomId: string, messages: ChatMessage[]): void {
    writeJson(this.roomFile(roomId), { messages: messages.slice(-ROOM_ARCHIVE_MAX) });
  }

  dropRoomArchive(roomId: string): void {
    removeFile(this.roomFile(roomId));
  }
}
