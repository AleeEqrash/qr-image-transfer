// Protocol v1 per QR_IMAGE_TRANSFER_METHODOLOGY.md §6
// DATA packet: MAGIC(2='QT') | VER(1) | fileId(4) | total(3) | index(3) | crc16(2) | payload
// Transport string: base64url(packet). META: JSON string.

export const MAGIC0 = 0x51; // Q
export const MAGIC1 = 0x54; // T
export const VER = 0x01;
export const HEADER_LEN = 15;

export interface Meta {
  v: number; fileId: number; name: string; size: number;
  mime: string; total: number; chunkSize: number; sha256: string;
  /** protocol: 1 = fixed chunks (default when absent), 2 = LT fountain */
  proto?: number;
  /** v2 only: source block count / block size */
  K?: number; blockSize?: number;
}

export function crc16ccitt(data: Uint8Array): number {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function chunkBytes(data: Uint8Array, chunkSize: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += chunkSize) out.push(data.slice(i, i + chunkSize));
  if (out.length === 0) out.push(new Uint8Array(0));
  return out;
}

// browser-safe base64url (no Node Buffer)
export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
export function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeDataFrame(fileId: number, total: number, index: number, payload: Uint8Array): string {
  const pkt = new Uint8Array(HEADER_LEN + payload.length);
  const dv = new DataView(pkt.buffer);
  pkt[0] = MAGIC0; pkt[1] = MAGIC1; pkt[2] = VER;
  dv.setUint32(3, fileId);
  pkt[7] = (total >> 16) & 0xff; pkt[8] = (total >> 8) & 0xff; pkt[9] = total & 0xff;
  pkt[10] = (index >> 16) & 0xff; pkt[11] = (index >> 8) & 0xff; pkt[12] = index & 0xff;
  dv.setUint16(13, crc16ccitt(payload));
  pkt.set(payload, HEADER_LEN);
  return b64urlEncode(pkt);
}

export interface DecodedFrame { fileId: number; total: number; index: number; payload: Uint8Array }

export function decodeDataFrame(s: string): DecodedFrame | null {
  let pkt: Uint8Array;
  try { pkt = b64urlDecode(s.trim()); } catch { return null; }
  if (pkt.length < HEADER_LEN) return null;
  if (pkt[0] !== MAGIC0 || pkt[1] !== MAGIC1 || pkt[2] !== VER) return null;
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const fileId = dv.getUint32(3);
  const total = (pkt[7] << 16) | (pkt[8] << 8) | pkt[9];
  const index = (pkt[10] << 16) | (pkt[11] << 8) | pkt[12];
  const crc = dv.getUint16(13);
  const payload = pkt.slice(HEADER_LEN);
  if (crc16ccitt(payload) !== crc) return null;
  if (index >= total) return null;
  return { fileId, total, index, payload };
}

export function encodeMeta(m: Meta): string { return JSON.stringify(m); }
export function decodeMeta(s: string): Meta | null {
  try {
    const o = JSON.parse(s.trim());
    if (typeof o.fileId !== 'number' || typeof o.total !== 'number' || typeof o.sha256 !== 'string') return null;
    return o as Meta;
  } catch { return null; }
}

export async function sha256hex(data: Uint8Array): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const d = await subtle.digest('SHA-256', data as BufferSource);
      return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch { /* fall through to pure-JS below (insecure contexts like LAN http:// have no subtle) */ }
  const { sha256 } = await import('js-sha256');
  return sha256(data);
}

export function concatFrames(map: Map<number, Uint8Array>, total: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let len = 0;
  for (let i = 0; i < total; i++) {
    const p = map.get(i);
    if (!p) throw new Error(`missing chunk ${i}`);
    parts.push(p); len += p.length;
  }
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
