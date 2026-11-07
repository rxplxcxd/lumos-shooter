import * as THREE from 'three';
import type { GameWorld } from '../gameplay/GameWorld';
import { Terrain, type Flat, type Road, type Surface } from './Terrain';
import { Rng } from './Noise';
import { batchStatic, Scatter } from './StaticBatcher';
import { buildCity, dressPOI, lampRow } from './City';
import { Vehicle } from '../vehicles/Vehicle';
import { settings, QUALITY_PRESETS } from '../core/Settings';
import { applyWind } from './Wind';

export interface POI { id: string; name: string; x: number; z: number; r: number; h: number; color?: [number, number, number]; tier: number }
export interface MapInfo {
  name: string;
  pois: POI[];
  lootSpots: THREE.Vector3[];
  spawnPoints: THREE.Vector3[];
  teamSpawns?: THREE.Vector3[][];
  bounds: number;
  extra?: any;
}
type Progress = (p: number, label: string) => void;

const segFor = () => ({ potato: 128, low: 160, medium: 200, high: 256, ultra: 320 })[settings.data.quality];

/** helper that places third-party models into the world with colliders + batching */
export class MapBuilder {
  w: GameWorld;
  rng: Rng;
  lootSpots: THREE.Vector3[] = [];
  batch = new THREE.Group();
  scatter: Scatter;
  constructor(w: GameWorld, seed: number) {
    this.w = w; this.rng = new Rng(seed);
    this.scatter = new Scatter(QUALITY_PRESETS[settings.data.quality].drawDistance);
    w.root.add(this.scatter.root);
    w.updaters.push(() => {
      const cam = w.engine.camera.position;
      this.scatter.update(cam);
      for (const c of this.culled) { const d2 = (c.center.x - cam.x) ** 2 + (c.center.z - cam.z) ** 2; c.obj.visible = d2 < c.m2 && d2 >= c.min2; }
    });
  }

  groundY(x: number, z: number, r = 3) {
    const t = this.w.terrain;
    return Math.min(t.getHeight(x, z), t.getHeight(x + r, z), t.getHeight(x - r, z), t.getHeight(x, z + r), t.getHeight(x, z - r));
  }

  /** id = manifest id or kit:<kit>:<piece> */
  async place(id: string, x: number, z: number, yaw = 0, o: { y?: number; scale?: number; scaleV?: THREE.Vector3; collider?: 'mesh' | 'box' | 'pole' | 'none'; surface?: Surface; batch?: boolean | THREE.Group; destructible?: number; loot?: number; noGround?: boolean } = {}) {
    let obj: THREE.Object3D;
    try {
      if (id.startsWith('kit:')) { const [, kit, piece] = id.split(':'); obj = await this.w.assets.kitPiece(kit as any, piece); }
      else obj = await this.w.assets.instance(id);
    } catch (e) { console.warn('place failed', id, e); return null; }
    const size = (obj.userData.size as THREE.Vector3)?.clone() ?? new THREE.Vector3(2, 2, 2);
    if (o.scale) { obj.scale.setScalar(o.scale); size.multiplyScalar(o.scale); }
    if (o.scaleV) { obj.scale.copy(o.scaleV); size.multiply(o.scaleV); }
    const y = o.y ?? (o.noGround ? 0 : this.groundY(x, z, Math.max(size.x, size.z) * 0.4) - 0.05);
    obj.position.set(x, y, z);
    obj.rotation.y = yaw;
    obj.updateMatrixWorld(true);
    const col = o.collider ?? 'mesh';
    let collider = null;
    if (col === 'mesh') collider = this.w.physics.addStaticMesh(obj, 12000);
    else if (col === 'box') {
      const b = new THREE.Box3().setFromObject(obj);
      collider = this.w.physics.addBox(b.getCenter(new THREE.Vector3()), b.getSize(new THREE.Vector3()).multiplyScalar(0.5));
    } else if (col === 'pole') collider = this.poleCollider(obj);
    if (collider) this.w.registerSurface(collider, o.surface ?? 'stone');
    if (o.destructible && collider) { this.w.registerDestructible(collider, obj, o.destructible, o.surface ?? 'wood'); this.w.root.add(obj); }
    else if (o.batch instanceof THREE.Group) o.batch.add(obj);
    else if (o.batch !== false) this.batch.add(obj);
    else this.w.root.add(obj);
    // loot around the footprint
    for (let i = 0; i < (o.loot ?? 0); i++) {
      const a = this.rng.next() * Math.PI * 2;
      const r = Math.max(size.x, size.z) * 0.5 + 1.5 + this.rng.next() * 2;
      const lx = x + Math.cos(a) * r, lz = z + Math.sin(a) * r;
      this.lootSpots.push(new THREE.Vector3(lx, this.w.terrain.getHeight(lx, lz) + 0.05, lz));
    }
    return obj;
  }

