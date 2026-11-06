import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { CharacterModel } from './CharacterModel';
import { QUALITY_PRESETS, settings } from '../core/Settings';
import { Weapon } from '../weapons/Weapon';
import type { Actor, DamageInfo, HitZone } from '../gameplay/types';
import type { GameWorld } from '../gameplay/GameWorld';
import type { Vehicle } from '../vehicles/Vehicle';

let NEXT_ID = 1;
const UP = new THREE.Vector3(0, 1, 0);
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();

export interface Intent {
  move: THREE.Vector3; // world-space XZ, length 0..1
  sprint: boolean;
  crouch: boolean;
  jump: boolean;
  yaw: number;
  pitch: number;
}

/** ray vs capsule (segment p0-p1, radius r) – returns distance along ray or -1 */
export function rayCapsule(o: THREE.Vector3, d: THREE.Vector3, p0: THREE.Vector3, p1: THREE.Vector3, r: number, maxDist: number) {
  // closest points between ray (o + t d) and segment (p0 + s (p1-p0))
  const u = d, v = tmpA.copy(p1).sub(p0), w0 = tmpB.copy(o).sub(p0);
  const a = 1, b = u.dot(v), c = v.dot(v), dd = u.dot(w0), e = v.dot(w0);
  const den = a * c - b * b;
  let s = den > 1e-6 ? (a * e - b * dd) / den : 0;
  s = Math.max(0, Math.min(1, s));
  let t = b * s - dd;
  if (t < 0) t = 0;
  if (t > maxDist) return -1;
  const pc = tmpC.copy(p0).addScaledVector(v, s);
  const pr = o.clone().addScaledVector(u, t);
  const dist = pc.distanceTo(pr);
  if (dist > r) return -1;
  return Math.max(0, t - Math.sqrt(r * r - dist * dist));
}

export class Soldier implements Actor {
  id = NEXT_ID++;
  name: string;
  team: number;
  kind = 'soldier' as const;
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  alive = true;
  downed = false;
  downedTime = 0;
  bleedOut = 30;
  health = 100;
  maxHealth = 100;
  armor = 0;
  armorTier = 0; // max plates 0..3
  isPlayer = false;
  radius = 0.35;
  height = 1.8;
  kills = 0;
  deaths = 0;
  score = 0;
  cash = 0;
  lastHitTime = -100;
  lastDamageTime = -100;
  inVehicle: Vehicle | null = null;
  seat = 0;
  model = new CharacterModel();
  w: GameWorld;
  body: RAPIER.RigidBody | null = null;
  collider: RAPIER.Collider | null = null;
  ctrl: RAPIER.KinematicCharacterController | null = null;
  grounded = true;
  crouching = false;
  sprinting = false;
  slideT = 0;
  slideDir = new THREE.Vector3();
  swimming = false;
  underwater = false;
  freefall = false;
  parachute = false;
  climbing = 0;
  climbFrom = new THREE.Vector3();
  climbTo = new THREE.Vector3();
  airTime = 0;
  stepDist = 0;
  physicsLOD = false;
  // inventory
  weapons: (Weapon | null)[] = [null, null];
  knife = new Weapon('knife');
  current = 0; // 0,1 = guns, 2 = knife
  reserve: Record<string, number> = { light: 90, heavy: 60, shells: 16, sniper: 10, rockets: 2, none: 0 };
  grenades = 2;
  medkits = 1;
  syringes = 0;
  plates = 2;
  busyT = 0; // healing / plating / throwing lock
  busyKind: '' | 'heal' | 'plate' | 'throw' | 'revive' | 'syringe' = '';
  perks = new Set<string>();
  ads = 0; // 0..1
  adsHeld = false;
  leaning = 0;
  heldModel: THREE.Object3D | null = null;
  heldFor = '';
  silencedUntil = 0;
  lastShotTime = -100;
  tint: number;
  killedBy: Actor | null = null;
  spectating = false;
  lastSafePos = new THREE.Vector3();
  /** e.g. sitting in the drop plane */
  frozen = false;
  /** multiplayer: '' local, 'human' remote player puppet, 'bot' host-bot puppet */
  netRemote: '' | 'human' | 'bot' = '';
  netId = '';
  private lastFallY = 0;
  private blockedFallT = 0;

