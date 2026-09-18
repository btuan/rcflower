/**
 * Prototype toon look for the 3D flower (`/flower-toon`): the model itself is
 * pure toon (one solid colour per part, quantised light bands, clean outline)
 * with no surface-space noise. All texture is screen-space (fBm wash and/or
 * pencil hatching) and laid into the shadow side only. The
 * shadow mask is the toon shade band combined with real cast shadows, read
 * back from the material's direct-light term.
 */
import * as THREE from "three";

import { addPencilOutline, FBM_GLSL, NOISE_GLSL } from "./watercolorMaterial";
import type { TuningRange } from "./tuningParams";

export type ToonOptions = {
  /** Degrees; rotates the flower so the look can be inspected from any side. */
  yaw: number;
  /** Degrees, sun direction around the flower (0 = from the camera side, negative = from the left). */
  lightAzimuth: number;
  /** Degrees, sun height above the horizon. */
  lightElevation: number;
  /** 0|1. Shadow-mapped cast shadows (petals onto each other, head onto leaves). */
  castShadows: number;
  /** 0..1, wraps light around the form (half-Lambert style), shrinking the shaded side. */
  wrap: number;
  /** Number of light bands (2 = classic lit/shadow split). */
  bands: number;
  /** 0..1, softness of the band edges. */
  softness: number;
  /** Brightness of the flat lit colour relative to the part's average vertex colour. */
  exposure: number;
  /** 0..1, how dark the flat shadow colour is before any texture. */
  shadow: number;
  /** 0..1, strength of the screen-space texture inside the shadow mask. */
  texture: number;
  /** 0 = fBm wash noise, 1 = pencil hatching; in between blends the two. */
  pattern: number;
  /** Texture size in pixels: noise blotch size; hatch spacing is 1/15 of it. */
  texScale: number;
  /** Domain-warp of the noise. */
  texWarp: number;
  /** 0..1, noise contrast: soft variation -> hard-edged pools. */
  texContrast: number;
  /** Degrees, hatch stroke direction. */
  hatchAngle: number;
  /** 0..1, strength of a second, perpendicular set of hatch strokes. */
  crossHatch: number;
  /** Outline width in model units (0 = off). Constant-width solid black line. */
  outline: number;
};

export const DEFAULT_TOON: ToonOptions = {
  yaw: 0,
  lightAzimuth: -30,
  lightElevation: 45,
  castShadows: 1,
  wrap: 0.2,
  bands: 2,
  softness: 0.08,
  exposure: 1.5,
  shadow: 0.45,
  texture: 0.7,
  pattern: 0,
  texScale: 70,
  texWarp: 1.5,
  texContrast: 0.5,
  hatchAngle: 45,
  crossHatch: 0,
  outline: 0.018,
};

/** Slider ranges for the tuning panel, in display order. */
export const TOON_RANGES: Record<keyof ToonOptions, TuningRange> = {
  yaw: { min: -180, max: 180, step: 1 },
  lightAzimuth: { min: -180, max: 180, step: 1 },
  lightElevation: { min: 0, max: 90, step: 1 },
  castShadows: { min: 0, max: 1, step: 1 },
  wrap: { min: 0, max: 1, step: 0.01 },
  bands: { min: 2, max: 6, step: 1 },
  softness: { min: 0, max: 1, step: 0.01 },
  exposure: { min: 0.5, max: 3, step: 0.01 },
  shadow: { min: 0, max: 1, step: 0.01 },
  texture: { min: 0, max: 1, step: 0.01 },
  pattern: { min: 0, max: 1, step: 0.01 },
  texScale: { min: 10, max: 400, step: 1 },
  texWarp: { min: 0, max: 6, step: 0.05 },
  texContrast: { min: 0, max: 1, step: 0.01 },
  hatchAngle: { min: 0, max: 180, step: 1 },
  crossHatch: { min: 0, max: 1, step: 0.01 },
  outline: { min: 0, max: 0.08, step: 0.001 },
};

/** Point the sun at the flower from `lightAzimuth`/`lightElevation`. */
const SUN_TARGET = new THREE.Vector3(0, 1.7, 0);
const SUN_DISTANCE = 10;

