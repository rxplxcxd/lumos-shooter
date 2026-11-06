// Optimizes raw downloaded GLBs (Sketchfab / itch.io) into web-ready assets:
//  - dedup / weld / prune / resample animations
//  - textures resized + re-encoded as WebP (huge VRAM + download savings)
//  - Draco geometry compression (decoded at runtime by three's DRACOLoader)
// Usage: node scripts/process-assets.mjs <rawDir> <outDir> [--tex 1024] [--nodraco] [--simplify 0.5]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, weld, prune, resample, textureCompress, draco, simplify, unpartition } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const [rawDir, outDir] = args;
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const texSize = +opt('--tex', 1024);
const noDraco = args.includes('--nodraco');
const simplifyRatio = +opt('--simplify', 0);
const only = opt('--only', '');
fs.mkdirSync(outDir, { recursive: true });

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
await MeshoptSimplifier.ready;

const files = fs.readdirSync(rawDir).filter((f) => /\.(glb|gltf)$/i.test(f) && (!only || only.split(',').includes(f.replace(/\.(glb|gltf)$/i, ''))));
for (const f of files) {
  const src = path.join(rawDir, f);
  const dst = path.join(outDir, f.replace(/\.gltf$/i, '.glb'));
  try {
    const doc = await io.read(src);
    const transforms = [dedup(), weld(), resample(), prune(), unpartition()];
    if (simplifyRatio > 0) transforms.push(simplify({ simplifier: MeshoptSimplifier, ratio: simplifyRatio, error: 0.001 }));
    transforms.push(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [texSize, texSize], quality: 82 }));
    if (!noDraco) transforms.push(draco({ method: 'edgebreaker', quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }));
    await doc.transform(...transforms);
    await io.write(dst, doc);
    const a = fs.statSync(src).size, b = fs.statSync(dst).size;
    console.log(`${f}: ${(a / 1024).toFixed(0)}KB -> ${(b / 1024).toFixed(0)}KB`);
  } catch (e) {
    console.log(`${f}: ERROR ${e.message}`);
  }
}