  /** lamp posts, traffic lights, signs: collide with the post only (arms / lanterns overhead stay passable) */
  poleCollider(obj: THREE.Object3D) {
    obj.updateMatrixWorld(true);
    const all = new THREE.Box3().setFromObject(obj);
    const foot = new THREE.Box3();
    const v = new THREE.Vector3();
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const p = m.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld); if (v.y < all.min.y + 0.6) foot.expandByPoint(v); }
    });
    if (foot.isEmpty()) foot.copy(all);
    const c = foot.getCenter(new THREE.Vector3());
    const hx = THREE.MathUtils.clamp((foot.max.x - foot.min.x) / 2, 0.08, 0.45), hz = THREE.MathUtils.clamp((foot.max.z - foot.min.z) / 2, 0.08, 0.45);
    const hy = (all.max.y - all.min.y) / 2;
    return this.w.physics.addBox(new THREE.Vector3(c.x, all.min.y + hy, c.z), new THREE.Vector3(hx, hy, hz));
  }

  async vehicle(id: string, x: number, z: number, yaw = 0, yOff = 0.2) {
    const v = new Vehicle(this.w, id);
    const water = v.isWater;
    const y = water ? this.w.waterLevel + 0.3 : this.w.terrain.getHeight(x, z) + yOff;
    try { await v.init(new THREE.Vector3(x, y, z), yaw); } catch (e) { console.warn('vehicle failed', id, e); return null; }
    return v;
  }

  /** commit batched geometry to the scene */
  flush(group?: THREE.Group) {
    const b = batchStatic(group ?? this.batch);
    this.w.root.add(b);
    if (!group) this.batch = new THREE.Group();
  }

  /** batch a group and show it only between `minDist` and `maxDist` from the camera (per-block culling / LOD) */
  flushCulled(group: THREE.Group, center: THREE.Vector3, maxDist: number, minDist = 0, shadows = true) {
    const b = batchStatic(group);
    if (!shadows) b.traverse((o) => { o.castShadow = false; });
    this.w.root.add(b);
    this.culled.push({ obj: b, center: center.clone(), m2: maxDist * maxDist, min2: minDist * minDist });
    return b;
  }
  culled: { obj: THREE.Object3D; center: THREE.Vector3; m2: number; min2: number }[] = [];

  /** footprint of a model / kit piece (cached by the asset manager) */
  async sizeOf(id: string): Promise<THREE.Vector3> {
    const obj = id.startsWith('kit:') ? await this.w.assets.kitPiece(id.split(':')[1] as any, id.split(':')[2]) : await this.w.assets.instance(id);
    return ((obj.userData.size as THREE.Vector3) ?? new THREE.Vector3(10, 10, 10)).clone();
  }

  async scatterKit(names: string[], count: number, opts: { avoid: { x: number; z: number; r: number }[]; minH?: number; maxH?: number; maxSlope?: number; scale?: [number, number]; chunk?: number; collider?: number; shadow?: boolean; maxDist?: number; area?: number; center?: [number, number] }) {
    const t = this.w.terrain;
    const per = Math.ceil(count / names.length);
    for (const name of names) {
      let piece: THREE.Object3D;
      try { piece = await this.w.assets.kitPiece('nature', name); } catch { continue; }
      let lod: THREE.Object3D | null = null, lod2: THREE.Object3D | null = null;
      try { lod = await this.w.assets.kitPiece('nature_lod', name); } catch { lod = null; }
      if (/Tree|Pine|Bush/.test(name)) try { lod2 = await this.w.assets.kitPiece('nature_lod2', name); } catch { lod2 = null; }
      if (QUALITY_PRESETS[settings.data.quality].wind && !/Rock|Pebble|RockPath/.test(name)) {
        const amt = /Grass|Fern|Flower|Plant|Bush|Mushroom/.test(name) ? 0.09 : 0.012;
        for (const p of [piece, lod, lod2]) p?.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) (Array.isArray(m.material) ? m.material : [m.material]).forEach((mt) => applyWind(mt, amt)); });
      }
      const mats: THREE.Matrix4[] = [];
      let tries = 0;
      while (mats.length < per && tries++ < per * 8) {
        const area = opts.area ?? t.size * 0.46;
        const x = (opts.center?.[0] ?? 0) + (this.rng.next() * 2 - 1) * area, z = (opts.center?.[1] ?? 0) + (this.rng.next() * 2 - 1) * area;
        const h = t.getHeight(x, z);
        if (h < (opts.minH ?? 2.5) || h > (opts.maxH ?? 90)) continue;
        if (1 - t.getNormal(x, z).y > (opts.maxSlope ?? 0.3)) continue;
        if (t.roadAt(x, z) > 0.1) continue;
        if (opts.avoid.some((a) => Math.hypot(a.x - x, a.z - z) < a.r)) continue;
        const s = (opts.scale?.[0] ?? 0.8) + this.rng.next() * ((opts.scale?.[1] ?? 1.3) - (opts.scale?.[0] ?? 0.8));
        mats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, h - 0.1, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rng.next() * 6.28), new THREE.Vector3(s, s, s)));
        if (opts.collider) this.w.physics.addBox(new THREE.Vector3(x, h + 2, z), new THREE.Vector3(opts.collider * s, 2, opts.collider * s));
      }
      this.scatter.add(piece, mats, opts.chunk ?? 200, opts.shadow ?? true, opts.maxDist, lod, 80, lod2, 190);
    }
  }
}

// =====================================================================================
// Battle Royale island
// =====================================================================================
export const BR_POIS: POI[] = [
  { id: 'city', name: 'Lumos City', x: 40, z: -30, r: 150, h: 14, color: [0.42, 0.42, 0.44], tier: 3 },
  { id: 'fort', name: 'Fort Granite', x: -430, z: -360, r: 105, h: 26, color: [0.52, 0.5, 0.44], tier: 3 },
  { id: 'harbor', name: 'Port Azure', x: 560, z: 330, r: 85, h: 2.6, color: [0.48, 0.48, 0.5], tier: 2 },
  { id: 'airfield', name: 'Skyline Airfield', x: -330, z: 390, r: 75, h: 10, color: [0.45, 0.46, 0.42], tier: 2 },
  { id: 'farm', name: 'Greenfield Farms', x: 390, z: -390, r: 90, h: 16, color: [0.55, 0.5, 0.32], tier: 1 },
  { id: 'factory', name: 'Ironworks', x: -540, z: 40, r: 85, h: 15, color: [0.44, 0.41, 0.39], tier: 2 },
  { id: 'suburbs', name: 'Maple Heights', x: 170, z: 380, r: 95, h: 9, tier: 1 },
  { id: 'gas', name: 'Route 9', x: 260, z: -170, r: 30, h: 13, color: [0.4, 0.4, 0.42], tier: 1 },
];

