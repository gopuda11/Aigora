# Shipped icon provenance

The thirteen file assets below are original neutral artwork created for this public release by gopuda11 and licensed under the root MIT license. `scripts/generate-neutral-icons.py` is the complete source: fixed line geometry, colors, circles and system-font letter labels. Raster PNG and ICO bytes are generated with Python standard-library code; no upstream artwork, provider marks, fonts, copied bitmaps or external renderer are incorporated. Maskable icons keep the mark within the central safe area. Existing URLs and dimensions are preserved.

History review: `ff385509` introduced the prior A mark and raster replacements, while `911e2d3a` introduced letter avatars and removed provider avatar bitmaps. Earlier raster icons were inherited from Clay/Clagentic. A commit alone does not establish the origin of raster inputs, so all thirteen file assets have been replaced by this reproducible source. The source tree does not redistribute the previous artwork.

Reproduce into a temporary directory with `python3 scripts/generate-neutral-icons.py --root <empty-directory>` and compare these hashes:

| File | SHA-256 |
| --- | --- |
| `lib/public/apple-touch-icon.png` | `c9416fd3979ad59a45182bc6fe044af972befb7840216c2e3d1c95480fc28276` |
| `lib/public/avatar-claude.svg` | `eed596393f2dafc780a78eb6882844c35266a1ceb6db188cc83e280ffa35749b` |
| `lib/public/avatar-codex.svg` | `dd4ef5b785bb3b705a12144d08901e7cbe040c73318eaaa3531406e039815c1e` |
| `lib/public/favicon-banded.png` | `394e54fffea0b03e8eb94bc73a2480d12c1488e666bdea1bcaae7fce61e04c3e` |
| `lib/public/favicon.ico` | `b5958542f2829db705d778998f3dc8579c580542b85aac6399edc77b957abb87` |
| `lib/public/icon-192.png` | `c22c5e4b4f2d192f62452abcc29b6882bd3f6c084af0bd6c511cea1070c1182e` |
| `lib/public/icon-512.png` | `7bdb43064c5778277af8633d409c176cc9a42747f276df1d576bf74dd8aadee4` |
| `lib/public/icon-banded-76.png` | `a209750503bb5f6794467fe365206ef1d4a08bbf1c5614c631707afa260fb457` |
| `lib/public/icon-maskable-192.png` | `c22c5e4b4f2d192f62452abcc29b6882bd3f6c084af0bd6c511cea1070c1182e` |
| `lib/public/icon-maskable-512.png` | `7bdb43064c5778277af8633d409c176cc9a42747f276df1d576bf74dd8aadee4` |
| `lib/public/icon-mono.svg` | `6a7e8a03c8dd9281ff11abf02e656a4541a88fb6b3f307af124a7d7da243a253` |
| `media/logo/aigora-icon-256.png` | `f9a6fea378a158bf278b255433d1a4d5323ef8ad1fade3ca87deddcc4b7e278b` |
| `media/logo/aigora-icon.svg` | `c08e61d31475ff29be7e2c72a1c09271e8027587ff1eafb6a9bb0d0f6f6355f1` |
