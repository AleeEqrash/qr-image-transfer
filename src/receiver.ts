import { BrowserQRCodeReader } from '@zxing/browser';
import { decodeDataFrame, decodeMeta, concatFrames, sha256hex, type Meta } from './protocol';
import { decodeDrop, LTDecoder } from './fountain';

const $ = (id: string) => document.getElementById(id)!;
const video = $('video') as unknown as HTMLVideoElement;
const stats = $('stats'), logEl = $('log'), fill = $('fill'), out = $('out');

const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 40, delayBetweenScanSuccess: 0 });
let controls: { stop(): void } | null = null;
let meta: Meta | null = null;
let sessionFileId: number | null = null;
let sessionTotal: number | null = null;
let store = new Map<number, Uint8Array>();
let sessionProto: 1 | 2 | null = null;
let v2dec: LTDecoder | null = null;
let finishedFileId: number | null = null;
let t0 = 0;
let log: string[] = [];
// Diagnostic report: machine-parseable event + sample lines for tuning.
// Every line starts with seconds since Start; novel arrivals log their index,
// samples (every 2s) snapshot counters so arrival curves can be reconstructed.
let report: string[] = [];
let sampler: number | null = null;
// Error histogram: distinguishes "QR won't scan" (NotFoundException =
// optical: size/focus/distance) from "QR scans but misreads"
// (ChecksumException/FormatException = raise ECC / fix module rendering).
let errHist = new Map<string, number>();
const nowS = () => ((performance.now() - t0) / 1000).toFixed(2);
function rep(line: string) { report.push(`${nowS()} ${line}`); }
// Throughput counters (proves buffering works, exposes the real bottleneck)
let attempts = 0;      // every decode attempt (success or miss)
let decoded = 0;       // attempts that yielded any QR text
let lastNovelAt = 0;   // last time a NEW chunk index arrived
let ticker: number | null = null;

function say(s: string) { log.push(`${((performance.now() - t0) / 1000).toFixed(1)}s ${s}`); logEl.textContent = log.slice(-12).join('\n'); }

// Session is keyed by proto/fileId/total from ANY frame (META or DATA), so
// joining mid-loop collects immediately. META only attaches name/mime/hash.
function ensureSession(proto: 1 | 2, fileId: number, total: number): boolean {
  if (sessionProto === null || proto !== sessionProto || fileId !== sessionFileId || total !== sessionTotal) {
    sessionProto = proto; sessionFileId = fileId; sessionTotal = total; store = new Map();
    v2dec = null; finishedFileId = null;
    if (meta?.fileId !== fileId) meta = null;
    out.innerHTML = '';
    return true; // fresh session
  }
  return false;
}

function ensureV2Decoder(K: number, blockSize: number): void {
  if (!v2dec || v2dec.K !== K) v2dec = new LTDecoder(K, blockSize);
}

async function onText(s: string) {
  const m = decodeMeta(s);
  if (m) {
    const proto: 1 | 2 = m.proto === 2 ? 2 : 1;
    const fresh = ensureSession(proto, m.fileId, m.total);
    if (fresh) { say(`META v${proto} total=${m.total} size=${m.size} name=${m.name}`); rep(`META proto=${proto} total=${m.total} size=${m.size} name=${m.name}`); }
    const hadMeta = !!meta;
    meta = m;
    if (proto === 2 && m.K && m.blockSize) ensureV2Decoder(m.K, m.blockSize);
    paint();
    // Everything arrived before META -> finish now.
    if (!hadMeta && finishedFileId !== m.fileId) {
      if (proto === 1 && sessionTotal !== null && store.size === sessionTotal) await finish();
      if (proto === 2 && v2dec?.isComplete()) await finishV2();
    }
    return;
  }
  const f = decodeDataFrame(s);
  if (f) {
    decoded++;
    if (finishedFileId === f.fileId) return; // already done, ignore loop repeats
    const fresh = ensureSession(1, f.fileId, f.total);
    if (fresh) say(`joined mid-stream v1 total=${f.total}, collecting… (META will verify)`);
    if (!store.has(f.index)) {
      store.set(f.index, f.payload);
      rep(`NOVEL idx=${f.index} collected=${store.size}/${sessionTotal}`);
      lastNovelAt = performance.now();
      paint();
      if (sessionTotal !== null && store.size === sessionTotal) {
        if (meta) await finish();
        else say(`all ${sessionTotal} chunks collected, waiting for META to verify…`);
      }
    }
    return;
  }
  const d = decodeDrop(s);
  if (!d) return;
  decoded++;
  if (finishedFileId === d.fileId) return;
  const fresh = ensureSession(2, d.fileId, d.K);
  ensureV2Decoder(d.K, d.payload.length);
  if (fresh) { say(`joined mid-stream v2 fountain K=${d.K}, collecting drops…`); rep(`JOIN v2 K=${d.K}`); }
  const before = v2dec!.recovered;
  const res = v2dec!.addDrop(d.seed, d.payload);
  if (res === 'progress' || (res === 'stored' && v2dec!.recovered > before)) {
    lastNovelAt = performance.now();
    rep(`DROP seed=${d.seed} blocks=${v2dec!.recovered}/${d.K} drops=${v2dec!.totalDrops}`);
    paint();
    if (v2dec!.isComplete()) {
      if (meta) await finishV2();
      else say(`all ${d.K} blocks recovered, waiting for META to verify…`);
    }
  } else if (res === 'stored') {
    paint();
  }
}

