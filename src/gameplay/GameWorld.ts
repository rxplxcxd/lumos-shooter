import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Engine } from '../core/Engine';
import type { AssetManager } from '../assets/AssetManager';
import type { AudioSys } from '../audio/Audio';
import type { Input } from '../input/Input';
import { Physics } from '../physics/Physics';
import { Effects } from '../fx/Effects';
import { Ballistics } from '../weapons/Ballistics';
import { Terrain, type Surface } from '../world/Terrain';
import { Water } from '../world/Water';
import { SkySystem } from '../world/SkySystem';
import { Events } from '../core/Events';
import { settings, QUALITY_PRESETS } from '../core/Settings';
import type { Actor, DamageInfo, HitZone } from './types';
import type { Soldier } from '../entities/Soldier';
import type { Vehicle, VehicleControls } from '../vehicles/Vehicle';
import type { Weapon } from '../weapons/Weapon';
import { attachmentById } from '../weapons/WeaponDefs';
import { wind } from '../world/Wind';
import { AmbientLife } from '../world/AmbientLife';
import type { PlayerController } from '../entities/PlayerController';
import type { Mode } from './Mode';
import type { NetSync } from '../net/NetSync';

export interface Interactable {
  pos: THREE.Vector3;
  radius: number;
  label: () => string;
  cost?: () => number;
  enabled: () => boolean;
  use: (s: Soldier) => void;
  hold?: number; // seconds to hold
}

interface Destructible { collider: RAPIER.Collider; obj: THREE.Object3D; hp: number; surface: Surface; onBreak?: () => void }

/**
 * The running match world: owns physics, terrain, water, sky, actors, vehicles, projectiles,
 * effects and interaction points. Game modes plug in via the Mode interface.
 */
export class GameWorld {
  engine: Engine; assets: AssetManager; audio: AudioSys; input: Input;
  scene: THREE.Scene;
  physics = new Physics();
  effects!: Effects;
  ballistics!: Ballistics;
  terrain!: Terrain;
  water!: Water;
  sky!: SkySystem;
  bus = new Events();
  actors: Actor[] = [];
  soldiers: Soldier[] = [];
  vehicles: Vehicle[] = [];
  interactables: Interactable[] = [];
  player: PlayerController | null = null;
  mode: Mode | null = null;
  time = 0;
  waterLevel = 0;
  mapSize = 1600;
  root = new THREE.Group();
  private charColliders = new Map<number, Actor>();
  private vehColliders = new Map<number, Vehicle>();
  private surfaces = new Map<number, Surface>();
  private destructibles = new Map<number, Destructible>();
  private weaponModels = new Map<string, Promise<THREE.Object3D>>();
  vehicleControls = new Map<Vehicle, VehicleControls>();
  updaters: ((dt: number) => void)[] = [];
  lowSpec: boolean;
  ambient: AmbientLife | null = null;
  net: NetSync | null = null;

  constructor(engine: Engine, assets: AssetManager, audio: AudioSys, input: Input) {
    this.engine = engine; this.assets = assets; this.audio = audio; this.input = input;
    this.scene = engine.scene;
    this.lowSpec = QUALITY_PRESETS[settings.data.quality].lowSpecMaterials;
  }

  async init(terrain: Terrain, opts: { time?: number; weather?: 'clear' | 'overcast' | 'fog' | 'rain'; timeSpeed?: number } = {}) {
    await this.physics.create();
    const q = QUALITY_PRESETS[settings.data.quality];
    this.scene.add(this.root);
    this.terrain = terrain;
    this.mapSize = terrain.size;
    this.waterLevel = terrain.seaLevel;
    this.root.add(terrain.build(this.lowSpec, q.terrainDetail));
    terrain.addToPhysics(this.physics);
    this.water = new Water(Math.min(q.far * 2.2, 4000), this.waterLevel, this.lowSpec ? 24 : q.waterHigh ? 128 : 64, q.waterHigh);
    this.water.setTerrain(terrain);
    this.root.add(this.water.mesh);
    this.sky = new SkySystem(this.scene, q.shadows, q.far, { clouds: q.clouds, renderer: this.engine.renderer, envMap: q.envMap, shadowRange: q.shadowRange });
    this.sky.attachCamera(this.engine.camera);
    this.sky.time = opts.time ?? 13;
    this.sky.speed = opts.timeSpeed ?? 0;
    this.sky.setWeather(opts.weather ?? 'clear', this.scene);
    this.effects = new Effects(this.scene, q.particles, q.decals);
    this.effects.ground = (x, z) => Math.max(this.terrain.getHeight(x, z), this.waterLevel - 30);
    this.effects.onCasingLand = (p) => this.audio.play('shell_drop', { pos: p, volume: 0.25, maxDist: 15, throttle: 90 });
    this.assets.kitPiece('nature', 'Pebble_Round_1').then(async (rock) => {
      const smg = await this.assets.template('w_smg').catch(() => null);
      const casing = smg?.getObjectByName('bullet_smglow_0') ?? null;
      this.effects.setDebrisSource(rock, casing);
    }).catch(() => {});
    this.ballistics = new Ballistics(this);
    if (q.ambientLife) this.ambient = new AmbientLife(this);
  }