  constructor(w: GameWorld, name: string, team: number, tint: number) {
    this.w = w; this.name = name; this.team = team; this.tint = tint;
  }

  async init(modelId = 'char_mannequin', gear = QUALITY_PRESETS[settings.data.quality].gear) {
    await this.model.init(this.w.assets, modelId, this.tint);
    this.model.groundFn = (x, z) => this.w.terrain.getHeight(x, z);
    if (gear) await this.model.addGear(this.w.assets, this.team === 0 ? 0x4b5a3a : [0x5a4a36, 0x3e4a52, 0x4a3a3a, 0x52523a][this.team % 4]);
    this.w.scene.add(this.model.root);
    return this;
  }
  private lastYaw = 0;
  private sprintHeat = 0;
  lookTarget: THREE.Vector3 | null = null;

  spawnAt(p: THREE.Vector3) {
    this.pos.copy(p);
    this.vel.set(0, 0, 0);
    this.alive = true; this.downed = false;
    this.health = this.maxHealth;
    this.model.resetPose();
    this.model.setVisible(true);
    this.model.setLoco('idle', 0);
    if (!this.body) {
      const ch = this.w.physics.createCharacter(new THREE.Vector3(this.pos.x, this.pos.y + 0.9, this.pos.z), this.radius, 0.55);
      this.body = ch.body; this.collider = ch.collider; this.ctrl = ch.ctrl;
      this.w.registerCharacterCollider(this.collider, this);
    } else {
      this.body.setNextKinematicTranslation(this.capsuleCenter());
      this.body.setTranslation(this.capsuleCenter(), true);
    }
    this.collider?.setEnabled(true);
    this.lastSafePos.copy(p);
  }

  capsuleCenter() { return { x: this.pos.x, y: this.pos.y + 0.9, z: this.pos.z }; }

  get weapon(): Weapon { return this.current === 2 ? this.knife : (this.weapons[this.current] ?? this.weapons[1 - this.current] ?? this.knife); }

  eyePos(out: THREE.Vector3) {
    const h = this.downed ? 0.5 : this.crouching || this.slideT > 0 ? 1.15 : this.swimming ? 1.45 : 1.65;
    out.set(this.pos.x, this.pos.y + h, this.pos.z);
    if (this.leaning) {
      out.x += Math.cos(this.yaw) * this.leaning * -0.45;
      out.z += -Math.sin(this.yaw) * this.leaning * -0.45;
      out.y -= Math.abs(this.leaning) * 0.08;
    }
    return out;
  }

  hitTest(o: THREE.Vector3, d: THREE.Vector3, maxDist: number): { dist: number; zone: HitZone } | null {
    if (!this.alive) return null;
    if (this.inVehicle && !this.inVehicle.exposedSeats) return null;
    const p = this.pos;
    const crouchK = this.downed ? 0.3 : this.crouching || this.slideT > 0 ? 0.68 : 1;
    let best: { dist: number; zone: HitZone } | null = null;
    const test = (y0: number, y1: number, r: number, zone: HitZone) => {
      const t = rayCapsule(o, d, tmpA.set(p.x, p.y + y0 * crouchK, p.z).clone(), new THREE.Vector3(p.x, p.y + y1 * crouchK, p.z), r, maxDist);
      if (t >= 0 && (!best || t < best.dist)) best = { dist: t, zone };
    };
    test(1.52, 1.68, 0.16, 'head');
    test(0.85, 1.38, 0.3, 'body');
    test(0.1, 0.82, 0.24, 'legs');
    return best;
  }

