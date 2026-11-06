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
  Funnel URL, where bytes over the wire matter too).

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
| Flower WebPs (2048 px) | already compressed | not compressible further |
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
| F4 | **Shrink the `.glb` files** (~0.9-1 MB each, four of them). Inspect with `gltf-transform inspect` to see whether geometry or textures dominate, then apply meshopt or Draco compression | Medium-high: the heaviest assets on the page | Medium. Needs the decoder wired into `GLTFLoader` and a visual check |
| F5 | **One geometry, four poses** instead of four meshes ([`tools/flower/ANIMATION.md`](../../tools/flower/ANIMATION.md), open decision 1). Roughly a 4x download cut and smoother mood transitions | High, but largest change | High: changes the model exporter and runtime. Do after F3/F4, if at all |
| F6 | Cap the render loop (for example 30 fps) or pause when nothing is moving | Unknown: the renderer already uses `antialias: false` and `pixelRatio: 1`. Measure CPU/GPU use on the device first | Low |
| F7 | Serve smaller flower WebPs than 2048 px where the display is smaller (`srcset`, or lower-resolution variants) | Low-medium: depends on where they're used | Medium |

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
3. S1 if remote visitors on the public URL matter.
4. F2/F4 once a bundle visualizer and `gltf-transform inspect` show where the
   bytes are.
5. F3 for scene rebuilds.
6. B4 / B5 / B6, depending on what the timings say.
