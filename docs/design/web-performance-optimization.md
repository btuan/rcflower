# Web app performance optimization

Status: **proposal, partly implemented** (written 2026-11-06). A prioritized
list of ways to make the deploy faster and the web app lighter, with the
Arduino Uno Q (4 in-order cores, ~3.6 GB RAM) as the constraint that matters.
The CV side is covered separately in
[ml-inference-optimization.md](ml-inference-optimization.md).

## How to read this

- **Measured** numbers come from a Windows dev machine, not the Uno Q. Treat
  absolute times as lower bounds for the device; sizes and ratios carry over.
- **Unmeasured** items say so. Do the "Measure first" step before spending time
  on anything marked that way.
- Priority is value for effort and risk, highest first within each section.
- Two audiences load the app, and they differ: the **kiosk** (a browser on the
  device itself, loading from loopback, so network size barely matters but
  parse/render cost does) and **remote visitors** (phones on the public
  Funnel URL or the RC LAN, where bytes over the wire matter too).
- **The main demo is a remote-visitor scenario.** The presenter (a Pixel 9)
  opens `/live` on their phone while another person opens `/watering-can` on
  theirs and tilts the screen to simulate watering the flower. `/live` loads
  the JS bundles and a ~1 MB GLB (no 2D images); `/watering-can` loads the JS
  bundles and the watering-can WebPs (upright and two pouring poses, in four
  widths via `srcset`). Recurse Center users have capable phones and current
  browsers, so decode speed on their side is not a concern; **bytes over the
  wire on varied networks** (RC Wi-Fi with the device on the LAN, other Wi-Fi,
  mobile data) are what the demo is sensitive to. That makes S1 (compression),
  F4 (smaller GLBs) and F7 (AVIF) all demo-path items.

## Measure first

Nothing below has been timed on the Uno Q. Before the larger items:

1. Time each deploy step on the device (`npm ci`, `bun run build`,
   `bun install`, `uv sync`). Wrap them with `time`, or compare the timestamps
   in `journalctl` output. This tells us whether build optimizations are worth
   doing at all once `npm ci` is skipped.
2. Profile `/live` on the kiosk: Chrome DevTools Performance with the real
   hardware (not throttling a desktop), plus a bundle visualizer
   (for example `rollup-plugin-visualizer`) on `frontend/dist`.
3. Record the baseline here, in place, with a date, as
   [../hardware/raspberry-pi-4b.md](../hardware/raspberry-pi-4b.md) does.

## Measured so far (dev machine, 2026-11-06)

| Thing | Raw | Compressed |
| --- | --- | --- |
| `index-*.js` (entry) | ~350 KB | ~116-118 KB gzip |
| Large shared chunk (almost certainly three.js, oddly named `flower_dead-*.js`) | ~615 KB | ~152-155 KB gzip |
| One mood `.glb` | ~880-981 KB | ~453 KB gzip (for the 981 KB one) |
| Flower WebPs (2048 px) | ~424 KB mean | gzip doesn't help; other image formats do, see "Image formats" |
| `tsc -b` | ~3.9 s (possibly a warm incremental run) | |
| `vite build` | ~1.5 s | |

The backend currently sends all of this uncompressed. `/assets/*` already has
`immutable` caching; `index.html` is `no-cache`.

## Build and deploy time

