import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { CharacterModel } from './CharacterModel';
import type { Actor, DamageInfo, HitZone } from '../gameplay/types';
import type { GameWorld } from '../gameplay/GameWorld';
import { rayCapsule, type Soldier } from './Soldier';
import { lerpAngle } from './BotBrain';

let ZID = 100000;

/** Grid flow-field (BFS from the target) – cheap navigation for 50+ zombies around walls & doors. */
export class NavGrid {
  readonly cell: number; readonly w: number; readonly h: number; readonly ox: number; readonly oz: number;
  blocked: Uint8Array; dist: Int32Array; private queue: Int32Array;
  constructor(cx: number, cz: number, width: number, depth: number, cell = 1) {
    this.cell = cell; this.w = Math.ceil(width / cell); this.h = Math.ceil(depth / cell);
    this.ox = cx - width / 2; this.oz = cz - depth / 2;
    this.blocked = new Uint8Array(this.w * this.h); this.dist = new Int32Array(this.w * this.h).fill(-1); this.queue = new Int32Array(this.w * this.h);
  }
  idx(x: number, z: number) {
    const ix = Math.floor((x - this.ox) / this.cell), iz = Math.floor((z - this.oz) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.w || iz >= this.h) return -1;
    return iz * this.w + ix;
  }
  blockBox(cx: number, cz: number, hx: number, hz: number, v = 1) {
    for (let x = cx - hx; x <= cx + hx; x += this.cell * 0.5) for (let z = cz - hz; z <= cz + hz; z += this.cell * 0.5) { const i = this.idx(x, z); if (i >= 0) this.blocked[i] = v; }
  }
  compute(tx: number, tz: number) {
    this.dist.fill(-1);
    const s = this.idx(tx, tz);
    if (s < 0) return;
    let head = 0, tail = 0;
    this.queue[tail++] = s; this.dist[s] = 0;
    while (head < tail) {
      const c = this.queue[head++];
      const cx = c % this.w, cz = (c / this.w) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= this.w || nz >= this.h) continue;
        const n = nz * this.w + nx;
        if (this.dist[n] >= 0 || this.blocked[n]) continue;
        this.dist[n] = this.dist[c] + 1;
        this.queue[tail++] = n;
      }
    }
  }
  /** direction toward the target from a world position (null = direct) */
  dir(x: number, z: number, out: THREE.Vector3): THREE.Vector3 | null {
    const i = this.idx(x, z);
    if (i < 0 || this.dist[i] < 0) return null;
    const cx = i % this.w, cz = (i / this.w) | 0;
    let best = this.dist[i], bx = 0, bz = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= this.w || nz >= this.h) continue;
      const n = nz * this.w + nx;
      if (this.dist[n] >= 0 && this.dist[n] < best) {
        if (dx && dz && (this.blocked[cz * this.w + nx] || this.blocked[nz * this.w + cx])) continue; // no corner cutting
        best = this.dist[n]; bx = dx; bz = dz;
      }
    }
    if (!bx && !bz) return null;
    return out.set(bx, 0, bz).normalize();
  }
}

export type ZombieType = 'walker' | 'runner' | 'brute' | 'hazmat';

/**
 * Zombie actor: chases the nearest living soldier (flow field when a NavGrid exists),
 * melee attacks, hit-zone reactions (headshot = head bone scaled away, leg damage = crawler),
 * barricade breaking and round-scaled health.
 */
export class Zombie implements Actor {
  id = ZID++;
  name = 'Zombie';
  team = 99;
  kind = 'zombie' as const;
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  alive = true;
  downed = false;
  health: number;
  maxHealth: number;
  armor = 0;
  isPlayer = false;
  radius = 0.4;
  height = 1.8;
  kills = 0; score = 0; lastHitTime = 0;
  inVehicle = null;
  model = new CharacterModel();
  w: GameWorld;
  type: ZombieType;
  speed: number;
  crawler = false;
  headless = false;
  target: Actor | null = null;
  private attackCd = 0;
  private thinkT = 0;
  private groanT = Math.random() * 6;
  private legDmg = 0;
  deadT = 0;
  body: RAPIER.RigidBody | null = null;
  collider: RAPIER.Collider | null = null;
  ctrl: RAPIER.KinematicCharacterController | null = null;
  nav: NavGrid | null = null;
  onDeath?: (z: Zombie, info: DamageInfo) => void;
  private lastPos = new THREE.Vector3();
  private stuckT = 0;
  private useModel: string;
  netRemote = false;
  netId = '';
  /** melee damage per hit (BR zombies hit softer than round-based ones) */
  hitDamage = 40;

