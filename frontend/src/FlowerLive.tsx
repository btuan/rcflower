import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { createFlowerScene } from "./flowerScene";
import { droopFor, yawTarget } from "./flowerLiveMath";
import { DEFAULT_PHYSICS, FlowerSpring, PRESET_PHYSICS } from "./flowerSpring";

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

const MAX_YAW = (35 * Math.PI) / 180;
const YAW_TAU = 0.35; // seconds, critically-damped-ish smoothing time constant
const DROOP_TAU = 2; // seconds, smoothing for health-driven droop/tilt
const TRACK_STALE_MS = 1500;

/** Horizontal direction (in flower/world space) the head tilts toward as health falls. */
const TILT_DIR = new THREE.Vector3(1, 0, 1).normalize();

type MoodEvent = { mood: Mood; health: number; wateredAt: number | null };
type PersonEvent = { inFrame: boolean; t?: unknown };
type TrackEvent = {
  n: number;
  primary: { cx: number; cy: number; w: number; h: number; conf: number } | null;
  capturedAt: number | null;
};

function isMood(v: unknown): v is Mood {
  return v === "neutral" || v === "happy" || v === "sad" || v === "dead";
}

export default function FlowerLive() {
  const params = new URLSearchParams(window.location.search);
  const mirror = params.get("mirror") === "1";
  const debug = params.get("debug") === "1";

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const springRef = useRef<FlowerSpring | null>(null);
  const rootRef = useRef<THREE.Object3D | null>(null);

  const [mood, setMood] = useState<Mood>("neutral");
  const [sseStatus, setSseStatus] = useState("connecting");

  // Live values read by the RAF loop, updated from SSE without re-render.
  const healthRef = useRef(1);
  const inFrameRef = useRef(false);
  const sawFirstPersonRef = useRef(false);
  const trackCxRef = useRef(0.5);
  const trackNRef = useRef(0);
  const trackAtRef = useRef(0);
  const yawRef = useRef(0);
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

    new GLTFLoader().load(
      GLB[mood],
      (gltf) => {
        if (disposed) return;
        const root = gltf.scene;
        scene.add(root);
        rootRef.current = root;
        const spring = new FlowerSpring(root, {
          ...DEFAULT_PHYSICS,
          ...PRESET_PHYSICS[mood],
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

        // Health -> continuous droop, smoothed over ~2s.
        const basePreset = { ...DEFAULT_PHYSICS, ...PRESET_PHYSICS[mood] };
        const droop = droopFor(healthRef.current, basePreset);
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
        const targetYaw = fresh ? yawTarget(trackCxRef.current, mirror, MAX_YAW) : 0;
        const yawAlpha = 1 - Math.exp(-dt / YAW_TAU);
        yawRef.current += (targetYaw - yawRef.current) * yawAlpha;
        root.rotation.y = yawRef.current;
      }

      renderer.render(scene, camera);

      if (debug) {
        setDbg({
          mood,
          health: healthRef.current,
          inFrame: inFrameRef.current,
          n: trackNRef.current,
          cx: trackCxRef.current,
          yawDeg: (yawRef.current * 180) / Math.PI,
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
      dispose();
    };
    // Re-run only when the mood (and thus the loaded model) changes; debug/mirror/sseStatus
    // are read through refs/closures each frame rather than restarting the scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mood]);

  return (
    <div className="fixed inset-0 bg-white select-none overflow-hidden">
      <div ref={canvasRef} className="absolute inset-0" />
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
