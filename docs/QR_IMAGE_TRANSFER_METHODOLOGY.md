# QR Image Transfer: Image Transmission via Sequential QR Stream (Screen-Camera Link)

## Web-to-Web System — Scientific Documentation & Methodology

**Version:** 1.0 — 2026-10-13
**Scope:** Desktop browser (sender/display) → Phone browser (receiver/camera), loop-until-complete, image-first then generic files.
**Status:** Design + experimental protocol. No implementation yet.

---

## 1. Abstract

This document specifies the scientific basis and engineering methodology for transferring arbitrary binary data — starting with images — through a one-way optical channel: a sender displays the image as a time-multiplexed stream of QR codes (played as a continuous stream), and a receiver scans them with a phone camera, reassembles chunks, verifies integrity, and reconstructs the original file.

The core claim under test is:

> A generic `bytes → chunks → QR frames → looped display → camera scan → reassembly` pipeline implemented purely in web technologies can reliably transfer a ~50 KB image in <60 s and a short text in <5 s on commodity hardware, and can scale to original-quality images (1–5 MB) with predictable linear time cost.

We formalize the channel model, protocol, variables, experimental matrix, metrics, and threats to validity, grounded in QR symbology standards and screen-camera communication (SCC) literature.

---

## 2. Research Questions & Objectives

### 2.1 Primary questions

1. **RQ1 (Feasibility):** What reliable application goodput (correct bytes/s) is achievable with monochrome streaming QR codes in a browser-to-browser SCC link under normal indoor conditions?
2. **RQ2 (Parameter sensitivity):** How do QR payload size (chunk size), display frame rate, error-correction level, display size/distance, and ambient light affect decode success rate and time-to-complete?
3. **RQ3 (Scaling):** What is the time-to-complete function `T(S)` for file size `S`, and is original-quality image transfer (1–5 MB) practically usable or only asymptotically possible?
4. **RQ4 (UX reliability):** Does a simple loop-until-complete strategy (retransmit `meta, 0..N-1` cyclically) achieve 100% eventual reconstruction without a back-channel or forward error correction (FEC)?

### 2.2 Objectives

- **O1:** Build a minimal generic pipeline testable first with text (1–5 QRs), then 50 KB WebP image (~60 frames).
- **O2:** Measure effective scan rate, loss rate, and completion time across a controlled parameter matrix.
- **O3:** Derive an empirical capacity model to predict original-quality transfer time before committing to FEC/fountain-code optimization.
- **O4:** Document a reproducible method any reviewer can rerun with a laptop + phone on a LAN.

### 2.3 Non-objectives (MVP)

Fountain codes / LT/Raptor FEC, encryption/authentication beyond integrity hash, color/multiplexed QR, imperceptible video embedding, native mobile apps, two-way handshake.

---

## 3. Theoretical Background

### 3.1 QR code capacity (standard)

QR is defined by ISO/IEC 18004 (current edition 2024) [1]. Key facts:

- Symbol versions 1–40, from 21×21 to 177×177 modules, +4 modules per version [2][3].
- Maximum theoretical capacity at Version 40-L (lowest ECC): **7,089 numeric / 4,296 alphanumeric / 2,953 bytes / 1,817 Kanji** [4][5][6].
- At Version 40-M: **2,331 bytes**; at Version 40-H: **1,273 bytes** [4][5]. Moving L→H roughly halves capacity because redundancy is taken from the same codeword budget [4].
- ECC levels (Reed-Solomon): **L 7%, M 15%, Q 25%, H 30%** recoverable codewords [6][7].
- Byte mode character-count indicator width depends on version (8/16/16 bits) [8].

**Critical distinction — ceiling vs. scannable capacity:** A Version 40 symbol at 5 cm has ~0.27 mm modules, below what phone cameras resolve at normal distances. “Capacity you cannot scan is not capacity” [4]. Practical streaming systems therefore use mid versions (e.g., ≤213 bytes at V10-M [4]) and accept far lower per-frame payload for speed.

This project therefore adopts a **conservative operating point: 400–1,000 raw bytes/frame**, yielding QR Versions ~10–20 at ECC-M — fast to detect, robust to blur.

