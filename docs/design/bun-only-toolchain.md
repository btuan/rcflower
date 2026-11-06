# Bun-only toolchain (dropping npm, then Node)

Status: **proposal, not implemented** (written 2026-11-06). Today `bun` and
`npm`/`node` are both required to build and deploy; this doc lists what it
takes to need only Bun (plus `uv` for Python).

## Where npm and Node are used today

| Where | What | Needs |
| --- | --- | --- |
| `frontend/package-lock.json` | Frontend lockfile (the frontend has no `bun.lock`) | npm |
| `backend/package-lock.json` | Stray second lockfile next to `backend/bun.lock` | nothing (delete) |
| `deploy/install-systemd.sh` | `npm ci --silent` in `frontend/`, plus a `command -v npm` prerequisite check | npm |
| `frontend/package.json` | `flower-images` / `watering-can-images` scripts run `node scripts/*.mjs` (they import `sharp`) | node |
| `frontend/README.md` | Scripts table says `npm run ...` (and lists `npm run images`, which no longer exists as a script name) | docs |
| **Shebangs** in `frontend/node_modules/.bin` | `vite`, `vitest`, `tsc`, `eslint` all start with `#!/usr/bin/env node`, so `bun run build` runs them **under Node** unless told otherwise | node |

The last row is the important one: **replacing `npm ci` with `bun install` does
not remove Node.** `bun run <script>` respects a tool's shebang by default;
`bun run --bun <script>` (or `[run] bun = true` in a `bunfig.toml`) forces Bun's
runtime instead. The dev path already does this: `backend/src/vite.ts` starts
Vite with `bunx --bun vite`, so Vite itself is known to run under Bun in dev.
The production build (`vite build`) is not known to.

So there are two separable goals:

1. **Drop npm** (the package manager): small, low risk.
2. **Drop Node** (the runtime for build tooling): needs the build, typecheck,
   lint and test tools to run under Bun. Worth doing only if "no Node on the
   device" matters.

## Benefits and costs

Benefits:

- **Faster installs.** `bun install` is generally much faster than `npm ci`,
  especially with a cold cache, and the Pi/Uno Q run `npm ci` on a slow ARM
  CPU and flash storage at every deploy. This is the main payoff. (Not yet
  measured on our hardware; time both on the Uno Q before committing to the
  migration.)
- **Build time: probably no meaningful change.** Most of it is `tsc -b` and
  `vite build`, which are the same code whichever tool installed the
  packages. Running them under Bun's runtime (step 2) may move it either way;
  Vite and Rolldown do their heavy work in native code, so the JavaScript
  runtime matters less than expected. Unmeasured.
- **Fewer prerequisites.** The deploy script needs `bun`, `uv` and `npm`
  today. Step 1 drops `npm`; step 2 drops Node.
- **No stray-Node surprises.** The comment in `backend/src/vite.ts` records
  that the Pi's `PATH` once had an old `node` that broke Vite/Rolldown.
  Step 2 removes that class of problem.
- **One lockfile format and install command** across `backend/` and
  `frontend/` (the backend currently has both `bun.lock` and a leftover
  `package-lock.json`).
- **Safer installs by default.** Bun doesn't run dependencies' install scripts
  unless the package is in `trustedDependencies`; npm runs them by default.

Costs:

- **Compatibility risk** (see "Rollout and risk"): Vitest and `vite build`
  under Bun are unverified, and `sharp` has not been checked under Bun.
- **Less mature tooling around `bun.lock`** than `package-lock.json` (editors,
  dependency-update bots). Not checked for our setup.
- **A migration with a deploy risk** on the only live site, hence the
  hand-test on the Uno Q first.

## Step 1: drop npm

1. In `frontend/`, run `bun install`. With no `bun.lock` present, Bun reads
   `package-lock.json` and keeps the versions it resolved, so this should not
   change dependency versions. Compare `bun pm ls` against `npm ls --all`
   before deleting the old lockfile.
2. Commit `frontend/bun.lock`; delete `frontend/package-lock.json` and
   `backend/package-lock.json`.
3. `deploy/install-systemd.sh`: replace `npm ci --silent` with
   `"$BUN" install --frozen-lockfile --silent`, drop the `npm` entry from the
   prerequisite check, and update the comment above it.
4. `frontend/package.json`: change `node scripts/...` to `bun scripts/...`.
   Confirm `sharp` loads under Bun and the image scripts produce the same
   WebP files (`git status` should show no changes to
   `frontend/src/assets/flower/`), or replace `sharp` instead; see "Optional:
   replace `sharp` with `Bun.Image`" below.
5. Docs: `frontend/README.md` scripts table (`npm run` -> `bun run`; fix the
   stale `images` entry), and any mention in `README.md` / `AGENTS.md`.

Watch for: Bun doesn't run dependency install scripts unless the package is in
`trustedDependencies`. `sharp`, `lightningcss` and the Rolldown binding ship
prebuilt platform packages (optional dependencies), so they should not need
one, but check that `bun install` on the Pi/Uno Q (linux-arm64) pulls the
right binaries.

After this step Node is still required by the shebangs above, so keep Node on
the devices (or do step 2).

## Step 2: drop Node

