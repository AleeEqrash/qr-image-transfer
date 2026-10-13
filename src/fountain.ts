// Protocol v2 — LT fountain codes (fixes the v1 "last-frames hostage" tail).
//
// v1 sends fixed indices 0..N-1: the receiver waits for SPECIFIC frames, so
// the tail takes full loop cycles per missing frame (coupon collector).
// v2 sends an endless stream of UNIQUE pseudo-random XOR combinations
// ("drops"). The receiver recovers after ANY ~K*(1+eps) drops via peeling.
// No specific frame can ever stall completion; every decode counts.
//
// Wire: base64url(MAGIC 'QF' | VER | fileId u32 | K u24 | seed u32 | payload)
// seed < K (high bit clear)  -> systematic drop = verbatim block[seed]
// seed & 0x80000000 set      -> LT drop, neighbors sampled from seed
// K and blockSize travel in every header, so mid-loop join works without META.
// META (JSON, proto:2) still carries name/mime/size/sha256 for final verify.

import { b64urlDecode, b64urlEncode } from './protocol';

export const FMAGIC0 = 0x51; // Q
export const FMAGIC1 = 0x46; // F
export const FVER = 0x01;
export const FHEADER_LEN = 14;
export const LT_FLAG = 0x80000000;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Luby robust soliton distribution CDF over degrees 1..K.
export function solitonCDF(K: number, c = 0.1, delta = 0.5): Float64Array {
  const cdf = new Float64Array(Math.max(1, K));
  if (K <= 1) { cdf[0] = 1; return cdf; }
  const rho = (d: number) => (d === 1 ? 1 / K : 1 / (d * (d - 1)));
  const R = c * Math.log(K / delta) * Math.sqrt(K);
  const pivot = Math.max(1, Math.floor(K / Math.max(R, 1)));
  const tau = (d: number) => {
    if (d < pivot) return R / (d * K);
    if (d === pivot) return (R * Math.log(Math.max(R, 1) / delta)) / K;
    return 0;
  };
  let z = 0;
  const w: number[] = [];
  for (let d = 1; d <= K; d++) { const x = rho(d) + tau(d); w.push(x); z += x; }
  let acc = 0;
  for (let d = 1; d <= K; d++) { acc += w[d - 1] / z; cdf[d - 1] = acc; }
  cdf[K - 1] = 1;
  return cdf;
}

export function sampleDegree(rng: () => number, cdf: Float64Array): number {
  const r = rng();
  for (let i = 0; i < cdf.length; i++) if (r <= cdf[i]) return i + 1;
  return cdf.length;
}

// d distinct indices in [0, K) — Floyd's algorithm.
export function sampleNeighbors(rng: () => number, K: number, d: number): number[] {
  const set = new Set<number>();
  for (let j = K - d; j < K; j++) {
    const t = Math.floor(rng() * (j + 1));
    set.add(set.has(t) ? j : t);
  }
  return [...set];
}

export interface SourceBlocks {
  K: number;
  blockSize: number;
  size: number;
  data: Uint8Array[];
}

export function splitBlocks(bytes: Uint8Array, blockSize: number): SourceBlocks {
  const K = Math.max(1, Math.ceil(bytes.length / blockSize));
  const data: Uint8Array[] = [];
  for (let i = 0; i < K; i++) {
    const b = new Uint8Array(blockSize);
    b.set(bytes.slice(i * blockSize, (i + 1) * blockSize));
    data.push(b);
  }
  return { K, blockSize, size: bytes.length, data };
}

export function dropNeighbors(seed: number, K: number, cdf: Float64Array): number[] {
  const s = seed >>> 0;
  if ((s & LT_FLAG) === 0) {
    if (s >= K) throw new Error(`systematic seed ${s} out of range K=${K}`);
    return [s];
  }
  const rng = mulberry32(s);
  return sampleNeighbors(rng, K, sampleDegree(rng, cdf));
}

export function makeDrop(blocks: SourceBlocks, fileId: number, seed: number, cdf: Float64Array): string {
  const nb = dropNeighbors(seed >>> 0, blocks.K, cdf);
  const out = new Uint8Array(blocks.blockSize);
  for (const i of nb) {
    const b = blocks.data[i];
    for (let j = 0; j < out.length; j++) out[j] ^= b[j];
  }
  const pkt = new Uint8Array(FHEADER_LEN + out.length);
  const dv = new DataView(pkt.buffer);
  pkt[0] = FMAGIC0; pkt[1] = FMAGIC1; pkt[2] = FVER;
  dv.setUint32(3, fileId);
  pkt[7] = (blocks.K >> 16) & 0xff; pkt[8] = (blocks.K >> 8) & 0xff; pkt[9] = blocks.K & 0xff;
  dv.setUint32(10, seed >>> 0);
  pkt.set(out, FHEADER_LEN);
  return b64urlEncode(pkt);
}

