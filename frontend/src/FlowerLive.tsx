import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { Rain, type RainHandle } from "./Rain";
import { createFlowerScene } from "./flowerScene";
import {
  DEFAULT_YAW_SPRING_PARAMS,
  displayMoodFor,
  droopFor,
  stepYawSpring,
  yawTarget,
  type YawSpringState,
} from "./flowerLiveMath";
import { DEFAULT_PHYSICS, FlowerSpring, PRESET_PHYSICS } from "./flowerSpring";
import {
  applyWatercolor,
  watercolorOptionsFromParams,
  WATERCOLOR_RANGES,
  type WatercolorOptions,
} from "./watercolorMaterial";

import glbNeutral from "../../assets/flower/flower_neutral.glb?url";
import glbHappy from "../../assets/flower/flower_happy.glb?url";
import glbSad from "../../assets/flower/flower_sad.glb?url";
import glbDead from "../../assets/flower/flower_dead.glb?url";

type Mood = "neutral" | "happy" | "sad" | "dead";
const GLB: Record<Mood, string> = {
  neutral: glbNeutral,
  happy: glbHappy,
  sad: glbSad,
  dead: glbDead,
};

// Wide on purpose: the head is small on the kiosk display, so a modest yaw reads as nothing.
const MAX_YAW = (75 * Math.PI) / 180;
// Gentle idle sway layered on the follow target while anyone is in frame.
const SWAY_AMPLITUDE = (6 * Math.PI) / 180;
const SWAY_PERIOD_S = 3.5;
const DROOP_TAU = 2; // seconds, smoothing for health-driven droop/tilt
const TRACK_STALE_MS = 1500;

/** Horizontal direction (in flower/world space) the head tilts toward as health falls. */
const TILT_DIR = new THREE.Vector3(1, 0, 1).normalize();

type MoodEvent = { mood: Mood; health: number; wateredAt: number | null };
type PersonEvent = { inFrame: boolean; t?: unknown };
type PourEvent = { pouring: boolean; changedAt?: unknown };
type TrackEvent = {
  n: number;
  primary: { cx: number; cy: number; w: number; h: number; conf: number } | null;
  capturedAt: number | null;
};

function isMood(v: unknown): v is Mood {
  return v === "neutral" || v === "happy" || v === "sad" || v === "dead";
}

/** Tuning panel for the `?wc=1` watercolor prototype. */
function WatercolorPanel({
  watercolor,
  onChange,
}: {
  watercolor: WatercolorOptions;
  onChange: (key: keyof WatercolorOptions, value: number) => void;
}) {
  return (
    <div className="absolute top-2 right-2 z-10 w-56 font-mono text-[11px] leading-tight text-gray-600 bg-white/80 rounded px-2 py-1">
      {(Object.keys(WATERCOLOR_RANGES) as (keyof WatercolorOptions)[]).map((key) => {
        const range = WATERCOLOR_RANGES[key];
        // 0|1 options render as checkboxes.
        if (range.max === 1 && range.step === 1) {
          return (
            <label key={key} className="flex items-center gap-1 py-0.5">
              <input
                type="checkbox"
                checked={watercolor[key] === 1}
                onChange={(e) => onChange(key, e.target.checked ? 1 : 0)}
              />
              {key}
            </label>
          );
        }
        return (
          <label key={key} className="block py-0.5">
            <span className="flex justify-between">
              <span>{key}</span>
              <span>{watercolor[key]}</span>
            </span>
            <input
              type="range"
              className="w-full"
              {...range}
              value={watercolor[key]}
              onChange={(e) => onChange(key, Number(e.target.value))}
            />
          </label>
        );
      })}
      <button
        type="button"
        className="mt-1 underline"
        onClick={() => {
          const q = new URLSearchParams({ wc: "1" });
          for (const [k, v] of Object.entries(watercolor)) {
            q.set(`wc${k[0].toUpperCase()}${k.slice(1)}`, String(v));
          }
          void navigator.clipboard?.writeText(`${window.location.origin}/live?${q}`);
        }}
      >
        copy URL with these values
      </button>
    </div>
  );
}