| # | Change | Value | Effort / risk | Status |
| --- | --- | --- | --- | --- |
| B1 | Skip `npm ci` when `package-lock.json` is unchanged; show progress instead of `--silent`; add `--no-audit --no-fund` | High: `npm ci` took minutes on the Uno Q and wiped `node_modules` on every deploy | Low | **Done** (`88339be`, `7d6a850`) |
| B2 | Don't typecheck on deploy. The `build` script is `tsc -b && vite build`; the device only needs `vite build`. Keep `tsc` as a separate dev/CI script | Medium: `tsc` was the larger share of the build here, and it's single-threaded on an in-order CPU | Low. Needs a decision on where the typecheck runs instead (dev, CI, or `bun run typecheck` before commit) | Proposed |
| B3 | Skip the frontend build when nothing under `frontend/` changed since the last build | Medium: most deploys are backend or docs changes | Low-medium. Easiest as part of B5 | Proposed |
| B4 | Build `frontend/dist` on a fast machine (or CI) and ship it, so the device needs no Node tooling or `node_modules` at all | Highest, if the device build is slow. Removes `npm ci` and the build from the device entirely | Medium. Changes the deploy flow from `git pull && ./deploy/install-systemd.sh`; needs a place to host the artifact and a rule that `dist` isn't committed | Proposed. Decide after timing (see above) |
| B5 | Drive the deploy with `make -j` instead of growing the shell script. Targets with file dependencies give B1's skip, B3, and running the backend `bun install` and `uv sync` in parallel with the frontend chain | Medium. Parallel gain is small on routine deploys (installs are near no-ops once cached), larger on a first deploy or dependency change | Low-medium. Check `make` is installed on the devices. Freshness is by mtime, so `git pull` correctly invalidates changed files | Proposed. Device has 4 cores and ~3 GB available RAM, so memory is not a blocker |
| B6 | Replace `npm` with Bun for installs ([bun-only-toolchain.md](bun-only-toolchain.md)) | Unknown: likely faster installs, no build-time change. Time both on the device first | Medium: deploy risk on the only live site | Proposed, separate branch |

Order: time the steps, then B2 (cheap), then B5 if parallelism or skip logic is
still wanted, and B4 only if the on-device build is still slow.

## Backend run time

| # | Change | Value | Effort / risk |
| --- | --- | --- | --- |
| S1 | **Compress static responses.** `serveStatic` in `backend/src/http.ts` sends no `Content-Encoding`. Precompress at build time (`.br` / `.gz` next to each file) and serve by `Accept-Encoding`, rather than compressing per request on a weak CPU. Skip already-compressed formats (WebP) | High for remote visitors: JS ~965 KB raw -> ~270 KB, `.glb` roughly halves. **No effect on the kiosk** (loopback) | Low-medium: a small build step plus `Vary: Accept-Encoding` and correct content types |
| S2 | Add `ETag` / `Last-Modified` handling for `index.html` so revalidation returns 304 | Small. `index.html` is tiny | Low |

The backend does little else per request; its SSE and detection ingest paths
were not profiled. Check CPU use of `rcflower-backend` under `top` while the
detector is running before assuming it needs work.

## Frontend run time

| # | Change | Value | Effort / risk |
| --- | --- | --- | --- |
| F1 | **Lazy-load every route.** `main.tsx` imports all routes eagerly except `FlowerShake` and `FlowerLive`, so `/live` also downloads and parses `/debug`, `/flower` and the rest. Also remove the leftover `console.log(Flower)` in `main.tsx`, which keeps `Flower` in the entry bundle | High for the kiosk: less JS to parse on a slow CPU | Low |
| F2 | **Check what's in the ~615 KB chunk.** If it's three.js, confirm only the used parts are included (tree-shaking), and give it a sensible chunk name. A visualizer settles this. Vite's >500 kB warning already flags it | Medium-high. Cutting even a third helps parse time | Low to investigate; medium if it needs import changes |
| F3 | **Rebuilding the scene on every mood change.** `FlowerLive`'s main `useEffect` depends on `[mood]`, so a change tears down and recreates the renderer, scene and model. The first render also loads the `neutral` model, then loads a second once the SSE mood arrives. Keep one renderer and swap only the model, and/or wait for the initial mood before choosing a model | Medium-high on an in-order CPU, and avoids a visible flash | Medium. Touches the render lifecycle; test on the device |
| F4 | **Shrink the `.glb` files** (~0.9-1 MB each, four of them). They have no textures, only float32 vertex data, so the options are quantization and mesh compression; see "3D model formats" below | Medium-high: the heaviest assets on the page | Low (quantization) to medium (meshopt, Draco). A visual check and a test of `flowerSpring`'s bone lookups are needed |
| F5 | **One geometry, four poses** instead of four meshes ([`tools/flower/ANIMATION.md`](../../tools/flower/ANIMATION.md), open decision 1). Roughly a 4x download cut and smoother mood transitions | High, but largest change | High: changes the model exporter and runtime. Do after F3/F4, if at all |
| F6 | Cap the render loop (for example 30 fps) or pause when nothing is moving | Unknown: the renderer already uses `antialias: false` and `pixelRatio: 1`. Measure CPU/GPU use on the device first | Low |
| F7 | **Build AVIF alongside the WebPs** and serve it with `<picture>` (WebP as the fallback). Roughly a third smaller at matched PSNR in the measurements below. Also serve smaller sizes than 2048 px where the display is smaller (`srcset`) | Medium-high for remote visitors: `/watering-can` (part of the demo), `/` and `/flower` load the WebPs. No effect on the kiosk (`/live`), which loads no 2D images | Low-medium |