export interface DecodedDrop {
  fileId: number;
  K: number;
  seed: number;
  payload: Uint8Array; // length == blockSize (last block zero-padded at split)
}

export function decodeDrop(s: string): DecodedDrop | null {
  let pkt: Uint8Array;
  try { pkt = b64urlDecode(s.trim()); } catch { return null; }
  if (pkt.length < FHEADER_LEN + 1) return null;
  if (pkt[0] !== FMAGIC0 || pkt[1] !== FMAGIC1 || pkt[2] !== FVER) return null;
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const K = (pkt[7] << 16) | (pkt[8] << 8) | pkt[9];
  if (K < 1 || K > 1 << 20) return null;
  return { fileId: dv.getUint32(3), K, seed: dv.getUint32(10), payload: pkt.slice(FHEADER_LEN) };
}

interface PendingDrop {
  neighbors: Set<number>;
  data: Uint8Array;
}

// Peeling (belief-propagation) decoder. Neighbors recomputed from seeds, so
// only (seed, payload) crosses the wire.
export class LTDecoder {
  readonly K: number;
  readonly blockSize: number;
  readonly cdf: Float64Array;
  blocks: (Uint8Array | null)[];
  recovered = 0;
  drops: (PendingDrop | null)[] = [];
  adj: Set<number>[] = [];
  seen = new Set<number>();
  /** unique drops accepted (incl. redundant) — overhead metric */
  totalDrops = 0;

  constructor(K: number, blockSize: number, cdf?: Float64Array) {
    this.K = K;
    this.blockSize = blockSize;
    this.cdf = cdf ?? solitonCDF(K);
    this.blocks = new Array(K).fill(null);
    this.adj = Array.from({ length: K }, () => new Set<number>());
  }

  /** @returns 'dup' | 'redundant' | 'stored' | 'progress' */
  addDrop(seed: number, payload: Uint8Array): string {
    if (this.isComplete() || this.seen.has(seed)) return 'dup';
    this.seen.add(seed);
    this.totalDrops++;
    if (payload.length !== this.blockSize) return 'redundant';
    const data = payload.slice();
    const unk: number[] = [];
    for (const i of dropNeighbors(seed, this.K, this.cdf)) {
      const b = this.blocks[i];
      if (b) { for (let j = 0; j < data.length; j++) data[j] ^= b[j]; }
      else unk.push(i);
    }
    if (unk.length === 0) return 'redundant';
    if (unk.length === 1) { this.recover(unk[0], data); return 'progress'; }
    const di = this.drops.length;
    this.drops.push({ neighbors: new Set(unk), data });
    for (const i of unk) this.adj[i].add(di);
    return 'stored';
  }

  private recover(i: number, val: Uint8Array): void {
    const stack: [number, Uint8Array][] = [[i, val]];
    while (stack.length) {
      const [bi, bv] = stack.pop()!;
      if (this.blocks[bi]) continue;
      this.blocks[bi] = bv;
      this.recovered++;
      for (const di of this.adj[bi]) {
        const d = this.drops[di];
        if (!d || !d.neighbors.has(bi)) continue;
        d.neighbors.delete(bi);
        for (let j = 0; j < d.data.length; j++) d.data[j] ^= bv[j];
        if (d.neighbors.size === 1) {
          const nxt = [...d.neighbors][0];
          this.drops[di] = null;
          stack.push([nxt, d.data]);
        } else if (d.neighbors.size === 0) {
          this.drops[di] = null;
        }
      }
      this.adj[bi].clear();
    }
  }

  isComplete(): boolean {
    return this.recovered >= this.K;
  }

  /** Concatenated source bytes trimmed to `size`. Throws if incomplete. */
  result(size: number): Uint8Array {
    if (!this.isComplete()) throw new Error(`incomplete ${this.recovered}/${this.K}`);
    const out = new Uint8Array(this.K * this.blockSize);
    for (let i = 0; i < this.K; i++) out.set(this.blocks[i]!, i * this.blockSize);
    return out.slice(0, size);
  }
}