function missingCount(): number {
  return sessionTotal === null ? 0 : sessionTotal - store.size;
}

// Which exact indices are missing — the key tail diagnostic. If the SAME
// indices stay missing across many loops while decode/attempts stays high,
// those specific QR patterns are systematically undecodable at this
// distance/focus (moiré), not randomly missed: re-encode smaller/different.
function missingIndices(): number[] {
  if (sessionProto === 2 && v2dec) {
    const out: number[] = [];
    for (let i = 0; i < v2dec.K; i++) if (!v2dec.blocks[i]) out.push(i);
    return out;
  }
  if (sessionTotal === null) return [];
  const out: number[] = [];
  for (let i = 0; i < sessionTotal; i++) if (!store.has(i)) out.push(i);
  return out;
}

function paint() {
  if (sessionTotal === null) {
    const el = ((performance.now() - t0) / 1000).toFixed(0);
    stats.textContent = `scanning… ${el}s | decode ${decoded}/${attempts} attempts`;
    return;
  }
  if (sessionProto === 2 && v2dec) {
    const K = sessionTotal;
    const pct = Math.round((v2dec.recovered / K) * 100);
    fill.style.width = pct + '%';
    const el = ((performance.now() - t0) / 1000).toFixed(0);
    const oh = v2dec.recovered > 0 ? Math.round(((v2dec.totalDrops - v2dec.recovered) / v2dec.recovered) * 100) : 0;
    const name = meta ? ` ${meta.name}` : '';
    let extra = `drops ${v2dec.totalDrops} (+${oh}% overhead) | decode ok ${decoded}/${attempts} | ${el}s elapsed`;
    if (!v2dec.isComplete() && lastNovelAt > 0 && performance.now() - lastNovelAt > 10000) {
      extra += ' | slow: move closer, tap to lock focus, brightness max';
    } else if (!meta) {
      extra += ' — waiting for META…';
    }
    stats.textContent = `fountain ${v2dec.recovered}/${K} blocks (${pct}%)${name} | ${extra}`;
    return;
  }
  const pct = Math.round((store.size / sessionTotal) * 100);
  fill.style.width = pct + '%';
  const el = ((performance.now() - t0) / 1000).toFixed(0);
  const rate = (store.size / Math.max(1, (performance.now() - t0) / 1000)).toFixed(1);
  const idleFor = ((performance.now() - lastNovelAt) / 1000).toFixed(0);
  const name = meta ? ` ${meta.name}` : '';
  let extra = `${rate} new/s | decode ok ${decoded}/${attempts} | ${el}s elapsed`;
  if (store.size < sessionTotal && lastNovelAt > 0 && performance.now() - lastNovelAt > 10000) {
    const ratio = attempts > 0 ? decoded / attempts : 1;
    extra += ` | STUCK no new chunk for ${idleFor}s — `;
    extra += ratio < 0.25
      ? 'most frames unreadable: move closer, tap phone screen to lock focus, brightness max, sender chunk 500 + ECC Q'
      : 'tail: last frames need full loops (~10s each with 2x dwell). Hold steady; fewer frames (bigger chunk) shortens loops';
  } else if (!meta) {
    extra += ' — waiting for META…';
  }
  const miss = missingIndices();
  const missStr = miss.length <= 25 ? miss.join(',') : miss.slice(0, 25).join(',') + `…+${miss.length - 25}`;
  stats.textContent = `${store.size}/${sessionTotal} (${pct}%)${name} | missing ${miss.length}:[${missStr}] | ${extra}`;
}

async function finishV2() {
  if (!meta || !v2dec || sessionFileId === null) return;
  if (finishedFileId === sessionFileId) return;
  finishedFileId = sessionFileId;
  try {
    const bytes = v2dec.result(meta.size);
    await verifyAndRender(bytes, meta, `${v2dec.recovered}/${v2dec.K} blocks, ${v2dec.totalDrops} drops`);
    rep(`DONE v2 ok bytes=${bytes.length} attempts=${attempts} decoded=${decoded} drops=${v2dec.totalDrops}`);
  } catch (e) { say('finish error: ' + (e as Error).message); }
}

