// Merges many small models (one file per prop) into a single "kit" GLB.
// Each source file becomes one top-level node named after the file, so the
// runtime can clone/instance pieces by name while sharing materials/textures.
// Usage: node scripts/build-kit.mjs <out.glb> [--tex 512] <file|dir> ...
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, weld, prune, textureCompress, draco, mergeDocuments, unpartition, simplify } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const out = args.shift();
let tex = 512;
let simplifyRatio = 0;
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tex') { tex = +args[++i]; continue; }
  if (args[i] === '--simplify') { simplifyRatio = +args[++i]; continue; }
  const p = args[i];
  if (fs.statSync(p).isDirectory()) inputs.push(...fs.readdirSync(p).filter((f) => /\.(glb|gltf)$/i.test(f)).map((f) => path.join(p, f)));
  else inputs.push(p);
}
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const target = new (await import('@gltf-transform/core')).Document();
target.createBuffer();
const scene = target.createScene('Kit');
target.getRoot().setDefaultScene(scene);
for (const f of inputs) {
  const name = path.basename(f).replace(/\.(glb|gltf)$/i, '');
  const src = await io.read(f);
  for (const a of src.getRoot().listAnimations()) a.dispose();
  const map = mergeDocuments(target, src);
  const srcScene = src.getRoot().getDefaultScene() || src.getRoot().listScenes()[0];
  const group = target.createNode(name);
  for (const child of srcScene.listChildren()) group.addChild(map.get(child));
  scene.addChild(group);
  for (const s of target.getRoot().listScenes()) if (s !== scene) s.dispose();
}
await MeshoptSimplifier.ready;
const extra = simplifyRatio ? [simplify({ simplifier: MeshoptSimplifier, ratio: simplifyRatio, error: +(process.env.SIMPLIFY_ERROR || 0.02), lockBorder: false })] : [];
await target.transform(unpartition(), dedup(), weld(), ...extra, prune({ keepLeaves: true }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [tex, tex], quality: 80 }), draco());
await io.write(out, target);
console.log(path.basename(out), inputs.length, 'pieces', (fs.statSync(out).size / 1024).toFixed(0) + 'KB');
