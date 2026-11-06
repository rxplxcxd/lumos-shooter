import * as THREE from 'three';
import { SoldierMode, TEAM_COLORS } from '../SoldierMode';
import type { ModeOptions, HudInfo } from '../Mode';
import type { GameWorld } from '../GameWorld';
import { buildBRMap, type MapInfo } from '../../world/Maps';
import { LootSystem } from '../Loot';
import type { Actor, DamageInfo } from '../types';
import type { Soldier } from '../../entities/Soldier';
import { Zombie } from '../../entities/Zombie';
import { QUALITY_PRESETS, settings } from '../../core/Settings';
import { Weapon } from '../../weapons/Weapon';

interface Phase { wait: number; shrink: number; r: number; dps: number }
const PHASES: Phase[] = [
  { wait: 75, shrink: 50, r: 430, dps: 1 }, { wait: 55, shrink: 45, r: 270, dps: 2 }, { wait: 45, shrink: 40, r: 160, dps: 4 },
  { wait: 35, shrink: 30, r: 90, dps: 6 }, { wait: 25, shrink: 25, r: 40, dps: 9 }, { wait: 20, shrink: 25, r: 0, dps: 12 },
];

/**
 * Battle Royale (Solos/Duos/Trios/Quads, Sniper-only, CQB, High-Tier, Extraction) and the
 * Zombie Royale variant: drop plane, freefall + parachute, shrinking storm, loot, buy
 * stations, supply drops, UAV, DBNO + revives, death crates, placement.
 */
export class BattleRoyale extends SoldierMode {
  readonly id: string;
  readonly name: string;
  map!: MapInfo;
  loot!: LootSystem;
  teamSize = 1;
  zombies: Zombie[] = [];
  zombieMode: boolean;
  // storm
  zone = { x: 0, z: 0, r: 780 };
  next = { x: 0, z: 0, r: 430 };
  from = { x: 0, z: 0, r: 780 };
  phase = 0;
  phaseT = 0;
  shrinking = false;
  private stormMesh!: THREE.Mesh;
  // plane
  plane: THREE.Object3D | null = null;
  planeStart = new THREE.Vector3();
  planeEnd = new THREE.Vector3();
  planeT = 0;
  planeDur = 55;
  inFlight: Set<Soldier> = new Set();
  private botDrop = new Map<Soldier, number>();
  uavUntil = 0;
  extraction: { pos: THREE.Vector3; active: boolean; progress: number }[] = [];
  placement = 0;
  private aliveTeamsAtDeath = 0;

  constructor(w: GameWorld, opts: ModeOptions & { zombies?: boolean } = {}) {
    super(w, opts);
    this.zombieMode = !!opts.zombies;
    this.id = this.zombieMode ? 'zombieroyale' : 'br';
    const sub = opts.sub ?? 'solos';
    this.teamSize = { solos: 1, duos: 2, trios: 3, quads: 4 }[sub] ?? 1;
    this.name = this.zombieMode ? 'Zombie Royale' : `Battle Royale – ${sub[0].toUpperCase() + sub.slice(1)}`;
    this.allowDBNO = this.teamSize > 1;
    this.healthRegen = true;
  }

  zoneTarget() { return this.next; }
  outsideZone(p: THREE.Vector3, k = 1) { return Math.hypot(p.x - this.next.x, p.z - this.next.z) > this.next.r * k && this.phase > 0; }