const FRAGMENT_GLSL = /* glsl */ `
  {
    // Recover "how lit is this pixel" (0..1) from the direct term: it is
    // ramp(N.L) * castShadow * sun * albedo / PI, so dividing the rest out
    // leaves the wrapped N.L with cast shadows already folded in.
    float tnAlbedoMax = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b));
    vec3 tnDirect = reflectedLight.directDiffuse;
    float tnLight = clamp(
      max(tnDirect.r, max(tnDirect.g, tnDirect.b)) * PI / max(tnAlbedoMax * tnSun, 1e-4), 0.0, 1.0);

    // Quantise into bands; level 0 = full shadow, 1 = fully lit.
    float tnT = tnLight * tnBands;
    float tnLevel = clamp(
      (floor(tnT) - 1.0 + smoothstep(0.0, max(tnSoftness, 1e-3), fract(tnT))) / (tnBands - 1.0), 0.0, 1.0);
    float tnMask = 1.0 - tnLevel;

    // Flat colours: lit, and a darker, more saturated shadow of the same hue.
    vec3 tnLit = clamp(diffuseColor.rgb * tnExposure, 1e-4, 1.0);
    vec3 tnCol = mix(tnLit, pow(tnLit, vec3(1.0 + 2.0 * tnShadow)) * (1.0 - 0.35 * tnShadow), tnMask);

    // Screen-space texture, strictly confined to the shadow mask.
    vec2 tnPx = gl_FragCoord.xy;
    float tnAmount = tnMask * tnTexture;

    vec3 tnQ = vec3(tnPx / tnTexScale, 3.0);
    tnQ.xy += tnTexWarp * (vec2(wcNoise(tnQ + 19.0), wcNoise(tnQ + 41.0)) - 0.5);
    float tnBand = mix(0.35, 0.03, tnTexContrast);
    float tnNoise = smoothstep(0.5 - tnBand, 0.5 + tnBand, wcFbm(tnQ));
    // Wash: pigment varies both ways around the flat colour.
    vec3 tnNoiseCol = pow(tnCol, vec3(exp2((tnNoise - 0.5) * 2.2 * tnAmount)));

    float tnSpacing = max(tnTexScale / 15.0, 1.5);
    vec2 tnDir = vec2(cos(tnHatchAngle), sin(tnHatchAngle));
    float tnBend = (wcNoise(vec3(tnPx * 0.02, 9.0)) - 0.5) * tnSpacing * 1.5;
    float tnPress = wcNoise(vec3(tnPx * 0.05, 13.0));
    float tnLine = 1.0 - smoothstep(0.12, 0.3, abs(fract((dot(tnPx, tnDir) + tnBend) / tnSpacing) - 0.5));
    float tnCross = 1.0 - smoothstep(0.12, 0.3,
      abs(fract((dot(tnPx, vec2(-tnDir.y, tnDir.x)) + tnBend) / tnSpacing) - 0.5));
    float tnStroke = max(tnLine, tnCross * tnCrossHatch) * smoothstep(0.2, 0.6, tnPress + 0.25);
    vec3 tnHatchCol = mix(tnCol, tnCol * tnCol * 0.4, tnStroke * tnAmount);

    outgoingLight = mix(tnNoiseCol, tnHatchCol, tnPattern);
  }
`;

/** 256x1 ramp the toon material looks N.L up in: linear, with light wrap, quantised later in the shader. */
function writeRamp(data: Uint8Array, wrap: number) {
  for (let i = 0; i < data.length; i++) {
    const nDotL = (i / (data.length - 1)) * 2 - 1;
    data[i] = Math.round(255 * Math.min(1, Math.max(0, (nDotL + wrap) / (1 + wrap))));
  }
}

/**
 * Replace every mesh material under `root` with the toon material and aim
 * `sun` from the options. Returns a setter for live tuning.
 */
