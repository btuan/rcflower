import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { TuningPanel } from "./TuningPanel";
import { createFlowerScene } from "./flowerScene";
import { DEFAULT_PHYSICS, FlowerSpring, PRESET_PHYSICS } from "./flowerSpring";
import { applyToon, DEFAULT_TOON, TOON_RANGES, type ToonOptions } from "./toonMaterial";
import { tuningOptionsFromParams } from "./tuningParams";

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
const MOODS = Object.keys(GLB) as Mood[];

/**
 * `/flower-toon`: standalone playground for the toon + shadow-masked texture
 * look. No SSE or tracking; the flower idles on its spring and everything is
 * driven from the panel (or `tn*` query params).
 */
export default function FlowerToon() {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [mood, setMood] = useState<Mood>("neutral");
  const [options, setOptions] = useState<ToonOptions>(() =>
    tuningOptionsFromParams(new URLSearchParams(window.location.search), "tn", DEFAULT_TOON),
  );
  // Latest options for the model-load callback and RAF loop; setter pushes slider changes into the live shader.
  const optionsRef = useRef(options);
  const setToonRef = useRef<((next: Partial<ToonOptions>) => void) | null>(null);
  const onChange = (key: keyof ToonOptions, value: number) => {
    const next = { ...optionsRef.current, [key]: value };
    optionsRef.current = next;
    setOptions(next);
    setToonRef.current?.({ [key]: value });
  };

  // Scene lifetime = mood lifetime (each mood is its own GLB).
  useEffect(() => {
    const host = canvasRef.current;
    if (!host) return;
    let disposed = false;

    const { renderer, scene, camera, dispose } = createFlowerScene(host);
    renderer.shadowMap.enabled = true;
    const sun = scene.children.find(
      (child): child is THREE.DirectionalLight => (child as THREE.DirectionalLight).isDirectionalLight,
    );

    let spring: FlowerSpring | null = null;
    let root: THREE.Object3D | null = null;
    new GLTFLoader().load(GLB[mood], (gltf) => {
      if (disposed || !sun) return;
      root = gltf.scene;
      scene.add(root);
      setToonRef.current = applyToon(root, sun, optionsRef.current);
      spring = new FlowerSpring(root, { ...DEFAULT_PHYSICS, ...PRESET_PHYSICS[mood] });
    });

    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min((now - last) / 1000, 1 / 20);
      last = now;
      if (spring && root) {
        spring.step(dt);
        root.rotation.y = (optionsRef.current.yaw * Math.PI) / 180;
      }
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      setToonRef.current = null;
      dispose();
    };
  }, [mood]);

  return (
    <div className="fixed inset-0 bg-white select-none overflow-hidden">
      <div ref={canvasRef} className="absolute inset-0" />
      <TuningPanel values={options} ranges={TOON_RANGES} onChange={onChange} urlPrefix="tn" urlBase="/flower-toon">
        <div className="flex gap-2 py-0.5">
          {MOODS.map((m) => (
            <button
              key={m}
              type="button"
              className={m === mood ? "font-bold underline" : ""}
              onClick={() => setMood(m)}
            >
              {m}
            </button>
          ))}
        </div>
      </TuningPanel>
    </div>
  );
}
