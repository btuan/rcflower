# Hardware overview

Status: **reference** — index of the hardware RC Flower runs on. Facts live in
the per-device docs; this page only says which doc to read.

| Doc | What it covers |
| --- | --- |
| [raspberry-pi-4b.md](raspberry-pi-4b.md) | **Reference device** (`kirwinpi`): specs, compute capability limits, deployment host, measured resource baselines. |
| [arduino-uno-q.md](arduino-uno-q.md) | Stand-in device (`porygon-q`) used while the Pi is out for servicing. Stub. |
| [camera.md](camera.md) | The USB webcam, shared by every device. |

Measurements and design docs (`docs/design/`) assume the Pi 4B unless they say
otherwise.

## How the flower is displayed

The 3D flower is rendered client-side, by whichever browser opens the page.
Normally a display is attached to the single-board computer and a browser tab
is opened on `http://127.0.0.1:3000/live` (`frontend/src/FlowerLive.tsx`).
Since it's just a web page, any mobile device can open it too.
