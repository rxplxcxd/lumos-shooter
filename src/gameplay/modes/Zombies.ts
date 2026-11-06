import * as THREE from 'three';
import { SoldierMode } from '../SoldierMode';
import type { ModeOptions, HudInfo } from '../Mode';
import type { GameWorld } from '../GameWorld';
import { buildZombieOutpost, type MapInfo, type ZRoom, type ZDoor } from '../../world/Maps';
import { Zombie, NavGrid, type ZombieType } from '../../entities/Zombie';
import { Weapon } from '../../weapons/Weapon';
import { LOOT_WEAPONS, WEAPONS } from '../../weapons/WeaponDefs';
import type { Actor, DamageInfo } from '../types';
import type { Soldier } from '../../entities/Soldier';
import { settings } from '../../core/Settings';

const PERKS: Record<string, { name: string; cost: number; desc: string; color: string }> = {
  juggernog: { name: 'Juggernog', cost: 2500, desc: 'Doppelte Lebenspunkte', color: '#e74c3c' },
  quickrevive: { name: 'Quick Revive', cost: 1500, desc: 'Schnelle Heilung / Selbst-Revive', color: '#3498db' },
  speedcola: { name: 'Speed Cola', cost: 3000, desc: '50% schneller nachladen', color: '#2ecc71' },
  doubletap: { name: 'Double Tap', cost: 2000, desc: 'Höhere Feuerrate', color: '#f39c12' },
  staminup: { name: 'Stamin-Up', cost: 2000, desc: 'Schneller sprinten', color: '#f1c40f' },
};

const LOGS = [
  'LOG 1 – Dr. Vance: "Die Probe aus dem Lumos-Krater reagiert auf Strom. Die Toten… bewegen sich."',
  'LOG 2 – Sgt. Ortiz: "Wir haben die Kaserne versiegelt. Wenn jemand das hört: Generator starten, Notsignal senden!"',
  'LOG 3 – Unbekannt: "Das Notsignal ruft den Evakuierungs-Heli. Aber es lockt auch SIE an. Haltet durch."',
];

/**
 * Round-based co-op Zombies (CoD BO style): waves with escalating health/speed, points,
 * purchasable doors & debris, perk machines with drink animation, wall-buys, Mystery Box,
 * Pack-a-Punch (needs power), electric trap, and a main-quest easter egg with an ending.
 */
export class ZombiesMode extends SoldierMode {
  readonly id = 'zombies';
  readonly name = 'Zombies – Outpost 9';
  map!: MapInfo;
  round = 0;
  zombies: Zombie[] = [];
  toSpawn = 0;
  breakT = 6;
  spawnT = 0;
  power = false;
  nav!: NavGrid;
  rooms!: ZRoom[];
  doors!: ZDoor[];
  radiosFound = new Set<number>();
  eggStage = 0; // 0 none, 1 logs done, 2 signal sent (final wave), 3 heli arrived
  finalT = 0;
  trapT = 0;
  boxBusy = false;
  private heli: THREE.Object3D | null = null;
  private navT = 0;
  private selfRevives = 3;

  constructor(w: GameWorld, opts: ModeOptions = {}) {
    super(w, opts);
    this.healthRegen = true;
    this.allowDBNO = true;
    this.friendlyFire = false;
  }

  allowDowned(s: Soldier) { return s.isPlayer || super.allowDowned(s); }

  async setup(progress: (p: number, l: string) => void) {
    const w = this.w;
    this.map = await buildZombieOutpost(w, 9, (p, l) => progress(p * 0.7, l));
    const ex = this.map.extra;
    this.rooms = ex.rooms; this.doors = ex.doors;
    // nav grid: everything blocked except open rooms + open doors
    this.nav = new NavGrid(0, 0, 120, 120, 1);
    this.rebuildNav();
    progress(0.75, 'Maschinen');
    this.setupInteractables();
    const idx = this.w.net?.myIdx ?? 0;
    const pc = await this.spawnPlayer(new THREE.Vector3((idx % 4) * 2.2 - 3.3, ex.y + 0.5, -4 - Math.floor(idx / 4) * 2), 0);
    pc.soldier.weapons = [new Weapon('viper', 0), null];
    pc.soldier.perks.clear(); // perks are bought from machines in Zombies
    pc.soldier.current = 0;
    pc.soldier.reserve.light = 40;
    pc.soldier.cash = 500;
    pc.soldier.armorTier = 0;
    pc.soldier.grenades = 2;
    // AI squad mates
    const humans = this.w.net ? this.w.net.start.players.length : 1;
    const mates = this.authority ? Math.max(0, (settings.data.quality === 'potato' ? 1 : 2) - (humans - 1)) : 0;
    for (let i = 0; i < mates; i++) {
      const b = await this.spawnBot(0, new THREE.Vector3(i * 2 - 1, ex.y + 0.5, 3), 0.6, 0x2e86c1);
      b.s.weapons = [new Weapon(i ? 'wasp' : 'kestrel', 1), new Weapon('viper', 0)];
      b.s.reserve.light = 400; b.s.reserve.heavy = 400;
      b.roamRadius = 8;
      b.home.set(0, 0, 0);
    }
    this.listenShots();
    w.audio.playMusic('zombies');
    progress(1, 'Bereit');
  }