### 3.2 Screen-camera channel (SCC) model

Streaming QR is a form of **screen-camera communication (SCC) / optical wireless / visible-light communication**. A recent IEEE survey consolidates streaming-QR enhancements reporting up to **24× storage improvement and ~900 kbps**, and up to **7.6673 Mbps** if distortion is eliminated [9].

Representative prior results (all monochrome unless noted):

| System | Setup | Reported throughput |
|---|---|---|
| Xie et al. (bidirectional phone-to-phone, 2 MP front camera) | low-res front cameras | **~3 kbps** unidirectional [9] |
| Vanderhulst & Trappeniers (video loop, reduced fps) | V1 → V40 sweep | **336 bps (V1) to 472 kbps (V40)** max [9] |
| Liu et al. 2020 (dynamic QR, mobile) | real-time / non-real-time | **150 / 300 kbps**; color-multiplexed **320 / 900 kbps**, text/picture/audio error-free [10][11] |
| Fath et al. (inflight screen → phone, color QR + temporal FEC) | screen at ½ camera rate | **120.43 kbps** [9] |
| FareQR (SEC 2020, border + Viterbi de-mixing) | rolling-shutter + inter-frame mixing fix | recovers mixed blocks, reduces block error rate [12] |
| RescQR (TMC 2024, mixture separation + Viterbi) | standard QR | **400+ kbps goodput** [13] |
| ChromaCode / AirCode (imperceptible embedding) | invisible + audio metadata | **~551 kbps raw, 5–8% BER**; AirCode **~1 Mbps, 5% BER** [14][15] |

Three lessons directly shape this methodology:

1. **Display rate must be ≤ ½ camera capture rate.** Asynchronous SCC loses data when display fps exceeds capture fps; Fath et al. explicitly set screen fps to half the camera rate [9]. A 60 Hz screen vs. 30 fps camera does not mean 30 QR/s is decodable — rolling shutter and inter-frame mixing create composite/blurred frames [12][13].
2. **Composite frames are the dominant error source at high fps.** FareQR and RescQR exist precisely to detect and de-obfuscate mixed frames with borders + Viterbi decoding [12][13]. MVP avoids this complexity by **capping display at 8–10 fps**.
3. **Real-time browser decoding is the bottleneck, not display.** Phone browsers decoding 1080p frames in JS achieve ~5–15 successful decodes/s even if the screen shows 30/s. Hence the hypothesis of **8–12 QR/s effective**.

### 3.3 Receiver technology constraints

- **@zxing/browser** (`BrowserQRCodeReader.decodeFromVideoDevice`, `decodeContinuously`) is the maintained browser layer over the ZXing port [16][17]. Continuous mode + `listVideoInputDevices` + torch control is the standard path.
- **jsQR** is a pure-JS ZXing QR port taking RGBA frames (`jsQR(data, width, height)`) [18]. Recommended pattern is to run it in a **Web Worker** on each video frame to avoid main-thread jank [19].
- Known issue: ZXing-JS degrades on very high-resolution inputs; downscaling (e.g., to ~640 px) before decode improves detection and speed [20].
- Camera access requires **secure context (HTTPS or localhost)** and explicit permission; LAN testing needs `https://<laptop-ip>` or a tunnel. This is a methodological requirement, not optional.

### 3.4 Compression note

JPEG/PNG/WebP images are already entropy-coded; generic gzip after image encoding yields negligible gain. Therefore:

- For **original quality**: transmit raw file bytes (no recompression), chunk and send.
- For **fast mode** (later option): downscale + WebP/AVIF re-encode sender-side before chunking.
- MVP tests both paths but measures them separately — do not conflate codec gain with channel gain.

---

## 4. Hypotheses

