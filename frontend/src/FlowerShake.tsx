import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { upInDevice } from "./orientation";
import { useDeviceOrientation } from "./useDeviceOrientation";
import { useDeviceMotion } from "./useDeviceMotion";
import {
  DEFAULT_PHYSICS,
  FlowerSpring,
  PRESET_PHYSICS,
  type Physics,
} from "./flowerSpring";

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

// Sliders exposed on the page. Everything else keeps DEFAULT_PHYSICS.
const SLIDERS: { key: keyof Physics; min: number; max: number; step: number }[] = [
  { key: "stiffness", min: 5, max: 120, step: 1 },
  { key: "damping", min: 0.05, max: 1.2, step: 0.05 },
  { key: "gravityInfluence", min: 0, max: 0.6, step: 0.01 },
  { key: "shakeGain", min: 0, max: 0.3, step: 0.01 },
  { key: "bounceToBend", min: 0, max: 1.5, step: 0.05 },
  { key: "wind", min: 0, max: 1, step: 0.05 },
  { key: "shedThreshold", min: 5, max: 60, step: 1 },
  { key: "petalFloatGravity", min: 0, max: 0.5, step: 0.01 },
  { key: "petalFloatSway", min: 0, max: 2, step: 0.05 },
];

export default function FlowerShake() {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const springRef = useRef<FlowerSpring | null>(null);
  const [mood, setMood] = useState<Mood>("neutral");
  const [physics, setPhysics] = useState<Physics>({ ...DEFAULT_PHYSICS });
  const [invertAccel, setInvertAccel] = useState(false);
  const [status, setStatus] = useState("loading");
  const [shed, setShed] = useState({ shed: 0, total: 0 });
  const [showControls, setShowControls] = useState(true);

  const orient = useDeviceOrientation();
  const motion = useDeviceMotion();
  const orientRef = useRef(orient.orientation);
  const invertRef = useRef(invertAccel);
  useEffect(() => {
    orientRef.current = orient.orientation;
  }, [orient.orientation]);
  useEffect(() => {
    invertRef.current = invertAccel;
  }, [invertAccel]);

  // Scene lifetime = mood lifetime (each mood is its own GLB).
  useEffect(() => {
    const host = canvasRef.current;
    if (!host) return;
    let disposed = false;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-3, 3, 3, -3, 0.1, 100);
    camera.position.set(0.2, 4.5, 12);
    camera.lookAt(0.2, 1.7, 0);

    scene.add(new THREE.HemisphereLight(0xffffff, 0xcfd8c8, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-3, 6, 5);
    scene.add(sun);

    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      renderer.setSize(w, h);
      const aspect = w / h;
      const half = 3.2;
      camera.left = -half * aspect;
      camera.right = half * aspect;
      camera.top = half;
      camera.bottom = -half;
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener("resize", resize);

    setStatus("loading");
    new GLTFLoader().load(
      GLB[mood],
      (gltf) => {
        if (disposed) return;
        const root = gltf.scene;
        scene.add(root);
        const spring = new FlowerSpring(root, {
          ...DEFAULT_PHYSICS,
          ...PRESET_PHYSICS[mood],
        });
        springRef.current = spring;
        if (import.meta.env.DEV) {
          (window as unknown as { __flower?: FlowerSpring }).__flower = spring;
        }
        setPhysics({ ...spring.physics });
        setShed({ shed: 0, total: spring.petalCount });
        setStatus("ready");
      },
      undefined,
      (err) => setStatus(`load failed: ${String(err)}`),
    );

    let last = performance.now();
    let frame = 0;
    let raf = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = (now - last) / 1000;
      last = now;
      const spring = springRef.current;
      if (spring) {
        const o = orientRef.current;
        if (o.beta !== null && o.gamma !== null) {
          const up = upInDevice(o.beta, o.gamma);
          spring.down.set(-up.x, -up.y, -up.z);
        }
        const m = motion.latest.current;
        if (m) {
          const sgn = invertRef.current ? -1 : 1;
          spring.accel.set(m.x * sgn, m.y * sgn, m.z * sgn);
        }
        spring.step(dt);
        frame += 1;
        if (frame % 15 === 0) {
          setShed((s) =>
            s.shed === spring.petalsShed ? s : { shed: spring.petalsShed, total: spring.petalCount },
          );
        }
      }
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      springRef.current = null;
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, [mood, motion.latest]);

  const updatePhysics = (key: keyof Physics, value: number) => {
    setPhysics((p) => {
      const next = { ...p, [key]: value };
      const spring = springRef.current;
      if (spring) {
        spring.physics = { ...next };
        spring.retune();
      }
      return next;
    });
  };

  const start = () => {
    void orient.start();
    void motion.start();
  };

  const kick = (x: number, y: number) =>
    springRef.current?.kick(new THREE.Vector3(x, y, 0));

  const sensorsOn = orient.listening || motion.listening;

  return (
    <div className="fixed inset-0 bg-white text-gray-900 select-none">
      <div ref={canvasRef} className="absolute inset-0" />

      <div className="absolute top-2 left-2 right-2 flex flex-wrap gap-2 items-center text-sm">
        {!sensorsOn ? (
          <button
            onClick={start}
            className="px-3 py-2 rounded bg-emerald-600 text-white font-medium"
          >
            Enable motion
          </button>
        ) : (
          <span className="px-2 py-1 rounded bg-emerald-100">
            sensors on · {motion.sampleCount} samples
          </span>
        )}
        <button onClick={() => kick(0, 60)} className="px-3 py-2 rounded bg-gray-200">
          Bounce
        </button>
        <button onClick={() => kick(-70, 0)} className="px-3 py-2 rounded bg-gray-200">
          Jerk
        </button>
        <button
          onClick={() => springRef.current?.kick(new THREE.Vector3(-45, 15, 0), 0.25)}
          className="px-3 py-2 rounded bg-gray-200"
        >
          Whack
        </button>
        <button
          onClick={() => springRef.current?.resetPetals()}
          className="px-3 py-2 rounded bg-gray-200"
        >
          Regrow
        </button>
        <select
          value={mood}
          onChange={(e) => setMood(e.target.value as Mood)}
          className="px-2 py-2 rounded bg-gray-200"
        >
          {(Object.keys(GLB) as Mood[]).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <span className="text-gray-500">
          {status}
          {shed.total ? ` · petals ${shed.total - shed.shed}/${shed.total}` : ""}
        </span>
        <button
          onClick={() => setShowControls((v) => !v)}
          className="ml-auto px-2 py-1 rounded bg-gray-100"
        >
          {showControls ? "hide" : "tune"}
        </button>
      </div>

      {(orient.error || motion.error) && (
        <div className="absolute top-14 left-2 right-2 text-xs text-red-700">
          {orient.error ?? motion.error}
        </div>
      )}

      {showControls && (
        <div className="absolute bottom-0 left-0 right-0 p-2 bg-white/85 backdrop-blur text-xs grid grid-cols-2 gap-x-4 gap-y-1">
          {SLIDERS.map(({ key, min, max, step }) => (
            <label key={key} className="flex items-center gap-2">
              <span className="w-28 truncate">{key}</span>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={physics[key]}
                onChange={(e) => updatePhysics(key, Number(e.target.value))}
                className="flex-1"
              />
              <span className="w-10 text-right tabular-nums">
                {Number(physics[key]).toFixed(step < 1 ? 2 : 0)}
              </span>
            </label>
          ))}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={invertAccel}
              onChange={(e) => setInvertAccel(e.target.checked)}
            />
            invert accel sign (iOS vs Android)
          </label>
        </div>
      )}
    </div>
  );
}