  private rebuildNav() {
    const n = this.nav;
    n.blocked.fill(1);
    // outside is open terrain (zombies walk in from the windows)
    for (let x = -60; x < 60; x++) for (let z = -60; z < 60; z++) {
      const inRoom = this.rooms.find((r) => Math.abs(x - r.x) < r.hw + 0.5 && Math.abs(z - r.z) < r.hd + 0.5);
      const i = n.idx(x + 0.5, z + 0.5);
      if (i < 0) continue;
      if (!inRoom) n.blocked[i] = 0; else n.blocked[i] = 0;
    }
    // walls
    for (const r of this.rooms) {
      n.blockBox(r.x, r.z - r.hd, r.hw, 0.4); n.blockBox(r.x, r.z + r.hd, r.hw, 0.4);
      n.blockBox(r.x - r.hw, r.z, 0.4, r.hd); n.blockBox(r.x + r.hw, r.z, 0.4, r.hd);
    }
    // windows (zombie entry) – one gap per outer wall of open rooms
    for (const r of this.rooms) for (const sp of r.spawns) {
      const dx = sp.x - r.x, dz = sp.z - r.z;
      const wx = Math.abs(dx) > r.hw ? r.x + Math.sign(dx) * r.hw : sp.x;
      const wz = Math.abs(dz) > r.hd ? r.z + Math.sign(dz) * r.hd : sp.z;
      if (r.open) n.blockBox(wx, wz, 0.8, 0.8, 0);
    }
    for (const d of this.doors) n.blockBox(d.x, d.z, d.horizontal ? 1.8 : 0.5, d.horizontal ? 0.5 : 1.8, d.open ? 0 : 1);
  }

