import * as THREE from 'three';
import type { WeaponDef } from './WeaponDefs';

/**
 * Per-weapon ADS calibration from the actual model geometry.
 *
 * The weapon (view-model space: muzzle towards -Z, stock towards +Z) is sampled along its
 * sight plane; the top silhouette gives the front sight (post / bead / blade) and the rear
 * sight (notch / receiver top). Peep / aperture sights are found by rasterising the rear sight
 * cross-section and searching for an enclosed hole. The gun is then tilted a few degrees so
 * rear and front sight line up and placed so that this sight line runs exactly through the
 * screen centre, with a class-specific eye relief. Optics use their own optical axis; big
 * optics (magnified / sniper) hide the view-model at full ADS and draw an eyepiece overlay.
 */
export interface SightCalib {
  /** holder position when fully aimed */
  pos: THREE.Vector3;
  /** nose-up tilt (radians) at full ADS */
  tilt: number;
  /** what the eye looks through */
  kind: 'iron' | 'reflex' | 'magnified' | 'scope';
}

const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3(), tmpP = new THREE.Vector3();

function sampleTriangles(root: THREE.Object3D, accept: (o: THREE.Object3D) => boolean, cb: (p: THREE.Vector3) => void,
  opt: { spacing?: number; maxN?: number; filter?: (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => boolean; stride?: boolean } = {}) {
  const spacing = opt.spacing ?? 0.004, maxN = opt.maxN ?? 14;
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const m4 = new THREE.Matrix4();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !accept(o)) return;
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!pos) return;
    m4.multiplyMatrices(inv, mesh.matrixWorld);
    const idx = mesh.geometry.index;
    const tri = idx ? idx.count / 3 : pos.count / 3;
    const stride = opt.stride === false ? 1 : Math.max(1, Math.floor(tri / 6000)); // cap the work on dense models
    for (let t = 0; t < tri; t += stride) {
      const a = idx ? idx.getX(t * 3) : t * 3, b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      tmpA.fromBufferAttribute(pos, a).applyMatrix4(m4);
      tmpB.fromBufferAttribute(pos, b).applyMatrix4(m4);
      tmpC.fromBufferAttribute(pos, c).applyMatrix4(m4);
      if (opt.filter && !opt.filter(tmpA, tmpB, tmpC)) continue;
      // sample the triangle densely enough for the requested resolution
      const ext = Math.max(tmpA.distanceTo(tmpB), tmpB.distanceTo(tmpC), tmpC.distanceTo(tmpA));
      const n = Math.min(maxN, Math.max(1, Math.ceil(ext / spacing)));
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
        const u = i / n, v = j / n, w = 1 - u - v;
        tmpP.set(tmpA.x * w + tmpB.x * u + tmpC.x * v, tmpA.y * w + tmpB.y * u + tmpC.y * v, tmpA.z * w + tmpB.z * u + tmpC.z * v);
        cb(tmpP);
      }
    }
  });
}

/** occupancy raster of the gun's cross-section inside a z-slab (looking down the bore) */
function slabRaster(holder: THREE.Object3D, accept: (o: THREE.Object3D) => boolean, z0: number, z1: number, x0: number, x1: number, y0: number, y1: number, cell: number) {
  const W = Math.max(1, Math.ceil((x1 - x0) / cell)), H = Math.max(1, Math.ceil((y1 - y0) / cell));
  const occ = new Uint8Array(W * H);
  const inBox = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) =>
    Math.max(a.z, b.z, c.z) >= z0 && Math.min(a.z, b.z, c.z) <= z1 && Math.max(a.x, b.x, c.x) >= x0 && Math.min(a.x, b.x, c.x) <= x1 && Math.max(a.y, b.y, c.y) >= y0 && Math.min(a.y, b.y, c.y) <= y1;
  sampleTriangles(holder, accept, (p) => {
    if (p.z < z0 || p.z > z1) return;
    const i = Math.floor((p.x - x0) / cell), j = Math.floor((p.y - y0) / cell);
    if (i >= 0 && i < W && j >= 0 && j < H) occ[j * W + i] = 1;
  }, { spacing: cell * 0.8, maxN: 160, filter: inBox, stride: false });
  return { occ, W, H, x0, y0, cell };
}

/** enclosed empty regions (holes) of a raster – flood fill from the border */
function findHoles(r: ReturnType<typeof slabRaster>) {
  const { occ, W, H } = r;
  const lab = new Int32Array(W * H); // 0 = unvisited, -1 = outside, >0 = hole id
  const stack: number[] = [];
  const flood = (start: number, id: number) => {
    const cells: number[] = [];
    stack.push(start); lab[start] = id;
    while (stack.length) {
      const k = stack.pop()!; cells.push(k);
      const x = k % W, y = (k - x) / W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nk = ny * W + nx;
        if (occ[nk] || lab[nk]) continue;
        lab[nk] = id; stack.push(nk);
      }
    }
    return cells;
  };
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) { const k = y * W + x; if (!occ[k] && !lab[k]) flood(k, -1); }
  for (let y = 0; y < H; y++) for (const x of [0, W - 1]) { const k = y * W + x; if (!occ[k] && !lab[k]) flood(k, -1); }
  const holes: { cx: number; cy: number; area: number; h: number }[] = [];
  let id = 1;
  for (let k = 0; k < W * H; k++) {
    if (occ[k] || lab[k]) continue;
    const cells = flood(k, id++);
    let sx = 0, sy = 0, ymin = 1e9, ymax = -1e9;
    for (const c of cells) { const x = c % W, y = (c - x) / W; sx += x; sy += y; ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
    holes.push({ cx: r.x0 + (sx / cells.length + 0.5) * r.cell, cy: r.y0 + (sy / cells.length + 0.5) * r.cell, area: cells.length, h: (ymax - ymin + 1) * r.cell });
  }
  return holes;
}

