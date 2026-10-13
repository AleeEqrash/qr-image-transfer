# Benchmark Log

Fixture: `Screenshot 2026-07-23 125613.png`, 33509 B. Phone: Android 10 / Chrome Mobile 155. Same room/distance throughout.

| date | proto | chunk/block | fps | ECC | QRpx | N/K | drops | overhead | TTC_s | decode ok/att | result |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-13 | v1 chunks, 2x dwell | 800 | 8 | M | 720 | 42 | — | — | 224 | 1748/3690 (47%) | DONE, stuck 95% ~3min on frames 22,29 (fractional-module misreads) |
| 2026-10-13 | v2 fountain | 512 | 8 | M | 720 | 66 | 85 | 29% | 82 | 1018/1580 | DONE (data 13s, META wait 60s) |
| 2026-10-13 | v2 fountain, META x10 | 512 | 8 | M | 720 | 66 | 82 | 24% | 18 | 165/326 | DONE, clean cascade |
| 2026-10-13 | v2 fountain, META x10, LT-only passes | 800 | 10 | M | 720 | 66 | 47 | 12% | 10 | 85/180 (47%) | DONE, speed-run same 33KB file |
| 2026-10-13 | v2 fountain, META x10, LT-only passes | 800 | 10 | M | 720 | 4494 | 5931 | 32% | 1146 | 11080/20826 (53%) | DONE 3.6MB photo. Curve: 2000blk@387s, 3000@645s, cascade 4003→4494 in 64s. Errs: NotFound 4.9k, Format 1.8k, Checksum 1.8k |
| 2026-10-13 | v2 fountain, META x10, LT-only passes | 1000 | 10 | Q | 720 | 34 | 10 | — | — (stuck 0/34 @43s) | 12/547 (2%) | FAILED. V25-Q past phone optics. Errs: Format 282 (finder unlocatable), NotFound 151. Verdict: ceiling is 800/M on this hardware |

Fixes proven by reports, in order: integer-scale QR rendering → LT fountain drops → META interleave every 20 frames.

Export receiver log lines `(t, index)` to `bench/run-*.csv` for the TTC(S) fit.