  damage(amount: number, info: DamageInfo): number {
    if (!this.alive) return 0;
    if (this.w.mode && !this.w.mode.canDamage(this, info)) return 0;
    if (this.netRemote && this.w.net) return this.w.net.remoteDamage(this, amount, info);
    if (this.perks.has('juggernog')) amount *= 0.5;
    let dealt = 0;
    if (this.armor > 0 && !info.storm) {
      const a = Math.min(this.armor, amount);
      this.armor -= a; amount -= a; dealt += a;
      if (this.armor <= 0) this.w.bus.emit('armorBroken', this);
    }
    this.health -= amount;
    dealt += amount;
    this.lastDamageTime = this.w.time;
    if (info.attacker && info.attacker !== this) this.lastAttacker = info.attacker;
    if (info.dir) this.model.flinch(info.dir, Math.min(2, dealt / 25 + 0.4));
    this.w.bus.emit('damage', { target: this, amount: dealt, info });
    if (this.health <= 0) {
      if (!this.downed && this.w.mode?.allowDowned(this)) this.goDown(info);
      else this.die(info);
    } else if (!this.downed && this.model.upper === this.model.upperBase && Math.random() < 0.3) {
      this.model.setUpper('hit', 0.05, 0.3);
    }
    return dealt;
  }
  lastAttacker: Actor | null = null;

  goDown(info: DamageInfo) {
    this.downed = true;
    this.health = 100; // bleed-out health
    this.downedTime = this.w.time;
    this.busyT = 0; this.busyKind = '';
    this.model.setLoco('downed', 0.2);
    this.w.bus.emit('downed', { target: this, info });
  }

  revive() {
    this.downed = false;
    this.health = 30;
    this.model.setLoco('idle', 0.3);
    this.w.bus.emit('revived', this);
  }

