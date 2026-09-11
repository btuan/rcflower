#!/usr/bin/env node
// Generates responsive WebP variants of the flower mood illustrations.
//
// Source of truth: 2048x2048 PNGs in `assets/watering_can/` (repo root). This script
// reads those and writes multi-width WebP files into
// `frontend/src/assets/WateringCan/`, which are committed so the build doesn't
// depend on this script running in CI.
//
// Usage: `npm run images` (from frontend/), or `node scripts/gen-images.mjs`.

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const srcDir = path.join(repoRoot, "assets", "watering_can");
const outDir = path.join(__dirname, "..", "src", "assets", "WateringCan");

const STATES = ["Upright", "Pour1", "Pour2"];
const WIDTHS = [256, 512, 1024, 2048];
const WEBP_QUALITY = 82;

async function main() {
  await mkdir(outDir, { recursive: true });

  for (const state of STATES) {
    const srcPath = path.join(srcDir, `WateringCan${state}.png`);
    for (const width of WIDTHS) {
      const outPath = path.join(outDir, `WateringCan${state}-${width}.webp`);
      await sharp(srcPath)
        .resize(width, width)
        .webp({ quality: WEBP_QUALITY })
        .toFile(outPath);
      console.log(`wrote ${path.relative(repoRoot, outPath)}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
