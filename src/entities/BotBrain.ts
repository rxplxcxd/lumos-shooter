import * as THREE from 'three';
import type { Soldier, Intent } from './Soldier';
import type { GameWorld } from '../gameplay/GameWorld';
import type { Actor } from '../gameplay/types';
import { Rng } from '../world/Noise';

type BotState = 'idle' | 'roam' | 'engage' | 'cover' | 'heal' | 'storm' | 'drop' | 'revive' | 'chase';
const tmp = new THREE.Vector3();
const rng = new Rng(1337);

/**
 * Utility AI for soldier bots: perception (vision cone + LOS raycasts + hearing), target
 * selection, cover seeking with occlusion checks, strafing, burst fire with skill-based aim
 * error, healing/plating, storm avoidance, reviving squad mates and parachute landing.
 */
export class BotBrain {
  s: Soldier;
  w: GameWorld;
  state: BotState = 'roam';
  target: Actor | null = null;
  goal = new THREE.Vector3();
  skill: number; // 0..1
  private think = rng.next() * 0.3;
  private strafe = 1;
  private strafeT = 0;
  private burst = 0;
  private burstCd = 0;
  private aimErr = new THREE.Vector3();
  private lastSeen = new THREE.Vector3();
  private lastSeenT = -100;
  private stuckT = 0;
  private lastPos = new THREE.Vector3();
  private coverT = 0;
  private reaction = 0;
  yaw = 0; pitch = 0;
  dropTarget: THREE.Vector3 | null = null;
  roamRadius = 400;
  home = new THREE.Vector3();
  aggressive = 0.6;
  /** optional patrol points (MP lanes / objectives) */
  waypoints: THREE.Vector3[] | null = null;
  lastIntent: Intent | null = null;

  constructor(s: Soldier, w: GameWorld, skill = 0.5) {
    this.s = s; this.w = w; this.skill = skill;
    this.yaw = s.yaw;
    this.pickRoam();
  }

  pickRoam() {
    if (this.waypoints?.length) { this.goal.copy(this.waypoints[Math.floor(rng.next() * this.waypoints.length)]).add(new THREE.Vector3(rng.range(-6, 6), 0, rng.range(-6, 6))); return; }
    const m = this.w.mode as any;
    const z = m?.zoneTarget?.();
    if (z && rng.chance(0.6)) {
      const a = rng.next() * Math.PI * 2, r = Math.sqrt(rng.next()) * z.r * 0.8;
      this.goal.set(z.x + Math.cos(a) * r, 0, z.z + Math.sin(a) * r);
    } else {
      const a = rng.next() * Math.PI * 2, r = 20 + rng.next() * Math.min(this.roamRadius, 160);
      this.goal.set(this.home.x + this.s.pos.x * 0.5 + Math.cos(a) * r, 0, this.home.z + this.s.pos.z * 0.5 + Math.sin(a) * r);
    }
    const lim = this.w.mapSize * 0.45;
    this.goal.x = THREE.MathUtils.clamp(this.goal.x, -lim, lim); this.goal.z = THREE.MathUtils.clamp(this.goal.z, -lim, lim);
    if (this.w.terrain.getHeight(this.goal.x, this.goal.z) < this.w.waterLevel + 1) this.goal.copy(this.s.pos);
  }

  canSee(a: Actor, maxDist: number) {
    const eye = this.s.eyePos(new THREE.Vector3());
    const te = a.eyePos(new THREE.Vector3());
    te.y -= 0.3;
    const d = eye.distanceTo(te);
    if (d > maxDist) return false;
    const dir = te.clone().sub(eye).normalize();
    // vision cone (wide when alerted)
    const fwd = new THREE.Vector3(Math.sin(this.s.yaw), 0, Math.cos(this.s.yaw));
    const cone = this.state === 'engage' ? -0.4 : 0.15;
    if (dir.clone().setY(0).normalize().dot(fwd) < cone && d > 8) return false;
    // crouched / prone targets in grass are harder to spot at range
    const s2 = a as any;
    if (s2.crouching && d > 60) return false;
    const hit = this.w.physics.raycast(eye, dir, d - 0.5, this.s.collider);
    return !hit;
  }

  findTarget() {
    const fogFar = this.w.sky.fog.far * 0.6;
    const range = Math.min(this.s.weapon.def.cls === 'sniper' ? 260 : 140, fogFar) * (0.7 + this.skill * 0.5);
    let best: Actor | null = null, bd = range;
    for (const a of this.w.actorsNear(this.s.pos, range)) {
      if (a === this.s || !a.alive || (a.team === this.s.team && a.kind === 'soldier')) continue;
      if ((a as any).inVehicle && !((a as any).inVehicle.exposedSeats)) {
        // target vehicles only with launchers
        if (this.s.weapon.def.cls !== 'launcher') continue;
      }
      const d = a.pos.distanceTo(this.s.pos) * (a.downed ? 1.5 : 1);
      if (d < bd && this.canSee(a, range)) { bd = d; best = a; }
    }
    return best;
  }

