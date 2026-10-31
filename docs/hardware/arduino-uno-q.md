# Arduino Uno Q

Status: **stub** — to be filled in. Written as a stand-in host while the
reference device ([raspberry-pi-4b.md](raspberry-pi-4b.md)) is out for
servicing. Like that doc, this one should hold physical facts and *measured*
numbers only; mark anything unmeasured as such rather than copying a Pi
number across.

Runs a second instance of RC Flower while the Pi 4B is out for servicing.
Uses the same USB webcam as the Pi — see [camera.md](camera.md) — but it is
**not connected yet**, so `rcflower-detect` currently fails at startup with
`CameraNotFoundError` and ML inference on this board is **untested**.

## Deployment host

- `arduino@porygon-q` (the Uno Q's default user), repo at
  `/home/arduino/rcflower`.
- Public via a Tailscale Funnel at https://flower2.recurse.com/. The tailnet
  hostname itself is deliberately not recorded in this repo.
- Same two systemd services as the Pi, rendered for this user and path by
  `deploy/install-systemd.sh` (no unit edits needed).

## Device

TODO: board/SoC, CPU (cores, clock, ISA/fp16 support), GPU and supported
graphics/compute APIs (does Vulkan work with NCNN here?), RAM, OS and kernel
version, and any hardware video encode/decode.

## Differences from the Pi 4B

Known so far: the user (`arduino`, not `pi`) and repo path
(`/home/arduino/rcflower`) differ, which is why the systemd units are
templates. Still TODO, once the camera is connected:

- Camera: device node / `camera.source` index.
- Inference: whether the `use_vulkan` and `cpu_threads` defaults still make
  sense, and whether the NCNN/OpenCV wheels behave the same on this CPU.

## Known resource baseline

TODO: not yet measured. Record fps, CPU use and temperature for
`rcflower-detect` with the date measured, using the same config as the Pi
baseline so the two are comparable.

## See also

- [overview.md](overview.md) — all supported devices.
- Root `README.md` — running as systemd services.
