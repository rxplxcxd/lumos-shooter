import { WEAPONS, RARITY, attachmentById, type WeaponDef, type Rarity } from './WeaponDefs';

export interface WeaponStats extends WeaponDef { silenced: boolean; thermal: boolean }

/** A concrete weapon in an inventory: base def + rarity tier + gunsmith attachments + ammo state. */
export class Weapon {
  def: WeaponDef;
  rarity: Rarity;
  attachments: string[];
  stats!: WeaponStats;
  ammo = 0;
  cooldown = 0;
  reloading = 0;
  bloom = 0;
  burstLeft = 0;
  packed = false; // Pack-a-Punch

  constructor(id: string, rarity: Rarity = 0, attachments: string[] = []) {
    this.def = WEAPONS[id] ?? WEAPONS.kestrel;
    this.rarity = rarity;
    this.attachments = attachments;
    this.recompute();
    this.ammo = this.stats.mag;
  }

  recompute() {
    const r = RARITY[this.rarity];
    const s: WeaponStats = { ...this.def, silenced: false, thermal: false };
    s.damage *= r.dmg;
    s.mag = Math.max(1, Math.round(s.mag * r.mag));
    for (const id of this.attachments) {
      const a = attachmentById(id);
      if (!a) continue;
      const m = a.mods;
      if (m.adsFov) s.adsFov *= m.adsFov;
      if (m.adsTime) s.adsTime *= m.adsTime;
      if (m.recoilV) s.recoilV *= m.recoilV;
      if (m.recoilH) s.recoilH *= m.recoilH;
      if (m.hipSpread) s.hipSpread *= m.hipSpread;
      if (m.mag) s.mag = Math.round(s.mag * m.mag);
      if (m.reload) s.reload *= m.reload;
      if (m.velocity) s.velocity *= m.velocity;
      if (m.range) s.range *= m.range;
      if (m.moveMul) s.moveMul *= m.moveMul;
      if (m.silenced) s.silenced = true;
      if (m.thermal) s.thermal = true;
      if (m.scope) s.scope = true;
    }
    if (this.packed) { s.damage *= 2; s.mag = Math.round(s.mag * 1.5); s.rpm *= 1.1; }
    this.stats = s;
  }

  get name() { return (this.packed ? '✦ ' : '') + this.def.name; }
  get color() { return RARITY[this.packed ? 5 : this.rarity].color; }
  get interval() { return 60 / this.stats.rpm; }
  canFire() { return this.cooldown <= 0 && this.reloading <= 0 && (this.ammo > 0 || this.def.cls === 'melee'); }

  update(dt: number, moving: boolean, ads: boolean) {
    this.cooldown -= dt;
    const recover = ads ? 6 : 4;
    this.bloom = Math.max(0, this.bloom - dt * recover * (moving ? 0.5 : 1));
  }

  /** current cone half-angle in degrees */
  spread(ads: number, moving: number, airborne: boolean, crouch: boolean) {
    const s = this.stats;
    let base = s.hipSpread + (s.adsSpread - s.hipSpread) * ads;
    base *= 1 + moving * (1 - ads * 0.7) * 0.8;
    if (airborne) base *= 2.2;
    if (crouch) base *= 0.75;
    return base + this.bloom;
  }

  pack() { this.packed = true; this.recompute(); this.ammo = this.stats.mag; }
}