  constructor(w: GameWorld, type: ZombieType, health: number, speed: number) {
    this.w = w; this.type = type; this.health = this.maxHealth = health; this.speed = speed;
    this.useModel = type === 'hazmat' ? 'zombie_hazmat' : type === 'brute' ? 'char_hero_m' : Math.random() < 0.5 ? 'char_mannequin' : 'char_mannequin_f';
    if (type === 'brute') { this.health = this.maxHealth = health * 3; this.radius = 0.55; }
  }

  async init() {
    const tint = this.useModel.startsWith('char_mannequin') ? [0x6f8a5a, 0x7a7a5a, 0x5a6a4a, 0x8a6a5a][(Math.random() * 4) | 0] : this.type === 'brute' ? 0x7a9a6a : undefined;
    await this.model.init(this.w.assets, this.useModel, tint);
    this.model.groundFn = (x, z) => this.w.terrain.getHeight(x, z);
    if (this.type === 'brute') this.model.root.scale.setScalar(1.35);
    this.w.scene.add(this.model.root);
    this.model.setLoco(this.speed > 3 ? 'zombieRun' : 'zombieWalk', 0, this.speed > 3 ? 1.1 : this.speed / 1.2);
    return this;
  }

  spawn(p: THREE.Vector3) {
    this.pos.copy(p);
    this.lastPos.copy(p);
    if (!this.body) {
      const ch = this.w.physics.createCharacter(new THREE.Vector3(p.x, p.y + 0.9, p.z), this.radius, 0.55);
      this.body = ch.body; this.collider = ch.collider; this.ctrl = ch.ctrl;
      this.ctrl.enableSnapToGround(0.6);
      this.w.registerCharacterCollider(this.collider, this);
    }
    this.w.audio.play('zombie_groan', { pos: p, volume: 0.6, maxDist: 50 });
  }

  eyePos(out: THREE.Vector3) { return out.set(this.pos.x, this.pos.y + (this.crawler ? 0.5 : 1.6 * this.model.root.scale.y), this.pos.z); }

  hitTest(o: THREE.Vector3, d: THREE.Vector3, maxDist: number): { dist: number; zone: HitZone } | null {
    if (!this.alive) return null;
    const p = this.pos, k = this.crawler ? 0.35 : this.model.root.scale.y;
    let best: { dist: number; zone: HitZone } | null = null;
    const test = (y0: number, y1: number, r: number, zone: HitZone) => {
      const t = rayCapsule(o, d, new THREE.Vector3(p.x, p.y + y0 * k, p.z), new THREE.Vector3(p.x, p.y + y1 * k, p.z), r * (zone === 'body' ? Math.max(1, k) : 1), maxDist);
      if (t >= 0 && (!best || t < best.dist)) best = { dist: t, zone };
    };
    if (!this.headless) test(1.5, 1.66, 0.17, 'head');
    test(0.85, 1.38, 0.32, 'body');
    test(0.1, 0.82, 0.25, 'legs');
    return best;
  }

  damage(amount: number, info: DamageInfo): number {
    if (!this.alive) return 0;
    if (this.netRemote && this.w.net) {
      if (info.attacker?.isPlayer) (info.attacker as Soldier).cash += 10;
      return this.w.net.remoteDamage(this, amount, info);
    }
    this.health -= amount;
    if (info.dir) this.model.flinch(info.dir, Math.min(2.5, amount / 40 + 0.5));
    this.lastHitTime = this.w.time;
    if (info.attacker?.kind === 'soldier') (info.attacker as Soldier).cash += 10; // CoD points per hit
    if (info.zone === 'legs') { this.legDmg += amount; if (!this.crawler && this.legDmg > this.maxHealth * 0.45 && Math.random() < 0.6) this.makeCrawler(); }
    if (this.health <= 0) {
      if (info.zone === 'head') this.popHead();
      this.die(info);
    }
    return amount;
  }

