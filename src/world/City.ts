import * as THREE from 'three';
import type { MapBuilder } from './Maps';
import type { Rng } from './Noise';
import { QUALITY_PRESETS, settings } from '../core/Settings';

/**
 * Lumos City: a real street grid instead of buildings dropped on painted roads.
 *
 *  - kit road segments + 4-way intersections (crosswalks), scaled to a 14.4 m four-lane road
 *  - raised sidewalks with curbs (physics steps), a paved central plaza
 *  - buildings snapped to their block quadrants, long side along the street, alleys between them
 *  - street furniture from the "City Props Collection" (bus stops, benches, bins, hydrants,
 *    parking meters, post boxes, dumpsters, utility boxes, manholes, storm drains)
 *  - street lights (switch on at dusk, see StreetLights) and traffic lights at every crossing
 *  - parked cars along the curbs, pocket parks with trees
 * Everything static is batched per block and distance-culled; bins / dumpsters / pallets are
 * physics props (Knockables) that cars, bullets and explosions push around.
 */
export interface CityInfo {
  lamps: THREE.Vector3[];
  /** road ends at the city boundary (for connecting country roads) */
  exits: [number, number][];
  parking: { x: number; z: number; yaw: number }[];
}

const ROAD_S = 0.8; // kit road: 18 m wide -> 14.4 m
const ROAD_HW = 9 * ROAD_S;
const INTER_H = 12.335 * ROAD_S;
const SEG = 6 * ROAD_S;
const CURB = 0.18;

