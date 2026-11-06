import * as THREE from 'three';
import { Simplex, smoothstep, lerp } from './Noise';
import type { Physics } from '../physics/Physics';

export interface Flat { x: number; z: number; r: number; h?: number; blend?: number; color?: [number, number, number] }
export interface Road { pts: [number, number][]; width: number }
export interface Lake { x: number; z: number; r: number; depth: number }
export interface TerrainOptions {
  size: number;
  segments: number;
  seed: number;
  island: boolean;
  baseHeight: number;
  hills: number;
  mountains: number;
  flats?: Flat[];
  roads?: Road[];
  lakes?: Lake[];
  seaLevel?: number;
}

export type Surface = 'grass' | 'dirt' | 'stone' | 'sand' | 'asphalt' | 'snow' | 'water' | 'wood' | 'metal' | 'gravel';

/**
 * Procedural heightmap terrain (island with mountains, lakes, flattened POIs and roads)
 * rendered as one vertex-coloured mesh and mirrored as a Rapier heightfield collider.
 */
export class Terrain {
  readonly opts: TerrainOptions;
  readonly N: number;
  readonly size: number;
  readonly heights: Float32Array;
  readonly roadMask: Float32Array;
  mesh!: THREE.Mesh;
  private noise: Simplex;
  readonly seaLevel: number;

  constructor(opts: TerrainOptions) {
    this.opts = opts;
    this.N = opts.segments;
    this.size = opts.size;
    this.seaLevel = opts.seaLevel ?? 0;
    this.noise = new Simplex(opts.seed);
    const n1 = this.N + 1;
    this.heights = new Float32Array(n1 * n1);
    this.roadMask = new Float32Array(n1 * n1);
    for (let iz = 0; iz < n1; iz++) for (let ix = 0; ix < n1; ix++) {
      const x = -this.size / 2 + (ix / this.N) * this.size;
      const z = -this.size / 2 + (iz / this.N) * this.size;
      const { h, road } = this.sample(x, z);
      this.heights[iz * n1 + ix] = h;
      this.roadMask[iz * n1 + ix] = road;
    }
  }

