import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { GameWorld } from '../gameplay/GameWorld';
import type { NetClient, StartInfo } from './NetClient';
import { Soldier } from '../entities/Soldier';
import { Zombie, type ZombieType } from '../entities/Zombie';
import { lerpAngle } from '../entities/BotBrain';
import type { Actor, DamageInfo, HitZone } from '../gameplay/types';
import { Weapon } from '../weapons/Weapon';
import type { LocoState } from '../entities/CharacterModel';
import type { Vehicle } from '../vehicles/Vehicle';
import { TEAM_COLORS } from '../gameplay/SoldierMode';
import { QUALITY_PRESETS, settings } from '../core/Settings';

interface Target { pos: THREE.Vector3; vel: THREE.Vector3; yaw: number; pitch: number; seen: number }
const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Host-relay multiplayer session for a running match.
 *  - every client simulates its own player and streams state (20 Hz)
 *  - the host simulates bots, zombies and the game mode and streams snapshots (10 Hz)
 *  - damage is applied by the owner of the target (hit events), kills are broadcast
 *  - loot, vehicles and Zombies map events are replicated as events
 * Remote humans exist as `Soldier` puppets (targetable by bots/zombies on the host), host bots and
 * zombies exist as puppets on clients.
 */
export class NetSync {
  readonly host: boolean;
  readonly myId: string;
  readonly myIdx: number;
  readonly start: StartInfo;
  remotes = new Map<string, Soldier>();
  botProxies = new Map<string, Soldier>();
  zProxies = new Map<string, Zombie>();
  private targets = new Map<Actor, Target>();
  private pending = new Set<string>();
  private stT = 0; private snapT = 0;
  private offs: (() => void)[] = [];
  private botShots = new Map<Soldier, number>();
  private vehicleOwner = new Map<number, string>();
  private vehTarget = new Map<number, { p: THREE.Vector3; q: THREE.Quaternion }>();
  private myVehicle: Vehicle | null = null;
  private lastNetState: Record<string, unknown> | null = null;

  constructor(public w: GameWorld, public net: NetClient, start: StartInfo) {
    this.start = start;
    this.host = start.host === net.id;
    this.myId = net.id;
    this.myIdx = Math.max(0, start.players.findIndex((p) => p.id === net.id));
  }

  /** team for the n-th human in the room (mode dependent) */
  teamFor(idx: number): number {
    const m = this.start.mode, s = this.start.sub;
    if (m === 'mp') return s === 'ffa' ? 600 + idx : idx % 2;
    if ((m === 'br' || m === 'zombieroyale') && (s === 'solos' || s === 'sniper' || s === 'cqb' || s === 'hightier' || s === 'extraction')) return idx === 0 ? 0 : 500 + idx;
    return 0;
  }
  get myTeam() { return this.teamFor(this.myIdx); }