  private setupInteractables() {
    const w = this.w, ex = this.map.extra;
    const me = () => w.player!.soldier;
    // doors
    for (const d of this.doors) {
      w.interactables.push({
        pos: new THREE.Vector3(d.x, ex.y + 1.2, d.z), radius: 3,
        label: () => `${d.debris ? 'Trümmer räumen' : 'Tür öffnen'} [$${d.cost}]`, cost: () => d.cost,
        enabled: () => !d.open,
        use: (s) => {
          if (s.cash < d.cost) { w.audio.ui('error'); return; }
          s.cash -= d.cost;
          this.zEvent('door', d.id);
        },
      });
    }
    // machines
    for (const m of ex.machines as { kind: string; x: number; z: number; obj: THREE.Object3D | null }[]) {
      const pos = new THREE.Vector3(m.x, ex.y + 1.2, m.z);
      if (PERKS[m.kind]) {
        const perk = PERKS[m.kind];
        if (m.obj) m.obj.traverse((o) => { const mm = o as THREE.Mesh; if (mm.isMesh) { const mat = (mm.material as THREE.MeshStandardMaterial).clone(); mat.emissive = new THREE.Color(perk.color); mat.emissiveIntensity = 0.0; mm.material = mat; mm.userData.perkMat = mat; } });
        w.interactables.push({
          pos, radius: 2.5, label: () => (this.power || m.kind === 'quickrevive' ? `${perk.name} – ${perk.desc} [$${perk.cost}]` : `${perk.name} (kein Strom)`), cost: () => perk.cost,
          enabled: () => !me().perks.has(m.kind),
          use: (s) => {
            if (!this.power && m.kind !== 'quickrevive') { w.audio.ui('error'); return; }
            if (s.cash < perk.cost || s.perks.size >= 4) { w.audio.ui('error'); return; }
            s.cash -= perk.cost;
            s.beginBusy('heal', 1.6); s.medkits++; // drink animation reuses the consume clip
            s.perks.add(m.kind);
            if (m.kind === 'juggernog') { s.maxHealth = 200; s.health = 200; }
            w.audio.play('coin');
            w.bus.emit('toast', `${perk.name} getrunken!`);
            w.bus.emit('perk', m.kind);
          },
        });
      } else if (m.kind === 'mysterybox') {
        w.interactables.push({ pos, radius: 2.6, label: () => (this.boxBusy ? 'Mystery Box…' : 'Mystery Box [$950]'), cost: () => 950, enabled: () => true, use: (s) => this.useBox(s, pos) });
      } else if (m.kind === 'packapunch') {
        w.interactables.push({
          pos, radius: 2.6, label: () => (this.power ? `Pack-a-Punch: ${me().weapon.name} [$5000]` : 'Pack-a-Punch (kein Strom)'), cost: () => 5000,
          enabled: () => !me().weapon.packed && me().weapon.def.cls !== 'melee',
          use: (s) => {
            if (!this.power || s.cash < 5000) { w.audio.ui('error'); return; }
            s.cash -= 5000; w.audio.play('turbo'); w.effects.burst(pos, 40, 3, 0xb04aff, 0.2, 1.2, 0);
            s.weapon.pack(); w.bus.emit('toast', `${s.weapon.name} wurde aufgewertet!`);
          },
        });
      } else if (m.kind === 'power') {
        w.interactables.push({
          pos, radius: 2.6, hold: 1.5,
          label: () => (!this.power ? 'Strom einschalten (halten)' : this.eggStage === 1 ? 'NOTSIGNAL SENDEN (halten)' : 'Generator läuft'),
          enabled: () => !this.power || this.eggStage === 1,
          use: () => {
            if (!this.power) this.zEvent('power', '');
            else if (this.eggStage === 1) this.zEvent('signal', '');
          },
        });
      } else if (m.kind === 'trap') {
        w.interactables.push({
          pos, radius: 2.5, label: () => (this.power ? 'Elektrofalle aktivieren [$1000]' : 'Elektrofalle (kein Strom)'), cost: () => 1000,
          enabled: () => this.trapT <= 0,
          use: (s) => { if (!this.power || s.cash < 1000) { w.audio.ui('error'); return; } s.cash -= 1000; this.zEvent('trap', ''); },
        });
      }
    }
    // wall-buys
    for (const wb of ex.wallbuys as { weapon: string; x: number; z: number; yaw: number }[]) {
      const def = WEAPONS[wb.weapon];
      const pos = new THREE.Vector3(wb.x, ex.y + 1.6, wb.z);
      w.weaponModel(new Weapon(def.id)).then((m) => { m.position.copy(pos); m.rotation.y = wb.yaw + Math.PI / 2; w.root.add(m); });
      w.interactables.push({
        pos, radius: 2.4, label: () => (me().weapons.some((x) => x?.def.id === def.id) ? `${def.name} Munition [$${Math.round(def.cost / 2)}]` : `${def.name} kaufen [$${def.cost}]`), cost: () => def.cost, enabled: () => true,
        use: (s) => {
          const has = s.weapons.find((x) => x?.def.id === def.id);
          const price = has ? Math.round(def.cost / 2) : def.cost;
          if (s.cash < price) { w.audio.ui('error'); return; }
          s.cash -= price;
          if (has) { has.ammo = has.stats.mag; s.reserve[def.ammo] = has.stats.mag * 6; }
          else { s.give(new Weapon(def.id, 1)); s.reserve[def.ammo] = Math.max(s.reserve[def.ammo] ?? 0, def.mag * 6); }
          w.audio.play('cash');
        },
      });
    }
    // easter egg radios
    (ex.radios as THREE.Vector3[]).forEach((p, i) => {
      w.interactables.push({
        pos: p.clone().setY(ex.y + 1.2), radius: 2.2, label: () => 'Funkgerät anhören', enabled: () => !this.radiosFound.has(i),
        use: () => this.zEvent('radio', String(i)),
      });
    });
  }