  private distToSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
    return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
  }

  /** raw procedural height + road weight */
  sample(x: number, z: number) {
    const o = this.opts, n = this.noise;
    const half = this.size / 2;
    let h = o.baseHeight + n.fbm(x / 420, z / 420, 5) * o.hills + n.fbm(x / 90, z / 90, 3) * o.hills * 0.12;
    const m = Math.max(0, n.fbm(x / 700 + 13.7, z / 700 - 4.2, 3) + 0.1);
    h += Math.pow(n.ridge(x / 260, z / 260, 4), 2.2) * o.mountains * m;
    if (o.island) {
      const d = Math.hypot(x, z) / half + n.fbm(x / 300, z / 300, 3) * 0.12;
      const mask = 1 - smoothstep(0.62, 0.93, d);
      h = lerp(-22, h, mask);
    }
    for (const l of o.lakes ?? []) {
      const d = Math.hypot(x - l.x, z - l.z) + n.noise(x / 60, z / 60) * l.r * 0.2;
      const w = 1 - smoothstep(l.r * 0.6, l.r * 1.25, d);
      h = lerp(h, Math.min(h, this.seaLevel - l.depth), w);
    }
    let road = 0;
    for (const f of o.flats ?? []) {
      const d = Math.hypot(x - f.x, z - f.z);
      const w = 1 - smoothstep(f.r, f.r + (f.blend ?? 40), d);
      if (w > 0) h = lerp(h, f.h ?? h, w);
    }
    for (const r of o.roads ?? []) {
      let best = 1e9;
      for (let i = 0; i < r.pts.length - 1; i++) best = Math.min(best, this.distToSeg(x, z, r.pts[i][0], r.pts[i][1], r.pts[i + 1][0], r.pts[i + 1][1]));
      const w = 1 - smoothstep(r.width * 0.5, r.width * 0.5 + 1.5, best);
      road = Math.max(road, w);
    }
    return { h, road };
  }

  /** bilinear height lookup (world units) */
  getHeight(x: number, z: number) {
    const n1 = this.N + 1;
    const fx = ((x + this.size / 2) / this.size) * this.N;
    const fz = ((z + this.size / 2) / this.size) * this.N;
    if (fx < 0 || fz < 0 || fx >= this.N || fz >= this.N) return -30;
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const h00 = this.heights[iz * n1 + ix], h10 = this.heights[iz * n1 + ix + 1];
    const h01 = this.heights[(iz + 1) * n1 + ix], h11 = this.heights[(iz + 1) * n1 + ix + 1];
    // match the triangle split used by the mesh/heightfield closely enough for gameplay
    return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
  }

  getNormal(x: number, z: number, out = new THREE.Vector3()) {
    const e = this.size / this.N;
    const hl = this.getHeight(x - e, z), hr = this.getHeight(x + e, z);
    const hd = this.getHeight(x, z - e), hu = this.getHeight(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }

  roadAt(x: number, z: number) {
    const n1 = this.N + 1;
    const ix = Math.round(((x + this.size / 2) / this.size) * this.N);
    const iz = Math.round(((z + this.size / 2) / this.size) * this.N);
    if (ix < 0 || iz < 0 || ix > this.N || iz > this.N) return 0;
    return this.roadMask[iz * n1 + ix];
  }

  surfaceAt(x: number, z: number): Surface {
    const h = this.getHeight(x, z);
    if (h < this.seaLevel - 0.3) return 'water';
    if (this.roadAt(x, z) > 0.5) return 'asphalt';
    if (h < this.seaLevel + 2.2) return 'sand';
    const slope = 1 - this.getNormal(x, z).y;
    if (h > 70) return 'snow';
    if (slope > 0.3) return 'stone';
    return 'grass';
  }

  build(lowSpec: boolean) {
    const g = new THREE.PlaneGeometry(this.size, this.size, this.N, this.N);
    g.rotateX(-Math.PI / 2);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const n = this.noise;
    const c = new THREE.Color();
    const grass = new THREE.Color(0x5d8a3a), grass2 = new THREE.Color(0x7a9a45), dry = new THREE.Color(0x9a8f55);
    const sand = new THREE.Color(0xd8c690), rock = new THREE.Color(0x7d7468), snow = new THREE.Color(0xf2f4f7);
    const asphalt = new THREE.Color(0x3a3c40), seabed = new THREE.Color(0x9b8f6a);
    const nrm = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const h = this.heights[i];
      pos.setY(i, h);
      const x = pos.getX(i), z = pos.getZ(i);
      this.getNormal(x, z, nrm);
      const slope = 1 - nrm.y;
      const v = n.noise(x / 35, z / 35) * 0.5 + 0.5;
      c.copy(grass).lerp(grass2, v).lerp(dry, Math.max(0, n.noise(x / 300, z / 300)) * 0.6);
      if (h < this.seaLevel + 2.2) c.lerp(sand, 1 - smoothstep(this.seaLevel + 1, this.seaLevel + 2.2, h));
      if (h < this.seaLevel - 1) c.copy(seabed);
      c.lerp(rock, smoothstep(0.22, 0.4, slope));
      c.lerp(snow, smoothstep(62, 78, h) * (1 - smoothstep(0.35, 0.55, slope)));
      for (const f of this.opts.flats ?? []) {
        if (!f.color) continue;
        const d = Math.hypot(x - f.x, z - f.z);
        const w = 1 - smoothstep(f.r * 0.85, f.r + 6, d);
        if (w > 0) c.lerp(new THREE.Color(f.color[0], f.color[1], f.color[2]), w * 0.85);
      }
      const r = this.roadMask[i];
      if (r > 0) c.lerp(asphalt, r);
      const shade = 0.92 + n.noise(x / 6, z / 6) * 0.08;
      colors[i * 3] = c.r * shade; colors[i * 3 + 1] = c.g * shade; colors[i * 3 + 2] = c.b * shade;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    const mat = lowSpec
      ? new THREE.MeshLambertMaterial({ vertexColors: true })
      : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.receiveShadow = true;
    this.mesh.name = 'terrain';
    return this.mesh;
  }

  /** Rapier heightfield. Rapier stores heights column-major with rows along Z. */
  addToPhysics(physics: Physics) {
    const n1 = this.N + 1;
    const hf = new Float32Array(n1 * n1);
    for (let iz = 0; iz < n1; iz++) for (let ix = 0; ix < n1; ix++) hf[iz + ix * n1] = this.heights[iz * n1 + ix];
    let col = physics.addHeightfield(this.N, this.N, hf, { x: this.size, y: 1, z: this.size });
    // self-check orientation on an asymmetric probe; transpose if the driver disagrees
    const px = this.size * 0.21, pz = -this.size * 0.33;
    const hit = physics.raycast(new THREE.Vector3(px, 400, pz), new THREE.Vector3(0, -1, 0), 1000);
    if (hit && Math.abs(hit.point.y - this.getHeight(px, pz)) > 1.0) {
      physics.removeCollider(col);
      for (let iz = 0; iz < n1; iz++) for (let ix = 0; ix < n1; ix++) hf[ix + iz * n1] = this.heights[iz * n1 + ix];
      col = physics.addHeightfield(this.N, this.N, hf, { x: this.size, y: 1, z: this.size });
      console.info('[terrain] heightfield transposed to match renderer');
    }
    return col;
  }

  /** random dry land position with optional min height */
  randomLand(rng: () => number, minH = 1.5, maxSlope = 0.25, radius = this.size * 0.42) {
    for (let i = 0; i < 200; i++) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * radius;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = this.getHeight(x, z);
      if (h > minH && 1 - this.getNormal(x, z).y < maxSlope) return new THREE.Vector3(x, h, z);
    }
    return new THREE.Vector3(0, this.getHeight(0, 0), 0);
  }
}