  /** create puppets for the other humans and hook all network handlers */
  async init(spawn: THREE.Vector3) {
    for (const p of this.start.players) if (p.id !== this.myId) await this.addRemote(p.id, p.name, p.idx, spawn.clone().add(new THREE.Vector3(p.idx * 2, 0, 0)));
    const on = (t: string, fn: (m: any) => void) => this.offs.push(this.net.on(t, fn));
    on('st', (m) => this.onState(m));
    on('snap', (m) => { if (!this.host) this.onSnap(m); });
    on('ev', (m) => this.onEvent(m.from, m.e));
    on('left', (m) => { const r = this.remotes.get(m.id); if (r) { r.alive = false; r.model.setVisible(false); this.w.removeActor(r); this.remotes.delete(m.id); this.w.bus.emit('toast', `${r.name} hat das Spiel verlassen`); } });
    on('hostLeft', () => { if (!this.host) this.w.bus.emit('toast', 'Host hat das Match verlassen – Verbindung zur Welt-Simulation verloren'); });
    // local events -> network
    this.offs.push(this.w.bus.on('kill', (e: { victim: Actor; killer: Actor | null; info: DamageInfo & { net?: boolean } }) => {
      if (e.info?.net) return;
      const v = e.victim as Actor & { netRemote?: string };
      const mine = v === this.w.player?.soldier;
      const hostOwned = this.host && !v.isPlayer && !(v as any).netRemote;
      if (!mine && !hostOwned) return;
      this.net.event({ k: 'kill', v: this.idOf(v), a: e.killer ? this.idOf(e.killer) : '', w: e.info?.weapon ?? '', z: e.info?.zone ?? '' });
      if (mine && !this.host) {
        const s = this.w.player!.soldier;
        this.net.toHost({ k: 'drop', p: [s.pos.x, s.pos.y, s.pos.z], ws: s.weapons.filter(Boolean).map((x) => [x!.def.id, x!.rarity, x!.attachments]), pl: s.plates, c: s.cash });
      }
    }));
    this.offs.push(this.w.bus.on('playerFired', (s: Soldier) => {
      const p = this.w.player!;
      const o = p.muzzleWorld(), d = p.forward();
      this.net.event({ k: 'shot', o: [r2(o.x), r2(o.y), r2(o.z)], d: [r2(d.x), r2(d.y), r2(d.z)], w: s.weapon.def.id, s: s.weapon.stats.silenced ? 1 : 0 });
    }));
    this.offs.push(this.w.bus.on('vehicleEnter', (e: { vehicle: Vehicle; soldier: Soldier }) => {
      if (e.soldier !== this.w.player?.soldier || e.soldier.seat !== 0) return;
      this.myVehicle = e.vehicle;
      this.net.event({ k: 'vclaim', v: e.vehicle.id });
    }));
    this.offs.push(this.w.bus.on('vehicleExit', (e: { vehicle: Vehicle; soldier: Soldier }) => {
      if (e.soldier !== this.w.player?.soldier || this.myVehicle !== e.vehicle) return;
      const b = e.vehicle.body, t = b.translation(), q = b.rotation(), lv = b.linvel();
      this.net.event({ k: 'vrel', v: e.vehicle.id, p: [t.x, t.y, t.z], q: [q.x, q.y, q.z, q.w], lv: [lv.x, lv.y, lv.z] });
      this.myVehicle = null;
    }));
    const loot = (this.w as any).loot;
    if (loot) {
      loot.onTake = (id: number) => this.net.event({ k: 'ltake', id });
      if (this.host) loot.onSpawn = (it: any) => this.net.event({ k: 'lspawn', id: it.id, kind: it.kind, r: it.rarity, a: it.amount, at: it.ammoType ?? '', p: [it.pos.x, it.pos.y, it.pos.z], wp: it.weapon ? [it.weapon.def.id, it.weapon.rarity, it.weapon.attachments] : null });
    }
  }

  idOf(a: Actor): string {
    if (a === this.w.player?.soldier) return this.myId;
    const s = a as Actor & { netId?: string };
    if (s.netId) return s.netId;
    return (a.kind === 'zombie' ? 'z' : 'b') + a.id;
  }

  resolve(id: string): Actor | null {
    if (!id) return null;
    if (id === this.myId) return this.w.player?.soldier ?? null;
    const r = this.remotes.get(id) ?? this.botProxies.get(id) ?? this.zProxies.get(id);
    if (r) return r;
    if (this.host) return this.w.actors.find((x) => this.idOf(x) === id) ?? null;
    return null;
  }

  private async addRemote(id: string, name: string, idx: number, pos: THREE.Vector3) {
    if (this.remotes.has(id) || this.pending.has(id)) return;
    this.pending.add(id);
    const team = this.teamFor(idx);
    const s = new Soldier(this.w, name, team, team === this.myTeam ? 0x2ecc71 : TEAM_COLORS[(idx + 1) % TEAM_COLORS.length]);
    s.netId = id; s.netRemote = 'human';
    await s.init('char_mannequin');
    s.spawnAt(pos);
    s.weapons[0] = new Weapon('kestrel', 1);
    this.w.addActor(s);
    this.remotes.set(id, s);
    this.targets.set(s, { pos: pos.clone(), vel: new THREE.Vector3(), yaw: 0, pitch: 0, seen: this.w.time });
    this.pending.delete(id);
  }

