// Lists mesh nodes with their world-space bounds – helps to strip diorama bases etc.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
for (const f of process.argv.slice(2)) {
  const doc = await io.read(f);
  console.log('#', f);
  for (const n of doc.getRoot().listNodes()) {
    if (!n.getMesh()) continue;
    const b = getBounds(n);
    const s = b.max.map((v, i) => (v - b.min[i]).toFixed(1));
    const tris = n.getMesh().listPrimitives().reduce((a, p) => a + (p.getIndices()?.getCount() ?? 0) / 3, 0);
    console.log(`  ${n.getName()} | size ${s.join('x')} | tris ${tris} | mat ${n.getMesh().listPrimitives().map((p) => p.getMaterial()?.getName()).join(',')}`);
  }
}
