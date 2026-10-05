#!/usr/bin/env node
// Renders public/icon/icon.svg to the PNG sizes the manifest uses.
// Usage: node scripts/make-icons.mjs   (needs the `sharp` devDependency)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const dir = fileURLToPath(new URL('../public/icon/', import.meta.url));
const svg = readFileSync(dir + 'icon.svg');
const SIZES = [16, 32, 48, 96, 128];

for (const size of SIZES) {
  // Rasterise at a high density, then downscale: crisper edges at 16 and 32.
  await sharp(svg, { density: Math.max(72, (72 * size * 4) / 128) })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(`${dir}${size}.png`);
  console.log(`public/icon/${size}.png`);
}