  // ------------------------------------------------------------------ incoming
  private onState(m: any) {
    let s = this.remotes.get(m.id);
    if (!s) { const p = this.start.players.find((x) => x.id === m.id); if (p) this.addRemote(p.id, m.n ?? p.name, p.idx, new THREE.Vector3(...(m.p as [number, number, number]))); return; }
    const t = this.targets.get(s)!;
    t.pos.set(m.p[0], m.p[1], m.p[2]); t.vel.set(m.v[0], m.v[1], m.v[2]); t.yaw = m.y; t.pitch = m.pi; t.seen = this.w.time;
    const wasAlive = s.alive;
    s.health = m.hp; s.armor = m.ar; s.armorTier = Math.max(s.armorTier, Math.ceil(m.ar / 50));
    s.downed = !!m.dn; s.kills = m.k ?? s.kills;
    s.crouching = !!m.cr; s.sprinting = !!m.sp; s.grounded = !m.air; s.swimming = !!m.sw; s.freefall = !!m.ff; s.parachute = !!m.pc;
    if (m.al && !wasAlive) { s.spawnAt(t.pos); s.health = m.hp; }
    if (!m.al && wasAlive) { s.alive = false; s.model.setUpper('none', 0.1); s.model.setLoco('dead', 0.15); }
    const wkey = m.w as string;
    if (wkey && s.weapon.def.id + s.weapon.attachments.join(',') !== wkey) {
      const [id, atts] = wkey.split('|');
      s.weapons[0] = new Weapon(id, 1, atts ? atts.split(',').filter(Boolean) : []); s.current = 0;
    }
    if (m.f) s.lastShotTime = this.w.time;
    // remote driver: vehicle pose
    if (m.vh) {
      const v = this.w.vehicles.find((x) => x.id === m.vh[0]);
      if (v) {
        if (this.vehicleOwner.get(v.id) !== m.id) this.claimRemote(v, m.id);
        this.vehTarget.set(v.id, { p: new THREE.Vector3(m.vh[1], m.vh[2], m.vh[3]), q: new THREE.Quaternion(m.vh[4], m.vh[5], m.vh[6], m.vh[7]) });
      }
      s.model.setVisible(!!v?.exposedSeats);
    } else if (s.alive) s.model.setVisible(true);
  }

  private async onSnap(m: any) {
    const now = this.w.time;
    // bots
    for (const b of m.b as any[]) {
      const id = 'b' + b[0];
      let s = this.botProxies.get(id);
      if (!s) {
        if (this.pending.has(id)) continue;
        this.pending.add(id);
        const team = b[10] as number;
        s = new Soldier(this.w, b[12] ?? 'Bot', team, team === this.myTeam ? 0x2ecc71 : TEAM_COLORS[team % TEAM_COLORS.length]);
        s.netId = id; s.netRemote = 'bot';
        await s.init(QUALITY_PRESETS[settings.data.quality].lowSpecMaterials ? 'char_mannequin_lod' : 'char_mannequin');
        s.spawnAt(new THREE.Vector3(b[1], b[2], b[3]));
        s.weapons[0] = new Weapon(b[9] || 'kestrel', 1);
        this.w.addActor(s);
        this.botProxies.set(id, s);
        this.targets.set(s, { pos: new THREE.Vector3(b[1], b[2], b[3]), vel: new THREE.Vector3(), yaw: b[4], pitch: b[5], seen: now });
        this.pending.delete(id);
        continue;
      }
      const t = this.targets.get(s)!;
      const np = new THREE.Vector3(b[1], b[2], b[3]);
      t.vel.copy(np).sub(t.pos).multiplyScalar(10); if (t.vel.lengthSq() > 2500) t.vel.set(0, 0, 0);
      t.pos.copy(np); t.yaw = b[4]; t.pitch = b[5]; t.seen = now;
      s.health = b[7];
      s.frozen = !!b[13];
      s.model.setVisible(!b[13]);
      if (b[8] && !s.alive) s.spawnAt(np);
      if (!b[8] && s.alive) { s.alive = false; s.model.setLoco('dead', 0.15); }
      if (b[9] && s.weapon.def.id !== b[9]) { s.weapons[0] = new Weapon(b[9], 1); s.current = 0; }
      s.freefall = !!b[14]; s.parachute = !!b[15];
      if (b[11]) this.remoteShotFx(s);
    }
    // zombies
    for (const z of (m.z as any[]) ?? []) {
      const id = 'z' + z[0];
      let p = this.zProxies.get(id);
      if (!p) {
        if (this.pending.has(id)) continue;
        this.pending.add(id);
        p = new Zombie(this.w, z[1] as ZombieType, 100, 1);
        p.netId = id; p.netRemote = true;
        await p.init();
        p.pos.set(z[2], z[3], z[4]);
        this.w.addActor(p);
        this.zProxies.set(id, p);
        this.targets.set(p, { pos: p.pos.clone(), vel: new THREE.Vector3(), yaw: z[5], pitch: 0, seen: now });
        this.pending.delete(id);
        continue;
      }
      const t = this.targets.get(p)!;
      const np = new THREE.Vector3(z[2], z[3], z[4]);
      t.vel.copy(np).sub(t.pos).multiplyScalar(10); if (t.vel.lengthSq() > 900) t.vel.set(0, 0, 0);
      t.pos.copy(np); t.yaw = z[5]; t.seen = now;
      const alive = !!z[7];
      if (alive && !p.alive) { p.alive = true; p.deadT = 0; p.headless = false; p.crawler = false; p.model.inner.traverse((o) => { if (o.name === 'Head' || o.name.startsWith('calf_')) o.scale.setScalar(1); }); p.model.resetPose(); p.model.root.visible = true; p.pos.copy(np); }
      if (!alive && p.alive) { p.alive = false; p.model.setLoco('dead', 0.1); }
      if (z[8] && !p.crawler) { p.crawler = true; p.model.inner.traverse((o) => { if (o.name.startsWith('calf_')) o.scale.setScalar(0.01); }); }
      if (z[9] && !p.headless) { p.headless = true; p.model.inner.traverse((o) => { if (o.name === 'Head') o.scale.setScalar(0.01); }); }
      if (z[10]) p.model.setUpper('zombieAttack', 0.1, 0.9);
    }
    if (m.m) { this.lastNetState = m.m; this.w.mode?.applyNetState(m.m); }
  }

