// Byte mode QR encoder for versions 1 to 10, levels L and M, no dependencies.
export type QrLevel = 'L' | 'M';
export type QrMatrix = { size: number; modules: boolean[][] };

type BlockPlan = { ecPerBlock: number; groups: Array<{ blocks: number; dataCodewords: number }> };

const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

const PLANS: Record<QrLevel, BlockPlan[]> = {
  L: [
    { ecPerBlock: 0, groups: [] },
    { ecPerBlock: 7, groups: [{ blocks: 1, dataCodewords: 19 }] },
    { ecPerBlock: 10, groups: [{ blocks: 1, dataCodewords: 34 }] },
    { ecPerBlock: 15, groups: [{ blocks: 1, dataCodewords: 55 }] },
    { ecPerBlock: 20, groups: [{ blocks: 1, dataCodewords: 80 }] },
    { ecPerBlock: 26, groups: [{ blocks: 1, dataCodewords: 108 }] },
    { ecPerBlock: 18, groups: [{ blocks: 2, dataCodewords: 68 }] },
    { ecPerBlock: 20, groups: [{ blocks: 2, dataCodewords: 78 }] },
    { ecPerBlock: 24, groups: [{ blocks: 2, dataCodewords: 97 }] },
    { ecPerBlock: 30, groups: [{ blocks: 2, dataCodewords: 116 }] },
    { ecPerBlock: 18, groups: [{ blocks: 2, dataCodewords: 68 }, { blocks: 2, dataCodewords: 69 }] },
  ],
  M: [
    { ecPerBlock: 0, groups: [] },
    { ecPerBlock: 10, groups: [{ blocks: 1, dataCodewords: 16 }] },
    { ecPerBlock: 16, groups: [{ blocks: 1, dataCodewords: 28 }] },
    { ecPerBlock: 26, groups: [{ blocks: 1, dataCodewords: 44 }] },
    { ecPerBlock: 18, groups: [{ blocks: 2, dataCodewords: 32 }] },
    { ecPerBlock: 24, groups: [{ blocks: 2, dataCodewords: 43 }] },
    { ecPerBlock: 16, groups: [{ blocks: 4, dataCodewords: 27 }] },
    { ecPerBlock: 18, groups: [{ blocks: 4, dataCodewords: 31 }] },
    { ecPerBlock: 22, groups: [{ blocks: 2, dataCodewords: 38 }, { blocks: 2, dataCodewords: 39 }] },
    { ecPerBlock: 22, groups: [{ blocks: 3, dataCodewords: 36 }, { blocks: 2, dataCodewords: 37 }] },
    { ecPerBlock: 26, groups: [{ blocks: 4, dataCodewords: 43 }, { blocks: 1, dataCodewords: 44 }] },
  ],
};

const FORMAT_BITS: Record<QrLevel, number> = { L: 1, M: 0 };
const MAX_VERSION = 10;

function dataCodewords(plan: BlockPlan): number {
  return plan.groups.reduce((sum, g) => sum + g.blocks * g.dataCodewords, 0);
}

function gfMul(a: number, b: number): number {
  let result = 0;
  for (let i = 7; i >= 0; i--) {
    result = (result << 1) ^ ((result >>> 7) * 0x11d);
    result ^= ((b >>> i) & 1) * a;
  }
  return result & 0xff;
}

function ecDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j] as number, root) ^ (j + 1 < degree ? (result[j + 1] as number) : 0);
    }
    root = gfMul(root, 2);
  }
  return result;
}

function ecRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] = (result[i] as number) ^ gfMul(divisor[i] as number, factor);
  }
  return result;
}

function chooseVersion(length: number, level: QrLevel): number {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const countBits = version <= 9 ? 8 : 16;
    const capacity = dataCodewords((PLANS[level] as BlockPlan[])[version] as BlockPlan) * 8;
    if (4 + countBits + length * 8 <= capacity) return version;
  }
  throw new Error(`data too long for a version ${MAX_VERSION} QR code`);
}

function buildCodewords(data: Uint8Array, version: number, level: QrLevel): number[] {
  const plan = (PLANS[level] as BlockPlan[])[version] as BlockPlan;
  const capacity = dataCodewords(plan) * 8;
  const bits: number[] = [];
  const push = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(4, 4);
  push(data.length, version <= 9 ? 8 : 16);
  for (const b of data) push(b, 8);
  push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let w = 0;
    for (let j = 0; j < 8; j++) w = (w << 1) | (bits[i + j] as number);
    words.push(w);
  }

  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];
  const divisor = ecDivisor(plan.ecPerBlock);
  let offset = 0;
  for (const group of plan.groups) {
    for (let b = 0; b < group.blocks; b++) {
      const block = words.slice(offset, offset + group.dataCodewords);
      offset += group.dataCodewords;
      blocks.push(block);
      ecBlocks.push(ecRemainder(block, divisor));
    }
  }
  const longest = Math.max(...blocks.map((b) => b.length));
  const out: number[] = [];
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) if (i < block.length) out.push(block[i] as number);
  }
  for (let i = 0; i < plan.ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i] as number);
  }
  if (out.length !== TOTAL_CODEWORDS[version]) throw new Error('codeword count mismatch');
  return out;
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

class Grid {
  readonly size: number;
  readonly modules: boolean[][];
  readonly reserved: boolean[][];

  constructor(size: number) {
    this.size = size;
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }

