/**
 * Prototype watercolor look for the 3D flower: patches the GLB's standard
 * materials (via onBeforeCompile) so the fragment colour is perturbed by
 * domain-warped fractal Brownian motion, approximating the pigment pooling,
 * and edge lines of the reference art in assets/flower/Flower*.png.
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
  /** Outline width in model units (0 = off). Drawn as a noise-wobbled inverted hull per part. */
  outline: number;
  /** 0..1, pencil texture on the outline: 0 = solid ink line, 1 = light, broken graphite. */
  pencil: number;
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
  outline: 0.02,
  pencil: 0.5,
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
  outline: { min: 0, max: 0.08, step: 0.001 },
  pencil: { min: 0, max: 1, step: 0.01 },
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
`;

const FBM_GLSL = /* glsl */ `
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
  const meshes: THREE.Mesh[] = [];
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes.push(mesh);
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
            `#include <common>\n#define WC_OCTAVES ${octaves}\nvarying vec3 vWcPos;\n${uniformDecl}\n${NOISE_GLSL}\n${FBM_GLSL}`,
          )
          .replace("#include <opaque_fragment>", `${FRAGMENT_GLSL}\n#include <opaque_fragment>`);
      };
      material.customProgramCacheKey = () => `watercolor-${octaves}-${material.vertexColors}`;
      material.needsUpdate = true;
    }
  });

  // Outline: a back-face-only copy of each mesh pushed out along its normals
  // (inverted hull). The parts are closed, smooth-shaded solids, so this gives
  // a clean per-part line with no extra render pass, and the copy shares the
  // skeleton so it bends with the flower.
  const outlineUniforms = {
    wcOutline: { value: options.outline },
    wcPencil: { value: options.pencil },
    wcScale: uniforms.wcScale,
  };
  const hullMaterials = new Map<THREE.Material, THREE.MeshBasicMaterial>();
  const hulls: THREE.Mesh[] = [];
  for (const mesh of meshes) {
    const base = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    let hullMaterial = hullMaterials.get(base);
    if (!hullMaterial) {
      hullMaterial = new THREE.MeshBasicMaterial({ side: THREE.BackSide, color: 0x000000 });
      hullMaterial.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, outlineUniforms);
        shader.vertexShader = shader.vertexShader
          .replace(
            "#include <common>",
            `#include <common>\nuniform float wcOutline;\nuniform float wcScale;\nvarying vec3 vWcPos;\n${NOISE_GLSL}`,
          )
          .replace(
            "#include <begin_vertex>",
            // Wobble the width along the surface so it reads as a brush line.
            `#include <begin_vertex>
            vWcPos = position;
            transformed += normalize(normal) * wcOutline * (0.35 + 1.3 * wcNoise(position * wcScale * 3.0));`,
          );
        shader.fragmentShader = shader.fragmentShader
          .replace(
            "#include <common>",
            `#include <common>\nuniform float wcPencil;\nuniform float wcScale;\nvarying vec3 vWcPos;\n${NOISE_GLSL}`,
          )
          .replace(
            "#include <opaque_fragment>",
            `{
              // Pencil: pressure varies slowly along the line (fixed to the
              // surface); paper tooth is fine and lives in screen space. Where
              // pressure is light the graphite skips over the tooth.
              float wcPressure = wcNoise(vWcPos * wcScale * 5.0);
              float wcTooth = wcNoise(vec3(gl_FragCoord.xy * 0.9, 0.0)) * 0.65
                            + wcNoise(vec3(gl_FragCoord.xy * 0.33, 7.0)) * 0.35;
              if (wcTooth < wcPencil * (0.15 + 0.6 * (1.0 - wcPressure))) discard;
              // Graphite is dark grey rather than ink black where it's thin.
              outgoingLight = vec3(0.12 * wcPencil * (1.0 - wcPressure) * wcTooth);
            }
            #include <opaque_fragment>`,
          );
      };
      hullMaterial.customProgramCacheKey = () => "watercolor-outline";
      hullMaterials.set(base, hullMaterial);
    }
    const skinned = mesh as THREE.SkinnedMesh;
    let hull: THREE.Mesh;
    if (skinned.isSkinnedMesh) {
      const skinnedHull = new THREE.SkinnedMesh(mesh.geometry, hullMaterial);
      skinnedHull.bind(skinned.skeleton, skinned.bindMatrix);
      hull = skinnedHull;
    } else {
      hull = new THREE.Mesh(mesh.geometry, hullMaterial);
    }
    hull.name = `${mesh.name}.outline`;
    hull.position.copy(mesh.position);
    hull.quaternion.copy(mesh.quaternion);
    hull.scale.copy(mesh.scale);
    hull.frustumCulled = mesh.frustumCulled;
    hull.visible = options.outline > 0;
    mesh.parent?.add(hull);
    hulls.push(hull);
  }
  const setOutline = (width: number) => {
    outlineUniforms.wcOutline.value = width;
    for (const hull of hulls) hull.visible = width > 0;
  };

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
    if (next.outline !== undefined) setOutline(next.outline);
    if (next.pencil !== undefined) outlineUniforms.wcPencil.value = next.pencil;
    if (next.warp !== undefined) uniforms.wcWarpAmt.value = next.warp;
    if (next.lacunarity !== undefined) uniforms.wcLacunarity.value = next.lacunarity;
    if (next.gain !== undefined) uniforms.wcGain.value = next.gain;
    if (next.octaves !== undefined && next.octaves !== octaves) {
      octaves = next.octaves;
      for (const material of seen) material.needsUpdate = true;
    }
  };
}