  /** gunshot / explosion awareness */
  hear(p: THREE.Vector3, loud: number) {
    if (this.state === 'engage') return;
    const d = p.distanceTo(this.s.pos);
    if (d < loud) { this.lastSeen.copy(p); this.lastSeenT = this.w.time; this.yaw = Math.atan2(p.x - this.s.pos.x, p.z - this.s.pos.z); if (this.state !== 'storm' && this.state !== 'drop') this.state = 'chase'; }
  }

  update(dt: number) {
    const s = this.s, w = this.w;
    if (!s.alive || s.frozen) return;
    if (s.inVehicle) { s.move(dt, { move: new THREE.Vector3(), sprint: false, crouch: false, jump: false, yaw: s.yaw, pitch: 0 }); return; }
    s.updateWeapon(dt);
    this.think -= dt;
    if (this.think <= 0) { this.think = 0.25 + rng.next() * 0.15; this.decide(); }

    const intent: Intent = { move: new THREE.Vector3(), sprint: false, crouch: false, jump: false, yaw: this.yaw, pitch: this.pitch };
    const toGoal = tmp.copy(this.goal).sub(s.pos).setY(0);
    const dist = toGoal.length();

    if (s.freefall) {
      if (this.dropTarget) {
        const d = this.dropTarget.clone().sub(s.pos).setY(0);
        if (d.length() > 5) intent.move.copy(d.normalize());
        this.yaw = Math.atan2(intent.move.x, intent.move.z) || this.yaw;
      }
      if (!s.parachute && s.pos.y - w.terrain.getHeight(s.pos.x, s.pos.z) < 150 + this.skill * 40) s.parachute = true;
    } else if (this.state === 'engage' && this.target) {
      const t = this.target;
      const tp = t.pos.clone();
      const d = tp.distanceTo(s.pos);
      const desired = s.weapon.def.cls === 'shotgun' || s.weapon.def.cls === 'smg' ? 8 : s.weapon.def.cls === 'sniper' ? 90 : 25;
      const toT = tp.clone().sub(s.pos).setY(0).normalize();
      const side = new THREE.Vector3(-toT.z, 0, toT.x).multiplyScalar(this.strafe);
      this.strafeT -= dt;
      if (this.strafeT <= 0) { this.strafe = rng.chance(0.5) ? 1 : -1; this.strafeT = 0.6 + rng.next() * 1.4; }
      intent.move.copy(side).multiplyScalar(0.8);
      if (d > desired * 1.3) intent.move.addScaledVector(toT, 0.9);
      else if (d < desired * 0.6) intent.move.addScaledVector(toT, -0.6);
      if (intent.move.lengthSq() > 1) intent.move.normalize();
      intent.crouch = this.burst > 0 && d > 20 && this.skill > 0.4 && Math.sin(w.time * 1.3 + s.id) > 0.3;
      this.aim(t, dt);
      s.lookTarget = t.eyePos(new THREE.Vector3());
      this.shoot(dt, d);
    } else {
      s.lookTarget = null;
      // walk to goal
      if (dist > 3) {
        intent.move.copy(toGoal.normalize());
        intent.sprint = this.state === 'storm' || this.state === 'cover' || this.state === 'revive' || dist > 60;
        const wantYaw = Math.atan2(intent.move.x, intent.move.z);
        this.yaw = lerpAngle(this.yaw, wantYaw, Math.min(1, dt * 6));
        this.pitch *= 0.9;
        this.avoid(intent, dt);
      } else if (this.state === 'roam' || this.state === 'chase') this.pickRoam();
      if (this.state === 'heal') { intent.move.set(0, 0, 0); intent.crouch = true; }
      if (this.state === 'revive' && dist < 1.5) {
        const mate = this.reviveTarget;
        if (mate && mate.downed) { this.reviveT += dt; intent.move.set(0, 0, 0); s.model.setLoco('revive', 0.2); if (this.reviveT > 4) { mate.revive(); this.reviveT = 0; this.state = 'roam'; } }
      }
    }
    intent.yaw = this.yaw; intent.pitch = this.pitch;
    this.lastIntent = intent;
    // physics LOD: far bots skip the character controller
    const pd = w.player ? s.pos.distanceTo(w.player.soldier.pos) : 0;
    s.physicsLOD = pd > 140 && !s.freefall;
    s.move(dt, intent);
    // stuck detection
    this.stuckT += dt;
    if (this.stuckT > 2.5) {
      if (s.pos.distanceTo(this.lastPos) < 1 && this.state !== 'engage' && this.state !== 'heal') { this.pickRoam(); intent.jump = true; }
      this.lastPos.copy(s.pos); this.stuckT = 0;
    }
  }
  private reviveTarget: Soldier | null = null;
  private reviveT = 0;