  private remoteShotFx(s: Soldier) {
    const d = s.pos.distanceTo(this.w.audio.listener);
    if (d > 250) return;
    const eye = s.eyePos(new THREE.Vector3());
    const dir = new THREE.Vector3(Math.sin(s.yaw) * Math.cos(s.pitch), Math.sin(s.pitch), Math.cos(s.yaw) * Math.cos(s.pitch));
    const o = eye.addScaledVector(dir, 0.8);
    this.w.effects.muzzle(o, dir, s.weapon.def.cls === 'shotgun');
    this.w.effects.tracer(o, o.clone().addScaledVector(dir, 60), 0xffb070);
    this.w.audio.play(s.weapon.stats.sound, { pos: s.pos, volume: 0.75, maxDist: 600 });
    s.lastShotTime = this.w.time;
    s.model.recoilKick(0.5);
  }

  private onEvent(from: string, e: any) {
    const w = this.w;
    switch (e.k) {
      case 'shot': {
        const o = new THREE.Vector3(...(e.o as [number, number, number])), d = new THREE.Vector3(...(e.d as [number, number, number]));
        w.effects.muzzle(o, d, false, !!e.s);
        w.effects.tracer(o, o.clone().addScaledVector(d, 60), 0xffd890);
        const r = this.remotes.get(from);
        if (r) { r.lastShotTime = w.time; r.silencedUntil = e.s ? w.time + 0.1 : 0; r.model.recoilKick(0.6); }
        w.audio.play(e.s ? 'suppressed' : (r?.weapon.stats.sound ?? 'ar_shot'), { pos: o, volume: e.s ? 0.4 : 0.85, maxDist: e.s ? 40 : 600 });
        break;
      }
      case 'hit': {
        const me = w.player?.soldier;
        if (!me || !me.alive) break;
        const att = this.resolve(e.a);
        me.damage(e.dmg, { attacker: att, zone: e.z as HitZone, dir: e.d ? new THREE.Vector3(...(e.d as [number, number, number])) : undefined, explosive: !!e.ex, weapon: e.w, point: e.p ? new THREE.Vector3(...(e.p as [number, number, number])) : undefined });
        break;
      }
      case 'bdmg': case 'zdmg': {
        if (!this.host) break;
        const target = w.actors.find((x) => this.idOf(x) === e.id);
        const att = this.remotes.get(from) ?? null;
        if (target && target.alive) target.damage(e.dmg, { attacker: att, zone: e.z as HitZone, dir: e.d ? new THREE.Vector3(...(e.d as [number, number, number])) : undefined, explosive: !!e.ex, weapon: e.w, melee: !!e.ml });
        break;
      }
      case 'kill': {
        const victim = this.resolve(e.v);
        const killer = this.resolve(e.a);
        const info: DamageInfo & { net: boolean } = { attacker: killer, weapon: e.w, zone: (e.z || undefined) as HitZone, net: true };
        if (victim) {
          if ((victim as any).netRemote === 'human' && victim.alive) { victim.alive = false; (victim as Soldier).model.setLoco('dead', 0.15); }
          if (killer === w.player?.soldier && victim !== killer) { killer.kills++; killer.score += victim.kind === 'zombie' ? 60 : 100; if (victim.kind === 'zombie') (killer as Soldier).cash += e.z === 'head' ? 100 : 60; }
          else if (killer && this.host && (killer as any).netRemote === 'human') { killer.kills++; }
          w.bus.emit('kill', { victim, killer, info });
          if (this.host && (victim as any).netRemote === 'human') w.mode?.onKill(victim, info);
          if ((killer as any)?.isPlayer && victim.kind === 'soldier') w.onPlayerHit(victim, 0, (e.z || 'body') as HitZone, true);
        }
        break;
      }
      case 'drop': {
        if (!this.host) break;
        const loot = (w as any).loot;
        if (!loot) break;
        const p = new THREE.Vector3(...(e.p as [number, number, number]));
        let k = 0;
        const at = () => { const a = k++ * 1.3; return p.clone().add(new THREE.Vector3(Math.cos(a) * 0.9, 0.25, Math.sin(a) * 0.9)); };
        for (const [id, r, atts] of e.ws as [string, number, string[]][]) loot.spawnWeapon(at(), new Weapon(id, r as any, atts));
        if (e.pl > 0) loot.spawn(at(), 'plate', 1, e.pl);
        if (e.c > 0) loot.spawn(at(), 'cash', 3, e.c);
        break;
      }
      case 'lspawn': {
        const loot = (w as any).loot;
        if (!loot || this.host) break;
        const wp = e.wp ? new Weapon(e.wp[0], e.wp[1], e.wp[2]) : undefined;
        loot.spawn(new THREE.Vector3(...(e.p as [number, number, number])), e.kind, e.r, e.a, e.at || undefined, wp, e.id);
        break;
      }
      case 'ltake': { const loot = (w as any).loot; const it = loot?.items.find((x: any) => x.id === e.id); if (it) loot.take(it, true); break; }
      case 'vclaim': { const v = w.vehicles.find((x) => x.id === e.v); if (v) this.claimRemote(v, from); break; }
      case 'vrel': {
        const v = w.vehicles.find((x) => x.id === e.v);
        if (!v) break;
        this.vehicleOwner.delete(v.id); this.vehTarget.delete(v.id);
        v.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
        v.body.setTranslation({ x: e.p[0], y: e.p[1], z: e.p[2] }, true);
        v.body.setRotation({ x: e.q[0], y: e.q[1], z: e.q[2], w: e.q[3] }, true);
        v.body.setLinvel({ x: e.lv[0], y: e.lv[1], z: e.lv[2] }, true);
        v.engineOn = false;
        break;
      }
      case 'zev': (w.mode as any)?.applyZEvent?.(e.kind, e.id, false); break;
      case 'vdmg': { const v = w.vehicles.find((x) => x.id === e.v); if (v && this.vehicleOwner.get(v.id) === undefined) v.damage(e.dmg, this.resolve(from)); break; }
    }
  }