## Image formats (measured)

The flower WebPs are generated from the 2048 px PNGs in `assets/flower/` by
`frontend/scripts/gen-flower-images.mjs` (sharp, WebP quality 82). Measured
2026-11-06 on the dev machine with sharp 0.35 (libaom/libwebp) and ImageMagick
7.1.2 (libjxl 0.12), mean over the four mood images. Quality is **PSNR against
the resized source** (premultiplied RGBA), a rough proxy, not a perceptual
metric. Compare sizes at similar PSNR, not at similar "quality" numbers, since
each codec's quality scale differs.

| Width | WebP q82 (current) | AVIF q60, 4:4:4 | AVIF q70, 4:4:4 | AVIF q50, 4:2:0 | JXL d1.0 |
| --- | --- | --- | --- | --- | --- |
| 256 | 15.1 KB, 46.9 dB | 9.2 KB, 46.2 dB | 10.8 KB, 47.9 dB | 6.2 KB, 43.3 dB | 20.1 KB, 46.1 dB |
| 512 | 43.7 KB, 49.4 dB | 22.8 KB, 47.9 dB | 27.1 KB, 49.5 dB | 15.0 KB, 45.1 dB | 58.1 KB, 49.0 dB |
| 1024 | 128.6 KB, 51.1 dB | 57.2 KB, 48.4 dB | 69.9 KB, 50.0 dB | 37.5 KB, 45.6 dB | 175.7 KB, 50.7 dB |
| 2048 | 424.2 KB, 51.2 dB | 182.8 KB, 48.4 dB | 229.7 KB, 50.0 dB | 124.2 KB, 45.8 dB | 535.3 KB, 51.4 dB |

(Full sweep including WebP q70, AVIF q50 4:4:4 and JXL d1.5/d2.5 was run; the
columns above are the useful ones.)

What it shows:
- **AVIF beats WebP at every size here, including 256 px.** At 256 px, AVIF
  q70 4:4:4 is 10.8 KB at 47.9 dB against WebP's 15.1 KB at 46.9 dB. The
  "WebP wins on thumbnails" claim does not hold for these illustrations.
  Matching WebP's quality needs something near AVIF q70 at 512 px and larger,
  which is still roughly 35-45% smaller (230 KB vs 424 KB at 2048 px, at about
  1 dB lower).
- **4:4:4 costs 8-20% more than 4:2:0** at the same quality setting (more at
  small sizes: 7.5 vs 6.2 KB at 256 px, 134 vs 124 KB at 2048 px) and raises
  PSNR by only 0.2-0.9 dB (flat colour edges are where chroma subsampling
  shows). PSNR is a blunt measure of chroma loss, so whether the
  difference is visible is open; see "Chroma subsampling" below.
- **JXL was larger than WebP at matched PSNR** in this run (20.1 vs 15.1 KB
  at 256 px, 535 vs 424 KB at 2048 px) and 2-3x slower to encode. It's also the
  least supported format in browsers. It might do better with tuned settings
  (this used ImageMagick with `jxl:distance` and `effort=7`), but it isn't a
  promising direction for these images.
