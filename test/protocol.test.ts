import { describe, it, expect } from 'vitest';
import { chunkBytes, crc16ccitt, encodeDataFrame, decodeDataFrame, b64urlEncode, b64urlDecode, concatFrames } from '../src/protocol';

describe('protocol v1', () => {
  it('round-trips chunks', () => {
    const data = new TextEncoder().encode('HELLO QR IMAGE TRANSFER');
    const chunks = chunkBytes(data, 5);
    expect(chunks.length).toBeGreaterThan(1);
    const total = chunks.length;
    const strs = chunks.map((c, i) => encodeDataFrame(123, total, i, c));
    const back = strs.map(s => decodeDataFrame(s)!);
    expect(back.every(Boolean)).toBe(true);
    const map = new Map(back.map(f => [f.index, f.payload]));
    expect(new TextDecoder().decode(concatFrames(map, total))).toBe('HELLO QR IMAGE TRANSFER');
  });
  it('rejects tampered frame (crc)', () => {
    const s = encodeDataFrame(1, 1, 0, new Uint8Array([1, 2, 3]));
    const raw = b64urlDecode(s); raw[raw.length - 1] ^= 0xff;
    expect(decodeDataFrame(b64urlEncode(raw))).toBeNull();
  });
  it('crc16 known vector', () => {
    expect(crc16ccitt(new TextEncoder().encode('123456789'))).toBe(0x29b1);
  });
});