- **H1:** With `chunkSize=800 B, ECC=M, display=8 fps`, a phone browser at 20–40 cm from a laptop screen in indoor light achieves **≥8 successful novel decodes/s (median)** and **<20% frame-loss rate** requiring only loop retransmission.
- **H2:** Time-to-complete is approximately linear: `T(S) ≈ ceil(S/C_eff) / G + K·loops`, where `C_eff` = application payload/frame, `G` = goodput (novel frames/s), `K` = loop overhead. A 50 KB image completes in <60 s.
- **H3:** Increasing `chunkSize` beyond ~1,000 B or `fps` beyond ~12 **decreases** goodput (denser QR = slower detect; faster display = more composites), producing a concave optimum around 600–900 B / 6–10 fps.
- **H4:** Loop-until-complete alone (no FEC, no back-channel) achieves eventual 100% reconstruction for `N ≤ 2,000` frames given unbounded loops, at the cost of long-tail latency from rare missing frames.

H3 and H4 are falsifiable and motivate the experimental matrix in §7.

---

## 5. System Architecture (Web-to-Web)

No backend, no database. Two static pages served over HTTPS on LAN.

```text
[SENDER laptop]  File/Text → protocol.encode → QR images → Looped player (8 fps fullscreen)
        | optical channel (screen → air → camera, no radio)
        v
[RECEIVER phone] Camera → frame sampler → QR decoder → collector → verifier → Blob preview/download
```

### 5.1 Sender responsibilities

1. Accept text or file → `ArrayBuffer`.
2. Compute SHA-256 (integrity), generate `fileId` (random uint32 per session).
3. Chunk into `C` -byte payloads (`C` tunable, default 800).
4. Build packets (§6), encode each to QR (npm `qrcode`, ECC-M default), cache as canvases/data-URLs.
5. Play loop `meta, 0..N-1` at set fps with `setInterval`/`rAF`, fullscreen high-contrast (black on white + quiet zone ≥4 modules), overlay `index/total` **outside** the QR matrix.
6. Expose controls: fps, chunkSize, ECC, QR scale, pause/resume; display stats (N, est. time).

### 5.2 Receiver responsibilities

1. `getUserMedia({ facingMode: 'environment', width: { ideal: 1280 } })`, render preview.
2. Sample to offscreen canvas at ~640 px wide, decode continuously (ZXing preferred, jsQR+Worker fallback).
3. On `meta` frame → init session `{ total, size, mime, sha256 }`, reset map.
4. On data frame → verify CRC16, dedupe by `(fileId, index)`, store.
5. UI: progress bar `collected/total`, missing-chunk bitmap, effective fps, elapsed time.
6. On `collected == total` → concat in index order → verify SHA-256 → `Blob URL` → `<img>`/download + timing report.

---

## 6. Protocol Specification (v1, MVP-frozen)

Designed to be implementable identically in TS and Python (no language-specific serialization).

### 6.1 Frame types

| Type | Encoding | Content |
|---|---|---|
| `META` | QR (JSON string, UTF-8, ECC-Q for robustness) | `{ v:1, fileId:u32, name, size:u64, mime, total:u24, chunkSize:u16, sha256:hex64, createdAt }` |
| `DATA` | QR (base64url of binary packet, ECC-M) | binary packet below |

Base64url is chosen over raw binary because browser QR encoders reliably accept text; overhead (+33%) is accepted and measured as part of `C_eff`.

### 6.2 DATA binary packet (big-endian)

```text
Offset  Size  Field
0       2     MAGIC = 0x51 54 ('QT')
2       1     VER = 0x01
3       4     fileId uint32
7       3     total uint24 (max 16,777,215 frames)
10      3     index uint24
13      2     crc16-CCITT of payload only
15      C     payload bytes (C = chunkSize, last chunk may be short)
```

Total per-frame pre-base64: `15 + C` bytes. Example `C=800` → 815 B → ~1,088 base64 chars → QR V~17–19 at M (encoder-dependent; measure and record actual version).

### 6.3 Loop discipline

Repeat indefinitely: `META, DATA[0], DATA[1], ..., DATA[N-1], META, ...`. Receiver may join mid-loop. Sender never changes `fileId` mid-session. `VER` + reserved discipline leaves room for future FEC header without breaking v1 decoders (they ignore unknown versions).

### 6.4 Integrity

- Per-frame: CRC16 catches mis-decodes / bit flips before insertion.
- Per-file: SHA-256 in META checked after reassembly; mismatch → keep scanning (do not declare success).

---

## 7. Experimental Methodology (Scientific Method)

Follows: observation → hypothesis (§4) → prediction → controlled experiment → analysis → replication.