  private avoid(intent: Intent, _dt: number) {
    const s = this.s;
    if (s.physicsLOD) return;
    const fwd = intent.move;
    const knee = new THREE.Vector3(s.pos.x, s.pos.y + 0.5, s.pos.z);
    const hit = this.w.physics.raycast(knee, fwd, 2.2, s.collider);
    if (hit) {
      const head = new THREE.Vector3(s.pos.x, s.pos.y + 1.9, s.pos.z);
      if (!this.w.physics.raycast(head, fwd, 2.2, s.collider)) { intent.jump = true; return; }
      const left = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const hl = this.w.physics.raycast(knee, left.clone().add(fwd).normalize(), 3, s.collider);
      const hr = this.w.physics.raycast(knee, left.clone().negate().add(fwd).normalize(), 3, s.collider);
      const go = !hl ? left : !hr ? left.negate() : fwd.clone().negate();
      intent.move.copy(go.normalize());
    }
    // never walk into deep water unless the goal is across it
    const ahead = s.pos.clone().addScaledVector(fwd, 4);
    if (this.w.terrain.getHeight(ahead.x, ahead.z) < this.w.waterLevel - 1.3 && this.state !== 'storm') { intent.move.negate(); this.pickRoam(); }
  }

  private aim(t: Actor, dt: number) {
    const s = this.s;
    const eye = s.eyePos(new THREE.Vector3());
    const tp = t.eyePos(new THREE.Vector3());
    tp.y -= t.downed ? 0.2 : 0.45; // centre mass
    // lead moving targets (good bots)
    const d = eye.distanceTo(tp);
    const v = s.weapon.stats.velocity || 1000;
    tp.addScaledVector(t.vel, (d / v) * this.skill);
    tp.y += 0.5 * 9.81 * s.weapon.stats.gravity * (d / v) ** 2 * this.skill;
    // aim error shrinks while tracking
    const errMax = (1.4 - this.skill) * (0.5 + d * 0.012) * (t.vel.lengthSq() > 4 ? 1.4 : 1);
    this.aimErr.lerp(new THREE.Vector3((rng.next() - 0.5) * errMax, (rng.next() - 0.5) * errMax, (rng.next() - 0.5) * errMax), dt * 2);
    tp.add(this.aimErr);
    const dir = tp.sub(eye);
    const wantYaw = Math.atan2(dir.x, dir.z);
    const wantPitch = Math.atan2(dir.y, Math.hypot(dir.x, dir.z));
    const turn = (2.5 + this.skill * 6) * dt;
    this.yaw = lerpAngle(this.yaw, wantYaw, Math.min(1, turn));
    this.pitch = THREE.MathUtils.lerp(this.pitch, wantPitch, Math.min(1, turn));
  }

  private shoot(dt: number, d: number) {
    const s = this.s, w = this.w, wp = s.weapon;
    if (this.reaction > 0) { this.reaction -= dt; return; }
    if (wp.ammo <= 0) { s.startReload(); return; }
    if (wp.reloading > 0) return;
    this.burstCd -= dt;
    if (this.burst <= 0) {
      if (this.burstCd > 0) return;
      this.burst = wp.stats.auto ? 3 + Math.floor(rng.next() * (d < 20 ? 8 : 4)) : 1;
      this.burstCd = 0.25 + rng.next() * 0.6 * (1.2 - this.skill) + (d > 80 ? 0.6 : 0);
    }
    if (!wp.canFire()) return;
    // must face the target roughly
    const eye = s.eyePos(new THREE.Vector3());
    const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    const spread = THREE.MathUtils.degToRad(wp.spread(0.6, Math.min(1, Math.hypot(s.vel.x, s.vel.z) / 4), !s.grounded, s.crouching));
    const pellets = wp.stats.pellets ?? 1;
    for (let i = 0; i < pellets; i++) {
      const dd = dir.clone().add(new THREE.Vector3((rng.next() - 0.5) * spread * 2, (rng.next() - 0.5) * spread * 2, (rng.next() - 0.5) * spread * 2)).normalize();
      w.ballistics.fire(s, eye.clone().addScaledVector(dd, 0.6), dd, wp.stats, { tracer: i === 0 });
    }
    wp.ammo--;
    wp.cooldown = wp.interval * (1.1 + (1 - this.skill) * 0.5);
    s.lastShotTime = w.time;
    this.burst--;
    s.model.recoilKick(wp.def.cls === 'shotgun' || wp.def.cls === 'sniper' ? 1.6 : 0.5);
    w.effects.muzzle(eye.clone().addScaledVector(dir, 0.9), dir, wp.def.cls === 'shotgun', wp.stats.silenced);
    w.audio.play(wp.stats.silenced ? 'suppressed' : wp.stats.sound, { pos: s.pos, volume: wp.stats.silenced ? 0.35 : 0.8, maxDist: wp.stats.silenced ? 40 : 600 });
    w.bus.emit('shot', { shooter: s, pos: s.pos, silenced: wp.stats.silenced });
  }