  /** shared map events (doors, power, trap, radios, signal): apply locally and replicate */
  zEvent(kind: string, id: string) { this.applyZEvent(kind, id, true); }
  applyZEvent(kind: string, id: string, local: boolean) {
    const w = this.w, ex = this.map.extra;
    if (local && w.net) w.net.net.event({ k: 'zev', kind, id });
    if (kind === 'door') {
      const d = this.doors.find((x) => x.id === id);
      if (!d || d.open) return;
      d.open = true;
      w.physics.removeCollider(d.collider); d.obj?.removeFromParent();
      for (const rid of d.rooms) { const r = this.rooms.find((rr) => rr.id === rid)!; r.open = true; }
      this.rebuildNav();
      w.audio.play(d.debris ? 'debris' : 'wood_break', { pos: new THREE.Vector3(d.x, ex.y, d.z) });
      w.bus.emit('toast', `${this.rooms.find((r) => r.id === d.rooms[1])!.name} geöffnet`);
    } else if (kind === 'power' && !this.power) {
      this.power = true; w.audio.play('engine_start', { volume: 1 }); w.bus.emit('toast', 'STROM AN – Perks & Pack-a-Punch aktiv');
      for (const mm of ex.machines) mm.obj?.traverse((o: THREE.Object3D) => { const mat = (o as THREE.Mesh).userData?.perkMat; if (mat) mat.emissiveIntensity = 0.8; });
      w.sky.time = 22.5;
    } else if (kind === 'signal' && this.eggStage === 1) {
      this.eggStage = 2; this.finalT = 90; w.bus.emit('toast', 'Notsignal gesendet! Überlebe 90 Sekunden bis zur Evakuierung!');
      w.audio.playMusic('tension'); if (this.authority) this.toSpawn += 40;
    } else if (kind === 'trap') { this.trapT = 20; w.audio.play('turbo'); }
    else if (kind === 'radio') {
      const i = Number(id);
      if (this.radiosFound.has(i)) return;
      this.radiosFound.add(i);
      w.bus.emit('story', LOGS[this.radiosFound.size - 1]);
      w.audio.play('ui_popup_open');
      if (this.radiosFound.size === 3) { this.eggStage = Math.max(this.eggStage, 1); w.bus.emit('toast', 'Alle Logs gefunden – sende das Notsignal am Generator!'); }
    }
  }

  netState() { return { r: this.round, ts: this.toSpawn, eg: this.eggStage, ft: this.finalT, pw: this.power ? 1 : 0, dr: this.doors.filter((d) => d.open).map((d) => d.id) }; }
  applyNetState(m: any) {
    if (m.r !== this.round) { this.round = m.r; this.w.bus.emit('round', this.round); }
    this.toSpawn = m.ts; this.finalT = m.ft;
    for (const id of m.dr as string[]) this.applyZEvent('door', id, false);
    if (m.pw && !this.power) this.applyZEvent('power', '', false);
    if (m.eg === 2 && this.eggStage < 2) { this.eggStage = 1; this.applyZEvent('signal', '', false); }
    if (m.eg === 3 && this.eggStage < 3) { this.eggStage = 3; this.callHeli(); }
  }

  private useBox(s: Soldier, pos: THREE.Vector3) {
    const w = this.w;
    if (this.boxBusy || s.cash < 950) { w.audio.ui('error'); return; }
    s.cash -= 950; this.boxBusy = true;
    w.audio.play('coin');
    let shown: THREE.Object3D | null = null;
    let t = 0;
    let def = this.rng.pick(LOOT_WEAPONS);
    const tick = async (dt: number) => {
      t += dt;
      if (t < 3 && Math.floor(t * 8) !== Math.floor((t - dt) * 8)) {
        def = this.rng.pick(LOOT_WEAPONS);
        const m = await w.weaponModel(new Weapon(def.id));
        shown?.removeFromParent(); shown = m; m.position.copy(pos).add(new THREE.Vector3(0, 0.5 + t * 0.15, 0)); w.root.add(m);
        w.audio.play('ui_cursor', { pos, volume: 0.6 });
      }
      if (t >= 3 && shown) {
        shown.rotation.y += dt;
        if (t > 3 && !w.interactables.includes(take)) w.interactables.push(take);
      }
      if (t > 12) done();
    };
    const done = () => { shown?.removeFromParent(); this.boxBusy = false; w.updaters = w.updaters.filter((u) => u !== tick); w.interactables = w.interactables.filter((i) => i !== take); };
    const take = { pos: pos.clone().add(new THREE.Vector3(0, 0.2, 0)), radius: 2.6, label: () => `${def.name} nehmen`, enabled: () => true, use: (sol: Soldier) => { sol.give(new Weapon(def.id, 3)); sol.reserve[def.ammo] = Math.max(sol.reserve[def.ammo] ?? 0, def.mag * 6); done(); } };
    w.updaters.push(tick);
  }