export async function buildCity(mb: MapBuilder, cx: number, cz: number, h: number, offs: number[], ext: number, R: Rng): Promise<CityInfo> {
  const w = mb.w;
  const q = QUALITY_PRESETS[settings.data.quality];
  const lowQ = q.lowSpecMaterials;
  const detail = settings.data.quality === 'potato' ? 0 : settings.data.quality === 'low' ? 0.35 : settings.data.quality === 'medium' ? 0.7 : 1;
  const info: CityInfo = { lamps: [], exits: [], parking: [] };
  const yBase = h - 0.1;

  // ------------------------------------------------------------------ roads
  const roads = new THREE.Group(); roads.name = 'city_roads';
  const roadRun = async (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 1) return;
    const n = Math.max(1, Math.round(len / SEG));
    const k = len / (n * SEG);
    const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      await mb.place('kit:city:Street_4Lane', x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, alongX ? 0 : Math.PI / 2,
        { y: yBase, scaleV: new THREE.Vector3(ROAD_S * k * 1.01, ROAD_S, ROAD_S), collider: 'none', batch: roads });
    }
    // manholes + storm drains along the run
    if (detail > 0.3) {
      for (let i = 1; i <= Math.floor(len / 24); i++) {
        const t = i / (Math.floor(len / 24) + 1);
        const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
        const lane = (R.chance(0.5) ? 1 : -1) * ROAD_HW * 0.45;
        await mb.place('kit:cityprops:Manhole', x + (alongX ? 0 : lane), z + (alongX ? lane : 0), R.next() * 6, { y: h + 0.025, collider: 'none', batch: roads });
        if (R.chance(0.3)) w.lights?.steam.push(new THREE.Vector3(x + (alongX ? 0 : lane), h + 0.05, z + (alongX ? lane : 0)));
        if (detail >= 1 && i === 1) {
          const side = R.chance(0.5) ? 1 : -1;
          await mb.place('kit:cityprops:Drain', x + (alongX ? 3 : side * (ROAD_HW - 0.8)), z + (alongX ? side * (ROAD_HW - 0.8) : 3), alongX ? 0 : Math.PI / 2, { y: h + 0.025, collider: 'none', batch: roads });
        }
      }
    }
  };
  const lo = cx - ext, hi = cx + ext, loZ = cz - ext, hiZ = cz + ext;
  for (const oz of offs) {
    // east-west road at z = cz + oz
    let x = lo;
    for (const ox of offs) { await roadRun(x, cz + oz, cx + ox - INTER_H, cz + oz); x = cx + ox + INTER_H; }
    await roadRun(x, cz + oz, hi, cz + oz);
    info.exits.push([lo, cz + oz], [hi, cz + oz]);
  }
  for (const ox of offs) {
    let z = loZ;
    for (const oz of offs) { await roadRun(cx + ox, z, cx + ox, cz + oz - INTER_H); z = cz + oz + INTER_H; }
    await roadRun(cx + ox, z, cx + ox, hiZ);
    info.exits.push([cx + ox, loZ], [cx + ox, hiZ]);
  }
  for (const ox of offs) for (const oz of offs) {
    const ix = cx + ox, iz = cz + oz;
    await mb.place('kit:city:Street_4WayIntersection', ix, iz, 0, { y: yBase, scale: ROAD_S, collider: 'none', batch: roads });
    // traffic lights on two diagonal corners, facing the approaching lanes
    if (detail > 0) {
      for (const [sx, sz] of [[1, 1], [-1, -1]] as const) {
        await mb.place('kit:street:TrafficLight_2', ix + sx * (ROAD_HW + 1.0), iz + sz * (ROAD_HW + 1.0), sx > 0 ? Math.PI : 0,
          { y: h + CURB, scale: 5.5, collider: 'box', surface: 'metal', batch: roads });
      }
      if (detail > 0.6) for (const [sx, sz] of [[1, -1], [-1, 1]] as const) {
        await mb.place('kit:cityprops:Crossing', ix + sx * (ROAD_HW + 0.8), iz + sz * (ROAD_HW + 0.8), sx > 0 ? -Math.PI / 2 : Math.PI / 2, { y: h + CURB, collider: 'box', surface: 'metal', batch: roads });
      }
    }
  }
  mb.flush(roads);

  // ------------------------------------------------------------------ blocks
  const blockCenters: number[] = [];
  for (let i = 0; i < offs.length - 1; i++) blockCenters.push((offs[i] + offs[i + 1]) / 2);
  // high / ultra: full-detail kit buildings near the camera, LOD versions further out
  const swapLod = detail >= 1;
  const kitSet = lowQ || !swapLod ? 'city_lod' : 'city';
  const tall = lowQ ? ['env_apartment', 'env_building_shop', 'kit:city_lod:Building_Small_1'] : [`kit:${kitSet}:Building_Large_2`, `kit:${kitSet}:Building_Medium_2_001`, `kit:${kitSet}:Building_Small_1`, 'env_apartment', 'env_building_shop'];
  // trees go through the instanced scatter (chunked, LOD swap, distance culled)
  const trees = new Map<string, THREE.Matrix4[]>();
  const tree = (name: string, x: number, y: number, z: number, sc: number, trunk = true) => {
    let l = trees.get(name); if (!l) { l = []; trees.set(name, l); }
    l.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), R.next() * 6.28), new THREE.Vector3(sc, sc, sc)));
    if (trunk) w.physics.addBox(new THREE.Vector3(x, y + 2, z), new THREE.Vector3(0.3 * sc, 2, 0.3 * sc));
  };
  const tile = 'kit:city:Sidewalk_Straight_3m';
  const plazaIdx = Math.floor(blockCenters.length / 2);
  for (let bi = 0; bi < blockCenters.length; bi++) for (let bj = 0; bj < blockCenters.length; bj++) {
    const bx = cx + blockCenters[bi], bz = cz + blockCenters[bj];
    const half = (offs[bi + 1] - offs[bi]) / 2 - ROAD_HW;
    const plaza = bi === plazaIdx && bj === plazaIdx;
    const g = new THREE.Group(); g.name = `block_${bi}_${bj}`;
    const props = new THREE.Group(); props.name = `props_${bi}_${bj}`;
    const near = new THREE.Group(), far = new THREE.Group();
    // --- sidewalk ring (or full plaza paving)
    const n = Math.max(2, Math.round((2 * half) / 3.6));
    const t = (2 * half) / n;
    const sv = new THREE.Vector3(t / 3, (CURB + 0.1) / 0.15, t / 3);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const ring = i === 0 || j === 0 || i === n - 1 || j === n - 1;
      if (!ring && !plaza) continue;
      await mb.place(tile, bx - half + (i + 0.5) * t, bz - half + (j + 0.5) * t, 0, { y: yBase, scaleV: sv, collider: 'none', batch: g });
    }
    const top = h + CURB;
    if (plaza) w.physics.addBox(new THREE.Vector3(bx, top - 0.14, bz), new THREE.Vector3(half, 0.14, half));
    else for (const [dx, dz, hx, hz] of [[0, half - t / 2, half, t / 2], [0, -half + t / 2, half, t / 2], [half - t / 2, 0, t / 2, half - t], [-half + t / 2, 0, t / 2, half - t]]) {
      const c = w.physics.addBox(new THREE.Vector3(bx + dx, top - 0.14, bz + dz), new THREE.Vector3(hx, 0.14, hz));
      w.registerSurface(c, 'stone');
    }

    // --- street furniture along the four curbs (u runs along the side, curb line at `edge`)
    const edge = half - 0.55;
    const sides: { nx: number; nz: number }[] = [{ nx: 0, nz: 1 }, { nx: 0, nz: -1 }, { nx: 1, nz: 0 }, { nx: -1, nz: 0 }];
    const busSide = R.int(0, 3);
    for (let si = 0; si < 4; si++) {
      const { nx, nz } = sides[si];
      const at = (u: number, inset: number) => ({ x: bx + nx * (edge - inset) + (nz !== 0 ? u : 0), z: bz + nz * (edge - inset) + (nx !== 0 ? u : 0) });
      const faceRoad = Math.atan2(nx, nz); // yaw that turns +Z towards the road
      // street lights along the curb
      for (const u of [-half * 0.62, 0, half * 0.62]) {
        const p = at(u, 0.1);
        await mb.place('kit:street:Streetlight_Single', p.x, p.z, faceRoad, { y: top, scale: 5.5, collider: 'box', surface: 'metal', batch: g });
        info.lamps.push(new THREE.Vector3(p.x, top + 5.6, p.z));
      }
      if (detail === 0) continue;
      // trees in planters between the lamps
      for (const u of [-half * 0.31, half * 0.31]) {
        if (si === busSide && u > 0) {
          // bus shelter, open side towards the road
          const p = at(u, 1.6);
          await mb.place('kit:cityprops:BusStop', p.x, p.z, faceRoad + Math.PI, { y: top, scale: 0.82, collider: 'mesh', surface: 'metal', batch: props });
          continue;
        }
        const p = at(u, 0.9);
        await mb.place('kit:city:Prop_Planter_Single', p.x, p.z, 0, { y: top, scale: 0.8, collider: 'box', surface: 'stone', batch: g });
        if (detail > 0.3) tree(R.pick(['CommonTree_1', 'CommonTree_2', 'CommonTree_4']), p.x, top + 0.4, p.z, 0.55 + R.next() * 0.2, false);
      }
      if (detail < 0.3) continue;
      // parking meters along two sides, hydrant + post box / benches
      if (si < 2 && detail >= 1) for (const u of [-half * 0.45, half * 0.45]) {
        const p = at(u, 0.15);
        await mb.place('kit:cityprops:ParkingMeter', p.x, p.z, faceRoad, { y: top, collider: 'box', surface: 'metal', batch: props });
      }
      {
        const p = at(half * 0.8 * (R.chance(0.5) ? 1 : -1), 0.25);
        await mb.place('kit:cityprops:FireHydrant', p.x, p.z, R.next() * 6, { y: top, scale: 0.8, collider: 'box', surface: 'metal', batch: props });
      }
      if (!plaza && R.chance(0.7)) {
        const p = at(R.range(-half * 0.2, half * 0.2), 2.3);
        await mb.place(R.pick(['kit:cityprops:ParkBenchLong', 'kit:cityprops:ConcreteBench', 'kit:cityprops:ParkBenchShort']), p.x, p.z, faceRoad + Math.PI / 2, { y: top, collider: 'box', surface: 'wood', batch: props });
        const b = at(R.range(-half * 0.2, half * 0.2) + 2.5, 2.4);
        await w.knock?.add('cityprops', R.pick(['TrashCanLarge', 'TrashCanSmall', 'TrashCommercial', 'TrashCanCap']), new THREE.Vector3(b.x, top, b.z), R.next() * 6, 1, 35);
      }
      if (R.chance(0.35)) { const p = at(half * 0.2, 2.6); await mb.place('kit:cityprops:PostBox', p.x, p.z, faceRoad, { y: top, collider: 'box', surface: 'metal', batch: props }); }
      // parked car along this curb (outer lane)
      if (info.parking.length < 14 && R.chance(0.45)) {
        const along = nz !== 0 ? Math.PI / 2 : 0;
        const u = R.range(-half * 0.5, half * 0.5);
        const off = half + ROAD_HW * 0.3;
        info.parking.push({ x: bx + nx * off + (nz !== 0 ? u : 0), z: bz + nz * off + (nx !== 0 ? u : 0), yaw: along + (R.chance(0.5) ? Math.PI : 0) });
      }
    }
    // bollards on the corners
    if (detail > 0.6) for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      for (const a of [0.25, 0.75]) {
        const ang = a * Math.PI / 2;
        await mb.place('kit:city:Prop_Bollard', bx + sx * (half - 0.6 - Math.cos(ang) * 0.9), bz + sz * (half - 0.6 - Math.sin(ang) * 0.9), 0, { y: top, collider: 'box', surface: 'metal', batch: props });
      }
    }

    // --- the lot
    const lot = half - t - 0.5;
    if (plaza) {
      await mb.place('env_skyscraper', bx, bz, R.int(0, 3) * Math.PI / 2, { y: top - 0.05, surface: 'stone', loot: 6, batch: g });
      // ornate lamps + benches + trees around the tower
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        const r = lot * 0.92;
        const x = bx + Math.cos(a) * r, z = bz + Math.sin(a) * r;
        await mb.place('kit:cityprops:Light', x, z, 0, { y: top, scale: 1.1, collider: 'box', surface: 'metal', batch: g });
        info.lamps.push(new THREE.Vector3(x, top + 4.3, z));
        if (detail === 0) continue;
        const a2 = a + Math.PI / 8;
        const x2 = bx + Math.cos(a2) * r, z2 = bz + Math.sin(a2) * r;
        await mb.place('kit:city:Prop_Planter_Single', x2, z2, 0, { y: top, collider: 'box', surface: 'stone', batch: g });
        if (detail > 0.3) tree(R.pick(['CommonTree_3', 'CommonTree_5', 'CommonTree_4']), x2, top + 0.5, z2, 0.6, false);
        if (detail > 0.3) await mb.place('kit:cityprops:ParkBenchLong', bx + Math.cos(a) * r * 0.82, bz + Math.sin(a) * r * 0.82, -a, { y: top, collider: 'box', surface: 'wood', batch: props });
      }
    } else {
      const quads: [number, number][] = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
      const parkQ = R.chance(0.3) ? R.int(0, 3) : -1;
      for (let qi = 0; qi < 4; qi++) {
        const [sx, sz] = quads[qi];
        if (qi === parkQ) {
          // pocket park: trees, bench, lamp
          const px = bx + sx * lot * 0.5, pz = bz + sz * lot * 0.5;
          if (detail > 0) for (let k = 0; k < 4; k++) tree(R.pick(['CommonTree_1', 'CommonTree_3', 'CommonTree_2', 'Bush_Common']), px + R.range(-6, 6), h, pz + R.range(-6, 6), 0.8 + R.next() * 0.4);
          await mb.place('kit:cityprops:Light', px, pz, 0, { y: h, collider: 'box', surface: 'metal', batch: g });
          info.lamps.push(new THREE.Vector3(px, h + 4.1, pz));
          if (detail > 0.3) await mb.place('kit:cityprops:ParkBenchShort', px + 2, pz, Math.PI / 2, { y: h, collider: 'box', surface: 'wood', batch: props });
          continue;
        }
        const id = R.pick(tall);
        const size = await mb.sizeOf(id);
        // long side along the street this quadrant faces
        const faceX = (qi % 2 === 0);
        let yaw = R.chance(0.5) ? 0 : Math.PI;
        let fx = size.x, fz = size.z;
        const wantLongX = !faceX;
        if ((fx >= fz) !== wantLongX) { yaw += Math.PI / 2; [fx, fz] = [fz, fx]; }
        const room = lot - 1.6;
        const k = Math.min(1, room / Math.max(fx, fz));
        fx *= k; fz *= k;
        const x = bx + sx * (lot - fx / 2), z = bz + sz * (lot - fz / 2);
        if (swapLod && id.startsWith('kit:city:')) {
          await mb.place(id, x, z, yaw, { y: h - 0.05, scale: k < 1 ? k : undefined, surface: 'stone', loot: 3, batch: near });
          await mb.place(id.replace('kit:city:', 'kit:city_lod:'), x, z, yaw, { y: h - 0.05, scale: k < 1 ? k : undefined, collider: 'none', batch: far });
        } else await mb.place(id, x, z, yaw, { y: h - 0.05, scale: k < 1 ? k : undefined, surface: 'stone', loot: 3, batch: g });
      }
      // alley clutter (cross-shaped gap between the buildings)
      if (detail > 0.3) {
        const nAlley = 2 + Math.round(detail * 3);
        for (let k = 0; k < nAlley; k++) {
          const alongX = R.chance(0.5);
          const u = R.range(-lot * 0.8, lot * 0.8);
          const x = bx + (alongX ? u : R.range(-0.6, 0.6)), z = bz + (alongX ? R.range(-0.6, 0.6) : u);
          const kind = R.pick(['Dumpster', 'Dumpster', 'TarpCrates', 'pallet1', 'TrashCanCap', 'Utility']);
          if (kind === 'Dumpster') await w.knock?.add('cityprops', 'Dumpster', new THREE.Vector3(x, h, z), alongX ? 0 : Math.PI / 2, 1, 260);
          else if (kind === 'pallet1' || kind === 'TrashCanCap') await w.knock?.add('cityprops', kind, new THREE.Vector3(x, h, z), R.next() * 6, 1, kind === 'pallet1' ? 20 : 30);
          else await mb.place(`kit:cityprops:${kind}`, x, z, alongX ? 0 : Math.PI / 2, { y: h, collider: 'box', surface: kind === 'Utility' ? 'metal' : 'wood', batch: props });
        }
      }
    }
    mb.flush(g);
    const bc = new THREE.Vector3(bx, h, bz);
    if (near.children.length) mb.flushCulled(near, bc, 150, 0);
    if (far.children.length) mb.flushCulled(far, bc, 5000, 150);
    // small props: batched separately, no shadows, hidden beyond ~250 m
    if (props.children.length) mb.flushCulled(props, bc, 200 + detail * 60, 0, false);
  }
  for (const [name, mats] of trees) {
    const piece = await w.assets.kitPiece('nature', name);
    let lod: THREE.Object3D | null = null;
    try { lod = await w.assets.kitPiece('nature_lod', name); } catch { lod = null; }
    let lod2: THREE.Object3D | null = null;
    try { lod2 = await w.assets.kitPiece('nature_lod2', name); } catch { lod2 = null; }
    mb.scatter.add(piece, mats, 70, true, 480, lod, 60, lod2, 160);
  }
  return info;
}

