import * as THREE from 'three';
import type { GameWorld } from './GameWorld';
import type { Soldier } from '../entities/Soldier';
import { Weapon } from '../weapons/Weapon';
import { LOOT_WEAPONS, RARITY, type Rarity } from '../weapons/WeaponDefs';
import { Rng } from '../world/Noise';

export type LootKind = 'weapon' | 'ammo' | 'armor' | 'plate' | 'medkit' | 'syringe' | 'grenade' | 'cash';
export interface LootItem {
  id: number; kind: LootKind; pos: THREE.Vector3; rarity: Rarity; weapon?: Weapon; amount: number; ammoType?: string;
  obj: THREE.Object3D | null; beam: THREE.Mesh | null; taken: boolean; base: number;
}

const BEAM_VS = 'varying float vY; void main(){ vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }';
const BEAM_FS = 'uniform vec3 color; uniform float time; varying float vY; void main(){ float a = (1.0 - vY) * 0.55 * (0.8 + 0.2 * sin(time * 3.0 + vY * 6.0)); gl_FragColor = vec4(color, a); }';

/**
 * Ground loot with Fortnite/Borderlands-style rarity light beams, death-crate drops and
 * supply-drop contents. Bots query it for nearby pickups.
 */
export class LootSystem {
  items: LootItem[] = [];
  private w: GameWorld;
  private next = 1;
  private beamGeo = new THREE.CylinderGeometry(0.09, 0.22, 7, 8, 1, true).translate(0, 3.5, 0);
  private beamMats = RARITY.map((r) => new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(r.color) }, time: { value: 0 } },
    vertexShader: BEAM_VS, fragmentShader: BEAM_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  }));
  rng = new Rng(77);
  highTier = false;
  sniperOnly = false;
  cqbOnly = false;

  constructor(w: GameWorld) {
    this.w = w;
    w.updaters.push((dt) => this.update(dt));
  }

  rollRarity(bonus = 0): Rarity {
    const r = this.rng.next() + bonus + (this.highTier ? 0.45 : 0);
    return (r > 0.97 ? 4 : r > 0.88 ? 3 : r > 0.7 ? 2 : r > 0.42 ? 1 : 0) as Rarity;
  }

  randomWeapon(rarity?: Rarity): Weapon {
    let pool = LOOT_WEAPONS.filter((w) => w.cls !== 'launcher' || this.rng.chance(0.15));
    if (this.sniperOnly) pool = pool.filter((w) => w.cls === 'sniper' || w.cls === 'marksman' || w.cls === 'pistol');
    if (this.cqbOnly) pool = pool.filter((w) => w.cls === 'smg' || w.cls === 'shotgun' || w.cls === 'pistol');
    const def = this.rng.pick(pool);
    const r = rarity ?? this.rollRarity();
    const atts: string[] = [];
    if (r >= 2) {
      if (def.cls === 'sniper') atts.push('sniperscope');
      else if (def.cls !== 'pistol' && def.cls !== 'shotgun' && def.cls !== 'launcher') atts.push(this.rng.pick(['reddot', 'acog', 'reddot']));
    }
    if (r >= 3 && def.cls !== 'launcher') atts.push(this.rng.pick(['suppressor', 'compensator', 'vgrip', 'extmag']));
    if (r >= 4 && def.cls !== 'launcher') atts.push(this.rng.pick(['extmag', 'fastmag', 'stock']));
    return new Weapon(def.id, r, [...new Set(atts)]);
  }

  /** random item for a loot spot */
  spawnRandom(p: THREE.Vector3, bonus = 0) {
    const roll = this.rng.next();
    if (roll < 0.36) this.spawnWeapon(p, this.randomWeapon(this.rollRarity(bonus)));
    else if (roll < 0.55) this.spawn(p, 'ammo', 0, 1, this.rng.pick(['light', 'heavy', 'shells', 'sniper', 'light', 'heavy']));
    else if (roll < 0.68) this.spawn(p, 'plate', 1, 1 + (this.rng.chance(0.3) ? 1 : 0));
    else if (roll < 0.75) this.spawn(p, 'armor', (2 + (this.rng.chance(0.3) ? 1 : 0)) as Rarity, 1);
    else if (roll < 0.84) this.spawn(p, 'medkit', 1, 1);
    else if (roll < 0.9) this.spawn(p, 'syringe', 2, 1);
    else if (roll < 0.96) this.spawn(p, 'grenade', 1, 2);
    else this.spawn(p, 'cash', 3, 100 + Math.floor(this.rng.next() * 400));
  }

  spawnWeapon(p: THREE.Vector3, wpn: Weapon) { return this.spawn(p, 'weapon', wpn.rarity, 1, undefined, wpn); }

  spawn(p: THREE.Vector3, kind: LootKind, rarity: Rarity, amount: number, ammoType?: string, weapon?: Weapon): LootItem {
    const it: LootItem = { id: this.next++, kind, pos: p.clone(), rarity, amount, ammoType, weapon, obj: null, beam: null, taken: false, base: p.y };
    this.items.push(it);
    this.loadVisual(it);
    this.w.interactables.push({
      pos: it.pos, radius: 2.2,
      label: () => this.label(it),
      enabled: () => !it.taken,
      use: (s) => this.pickup(s, it),
    });
    return it;
  }

  private async loadVisual(it: LootItem) {
    let obj: THREE.Object3D;
    try {
      if (it.kind === 'weapon' && it.weapon) obj = await this.w.weaponModel(it.weapon);
      else {
        const ids: Record<string, string> = { ammo: 'item_ammo', armor: 'item_vest', plate: 'item_vest', medkit: 'item_medkit', syringe: 'item_syringe', grenade: 'w_grenade', cash: 'item_supply' };
        obj = await this.w.assets.instance(ids[it.kind]);
        if (it.kind === 'plate') obj.scale.multiplyScalar(0.6);
        if (it.kind === 'cash') obj.scale.multiplyScalar(0.35);
        if (it.kind === 'grenade') obj.scale.multiplyScalar(1.8);
      }
    } catch {
      obj = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshStandardMaterial({ color: RARITY[it.rarity].color }));
    }
    if (it.taken) return;
    it.obj = obj;
    obj.position.copy(it.pos);
    this.w.scene.add(obj);
    if (it.rarity > 0 || it.kind === 'weapon') {
      it.beam = new THREE.Mesh(this.beamGeo, this.beamMats[it.rarity]);
      it.beam.position.copy(it.pos);
      it.beam.renderOrder = 3;
      this.w.scene.add(it.beam);
    }
  }

  label(it: LootItem): string {
    switch (it.kind) {
      case 'weapon': return `${it.weapon!.name} [${RARITY[it.rarity].name}]`;
      case 'ammo': return `Munition (${it.ammoType})`;
      case 'armor': return `Weste Stufe ${it.rarity}`;
      case 'plate': return `Panzerplatte x${it.amount}`;
      case 'medkit': return 'Medikit';
      case 'syringe': return 'Adrenalin-Spritze';
      case 'grenade': return `Granaten x${it.amount}`;
      case 'cash': return `$${it.amount}`;
    }
  }

  pickup(s: Soldier, it: LootItem) {
    if (it.taken) return;
    switch (it.kind) {
      case 'weapon': {
        const old = s.give(it.weapon!);
        if (old && old.def.cls !== 'melee') {
          this.take(it);
          this.spawnWeapon(s.pos.clone().add(new THREE.Vector3(0.6, 0.2, 0.6)), old);
          if (s.isPlayer) this.w.bus.emit('pickup', { item: it, label: this.label(it) });
          return;
        }
        break;
      }
      case 'ammo': {
        const t = it.ammoType ?? 'light';
        const add: Record<string, number> = { light: 60, heavy: 45, shells: 12, sniper: 8, rockets: 2 };
        s.reserve[t] = (s.reserve[t] ?? 0) + (add[t] ?? 30);
        break;
      }
      case 'armor': if (s.armorTier >= it.rarity) return; s.armorTier = it.rarity; s.armor = Math.max(s.armor, 50); break;
      case 'plate': if (s.plates >= 8) return; s.plates = Math.min(8, s.plates + it.amount); break;
      case 'medkit': if (s.medkits >= 5) return; s.medkits++; break;
      case 'syringe': if (s.syringes >= 3) return; s.syringes++; break;
      case 'grenade': if (s.grenades >= 4) return; s.grenades = Math.min(4, s.grenades + it.amount); break;
      case 'cash': s.cash += it.amount; this.w.audio.play('cash', { pos: s.pos, volume: s.isPlayer ? 0.6 : 0.2 }); break;
    }
    if (s.isPlayer) { this.w.audio.play('ui_select', { volume: 0.5 }); this.w.bus.emit('pickup', { item: it, label: this.label(it) }); }
    this.take(it);
  }

  /** removes the item from the world (picked up) */
  take(it: LootItem) {
    it.taken = true;
    it.obj?.removeFromParent();
    it.beam?.removeFromParent();
    this.items = this.items.filter((x) => x !== it);
    const idx = this.w.interactables.findIndex((x) => x.pos === it.pos);
    if (idx >= 0) this.w.interactables.splice(idx, 1);
  }

  nearestFor(s: Soldier, r: number): LootItem | null {
    let best: LootItem | null = null, bd = r * r;
    for (const it of this.items) {
      const d = it.pos.distanceToSquared(s.pos);
      if (d >= bd) continue;
      const useful = it.kind === 'weapon' ? (!s.weapons[0] || !s.weapons[1] || it.rarity > s.weapon.rarity)
        : it.kind === 'plate' ? s.plates < 5 : it.kind === 'armor' ? s.armorTier < it.rarity : it.kind === 'medkit' ? s.medkits < 2 : it.kind === 'ammo';
      if (useful) { bd = d; best = it; }
    }
    return best;
  }

  /** Warzone-style death crate: scatter the victim's inventory */
  deathDrop(s: Soldier) {
    const p = s.pos.clone();
    let k = 0;
    const at = () => { const a = k++ * 1.3; return p.clone().add(new THREE.Vector3(Math.cos(a) * 0.9, 0.25, Math.sin(a) * 0.9)); };
    for (const w of s.weapons) if (w) this.spawnWeapon(at(), w);
    if (s.plates > 0) this.spawn(at(), 'plate', 1, s.plates);
    if (s.medkits > 0) this.spawn(at(), 'medkit', 1, 1);
    if (s.cash > 0) this.spawn(at(), 'cash', 3, s.cash);
    this.spawn(at(), 'ammo', 0, 1, s.weapon.def.ammo);
  }

  /** care package contents */
  supplyDrop(p: THREE.Vector3) {
    this.spawnWeapon(p.clone().add(new THREE.Vector3(0.8, 0.3, 0)), this.randomWeapon(4));
    this.spawn(p.clone().add(new THREE.Vector3(-0.8, 0.3, 0)), 'plate', 2, 3);
    this.spawn(p.clone().add(new THREE.Vector3(0, 0.3, 0.8)), 'armor', 3, 1);
    this.spawn(p.clone().add(new THREE.Vector3(0, 0.3, -0.8)), 'syringe', 2, 1);
  }

  private t = 0;
  update(dt: number) {
    this.t += dt;
    for (const m of this.beamMats) m.uniforms.time.value = this.t;
    const cam = this.w.engine.camera.position;
    const low = this.w.lowSpec;
    const beamR = low ? 90 : 160, objR = low ? 40 : 80;
    for (const it of this.items) {
      if (!it.obj) continue;
      const d2 = it.pos.distanceToSquared(cam);
      const vis = d2 < beamR * beamR && (!low || it.rarity >= 2 || d2 < objR * objR);
      it.obj.visible = d2 < objR * objR;
      if (it.beam) it.beam.visible = vis;
      if (it.obj.visible) { it.obj.rotation.y += dt * 0.8; it.obj.position.y = it.base + 0.25 + Math.sin(this.t * 2 + it.id) * 0.06; }
    }
  }

  clear() { for (const it of [...this.items]) this.take(it); }
}
