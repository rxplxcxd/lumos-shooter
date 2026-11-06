// Prints bounds, mesh/triangle counts and animation names for GLB files.
// Usage: node scripts/inspect-assets.mjs <file.glb|dir> ...
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import fs from 'node:fs';
import path from 'node:path';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
});
const files = process.argv.slice(2).flatMap((p) =>
  fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => f.endsWith('.glb')).map((f) => path.join(p, f)) : [p]);
for (const f of files) {
  try {
    const doc = await io.read(f);
    const root = doc.getRoot();
    const scene = root.getDefaultScene() || root.listScenes()[0];
    const b = getBounds(scene);
    const size = b.max.map((v, i) => +(v - b.min[i]).toFixed(2));
    let tris = 0;
    for (const m of root.listMeshes()) for (const p of m.listPrimitives()) {
      const idx = p.getIndices(); const pos = p.getAttribute('POSITION');
      tris += idx ? idx.getCount() / 3 : (pos ? pos.getCount() / 3 : 0);
    }
    const anims = root.listAnimations().map((a) => a.getName());
    const tex = root.listTextures().map((t) => { const s = t.getSize(); return s ? s[0] : '?'; });
    const top = scene.listChildren().map((n) => n.getName()).slice(0, 6);
    console.log(`${path.basename(f)} | size ${size.join('x')} | min ${b.min.map((v) => v.toFixed(1)).join(',')} | tris ${Math.round(tris)} | skins ${root.listSkins().length} | tex ${tex.length}[${[...new Set(tex)].join(',')}] | anims ${anims.length ? anims.slice(0, 12).join(',') : '-'} | top ${top.join(',')}`);
  } catch (e) { console.log(path.basename(f), 'ERROR', e.message); }
}