  private claimRemote(v: Vehicle, owner: string) {
    if (v.driver === this.w.player?.soldier) return; // conflict: keep ours
    this.vehicleOwner.set(v.id, owner);
    v.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    v.engineOn = true;
  }
  isRemoteVehicle(v: Vehicle) { return this.vehicleOwner.has(v.id); }

  /** route damage dealt to a puppet to its owner (returns the predicted amount for hit markers) */
  remoteDamage(target: Actor & { netRemote?: string | boolean; netId?: string }, amount: number, info: DamageInfo): number {
    if (!target.alive) return 0;
    const att = info.attacker ? this.idOf(info.attacker) : '';
    const d = info.dir ? [r2(info.dir.x), r2(info.dir.y), r2(info.dir.z)] : null;
    const ev = { dmg: Math.round(amount * 10) / 10, z: info.zone ?? 'body', d, a: att, w: info.weapon ?? '', ex: info.explosive ? 1 : 0, ml: info.melee ? 1 : 0, p: info.point ? [r2(info.point.x), r2(info.point.y), r2(info.point.z)] : null };
    if (target.netRemote === 'human') this.net.to(target.netId!, { k: 'hit', ...ev });
    else if (target.netRemote === 'bot') this.net.toHost({ k: 'bdmg', id: target.netId, ...ev });
    else if (target.netRemote === true) this.net.toHost({ k: 'zdmg', id: target.netId, ...ev });
    if (info.dir) (target as any).model?.flinch?.(info.dir, 0.8);
    return amount;
  }

