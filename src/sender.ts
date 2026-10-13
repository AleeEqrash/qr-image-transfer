import QRCode from 'qrcode';
import { chunkBytes, decodeDataFrame, encodeDataFrame, encodeMeta, sha256hex } from './protocol';
import { LT_FLAG, makeDrop, decodeDrop, solitonCDF, splitBlocks, type SourceBlocks } from './fountain';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
const canvas = $('qr') as unknown as HTMLCanvasElement;
const overlay = $('overlay');
const stats = $('stats');
const stage = $('stage');

let timer: number | null = null;
let running = false;
let frames: string[] = [];
let idx = 0;
let proto = 1;
// v2 fountain session: systematic drops + endlessly refreshed LT batches
let v2: { blocks: SourceBlocks; cdf: Float64Array; fileId: number; meta: string; sys: string[]; ltNext: number } | null = null;

function ltBatch(n: number): string[] {
  if (!v2) return [];
  const out: string[] = [];
  for (let k = 0; k < n; k++) {
    out.push(makeDrop(v2.blocks, v2.fileId, (v2.ltNext++ | LT_FLAG) >>> 0, v2.cdf));
  }
  return out;
}

// META repeated every 20 frames: it appeared once per ~25s pass, so one
// missed META cost a full pass of waiting despite complete data. 5% overhead.
// LT batch capped: for multi-MB files 2K drops/pass would bloat memory;
// 1500 fresh drops/pass still far exceeds what the phone samples per pass.
function v2BatchSize(): number {
  if (!v2) return 0;
  return Math.min(2 * v2.blocks.K, 1500);
}
function v2Pass(seq: string[]): string[] {
  if (!v2) return [];
  const out: string[] = [v2.meta];
  seq.forEach((d, i) => {
    out.push(d);
    if ((i + 1) % 20 === 0) out.push(v2!.meta);
  });
  return out;
}

async function buildFrames(): Promise<void> {
  const text = ($('text') as HTMLInputElement).value ?? '';
  const fileInput = $('file') as unknown as HTMLInputElement;
  const chunkSize = parseInt(($('chunk') as HTMLSelectElement).value, 10);
  let bytes: Uint8Array, name: string, mime: string;
  if (fileInput.files && fileInput.files[0]) {
    const f = fileInput.files[0];
    bytes = new Uint8Array(await f.arrayBuffer());
    name = f.name; mime = f.type || 'application/octet-stream';
  } else {
    bytes = new TextEncoder().encode(text);
    name = 'message.txt'; mime = 'text/plain';
  }
  const fileId = (Math.random() * 0xffffffff) >>> 0;
  const hash = await sha256hex(bytes);
  proto = parseInt(($('proto') as HTMLSelectElement).value, 10) || 1;
  if (proto === 2) {
    const blockSize = parseInt(($('block') as HTMLSelectElement).value, 10) || 512;
    const blocks = splitBlocks(bytes, blockSize);
    const cdf = solitonCDF(blocks.K);
    const meta = encodeMeta({ v: 1, proto: 2, fileId, name, size: bytes.length, mime, total: blocks.K, chunkSize: blockSize, K: blocks.K, blockSize, sha256: hash });
    const sys = blocks.data.map((_, i) => makeDrop(blocks, fileId, i, cdf));
    v2 = { blocks, cdf, fileId, meta, sys, ltNext: (Math.floor(Math.random() * 0x7fffffff) | LT_FLAG) >>> 0 };
    frames = v2Pass([...sys, ...ltBatch(v2BatchSize())]);
    idx = 0;
    stats.textContent = `v2 fountain file=${name} size=${bytes.length}B K=${blocks.K} blocks x ${blockSize}B sha256=${hash.slice(0, 12)}…`;
    return;
  }
  v2 = null;
  const chunks = chunkBytes(bytes, chunkSize);
  const meta = encodeMeta({ v: 1, fileId, name, size: bytes.length, mime, total: chunks.length, chunkSize, sha256: hash });
  const data = chunks.map((c, i) => encodeDataFrame(fileId, chunks.length, i, c));
  // 2x dwell: show each frame twice back-to-back. Independent camera-noise
  // samples per dwell beat transient blur on hard frames (loop takes 2x).
  const dbl = ($('double') as unknown as HTMLInputElement).checked;
  const seq = dbl ? data.flatMap(d => [d, d]) : data;
  frames = [meta, ...seq];
  // frame 0 is META; data frames are frames[1..]; loop includes meta each cycle
  idx = 0;
  stats.textContent = `v1 chunks file=${name} size=${bytes.length}B chunks=${chunks.length} sha256=${hash.slice(0, 12)}…`;
}

async function draw(): Promise<void> {
  if (!frames.length) return;
  const ecc = ($('ecc') as HTMLSelectElement).value as 'L' | 'M' | 'Q';
  const qrsize = parseInt(($('qrsize') as HTMLSelectElement).value, 10) || 720;
  const s = frames[idx % frames.length];
  const isMeta = idx % frames.length === 0;
  // Integer modules: fixed `width` forces fractional pixels per module, which
  // systematically corrupts specific patterns (misreads, not misses). Render
  // at exact integer scale instead; CSS upscales with pixelated rendering.
  const mods = QRCode.create(s, { errorCorrectionLevel: ecc }).modules.size;
  const pxPerMod = Math.max(2, Math.round(qrsize / (mods + 4)));
  await QRCode.toCanvas(canvas, s, { errorCorrectionLevel: ecc, margin: 2, scale: pxPerMod });
  if (isMeta) {
    overlay.textContent = `META tick=${idx}`;
  } else if (proto === 2) {
    const d = decodeDrop(s);
    overlay.textContent = d ? ((d.seed & LT_FLAG) !== 0 ? `fountain LT tick=${idx}` : `fountain sys ${d.seed} tick=${idx}`) : `frame tick=${idx}`;
  } else {
    const f = decodeDataFrame(s);
    overlay.textContent = f ? `chunk ${f.index}/${f.total - 1} tick=${idx}` : `frame tick=${idx}`;
  }
  idx++;
  // v2: every loop pass carries FRESH LT seeds — the stream never repeats a
  // drop, so the receiver always gains information (no duplicate loop).
  if (proto === 2 && v2 && idx % frames.length === 0) {
    // Later passes are pure fresh LT (no systematic repeat): the receiver
    // likely holds those blocks, and novel drops are always more valuable.
    // META stays interleaved every 20 frames.
    frames = v2Pass(ltBatch(v2BatchSize()));
  }
}

// Chained scheduling: each frame is fully rendered before the next interval
// starts, so every QR gets its full dwell time on screen (no overlap/skips).
function loop() {
  if (!running) return;
  const t0 = performance.now();
  draw().catch(e => { stats.textContent = 'draw error: ' + (e as Error).message; console.error(e); })
    .finally(() => {
      if (!running) return;
      const fps = parseInt(($('fps') as HTMLSelectElement).value, 10) || 8;
      const wait = Math.max(0, Math.round(1000 / fps) - (performance.now() - t0));
      timer = window.setTimeout(loop, wait);
    });
}

$('start').onclick = async () => {
  try {
    stats.textContent = 'building frames…';
    await buildFrames();
    if (timer) clearTimeout(timer);
    running = true;
    loop();
  } catch (e) {
    stats.textContent = 'ERROR: ' + (e as Error).message;
    console.error(e);
  }
};
$('stop').onclick = () => { running = false; if (timer) clearTimeout(timer); timer = null; };
stage.onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else stage.requestFullscreen?.(); };