export interface DressItem { id: string; n: number; mass?: number; collider?: 'box' | 'mesh' | 'none'; scale?: number; surface?: 'metal' | 'wood' | 'stone'; lamp?: number }

/**
 * Scatters props around a point of interest without dropping them into buildings: every spot is
 * probed with a downward ray first. Lamps register with the street-light system; `mass` turns a
 * prop into a physics knockable.
 */
export async function dressPOI(mb: MapBuilder, cx: number, cz: number, r: number, items: DressItem[], R: Rng, rMin = 0.2) {
  const w = mb.w;
  const detail = settings.data.quality === 'potato' ? 0.3 : settings.data.quality === 'low' ? 0.5 : settings.data.quality === 'medium' ? 0.8 : 1;
  const g = new THREE.Group();
  for (const it of items) {
    const n = it.lamp ? it.n : Math.round(it.n * detail);
    for (let k = 0, tries = 0; k < n && tries < n * 6; tries++) {
      const a = R.next() * Math.PI * 2, d = r * (rMin + (1 - rMin) * Math.sqrt(R.next()));
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      const ground = w.terrain.getHeight(x, z);
      if (ground < w.waterLevel + 0.4) continue;
      const hit = w.physics.raycast(new THREE.Vector3(x, ground + 40, z), new THREE.Vector3(0, -1, 0), 41);
      if (hit && hit.point.y > ground + 0.35) continue; // something is already there
      k++;
      const yaw = R.next() * Math.PI * 2;
      const [kit, piece] = it.id.split(':');
      if (it.mass) await w.knock?.add(kit as 'cityprops', piece, new THREE.Vector3(x, ground, z), yaw, it.scale ?? 1, it.mass);
      else await mb.place(`kit:${it.id}`, x, z, it.lamp ? 0 : yaw, { y: ground, scale: it.scale, collider: it.collider ?? 'box', surface: it.surface ?? 'metal', batch: g });
      if (it.lamp) w.lights?.add(new THREE.Vector3(x, ground + it.lamp, z));
    }
  }
  if (g.children.length) mb.flush(g);
}

/** a row of lamps along a straight segment (both sides) */
export async function lampRow(mb: MapBuilder, x0: number, z0: number, x1: number, z1: number, side: number, step: number, id = 'cityprops:Light', height = 4.2, scale = 1) {
  const w = mb.w;
  const len = Math.hypot(x1 - x0, z1 - z0);
  const nx = -(z1 - z0) / len, nz = (x1 - x0) / len;
  const g = new THREE.Group();
  for (let d = step / 2; d < len; d += step) {
    for (const s of [-1, 1]) {
      const x = x0 + (x1 - x0) * (d / len) + nx * side * s, z = z0 + (z1 - z0) * (d / len) + nz * side * s;
      const y = w.terrain.getHeight(x, z);
      await mb.place(`kit:${id}`, x, z, 0, { y, scale, collider: 'box', surface: 'metal', batch: g });
      w.lights?.add(new THREE.Vector3(x, y + height * scale, z));
    }
  }
  mb.flush(g);
}