- **Encode time** is not an issue: images are generated by hand and
  committed, not at deploy time (sharp AVIF ~0.8 s at 2048 px).

Scope: the kiosk only shows `/live` (`FlowerLive`), which currently loads no
2D images, only a GLB rendered with WebGL. So **no image decoding happens on
the device today, and the image-format work does nothing for the kiosk.** The
WebPs are loaded by `Flower.tsx` and `Home.tsx` (the flower images) and
`WateringCan.tsx` (the watering-can images), so AVIF helps `/`, `/flower` and
`/watering-can`, which is part of the demo. The numbers above come from the
four **flower** images only; the **watering-can** sources in
`assets/watering_can/` haven't been measured yet, and should be before
committing to a quality setting.

**Decision: AVIF with WebP fallback is the format to adopt.** The audience
has capable phones and current browsers (decode cost is not a concern), and
bandwidth is what varies, so AVIF's ~35-45% saving is worth taking. Keep the
WebPs as the `<picture>` fallback for browsers without AVIF; skip JXL.

Still to check before shipping:
- **Visual quality by eye**, especially edges and the alpha channel.
- **Which AVIF quality and chroma subsampling to use**, per the next section.
  Pick by eye at the sizes the pages actually display.

### Chroma subsampling: 4:4:4, 4:2:2 and 4:2:0

Worth exploring all three; 4:2:0 is the smallest and 4:4:4 the sharpest, and
4:2:2 sits between them. In the measurements above 4:2:0 at q50 is much smaller
than 4:4:4 at q50 (8-20%) but loses 0.2-0.9 dB, and the loss concentrates on
coloured edges.
The fair comparison is by eye (and with a chroma-aware metric such as
SSIMULACRA2 or Butteraugli) at the sizes the pages display, with quality
raised for 4:2:0 until it matches.

- Sharp's AVIF output (`chromaSubsampling`) only offers `4:2:0` and `4:4:4`.
  **4:2:2 needs a different encoder**, such as `avifenc --yuv 422` (libavif)
  or ImageMagick; I haven't run it.
- Browser support is not uniform across the three: 4:2:0 is the AV1 Main
  profile every AVIF-capable browser decodes, and 4:4:4 is High profile.
  4:2:2 is in the Professional profile, which I believe is less commonly
  hardware-accelerated and less thoroughly tested in browsers. Test it on the
  target phones (a Pixel 9 at least, plus iOS Safari) before depending on it.

### Future: decoding 2D images on the Uno Q's GPU

If `/live` later gets background images or textures, the Uno Q's Adreno 702
reportedly has hardware decoders for H.264, H.265 and VP9 (per the
[Uno Q datasheet](https://docs.arduino.cc/resources/datasheets/ABX00162-ABX00173-datasheet.pdf);
not re-verified here). That makes HEIC (an H.265 intra frame in a HEIF
container) a theoretical way to decode stills in hardware. Things to check
before relying on it:
- **AVIF would not benefit.** It's AV1, which isn't in that list.
- **Browsers decode images in software.** Hardware decode is normally reached
  through the video pipeline (`<video>`, WebCodecs `VideoDecoder`), not
  `<img>`. Chrome and Firefox don't support HEIC in `<img>` at all (Safari
  does), and H.265 has patent-licensing baggage.
- **A more portable route to the same goal:** play a short H.264/VP9 clip or
  still frame through `<video>` and use it as a texture, or use GPU-compressed
  textures (KTX2/Basis), which stay compressed in GPU memory and need no
  decode step on the CPU at all.
- Whether the browser on the device actually uses the hardware decoder (via
  V4L2/VA-API) is a configuration question to test on the device.

## 3D model formats

Compression in the 3D world is mostly glTF extensions, so keep `.glb` and add
compression to it, rather than switching format. A plain `.glb` is already
binary, but it stores vertex data uncompressed.