const cache = new Map<string, SightCalib>();

const isAttachment = (o: THREE.Object3D) => { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.name.startsWith('att_')) return p; return null; };

export function calibrateSights(holder: THREE.Object3D, def: WeaponDef, opticKind: string | null): SightCalib {
  const key = def.id + '|' + (opticKind ?? '');
  let c = cache.get(key);
  if (!c) { c = calibrate(holder, def, opticKind); cache.set(key, c); }
  return { pos: c.pos.clone(), tilt: c.tilt, kind: c.kind };
}

function calibrate(holder: THREE.Object3D, def: WeaponDef, opticKind: string | null): SightCalib {
  holder.updateMatrixWorld(true);
  const gunBox = new THREE.Box3();
  holder.traverse((o) => { if ((o as THREE.Mesh).isMesh && !isAttachment(o)) gunBox.expandByObject(o); });
  // box in holder space (holder has an identity world matrix while it is being built)
  const zMin = gunBox.min.z, zMax = gunBox.max.z, L = Math.max(1e-3, zMax - zMin);
  const xc = (gunBox.min.x + gunBox.max.x) / 2;
  const strip = Math.max(0.006, (gunBox.max.x - gunBox.min.x) * 0.12);
  const pistol = def.cls === 'pistol';
  // low-poly kit guns have no real sight channel -> sit a little further back and look over the top
  const kit = def.model.startsWith('kit:');
  const eyeRelief = pistol ? 0.36 : (def.cls === 'shotgun' ? 0.15 : def.cls === 'smg' ? 0.12 : 0.11) + (kit ? 0.1 : 0);

  // ---- optics: look along the optic's own axis
  const optic = holder.getObjectByName('att_optic');
  if (optic && opticKind) {
    const ob = new THREE.Box3().setFromObject(optic);
    // optic boxes live in world space == holder space here
    const h = ob.max.y - ob.min.y;
    const axisY = ob.min.y + h * 0.66;
    const kind: SightCalib['kind'] = opticKind === 'reddot' ? 'reflex' : opticKind === 'sniperscope' ? 'scope' : 'magnified';
    const relief = kind === 'reflex' ? 0.17 : 0.075;
    return { pos: new THREE.Vector3(-xc, -axisY, -relief - ob.max.z), tilt: 0, kind };
  }

  // ---- launcher: side-mounted optic (RPG style) -> look past the left of the tube through the sight
  if (def.cls === 'launcher') {
    return { pos: new THREE.Vector3(0.045 - gunBox.min.x, -(gunBox.max.y * 0.55), -0.2 - zMax * 0.6), tilt: 0, kind: 'magnified' };
  }

  // ---- iron sights: top silhouette along the sight plane (bins over the length)
  const N = 96;
  const pts: number[] = [];
  sampleTriangles(holder, (o) => !isAttachment(o), (p) => { if (Math.abs(p.x - xc) <= strip * 1.6) pts.push(p.x, p.y, p.z); });
  const binOf = (z: number) => Math.min(N - 1, Math.max(0, Math.floor(((zMax - z) / L) * N))); // u = 0 at the stock end (+Z), 1 at the muzzle (-Z)
  const profile = (x0: number, half: number) => {
    const t = new Float32Array(N).fill(-1e9);
    for (let k = 0; k < pts.length; k += 3) {
      if (Math.abs(pts[k] - x0) > half) continue;
      const i = binOf(pts[k + 2]);
      if (pts[k + 1] > t[i]) t[i] = pts[k + 1];
    }
    return t;
  };
  let top = profile(xc, strip);
  const peakIn = (t: Float32Array, u0: number, u1: number) => {
    let best = -1e9, bi = -1;
    for (let i = Math.floor(u0 * N); i < Math.min(N, Math.ceil(u1 * N)); i++) if (t[i] > best) { best = t[i]; bi = i; }
    return { y: best, z: zMax - ((bi + 0.5) / N) * L, bin: bi, ok: bi >= 0 && best > -1e8 };
  };
  const frontRange: [number, number] = pistol ? [0.62, 0.99] : [0.56, 0.985];
  const rearRange: [number, number] = pistol ? [0.0, 0.4] : [0.2, 0.56];
  // the sight plane is where the front sight tip actually is (models are rarely perfectly centred)
  const f0 = peakIn(top, ...frontRange);
  let xs = xc;
  if (f0.ok) {
    let sx = 0, n = 0;
    for (let k = 0; k < pts.length; k += 3) {
      if (Math.abs(binOf(pts[k + 2]) - f0.bin) > 1 || pts[k + 1] < f0.y - 0.003 || Math.abs(pts[k] - xc) > strip) continue;
      sx += pts[k]; n++;
    }
    if (n) xs = sx / n;
    const narrow = profile(xs, 0.002);
    if (peakIn(narrow, ...frontRange).ok && peakIn(narrow, ...rearRange).ok) top = narrow;
  }
  const peak = (u0: number, u1: number) => peakIn(top, u0, u1);
  const rear = peak(...rearRange);
  const front = peak(...frontRange);
  if (!rear.ok || !front.ok) {
    return { pos: new THREE.Vector3(-xs, -(gunBox.max.y + 0.002), -eyeRelief - (zMax - L * 0.35)), tilt: 0, kind: def.scope ? 'scope' : 'iron' };
  }
  if (def.scope) {
    // integral scope: the eyepiece sits roughly one tube radius below the top of the scope
    const sc = peak(0.25, 0.75);
    return { pos: new THREE.Vector3(-xs, -(sc.y - 0.02), -0.08 - (sc.z + L * 0.12)), tilt: 0, kind: 'scope' };
  }
  // ---- aperture / peep sights: rasterise the rear sight cross-section and look for an enclosed hole
  const gunOnly = (o: THREE.Object3D) => !isAttachment(o);
  const rr = slabRaster(holder, gunOnly, rear.z - 0.014, rear.z + 0.014, xc - 0.02, xc + 0.02, Math.min(rear.y, front.y) - 0.035, rear.y + 0.004, 0.0003);
  const holes = findHoles(rr).filter((h) => h.area >= 8 && h.h >= 0.0012 && h.cy > front.y - 0.03 && h.h < 0.02);
  holes.sort((a, b) => Math.abs(a.cx - xc) + Math.abs(a.cy - rear.y) * 0.5 - (Math.abs(b.cx - xc) + Math.abs(b.cy - rear.y) * 0.5));
  const hole = holes[0];
  let aperture: number | null = null;
  if (hole) {
    aperture = hole.cy;
    xs = hole.cx;
    // front post: the highest blade within ~1 mm of the aperture axis (protective ears sit further out)
    const fr = slabRaster(holder, gunOnly, front.z - 0.02, front.z + 0.02, xs - 0.012, xs + 0.012, hole.cy - 0.03, front.y + 0.004, 0.0003);
    let best = -1e9;
    for (let i = 0; i < fr.W; i++) {
      const x = fr.x0 + (i + 0.5) * fr.cell;
      if (Math.abs(x - xs) > 0.0011) continue;
      for (let j = fr.H - 1; j >= 0; j--) if (fr.occ[j * fr.W + i]) { best = Math.max(best, fr.y0 + (j + 1) * fr.cell); break; }
    }
    if (best > -1e8) front.y = best;
  }
  // tilt so that the rear sight (aperture centre or top) and the front sight tip line up
  const rearY = aperture ?? rear.y;
  let tilt = Math.atan2(rearY - front.y, rear.z - front.z);
  tilt = THREE.MathUtils.clamp(tilt, -0.03, 0.055);
  const c = Math.cos(tilt), s = Math.sin(tilt);
  const ry = rearY * c - rear.z * s, fy = front.y * c - front.z * s;
  if ((globalThis as { __calibLog?: boolean }).__calibLog) console.log('[T] calib', def.id, JSON.stringify({ holes: holes.slice(0, 3).map((h) => [h.cx, h.cy, h.h].map((v) => +v.toFixed(4))), rear: [rear.y, rear.z].map((v) => +v.toFixed(4)), front: [front.y, front.z].map((v) => +v.toFixed(4)), aperture, tilt: +tilt.toFixed(3), xs: +xs.toFixed(4) }));
  if (aperture !== null) {
    // eye centred in the peep, front post tip just below the centre of the ring
    return { pos: new THREE.Vector3(-xs, -Math.max(ry, fy + 0.0008), -Math.min(eyeRelief, 0.085) - rear.z), tilt, kind: 'iron' };
  }
  // open sights: everything between the eye and the front sight must stay below the line of sight
  // (anything behind the eye – stock, cheek riser – is out of view)
  let block = -1e9;
  const uFront = (zMax - front.z) / L;
  const zEye = rear.z + eyeRelief - 0.03;
  for (let i = 0; i < Math.floor(uFront * N); i++) {
    if (top[i] < -1e8) continue;
    const z = zMax - ((i + 0.5) / N) * L;
    if (z > zEye) continue;
    block = Math.max(block, top[i] * c - z * s);
  }
  const lineY = Math.max(fy + 0.0012, ry + 0.0008, block + 0.0006);
  const pos = new THREE.Vector3(-xs, -lineY, -eyeRelief - rear.z);
  return { pos, tilt, kind: 'iron' };
}