export default function FlowerLive() {
  const params = new URLSearchParams(window.location.search);
  // Camera and display face the same way, so the raw camera x is reversed for a
  // viewer in front of the flower: mirror by default; `?mirror=0` turns it off.
  const mirror = params.get("mirror") !== "0";
  const debug = params.get("debug") === "1";
  // Prototype watercolor shader: `?wc=1`, tune with `wcScale`, `wcStrength`, ... (see watercolorMaterial.ts).
  const [watercolor, setWatercolor] = useState<WatercolorOptions | null>(() =>
    params.get("wc") === "1" ? watercolorOptionsFromParams(params) : null,
  );
  // Latest options for the model-load callback; setter pushes slider changes into the live shader.
  const watercolorRef = useRef(watercolor);
  const watercolorSetRef = useRef<((next: Partial<WatercolorOptions>) => void) | null>(null);
  const onWatercolorChange = (key: keyof WatercolorOptions, value: number) => {
    if (!watercolorRef.current) return;
    const next = { ...watercolorRef.current, [key]: value };
    watercolorRef.current = next;
    setWatercolor(next);
    watercolorSetRef.current?.({ [key]: value });
  };

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const springRef = useRef<FlowerSpring | null>(null);
  const rootRef = useRef<THREE.Object3D | null>(null);
  const rainRef = useRef<RainHandle | null>(null);

  const [mood, setMood] = useState<Mood>("neutral");
  // Who watered last, for the credit line (mirrors Flower.tsx).
  const [lastWatering, setLastWatering] = useState<{
    name: string | null;
    wateredAt: number;
  } | null>(null);
  const [sseStatus, setSseStatus] = useState("connecting");

  // Live values read by the RAF loop, updated from SSE without re-render.
  const healthRef = useRef(1);
  const inFrameRef = useRef(false);
  const sawFirstPersonRef = useRef(false);
  const trackCxRef = useRef(0.5);
  const trackNRef = useRef(0);
  const trackAtRef = useRef(0);
  const yawStateRef = useRef<YawSpringState>({ yaw: 0, vel: 0 });
  const tiltRef = useRef(0);
  const kickQueuedRef = useRef(false);

  // Debug overlay state (only updated when ?debug=1).
  const [dbg, setDbg] = useState({
    mood: "neutral" as Mood,
    health: 1,
    inFrame: false,
    n: 0,
    cx: 0.5,
    yawDeg: 0,
    sse: "connecting",
  });

  // SSE subscription: lives for the page's lifetime, independent of mood/model reloads.
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onopen = () => setSseStatus("open");
    es.onerror = () => setSseStatus("error / reconnecting");

    es.addEventListener("mood", (e: MessageEvent<string>) => {
      try {
        const data = JSON.parse(e.data) as Partial<MoodEvent>;
        if (isMood(data.mood)) setMood(data.mood);
        if (typeof data.health === "number") healthRef.current = data.health;
      } catch {
        // ignore malformed event
      }
    });

    es.addEventListener("person", (e: MessageEvent<string>) => {
      try {
        const data = JSON.parse(e.data) as Partial<PersonEvent>;
        const inFrame = Boolean(data.inFrame);
        if (sawFirstPersonRef.current && inFrame && !inFrameRef.current) {
          kickQueuedRef.current = true;
        }
        sawFirstPersonRef.current = true;
        inFrameRef.current = inFrame;
      } catch {
        // ignore malformed event
      }
    });

    es.addEventListener("track", (e: MessageEvent<string>) => {
      try {
        const data = JSON.parse(e.data) as Partial<TrackEvent>;
        const n = typeof data.n === "number" ? data.n : 0;
        trackNRef.current = n;
        if (n > 0 && data.primary && typeof data.primary.cx === "number") {
          trackCxRef.current = data.primary.cx;
          trackAtRef.current = performance.now();
        }
      } catch {
        // ignore malformed event
      }
    });

    es.addEventListener("pour", (e: MessageEvent<string>) => {
      try {
        const data = JSON.parse(e.data) as Partial<PourEvent>;
        rainRef.current?.setRaining(Boolean(data.pouring));
      } catch {
        // ignore malformed event
      }
    });

    es.addEventListener("watering", (e: MessageEvent<string>) => {
      const data = JSON.parse(e.data) as { name?: unknown; wateredAt?: number; replay?: boolean };
      setLastWatering({
        name: typeof data.name === "string" ? data.name : null,
        wateredAt: data.wateredAt ?? Date.now(),
      });
      // `replay` marks the backlog event the server sends on connect: show the
      // credit, but don't re-run the rain for a watering that already happened.
      if (!data.replay) rainRef.current?.start();
    });

    return () => es.close();
  }, []);

  // Scene + model lifetime = mood lifetime, same pattern as FlowerShake.
  useEffect(() => {
    const host = canvasRef.current;
    if (!host) return;
    let disposed = false;

    const { renderer, scene, camera, dispose } = createFlowerScene(host, {
      antialias: false,
      pixelRatio: 1,
    });

    const displayMood = displayMoodFor(mood);
    new GLTFLoader().load(
      GLB[displayMood],
      (gltf) => {
        if (disposed) return;
        const root = gltf.scene;
        if (watercolorRef.current) {
          watercolorSetRef.current = applyWatercolor(root, watercolorRef.current);
        }
        scene.add(root);
        rootRef.current = root;
        const spring = new FlowerSpring(root, {
          ...DEFAULT_PHYSICS,
          ...PRESET_PHYSICS[displayMood],
        });
        springRef.current = spring;
      },
      undefined,
      () => {
        // Load failure: leave the previous frame/model in place, nothing to render.
      },
    );

    let last = performance.now();
    let raf = 0;
    let running = true;

    const tick = (now: number) => {
      if (!running) return;
      raf = requestAnimationFrame(tick);
      const dt = Math.min((now - last) / 1000, 1 / 20);
      last = now;

      const spring = springRef.current;
      const root = rootRef.current;
      if (spring && root) {
        if (kickQueuedRef.current) {
          kickQueuedRef.current = false;
          spring.kick(new THREE.Vector3(0, 60, 0));
        }

        // Health -> continuous droop, smoothed over ~2s. `dead` renders as
        // `neutral` with health effectively 0, so droopFor already clamps
        // to full droop for it.
        const basePreset = { ...DEFAULT_PHYSICS, ...PRESET_PHYSICS[displayMoodFor(mood)] };
        const droop = droopFor(mood === "dead" ? 0 : healthRef.current, basePreset);
        const droopAlpha = 1 - Math.exp(-dt / DROOP_TAU);
        const nextGravityInfluence =
          spring.physics.gravityInfluence + (droop.gravityInfluence - spring.physics.gravityInfluence) * droopAlpha;
        const nextStiffness =
          spring.physics.stiffness + (droop.stiffness - spring.physics.stiffness) * droopAlpha;
        if (
          Math.abs(nextGravityInfluence - spring.physics.gravityInfluence) > 1e-4 ||
          Math.abs(nextStiffness - spring.physics.stiffness) > 1e-4
        ) {
          spring.physics = {
            ...spring.physics,
            gravityInfluence: nextGravityInfluence,
            stiffness: nextStiffness,
          };
          spring.retune();
        }
        tiltRef.current += (droop.tiltRad - tiltRef.current) * droopAlpha;
        const tilt = tiltRef.current;
        spring.down.set(
          TILT_DIR.x * Math.sin(tilt),
          -Math.cos(tilt),
          TILT_DIR.z * Math.sin(tilt),
        );

        spring.step(dt);

        // Track -> yaw. Stale target (no track event recently) snaps back to 0.
        const fresh = trackNRef.current > 0 && performance.now() - trackAtRef.current < TRACK_STALE_MS;
        const sway = fresh
          ? SWAY_AMPLITUDE * Math.sin((2 * Math.PI * now) / 1000 / SWAY_PERIOD_S)
          : 0;
        const targetYaw = fresh ? yawTarget(trackCxRef.current, mirror, MAX_YAW) + sway : 0;
        yawStateRef.current = stepYawSpring(yawStateRef.current, targetYaw, dt, DEFAULT_YAW_SPRING_PARAMS);
        root.rotation.y = yawStateRef.current.yaw;
      }

      renderer.render(scene, camera);

      if (debug) {
        setDbg({
          mood,
          health: healthRef.current,
          inFrame: inFrameRef.current,
          n: trackNRef.current,
          cx: trackCxRef.current,
          yawDeg: (yawStateRef.current.yaw * 180) / Math.PI,
          sse: sseStatus,
        });
      }
    };
    raf = requestAnimationFrame(tick);

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      running = false;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      springRef.current = null;
      rootRef.current = null;
      watercolorSetRef.current = null;
      dispose();
    };
    // Re-run only when the mood (and thus the loaded model) changes; debug/mirror/sseStatus
    // are read through refs/closures each frame rather than restarting the scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mood]);

  return (
    <div className="fixed inset-0 bg-white select-none overflow-hidden">
      <div ref={canvasRef} className="absolute inset-0" />
      <Rain ref={rainRef} />
      {lastWatering && (
        <p
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: "max(24px, env(safe-area-inset-bottom))",
            margin: 0,
            textAlign: "center",
            font: "500 16px/1.4 system-ui, sans-serif",
            color: "#3d3b36",
            textShadow: "0 1px 2px rgba(255, 255, 255, 0.8)",
            pointerEvents: "none",
            zIndex: 6,
          }}
        >
          {lastWatering.name ?? "Someone"} watered at{" "}
          {new Date(lastWatering.wateredAt).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          })}
        </p>
      )}
      {watercolor && <WatercolorPanel watercolor={watercolor} onChange={onWatercolorChange} />}
      {debug && (
        <div className="absolute top-2 left-2 font-mono text-[11px] leading-tight text-gray-400 bg-white/70 rounded px-2 py-1 pointer-events-none">
          <div>mood: {dbg.mood}</div>
          <div>health: {dbg.health.toFixed(2)}</div>
          <div>inFrame: {String(dbg.inFrame)}</div>
          <div>n: {dbg.n}</div>
          <div>cx: {dbg.cx.toFixed(2)}</div>
          <div>yaw: {dbg.yawDeg.toFixed(1)}°</div>
          <div>sse: {dbg.sse}</div>
        </div>
      )}
    </div>
  );
}
