/**
 * Prototype watercolor look for the 3D flower: patches the GLB's standard
 * materials (via onBeforeCompile) so the fragment colour is perturbed by
 * domain-warped fractal Brownian motion, approximating the pigment pooling,
 * granulation and splatter of the reference art in assets/flower/Flower*.png.
 *
 * The flower meshes have no UVs, only vertex colours, so the noise is sampled
 * in 3D at the rest-pose position (the pre-skinning `position` attribute).
 * That keeps the pigment glued to the petals while the spring bends them.
 */
import * as THREE from "three";

export type WatercolorOptions = {
  /** Noise frequency in model units. Higher = smaller blotches. */
  scale: number;
  /** 0..1, how strongly pigment density darkens/saturates the base colour. */
  strength: number;
  /** 0..1, how much of the PBR lighting is replaced by flat (unlit) albedo. */
  flatten: number;
  /** 0..1, pigment pooling toward silhouette edges. */
  edge: number;
  /** 0..1, screen-space paper grain. */
  grain: number;
  /** 0..1, light splatter speckles. */
  speckle: number;
  /** Domain-warp amount: 0 = plain cloudy fBm, higher = more wet-in-wet bleeding. */
  warp: number;
  /** fBm frequency multiplier per octave. */
  lacunarity: number;
  /** fBm amplitude multiplier per octave. Higher = rougher, more fine detail. */
  gain: number;
  /** 0|1. Replace each part's vertex-colour gradients with its average colour, to isolate the fBm. */
  solid: number;
  /** 0|1. Ignore scene lighting entirely (flat albedo), to isolate the fBm. */
  unlit: number;
  /** fBm octaves (compile-time constant; each one costs fragment time). */
  octaves: number;
};

export const DEFAULT_WATERCOLOR: WatercolorOptions = {
  scale: 1.6,
  strength: 0.7,
  flatten: 0.75,
  edge: 0.5,
  grain: 0.35,
  speckle: 0.6,
  warp: 2.5,
  lacunarity: 2.03,
  gain: 0.5,
  solid: 0,
  unlit: 0,
  octaves: 4,
};

/** Slider ranges for the tuning panel, in display order. */
export const WATERCOLOR_RANGES: Record<keyof WatercolorOptions, { min: number; max: number; step: number }> = {
  solid: { min: 0, max: 1, step: 1 },
  unlit: { min: 0, max: 1, step: 1 },
  scale: { min: 0.2, max: 8, step: 0.05 },
  warp: { min: 0, max: 8, step: 0.05 },
  octaves: { min: 1, max: 8, step: 1 },
  lacunarity: { min: 1.2, max: 4, step: 0.01 },
  gain: { min: 0.1, max: 0.9, step: 0.01 },
  strength: { min: 0, max: 1.5, step: 0.01 },
  flatten: { min: 0, max: 1, step: 0.01 },
  edge: { min: 0, max: 1.5, step: 0.01 },
  grain: { min: 0, max: 1, step: 0.01 },
  speckle: { min: 0, max: 1, step: 0.01 },
};

/** Read `wcScale`, `wcStrength`, ... overrides from a query string, for quick tuning. */
export function watercolorOptionsFromParams(params: URLSearchParams): WatercolorOptions {
  const opts = { ...DEFAULT_WATERCOLOR };
  for (const key of Object.keys(opts) as (keyof WatercolorOptions)[]) {
    const raw = params.get(`wc${key[0].toUpperCase()}${key.slice(1)}`);
    const v = raw === null ? NaN : Number(raw);
    if (Number.isFinite(v)) opts[key] = v;
  }
  opts.octaves = Math.max(1, Math.min(8, Math.round(opts.octaves)));
  return opts;
}