export async function buildBRMap(w: GameWorld, seed: number, progress: Progress): Promise<MapInfo> {
  const pois = BR_POIS;
  const flats: Flat[] = pois.map((p) => ({ x: p.x, z: p.z, r: p.r, h: p.h, blend: 50, color: p.color }));
  // runway
  for (let x = -470; x <= -190; x += 28) flats.push({ x, z: 390, r: 18, h: 10, blend: 30, color: [0.32, 0.32, 0.34] });
  const c = pois[0];
  // city park lawn (block south-east of the plaza)
  flats.push({ x: c.x + 68, z: c.z + 68, r: 23.4, square: true, grass: true, color: [0.25, 0.43, 0.17] });
  // city street grid (kit roads are laid on top; the terrain roads flatten and pave underneath)
  const offs = [-102, -34, 34, 102], ext = 140;
  const exits: [number, number][] = [];
  for (const o of offs) exits.push([c.x - ext, c.z + o], [c.x + ext, c.z + o], [c.x + o, c.z - ext], [c.x + o, c.z + ext]);
  // country roads start at the nearest city exit instead of cutting through the blocks
  const roads: Road[] = pois.slice(1).map((p) => {
    let best = exits[0], bd = 1e12;
    for (const e of exits) { const d = (e[0] - p.x) ** 2 + (e[1] - p.z) ** 2; if (d < bd) { bd = d; best = e; } }
    // leave the city straight along the street axis first, then bend towards the POI
    const out: [number, number] = Math.abs(best[0] - c.x) >= ext - 1 ? [best[0] + Math.sign(best[0] - c.x) * 40, best[1]] : [best[0], best[1] + Math.sign(best[1] - c.z) * 40];
    return { pts: [best, out, [(out[0] + p.x) / 2 + (p.z - out[1]) * 0.1, (out[1] + p.z) / 2 - (p.x - out[0]) * 0.1], [p.x, p.z]] as [number, number][], width: 9 };
  });
  for (const off of offs) {
    roads.push({ pts: [[c.x + off, c.z - ext], [c.x + off, c.z + ext]], width: 14 });
    roads.push({ pts: [[c.x - ext, c.z + off], [c.x + ext, c.z + off]], width: 14 });
  }
  roads.push({ pts: [[-470, 390], [-190, 390]], width: 24 });
  roads.push({ pts: [[pois[6].x - 70, pois[6].z], [pois[6].x + 70, pois[6].z]], width: 9 });
  progress(0.05, 'Terrain');
  const terrain = new Terrain({ size: 1600, segments: segFor(), seed, island: true, baseHeight: 10, hills: 22, mountains: 75, flats, roads, lakes: [{ x: -160, z: -150, r: 85, depth: 8 }] });
  const wr = new Rng(seed * 7 + 3);
  const lowQ0 = QUALITY_PRESETS[settings.data.quality].lowSpecMaterials;
  const weather = lowQ0 ? 'clear' : wr.pick(['clear', 'clear', 'cloudy', 'cloudy', 'overcast', 'drizzle', 'rain', 'fog', 'storm'] as const);
  // late drops fly into dusk: the city lights come on during the match
  // dynamic weather follows a seeded forecast (identical for everybody in an online match)
  await w.init(terrain, { time: lowQ0 ? 13 : 7 + wr.next() * 11, weather, timeSpeed: lowQ0 ? 0 : 0.004, dynamicWeather: !lowQ0, seed });
  const mb = new MapBuilder(w, seed);
  const R = mb.rng;
  const lowQ = lowQ0;

  progress(0.15, 'Lumos City');
  const city = await buildCity(mb, c.x, c.z, c.h, offs, ext, R);
  for (const l of city.lamps) w.lights?.add(l);
  for (const p of city.parking) {
    await mb.vehicle(R.pick(['car_cop', 'car_police', 'car_taxi', 'car_sedan', 'car_sport', 'car_suv', 'car_muscle', 'car_hatch', 'car_classic', 'motorcycle', 'hovercar']), p.x, p.z, p.yaw);
  }
  await mb.vehicle('bus', c.x - 34 + 3, c.z + 68, 0);

  progress(0.32, 'Fort Granite');
  const f = pois[1];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    await mb.place('env_bunker', f.x + Math.cos(a) * 80, f.z + Math.sin(a) * 80, -a + Math.PI / 2, { surface: 'stone', y: f.h - 0.1 });
  }
  await mb.place('env_warehouse', f.x - 30, f.z, 0, { surface: 'metal', loot: 6, y: f.h - 0.05 });
  await mb.place('env_warehouse', f.x + 30, f.z + 20, Math.PI / 2, { surface: 'metal', loot: 6, y: f.h - 0.05 });
  for (let i = 0; i < 14; i++) await mb.place('env_sandbag', f.x + R.range(-60, 60), f.z + R.range(-60, 60), R.next() * 6, { collider: 'box', surface: 'dirt', scale: 2.4, y: f.h });
  for (let i = 0; i < 6; i++) await mb.place('env_barrier', f.x + R.range(-55, 55), f.z + R.range(-55, 55), R.next() * 6, { collider: 'box', surface: 'metal', y: f.h });
  for (let i = 0; i < 6; i++) await mb.place('item_crate', f.x + R.range(-40, 40), f.z + R.range(-40, 40), R.next() * 6, { collider: 'box', surface: 'wood', destructible: 120, scale: 1.4, loot: 1, y: f.h });
  mb.flush();
  await dressPOI(mb, f.x, f.z, 60, [{ id: 'cityprops:Light', n: 6, lamp: 4.3 }, { id: 'cityprops:TarpCrates', n: 4, surface: 'wood' }, { id: 'cityprops:pallet1', n: 5, mass: 20 }, { id: 'cityprops:Utility', n: 2 }], R, 0.3);
  await mb.vehicle('tank', f.x, f.z - 40, 0);
  await mb.vehicle('apc', f.x - 15, f.z + 45, Math.PI);
  await mb.vehicle('jeep', f.x + 50, f.z - 10, Math.PI / 2);
  await mb.vehicle('heli_apache', f.x + 10, f.z + 55, 0, 0.5);
  await mb.vehicle('heli_huey', f.x + 45, f.z + 45, -Math.PI / 4, 0.5);

  progress(0.46, 'Port Azure');
  const h = pois[2];
  await mb.place('env_warehouses', h.x - 10, h.z - 10, Math.PI / 4, { surface: 'metal', loot: 8, y: h.h - 0.05 });
  await mb.place('env_warehouse', h.x + 25, h.z - 40, Math.PI / 4, { surface: 'metal', loot: 4, y: h.h - 0.05 });
  await mb.place('kit:euro_b:Station', h.x - 38, h.z + 30, Math.PI / 4 + Math.PI, { surface: 'stone', loot: 6, y: h.h - 0.05 });
  for (let i = 0; i < 10; i++) await mb.place('env_boxes', h.x + R.range(-45, 45), h.z + R.range(-45, 45), R.next() * 6, { collider: 'box', surface: 'wood', destructible: 80, scale: 1.3, y: h.h });
  mb.flush();
  await dressPOI(mb, h.x, h.z, 70, [{ id: 'cityprops:Light', n: 7, lamp: 4.3 }, { id: 'cityprops:pallet1', n: 8, mass: 20 }, { id: 'cityprops:pallet2', n: 6, mass: 20 }, { id: 'cityprops:TarpCrates', n: 5, surface: 'wood' },
    { id: 'cityprops:Dumpster', n: 3, mass: 260 }, { id: 'cityprops:Utility', n: 2 }, { id: 'cityprops:TrashCanLarge', n: 4, mass: 30 }, { id: 'city:Prop_Bollard', n: 10 }], R, 0.25);
  const shore = (dist: number, ang: number) => [h.x + Math.cos(ang) * dist, h.z + Math.sin(ang) * dist] as const;
  let [sx, sz] = shore(120, 0.75); await mb.vehicle('speedboat', sx, sz, 0.75);
  [sx, sz] = shore(115, 0.45); await mb.vehicle('boat', sx, sz, 0.4);
  [sx, sz] = shore(110, 1.05); await mb.vehicle('jetski', sx, sz, 1.0);
  [sx, sz] = shore(118, 1.25); await mb.vehicle('jetski', sx, sz, 1.2);
  [sx, sz] = shore(160, 0.6); await mb.vehicle('submarine', sx, sz, 0.6);
  await mb.vehicle('truck', h.x - 40, h.z + 20, Math.PI / 4);

  progress(0.56, 'Skyline Airfield');
  const a = pois[3];
  await mb.place('env_warehouse', a.x, a.z - 50, 0, { surface: 'metal', loot: 6, y: a.h - 0.05 });
  await mb.place('env_warehouse', a.x + 40, a.z - 50, 0, { surface: 'metal', loot: 4, y: a.h - 0.05 });
  await mb.place('kit:euro_a:GlassArcade', a.x - 45, a.z - 42, 0, { surface: 'stone', loot: 4, y: a.h - 0.05 });
  mb.flush();
  await dressPOI(mb, a.x, a.z - 40, 45, [{ id: 'cityprops:Light', n: 5, lamp: 4.3 }, { id: 'cityprops:TarpCrates', n: 3, surface: 'wood' }, { id: 'cityprops:pallet2', n: 4, mass: 20 }, { id: 'cityprops:Utility', n: 2 }], R, 0.2);
  for (let x = -460; x <= -200; x += 26) for (const dz of [-12.5, 12.5]) w.lights?.add(new THREE.Vector3(x, terrain.getHeight(x, 390 + dz) + 0.6, 390 + dz));
  await mb.vehicle('plane_prop', -440, 390, Math.PI / 2, 0.3);
  await mb.vehicle('plane_prop', a.x + 10, a.z - 25, Math.PI / 2, 0.3);
  await mb.vehicle('jet_f16', -400, 405, Math.PI / 2, 0.4);
  await mb.vehicle('heli_small', a.x + 60, a.z - 20, 0, 0.5);
  await mb.vehicle('golfcart', a.x - 20, a.z - 30, 0);

  progress(0.64, 'Greenfield Farms');
  const fa = pois[4];
  for (const [dx, dz] of [[-30, -20], [25, -30], [-20, 35]]) await mb.place('env_house', fa.x + dx, fa.z + dz, R.next() * 6, { surface: 'wood', loot: 4 });
  await mb.place('env_warehouse', fa.x + 30, fa.z + 30, 0.3, { surface: 'wood', loot: 5 });
  await mb.place('kit:euro_b:Mansion', fa.x - 58, fa.z + 8, Math.PI / 2, { surface: 'stone', loot: 6 });
  mb.flush();
  await dressPOI(mb, fa.x, fa.z, 55, [{ id: 'cityprops:Light', n: 3, lamp: 4.3 }, { id: 'cityprops:TarpCrates', n: 4, surface: 'wood' }, { id: 'cityprops:pallet1', n: 6, mass: 20 }, { id: 'cityprops:TrashCanCap', n: 3, mass: 30 }], R, 0.25);
  await mb.vehicle('tractor', fa.x, fa.z, 0);
  await mb.vehicle('car_hatch', fa.x + 45, fa.z - 5, 1);
  await mb.vehicle('bicycle', fa.x - 40, fa.z, 0.5);

  progress(0.7, 'Ironworks');
  const fc = pois[5];
  await mb.place('env_factory', fc.x, fc.z, 0, { surface: 'stone', loot: 8 });
  await mb.place('env_warehouses', fc.x + 15, fc.z + 50, Math.PI / 2, { surface: 'metal', loot: 6 });
  for (let i = 0; i < 8; i++) await mb.place('env_boxes', fc.x + R.range(-45, 45), fc.z + R.range(-45, 45), R.next() * 6, { collider: 'box', surface: 'wood', destructible: 80, scale: 1.3 });
  mb.flush();
  await dressPOI(mb, fc.x, fc.z, 65, [{ id: 'cityprops:Light', n: 6, lamp: 4.3 }, { id: 'cityprops:Dumpster', n: 4, mass: 260 }, { id: 'cityprops:pallet1', n: 8, mass: 20 }, { id: 'cityprops:pallet2', n: 6, mass: 20 },
    { id: 'cityprops:TarpCrates', n: 4, surface: 'wood' }, { id: 'cityprops:Utility', n: 3 }, { id: 'cityprops:TrashCommercial', n: 4, mass: 30 }], R, 0.3);
  await mb.vehicle('truck', fc.x - 40, fc.z - 30, 0);
  await mb.vehicle('car_suv', fc.x + 45, fc.z - 30, 2);

  progress(0.76, 'Maple Heights');
  const su = pois[6];
  for (let i = 0; i < 8; i++) {
    const dx = -60 + (i % 4) * 40, dz = i < 4 ? -22 : 22;
    await mb.place('env_house', su.x + dx, su.z + dz, i < 4 ? 0 : Math.PI, { surface: 'wood', loot: 3 });
  }
  await mb.place('kit:euro_b:Villa', su.x + 8, su.z + 62, Math.PI, { surface: 'stone', loot: 5 });
  mb.flush();
  await lampRow(mb, su.x - 75, su.z, su.x + 75, su.z, 6.2, 30);
  {
    const yard = new THREE.Group();
    for (let i = 0; i < 8; i++) {
      const dx = -60 + (i % 4) * 40, side = i < 4 ? -1 : 1;
      const x = su.x + dx + 5, z = su.z + side * 8.5;
      await mb.place('kit:cityprops:PostBox', x, z, side < 0 ? 0 : Math.PI, { collider: 'box', surface: 'metal', batch: yard, scale: 0.85 });
      await mb.w.knock?.add('cityprops', R.pick(['TrashCanLarge', 'TrashCanSmall']), new THREE.Vector3(x + 1.6, terrain.getHeight(x + 1.6, z), z), R.next() * 6, 1, 25);
      for (const tx of [-9, 9]) await mb.place(`kit:nature:${R.pick(['CommonTree_1', 'CommonTree_2', 'CommonTree_4'])}`, su.x + dx + tx, su.z + side * 13, R.next() * 6, { collider: 'box', surface: 'wood', batch: yard, scale: 0.7 + R.next() * 0.3 });
      await mb.place(`kit:nature:${R.pick(['Bush_Common', 'Bush_Common_Flowers'])}`, su.x + dx - 4, su.z + side * 10, R.next() * 6, { collider: 'none', batch: yard });
    }
    mb.flush(yard);
  }
  for (const [dx, id] of [[-50, 'car_sedan'], [-10, 'car_sport2'], [30, 'motorcycle'], [60, 'car_roadster']] as [number, string][]) await mb.vehicle(id, su.x + dx, su.z, Math.PI / 2);

  progress(0.8, 'Route 9');
  const g = pois[7];
  await mb.place('env_building_shop', g.x, g.z, 0, { surface: 'stone', loot: 4 });
  await mb.place('env_vending', g.x + 8, g.z + 6, Math.PI, { collider: 'box', surface: 'metal' });
  mb.flush();
  await dressPOI(mb, g.x, g.z, 24, [{ id: 'cityprops:Light', n: 4, lamp: 4.3 }, { id: 'cityprops:TrashCommercial', n: 3, mass: 30 }, { id: 'cityprops:Dumpster', n: 1, mass: 260 }, { id: 'cityprops:Utility', n: 1 }], R, 0.45);
  await mb.vehicle('car_taxi', g.x + 14, g.z - 8, 0.4);
  await mb.vehicle('motorcycle', g.x - 12, g.z - 6, 2.2);
  // lake craft
  await mb.vehicle('boat', -160, -150, 0);
  await mb.vehicle('jetski', -140, -170, 1);
  // random roadside vehicles across the island
  for (let i = 0; i < 12; i++) {
    const r = R.pick(roads.slice(0, 7));
    const t = R.next();
    const p0 = r.pts[0], p1 = r.pts[r.pts.length - 1];
    const x = p0[0] + (p1[0] - p0[0]) * t + R.range(-6, 6), z = p0[1] + (p1[1] - p0[1]) * t + R.range(-6, 6);
    if (terrain.getHeight(x, z) < 2) continue;
    await mb.vehicle(R.pick(['car_sedan', 'car_hatch', 'jeep', 'motorcycle', 'bicycle', 'hovercar', 'car_muscle', 'golfcart']), x, z, R.next() * 6);
  }

  progress(0.86, 'Vegetation');
  const dens = QUALITY_PRESETS[settings.data.quality].treeDensity;
  const avoid = [...pois.map((p) => ({ x: p.x, z: p.z, r: p.r + 10 })), { x: -330, z: 390, r: 160 }];
  const trees = lowQ ? ['CommonTree_3', 'CommonTree_5', 'Pine_4'] : ['Pine_1', 'Pine_3', 'Pine_4', 'CommonTree_1', 'CommonTree_3', 'CommonTree_5', 'DeadTree_1'];
  await mb.scatterKit(trees, Math.round(2400 * dens), { avoid, collider: 0.35, scale: [0.9, 1.6] });
  await mb.scatterKit(['Rock_Medium_1', 'Rock_Medium_2', 'Rock_Medium_3'], Math.round(500 * dens), { avoid, collider: 1.0, scale: [1, 3.5], maxSlope: 0.6, minH: 1 });
  await mb.scatterKit(['Bush_Common', 'Bush_Common_Flowers', 'Fern_1'], Math.round(900 * dens), { avoid, scale: [0.8, 1.6], shadow: false });
  if (QUALITY_PRESETS[settings.data.quality].grass) await mb.scatterKit(['Grass_Common_Tall', 'Grass_Wispy_Tall', 'Flower_3_Group'], 6000, { avoid, scale: [0.8, 1.4], shadow: false, chunk: 100, maxDist: 140 });

  if (w.ambient) {
    await w.ambient.addFlock(new THREE.Vector3(640, 0, 400), 70, 22, 'seagulls', 2);
    await w.ambient.addFlock(new THREE.Vector3(-160, 0, -150), 50, 18, 'seagulls', 1);
    await w.ambient.addFlock(new THREE.Vector3(-560, 0, 300), 60, 20, 'seagulls', 1);
    await w.ambient.addFlock(new THREE.Vector3(-430, 0, -360), 40, 35, 'raven', 3);
  }
  progress(0.94, 'Loot');
  // extra open-field loot near POIs
  for (const p of pois) for (let i = 0; i < 4 + p.tier * 2; i++) {
    const ang = R.next() * 6.28, rr = R.next() * p.r;
    const x = p.x + Math.cos(ang) * rr, z = p.z + Math.sin(ang) * rr;
    mb.lootSpots.push(new THREE.Vector3(x, terrain.getHeight(x, z) + 0.05, z));
  }
  await w.lights?.build();
  const spawnPoints = pois.map((p) => new THREE.Vector3(p.x, p.h + 1, p.z));
  return { name: 'Lumos Island', pois, lootSpots: mb.lootSpots, spawnPoints, bounds: 760, extra: { builder: mb } };
}