1. Force Bun's runtime for scripts: add `frontend/bunfig.toml` with
   ```toml
   [run]
   bun = true
   ```
   or use `bun run --bun build` in `backend/package.json`'s `build:frontend`
   and in `deploy/install-systemd.sh`. The `bunfig.toml` route also covers
   people running `bun run lint` / `bun run test` by hand.
2. Verify each tool under Bun, on Windows (dev) and on linux-arm64 (the Pi and
   Uno Q):
   - `bun run build` (`tsc -b && vite build`): Vite 8 + Rolldown native
     binding + Tailwind/lightningcss + the React Compiler Babel plugin.
     `vite.config.ts` uses `node:path`, `node:child_process`, `process.env`
     and `import.meta.dirname`, all of which Bun supports.
   - `bun run lint` (ESLint 10).
   - `bun run test` (Vitest 5): the least certain; Vitest's worker pools
     use `node:worker_threads` / `child_process`. If it misbehaves, keep
     tests on Node (a dev-only dependency) and still ship without Node on the
     devices, since the Pi/Uno Q never runs tests.
3. Keep `@types/node` and `"types": ["node"]` in `tsconfig.node.json`: they are
   type definitions only, not the runtime, and `vite.config.ts` needs them.
4. Remove Node from the prerequisites in docs, and optionally uninstall it
   from the devices.

Bun may substitute itself for `node` on `PATH` when none is installed (`--bun`
is documented as working "via symlinking node"), but don't rely on that
implicitly: make it explicit with step 2.1 and test on a device that has no
Node.

## Optional: replace `sharp` with `Bun.Image`

`sharp` is the one dependency whose native binaries we worry about. It is a
dev dependency used only by `frontend/scripts/gen-flower-images.mjs` and
`gen-watering-can-images.mjs` (run by hand, never by `vite build`), but it is
still installed on every deploy because `npm ci` / `bun install` install dev
dependencies, and its platform-specific prebuilt packages must resolve on the
Pi/Uno Q (linux-arm64). Replacing it removes that install-time risk entirely.

Bun has a built-in, sharp-shaped image API, [`Bun.Image`](https://bun.com/docs/runtime/image),
and our scripts only do one thing with `sharp` (resize a square PNG, encode
WebP at quality 82, write a file):

```js
// before
await sharp(srcPath).resize(width, width).webp({ quality: WEBP_QUALITY }).toFile(outPath);
// after
await new Bun.Image(srcPath).resize(width, width).webp({ quality: WEBP_QUALITY }).write(outPath);
```

Checked on Bun 1.3.14 / Windows with `assets/flower/FlowerNeutral.png` at 256px:
`Bun.Image` is available, writes a 256x256 WebP with alpha preserved, and
produces 12,724 bytes against the committed file's 12,516. **The output is
close but not byte-identical**, so switching means regenerating and
re-committing all the WebP files (a one-time diff to eyeball), and the
"leave `frontend/src/assets/flower/` unchanged" check no longer applies.

Notes and open points:

- The page documents JPEG/PNG/WebP via statically linked codecs on every
  platform, "no native addon build step". It does **not** state a minimum Bun
  version, whether the API is stable, or Linux arm64 support. Test on the Uno
  Q before relying on it, and pin a minimum Bun version.
- Default `fit` is `"fill"` (stretch), unlike sharp's default `"cover"`. For
  our square 2048x2048 sources resized to a square the result is the same.
- The scripts would then run only under Bun (`Bun.Image` is a global), which
  fits this proposal's direction; remove `sharp` from `frontend/package.json`.

## Rollout and risk

- **Do it on a feature branch.** The Uno Q is currently the only live
  deployment (`flower2.recurse.com`), so a broken frontend build there takes
  the site down.
- Test order: Windows dev machine, then run the build by hand on the Uno Q
  (`cd frontend && bun install --frozen-lockfile && bun run build`) before
  changing `install-systemd.sh`, then deploy.
- **Rollback:** revert the commit(s) and run `npm ci` again; `frontend/dist`
  from the last good deploy is untouched until a build succeeds, but check
  that a failed build doesn't leave `dist/` half-written.
- Biggest unknowns, in order: Vitest under Bun, `vite build` under Bun on
  linux-arm64, and either `sharp` under Bun (Windows and linux-arm64) or
  `Bun.Image` on linux-arm64, depending on which you choose.

## Acceptance checklist

- [ ] `bun install --frozen-lockfile` succeeds in `frontend/` and `backend/`
  on Windows and linux-arm64, with no `package-lock.json` in the repo.
- [ ] `bun run build`, `bun run lint`, `bun run test` pass (under Bun if doing
  step 2).
- [ ] Both image scripts run. With `sharp`: they leave
  `frontend/src/assets/flower/` unchanged. With `Bun.Image`: regenerated
  WebP files look right and are committed.
- [ ] `./deploy/install-systemd.sh` completes on a machine with Bun and `uv`
  but without npm (and, for step 2, without Node).
- [ ] No remaining `npm` / `node` references in `deploy/`, `README.md`,
  `AGENTS.md`, or `frontend/README.md`, apart from `node:` imports and
  `@types/node`.

## Open questions

- Is "no Node on the device" a goal, or is dropping npm enough? That decides
  whether step 2 happens at all.
- Pin the Bun version (for example a `packageManager` / `engines` entry, or a
  documented minimum) so the Pi, Uno Q and dev machines agree on lockfile
  format and `--bun` behaviour?