### 7.1 Variables

**Independent variables (factors):**

| Factor | Levels (MVP matrix) | Rationale |
|---|---|---|
| Chunk size `C` | 400, 600, 800, 1000 B | density vs. speed tradeoff |
| Display fps | 6, 8, 12 (cap; 30 only as negative control) | mixing/blur threshold |
| ECC | M (primary), L/Q as contrast | redundancy vs. density |
| Distance | 20, 30, 50 cm (fixed tripod/handheld note) | module resolution |
| Light | 200 lux dim / 500 lux office (phone lux app) | exposure/contrast |
| Payload | 5 B text, 5 KB text, 50 KB WebP | scaling validation |
| Devices | ≥2 phones × 1 laptop screen (record models) | generalizability |

**Dependent variables (responses):**

- `G` goodput (novel correct frames/s), `R_raw` raw decode attempts/s
- Frame loss rate (missed + CRC-fail / displayed)
- Time-to-first-frame (TTFF), time-to-complete (TTC)
- End-to-end success (SHA-256 match) within 5-min cap
- Receiver CPU (approx. via `requestIdleCallback` / devtools) — secondary

**Controlled (held constant):** fullscreen, max brightness, dark UI surround, quiet zone, perpendicular angle (0°), same Wi-Fi/HTTPS serving, same decoder version, autofocus locked where possible.

### 7.2 Procedure (per cell, repeat n=3)

1. Sender: load fixture (text/50 KB), set `(C, fps, ECC)`, record `N = ceil(S/C)`, start loop.
2. Receiver: at marked distance, start scan, log timestamped `(index, wallTime)` for every accepted novel frame.
3. Stop at SHA-256 success or 5-min timeout. Export log + TTC + missing map.
4. Cool-down 30 s (avoid thermal throttling bias), randomize order of cells (counterbalance learning/fatigue effects).
5. Negative control: one run at 30 fps display to demonstrate collapse (expected high loss, validates H3).

### 7.3 Fixtures

- `T1`: `"HELLO QR"` (8 B) — smoke test, expect N=1.
- `T2`: 5 KB lorem (forces ~7 frames at C=800) — multi-frame ordering test.
- `I1`: 50 KB WebP (e.g., 640 px photo re-encoded) — primary benchmark.
- `I2 (extrapolation only, not MVP pass/fail)`: 1 MB JPEG original — run once at best MVP setting to validate linear model, allow up to 15 min.

### 7.4 Quantitative model to fit

```text
N = ceil(S / C)
C_eff = C / (1 + overheadRatio)   # overhead = header + base64; measure empirically
TTC_predicted = N / G_median + loopPenalty
```

Report `G_median` per cell with IQR, plot `TTC vs. S` and `G vs. C` / `G vs. fps`. Fit linear regression for TTC(S); report R². Declare H1–H4 supported/refuted per pre-registered thresholds (§7.5).

### 7.5 Pass/fail (pre-registered)

- **M1 pass:** T1 completes <5 s in 3/3 runs at default setting.
- **M2 pass:** I1 completes <60 s median and SHA-256 matches in ≥2/3 runs at any matrix cell.
- **H1 support:** median G ≥ 8/s at default cell.
- **H3 support:** G(C=1000) < G(C=800) OR G(fps=12) < G(fps=8) with p<0.05 (Mann-Whitney, n≥9 logs pooled) — else refuted, optimum elsewhere.
- Extrapolation: predict 1 MB TTC from I1 model within ±30% of observed I2 (validates linearity).

### 7.6 Threats to validity & mitigations

| Threat | Mitigation |
|---|---|
| Screen/camera heterogeneity | record exact models, brightness, resolution; test ≥2 phones |
| Hand shake / angle | tripod or stack-of-books jig; log handheld vs. fixed |
| Ambient flicker / glare | fixed lux levels, perpendicular, matte screen filter note |
| Decoder warmup / throttling | randomized order, cool-down, report first-run vs. steady |
| Base64 bloat confounding | report both raw and on-wire chars; version actually used |
| Experimenter bias | pre-register thresholds above; publish raw logs |

---

## 8. Implementation Roadmap (Build Order)