  die(info: DamageInfo) {
    if (!this.alive) return;
    this.alive = false;
    this.downed = false;
    this.deaths++;
    this.health = 0;
    this.killedBy = info.attacker ?? null;
    if (this.inVehicle) this.inVehicle.exit(this, true);
    this.model.setUpper('none', 0.1);
    this.model.setLoco('dead', 0.15);
    // fall away from the shot; explosions throw the body
    if (info.dir) this.yaw = Math.atan2(-info.dir.x, -info.dir.z);
    if (info.explosive && info.point) {
      const away = this.pos.clone().sub(info.point).setY(0).normalize();
      this.model.launch(new THREE.Vector3(away.x * 7, 6.5, away.z * 7).applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.yaw));
    }
    this.collider?.setEnabled(false);
    this.w.onDeath(this, info);
  }

  /** core movement – used by player and nearby bots (Rapier KCC); far bots use cheap terrain snapping */
  move(dt: number, intent: Intent) {
    if (!this.alive || this.frozen) return;
    this.yaw = intent.yaw; this.pitch = intent.pitch;
    if (this.inVehicle) { this.inVehicle.seatTransform(this, this.pos); this.body?.setNextKinematicTranslation(this.capsuleCenter()); return; }
    const w = this.w;
    const water = w.waterLevel;
    const ground = w.terrain.getHeight(this.pos.x, this.pos.z);
    const depth = water - Math.max(ground, this.pos.y);
    this.swimming = !this.freefall && !this.parachute && water - ground > 1.35 && this.pos.y < water - 0.9;
    this.underwater = this.swimming && this.pos.y < water - 1.6;
    void depth;

    if (this.climbing > 0) {
      this.climbing -= dt;
      const t = 1 - Math.max(this.climbing, 0) / 0.55;
      this.pos.lerpVectors(this.climbFrom, this.climbTo, t);
      this.pos.y = THREE.MathUtils.lerp(this.climbFrom.y, this.climbTo.y, Math.min(1, t * 1.6));
      this.vel.set(0, 0, 0);
      this.body?.setNextKinematicTranslation(this.capsuleCenter());
      return;
    }

    // ----- desired horizontal velocity (acceleration / friction model)
    const wantCrouch = intent.crouch && !this.swimming;
    let speed = 4.5;
    const wpn = this.weapon;
    const moving = intent.move.lengthSq() > 0.01;
    this.sprinting = intent.sprint && moving && !wantCrouch && this.ads < 0.3 && !this.downed && this.busyT <= 0;
    if (this.sprinting) speed = (this.perks.has('staminup') ? 7.9 : 7.1) + (this.sprintBoost > 0 ? 0.8 : 0);
    if (wantCrouch) speed = 2.4;
    if (this.downed) speed = 0.9;
    if (this.swimming) speed = this.sprinting ? 3.4 : 2.2;
    speed *= wpn.stats.moveMul * (1 - this.ads * 0.42);
    if (this.busyKind === 'plate' || this.busyKind === 'heal') speed *= 0.55;
    if (this.sprintBoost > 0) this.sprintBoost -= dt;
    // slope: slower uphill, a little faster downhill
    if (this.grounded && moving && !this.freefall) {
      const n = w.terrain.getNormal(this.pos.x, this.pos.z, tmpC);
      const up = -(n.x * intent.move.x + n.z * intent.move.z);
      speed *= THREE.MathUtils.clamp(1 - up * 0.9, 0.55, 1.12);
    }

    // slide: sprint + crouch keeps momentum, friction bleeds it off, downhill slides accelerate
    if (this.sprinting && intent.crouch && this.slideT <= 0 && this.grounded) {
      this.slideT = 1.1;
      this.slideDir.copy(intent.move).normalize();
      this.slideSpeed = Math.max(Math.hypot(this.vel.x, this.vel.z), 6.5) + 2.2;
      w.audio.play('step_gravel', { pos: this.pos, volume: 0.6 });
    }
    if (this.slideT > 0) {
      this.slideT -= dt;
      const n = w.terrain.getNormal(this.pos.x, this.pos.z, tmpC);
      const downhill = n.x * this.slideDir.x + n.z * this.slideDir.z;
      this.slideSpeed = Math.max(0, this.slideSpeed - (5.2 - downhill * 14) * dt);
      if ((!intent.crouch && this.slideT < 0.85) || this.slideSpeed < 3.2) this.slideT = 0; // slide cancel / stop
      if (intent.jump && this.slideT > 0) { this.slideT = 0; this.vel.y = 5.6; this.grounded = false; this.model.setLoco('jump', 0.08); } // slide-jump keeps momentum
    }
    this.crouching = wantCrouch || this.slideT > 0;

    const target = tmpA.copy(intent.move).multiplyScalar(speed);
    if (this.slideT > 0) target.copy(this.slideDir).multiplyScalar(this.slideSpeed);
    if (this.freefall) this.glide(dt, intent, target);
    else {
      // ground: strong acceleration and friction; air: limited control, momentum preserved
      const cur = Math.hypot(this.vel.x, this.vel.z);
      const accel = this.grounded || this.swimming ? (target.lengthSq() > cur * cur ? 11 : 13) : 2.2;
      this.vel.x += (target.x - this.vel.x) * Math.min(1, accel * dt);
      this.vel.z += (target.z - this.vel.z) * Math.min(1, accel * dt);
    }

    // ----- vertical
    if (this.swimming) {
      const surf = water - 1.35;
      const wantY = intent.crouch ? -2 : intent.jump ? 1.6 : (surf - this.pos.y) * 2;
      this.vel.y += (wantY - this.vel.y) * Math.min(1, 4 * dt);
    } else if (!this.freefall) {
      this.vel.y -= 18.5 * dt; // slightly heavier than real gravity for a grounded shooter feel
      if (this.vel.y < -55) this.vel.y = -55;
      if (this.grounded && intent.jump && !this.crouching && !this.downed && this.slideT <= 0) {
        if (!this.tryMantle()) { this.vel.y = 6.6; this.grounded = false; this.model.setLoco('jump', 0.08); }
      }
    }

    const desired = tmpB.copy(this.vel).multiplyScalar(dt);
    if (this.physicsLOD || !this.ctrl || !this.collider) {
      this.pos.add(desired);
      const gh = w.terrain.getHeight(this.pos.x, this.pos.z);
      if (this.swimming) { /* free */ } else if (this.pos.y <= gh) { this.pos.y = gh; this.vel.y = Math.max(0, this.vel.y); this.grounded = true; } else this.grounded = this.pos.y - gh < 0.05;
      this.body?.setNextKinematicTranslation(this.capsuleCenter());
    } else {
      this.ctrl.computeColliderMovement(this.collider, desired, undefined, undefined, (c) => !w.isCharacterCollider(c));
      const m = this.ctrl.computedMovement();
      const wasAir = !this.grounded;
      this.grounded = this.ctrl.computedGrounded();
      this.pos.x += m.x; this.pos.y += m.y; this.pos.z += m.z;
      // safety: never sink under the heightfield
      const gh = w.terrain.getHeight(this.pos.x, this.pos.z);
      if (this.pos.y < gh - 0.6 && !this.swimming) { this.pos.y = gh; this.vel.y = 0; this.grounded = true; }
      if (this.grounded && this.vel.y < 0) {
        if (wasAir && this.airTime > 0.35) this.onLand(-this.vel.y);
        this.vel.y = 0;
      }
      // horizontal velocity follows actual movement (wall sliding)
      if (dt > 0) { this.vel.x = m.x / dt; this.vel.z = m.z / dt; }
      this.body!.setNextKinematicTranslation(this.capsuleCenter());
    }
    // freefall ends on terrain, water, roofs (blocked vertical movement) or when grounded
    if (this.freefall) {
      const fell = this.pos.y < this.lastFallY - 0.05;
      this.blockedFallT = fell ? 0 : this.blockedFallT + dt;
      this.lastFallY = this.pos.y;
    }
    if (this.freefall && (this.pos.y - w.terrain.getHeight(this.pos.x, this.pos.z) < 1.2 || this.grounded || this.swimming || this.blockedFallT > 0.35)) {
      this.blockedFallT = 0;
      this.freefall = false; this.parachute = false;
      this.w.bus.emit('landed', this);
      this.onLand(this.parachute ? 3 : 6);
    }
    this.airTime = this.grounded || this.swimming ? 0 : this.airTime + dt;
    if (this.grounded) this.lastSafePos.copy(this.pos);
    this.footsteps(dt);
  }

  /**
   * Warzone-style skydive: the direction of the movement input (relative to the camera) is the
   * glide direction. Forward = strong diagonal glide, looking down + forward = steep dive,
   * back = flare. With the canopy open the glide ratio is high, so far-away POIs are reachable.
   */
  private glide(dt: number, intent: Intent, out: THREE.Vector3) {
    const fwd = tmpB.set(Math.sin(intent.yaw), 0, Math.cos(intent.yaw));
    const f = intent.move.dot(fwd);
    const look = THREE.MathUtils.clamp(-intent.pitch, -0.3, 1.2); // >0 looking down
    const input = intent.move.length();
    let horiz: number, sink: number;
    if (!this.parachute) {
      const dive = Math.max(0, f) * THREE.MathUtils.smoothstep(look, 0.35, 1.0);
      const glideK = input * (1 - dive);
      horiz = 7 + glideK * 38 + dive * 18 - Math.max(0, -f) * 6;
      sink = 44 + dive * 26 - glideK * 10 - Math.max(0, -f) * 6;
      this.diveK = THREE.MathUtils.lerp(this.diveK, dive, Math.min(1, dt * 3));
    } else {
      const brake = Math.max(0, -f);
      horiz = 7 + Math.max(0, f) * 16 + (input - Math.abs(f)) * 9 - brake * 5;
      sink = 6.2 + Math.max(0, f) * 1.4 - brake * 2;
      this.diveK = THREE.MathUtils.lerp(this.diveK, 0, Math.min(1, dt * 3));
    }
    // direction: input direction, or forward drift when there is no input
    const dir = input > 0.05 ? tmpC.copy(intent.move).normalize() : tmpC.copy(fwd);
    out.copy(dir).multiplyScalar(Math.max(0, horiz));
    const accH = this.parachute ? 4 : 2.6;
    this.vel.x += (out.x - this.vel.x) * Math.min(1, accH * dt);
    this.vel.z += (out.z - this.vel.z) * Math.min(1, accH * dt);
    this.vel.y += (-sink - this.vel.y) * Math.min(1, (this.parachute ? 2.5 : 0.9) * dt);
    this.glideSpeed = Math.hypot(this.vel.x, this.vel.z, this.vel.y);
  }

  onLand(impact: number) {
    if (impact > 12 && !this.freefall) this.damage((impact - 12) * 10, { attacker: null });
    this.model.landKick(Math.min(2, impact / 6));
    this.model.setLoco('land', 0.05);
    const s = this.w.terrain.surfaceAt(this.pos.x, this.pos.z);
    this.w.audio.play(`land_${stepSurface(s)}`, { pos: this.pos, volume: 0.7, maxDist: 40 });
  }

  /** contextual vault / mantle over waist-to-chest high obstacles */
  tryMantle(): boolean {
    const w = this.w;
    const fwd = tmpC.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const knee = new THREE.Vector3(this.pos.x, this.pos.y + 0.6, this.pos.z);
    const hit = w.physics.raycast(knee, fwd, 1.0, this.collider);
    if (!hit) return false;
    const above = new THREE.Vector3(hit.point.x, this.pos.y + 2.3, hit.point.z).addScaledVector(fwd, 0.35);
    const down = w.physics.raycast(above, new THREE.Vector3(0, -1, 0), 2.2, this.collider);
    if (!down) return false;
    const rise = down.point.y - this.pos.y;
    if (rise < 0.4 || rise > 2.0) return false;
    // space check
    const head = w.physics.raycast(down.point.clone().add(new THREE.Vector3(0, 0.05, 0)), UP, 1.7, this.collider);
    if (head) return false;
    this.climbFrom.copy(this.pos);
    this.climbTo.copy(down.point).addScaledVector(fwd, 0.2);
    this.climbing = 0.55;
    this.model.setLoco('climb', 0.05, 1.6);
    w.audio.play('step_metal', { pos: this.pos, volume: 0.4 });
    return true;
  }

  footsteps(dt: number) {
    if (!this.grounded || this.swimming) {
      if (this.swimming && this.vel.lengthSq() > 1) { this.stepDist += dt * 1.5; if (this.stepDist > 1.2) { this.stepDist = 0; this.w.audio.play('step_water', { pos: this.pos, volume: 0.4, maxDist: 25 }); } }
      return;
    }
    const sp = Math.hypot(this.vel.x, this.vel.z);
    this.stepDist += sp * dt;
    const stride = this.sprinting ? 2.4 : 1.7;
    if (this.stepDist > stride && sp > 1) {
      this.stepDist = 0;
      if (this.crouching && !this.sprinting) return; // crouch walk is silent
      const s = this.w.surfaceUnder(this);
      const vol = this.sprinting ? 0.55 : 0.32;
      this.w.audio.play(`step_${stepSurface(s)}`, { pos: this.pos, volume: this.isPlayer ? vol * 0.5 : vol, maxDist: this.sprinting ? 45 : 28 });
    }
  }

  /** pick the locomotion animation from the physical state */
  animate(dt: number, camDist: number) {
    const m = this.model;
    if (!this.alive) { m.update(dt, camDist); this.syncModel(); return; }
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (this.inVehicle) m.setLoco(this.seat === 0 ? 'drive' : 'sit', 0.2);
    else if (this.downed) m.setLoco('downed', 0.2);
    else if (this.climbing > 0) { /* keep climb */ }
    else if (this.freefall) m.setLoco(this.parachute ? 'fall' : 'freefall', 0.3);
    else if (this.swimming) m.setLoco(sp > 0.5 ? 'swim' : 'swimIdle', 0.3);
    else if (this.slideT > 0) m.setLoco('slide', 0.1);
    else if (!this.grounded && this.airTime > 0.25) m.setLoco('fall', 0.25);
    else if (this.crouching) m.setLoco(sp > 0.4 ? 'crouchWalk' : 'crouchIdle', 0.2, Math.max(0.6, sp / 2));
    else if (sp > 6.2) m.setLoco('sprint', 0.2, sp / 7.4);
    else if (sp > 3) m.setLoco('jog', 0.2, sp / 4.5);
    else if (sp > 0.4) m.setLoco('walk', 0.2, Math.max(0.7, sp / 1.6));
    else if (m.loco !== 'land' || m.loco === 'land') m.setLoco('idle', 0.25);
    const armed = this.weapon.def.cls !== 'melee' && !this.inVehicle && !this.swimming && !this.downed && !this.sprinting && !this.freefall;
    const base = armed ? (this.ads > 0.5 || this.w.time - this.lastShotTime < 1.2 ? 'aim' : 'hold') : 'none';
    if (m.upperBase !== base) { m.upperBase = base; if (m.upper === 'none' || m.upper === 'aim' || m.upper === 'hold') m.setUpper(base, 0.18); }
    m.aimPitch = armed ? this.pitch : 0;
    // procedural layer inputs: local velocity, turn rate, breath, look target
    const fy = this.yaw, fx = Math.sin(fy), fz = Math.cos(fy);
    m.proc.move.set(this.vel.x * -fz + this.vel.z * fx, this.vel.x * fx + this.vel.z * fz);
    let dy = this.yaw - this.lastYaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    m.proc.yawRate = dt > 0 ? THREE.MathUtils.lerp(m.proc.yawRate, dy / dt, 0.2) : 0;
    this.lastYaw = this.yaw;
    this.sprintHeat = THREE.MathUtils.clamp(this.sprintHeat + (this.sprinting ? dt * 0.15 : -dt * 0.08), 0, 1);
    m.proc.breath = this.sprintHeat;
    m.proc.aimPitch = armed ? this.pitch : 0;
    m.proc.lookAt = this.lookTarget;
    m.proc.kind = 'soldier';
    m.update(dt, camDist);
    this.syncModel();
    this.syncHeld();
  }

  syncModel() {
    const r = this.model.root;
    r.position.copy(this.pos);
    // skydiving pose: body horizontal, steeper when diving, upright under the canopy
    const inner = this.model.inner;
    if (inner && this.alive) {
      const want = this.freefall && !this.parachute ? 1.0 + this.diveK * 0.5 : 0;
      inner.rotation.x = THREE.MathUtils.lerp(inner.rotation.x, want, 0.12);
      if (!this.freefall && Math.abs(inner.rotation.x) < 0.02 && inner.rotation.x !== 0 && this.alive) inner.rotation.x = 0;
      inner.position.y = this.freefall && !this.parachute ? 0.9 : inner.position.y * 0.9;
    }
    if (this.swimming) r.position.y = Math.min(this.pos.y, this.w.waterLevel - 1.4);
    r.rotation.y = this.yaw;
  }

  /** third-person weapon in hand (bots & TPS player) */
  async syncHeld() {
    const want = this.inVehicle || this.swimming || this.downed || !this.alive || this.freefall ? '' : this.weapon.def.id + (this.weapon.attachments.join(','));
    if (want === this.heldFor) return;
    this.heldFor = want;
    if (!want) { this.model.attach(null); return; }
    const obj = await this.w.weaponModel(this.weapon);
    if (this.heldFor !== want) return;
    this.model.attach(obj);
  }

  // ------------------------------------------------------------------ inventory helpers
  give(w: Weapon): Weapon | null {
    const slot = this.weapons[0] == null ? 0 : this.weapons[1] == null ? 1 : this.current === 2 ? 0 : this.current;
    const old = this.weapons[slot];
    this.weapons[slot] = w;
    this.current = slot;
    this.reserve[w.def.ammo] = Math.max(this.reserve[w.def.ammo] ?? 0, w.stats.mag * 2);
    return old;
  }

  switchWeapon(i: number) {
    if (i === this.current) return;
    if (i < 2 && !this.weapons[i]) return;
    this.current = i;
    this.weapon.reloading = 0;
    this.weapon.cooldown = 0.35;
    this.w.audio.play('bolt_pull', { pos: this.pos, volume: 0.3, maxDist: 15 });
  }

  startReload() {
    const wp = this.weapon;
    if (wp.def.cls === 'melee' || wp.reloading > 0 || wp.ammo >= wp.stats.mag || (this.reserve[wp.def.ammo] ?? 0) <= 0) return false;
    wp.reloading = wp.stats.reload * (this.perks.has('speedcola') ? 0.5 : 1);
    this.model.setUpper('reload', 0.1, wp.reloading);
    this.w.audio.play(wp.def.cls === 'pistol' ? 'reload_pistol' : 'mag_out', { pos: this.pos, volume: 0.5, maxDist: 20 });
    return true;
  }

  updateWeapon(dt: number) {
    const wp = this.weapon;
    wp.update(dt, Math.hypot(this.vel.x, this.vel.z) > 0.5, this.ads > 0.5);
    if (wp.reloading > 0) {
      wp.reloading -= dt;
      if (wp.reloading <= 0) {
        const need = wp.stats.mag - wp.ammo;
        const have = this.reserve[wp.def.ammo] ?? 0;
        const take = this.w.mode?.infiniteAmmo ? need : Math.min(need, have);
        wp.ammo += take;
        if (!this.w.mode?.infiniteAmmo) this.reserve[wp.def.ammo] = have - take;
        this.w.audio.play('mag_in', { pos: this.pos, volume: 0.5, maxDist: 20 });
      }
    }
    if (this.busyT > 0) {
      this.busyT -= dt;
      if (this.busyT <= 0) this.finishBusy();
    }
    if (!this.downed && this.alive && this.w.time - this.lastDamageTime > (this.perks.has('quickrevive') ? 3 : 6) && this.health < this.maxHealth && this.w.mode?.healthRegen !== false) {
      this.health = Math.min(this.maxHealth, this.health + dt * 25);
    }
    if (this.downed && this.w.time - this.downedTime > this.bleedOut) this.die({ attacker: this.lastAttacker });
    if (this.downed) this.health = Math.max(1, 100 - (this.w.time - this.downedTime) / this.bleedOut * 100);
  }

  beginBusy(kind: Soldier['busyKind'], time: number) {
    if (this.busyT > 0 || this.downed || this.inVehicle) return false;
    this.busyKind = kind; this.busyT = time;
    if (kind === 'heal' || kind === 'syringe') this.model.setUpper('consume', 0.1, time);
    if (kind === 'plate') this.model.setUpper('pickup', 0.1, time);
    if (kind === 'throw') this.model.setUpper('throw', 0.05, time);
    return true;
  }

  private finishBusy() {
    const k = this.busyKind; this.busyKind = '';
    if (k === 'heal' && this.medkits > 0) { this.medkits--; this.health = this.maxHealth; }
    if (k === 'syringe' && this.syringes > 0) { this.syringes--; this.health = Math.min(this.maxHealth, this.health + 50); this.sprintBoost = 6; }
    if (k === 'plate' && this.plates > 0) {
      this.plates--;
      this.armor = Math.min(this.armorTier * 50, this.armor + 50);
      this.w.audio.play('mag_in', { pos: this.pos, volume: 0.6, rate: 0.7 });
      this.w.bus.emit('plated', this);
    }
  }
  sprintBoost = 0;
  slideSpeed = 0;
  /** 0 = neutral, 1 = full dive (for animation / camera) */
  diveK = 0;
  glideSpeed = 0;

  tryHeal() { if (this.medkits > 0 && this.health < this.maxHealth) return this.beginBusy('heal', 3.5); if (this.syringes > 0 && this.health < this.maxHealth) return this.beginBusy('syringe', 1.2); return false; }
  tryPlate() { if (this.plates > 0 && this.armorTier > 0 && this.armor < this.armorTier * 50) return this.beginBusy('plate', 1.1 * (this.perks.has('speedcola') ? 0.5 : 1)); return false; }

  dispose() {
    this.model.dispose();
    if (this.collider) { this.w.unregisterCharacterCollider(this.collider); this.w.physics.removeCollider(this.collider); }
    this.collider = null; this.body = null;
    if (this.ctrl) { this.w.physics.world.removeCharacterController(this.ctrl); this.ctrl = null; }
  }
}

export function stepSurface(s: string) {
  switch (s) {
    case 'asphalt': case 'concrete': return 'stone';
    case 'sand': return 'sand';
    case 'snow': return 'snow';
    case 'stone': return 'gravel';
    case 'wood': return 'wood';
    case 'metal': case 'vehicle': return 'metal';
    case 'water': return 'water';
    case 'dirt': return 'dirt';
    default: return 'grass';
  }
}