  private decide() {
    const s = this.s, w = this.w;
    if (s.freefall) { this.state = 'drop'; return; }
    // storm overrides
    const m = w.mode as any;
    const inStorm = m?.outsideZone?.(s.pos, 0.85);
    // heal / plate when safe
    if (this.state !== 'engage' && s.armor < s.armorTier * 50 && s.plates > 0 && s.busyT <= 0) s.tryPlate();
    const tgt = this.findTarget();
    if (tgt) {
      if (this.target !== tgt) this.reaction = 0.35 + (1 - this.skill) * 0.5;
      this.target = tgt; this.state = 'engage'; this.lastSeen.copy(tgt.pos); this.lastSeenT = w.time;
      // retreat to cover when hurt
      if (s.health < 45 && s.armor <= 0 && this.coverT <= 0 && rng.chance(0.5 - this.aggressive * 0.3)) { if (this.findCover(tgt)) { this.state = 'cover'; this.coverT = 3; } }
      // swap to the better weapon for the distance
      const d = tgt.pos.distanceTo(s.pos);
      const other = s.weapons[1 - s.current];
      if (other && s.current < 2) {
        const close = (c: string) => c === 'shotgun' || c === 'smg' || c === 'pistol';
        if (d < 15 && close(other.def.cls) && !close(s.weapon.def.cls)) s.switchWeapon(1 - s.current);
        if (d > 40 && !close(other.def.cls) && close(s.weapon.def.cls)) s.switchWeapon(1 - s.current);
      }
      if (s.weapon.ammo === 0 && other && other.ammo > 0) s.switchWeapon(1 - s.current);
      return;
    }
    this.target = null;
    if (this.coverT > 0) { this.coverT -= 0.3; if (s.health < s.maxHealth && s.medkits > 0) s.tryHeal(); return; }
    if (inStorm) { const z = m.zoneTarget(); this.goal.set(z.x, 0, z.z); this.state = 'storm'; return; }
    if (s.health < 60 && s.medkits > 0 && s.busyT <= 0) { if (s.tryHeal()) { this.state = 'heal'; return; } }
    // revive squad mates
    const mate = w.soldiers.find((o) => o !== s && o.team === s.team && o.downed && o.pos.distanceTo(s.pos) < 60) ?? null;
    if (mate) { this.reviveTarget = mate; this.goal.copy(mate.pos); this.state = 'revive'; return; }
    if (w.time - this.lastSeenT < 8 && this.state !== 'roam') { this.goal.copy(this.lastSeen); this.state = 'chase'; return; }
    if (this.state !== 'roam' && this.state !== 'chase') { this.state = 'roam'; this.pickRoam(); }
    // loot nearby
    const loot = (w as any).loot?.nearestFor?.(s, 25);
    if (loot) { this.goal.copy(loot.pos); if (loot.pos.distanceTo(s.pos) < 2) (w as any).loot.pickup(s, loot); }
  }

  private findCover(threat: Actor): boolean {
    const s = this.s, w = this.w;
    const te = threat.eyePos(new THREE.Vector3());
    for (let i = 0; i < 10; i++) {
      const a = rng.next() * Math.PI * 2, r = 4 + rng.next() * 12;
      const p = s.pos.clone().add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
      p.y = w.terrain.getHeight(p.x, p.z) + 1.0;
      if (p.y < w.waterLevel + 0.5) continue;
      const dir = p.clone().sub(te); const len = dir.length(); dir.normalize();
      if (w.physics.raycast(te, dir, len - 0.5)) { this.goal.copy(p); return true; }
    }
    return false;
  }
}

export function lerpAngle(a: number, b: number, t: number) {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + d * t;
}