const NOISE_GLSL = /* glsl */ `
  float wcHash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float wcNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(wcHash(i), wcHash(i + vec3(1, 0, 0)), f.x),
          mix(wcHash(i + vec3(0, 1, 0)), wcHash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(wcHash(i + vec3(0, 0, 1)), wcHash(i + vec3(1, 0, 1)), f.x),
          mix(wcHash(i + vec3(0, 1, 1)), wcHash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  float wcFbm(vec3 p) {
    float sum = 0.0;
    float amp = 0.5;
    float norm = 0.0;
    for (int i = 0; i < WC_OCTAVES; i++) {
      sum += amp * wcNoise(p);
      norm += amp;
      p = p * wcLacunarity + vec3(11.7, 5.3, 8.1);
      amp *= wcGain;
    }
    return sum / norm;
  }
`;

const FRAGMENT_GLSL = /* glsl */ `
  {
    vec3 wcP = vWcPos * wcScale;
    // Domain warp: fBm offset by fBm gives the wet-in-wet bleeding shapes
    // rather than plain cloudy noise.
    vec3 wcWarp = vec3(wcFbm(wcP + 3.1), wcFbm(wcP + 17.4), wcFbm(wcP + 29.8)) - 0.5;
    float wcDensity = wcFbm(wcP + wcWarpAmt * wcWarp);
    // Stretch contrast; raw fBm clusters tightly around 0.5.
    wcDensity = smoothstep(0.25, 0.75, wcDensity);

    // Pigment pools where the surface turns away from the (orthographic) view.
    float wcRim = 1.0 - abs(normal.z);
    wcDensity = clamp(wcDensity + wcEdge * (wcRim * wcRim - 0.15), 0.0, 1.0);

    // Flat albedo is darker than the lit result, so renormalise it to the lit
    // brightness: keeps the unlit paint look without going muddy.
    vec3 wcLit = max(outgoingLight, vec3(1e-4));
    vec3 wcAlbedo = max(diffuseColor.rgb, vec3(1e-4));
    float wcLum = max(wcLit.r, max(wcLit.g, wcLit.b));
    vec3 wcBase = mix(wcLit, wcAlbedo / max(wcAlbedo.r, max(wcAlbedo.g, wcAlbedo.b)) * wcLum, wcFlatten);
    // Unlit: drop the scene lighting altogether. The gain roughly matches the lit exposure.
    wcBase = mix(wcBase, min(wcAlbedo * 1.6, vec3(1.0)), wcUnlit);
    // Subtractive-ish pigment: dense areas raise the exponent (darker, more
    // saturated); thin washes brighten toward the pure hue, not toward grey.
    float wcExp = exp2((wcDensity - 0.35) * 2.0 * wcStrength);
    vec3 wcCol = pow(wcBase, vec3(wcExp));
    vec3 wcHue = wcBase / max(wcBase.r, max(wcBase.g, wcBase.b));
    wcCol = mix(wcCol, wcHue, (1.0 - wcDensity) * 0.35 * wcStrength);

    // Splatter: sparse bright flecks fixed to the surface.
    float wcFleck = wcNoise(vWcPos * wcScale * 28.0);
    wcCol = mix(wcCol, vec3(1.0, 0.97, 0.75), smoothstep(0.86, 0.93, wcFleck) * wcSpeckle);

    // Paper grain lives in screen space: the paper doesn't move with the flower.
    float wcPaper = wcNoise(vec3(gl_FragCoord.xy * 0.35, 0.0)) * 0.6
                  + wcNoise(vec3(gl_FragCoord.xy * 0.09, 4.0)) * 0.4;
    wcCol *= 1.0 - wcGrain * 0.35 * (wcPaper - 0.4) * (0.5 + wcDensity);

    outgoingLight = wcCol;
  }
`;

/**
 * Patch every mesh material under `root` with the watercolor shader. Returns
 * a setter for live-tuning; everything is a uniform except octaves, which
 * triggers a shader recompile.
 */
