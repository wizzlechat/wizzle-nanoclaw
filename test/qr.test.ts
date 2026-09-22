import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { encodeQr, renderQr, type QrLevel } from '../src/qr.ts';

function qrencode(text: string, level: QrLevel): boolean[][] | null {
  const run = spawnSync('qrencode', ['-8', '-l', level, '-m', '0', '-t', 'ASCII', text], { encoding: 'utf8' });
  if (run.error || run.status !== 0) return null;
  const rows = run.stdout.split('\n').filter((line) => line.length > 0);
  return rows.map((row) => {
    const cells: boolean[] = [];
    for (let i = 0; i < row.length; i += 2) cells.push(row[i] === '#');
    return cells;
  });
}

function formatMask(modules: boolean[][]): number {
  let bits = 0;
  const bit = (x: number, y: number) => ((modules[y] as boolean[])[x] ? 1 : 0);
  for (let i = 0; i <= 5; i++) bits |= bit(8, i) << i;
  bits |= bit(8, 7) << 6;
  bits |= bit(8, 8) << 7;
  bits |= bit(7, 8) << 8;
  for (let i = 9; i < 15; i++) bits |= bit(14 - i, 8) << i;
  return ((bits ^ 0x5412) >>> 10) & 7;
}

function randomText(length: number, seed: number): string {
  let s = seed;
  let out = '';
  for (let i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out += String.fromCharCode(33 + (s % 94));
  }
  return out;
}

const available = spawnSync('qrencode', ['--version'], { encoding: 'utf8' }).status === 0;

test('matrix matches qrencode for the same mask', { skip: !available && 'qrencode not installed' }, () => {
  const lengths = [1, 7, 17, 25, 34, 50, 77, 100, 120, 150, 180, 210, 230, 270];
  for (const level of ['L', 'M'] as const) {
    for (const [i, length] of lengths.entries()) {
      const text = randomText(length, length * 31 + i + (level === 'M' ? 1000 : 0));
      const reference = qrencode(text, level);
      assert.ok(reference, 'qrencode failed');
      let mine;
      try {
        mine = encodeQr(text, { level, mask: formatMask(reference) });
      } catch {
        assert.ok(reference.length > 57, `encoder refused ${length} bytes at level ${level}`);
        continue;
      }
      assert.equal(mine.size, reference.length, `size for ${length} bytes at level ${level}`);
      assert.deepEqual(mine.modules, reference, `modules for ${length} bytes at level ${level}`);
    }
  }
});

test('invite sized payload matches qrencode', { skip: !available && 'qrencode not installed' }, () => {
  const invite =
    'wizzle://pair?r=wss%3A%2F%2Frelay.example%2Fws&p=Zm9vYmFyYmF6cXV4cXV1eA&s=' +
    'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU&n=Andy&rt=nanoclaw';
  const reference = qrencode(invite, 'L');
  assert.ok(reference);
  const mine = encodeQr(invite, { mask: formatMask(reference) });
  assert.deepEqual(mine.modules, reference);
});

test('auto mask picks a valid mask and renders', () => {
  const qr = encodeQr('wizzle://pair?r=wss%3A%2F%2Fexample&p=abc&s=def');
  assert.ok(qr.size >= 21);
  const utf8 = renderQr(qr);
  assert.equal(utf8.split('\n').length - 1, Math.ceil((qr.size + 4) / 2));
  const ascii = renderQr(qr, 'ascii', 1);
  assert.equal(ascii.split('\n').length - 1, qr.size + 2);
});

test('rejects payloads above version 10', () => {
  assert.throws(() => encodeQr('x'.repeat(300)));
});