  // ------------------------------------------------------------------ registries
  registerCharacterCollider(c: RAPIER.Collider, a: Actor) { this.charColliders.set(c.handle, a); }
  unregisterCharacterCollider(c: RAPIER.Collider) { this.charColliders.delete(c.handle); }
  isCharacterCollider(c: RAPIER.Collider) { return this.charColliders.has(c.handle); }
  registerVehicle(v: Vehicle) { this.vehicles.push(v); this.vehColliders.set(v.collider.handle, v); this.surfaces.set(v.collider.handle, 'metal'); }
  vehicleOfCollider(c: RAPIER.Collider) { return this.vehColliders.get(c.handle) ?? null; }
  removeVehicle(v: Vehicle) { this.vehicles = this.vehicles.filter((x) => x !== v); this.vehColliders.delete(v.collider.handle); v.dispose(); }
  registerSurface(c: RAPIER.Collider | null, s: Surface) { if (c) this.surfaces.set(c.handle, s); }
  surfaceOfCollider(c: RAPIER.Collider): string { if (this.vehColliders.has(c.handle)) return 'vehicle'; return this.surfaces.get(c.handle) ?? 'terrain'; }
  registerDestructible(c: RAPIER.Collider | null, obj: THREE.Object3D, hp: number, surface: Surface, onBreak?: () => void) {
    if (!c) return; this.destructibles.set(c.handle, { collider: c, obj, hp, surface, onBreak }); this.surfaces.set(c.handle, surface);
  }
  destructibleHit(c: RAPIER.Collider, dmg: number, p: THREE.Vector3) {
    const d = this.destructibles.get(c.handle);
    if (!d) return;
    d.hp -= dmg;
    if (d.hp <= 0) this.breakDestructible(d, p);
  }
  private breakDestructible(d: Destructible, p: THREE.Vector3) {
    this.destructibles.delete(d.collider.handle);
    this.physics.removeCollider(d.collider);
    d.obj.removeFromParent();
    this.effects.burst(p, 25, 6, d.surface === 'wood' ? 0x8a6a40 : 0x999999, 0.15, 1.2, 9.8, 1, 0.5);
    this.audio.play(d.surface === 'wood' ? 'wood_break' : d.surface === 'glass' as any ? 'glass_break' : 'crate_smash', { pos: p, volume: 0.8 });
    d.onBreak?.();
  }

  surfaceUnder(s: Soldier): Surface {
    const hit = this.physics.raycast(new THREE.Vector3(s.pos.x, s.pos.y + 0.3, s.pos.z), new THREE.Vector3(0, -1, 0), 0.8, s.collider);
    if (hit) { const surf = this.surfaceOfCollider(hit.collider); if (surf !== 'terrain') return (surf === 'vehicle' ? 'metal' : surf) as Surface; }
    return this.terrain.surfaceAt(s.pos.x, s.pos.z);
  }

  actorsNear(p: THREE.Vector3, r: number): Actor[] {
    const r2 = r * r;
    return this.actors.filter((a) => a.alive && a.pos.distanceToSquared(p) < r2 + 4);
  }