export function applyWatercolor(
  root: THREE.Object3D,
  options: WatercolorOptions = DEFAULT_WATERCOLOR,
): (next: Partial<WatercolorOptions>) => void {
  const uniforms = {
    wcScale: { value: options.scale },
    wcStrength: { value: options.strength },
    wcFlatten: { value: options.flatten },
    wcEdge: { value: options.edge },
    wcGrain: { value: options.grain },
    wcSpeckle: { value: options.speckle },
    wcWarpAmt: { value: options.warp },
    wcLacunarity: { value: options.lacunarity },
    wcGain: { value: options.gain },
    wcUnlit: { value: options.unlit },
  };
  let octaves = options.octaves;
  const uniformDecl = Object.keys(uniforms)
    .map((name) => `uniform float ${name};`)
    .join("\n");

  const seen = new Set<THREE.Material>();
  // Running vertex-colour sums per material (r, g, b, count), for the `solid` toggle.
  const colorSums = new Map<THREE.Material, [number, number, number, number]>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const colors = mesh.geometry.getAttribute("color");
      if (colors) {
        const sum = colorSums.get(material) ?? [0, 0, 0, 0];
        for (let i = 0; i < colors.count; i++) {
          sum[0] += colors.getX(i);
          sum[1] += colors.getY(i);
          sum[2] += colors.getZ(i);
        }
        sum[3] += colors.count;
        colorSums.set(material, sum);
      }
      if (seen.has(material)) continue;
      seen.add(material);
      material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nvarying vec3 vWcPos;")
          .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWcPos = position;");
        shader.fragmentShader = shader.fragmentShader
          .replace(
            "#include <common>",
            `#include <common>\n#define WC_OCTAVES ${octaves}\nvarying vec3 vWcPos;\n${uniformDecl}\n${NOISE_GLSL}`,
          )
          .replace("#include <opaque_fragment>", `${FRAGMENT_GLSL}\n#include <opaque_fragment>`);
      };
      material.customProgramCacheKey = () => `watercolor-${octaves}-${material.vertexColors}`;
      material.needsUpdate = true;
    }
  });

  // Swap vertex colours for the part's average colour (and back).
  const originals = new Map<THREE.Material, { vertexColors: boolean; color: THREE.Color }>();
  const setSolid = (solid: boolean) => {
    for (const [material, [r, g, b, n]] of colorSums) {
      const std = material as THREE.MeshStandardMaterial;
      if (!std.color || n === 0) continue;
      if (!originals.has(std)) {
        originals.set(std, { vertexColors: std.vertexColors, color: std.color.clone() });
      }
      const original = originals.get(std)!;
      std.vertexColors = solid ? false : original.vertexColors;
      if (solid) std.color.copy(original.color).multiply(new THREE.Color(r / n, g / n, b / n));
      else std.color.copy(original.color);
      std.needsUpdate = true;
    }
  };
  let solid = false;
  if (options.solid) setSolid((solid = true));

  return (next) => {
    if (next.unlit !== undefined) uniforms.wcUnlit.value = next.unlit;
    if (next.solid !== undefined && Boolean(next.solid) !== solid) setSolid((solid = Boolean(next.solid)));
    if (next.scale !== undefined) uniforms.wcScale.value = next.scale;
    if (next.strength !== undefined) uniforms.wcStrength.value = next.strength;
    if (next.flatten !== undefined) uniforms.wcFlatten.value = next.flatten;
    if (next.edge !== undefined) uniforms.wcEdge.value = next.edge;
    if (next.grain !== undefined) uniforms.wcGrain.value = next.grain;
    if (next.speckle !== undefined) uniforms.wcSpeckle.value = next.speckle;
    if (next.warp !== undefined) uniforms.wcWarpAmt.value = next.warp;
    if (next.lacunarity !== undefined) uniforms.wcLacunarity.value = next.lacunarity;
    if (next.gain !== undefined) uniforms.wcGain.value = next.gain;
    if (next.octaves !== undefined && next.octaves !== octaves) {
      octaves = next.octaves;
      for (const material of seen) material.needsUpdate = true;
    }
  };
}
