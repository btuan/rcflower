# Arduino Uno Q

Status: **stub** — to be filled in. Written as a stand-in host while the
reference device ([raspberry-pi-4b.md](raspberry-pi-4b.md)) is out for
servicing. Like that doc, this one should hold physical facts and *measured*
numbers only; mark anything unmeasured as such rather than copying a Pi
number across.

Hostname `porygon-q`. Uses the same USB webcam as the Pi — see
[camera.md](camera.md).

## Device

TODO: board/SoC, CPU (cores, clock, ISA/fp16 support), GPU and supported
graphics/compute APIs (does Vulkan work with NCNN here?), RAM, OS and kernel
version, and any hardware video encode/decode.

## Differences from the Pi 4B

TODO: what changes for running RC Flower, e.g.:

- Deployment: user, repo path, and anything else that differs from
  `kirwinpi` (the systemd units are rendered per machine by
  `deploy/install-systemd.sh`, so these shouldn't need unit edits).
- Camera: device node / `camera.source` index.
- Inference: whether `use_vulkan` and `cpu_threads` defaults still make sense.
- Network reachability (Tailscale funnel or not).

## Known resource baseline

TODO: not yet measured. Record fps, CPU use and temperature for
`rcflower-detect` with the date measured, using the same config as the Pi
baseline so the two are comparable.

## See also

- [overview.md](overview.md) — all supported devices.
- Root `README.md` — running as systemd services.