  async setup(progress: (p: number, l: string) => void) {
    const w = this.w;
    this.map = await buildBRMap(w, 4242, (p, l) => progress(p * 0.8, l));
    this.loot = new LootSystem(w);
    (w as any).loot = this.loot;
    const sub = this.opts.sub ?? 'solos';
    this.loot.highTier = sub === 'hightier';
    this.loot.sniperOnly = sub === 'sniper';
    this.loot.cqbOnly = sub === 'cqb';
    progress(0.82, 'Loot');
    const cap = { potato: 260, low: 380, medium: 520, high: 700 }[settings.data.quality];
    const spots = [...this.map.lootSpots].sort(() => this.rng.next() - 0.5).slice(0, cap);
    for (const p of spots) this.loot.spawnRandom(p);
    // buy stations at the big POIs
    for (const poi of this.map.pois.filter((p) => p.tier >= 2)) this.addBuyStation(new THREE.Vector3(poi.x + 8, poi.h, poi.z + 8));
    // storm visual
    this.stormMesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 400, 96, 1, true), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { time: { value: 0 } },
      vertexShader: 'varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: 'uniform float time; varying vec2 vUv; varying vec3 vW; void main(){ float s = 0.5 + 0.5 * sin(vUv.x * 200.0 + time * 2.0 + vUv.y * 20.0); float a = 0.35 + 0.15 * s; gl_FragColor = vec4(0.55, 0.15, 0.85, a * smoothstep(1.0, 0.6, vUv.y)); }',
    }));
    this.stormMesh.position.y = 150;
    this.stormMesh.renderOrder = 4;
    w.scene.add(this.stormMesh);
    // plane path across the island
    const ang = this.rng.next() * Math.PI * 2;
    this.planeStart.set(Math.cos(ang) * 820, 430, Math.sin(ang) * 820);
    this.planeEnd.set(-Math.cos(ang + 0.4) * 820, 430, -Math.sin(ang + 0.4) * 820);
    this.plane = await w.assets.instance('plane_cargo');
    w.scene.add(this.plane);
    // soldiers
    progress(0.86, 'Spieler');
    this.listenShots();
    // everyone lands with a sidearm (Warzone style)
    w.bus.on('landed', (s: Soldier) => { if (!s.weapons[0] && !s.weapons[1]) { s.weapons[1] = new Weapon(this.loot.sniperOnly ? 'viper' : 'viper', 0); s.current = 1; s.reserve.light = Math.max(s.reserve.light, 24); } });
    const total = { potato: 40, low: 60, medium: 100, high: 100 }[settings.data.quality];
    const teams = Math.ceil(total / this.teamSize);
    const pc = await this.spawnPlayer(this.planeStart.clone(), 0);
    pc.inPlane = true;
    this.inFlight.add(pc.soldier);
    pc.soldier.frozen = true;
    pc.soldier.collider?.setEnabled(false);
    pc.soldier.weapons = [null, null];
    pc.soldier.current = 2;
    for (let i = 1; i < total; i++) {
      const team = Math.floor(i / this.teamSize);
      const b = await this.spawnBot(team, this.planeStart.clone(), undefined, team === 0 ? 0x2ecc71 : TEAM_COLORS[(team % (TEAM_COLORS.length - 1)) + 1]);
      b.s.weapons = [null, null]; b.s.current = 2;
      b.s.collider?.setEnabled(false);
      b.s.model.setVisible(false);
      this.inFlight.add(b.s);
      b.s.frozen = true;
      this.botDrop.set(b.s, 0.1 + this.rng.next() * 0.8);
      const target = this.rng.pick(this.map.pois);
      b.dropTarget = new THREE.Vector3(target.x + this.rng.range(-target.r, target.r) * 0.7, 0, target.z + this.rng.range(-target.r, target.r) * 0.7);
      b.home.copy(b.dropTarget);
      if (i % 10 === 0) progress(0.86 + (i / total) * 0.12, `Bots ${i}/${total}`);
    }
    void teams;
    if (this.zombieMode) await this.spawnZombieHordes();
    if (this.opts.sub === 'extraction') {
      for (const poi of [this.map.pois[1], this.map.pois[3], this.map.pois[2]]) this.extraction.push({ pos: new THREE.Vector3(poi.x, poi.h, poi.z), active: false, progress: 0 });
    }
    w.audio.playMusic('drop');
    w.effects.warm(pc.soldier.pos);
    progress(1, 'Bereit');
  }

  private async spawnZombieHordes() {
    const per = { potato: 3, low: 4, medium: 6, high: 8 }[settings.data.quality];
    for (const poi of this.map.pois) {
      for (let i = 0; i < per; i++) {
        const z = new Zombie(this.w, this.rng.chance(0.15) ? 'runner' : this.rng.chance(0.1) ? 'brute' : 'walker', 220, this.rng.chance(0.2) ? 4.5 : 1.3);
        await z.init();
        const x = poi.x + this.rng.range(-poi.r, poi.r) * 0.6, zz = poi.z + this.rng.range(-poi.r, poi.r) * 0.6;
        z.spawn(new THREE.Vector3(x, this.w.terrain.getHeight(x, zz), zz));
        z.onDeath = (zz2) => { setTimeout(() => this.respawnZombie(zz2, poi), 30000); if (this.rng.chance(0.25)) this.loot.spawnRandom(zz2.pos.clone()); };
        this.w.addActor(z);
        this.zombies.push(z);
      }
    }
  }

  private respawnZombie(z: Zombie, poi: { x: number; z: number; r: number }) {
    if (this.over) return;
    z.alive = true; z.health = z.maxHealth; z.headless = false; z.crawler = false; z.deadT = 0;
    z.model.inner.traverse((o) => { if (o.name === 'Head' || o.name.startsWith('calf_')) o.scale.setScalar(1); });
    z.collider?.setEnabled(true);
    const x = poi.x + this.rng.range(-poi.r, poi.r) * 0.6, zz = poi.z + this.rng.range(-poi.r, poi.r) * 0.6;
    z.spawn(new THREE.Vector3(x, this.w.terrain.getHeight(x, zz), zz));
  }

  private addBuyStation(p: THREE.Vector3) {
    const w = this.w;
    w.assets.instance('env_vending2').then((m) => { m.position.copy(p); m.position.y = w.terrain.getHeight(p.x, p.z); w.root.add(m); });
    w.interactables.push({
      pos: p.clone().setY(w.terrain.getHeight(p.x, p.z) + 1), radius: 2.5,
      label: () => 'Kaufstation öffnen', enabled: () => true,
      use: () => w.bus.emit('openBuy', this),
    });
  }

  /** buy-station purchases (called by the HUD buy menu) */
  buy(item: string): boolean {
    const s = this.w.player?.soldier;
    if (!s) return false;
    const prices: Record<string, number> = { plates: 500, uav: 3500, supply: 6000, revive: 4500, loadout: 9000, armor: 3000 };
    const price = prices[item];
    if (s.cash < price) { this.w.audio.ui('error'); return false; }
    s.cash -= price;
    this.w.audio.play('cash');
    switch (item) {
      case 'plates': s.plates = Math.min(8, s.plates + 3); break;
      case 'armor': s.armorTier = 3; s.armor = 150; break;
      case 'uav': this.uavUntil = this.w.time + 40; this.w.bus.emit('toast', 'UAV aktiv – Gegner auf dem Radar'); break;
      case 'supply': this.callSupplyDrop(s.pos.clone().add(new THREE.Vector3(8, 0, 8))); break;
      case 'revive': {
        const mate = this.w.soldiers.find((o) => o.team === s.team && !o.alive);
        if (mate) { mate.spawnAt(s.pos.clone().add(new THREE.Vector3(0, 300, 0))); mate.freefall = true; mate.collider?.setEnabled(true); this.giveRandomKit(mate, 1); this.w.bus.emit('toast', `${mate.name} wird neu abgesetzt`); }
        break;
      }
      case 'loadout': {
        if (this.loadout) this.applyLoadout(s, this.loadout);
        this.w.bus.emit('toast', 'Loadout-Drop erhalten');
        break;
      }
    }
    return true;
  }

  async callSupplyDrop(p: THREE.Vector3) {
    const w = this.w;
    const crate = await w.assets.instance('item_supply');
    const chute = await w.assets.instance('item_parachute');
    crate.scale.setScalar(1.8);
    const ground = w.terrain.getHeight(p.x, p.z);
    crate.position.set(p.x, ground + 160, p.z);
    chute.position.copy(crate.position).add(new THREE.Vector3(0, 2.5, 0));
    w.scene.add(crate, chute);
    w.bus.emit('toast', 'Versorgungsabwurf unterwegs');
    w.audio.play('smoke_hiss', { pos: p, volume: 0.5 });
    const upd = (dt: number) => {
      if (crate.position.y > ground + 0.1) {
        crate.position.y = Math.max(ground, crate.position.y - dt * 9);
        chute.position.copy(crate.position).add(new THREE.Vector3(0, 2.5, 0));
        if (Math.random() < 0.5) w.effects.smoke(new THREE.Vector3(p.x, ground + 0.5, p.z), 0xff3020, 1);
      } else if (chute.parent) {
        chute.removeFromParent();
        w.audio.play('land_heavy', { pos: crate.position, volume: 0.9 });
        this.loot.supplyDrop(crate.position.clone().setY(ground));
        w.updaters = w.updaters.filter((u) => u !== upd);
      }
    };
    w.updaters.push(upd);
  }

  private dropSoldier(s: Soldier) {
    this.inFlight.delete(s);
    s.frozen = false;
    s.pos.copy(this.plane!.position).add(new THREE.Vector3(0, -6, 0));
    s.vel.set(0, -5, 0);
    s.freefall = true;
    s.parachute = false;
    s.collider?.setEnabled(true);
    s.body?.setTranslation(s.capsuleCenter(), true);
    s.model.setVisible(true);
    if (s.isPlayer) { this.w.player!.inPlane = false; this.w.bus.emit('toast', 'Freifall! [SPACE] Fallschirm'); }
  }

  update(dt: number) {
    const w = this.w;
    if (this.over && !w.player?.soldier.alive) { this.tickSoldiers(dt); return; }
    // ---------------------------------------------------------- plane
    if (this.plane && this.plane.parent) {
      this.planeT += dt / this.planeDur;
      const k = Math.min(this.planeT, 1);
      this.plane.position.lerpVectors(this.planeStart, this.planeEnd, k);
      const dir = this.planeEnd.clone().sub(this.planeStart).normalize();
      this.plane.rotation.y = Math.atan2(dir.x, dir.z);
      for (const s of [...this.inFlight]) {
        s.pos.copy(this.plane.position);
        s.body?.setNextKinematicTranslation(s.capsuleCenter());
        if (!s.isPlayer && k > (this.botDrop.get(s) ?? 0.5)) {
          // bots jump when closest to their target
          const b = this.bots.find((bb) => bb.s === s);
          const tgt = b?.dropTarget;
          if (!tgt || this.plane.position.clone().setY(0).distanceTo(tgt) < 260 || k > 0.95) this.dropSoldier(s);
        }
        if (s.isPlayer && (w.input.pressed('jump') || w.input.pressed('interact') || k >= 0.98)) this.dropSoldier(s);
      }
      const p = w.player;
      if (p && p.inPlane) {
        const cam = w.engine.camera;
        const off = new THREE.Vector3(0, 12, -38).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.plane.rotation.y + p.yaw * 0.3);
        cam.position.copy(this.plane.position).add(off);
        cam.lookAt(this.plane.position);
        p.update(dt);
      }
      if (k >= 1) { this.plane.removeFromParent(); w.audio.playMusic('tension'); }
    }
    // ---------------------------------------------------------- storm
    this.phaseT += dt;
    const ph = PHASES[Math.min(this.phase, PHASES.length - 1)];
    if (this.planeT >= 0.5 && this.phase < PHASES.length) {
      if (!this.shrinking && this.phaseT > ph.wait) {
        this.shrinking = true; this.phaseT = 0; this.from = { ...this.zone };
        w.bus.emit('toast', 'Die Zone zieht sich zusammen!');
        w.audio.play('ui_popup_open');
      } else if (this.shrinking) {
        const k = Math.min(1, this.phaseT / ph.shrink);
        this.zone.x = THREE.MathUtils.lerp(this.from.x, this.next.x, k);
        this.zone.z = THREE.MathUtils.lerp(this.from.z, this.next.z, k);
        this.zone.r = THREE.MathUtils.lerp(this.from.r, this.next.r, k);
        if (k >= 1) {
          this.shrinking = false; this.phaseT = 0; this.phase++;
          const np = PHASES[Math.min(this.phase, PHASES.length - 1)];
          const ang = this.rng.next() * Math.PI * 2, off = Math.max(0, this.zone.r - np.r) * this.rng.next() * 0.8;
          this.next = { x: this.zone.x + Math.cos(ang) * off, z: this.zone.z + Math.sin(ang) * off, r: np.r };
          if (this.phase === 2) for (const e of this.extraction) e.active = true;
          if (this.phase >= 1 && this.phase <= 4) this.callSupplyDrop(new THREE.Vector3(this.next.x + this.rng.range(-0.5, 0.5) * this.next.r, 0, this.next.z + this.rng.range(-0.5, 0.5) * this.next.r));
        }
      }
    }
    this.stormMesh.visible = this.phase > 0 || this.shrinking;
    this.stormMesh.scale.set(Math.max(this.zone.r, 1), 1, Math.max(this.zone.r, 1));
    this.stormMesh.position.set(this.zone.x, 150, this.zone.z);
    (this.stormMesh.material as THREE.ShaderMaterial).uniforms.time.value = w.time;
    // storm damage (ticks once per second)
    this.stormTick += dt;
    if (this.stormTick > 1 && (this.phase > 0 || this.shrinking)) {
      this.stormTick = 0;
      for (const s of w.soldiers) {
        if (!s.alive || this.inFlight.has(s) || s.freefall) continue;
        if (Math.hypot(s.pos.x - this.zone.x, s.pos.z - this.zone.z) > this.zone.r) s.damage(ph.dps * (s.downed ? 2 : 4), { storm: true });
      }
    }
    const pl = w.player?.soldier;
    if (pl) w.engine.damageVignette = Math.max(w.engine.damageVignette * 0.95, Math.hypot(pl.pos.x - this.zone.x, pl.pos.z - this.zone.z) > this.zone.r && pl.alive && (this.phase > 0 || this.shrinking) && !pl.freefall ? 0.5 : 0);
    // ---------------------------------------------------------- extraction
    for (const e of this.extraction) {
      if (!e.active || !pl?.alive) continue;
      if (pl.pos.distanceTo(e.pos) < 12) {
        e.progress += dt;
        if (e.progress > 12) this.finish(true, 'EXTRAHIERT! Beute gesichert', 1);
      } else e.progress = Math.max(0, e.progress - dt);
    }
    // ---------------------------------------------------------- actors
    this.tickSoldiers(dt);
    for (const z of this.zombies) z.update(dt);
    this.checkEnd();
    if (pl && !pl.alive) { pl.model.update(dt, 5); }
  }
  private stormTick = 0;

  aliveTeams() {
    const t = new Set<number>();
    for (const s of this.w.soldiers) if (s.alive) t.add(s.team);
    return t;
  }

  private checkEnd() {
    if (this.over) return;
    const teams = this.aliveTeams();
    const me = this.w.player?.soldier;
    if (!me) return;
    const myTeamAlive = this.w.soldiers.some((s) => s.team === me.team && s.alive && !s.downed);
    if (!myTeamAlive && !this.w.soldiers.some((s) => s.team === me.team && s.alive)) {
      this.placement = this.aliveTeamsAtDeath || teams.size + 1;
      this.finish(false, `Platz #${this.placement}`, this.placement);
    } else if (teams.size === 1 && teams.has(me.team) && this.planeT > 1) {
      this.finish(true, this.zombieMode ? 'LETZTER ÜBERLEBENDER!' : 'SIEG! #1', 1);
      this.w.audio.playMusic('victory');
    }
  }

  onKill(victim: Actor, info: DamageInfo) {
    super.onKill(victim, info);
    if (victim.kind === 'soldier') {
      const s = victim as Soldier;
      this.loot.deathDrop(s);
      if (s.isPlayer) this.aliveTeamsAtDeath = this.aliveTeams().size + (this.w.soldiers.some((o) => o.team === s.team && o.alive) ? 0 : 1);
      if ((info.attacker as Soldier)?.isPlayer) (info.attacker as Soldier).cash += 300;
      // zombie royale: fallen soldiers rise again
      if (this.zombieMode && this.rng.chance(0.5)) {
        setTimeout(async () => {
          if (this.over) return;
          const z = new Zombie(this.w, 'runner', 250, 3.8);
          await z.init(); z.spawn(s.pos.clone()); this.w.addActor(z); this.zombies.push(z);
        }, 4000);
      }
    }
  }

  hud(): HudInfo {
    const ph = PHASES[Math.min(this.phase, PHASES.length - 1)];
    const t = this.shrinking ? ph.shrink - this.phaseT : ph.wait - this.phaseT;
    const ex = this.extraction.find((e) => e.active);
    return {
      title: this.name,
      alive: this.w.soldiers.filter((s) => s.alive).length,
      timer: Math.max(0, t),
      objective: this.w.player?.inPlane ? 'Springe ab: [SPACE] / Ⓐ' : this.shrinking ? 'Zone schrumpft – bewege dich!' : ex ? `Extraktion verfügbar: ${Math.round(ex.pos.x)}, ${Math.round(ex.pos.z)}` : `Zone ${this.phase + 1}`,
      zone: { x: this.zone.x, z: this.zone.z, r: this.zone.r, nx: this.next.x, nz: this.next.z, nr: this.next.r, shrinking: this.shrinking, next: t },
    };
  }

  extractedLoot() {
    const s = this.w.player?.soldier;
    return (s?.weapons.filter(Boolean) as Weapon[] ?? []).map((w) => ({ id: w.def.id, rarity: w.rarity, attachments: w.attachments }));
  }

  /** bots render dots on the minimap during UAV */
  get uavActive() { return this.w.time < this.uavUntil; }
  get drawDistance() { return QUALITY_PRESETS[settings.data.quality].drawDistance; }
}
