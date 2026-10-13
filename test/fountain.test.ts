import { describe, it, expect } from 'vitest';
import {
  LTDecoder, decodeDrop, dropNeighbors, makeDrop, mulberry32, solitonCDF, splitBlocks, LT_FLAG,
} from '../src/fountain';

function pseudoRandomBytes(n: number, seed: number): Uint8Array {
  const rng = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

describe('fountain v2', () => {
  it('systematic drops alone round-trip (lossless)', () => {
    const bytes = pseudoRandomBytes(10000, 7);
    const blocks = splitBlocks(bytes, 512);
    const cdf = solitonCDF(blocks.K);
    const dec = new LTDecoder(blocks.K, blocks.blockSize, cdf);
    for (let i = 0; i < blocks.K; i++) {
      const d = decodeDrop(makeDrop(blocks, 99, i, cdf))!;
      expect(dec.addDrop(d.seed, d.payload)).toBe('progress');
    }
    expect(dec.isComplete()).toBe(true);
    expect(dec.result(bytes.length)).toEqual(bytes);
  });

  it('recovers under 40% loss with mid-stream join', () => {
    const bytes = pseudoRandomBytes(10000, 42);
    const blocks = splitBlocks(bytes, 512);
    const cdf = solitonCDF(blocks.K);
    // stream: systematic pass + 5K LT drops, shuffled, 40% erased, join at #30
    const rng = mulberry32(1234);
    const seeds: number[] = [];
    for (let i = 0; i < blocks.K; i++) seeds.push(i);
    for (let n = 0; n < 5 * blocks.K; n++) seeds.push((LT_FLAG | (1000 + n)) >>> 0);
    for (let i = seeds.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [seeds[i], seeds[j]] = [seeds[j], seeds[i]];
    }
    const kept = seeds.filter(() => rng() > 0.4).slice(30);
    const wire = kept.map(s => decodeDrop(makeDrop(blocks, 5, s, cdf))!);
    const dec = new LTDecoder(blocks.K, blocks.blockSize, cdf);
    let used = 0;
    for (const d of wire) {
      used++;
      dec.addDrop(d.seed, d.payload);
      if (dec.isComplete()) break;
    }
    expect(dec.isComplete()).toBe(true);
    expect(dec.result(bytes.length)).toEqual(bytes);
    // fountain overhead: should need far less than 2K drops for K blocks
    expect(used).toBeLessThan(2 * blocks.K);
  });

  it('tiny input (K=1) works', () => {
    const bytes = new TextEncoder().encode('HELLO QR');
    const blocks = splitBlocks(bytes, 512);
    expect(blocks.K).toBe(1);
    const cdf = solitonCDF(blocks.K);
    const dec = new LTDecoder(blocks.K, blocks.blockSize, cdf);
    const d = decodeDrop(makeDrop(blocks, 1, 0, cdf))!;
    dec.addDrop(d.seed, d.payload);
    expect(dec.result(bytes.length)).toEqual(bytes);
  });

  it('seeds are deterministic, neighbors valid', () => {
    const K = 42;
    const cdf = solitonCDF(K);
    const a = dropNeighbors((LT_FLAG | 777) >>> 0, K, cdf);
    const b = dropNeighbors((LT_FLAG | 777) >>> 0, K, cdf);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
    expect(Math.min(...a)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...a)).toBeLessThan(K);
    expect(dropNeighbors(5, K, cdf)).toEqual([5]);
  });
});
