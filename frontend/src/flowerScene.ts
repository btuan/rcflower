/**
 * Shared three.js scene scaffolding for the flower pages (FlowerShake.tsx's
 * `/flower-shake` and FlowerLive.tsx's `/live`): renderer, camera, lights,
 * and the resize handler that keeps the flower framed in an orthographic
 * view. Pulled out so both pages set up the same look without repeating
 * ~40 lines of three.js boilerplate.
 */
import * as THREE from "three";

export type FlowerScene = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  /** Call on container resize; also invoked once up front. */
  resize: () => void;
  /** Detach the canvas and free GPU resources. */
  dispose: () => void;
};

export type FlowerSceneOptions = {
  /** WebGLRenderer antialias flag. Default true; pass false on constrained hardware (e.g. the Pi kiosk). */
  antialias?: boolean;
  /** Cap on devicePixelRatio. Default `min(devicePixelRatio, 2)`; pass 1 to force no supersampling. */
  pixelRatio?: number;
};

/**
 * Build the renderer/scene/camera used by both flower pages and mount the
 * canvas into `host`. Caller owns the RAF loop and the FlowerSpring/model
 * loading; this only sets up the shared scaffolding.
 */
export function createFlowerScene(host: HTMLElement, opts: FlowerSceneOptions = {}): FlowerScene {
  const renderer = new THREE.WebGLRenderer({
    antialias: opts.antialias ?? true,
    alpha: true,
  });
  renderer.setPixelRatio(opts.pixelRatio ?? Math.min(window.devicePixelRatio, 2));
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

  const dispose = () => {
    window.removeEventListener("resize", resize);
    renderer.dispose();
    if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
  };

  return { renderer, scene, camera, resize, dispose };
}