  // ------------------------------------------------------------------ outgoing + interpolation
  update(dt: number) {
    const w = this.w, me = w.player?.soldier;
    this.net.tick(dt);
    // my state @20Hz
    this.stT -= dt;
    if (me && this.stT <= 0) {
      this.stT = 0.05;
      const v = me.inVehicle;
      const vb = v && me.seat === 0 ? v.body : null;
      const t = vb?.translation(), q = vb?.rotation();
      this.net.send({
        t: 'st', p: [r2(me.pos.x), r2(me.pos.y), r2(me.pos.z)], v: [r2(me.vel.x), r2(me.vel.y), r2(me.vel.z)], y: r2(me.yaw), pi: r2(me.pitch),
        hp: Math.round(me.health), ar: Math.round(me.armor), al: me.alive ? 1 : 0, dn: me.downed ? 1 : 0, k: me.kills, n: me.name,
        w: me.weapon.def.id + '|' + me.weapon.attachments.join(','), f: w.time - me.lastShotTime < 0.06 ? 1 : 0,
        cr: me.crouching ? 1 : 0, sp: me.sprinting ? 1 : 0, air: me.grounded ? 0 : 1, sw: me.swimming ? 1 : 0, ff: me.freefall ? 1 : 0, pc: me.parachute ? 1 : 0,
        vh: vb && t && q ? [v!.id, r2(t.x), r2(t.y), r2(t.z), q.x, q.y, q.z, q.w] : 0,
      });
    }
    // host snapshot @10Hz
    if (this.host) {
      for (const b of (w.mode as any)?.bots ?? []) { if (w.time - b.s.lastShotTime < 0.12) this.botShots.set(b.s, 1); }
      this.snapT -= dt;
      if (this.snapT <= 0) {
        this.snapT = 0.1;
        const bots = ((w.mode as any)?.bots ?? []).map((b: any) => {
          const s = b.s as Soldier;
          const fired = this.botShots.get(s) ? 1 : 0;
          this.botShots.delete(s);
          return [s.id, r2(s.pos.x), r2(s.pos.y), r2(s.pos.z), r2(s.yaw), r2(s.pitch), s.model.loco, Math.round(s.health), s.alive ? 1 : 0, s.weapon.def.id, s.team, fired, s.name, s.frozen ? 1 : 0, s.freefall ? 1 : 0, s.parachute ? 1 : 0];
        });
        const zs = ((w.mode as any)?.zombies ?? []).map((z: Zombie) => [z.id, z.type, r2(z.pos.x), r2(z.pos.y), r2(z.pos.z), r2(z.yaw), z.model.loco, z.alive ? 1 : 0, z.crawler ? 1 : 0, z.headless ? 1 : 0, z.model.upper === 'zombieAttack' ? 1 : 0]);
        this.net.send({ t: 'snap', b: bots, z: zs, m: w.mode?.netState() ?? null });
      }
    }
    // interpolate puppets
    const k = 1 - Math.exp(-dt * 14);
    const cam = w.engine.camera.position;
    for (const [a, t] of this.targets) {
      if (!a.alive && a.kind === 'soldier') { (a as Soldier).animate(dt, a.pos.distanceTo(cam)); continue; }
      a.pos.addScaledVector(t.vel, dt * 0.5).lerp(t.pos, k);
      a.yaw = lerpAngle(a.yaw, t.yaw, k);
      a.vel.lerp(t.vel, k);
      if (a.kind === 'soldier') {
        const s = a as Soldier;
        s.pitch = THREE.MathUtils.lerp(s.pitch, t.pitch, k);
        s.body?.setNextKinematicTranslation(s.capsuleCenter());
        const d = s.pos.distanceTo(cam);
        if (s.model.root.visible || d < QUALITY_PRESETS[settings.data.quality].drawDistance) s.animate(dt, d);
      }
    }
    // remote-driven vehicles follow their owner
    for (const [vid, tg] of this.vehTarget) {
      const v = w.vehicles.find((x) => x.id === vid);
      if (!v) continue;
      const cur = v.body.translation();
      const np = new THREE.Vector3(cur.x, cur.y, cur.z).lerp(tg.p, k);
      const cq = v.body.rotation();
      const nq = new THREE.Quaternion(cq.x, cq.y, cq.z, cq.w).slerp(tg.q, k);
      v.body.setNextKinematicTranslation(np); v.body.setNextKinematicRotation(nq);
    }
  }

  get stateFromHost() { return this.lastNetState; }

  dispose() {
    this.offs.forEach((o) => o());
    this.offs = [];
    const loot = (this.w as any).loot;
    if (loot) { loot.onTake = null; loot.onSpawn = null; }
  }
}
