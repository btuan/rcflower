#!/usr/bin/env node
// Generates responsive WebP variants of the flower mood illustrations.
//
// Source of truth: 2048x2048 PNGs in `assets/` (repo root). This script
// reads those and writes multi-width WebP files into
// `frontend/src/assets/flower/`, which are committed so the build doesn't
// depend on this script running in CI.
//
// Usage: `npm run images` (from frontend/), or `node scripts/gen-images.mjs`.

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const srcDir = path.join(repoRoot, "assets");
const outDir = path.join(__dirname, "..", "src", "assets", "flower");

const MOODS = ["Neutral", "Sad", "Happy", "Dead"];
const WIDTHS = [256, 512, 1024, 2048];
const WEBP_QUALITY = 82;

async function main() {
  await mkdir(outDir, { recursive: true });

  for (const mood of MOODS) {
    const srcPath = path.join(srcDir, `Flower${mood}.png`);
    for (const width of WIDTHS) {
      const outPath = path.join(outDir, `Flower${mood}-${width}.webp`);
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