// =====================================================================================
// Multiplayer arena (compact 3-lane)
// =====================================================================================
export async function buildArena(w: GameWorld, seed: number, progress: Progress, night = false): Promise<MapInfo> {
  const flats: Flat[] = [{ x: 0, z: 0, r: 120, h: 5, blend: 40, color: [0.45, 0.44, 0.4] }];
  const roads: Road[] = [{ pts: [[0, -110], [0, 110]], width: 10 }, { pts: [[-60, 0], [60, 0]], width: 8 }];
  const terrain = new Terrain({ size: 420, segments: 96, seed, island: false, baseHeight: 6, hills: 10, mountains: 30, flats, roads });
  await w.init(terrain, { time: night ? 23 : 16.5, weather: night ? 'clear' : 'cloudy', seed });
  const mb = new MapBuilder(w, seed);
  const R = mb.rng;
  progress(0.3, 'Crossroads');
  const y = 4.95;
  // lane-defining buildings
  for (const [x, z, id, yaw] of [[-32, -20, 'kit:city:Building_Medium_2_001', 0], [32, 20, 'kit:city:Building_Medium_2_001', Math.PI], [-36, 34, 'kit:city:Building_Small_1', Math.PI / 2], [36, -34, 'kit:city:Building_Small_1', -Math.PI / 2], [-70, -60, 'env_warehouse', 0], [70, 60, 'env_warehouse', Math.PI], [0, 0, 'env_building_shop', 0]] as [number, number, string, number][]) {
    await mb.place(id, x, z, yaw, { surface: 'stone', y });
  }
  // cover
  for (let i = 0; i < 26; i++) {
    const lane = R.pick([-52, -18, 18, 52]);
    const x = lane + R.range(-6, 6), z = R.range(-85, 85);
    const id = R.pick(['env_sandbag', 'env_barrier', 'item_crate', 'env_boxes']);
    await mb.place(id, x, z, R.next() * 6, { collider: 'box', surface: id === 'item_crate' || id === 'env_boxes' ? 'wood' : 'metal', scale: id === 'env_sandbag' ? 2.6 : 1.4, destructible: id === 'env_boxes' ? 90 : undefined, y });
  }
  for (const [x, z] of [[-20, -70], [22, 72], [-60, 10], [60, -10]]) { await mb.place('kit:street:Streetlight_Double', x, z, 0, { scale: 5.5, collider: 'pole', y, surface: 'metal' }); w.lights?.add(new THREE.Vector3(x, y + 5.8, z)); }
  mb.flush();
  // main street: lamps both sides, bins / dumpsters / benches that react to fire and explosions
  await lampRow(mb, 0, -100, 0, 100, 7.5, 33, 'street:Streetlight_Single', 1.02, 5.5);
  await dressPOI(mb, 0, 0, 95, [{ id: 'cityprops:TrashCanLarge', n: 8, mass: 30 }, { id: 'cityprops:TrashCommercial', n: 6, mass: 30 }, { id: 'cityprops:Dumpster', n: 5, mass: 260 },
    { id: 'cityprops:pallet1', n: 6, mass: 20 }, { id: 'cityprops:TarpCrates', n: 4, surface: 'wood' }, { id: 'cityprops:FireHydrant', n: 4, scale: 0.8 }, { id: 'cityprops:Utility', n: 3 },
    { id: 'cityprops:ParkBenchLong', n: 4, surface: 'wood' }, { id: 'cityprops:PostBox', n: 2 }], R, 0.12);
  await mb.place('kit:cityprops:BusStop', 7, 22, -Math.PI / 2, { y, scale: 0.85, collider: 'mesh', surface: 'metal' });
  mb.flush();
  // static car wrecks as cover
  for (const [x, z, id, yaw] of [[8, -40, 'car_sedan', 0.4], [-10, 44, 'car_taxi', -0.3], [-50, -30, 'car_suv', 1.6], [48, 28, 'car_cop', 1.2]] as [number, number, string, number][]) {
    await mb.place(id, x, z, yaw, { collider: 'box', surface: 'metal', y });
  }
  mb.flush();
  progress(0.7, 'Vegetation');
  await mb.scatterKit(['Pine_2', 'CommonTree_2', 'CommonTree_4'], 160, { avoid: [{ x: 0, z: 0, r: 115 }], collider: 0.35, scale: [1, 1.5], area: 200 });
  await mb.scatterKit(['Bush_Common', 'Grass_Common_Tall'], 300, { avoid: [{ x: 0, z: 0, r: 100 }], scale: [0.8, 1.4], shadow: false, area: 200 });
  if (w.ambient) await w.ambient.addFlock(new THREE.Vector3(0, 0, 0), 60, 30, 'seagulls', 1);
  await w.lights?.build();
  // invisible boundary walls
  for (const [x, z, hx, hz] of [[0, -112, 120, 2], [0, 112, 120, 2], [-112, 0, 2, 120], [112, 0, 2, 120]]) w.physics.addBox(new THREE.Vector3(x, 20, z), new THREE.Vector3(hx, 40, hz));
  const teamA: THREE.Vector3[] = [], teamB: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) { teamA.push(new THREE.Vector3(-45 + i * 13, y + 0.5, -98)); teamB.push(new THREE.Vector3(-45 + i * 13, y + 0.5, 98)); }
  const all = [...teamA, ...teamB, ...Array.from({ length: 10 }, () => new THREE.Vector3(R.range(-80, 80), y + 0.5, R.range(-80, 80)))];
  return { name: 'Crossroads', pois: [{ id: 'arena', name: 'Crossroads', x: 0, z: 0, r: 110, h: y, tier: 1 }], lootSpots: [], spawnPoints: all, teamSpawns: [teamA, teamB], bounds: 108 };
}