  private bone(name: string) { let b: THREE.Object3D | null = null; this.model.inner.traverse((o) => { if (o.name === name) b = o; }); return b as THREE.Object3D | null; }

  private makeCrawler() {
    this.crawler = true;
    this.speed *= 0.45;
    for (const n of ['calf_l', 'calf_r']) { const b = this.bone(n); if (b) b.scale.setScalar(0.01); }
    this.model.setLoco('downed', 0.2, 0.6);
    this.w.effects.burst(this.pos.clone().setY(this.pos.y + 0.5), 20, 3, 0x7a0a0a, 0.15, 0.8);
    this.w.audio.play('bone_crack', { pos: this.pos, volume: 0.7 });
  }

  private popHead() {
    const b = this.bone('Head');
    if (b) b.scale.setScalar(0.01);
    this.headless = true;
    const hp = this.eyePos(new THREE.Vector3());
    this.w.effects.burst(hp, 35, 5, 0x8a0000, 0.18, 0.9, 9.8, 1, 0.8);
    this.w.audio.play('splat_heavy', { pos: hp, volume: 0.8 });
  }

  die(info: DamageInfo) {
    this.alive = false;
    this.model.setLoco('dead', 0.1);
    if (info.dir) this.yaw = Math.atan2(-info.dir.x, -info.dir.z);
    if (info.explosive && info.point) { const a = this.pos.clone().sub(info.point).setY(0).normalize(); this.model.launch(new THREE.Vector3(a.x * 8, 7, a.z * 8).applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.yaw)); }
    if (this.w.lowSpec === false) this.w.effects.blood(this.pos, this.w.terrain.getHeight(this.pos.x, this.pos.z));
    this.collider?.setEnabled(false);
    this.w.audio.play('zombie_death', { pos: this.pos, volume: 0.7, maxDist: 50 });
    if (info.attacker?.kind === 'soldier') (info.attacker as Soldier).cash += info.zone === 'head' ? 100 : info.melee ? 130 : 60;
    this.w.onDeath(this, info);
    this.onDeath?.(this, info);
  }

  update(dt: number) {
    const w = this.w;
    const camD = this.pos.distanceTo(w.engine.camera.position);
    if (!this.alive) { this.deadT += dt; this.model.update(dt, camD); if (this.deadT > 6) this.model.root.position.y -= dt * 0.4; return; }
    if (this.netRemote) {
      // puppet: position comes from the host, only animate
      const sp = Math.hypot(this.vel.x, this.vel.z);
      if (!this.crawler) this.model.setLoco(sp > 0.3 ? (sp > 3 ? 'zombieRun' : 'zombieWalk') : 'zombieIdle', 0.25, sp > 3 ? sp / 4.5 : Math.max(0.6, sp / 1.2));
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      this.model.proc.move.set(this.vel.x * -fz + this.vel.z * fx, this.vel.x * fx + this.vel.z * fz);
      this.model.proc.kind = 'zombie';
      this.model.update(dt, camD);
      this.model.root.position.copy(this.pos);
      this.model.root.rotation.y = this.yaw;
      this.model.root.visible = camD < 220;
      return;
    }
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = 0.4 + Math.random() * 0.3;
      let best: Actor | null = null, bd = 1e9;
      for (const s of w.soldiers) { if (!s.alive) continue; const d = s.pos.distanceToSquared(this.pos) * (s.downed ? 2 : 1); if (d < bd) { bd = d; best = s; } }
      this.target = best;
    }
    const t = this.target;
    const move = new THREE.Vector3();
    if (t) {
      const to = t.pos.clone().sub(this.pos).setY(0);
      const d = to.length();
      if (d < 1.5 + this.radius) {
        this.attackCd -= dt;
        if (this.attackCd <= 0) {
          this.attackCd = 1.3;
          this.model.setUpper('zombieAttack', 0.1, 0.9);
          w.audio.play('zombie_swipe', { pos: this.pos, volume: 0.7 });
          setTimeout(() => { if (this.alive && t.alive && t.pos.distanceTo(this.pos) < 2.3) t.damage(this.type === 'brute' ? this.hitDamage * 1.5 : this.hitDamage, { attacker: this, melee: true }); }, 450);
        }
      } else {
        const flow = this.nav?.dir(this.pos.x, this.pos.z, new THREE.Vector3());
        move.copy(flow && d > 3 ? flow : to.normalize());
      }
      if (to.lengthSq() > 0.01) this.yaw = lerpAngle(this.yaw, Math.atan2(to.x, to.z), Math.min(1, dt * 5));
      if (move.lengthSq() > 0) this.yaw = lerpAngle(this.yaw, Math.atan2(move.x, move.z), Math.min(1, dt * 4));
    }
    // separation from other zombies
    for (const o of w.actorsNear(this.pos, 1.2)) {
      if (o === this || o.kind !== 'zombie') continue;
      const away = this.pos.clone().sub(o.pos).setY(0);
      const l = away.length();
      if (l > 0.01) move.addScaledVector(away.divideScalar(l), (1.2 - l) * 0.8);
    }
    const sp = this.speed * (this.crawler ? 1 : 1);
    this.vel.x = move.x * sp; this.vel.z = move.z * sp;
    this.vel.y -= 20 * dt;
    const desired = this.vel.clone().multiplyScalar(dt);
    if (this.ctrl && this.collider && camD < 70) {
      this.ctrl.computeColliderMovement(this.collider, desired, undefined, undefined, (c) => !w.isCharacterCollider(c));
      const m = this.ctrl.computedMovement();
      this.pos.x += m.x; this.pos.y += m.y; this.pos.z += m.z;
      if (this.ctrl.computedGrounded()) this.vel.y = 0;
    } else {
      this.pos.add(desired);
      const gh = w.terrain.getHeight(this.pos.x, this.pos.z);
      if (this.pos.y < gh) { this.pos.y = gh; this.vel.y = 0; }
    }
    const gh = w.terrain.getHeight(this.pos.x, this.pos.z);
    if (this.pos.y < gh - 0.5) { this.pos.y = gh; this.vel.y = 0; }
    this.body?.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y + 0.9, z: this.pos.z });
    // break barricades / doors in the way
    this.stuckT += dt;
    if (this.stuckT > 1.5) { if (this.pos.distanceTo(this.lastPos) < 0.3 && t) (w.mode as any)?.zombieBlocked?.(this); this.lastPos.copy(this.pos); this.stuckT = 0; }
    this.groanT -= dt;
    if (this.groanT <= 0) { this.groanT = 4 + Math.random() * 8; w.audio.play(Math.random() < 0.5 ? 'zombie_groan' : 'zombie_snarl', { pos: this.pos, volume: 0.5, maxDist: 35 }); }
    if (!this.crawler) this.model.setLoco(move.lengthSq() > 0.05 ? (this.speed > 3 ? 'zombieRun' : 'zombieWalk') : 'zombieIdle', 0.25, this.speed > 3 ? this.speed / 4.5 : Math.max(0.6, this.speed / 1.2));
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    this.model.proc.move.set(this.vel.x * -fz + this.vel.z * fx, this.vel.x * fx + this.vel.z * fz);
    this.model.proc.kind = 'zombie';
    this.model.proc.lookAt = t ? t.eyePos(new THREE.Vector3()) : null;
    this.model.update(dt, camD);
    this.model.root.position.copy(this.pos);
    this.model.root.rotation.y = this.yaw;
    this.model.root.visible = camD < 220;
  }

  dispose() {
    this.model.dispose();
    if (this.collider) { this.w.unregisterCharacterCollider(this.collider); this.w.physics.removeCollider(this.collider); }
    if (this.ctrl) this.w.physics.world.removeCharacterController(this.ctrl);
    this.collider = null; this.ctrl = null;
  }
}
