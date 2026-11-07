// Splits a merged scene (e.g. a SketchUp street exported to Sketchfab) into individually placeable
// pieces and writes them as a kit GLB (one top-level node per piece).
//
// 1. the scene graph is flattened (world transforms baked into every mesh node)
// 2. huge flat meshes are treated as ground plates and dropped (--keep-ground keeps them)
// 3. meshes whose footprints touch / overlap (XZ, with tolerance) are merged with union-find,
//    so facade + side walls + roof + chimneys of one building end up in one cluster
// 4. clusters that are still very long (terraced rows) can be cut along their long axis at
//    gaps in the footprint coverage (--split-rows)
// 5. every cluster becomes a node `<prefix>_<nn>`; a JSON sidecar lists size, tris and members
//
// Usage: node scripts/split-scene.mjs <in.glb> <out.glb> [--prefix eb] [--tol 0.3] [--tex 1024]
//          [--min-size 1.5] [--keep-ground] [--split-rows 28] [--scale 1]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, weld, prune, textureCompress, draco, flatten, unpartition, getBounds } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const input = args.shift(), out = args.shift();
const opt = { prefix: 'piece', tol: 0.3, tex: 1024, minSize: 1.5, keepGround: false, splitRows: 0, scale: 1, dropLarger: 1e9, dropNames: [], keep: null, report: '' };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--prefix') opt.prefix = args[++i];
  else if (a === '--tol') opt.tol = +args[++i];
  else if (a === '--tex') opt.tex = +args[++i];
  else if (a === '--min-size') opt.minSize = +args[++i];
  else if (a === '--keep-ground') opt.keepGround = true;
  else if (a === '--split-rows') opt.splitRows = +args[++i];
  else if (a === '--scale') opt.scale = +args[++i];
  else if (a === '--drop-larger') opt.dropLarger = +args[++i];
  else if (a === '--drop') opt.dropNames = args[++i].split(',');
  else if (a === '--report') opt.report = args[++i];
  else if (a === '--keep') opt.keep = Object.fromEntries(args[++i].split(',').map((kv) => kv.split('=')));
}
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(), 'draco3d.encoder': await draco3d.createEncoderModule(),
});
const doc = await io.read(input);
for (const a of doc.getRoot().listAnimations()) a.dispose();
await doc.transform(flatten());
const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
const tris = (n) => n.getMesh().listPrimitives().reduce((s, p) => s + (p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount()) / 3, 0);

// ---------------------------------------------------------------- collect mesh nodes
const items = [];
for (const n of scene.listChildren()) {
  if (!n.getMesh()) { if (!n.listChildren().length) n.dispose(); continue; }
  const b = getBounds(n);
  const size = b.max.map((v, i) => v - b.min[i]);
  items.push({ n, min: b.min, max: b.max, size, tris: tris(n) });
}
// ground plates: very large & thin (or a big low slab spanning most of the scene)
const sceneMin = [0, 1, 2].map((i) => Math.min(...items.map((it) => it.min[i])));
const sceneMax = [0, 1, 2].map((i) => Math.max(...items.map((it) => it.max[i])));
const sceneSpan = Math.max(sceneMax[0] - sceneMin[0], sceneMax[2] - sceneMin[2]);
const isGround = (it) => (it.size[1] < 0.25 && Math.max(it.size[0], it.size[2]) > 12) || (Math.max(it.size[0], it.size[2]) > sceneSpan * 0.55 && it.size[1] < 3)
  || Math.max(it.size[0], it.size[2]) > opt.dropLarger || opt.dropNames.includes(it.n.getName());
const ground = items.filter(isGround);
const parts = items.filter((it) => !isGround(it));
console.log(`${items.length} meshes, ${ground.length} ground plates, scene ${sceneMax.map((v, i) => (v - sceneMin[i]).toFixed(1)).join('x')}`);

// ---------------------------------------------------------------- union-find on XZ footprints
const parent = parts.map((_, i) => i);
const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
const touch = (a, b, t) => a.min[0] - t <= b.max[0] && b.min[0] - t <= a.max[0] && a.min[2] - t <= b.max[2] && b.min[2] - t <= a.max[2];
for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
  if (touch(parts[i], parts[j], opt.tol)) parent[find(i)] = find(j);
}
let clusters = new Map();
parts.forEach((it, i) => { const r = find(i); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(it); });
clusters = [...clusters.values()];

