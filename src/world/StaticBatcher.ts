import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Merges all static meshes below a group into one mesh per material (huge draw-call
 * reduction for towns built from many small kit pieces – essential on integrated GPUs).
 */
export function batchStatic(group: THREE.Object3D): THREE.Group {
  group.updateMatrixWorld(true);
  const buckets = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[]; cast: boolean }>();
  const keep: THREE.Object3D[] = [];
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as THREE.SkinnedMesh).isSkinnedMesh || (m as THREE.InstancedMesh).isInstancedMesh || !m.visible || o.userData.noBatch) return;
    if (Array.isArray(m.material)) { keep.push(m); return; }
    let g = m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    if (!g.index) g.setIndex([...Array(g.getAttribute('position').count).keys()]);
    // keep a common attribute layout
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(name)) g.deleteAttribute(name);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const attrs = Object.keys(g.attributes).sort().join(',');
    if (g.morphAttributes && Object.keys(g.morphAttributes).length) g.morphAttributes = {};
    const key = m.material.uuid + '|' + attrs;
    let b = buckets.get(key);
    if (!b) { b = { mat: m.material, geos: [], cast: m.castShadow }; buckets.set(key, b); }
    b.geos.push(g);
    g = null as unknown as THREE.BufferGeometry;
  });
  const out = new THREE.Group();
  out.name = group.name + '_batched';
  for (const b of buckets.values()) {
    const merged = mergeGeometries(b.geos, false);
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, b.mat);
    mesh.castShadow = b.cast;
    mesh.receiveShadow = true;
    out.add(mesh);
    b.geos.forEach((g) => g.dispose());
  }
  for (const k of keep) { const c = k.clone(); k.getWorldPosition(c.position); k.getWorldQuaternion(c.quaternion); k.getWorldScale(c.scale); out.add(c); }
  return out;
}

/** Chunked instanced scatter with distance culling (trees, rocks, bushes, grass). */
export class Scatter {
  chunks: { center: THREE.Vector3; group: THREE.Group; lod: THREE.Group | null; lodDist: number }[] = [];
  root = new THREE.Group();
  constructor(public drawDistance: number) { this.root.name = 'scatter'; }

  private build(piece: THREE.Object3D, list: THREE.Matrix4[], castShadow: boolean) {
    piece.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    piece.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    const inv = new THREE.Matrix4().copy(piece.matrixWorld).invert();
    const g = new THREE.Group();
    for (const m of meshes) {
      const local = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
      const im = new THREE.InstancedMesh(m.geometry, m.material, list.length);
      const tmp = new THREE.Matrix4();
      list.forEach((t, i) => im.setMatrixAt(i, tmp.multiplyMatrices(t, local)));
      im.castShadow = castShadow; im.receiveShadow = true;
      im.computeBoundingSphere();
      g.add(im);
    }
    return g;
  }

  add(piece: THREE.Object3D, transforms: THREE.Matrix4[], chunkSize: number, castShadow = true, maxDist = this.drawDistance, lodPiece: THREE.Object3D | null = null, lodDist = 110) {
    if (!transforms.length) return;
    const byChunk = new Map<string, THREE.Matrix4[]>();
    const p = new THREE.Vector3();
    for (const t of transforms) {
      p.setFromMatrixPosition(t);
      const k = `${Math.floor(p.x / chunkSize)},${Math.floor(p.z / chunkSize)}`;
      let arr = byChunk.get(k); if (!arr) { arr = []; byChunk.set(k, arr); } arr.push(t);
    }
    for (const [k, list] of byChunk) {
      const [cx, cz] = k.split(',').map(Number);
      const g = this.build(piece, list, castShadow);
      g.userData.maxDist = maxDist;
      this.root.add(g);
      let lod: THREE.Group | null = null;
      if (lodPiece) { lod = this.build(lodPiece, list, false); lod.visible = false; this.root.add(lod); }
      this.chunks.push({ center: new THREE.Vector3((cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize), group: g, lod, lodDist: lodDist + chunkSize * 0.5 });
    }
  }

  update(cam: THREE.Vector3) {
    for (const c of this.chunks) {
      const d = Math.hypot(c.center.x - cam.x, c.center.z - cam.z);
      const vis = d < (c.group.userData.maxDist as number);
      const far = !!c.lod && d > c.lodDist;
      c.group.visible = vis && !far;
      if (c.lod) c.lod.visible = vis && far;
    }
  }
}