  private thermalOn = false;
  private thermalT = 0;
  /** thermal optic: sky reads cold, living bodies glow hot (emissive override on their materials) */
  setThermal(on: boolean, dt = 0) {
    this.thermalT -= dt;
    if (on === this.thermalOn && (!on || this.thermalT > 0)) return;
    this.thermalOn = on; this.thermalT = 0.5;
    this.sky.dome.visible = !on;
    for (const a of this.actors) {
      const root = (a as unknown as { model?: { root: THREE.Object3D } }).model?.root;
      if (!root) continue;
      const hot = on && a.alive;
      root.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (!m || !(o as THREE.Mesh).isMesh || !('emissive' in m)) return;
        if (hot && m.userData.thermalE === undefined) { m.userData.thermalE = m.emissive.getHex(); m.userData.thermalI = m.emissiveIntensity; m.emissive.setRGB(1, 0.95, 0.85); m.emissiveIntensity = 1.6; }
        else if (!hot && m.userData.thermalE !== undefined) { m.emissive.setHex(m.userData.thermalE); m.emissiveIntensity = m.userData.thermalI; delete m.userData.thermalE; }
      });
    }
  }

  addActor(a: Actor) { this.actors.push(a); if (a.kind === 'soldier') this.soldiers.push(a as Soldier); }
  removeActor(a: Actor) { this.actors = this.actors.filter((x) => x !== a); this.soldiers = this.soldiers.filter((x) => x !== a); }

  // ------------------------------------------------------------------ combat events
  explode(p: THREE.Vector3, radius: number, damage: number, attacker: Actor | null, weapon = 'explosive') {
    this.effects.explosion(p, radius / 7);
    const d = p.distanceTo(this.audio.listener);
    this.audio.play(d > 120 ? 'explosion_far' : radius > 7 ? 'explosion_large' : 'explosion_medium', { pos: p, volume: 1, maxDist: 900 });
    if (d < 40) { this.player?.shake(Math.max(0, 1 - d / 40) * 1.2); this.input.rumble(1 - d / 40, 1 - d / 40, 400); }
    for (const a of this.actorsNear(p, radius)) {
      const dist = a.pos.distanceTo(p);
      const k = 1 - dist / radius;
      if (k <= 0) continue;
      // simple occlusion test
      const eye = a.eyePos(new THREE.Vector3());
      const dir = eye.clone().sub(p); const len = dir.length(); dir.normalize();
      const hit = this.physics.raycast(p.clone().addScaledVector(dir, 0.2), dir, Math.max(0, len - 0.4));
      const occl = hit ? 0.35 : 1;
      const dealt = a.damage(damage * k * occl, { attacker, weapon, explosive: true, dir, point: p.clone() });
      if (attacker?.isPlayer && dealt > 0) this.onPlayerHit(a, dealt, 'body', !a.alive || a.downed);
    }
    for (const v of this.vehicles) {
      const dist = v.model.position.distanceTo(p);
      if (dist < radius + 2) { v.damage(damage * 3 * (1 - dist / (radius + 2)), attacker); v.body.applyImpulse(v.model.position.clone().sub(p).normalize().multiplyScalar(v.def.mass * 2 * (1 - dist / (radius + 2))), true); }
    }
    for (const dd of [...this.destructibles.values()]) {
      const op = dd.obj.getWorldPosition(new THREE.Vector3());
      if (op.distanceTo(p) < radius) this.breakDestructible(dd, op);
    }
  }

  onDeath(a: Actor, info: DamageInfo) {
    const killer = info.attacker;
    if (killer && killer !== a) { killer.kills++; killer.score += a.kind === 'zombie' ? 60 : 100; }
    this.bus.emit('kill', { victim: a, killer, info });
    this.mode?.onKill(a, info);
  }

  onPlayerHit(target: Actor, dealt: number, zone: HitZone, kill: boolean) {
    this.bus.emit('hitmarker', { target, dealt, zone, kill, armor: target.armor > 0 });
    this.audio.play(kill ? 'bone_crack' : 'splat', { volume: kill ? 0.5 : 0.25, throttle: 40 });
    this.input.rumble(0.15, 0.35, 60);
  }

  // ------------------------------------------------------------------ weapon visuals
  weaponModel(w: Weapon): Promise<THREE.Object3D> {
    const key = w.def.id + '|' + w.attachments.join(',');
    let p = this.weaponModels.get(key);
    if (!p) {
      p = this.buildWeaponModel(w);
      this.weaponModels.set(key, p);
    }
    return p.then((o) => { const c = o.clone(true); c.userData = { muzzle: (o.userData.muzzle as THREE.Vector3).clone(), box: (o.userData.box as THREE.Box3).clone() }; return c; });
  }

  private async buildWeaponModel(w: Weapon): Promise<THREE.Object3D> {
    const g = new THREE.Group();
    let gun: THREE.Object3D;
    if (w.def.model.startsWith('kit:')) {
      const piece = await this.assets.kitPiece('guns', w.def.model.slice(4));
      // kit guns point +X; rotate so muzzle faces +Z and scale to the defined length
      const s = piece.userData.size as THREE.Vector3;
      const inner = new THREE.Group(); inner.add(piece);
      inner.rotation.y = -Math.PI / 2;
      inner.scale.setScalar(w.def.length / Math.max(s.x, 1e-3));
      const wrap = new THREE.Group(); wrap.add(inner);
      wrap.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(wrap);
      inner.position.sub(b.getCenter(new THREE.Vector3()));
      gun = wrap;
    } else {
      gun = await this.assets.instance(w.def.model);
      const b = new THREE.Box3().setFromObject(gun);
      gun.position.sub(b.getCenter(new THREE.Vector3()));
    }
    g.add(gun);
    g.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(g);
    g.userData.muzzle = new THREE.Vector3(0, box.max.y * 0.35, box.max.z);
    g.userData.box = box;
    // gunsmith attachments from the Quaternius accessory kit (modelled along +X like the guns)
    const len = w.def.length;
    for (const id of w.attachments) {
      const a = attachmentById(id);
      if (!a?.piece) continue;
      try {
        const piece = await this.assets.kitPiece('attachments', a.piece);
        const inner = new THREE.Group(); inner.add(piece); inner.rotation.y = -Math.PI / 2;
        const holder = new THREE.Group(); holder.add(inner);
        holder.updateMatrixWorld(true);
        const raw = new THREE.Box3().setFromObject(holder);
        const rs = raw.getSize(new THREE.Vector3());
        const target = a.slot === 'optic' ? len * 0.3 : a.slot === 'muzzle' ? len * 0.28 : a.slot === 'underbarrel' ? len * 0.14 : a.slot === 'stock' ? len * 0.3 : len * 0.18;
        const k = target / Math.max(rs.x, rs.y, rs.z, 1e-4);
        holder.scale.setScalar(k);
        holder.updateMatrixWorld(true);
        const ab = new THREE.Box3().setFromObject(holder);
        const ac = ab.getCenter(new THREE.Vector3());
        const off = new THREE.Vector3(-ac.x, 0, -ac.z);
        if (a.slot === 'optic') off.add(new THREE.Vector3(0, box.max.y - ab.min.y - 0.004, box.max.z * 0.05));
        else if (a.slot === 'muzzle') { off.add(new THREE.Vector3(0, box.max.y * 0.35 - ac.y, box.max.z + (ab.max.z - ab.min.z) * 0.45)); g.userData.muzzle.z += ab.max.z - ab.min.z; }
        else if (a.slot === 'underbarrel') off.add(new THREE.Vector3(0, box.min.y - ab.max.y + 0.01, box.max.z - len * 0.3));
        else if (a.slot === 'laser') off.add(new THREE.Vector3(box.max.x + 0.01 - ab.min.x, box.max.y * 0.1 - ac.y, box.max.z - len * 0.28));
        else if (a.slot === 'stock') off.add(new THREE.Vector3(0, -ac.y, box.min.z - (ab.max.z - ab.min.z) * 0.4));
        holder.position.copy(off);
        holder.userData.slot = a.slot;
        holder.name = 'att_' + a.slot;
        g.add(holder);
      } catch { /* missing piece */ }
    }
    g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; } });
    return g;
  }

  // ------------------------------------------------------------------ loop
  fixedUpdate(dt: number) {
    for (const v of this.vehicles) { if (this.net?.isRemoteVehicle(v)) continue; v.prePhysics(dt, v.driver ? this.vehicleControls.get(v) ?? null : null); }
    this.physics.step();
    for (const v of this.vehicles) v.postPhysics(dt);
    this.ballistics.update(dt);
  }

  update(dt: number) {
    this.time += dt;
    for (const u of this.updaters) u(dt);
    this.mode?.update(dt);
    this.net?.update(dt);
    const cam = this.engine.camera;
    const focus = this.player?.soldier.pos ?? cam.position;
    wind.uTime.value += dt;
    wind.uStrength.value = this.sky.weather === 'rain' ? 1.8 : this.sky.weather === 'overcast' ? 1.3 : 1;
    this.sky.update(dt, focus);
    this.water.update(this.time, this.sky.sunDir, this.sky.fog, this.sky.brightness, cam.position);
    this.effects.update(dt);
    this.ambient?.update(dt);
    this.audio.updateListener(cam);
  }

  nearestInteractable(p: THREE.Vector3, dir?: THREE.Vector3): Interactable | null {
    let best: Interactable | null = null, bd = 1e9;
    for (const it of this.interactables) {
      if (!it.enabled()) continue;
      const d = it.pos.distanceTo(p);
      if (d > it.radius) continue;
      let score = d;
      if (dir) { const to = it.pos.clone().sub(p).setY(0).normalize(); score -= to.dot(dir) * 1.5; }
      if (score < bd) { bd = score; best = it; }
    }
    return best;
  }

  dispose() {
    if (this.thermalOn) { this.thermalT = 0; this.setThermal(false); }
    this.net?.dispose(); this.net = null;
    this.ambient?.dispose();
    for (const v of [...this.vehicles]) v.dispose();
    for (const s of this.soldiers) s.dispose();
    this.actors.forEach((a) => (a as any).dispose?.());
    this.vehicles = []; this.actors = []; this.soldiers = []; this.interactables = []; this.updaters = [];
    this.scene.clear();
    this.physics.dispose();
    this.bus.clear();
  }
}