What the current files contain (neutral mood; the others are similar): no
images or textures at all, 14 skinned meshes and about 14,000 vertices, about
84,000 indices, and `KHR_materials_specular` as the only extension. Each
vertex is float32 `POSITION` (12 bytes), `NORMAL` (12), `COLOR_0` (12),
`JOINTS_0` (4) and `WEIGHTS_0` (16), 56 bytes in all, so about 788 KB of the
~958 KB binary chunk is vertex data and ~168 KB is 16-bit indices. **Texture
compression (KTX2/Basis) does not apply**, and my earlier suggestion to check
whether textures dominate was moot.

| Option | What it does | Needs at runtime | Fit here |
| --- | --- | --- | --- |
| `KHR_mesh_quantization` | Stores positions as int16, normals and colours as 8-bit, weights as 8-bit, instead of float32. Lossy but visually negligible if ranges are sane | Nothing: three's `GLTFLoader` supports it natively | **Best first step.** My arithmetic estimate: ~24 bytes/vertex instead of 56, so the binary goes from ~958 KB to ~505 KB (about 47% smaller) before any other compression. Not measured by running it |
| `EXT_meshopt_compression` ([meshoptimizer](https://github.com/zeux/meshoptimizer)) | Reorders and delta/entropy-codes vertex and index buffers. Designed to be applied on top of quantization, and to be followed by gzip/brotli. Handles skinning data | A small WASM decoder (`MeshoptDecoder` ships with three's examples); very fast decode | **Best fit for a weak CPU.** Typically cuts well past quantization alone; expect it to compress the skin weights very well, since they are smooth blends of two bones |
| `KHR_draco_mesh_compression` ([Draco](https://google.github.io/draco/)) | Higher ratio on geometry, but slower to decode and it targets positions/normals/UVs; skin data compresses less well | `DRACOLoader` plus a WASM decoder (hundreds of KB) served from the backend | Probably not worth it: bigger decoder, slower decode on an in-order CPU, and little geometry to win on. Use only if meshopt falls short |
| `KHR_texture_basisu` (KTX2) | GPU-compressed textures | Basis transcoder | N/A: no textures |
| `.gltf` / `.obj` | Text formats | | Larger than `.glb`; not an option |
| Custom or other binary formats (USDZ, FBX, ...) | | Custom loaders | No browser or three.js advantage over glTF; skip |

Suggested path: run `gltf-transform quantize` then `gltf-transform meshopt`
(and *not* `optimize`, which can merge meshes and prune the bones that
`frontend/src/flowerSpring.ts` looks up by name), compare the sizes of the
raw and gzipped results, load the result in `/flower-shake` and `/live`, and
check that the bones still drive the pose. Wire `MeshoptDecoder` into the
loaders in `FlowerLive.tsx` and `FlowerShake.tsx`. The four moods share the
same rig, so this is also a good time to decide on "one geometry, four poses"
(F5).

Not run yet: I tried to run the gltf-transform CLI to get real numbers, but
the one-off `npx` package download was blocked in this session. The estimates
above are therefore arithmetic from the file's accessor layout, not
measurements. Install `@gltf-transform/cli` once and run the commands above to
replace them.

## Not recommended yet

- **Replacing React** (for example with Preact). The React Compiler is already
  on and `FlowerLive` keeps its hot path in refs, so React plus the router is
  a modest slice of the 350 KB entry compared with three.js and the models.
  Revisit only if the profile shows React work dominating.
- **A different bundler or a framework migration.** Build times are small
  here already; the cost is in install and in what's shipped, not in Vite.

## Suggested order of work

1. Time the deploy steps and profile `/live` on the Uno Q ("Measure first").
2. B2, F1: small, low risk, benefit both build time and the kiosk.
3. S1 (precompressed static files) and F4 (quantized/meshopt GLBs): these
   shrink what the demo phones download on `/live`.
4. F7 (AVIF with WebP fallback, after trying 4:2:0 / 4:2:2 / 4:4:4 and
   measuring the watering-can images): shrinks `/watering-can`, the other
   half of the demo.
5. F2 once a bundle visualizer shows where the JS bytes are.
6. F3 for scene rebuilds.
7. B4 / B5 / B6, depending on what the timings say.