async function verifyAndRender(bytes: Uint8Array, m: Meta, detail: string): Promise<void> {
  const h = await sha256hex(bytes);
  const secs = ((performance.now() - t0) / 1000).toFixed(0);
  const ok = h === m.sha256;
  say(ok ? `DONE sha256 match ${bytes.length}B in ${secs}s (${detail}, decode ok ${decoded}/${attempts})` : `HASH MISMATCH exp=${m.sha256.slice(0, 12)} got=${h.slice(0, 12)}`);
  renderOut(bytes, m);
}

function renderOut(bytes: Uint8Array, m: Meta): void {
  out.innerHTML = '';
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: m.mime }));
  if (m.mime.startsWith('image/')) { const img = document.createElement('img'); img.src = url; img.style.maxWidth = '100%'; out.appendChild(img); }
  const a = document.createElement('a'); a.href = url; a.download = m.name; a.textContent = `Download ${m.name} (${bytes.length}B)`; a.style.display = 'block'; out.appendChild(a);
}

async function finish() {
  if (!meta || sessionTotal === null || sessionFileId === null) return;
  if (finishedFileId === sessionFileId) return;
  finishedFileId = sessionFileId;
  try {
    const bytes = concatFrames(store, sessionTotal);
    const r = (store.size / Math.max(1, (performance.now() - t0) / 1000)).toFixed(1);
    await verifyAndRender(bytes, meta, `${r} new/s`);
    rep(`DONE ok bytes=${bytes.length} attempts=${attempts} decoded=${decoded}`);
  } catch (e) { say('finish error: ' + (e as Error).message); }
}

($('start') as HTMLButtonElement).onclick = async () => {
  t0 = performance.now(); log = [];
  meta = null; sessionProto = null; sessionFileId = null; sessionTotal = null; store = new Map(); v2dec = null; finishedFileId = null;
  attempts = 0; decoded = 0; lastNovelAt = 0;
  out.innerHTML = ''; fill.style.width = '0%';
  errHist = new Map();
  report = [`0.00 SESSION ua="${navigator.userAgent}"`];
  rep('START camera');
  say('starting camera… (needs HTTPS)');
  // Capped resolution: full-HD frames decode 3-5x slower on phone CPUs and are
  // the main reason collection stalls. 960px is plenty for screen QR at 20-50cm.
  controls = await reader.decodeFromConstraints(
    { video: { facingMode: { ideal: 'environment' }, width: { ideal: 960 }, height: { ideal: 720 } } },
    video,
    (res, err) => {
      attempts++;
      if (res) { void onText(res.getText()); return; }
      const n = (err as Error)?.name || (err as { constructor?: { name?: string } })?.constructor?.name || 'UnknownError';
      errHist.set(n, (errHist.get(n) ?? 0) + 1);
    },
  );
  say('scanning… point at sender screen');
  if (ticker) clearInterval(ticker);
  ticker = window.setInterval(paint, 1000); // live rate even with zero novel frames
  if (sampler) clearInterval(sampler);
  sampler = window.setInterval(() => {
    const hist = [...errHist.entries()].map(([k, v]) => `${k}=${v}`).join(' ');
    const v2 = sessionProto === 2 && v2dec ? ` blocks=${v2dec.recovered}/${sessionTotal} drops=${v2dec.totalDrops}` : '';
    rep(`SAMPLE proto=${sessionProto ?? '?'} attempts=${attempts} decoded=${decoded} collected=${store.size}/${sessionTotal ?? '?'}${v2} missing=[${missingIndices().slice(0, 40).join(',')}] errs{${hist}}`);
  }, 2000);
};
($('stop') as HTMLButtonElement).onclick = () => {
  controls?.stop(); if (ticker) clearInterval(ticker); ticker = null;
  if (sampler) clearInterval(sampler); sampler = null;
  rep(`STOP collected=${store.size}/${sessionTotal ?? '?'} attempts=${attempts} decoded=${decoded}`);
  say('stopped — tap "Download report" to save the session log');
};
($('report') as HTMLButtonElement).onclick = () => {
  const head = [
    '# QR Image Transfer — receiver session report',
    `# exported=${new Date().toISOString()}`,
    `# fileId=${sessionFileId ?? '?'} proto=${sessionProto ?? '?'} name=${meta?.name ?? '?'} size=${meta?.size ?? '?'} total=${sessionTotal ?? '?'} sha=${meta?.sha256?.slice(0, 16) ?? '?'}…`,
    `# result=${finishedFileId !== null ? 'DONE' : 'INCOMPLETE'} missing=[${missingIndices().slice(0, 100).join(',')}]`,
    '# --- events (t_seconds EVENT) ---',
  ];
  const blob = new Blob([head.join('\n') + '\n' + report.join('\n') + '\n'], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `qr-report-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  say('report downloaded — share the .txt to diagnose');
};