export function applyToon(
  root: THREE.Object3D,
  sun: THREE.DirectionalLight,
  options: ToonOptions = DEFAULT_TOON,
): (next: Partial<ToonOptions>) => void {
  const current = { ...options };
  const uniforms = {
    tnSun: { value: sun.intensity },
    tnBands: { value: options.bands },
    tnSoftness: { value: options.softness },
    tnExposure: { value: options.exposure },
    tnShadow: { value: options.shadow },
    tnTexture: { value: options.texture },
    tnPattern: { value: options.pattern },
    tnTexScale: { value: options.texScale },
    tnTexWarp: { value: options.texWarp },
    tnTexContrast: { value: options.texContrast },
    tnCrossHatch: { value: options.crossHatch },
    tnHatchAngle: { value: THREE.MathUtils.degToRad(options.hatchAngle) },
  };
  const uniformDecl = Object.keys(uniforms)
    .map((name) => `uniform float ${name};`)
    .join("\n");

  const rampData = new Uint8Array(256);
  writeRamp(rampData, options.wrap);
  const ramp = new THREE.DataTexture(rampData, rampData.length, 1, THREE.RedFormat);
  ramp.minFilter = ramp.magFilter = THREE.LinearFilter;
  ramp.needsUpdate = true;

  // Solid colour per part: the average of the vertex colours of every mesh sharing a material.
  const meshes: THREE.Mesh[] = [];
  const colorSums = new Map<THREE.Material, [number, number, number, number]>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    meshes.push(mesh);
    const colors = mesh.geometry.getAttribute("color");
    if (!colors) return;
    const sum = colorSums.get(mesh.material) ?? [0, 0, 0, 0];
    for (let i = 0; i < colors.count; i++) {
      sum[0] += colors.getX(i);
      sum[1] += colors.getY(i);
      sum[2] += colors.getZ(i);
    }
    sum[3] += colors.count;
    colorSums.set(mesh.material, sum);
  });

  const toonMaterials = new Map<THREE.Material, THREE.MeshToonMaterial>();
  for (const mesh of meshes) {
    const base = mesh.material as THREE.Material;
    let toon = toonMaterials.get(base);
    if (!toon) {
      const [r, g, b, n] = colorSums.get(base) ?? [0.5, 0.5, 0.5, 1];
      toon = new THREE.MeshToonMaterial({ gradientMap: ramp, side: THREE.DoubleSide });
      toon.color.setRGB(r / n, g / n, b / n);
      toon.name = `${base.name}.toon`;
      toon.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.fragmentShader = shader.fragmentShader
          .replace(
            "#include <common>",
            // The shared fBm reads these as uniforms in the watercolor shader; fixed here.
            `#include <common>\n#define WC_OCTAVES 4\n#define wcLacunarity 2.03\n#define wcGain 0.5\n${uniformDecl}\n${NOISE_GLSL}\n${FBM_GLSL}`,
          )
          .replace("#include <opaque_fragment>", `${FRAGMENT_GLSL}\n#include <opaque_fragment>`);
      };
      toon.customProgramCacheKey = () => "flower-toon";
      toonMaterials.set(base, toon);
    }
    mesh.material = toon;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }

  // Clean constant-width ink line: no noise lives on the model itself.
  // Hulls are added after the shadow flags so they neither cast nor receive.
  const outline = addPencilOutline(meshes, { outline: options.outline, pencil: 0, scale: 1, wobble: 0 });

  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -3.5;
  sun.shadow.camera.right = sun.shadow.camera.top = 3.5;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 2 * SUN_DISTANCE;
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  sun.target.position.copy(SUN_TARGET);
  sun.parent?.add(sun.target);

  const aimSun = () => {
    const az = THREE.MathUtils.degToRad(current.lightAzimuth);
    const el = THREE.MathUtils.degToRad(current.lightElevation);
    sun.position
      .set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
      .multiplyScalar(SUN_DISTANCE)
      .add(SUN_TARGET);
  };
  aimSun();
  sun.castShadow = options.castShadows === 1;

  return (next) => {
    Object.assign(current, next);
    if (next.lightAzimuth !== undefined || next.lightElevation !== undefined) aimSun();
    if (next.castShadows !== undefined) sun.castShadow = next.castShadows === 1;
    if (next.wrap !== undefined) {
      writeRamp(rampData, next.wrap);
      ramp.needsUpdate = true;
    }
    if (next.bands !== undefined) uniforms.tnBands.value = next.bands;
    if (next.softness !== undefined) uniforms.tnSoftness.value = next.softness;
    if (next.exposure !== undefined) uniforms.tnExposure.value = next.exposure;
    if (next.shadow !== undefined) uniforms.tnShadow.value = next.shadow;
    if (next.texture !== undefined) uniforms.tnTexture.value = next.texture;
    if (next.pattern !== undefined) uniforms.tnPattern.value = next.pattern;
    if (next.texScale !== undefined) uniforms.tnTexScale.value = next.texScale;
    if (next.texWarp !== undefined) uniforms.tnTexWarp.value = next.texWarp;
    if (next.texContrast !== undefined) uniforms.tnTexContrast.value = next.texContrast;
    if (next.crossHatch !== undefined) uniforms.tnCrossHatch.value = next.crossHatch;
    if (next.hatchAngle !== undefined) uniforms.tnHatchAngle.value = THREE.MathUtils.degToRad(next.hatchAngle);
    if (next.outline !== undefined) outline.setOutline(next.outline);
  };
}
