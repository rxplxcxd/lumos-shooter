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
  /** church / town-hall bell towers (hourly chimes) */
  bells: THREE.Vector3[];
  /** chimney tops (smoke) */
  chimneys: THREE.Vector3[];
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
  const info: CityInfo = { lamps: [], exits: [], parking: [], bells: [], chimneys: [] };
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
        { y: yBase + (i % 2) * 0.002, scaleV: new THREE.Vector3(ROAD_S * k, ROAD_S, ROAD_S), collider: 'none', batch: roads });
    }
    // manholes + storm drains along the run
    if (detail > 0.3) {
      for (let i = 1; i <= Math.floor(len / 24); i++) {
        const t = i / (Math.floor(len / 24) + 1);
        const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
        const lane = (R.chance(0.5) ? 1 : -1) * ROAD_HW * 0.45;
        await mb.place('kit:cityprops:Manhole', x + (alongX ? 0 : lane), z + (alongX ? lane : 0), R.next() * 6, { y: h + 0.045, collider: 'none', batch: roads });
        if (R.chance(0.3)) w.lights?.steam.push(new THREE.Vector3(x + (alongX ? 0 : lane), h + 0.05, z + (alongX ? lane : 0)));
        if (detail >= 1 && i === 1) {
          const side = R.chance(0.5) ? 1 : -1;
          await mb.place('kit:cityprops:Drain', x + (alongX ? 3 : side * (ROAD_HW - 0.8)), z + (alongX ? side * (ROAD_HW - 0.8) : 3), alongX ? 0 : Math.PI / 2, { y: h + 0.045, collider: 'none', batch: roads });
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
    await mb.place('kit:city:Street_4WayIntersection', ix, iz, 0, { y: yBase + 0.006, scale: ROAD_S, collider: 'none', batch: roads });
    // traffic lights on two diagonal corners, facing the approaching lanes
    if (detail > 0) {
      for (const [sx, sz] of [[1, 1], [-1, -1]] as const) {
        await mb.place('kit:street:TrafficLight_2', ix + sx * (ROAD_HW + 1.0), iz + sz * (ROAD_HW + 1.0), sx > 0 ? Math.PI : 0,
          { y: h + CURB, scale: 5.5, collider: 'pole', surface: 'metal', batch: roads });
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
  // low-end presets: one city-wide batch (draw calls = materials, not blocks x materials)
  const shared = lowQ ? new THREE.Group() : null;
  for (let bi = 0; bi < blockCenters.length; bi++) for (let bj = 0; bj < blockCenters.length; bj++) {
    const bx = cx + blockCenters[bi], bz = cz + blockCenters[bj];
    const half = (offs[bi + 1] - offs[bi]) / 2 - ROAD_HW;
    const plaza = bi === plazaIdx && bj === plazaIdx;
    // district: modern high-rise blocks, a historic old town (photo-textured European buildings) and a city park
    const kind: 'plaza' | 'oldtown' | 'park' | 'modern' = plaza ? 'plaza' : bi === 0 && bj < 2 ? 'oldtown' : bi === blockCenters.length - 1 && bj === blockCenters.length - 1 ? 'park' : 'modern';
    const historic = kind === 'oldtown' || kind === 'park';
    const g = shared ?? new THREE.Group(); if (!shared) g.name = `block_${bi}_${bj}`;
    const props = shared ?? new THREE.Group(); if (!shared) props.name = `props_${bi}_${bj}`;
    const near = new THREE.Group(), far = new THREE.Group();
    // --- sidewalk ring (or full plaza paving)
    const n = Math.max(2, Math.round((2 * half) / 3.6));
    const t = (2 * half) / n;
    const sv = new THREE.Vector3(t / 3, (CURB + 0.1) / 0.15, t / 3);
    const paved = plaza || kind === 'modern' || kind === 'oldtown';
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const ring = i === 0 || j === 0 || i === n - 1 || j === n - 1;
      if (!ring && !paved) continue;
      await mb.place(tile, bx - half + (i + 0.5) * t, bz - half + (j + 0.5) * t, 0, { y: yBase, scaleV: sv, collider: 'none', batch: g });
    }
    const top = h + CURB;
    if (paved) w.registerSurface(w.physics.addBox(new THREE.Vector3(bx, top - 0.14, bz), new THREE.Vector3(half, 0.14, half)), 'stone');
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
      // street lights along the curb (ornate double lanterns in the historic districts)
      for (const u of [-half * 0.62, 0, half * 0.62]) {
        const p = at(u, 0.1);
        if (historic) {
          await mb.place('kit:euro_b:OrnateLamp', p.x, p.z, nz !== 0 ? 0 : Math.PI / 2, { y: top, collider: 'pole', surface: 'metal', batch: g });
          info.lamps.push(new THREE.Vector3(p.x, top + 4.9, p.z));
        } else {
          await mb.place('kit:street:Streetlight_Single', p.x, p.z, faceRoad, { y: top, scale: 5.5, collider: 'pole', surface: 'metal', batch: g });
          info.lamps.push(new THREE.Vector3(p.x, top + 5.6, p.z));
        }
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
        if (detail > 0.3) {
          if (R.chance(0.72)) tree(R.pick(['CommonTree_1', 'CommonTree_2', 'CommonTree_4']), p.x, top + 0.4, p.z, 0.55 + R.next() * 0.2, false);
          else tree(R.pick(['Bush_Common_Flowers', 'Bush_Common']), p.x, top + 0.45, p.z, 0.75, false);
        }
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
      // traffic signs near the corners (stop / no parking / give way)
      if (detail > 0.3) {
        const sgn = R.pick(['Sign_Stop', 'Sign_NoParking', 'Sign_Triangle', 'Sign_NoParking']);
        const p = at(half * (R.chance(0.5) ? 0.9 : -0.9), 0.2);
        await mb.place(`kit:street:${sgn}`, p.x, p.z, faceRoad + (sgn === 'Sign_Stop' ? Math.PI / 2 : 0), { y: top, scale: 5.5, collider: 'pole', surface: 'metal', batch: props });
      }
      // more bins along the curb (physics props: they fly when a car clips the sidewalk)
      if (detail > 0.6) for (const u of [-half * 0.72, half * 0.55]) {
        if (!R.chance(0.55)) continue;
        const p = at(u, 0.5);
        await w.knock?.add('cityprops', R.pick(['TrashCanLarge', 'TrashCanSmall', 'TrashCommercial']), new THREE.Vector3(p.x, top, p.z), R.next() * 6, 1, 30);
      }
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
    } else if (kind === 'oldtown') {
      await oldTownBlock(mb, bx, bz, half - t + 0.05, h, R, g, props, info, bi === 0 && bj === 1, detail);
    } else if (kind === 'park') {
      await parkBlock(mb, bx, bz, half - t, h, R, g, props, info, tree, detail);
    } else {
      const quads: [number, number][] = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
      const ly = top; // paved lot
      const parkQ = R.chance(0.3) ? R.int(0, 3) : -1;
      for (let qi = 0; qi < 4; qi++) {
        const [sx, sz] = quads[qi];
        if (qi === parkQ) {
          // pocket park: trees, bench, lamp
          const px = bx + sx * lot * 0.5, pz = bz + sz * lot * 0.5;
          if (detail > 0) for (let k = 0; k < 4; k++) tree(R.pick(['CommonTree_1', 'CommonTree_3', 'CommonTree_2', 'Bush_Common']), px + R.range(-6, 6), ly, pz + R.range(-6, 6), 0.8 + R.next() * 0.4);
          await mb.place('kit:cityprops:Light', px, pz, 0, { y: ly, collider: 'box', surface: 'metal', batch: g });
          info.lamps.push(new THREE.Vector3(px, ly + 4.1, pz));
          if (detail > 0.3) await mb.place('kit:cityprops:ParkBenchShort', px + 2, pz, Math.PI / 2, { y: ly, collider: 'box', surface: 'wood', batch: props });
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
          await mb.place(id, x, z, yaw, { y: ly - 0.03, scale: k < 1 ? k : undefined, surface: 'stone', loot: 3, batch: near });
          await mb.place(id.replace('kit:city:', 'kit:city_lod:'), x, z, yaw, { y: ly - 0.03, scale: k < 1 ? k : undefined, collider: 'none', batch: far });
        } else await mb.place(id, x, z, yaw, { y: ly - 0.03, scale: k < 1 ? k : undefined, surface: 'stone', loot: 3, batch: g });
      }
      // construction site in one corner of some blocks: barriers, pallets, tarps, rubble
      if (detail > 0.3 && R.chance(0.35)) {
        const [sx, sz] = R.pick(quads);
        const cxs = bx + sx * (lot - 3.2), czs = bz + sz * (lot * 0.45);
        await mb.place('kit:cityprops:PostBarrier', cxs, czs, Math.PI / 2, { y: ly, collider: 'box', surface: 'metal', batch: props });
        await mb.place('env_barrier', cxs - sx * 2.5, czs + 4, 0, { y: ly, collider: 'box', surface: 'stone', batch: props });
        for (let k = 0; k < 3; k++) await w.knock?.add('cityprops', R.pick(['pallet1', 'pallet2']), new THREE.Vector3(cxs - sx * R.range(1, 4), ly + k * 0.15, czs - R.range(-3, 3)), R.next() * 6, 1, 20);
        for (let k = 0; k < 4; k++) await mb.place(`kit:nature:${R.pick(['Rock_Medium_1', 'Rock_Medium_2', 'Pebble_Round_1'])}`, cxs - sx * R.range(0, 5), czs + R.range(-4, 4), R.next() * 6, { y: ly - 0.2, scale: 0.35 + R.next() * 0.4, collider: 'none', batch: props });
      }
      // alley clutter (cross-shaped gap between the buildings)
      if (detail > 0.3) {
        const nAlley = 3 + Math.round(detail * 4);
        for (let k = 0; k < nAlley; k++) {
          const alongX = R.chance(0.5);
          const u = R.range(-lot * 0.8, lot * 0.8);
          const x = bx + (alongX ? u : R.range(-0.6, 0.6)), z = bz + (alongX ? R.range(-0.6, 0.6) : u);
          const kind = R.pick(['Dumpster', 'Dumpster', 'TarpCrates', 'pallet1', 'TrashCanCap', 'Utility']);
          if (kind === 'Dumpster') await w.knock?.add('cityprops', 'Dumpster', new THREE.Vector3(x, ly, z), alongX ? 0 : Math.PI / 2, 1, 260);
          else if (kind === 'pallet1' || kind === 'TrashCanCap') await w.knock?.add('cityprops', kind, new THREE.Vector3(x, ly, z), R.next() * 6, 1, kind === 'pallet1' ? 20 : 30);
          else await mb.place(`kit:cityprops:${kind}`, x, z, alongX ? 0 : Math.PI / 2, { y: ly, collider: 'box', surface: kind === 'Utility' ? 'metal' : 'wood', batch: props });
        }
      }
    }
    if (!shared) mb.flush(g);
    const bc = new THREE.Vector3(bx, h, bz);
    if (near.children.length) mb.flushCulled(near, bc, 150, 0);
    if (far.children.length) mb.flushCulled(far, bc, 5000, 150);
    // small props: batched separately, no shadows, hidden beyond ~250 m
    if (!shared && props.children.length) mb.flushCulled(props, bc, 200 + detail * 60, 0, false);
  }
  if (shared) mb.flush(shared);
  for (const [name, mats] of trees) {
    const piece = await w.assets.kitPiece('nature', name);
    let lod: THREE.Object3D | null = null;
    try { lod = await w.assets.kitPiece('nature_lod', name); } catch { lod = null; }
    let lod2: THREE.Object3D | null = null;
    try { lod2 = await w.assets.kitPiece('nature_lod2', name); } catch { lod2 = null; }
    if (/Grass|Flower/.test(name)) mb.scatter.add(piece, mats, 70, false, 140);
    else mb.scatter.add(piece, mats, 70, true, 480, lod, 60, lod2, 160);
  }
  return info;
}

// --------------------------------------------------------------------------- historic districts
const EURO_POOL = ['DutchRow', 'BrickHouse_A', 'NarrowHouse', 'BrickHouse_B', 'BrickHouse_A', 'NarrowHouse', 'BrickHouse_B', 'FacadeShell'];

/**
 * Old town block: terraced rows of historic houses along all four streets, facades flush with the
 * sidewalk, backs towards a closed courtyard. Rows are stretched (±25 %) so they close without gaps.
 */
async function oldTownBlock(mb: MapBuilder, bx: number, bz: number, lot: number, h: number, R: Rng, g: THREE.Group, props: THREE.Group, info: CityInfo, townHall: boolean, detail: number) {
  const sizes = new Map<string, THREE.Vector3>();
  for (const p of new Set([...EURO_POOL, 'TownHall', 'CornerShop'])) sizes.set(p, await mb.sizeOf(`kit:euro_a:${p}`));
  const dims = (p: string) => { const sz = sizes.get(p)!; return p === 'TownHall' ? { w: sz.z, d: sz.x } : { w: sz.x, d: sz.z }; };
  const depthMax = 16.5;
  // houses whose side walls are textured brick can close a row at a street corner
  const CORNER = ['BrickHouse_A', 'CornerShop', 'BrickHouse_B'];
  const sides = [{ nx: 0, nz: 1 }, { nx: 0, nz: -1 }, { nx: 1, nz: 0 }, { nx: -1, nz: 0 }];
  // end depths of the north / south rows at their west (-x) and east (+x) ends
  const endDepth = { n: [depthMax, depthMax], s: [depthMax, depthMax] };
  for (let si = 0; si < 4; si++) {
    const { nx, nz } = sides[si];
    const ns = nz !== 0;
    // north/south rows run the full width; east/west rows close the gap between their corner houses
    let from = -lot, to = lot;
    if (!ns) {
      const ix = nx > 0 ? 1 : 0;
      from = -lot + endDepth.s[ix]; to = lot - endDepth.n[ix];
    }
    const len = to - from;
    if (len < 5) continue;
    const row: string[] = [];
    let sum = 0;
    for (let guard = 0; sum < len - 2 && guard < 40; guard++) {
      const first = row.length === 0;
      const p = ns && first ? R.pick(CORNER) : R.pick(EURO_POOL);
      if (p === 'FacadeShell' && (first || row[row.length - 1] === 'FacadeShell')) continue;
      if (!first && p === row[row.length - 1]) continue; // no identical neighbours
      const w = dims(p).w;
      if (sum + w > len * 1.2 && sum > len * 0.8) break;
      if (sum + w > len * 1.2) continue;
      row.push(p); sum += w;
    }
    if (!row.length) continue;
    // the last house of a north/south row is a corner house too
    if (ns && row.length > 1 && !CORNER.includes(row[row.length - 1])) { sum -= dims(row[row.length - 1]).w; row[row.length - 1] = R.pick(CORNER); sum += dims(row[row.length - 1]).w; }
    if (townHall && si === 0) { const mid = Math.floor(row.length / 2); sum += dims('TownHall').w - dims(row[mid]).w; row[mid] = 'TownHall'; }
    const k = THREE.MathUtils.clamp(len / sum, 0.7, 1.35);
    let u = (from + to) / 2 - (sum * k) / 2;
    const faceYaw = Math.atan2(nx, nz);
    row.forEach((p, idx) => {
      const d = dims(p);
      const depth = Math.min(d.d, depthMax);
      if (ns && idx === 0) endDepth[nz > 0 ? 'n' : 's'][0] = depth;
      if (ns && idx === row.length - 1) endDepth[nz > 0 ? 'n' : 's'][1] = depth;
    });
    for (const p of row) {
      const d = dims(p);
      const wS = d.w * k, depth = Math.min(d.d, depthMax);
      const cu = u + wS / 2; u += wS;
      const x = bx + nx * (lot - depth / 2) + (ns ? cu : 0), z = bz + nz * (lot - depth / 2) + (ns ? 0 : cu);
      const sv = p === 'TownHall' ? new THREE.Vector3(depth / d.d, 1, k) : new THREE.Vector3(k, 1, depth / d.d);
      // facades stand on the sidewalk (no sunken strip in front of the doors)
      await mb.place(`kit:euro_a:${p}`, x, z, p === 'TownHall' ? faceYaw - Math.PI / 2 : faceYaw, { y: h + CURB - 0.03, scaleV: sv, surface: 'stone', loot: p === 'TownHall' ? 4 : 2, batch: g });
      if (p === 'TownHall') info.bells.push(new THREE.Vector3(x, h + 16, z));
      // chimneys: back half of the roof ridge of the narrow / brick houses
      if ((p === 'NarrowHouse' || p === 'BrickHouse_B' || p === 'DutchRow') && R.chance(0.6)) {
        const sz = sizes.get(p)!;
        info.chimneys.push(new THREE.Vector3(x - nx * depth * 0.15, h + sz.y - 0.3, z - nz * depth * 0.15));
      }
    }
  }
  // closed courtyard behind the rows: a few trees and junk (seen from rooftops / windows)
  if (detail > 0.3) {
    const inner = lot - depthMax;
    if (inner > 3) {
      await mb.w.knock?.add('cityprops', 'Dumpster', new THREE.Vector3(bx + R.range(-inner + 2, inner - 2), h + CURB, bz + R.range(-inner + 2, inner - 2)), R.next() * 6, 1, 260);
      await mb.place('kit:cityprops:TarpCrates', bx + R.range(-inner + 2, inner - 2), bz + R.range(-inner + 2, inner - 2), R.next() * 6, { y: h + CURB, collider: 'box', surface: 'wood', batch: props });
    }
  }
  void info;
}

/**
 * City park: lawn, a domed bandstand in the middle, stepping-stone paths from the four streets,
 * gazebos and pavilions, flower beds, benches, ornate lanterns and a wrought-iron fence.
 */
async function parkBlock(mb: MapBuilder, bx: number, bz: number, lot: number, h: number, R: Rng, g: THREE.Group, props: THREE.Group, info: CityInfo,
  tree: (name: string, x: number, y: number, z: number, sc: number, trunk?: boolean) => void, detail: number) {
  const w = mb.w;
  await mb.place('kit:euro_b:Bandstand', bx, bz, R.int(0, 3) * Math.PI / 2, { y: h - 0.02, surface: 'stone', loot: 4, batch: g });
  // paths from the four entrances to the bandstand
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dz] of dirs) {
    for (let r = 8.5; r < lot - 0.5; r += 2.1) {
      await mb.place('kit:nature:RockPath_Round_Wide', bx + dx * r, bz + dz * r, R.next() * 6, { y: h + 0.01, scale: 1.3, collider: 'none', batch: g });
    }
    // lanterns either side of the path
    for (const s of [-1, 1]) {
      const r = lot * 0.55;
      const x = bx + dx * r + dz * s * 2.4, z = bz + dz * r + dx * s * 2.4;
      await mb.place('kit:euro_b:OrnateLamp', x, z, dx !== 0 ? Math.PI / 2 : 0, { y: h, collider: 'pole', surface: 'metal', batch: g });
      info.lamps.push(new THREE.Vector3(x, h + 4.9, z));
    }
    // benches facing the bandstand
    if (detail > 0.3) {
      const r = 10.5;
      for (const s of [-1, 1]) {
        const x = bx + dx * r + dz * s * 3.2, z = bz + dz * r + dx * s * 3.2;
        await mb.place('kit:cityprops:ParkBenchLong', x, z, Math.atan2(-dx, -dz) + Math.PI / 2, { y: h, collider: 'box', surface: 'wood', batch: props });
      }
      await w.knock?.add('cityprops', 'TrashCanLarge', new THREE.Vector3(bx + dx * (r + 1.5) + dz * 4.6, h, bz + dz * (r + 1.5) + dx * 4.6), R.next() * 6, 1, 30);
    }
  }
  // the four quadrants: gazebo, wooden pavilion, white pavilion, flower garden
  const quads: [number, number, string][] = [[1, 1, 'kit:euro_b:Gazebo'], [-1, 1, 'kit:euro_b:Pavilion_Wood'], [1, -1, 'kit:euro_a:Pavilion_White'], [-1, -1, 'kit:euro_a:FlowerBed']];
  for (const [sx, sz, id] of quads) {
    const qx = bx + sx * lot * 0.58, qz = bz + sz * lot * 0.58;
    await mb.place(id, qx, qz, Math.atan2(-sx, -sz), { y: h - 0.02, surface: 'wood', batch: g, collider: id.endsWith('FlowerBed') ? 'box' : 'mesh' });
    if (detail > 0) {
      for (let k = 0; k < 3; k++) {
        const a = R.next() * Math.PI * 2, r = 6.5 + R.next() * 3;
        const tx = THREE.MathUtils.clamp(qx + Math.cos(a) * r, bx - lot + 1.5, bx + lot - 1.5), tz = THREE.MathUtils.clamp(qz + Math.sin(a) * r, bz - lot + 1.5, bz + lot - 1.5);
        if (Math.abs(tx - bx) < 3.5 || Math.abs(tz - bz) < 3.5) continue; // keep the paths free
        tree(R.pick(['CommonTree_1', 'CommonTree_2', 'CommonTree_3', 'CommonTree_5']), tx, h, tz, 0.75 + R.next() * 0.45);
      }
      for (let k = 0; k < 4; k++) {
        const tx = qx + R.range(-5, 5), tz = qz + R.range(-5, 5);
        if (Math.abs(tx - bx) < 3 || Math.abs(tz - bz) < 3) continue;
        await mb.place(`kit:nature:${R.pick(['Bush_Common', 'Bush_Common_Flowers', 'Flower_3_Group', 'Flower_4_Group'])}`, tx, tz, R.next() * 6, { y: h, collider: 'none', batch: g });
      }
    }
  }
  // lawn detail: grass tufts and flowers (instanced, off the paths)
  if (detail > 0.3) {
    const tufts = ['Grass_Common_Short', 'Grass_Common_Tall', 'Flower_3_Group'];
    for (let k = 0; k < Math.round(140 * detail); k++) {
      const tx = bx + R.range(-lot + 1, lot - 1), tz = bz + R.range(-lot + 1, lot - 1);
      if (Math.abs(tx - bx) < 2.2 || Math.abs(tz - bz) < 2.2 || Math.hypot(tx - bx, tz - bz) < 7.5) continue;
      tree(R.pick(tufts), tx, h - 0.02, tz, 0.8 + R.next() * 0.6, false);
    }
  }
  // wrought-iron fence along the lot edge with gaps for the four paths
  if (detail > 0.3) {
    const gate = await mb.sizeOf('kit:euro_b:IronGate');
    const seg = gate.x;
    for (const [nx, nz] of dirs) {
      const n = Math.floor((2 * lot) / seg);
      for (let i = 0; i < n; i++) {
        const u = -lot + (i + 0.5) * ((2 * lot) / n);
        if (Math.abs(u) < 3.2) continue;
        const x = bx + nx * (lot - 0.4) + (nz !== 0 ? u : 0), z = bz + nz * (lot - 0.4) + (nx !== 0 ? u : 0);
        await mb.place('kit:euro_b:IronGate', x, z, nz !== 0 ? 0 : Math.PI / 2, { y: h, scaleV: new THREE.Vector3(((2 * lot) / n) / seg, 1, 1), collider: 'box', surface: 'metal', batch: props });
      }
    }
  }
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
      else await mb.place(`kit:${it.id}`, x, z, it.lamp ? 0 : yaw, { y: ground, scale: it.scale, collider: it.collider ?? (it.lamp ? 'pole' : 'box'), surface: it.surface ?? 'metal', batch: g });
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
      await mb.place(`kit:${id}`, x, z, 0, { y, scale, collider: 'pole', surface: 'metal', batch: g });
      w.lights?.add(new THREE.Vector3(x, y + height * scale, z));
    }
  }
  mb.flush(g);
}