// ---------------------------------------------------------------- optional: cut long terraced rows at footprint gaps
const bbox = (list) => ({ min: [0, 1, 2].map((k) => Math.min(...list.map((it) => it.min[k]))), max: [0, 1, 2].map((k) => Math.max(...list.map((it) => it.max[k]))) });
if (opt.splitRows > 0) {
  const outC = [];
  for (const c of clusters) {
    const b = bbox(c);
    const sx = b.max[0] - b.min[0], sz = b.max[2] - b.min[2];
    const axis = sx >= sz ? 0 : 2;
    const len = Math.max(sx, sz);
    if (len <= opt.splitRows || c.length < 4) { outC.push(c); continue; }
    // sort member centres along the axis and cut where a member does not overlap the next one
    const sorted = [...c].sort((p, q) => (p.min[axis] + p.max[axis]) - (q.min[axis] + q.max[axis]));
    let cur = [], curMax = -1e9;
    for (const it of sorted) {
      if (cur.length && it.min[axis] > curMax - 0.05 && (curMax - bbox(cur).min[axis]) > 6) { outC.push(cur); cur = []; curMax = -1e9; }
      cur.push(it); curMax = Math.max(curMax, it.max[axis]);
    }
    if (cur.length) outC.push(cur);
  }
  clusters = outC;
}
// tiny clusters (loose decoration) are folded into the nearest bigger cluster when they touch it with a larger tolerance
const big = clusters.filter((c) => { const b = bbox(c); return Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) >= opt.minSize; });
const small = clusters.filter((c) => !big.includes(c));
for (const c of small) {
  const b = bbox(c);
  const host = big.find((h) => touch(bbox(h), b, 1.5));
  if (host) host.push(...c);
}
// ---------------------------------------------------------------- build output nodes
const report = [];
big.sort((a, b) => { const A = bbox(a), B = bbox(b); return (A.min[0] + A.min[2]) - (B.min[0] + B.min[2]); });
big.forEach((c, k) => {
  const b = bbox(c);
  const name = `${opt.prefix}_${String(k).padStart(2, '0')}`;
  const g = doc.createNode(name);
  for (const it of c) { scene.removeChild(it.n); g.addChild(it.n); }
  if (opt.scale !== 1) g.setScale([opt.scale, opt.scale, opt.scale]);
  scene.addChild(g);
  report.push({ name, size: [0, 1, 2].map((i) => +((b.max[i] - b.min[i]) * opt.scale).toFixed(2)), center: [0, 1, 2].map((i) => +(((b.max[i] + b.min[i]) / 2) * opt.scale).toFixed(2)), members: c.length, tris: c.reduce((s, it) => s + it.tris, 0), materials: [...new Set(c.flatMap((it) => it.n.getMesh().listPrimitives().map((p) => p.getMaterial()?.getName())))].slice(0, 6) });
});
for (const it of [...ground, ...small.flat().filter((it) => it.n.getParentNode?.() === null)]) {
  if (opt.keepGround && ground.includes(it)) { const g = doc.createNode(`${opt.prefix}_ground_${report.length}`); scene.removeChild(it.n); g.addChild(it.n); scene.addChild(g); continue; }
  it.n.dispose();
}
// drop anything still directly under the scene that is not one of our groups
for (const n of scene.listChildren()) if (n.getMesh()) n.dispose();
// --keep a=NewName,b=Other: keep only these clusters, renamed
if (opt.keep) {
  for (const g of scene.listChildren()) {
    const nn = opt.keep[g.getName()];
    if (!nn) { g.listChildren().forEach((c) => c.dispose()); g.dispose(); continue; }
    g.setName(nn);
    const r = report.find((x) => x.name === g.getName() || opt.keep[x.name] === nn); if (r) r.name = nn;
  }
  for (let i = report.length - 1; i >= 0; i--) if (!Object.values(opt.keep).includes(report[i].name)) report.splice(i, 1);
}
await doc.transform(unpartition(), dedup(), weld(), prune({ keepLeaves: true }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [opt.tex, opt.tex], quality: 82 }), draco());
await io.write(out, doc);
if (opt.report) fs.writeFileSync(opt.report, JSON.stringify(report, null, 1));
console.log(path.basename(out), report.length, 'pieces', (fs.statSync(out).size / 1024).toFixed(0) + 'KB');
for (const r of report) console.log(`  ${r.name}  ${r.size.join(' x ')}  members ${r.members}  tris ${r.tris}  ${r.materials.join(',')}`);
