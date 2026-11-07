// Turns a multi-object asset pack (one GLB with many props, e.g. from Sketchfab) into a kit GLB:
// the scene graph is flattened (world transforms baked), every prop becomes one top-level node
// with a clean name, and props made of several meshes can be grouped.
// Usage: node scripts/build-pack-kit.mjs <in.glb> <out.glb> [--tex 512] [--simplify 0.5]
//          [--strip "_.*_shader_0$"] [--group "Dumpster=Dumpster,LidLeft,LidRight"]... [--drop name,...]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, weld, prune, textureCompress, draco, flatten, simplify, unpartition } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const input = args.shift(), out = args.shift();
let tex = 512, ratio = 0, strip = null;
const groups = [], drop = new Set();
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tex') tex = +args[++i];
  else if (args[i] === '--simplify') ratio = +args[++i];
  else if (args[i] === '--strip') strip = new RegExp(args[++i]);
  else if (args[i] === '--group') { const [n, list] = args[++i].split('='); groups.push([n, list.split(',')]); }
  else if (args[i] === '--drop') args[++i].split(',').forEach((n) => drop.add(n));
}
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const doc = await io.read(input);
for (const a of doc.getRoot().listAnimations()) a.dispose();
await doc.transform(flatten());
const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
// remove empty transform nodes, rename props
const clean = (n) => (strip ? n.replace(strip, '') : n);
// groups first (members match the cleaned name, or the original name by prefix with a trailing *)
const orig = new Map(scene.listChildren().map((n) => [n, n.getName()]));
for (const [gname, members] of groups) {
  const g = doc.createNode(gname);
  for (const m of members) {
    const hits = scene.listChildren().filter((n) => n.getMesh() && (m.endsWith('*') ? orig.get(n).startsWith(m.slice(0, -1)) : clean(orig.get(n)) === m));
    if (!hits.length) console.warn('missing', m);
    for (const n of hits) { scene.removeChild(n); g.addChild(n); n.setName(gname + '_' + clean(orig.get(n))); }
  }
  scene.addChild(g);
}
const used = new Set();
for (const n of scene.listChildren()) {
  if (!n.getMesh()) { if (!n.listChildren().length) n.dispose(); continue; }
  let name = clean(n.getName());
  if (drop.has(name)) { n.dispose(); continue; }
  while (used.has(name)) name += '_2';
  used.add(name);
  n.setName(name);
}
await MeshoptSimplifier.ready;
const extra = ratio ? [simplify({ simplifier: MeshoptSimplifier, ratio, error: +(process.env.SIMPLIFY_ERROR || 0.004), lockBorder: false })] : [];
await doc.transform(unpartition(), dedup(), weld(), ...extra, prune({ keepLeaves: true }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [tex, tex], quality: 80 }), draco());
await io.write(out, doc);
console.log(path.basename(out), scene.listChildren().map((n) => n.getName()).join(', '), (fs.statSync(out).size / 1024).toFixed(0) + 'KB');