- **M1 — Text loop (hours):** `src/protocol.ts` (chunk/encode/decode/crc16/sha256) + unit tests (round-trip, CRC catch, out-of-order reassembly) + `sender` text→QR loop + `receiver` continuous scan. Gate: T1 <5 s.
- **M2 — Image + UX (1–2 days):** file picker, META frame, progress/missing map, Blob preview/download, tunable fps/chunk/ECC, fullscreen mode. Gate: I1 <60 s.
- **M3 — Benchmark harness (½ day):** one-click fixture loader, CSV log export `(cell, run, index, t)`, `BENCHMARK.md` auto-template, distance/lux checklist. Gate: matrix complete, model fitted.
- **Backlog (not MVP):** Reed-Solomon/Fountain outer code, color QR 3× multiplexing [10], mixed-frame Viterbi recovery [12][13], encryption (AES-GCM + ECDH), PWA offline install.

Suggested minimal tree:

```text
index.html  sender.html  receiver.html
src/protocol.ts  src/sender.ts  src/receiver.ts  src/bench.ts
test/protocol.test.ts  fixtures/hello.txt  fixtures/photo-50k.webp
BENCHMARK.md  QR_IMAGE_TRANSFER_METHODOLOGY.md (this file)
```

---

## 9. Limitations & Ethics

- **Throughput:** Even at 400+ kbps lab goodputs [13], original-quality multi-MB files take minutes — unsuitable for urgent or large-scale use. Document, do not oversell.
- **Security:** Screen is shoulder-surfable; anyone in line-of-sight can capture. MVP provides integrity (SHA-256) but **no confidentiality** — do not transfer sensitive images without later encryption layer. No radio means no remote interception, which is a privacy advantage for air-gapped use — state both.
- **Accessibility & safety:** Sustained flashing at 8–12 fps can bother photosensitive users; provide pause, static-step mode, and warning. Max brightness + dark room guidance has eye-strain cost — time-box sessions.
- **Reproducibility:** All results are device- and environment-specific; report full context or the numbers are meaningless.

---

## 10. References (Sources)