  private startRound() {
    this.round++;
    this.toSpawn = Math.min(6 + this.round * 4, 120);
    this.w.bus.emit('round', this.round);
    this.w.audio.play('explosion_far', { volume: 0.6 });
  }

  private zombieHealth() { return this.round < 10 ? 150 + (this.round - 1) * 100 : 1050 * Math.pow(1.1, this.round - 9); }

  private async spawnZombie() {
    const open = this.rooms.filter((r) => r.open);
    const room = this.rng.pick(open);
    const sp = this.rng.pick(room.spawns).clone();
    const runnerChance = this.round < 4 ? 0 : Math.min(0.85, (this.round - 3) * 0.15);
    let type: ZombieType = this.rng.chance(runnerChance) ? 'runner' : 'walker';
    if (this.round % 5 === 0 && this.rng.chance(0.15)) type = 'brute';
    if (this.round >= 3 && this.rng.chance(0.12)) type = 'hazmat';
    const speed = type === 'runner' ? 4.4 + this.rng.next() : type === 'brute' ? 2.2 : 1.1 + this.rng.next() * 0.4;
    // recycle dead zombies (object pool)
    let z = this.zombies.find((zz) => !zz.alive && zz.deadT > 5 && zz.type === type);
    if (z) {
      z.alive = true; z.health = z.maxHealth = this.zombieHealth() * (type === 'brute' ? 3 : 1); z.deadT = 0; z.crawler = false; z.headless = false; z.speed = speed;
      z.model.inner.traverse((o) => { if (o.name === 'Head' || o.name.startsWith('calf_')) o.scale.setScalar(1); });
      z.collider?.setEnabled(true);
    } else {
      z = new Zombie(this.w, type, this.zombieHealth(), speed);
      await z.init();
      z.nav = this.nav;
      this.w.addActor(z);
      this.zombies.push(z);
    }
    sp.y = this.w.terrain.getHeight(sp.x, sp.z);
    z.spawn(sp);
    z.model.setLoco('zombieWalk', 0);
    z.model.root.visible = true;
  }

  zombieBlocked(_z: Zombie) { /* walls are solid – flow field routes around them */ }

  update(dt: number) {
    const w = this.w;
    this.tickSoldiers(dt);
    for (const z of this.zombies) z.update(dt);
    this.navT -= dt;
    if (this.navT <= 0 && w.player) { this.navT = 0.4; this.nav.compute(w.player.soldier.pos.x, w.player.soldier.pos.z); }
    // round flow
    if (!this.authority) {
      // clients: the host runs rounds/spawning; still handle own down state
      const me0 = w.player?.soldier;
      if (me0 && !me0.alive && !this.over) this.finish(false, `Du hast ${this.round} Runden überlebt`);
      return;
    }
    const alive = this.zombies.filter((z) => z.alive).length;
    if (this.toSpawn <= 0 && alive === 0 && this.eggStage < 2) {
      this.breakT -= dt;
      if (this.breakT <= 0) { this.breakT = 9; this.startRound(); }
    }
    this.spawnT -= dt;
    const cap = settings.data.quality === 'potato' ? 12 : settings.data.quality === 'low' ? 18 : 26;
    if (this.toSpawn > 0 && alive < cap && this.spawnT <= 0) { this.spawnT = Math.max(0.4, 2 - this.round * 0.1); this.toSpawn--; this.spawnZombie(); }
    // trap
    if (this.trapT > 0) {
      this.trapT -= dt;
      const c = new THREE.Vector3(0, this.map.extra.y, -20);
      if (Math.random() < 0.5) w.effects.burst(c.clone().add(new THREE.Vector3((Math.random() - 0.5) * 8, 0.5 + Math.random() * 2, (Math.random() - 0.5) * 3)), 6, 6, 0x9fd8ff, 0.08, 0.2, 0);
      for (const z of this.zombies) if (z.alive && Math.abs(z.pos.x - c.x) < 4.5 && Math.abs(z.pos.z - c.z) < 2.5) z.damage(9999, { attacker: w.player!.soldier, weapon: 'trap' });
    }
    // final wave & helicopter escape
    if (this.eggStage === 2) {
      this.finalT -= dt;
      if (this.toSpawn < 10) this.toSpawn += 5;
      if (this.finalT <= 0) { this.eggStage = 3; this.callHeli(); }
    }
    // player down handling (solo self revive with Quick Revive)
    const me = w.player?.soldier;
    if (me && me.downed && me.perks.has('quickrevive') && this.selfRevives > 0 && w.time - me.downedTime > 4) {
      this.selfRevives--; me.revive(); me.perks.delete('quickrevive'); w.bus.emit('toast', 'Quick Revive: Selbstwiederbelebung');
    }
    if (me && !me.alive && !this.over) this.finish(false, `Du hast ${this.round} Runden überlebt`);
  }