  setFunction(x: number, y: number, dark: boolean): void {
    (this.modules[y] as boolean[])[x] = dark;
    (this.reserved[y] as boolean[])[x] = true;
  }

  drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        this.setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  }

  drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  drawFormat(level: QrLevel, mask: number): void {
    const data = (FORMAT_BITS[level] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, bit(i));
    this.setFunction(8, this.size - 8, true);
  }

  drawVersion(version: number): void {
    if (version < 7) return;
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, bit);
      this.setFunction(b, a, bit);
    }
  }

  drawFunctionPatterns(version: number, level: QrLevel): void {
    for (let i = 0; i < this.size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);
    const positions = alignmentPositions(version);
    const last = positions.length - 1;
    for (let i = 0; i < positions.length; i++) {
      for (let j = 0; j < positions.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        this.drawAlignment(positions[i] as number, positions[j] as number);
      }
    }
    this.drawFormat(level, 0);
    this.drawVersion(version);
  }

  placeData(codewords: number[]): void {
    let i = 0;
    const total = codewords.length * 8;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if ((this.reserved[y] as boolean[])[x] || i >= total) continue;
          (this.modules[y] as boolean[])[x] = (((codewords[i >>> 3] as number) >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if ((this.reserved[y] as boolean[])[x]) continue;
        let invert: boolean;
        switch (mask) {
          case 0:
            invert = (x + y) % 2 === 0;
            break;
          case 1:
            invert = y % 2 === 0;
            break;
          case 2:
            invert = x % 3 === 0;
            break;
          case 3:
            invert = (x + y) % 3 === 0;
            break;
          case 4:
            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            break;
          case 5:
            invert = ((x * y) % 2) + ((x * y) % 3) === 0;
            break;
          case 6:
            invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
          default:
            invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (invert) (this.modules[y] as boolean[])[x] = !(this.modules[y] as boolean[])[x];
      }
    }
  }

  penalty(): number {
    let result = 0;
    const size = this.size;
    const at = (x: number, y: number) => (this.modules[y] as boolean[])[x] as boolean;
    const line = (get: (i: number) => boolean) => {
      let runColor = false;
      let runLength = 0;
      const history = new Array<number>(7).fill(0);
      const addHistory = (length: number) => {
        if (history[0] === 0) length += size;
        history.pop();
        history.unshift(length);
      };
      const countPatterns = () => {
        const n = history[1] as number;
        const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
        const left = core && (history[0] as number) >= n * 4 && (history[6] as number) >= n ? 1 : 0;
        const right = core && (history[6] as number) >= n * 4 && (history[0] as number) >= n ? 1 : 0;
        return left + right;
      };
      for (let i = 0; i < size; i++) {
        if (get(i) === runColor) {
          runLength++;
          if (runLength === 5) result += 3;
          else if (runLength > 5) result++;
        } else {
          addHistory(runLength);
          if (!runColor) result += countPatterns() * 40;
          runColor = get(i);
          runLength = 1;
        }
      }
      if (runColor) {
        addHistory(runLength);
        runLength = 0;
      }
      addHistory(runLength + size);
      result += countPatterns() * 40;
    };
    for (let y = 0; y < size; y++) line((x) => at(x, y));
    for (let x = 0; x < size; x++) line((y) => at(x, y));
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = at(x, y);
        if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) result += 3;
      }
    }
    let dark = 0;
    for (const row of this.modules) for (const m of row) if (m) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + k * 10;
  }
}

export function encodeQr(text: string, options: { level?: QrLevel; mask?: number } = {}): QrMatrix {
  const level = options.level ?? 'L';
  const data = new TextEncoder().encode(text);
  const version = chooseVersion(data.length, level);
  const codewords = buildCodewords(data, version, level);
  const size = version * 4 + 17;
  const grid = new Grid(size);
  grid.drawFunctionPatterns(version, level);
  grid.placeData(codewords);
  let mask = options.mask ?? -1;
  if (mask < 0) {
    let best = Number.POSITIVE_INFINITY;
    for (let candidate = 0; candidate < 8; candidate++) {
      grid.applyMask(candidate);
      grid.drawFormat(level, candidate);
      const score = grid.penalty();
      if (score < best) {
        best = score;
        mask = candidate;
      }
      grid.applyMask(candidate);
    }
  }
  grid.applyMask(mask);
  grid.drawFormat(level, mask);
  return { size, modules: grid.modules };
}

export function renderQr(qr: QrMatrix, style: 'utf8' | 'ascii' = 'utf8', quiet = 2): string {
  const size = qr.size + quiet * 2;
  const dark = (x: number, y: number) => {
    const mx = x - quiet;
    const my = y - quiet;
    if (mx < 0 || my < 0 || mx >= qr.size || my >= qr.size) return false;
    return (qr.modules[my] as boolean[])[mx] as boolean;
  };
  const lines: string[] = [];
  if (style === 'ascii') {
    for (let y = 0; y < size; y++) {
      let line = '';
      for (let x = 0; x < size; x++) line += dark(x, y) ? '##' : '  ';
      lines.push(line);
    }
    return `${lines.join('\n')}\n`;
  }
  for (let y = 0; y < size; y += 2) {
    let line = '';
    for (let x = 0; x < size; x++) {
      const top = dark(x, y);
      const bottom = y + 1 < size ? dark(x, y + 1) : false;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return `${lines.join('\n')}\n`;
}