1. ISO — ISO/IEC 18004:2024 QR code symbology specification (Edition 4). Confirms scope: symbology, encoding, ECC rules, quality requirements. https://www.iso.org/standard/83389.html
2. DENSO WAVE — Information capacity and versions of QR Code. Versions 1–40, 21×21 to 177×177, +4 modules/version. https://www.qrcode.com/en/about/version.html
3. PHP-QRCode docs — Terminology: side length `4*version+17`, version info / format info / character-count widths. https://php-qrcode.readthedocs.io/en/main/Appendix/Terminology.html
4. UseQR — How much data fits in a QR code. V40-L ceilings (7,089 / 4,296 / 2,953 B), V40-M 2,331 B, V40-H 1,273 B; density–scannability curve; V10-M ≈213 B table. https://useqr.app/docs/spec/how-much-data-fits-in-a-qr-code
5. Aspose Barcode docs — 101×101 high-ECC ≈406 B; 177×177 1,273–2,953 B by ECC. https://docs.aspose.com/barcode/info-cards/qr-code
6. JpGraph QR manual Ch.27 — 40 sizes, 4 ECC levels, capacity tables incl. V40 L/M/Q/H byte caps 2,953/2,331/1,663/1,273. https://jpgraph.net/download/manuals/chunkhtml/ch27.html
7. ISO/IEC 18004:2024 sample (§3–4) — max V40-L byte 2,953; ECC L/M/Q/H 7/15/25/30%. https://cdn.standards.iteh.ai/samples/83389/dee29007cb62437f9767323e6af02f90/ISO-IEC-18004-2024.pdf
8. PHP-QRCode / Thonky-referenced ECC model — Reed-Solomon ECC, count-indicator widths (Byte 8/16/16). https://php-qrcode.readthedocs.io/en/main/Appendix/Terminology.html
9. IEEE Survey — Streaming QR Codes (2024, document 10681075). Consolidates SCC: up to 24× / 900 kbps, 7.6673 Mbps distortion-free; Xie 3 kbps; Vanderhulst 336 bps–472 kbps; Fath 120.43 kbps at ½ camera rate; Liu custom 225 kbps. https://ieeexplore.ieee.org/document/10681075
10. Liu et al. 2020 — Screen-Camera Communication System Based on Dynamic QR Code (IOP). Traditional 150/300 kbps real/non-real-time; color-multiplexed 320/900 kbps; text/picture/audio error-free. https://iopscience.iop.org/article/10.1088/1757-899X/790/1/012012
11. Same work (PDF mirror) — confirms multiplexed 3-QR color method and 60 Hz / 30 fps test rig (AMOLED 2560×1440). https://iopscience.iop.org/article/10.1088/1757-899X/790/1/012012/pdf
12. Wang et al. 2020 — FareQR: Fast and Reliable Screen-Camera Transfer (SEC). Outline border + Viterbi hard-decision for rolling-shutter/mixed frames. https://www.computer.org/csdl/proceedings-article/sec/2020/594300a364/1rqEzm2yG9q
13. RescQR 2024 — Enabling Reliable Data Recovery in SCC (TMC 23, pp. 3510–3522). Mixture separation + Viterbi + auto-config; 400+ kbps goodput with standard QR. https://www.computer.org/csdl/journal/tm/2024/05/10128721/1NdJJqmIv8k
14. Zhang et al. (MobiCom’18) — ChromaCode: Fully Imperceptible SCC. Goodput vs. throughput vs. BER framing; 312–621 kbps raw on textured video. https://www.cs.purdue.edu/homes/chunyi/pubs/mobicom18-zhang.pdf
15. NSDI’21 slides — ChromaCode/AirCode: 551 kbps @ 8% BER → AirCode ~1 Mbps @ 5% BER; audio metadata channel. https://www.usenix.org/system/files/nsdi21_slides_qian-kun.pdf
16. ZXing-JS Browser — README: `BrowserQRCodeReader`, `decodeFromVideoDevice`, `decodeContinuously`, `listVideoInputDevices`. https://github.com/zxing-js/browser/blob/master/README.md
17. ZXing-JS Browser package — `@zxing/browser` v0.2.1, browser layer scope. https://github.com/zxing-js/browser/blob/master/package.json
18. jsQR (npm v0.2.2) — pure-JS ZXing QR port, RGBA→string wrapper + stepwise API. https://www.npmjs.com/package/jsqr/v/0.2.2
19. How-To Geek — Scan QR in browsers with Web Workers + jsQR (worker-per-frame pattern for 60 fps UI). https://www.howtogeek.com/devops/how-to-scan-qr-codes-in-web-browsers-with-web-workers-and-jsqr
20. ZXing-JS issue #236 — downscaling high-res inputs fixes `NotFoundException`; resolution–detectability tradeoff. https://github.com/zxing-js/library/issues/236

---

## 11. Appendix A — Worked Example (Why Defaults Are What They Are)

Assume `C=800 B`, header 15 B → 815 B → base64url ≈1,087 chars → QR ≈V17-M (typical encoder).

- 50 KB image: `N = ceil(50,000/800) = 63 frames`. At `G=8/s` → ~8 s ideal, ~15–30 s with misses + loop overhead. Comfortably <60 s → M2 feasible.
- 1 MB original: `N = 1,250 frames` → ~156 s ideal at 8/s, realistically 3–6 min with tail. Usable but tedious — motivates future FEC.
- 5 MB original: `N = 6,250` → 13+ min ideal. Not MVP-usable; document as scaling limit.

Hence: **default 800 B / 8 fps / ECC-M**, tune ± from measured `G`, do not start at 30 fps or V40.

## 12. Appendix B — Reproducibility Checklist (attach to every run)

- [ ] Laptop model, screen size/resolution/brightness, browser version
- [ ] Phone model, camera MP, browser version, `getUserMedia` constraints used
- [ ] Distance (cm), angle (°), handheld/fixed, lux (approx.)
- [ ] Commit hash, `(C, fps, ECC)`, fixture name + SHA-256, N observed
- [ ] Raw log CSV + TTC + success/fail + notes (glare, blur, throttle)

---

*End of methodology. Implementation must cite this file for any parameter default that deviates (note cell + reason).*
