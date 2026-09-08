# frontend

React 19 SPA: React Router, Tailwind v4, React Compiler. Vite is the
**compiler and hot-reloader** for this directory. It is not the app server.

## You don't run this directory directly

Develop from `backend/`:

```sh
cd ../backend && bun run dev     # -> http://localhost:3000
```

That spawns Vite as an internal child process (loopback only, no banner) and
proxies every non-`/api` request to it, so you get hot reload *and* the API
on one port. Opening Vite's own port (5173) gives you a frontend with no
backend -- every `/api` call 404s. If you find yourself typing 5173, stop.

In production nothing from here runs as a process: `bun run build:frontend`
(from `backend/`) runs `vite build` once, and the Bun server serves the
static `dist/` output. See "One server, one port" in the root README.

## Scripts (from this directory)

| script | what |
|---|---|
| `npm run build` | `tsc -b && vite build` -> `dist/`. Called by `backend`'s `build:frontend` and by `deploy/install-systemd.sh`. |
| `npm run lint` | ESLint (React hooks + React Compiler rules). |
| `npm test` | Vitest -- currently the watering-can twist state machine. |
| `npm run images` | Regenerate the responsive WebP flower images in `src/assets/flower/` from the 2048px PNGs in `../assets/`. |
| `npm run dev` | Vite alone on 5173, **without** the backend. Only useful for isolated component work; `/api` won't exist. |

## Routes (`src/main.tsx`)

| path | component |
|---|---|
| `/flower` | `Flower.tsx` -- the flower mood display, driven by SSE |
| `/watering-can` | `WateringCan.tsx` -- phone twist-to-pour gesture |
| `/debug` | `Debug.tsx` -- pipeline latency + "simulate person" button |
| `/sse` | `SseDemo.tsx` -- raw SSE event dump |

## Config

`.env` holds `ALLOWED_HOSTS` (comma-separated) for Vite's dev-server host
check -- set it when developing through a tunnel/proxy hostname. Per-machine
values go in `.env.local` (gitignored). iOS device-orientation needs HTTPS;
terminate TLS in front of the Bun server (e.g. `tailscale serve`).