// =====================================================================================
// Zombies: walled outpost with purchasable doors (round based)
// =====================================================================================
export interface ZRoom { id: string; name: string; x: number; z: number; hw: number; hd: number; open: boolean; spawns: THREE.Vector3[] }
export interface ZDoor { id: string; cost: number; x: number; z: number; horizontal: boolean; rooms: [string, string]; obj: THREE.Object3D | null; collider: any; open: boolean; debris: boolean }

export async function buildZombieOutpost(w: GameWorld, seed: number, progress: Progress): Promise<MapInfo> {
  const flats: Flat[] = [{ x: 0, z: 0, r: 70, h: 3, blend: 30, color: [0.4, 0.38, 0.34] }];
  const terrain = new Terrain({ size: 360, segments: 80, seed, island: false, baseHeight: 4, hills: 8, mountains: 20, flats });
  await w.init(terrain, { time: 21.5, weather: 'fog', seed });
  const mb = new MapBuilder(w, seed);
  const y = 2.95;
  const rooms: ZRoom[] = [
    { id: 'spawn', name: 'Kommandoposten', x: 0, z: 0, hw: 13, hd: 13, open: true, spawns: [] },
    { id: 'lab', name: 'Labor', x: 0, z: 28, hw: 11, hd: 9, open: false, spawns: [] },
    { id: 'barracks', name: 'Kaserne', x: 26, z: 0, hw: 9, hd: 11, open: false, spawns: [] },
    { id: 'power', name: 'Generatorraum', x: -26, z: 0, hw: 9, hd: 11, open: false, spawns: [] },
    { id: 'yard', name: 'Südhof', x: 0, z: -28, hw: 11, hd: 9, open: false, spawns: [] },
  ];
  progress(0.3, 'Outpost walls');
  // modular walls from the CC0 city kit brick tiles (2 m x 1 m) – instanced
  const brick = await w.assets.kitPiece('city', 'Brick_Plain_1');
  const tiles: THREE.Matrix4[] = [];
  const doorGaps: { x: number; z: number }[] = [{ x: 0, z: 13 }, { x: 13, z: 0 }, { x: -13, z: 0 }, { x: 0, z: -13 }];
  const wallSeg = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const yaw = Math.atan2(z1 - z0, x1 - x0);
    const n = Math.round(len / 2);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
      if (doorGaps.some((d) => Math.hypot(d.x - x, d.z - z) < 1.9)) continue;
      for (let k = 0; k < 4; k++) tiles.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y + k, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw), new THREE.Vector3(1, 1, 1)));
    }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const col = w.physics.addBox(new THREE.Vector3(cx, y + 2, cz), new THREE.Vector3(len / 2, 2.2, 0.25), -yaw);
    w.registerSurface(col, 'stone');
  };
  for (const r of rooms) {
    const x0 = r.x - r.hw, x1 = r.x + r.hw, z0 = r.z - r.hd, z1 = r.z + r.hd;
    // split walls around door gaps by building them in halves when needed
    const seg = (ax: number, az: number, bx: number, bz: number) => {
      const gap = doorGaps.find((d) => (ax === bx ? Math.abs(d.x - ax) < 0.5 && d.z > Math.min(az, bz) && d.z < Math.max(az, bz) : Math.abs(d.z - az) < 0.5 && d.x > Math.min(ax, bx) && d.x < Math.max(ax, bx)));
      if (!gap) return wallSeg(ax, az, bx, bz);
      if (ax === bx) { wallSeg(ax, Math.min(az, bz), ax, gap.z - 1.8); wallSeg(ax, gap.z + 1.8, ax, Math.max(az, bz)); }
      else { wallSeg(Math.min(ax, bx), az, gap.x - 1.8, az); wallSeg(gap.x + 1.8, az, Math.max(ax, bx), az); }
    };
    seg(x0, z0, x1, z0); seg(x0, z1, x1, z1); seg(x0, z0, x0, z1); seg(x1, z0, x1, z1);
    // zombie windows: spawn points just outside the outer walls
    for (let i = 0; i < 3; i++) {
      const side = i % 4;
      const p = side === 0 ? new THREE.Vector3(r.x + (i - 1) * 6, y, r.z + r.hd + 6) : side === 1 ? new THREE.Vector3(r.x + r.hw + 6, y, r.z + (i - 1) * 6) : new THREE.Vector3(r.x - r.hw - 6, y, r.z + (i - 1) * 6);
      r.spawns.push(p);
    }
  }
  mb.scatter.add(brick, tiles, 1000, true, 1e6);
  // floor tiles
  const floor = await w.assets.kitPiece('city', 'Floor_4x4');
  const ft: THREE.Matrix4[] = [];
  for (const r of rooms) for (let x = r.x - r.hw + 2; x < r.x + r.hw; x += 4) for (let z = r.z - r.hd + 2; z < r.z + r.hd; z += 4) ft.push(new THREE.Matrix4().makeTranslation(x, y + 0.02, z));
  mb.scatter.add(floor, ft, 1000, false, 1e6);

  progress(0.6, 'Machines');
  const doors: ZDoor[] = [
    { id: 'd_lab', cost: 750, x: 0, z: 13, horizontal: true, rooms: ['spawn', 'lab'], obj: null, collider: null, open: false, debris: false },
    { id: 'd_bar', cost: 750, x: 13, z: 0, horizontal: false, rooms: ['spawn', 'barracks'], obj: null, collider: null, open: false, debris: false },
    { id: 'd_pow', cost: 1000, x: -13, z: 0, horizontal: false, rooms: ['spawn', 'power'], obj: null, collider: null, open: false, debris: false },
    { id: 'd_yard', cost: 1250, x: 0, z: -13, horizontal: true, rooms: ['spawn', 'yard'], obj: null, collider: null, open: false, debris: true },
  ];
  for (const d of doors) {
    const id = d.debris ? 'env_boxes' : 'env_door';
    const obj = await mb.place(id, d.x, d.z, d.horizontal ? 0 : Math.PI / 2, { collider: 'none', batch: false, y, scale: d.debris ? 2.2 : 1.6 });
    d.obj = obj;
    d.collider = w.physics.addBox(new THREE.Vector3(d.x, y + 1.5, d.z), d.horizontal ? new THREE.Vector3(1.9, 1.6, 0.4) : new THREE.Vector3(0.4, 1.6, 1.9));
    w.registerSurface(d.collider, 'wood');
  }
  const machines: { kind: string; x: number; z: number; yaw: number; obj: THREE.Object3D | null }[] = [
    { kind: 'quickrevive', x: -10, z: -10, yaw: Math.PI / 4, obj: null },
    { kind: 'juggernog', x: 32, z: 8, yaw: -Math.PI / 2, obj: null },
    { kind: 'speedcola', x: 8, z: 34, yaw: Math.PI, obj: null },
    { kind: 'staminup', x: -32, z: 8, yaw: Math.PI / 2, obj: null },
    { kind: 'doubletap', x: -8, z: -34, yaw: 0, obj: null },
    { kind: 'mysterybox', x: -6, z: 32, yaw: 0, obj: null },
    { kind: 'packapunch', x: 6, z: -33, yaw: 0, obj: null },
    { kind: 'power', x: -32, z: -8, yaw: Math.PI / 2, obj: null },
    { kind: 'trap', x: 0, z: -20, yaw: 0, obj: null },
  ];
  for (const m of machines) {
    const id = m.kind === 'mysterybox' ? 'env_mysterybox' : m.kind === 'packapunch' ? 'item_supply' : m.kind === 'power' || m.kind === 'trap' ? 'env_barrier' : m.kind === 'juggernog' || m.kind === 'doubletap' ? 'env_vending' : 'env_vending2';
    m.obj = await mb.place(id, m.x, m.z, m.yaw, { collider: 'box', surface: 'metal', batch: false, y, scale: m.kind === 'packapunch' ? 2 : 1 });
  }
  // wall-buys
  const wallbuys = [{ weapon: 'viper', x: 12.3, z: -6, yaw: -Math.PI / 2 }, { weapon: 'wasp', x: -12.3, z: 6, yaw: Math.PI / 2 }, { weapon: 'brawler', x: 34.5, z: -6, yaw: -Math.PI / 2 }, { weapon: 'kestrel', x: -6, z: 36.5, yaw: Math.PI }, { weapon: 'longbow', x: 10.5, z: -36.5, yaw: 0 }];
  // easter-egg radios
  const radios = [new THREE.Vector3(30, y, -9), new THREE.Vector3(-30, y, 9), new THREE.Vector3(9, y, 33)];
  for (const r of radios) await mb.place('item_ammo', r.x, r.z, 0, { collider: 'none', batch: false, y: y + 0.9, scale: 0.6 });
  mb.flush();
  // surroundings: dead forest and fog
  await mb.scatterKit(['Pine_5', 'CommonTree_5', 'DeadTree_3'], 120, { avoid: [{ x: 0, z: 0, r: 55 }], collider: 0.4, scale: [0.9, 1.5], area: 160 });
  // warm work lights inside the outpost rooms (cheap: 5 point lights)
  for (const r of rooms) {
    const l = new THREE.PointLight(r.id === 'spawn' ? 0xffc27a : 0xff9a5a, 28, 30, 1.6);
    l.position.set(r.x, y + 5, r.z);
    w.root.add(l);
  }
  await mb.scatterKit(['Rock_Medium_1', 'Rock_Medium_3', 'Mushroom_Common'], 120, { avoid: [{ x: 0, z: 0, r: 50 }], scale: [1, 2.5], area: 160 });
  if (w.ambient) await w.ambient.addFlock(new THREE.Vector3(0, y, 0), 35, 14, 'raven', 5);
  return {
    name: 'Outpost 9', pois: [{ id: 'outpost', name: 'Outpost 9', x: 0, z: 0, r: 50, h: y, tier: 1 }], lootSpots: [], spawnPoints: [new THREE.Vector3(0, y + 0.5, 0)], bounds: 160,
    extra: { rooms, doors, machines, wallbuys, radios, y },
  };
}