  private async callHeli() {
    const w = this.w;
    const heli = await w.assets.instance('heli_huey');
    const land = new THREE.Vector3(0, this.map.extra.y, -50);
    heli.position.copy(land).add(new THREE.Vector3(0, 120, 0));
    w.root.add(heli);
    this.heli = heli;
    w.bus.emit('toast', 'Evakuierungs-Heli landet südlich der Anlage!');
    const upd = (dt: number) => {
      if (heli.position.y > land.y + 0.2) heli.position.y -= dt * 12;
      heli.rotation.y += dt * 0.1;
    };
    w.updaters.push(upd);
    w.interactables.push({ pos: land.clone().setY(land.y + 1), radius: 7, label: () => 'EVAKUIEREN', enabled: () => heli.position.y < land.y + 2, use: () => { this.finish(true, `ENTKOMMEN! Easter Egg abgeschlossen (Runde ${this.round})`); w.audio.playMusic('victory'); } });
    // open the yard so the player can reach it
    const d = this.doors.find((dd) => dd.id === 'd_yard')!;
    if (!d.open) { d.open = true; w.physics.removeCollider(d.collider); d.obj?.removeFromParent(); this.rooms.find((r) => r.id === 'yard')!.open = true; this.rebuildNav(); }
  }

  onKill(victim: Actor, info: DamageInfo) {
    super.onKill(victim, info);
    if (victim.kind === 'zombie' && this.rng.chance(0.04)) this.powerUp(victim.pos.clone());
  }

  /** classic power-ups: Max Ammo, Insta-Kill, Nuke, Double Points */
  private powerUp(p: THREE.Vector3) {
    const w = this.w;
    const kind = this.rng.pick(['Max Ammo', 'Insta-Kill', 'Nuke', 'Double Points']);
    const it = { pos: p.setY(p.y + 0.8), radius: 1.6, label: () => kind, enabled: () => true, use: (s: Soldier) => {
      w.interactables = w.interactables.filter((x) => x !== it);
      w.bus.emit('toast', kind.toUpperCase() + '!');
      w.audio.play('turbo');
      if (kind === 'Max Ammo') for (const so of w.soldiers) for (const wp of so.weapons) if (wp) { wp.ammo = wp.stats.mag; so.reserve[wp.def.ammo] = wp.stats.mag * 8; }
      if (kind === 'Nuke') { for (const z of this.zombies) if (z.alive) z.damage(99999, { attacker: s }); s.cash += 400; }
      if (kind === 'Insta-Kill') { const old = this.zombies.map((z) => z.health); void old; this.instaUntil = w.time + 30; }
      if (kind === 'Double Points') this.doubleUntil = w.time + 30;
    } };
    w.interactables.push(it);
    w.effects.burst(p, 30, 2, 0x7dff7a, 0.25, 1, 0);
  }
  instaUntil = 0;
  doubleUntil = 0;

  canDamage(t: Actor, i: DamageInfo) {
    if (t.kind === 'zombie' && this.w.time < this.instaUntil && i.attacker?.isPlayer) { t.health = 0; }
    return !(t.kind === 'soldier' && i.attacker?.kind === 'soldier');
  }

  hud(): HudInfo {
    const me = this.w.player?.soldier;
    const zAlive = this.authority ? this.zombies.filter((z) => z.alive).length : [...(this.w.net?.zProxies.values() ?? [])].filter((z) => z.alive).length;
    return {
      title: 'ZOMBIES',
      round: this.round,
      points: me?.cash ?? 0,
      objective: this.eggStage === 2 ? `Evakuierung in ${Math.ceil(this.finalT)}s` : this.eggStage === 3 ? 'Steige in den Helikopter!' : !this.power ? 'Finde den Generator und schalte den Strom ein' : this.radiosFound.size < 3 ? `Funkgeräte: ${this.radiosFound.size}/3` : 'Sende das Notsignal!',
      alive: zAlive + this.toSpawn,
    };
  }
}
