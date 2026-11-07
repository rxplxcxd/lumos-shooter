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
    // keep a common attribute layout (float32 everywhere so quantised / normalised attributes merge)
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(name)) g.deleteAttribute(name);
    for (const name of Object.keys(g.attributes)) {
      const a = g.getAttribute(name) as THREE.BufferAttribute;
      if (a.array instanceof Float32Array && !(a as THREE.BufferAttribute & { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) continue;
      const f = new Float32Array(a.count * a.itemSize);
      const get = [a.getX, a.getY, a.getZ, a.getW];
      for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) f[i * a.itemSize + k] = get[k].call(a, i);
      g.setAttribute(name, new THREE.BufferAttribute(f, a.itemSize));
    }
    if (g.getAttribute('color') && g.getAttribute('color').itemSize === 4) {
      const c = g.getAttribute('color'); const f = new Float32Array(c.count * 3);
      for (let i = 0; i < c.count; i++) { f[i * 3] = c.getX(i); f[i * 3 + 1] = c.getY(i); f[i * 3 + 2] = c.getZ(i); }
      g.setAttribute('color', new THREE.BufferAttribute(f, 3));
    }
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
  chunks: { center: THREE.Vector3; group: THREE.Group; lod: THREE.Group | null; lodDist: number; lod2: THREE.Group | null; lod2Dist: number }[] = [];
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

  add(piece: THREE.Object3D, transforms: THREE.Matrix4[], chunkSize: number, castShadow = true, maxDist = this.drawDistance, lodPiece: THREE.Object3D | null = null, lodDist = 110, lod2Piece: THREE.Object3D | null = null, lod2Dist = 210) {
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
      let lod: THREE.Group | null = null, lod2: THREE.Group | null = null;
      if (lodPiece) { lod = this.build(lodPiece, list, false); lod.visible = false; this.root.add(lod); }
      if (lod2Piece) { lod2 = this.build(lod2Piece, list, false); lod2.visible = false; this.root.add(lod2); }
      this.chunks.push({ center: new THREE.Vector3((cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize), group: g, lod, lodDist: lodDist + chunkSize * 0.5, lod2, lod2Dist: lod2Dist + chunkSize * 0.5 });
    }
  }

  update(cam: THREE.Vector3) {
    for (const c of this.chunks) {
      const d = Math.hypot(c.center.x - cam.x, c.center.z - cam.z);
      const vis = d < (c.group.userData.maxDist as number);
      const far = !!c.lod && d > c.lodDist;
      const far2 = !!c.lod2 && d > c.lod2Dist;
      c.group.visible = vis && !far && !far2;
      if (c.lod) c.lod.visible = vis && far && !far2;
      if (c.lod2) c.lod2.visible = vis && far2;
    }
  }
}
