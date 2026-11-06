import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { VEHICLES, type VehicleDef } from './VehicleDefs';
import type { GameWorld } from '../gameplay/GameWorld';
import type { Soldier } from '../entities/Soldier';
import type { Actor } from '../gameplay/types';
import { GROUP, groups } from '../physics/Physics';
import { WEAPONS } from '../weapons/WeaponDefs';
import type { WeaponStats } from '../weapons/Weapon';

export interface VehicleControls {
  throttle: number; // -1..1 (W/S, RT/LT)
  steer: number; // -1..1
  up: number; // -1..1 ascend/descend
  pitch: number; // aircraft pitch input
  roll: number;
  aimYaw: number; // camera yaw (heli heading / turret)
  aimPitch: number;
  fire: boolean;
  handbrake: boolean;
  boost: boolean;
}

const OPEN = new Set(['motorcycle', 'bicycle', 'jetski', 'golfcart', 'tractor', 'jeep', 'boat', 'speedboat']);
const tq = new THREE.Quaternion(), te = new THREE.Euler(), tv = new THREE.Vector3(), tv2 = new THREE.Vector3();

let NEXT = 1;
export class Vehicle {
  id = NEXT++;
  def: VehicleDef;
  w: GameWorld;
  model!: THREE.Object3D;
  body!: RAPIER.RigidBody;
  collider!: RAPIER.Collider;
  vc: RAPIER.DynamicRayCastVehicleController | null = null;
  occupants: (Soldier | null)[];
  health: number;
  destroyed = false;
  size = new THREE.Vector3();
  exposedSeats: boolean;
  speed = 0;
  altitude = 0;
  engineOn = false;
  private engine: ReturnType<GameWorld['audio']['loop']> = null;
  private mixer: THREE.AnimationMixer | null = null;
  private rotors: THREE.Object3D[] = [];
  private fireCd = 0;
  private flipT = 0;
  private wreckT = 0;
  private yawRate = 0;
  heading = 0;
  airSpeed = 0;
  private bank = 0;
  private pitchA = 0;
  lastDriver: Soldier | null = null;
  spawnPos = new THREE.Vector3();
  boostFuel = 1;
  private wheels: { node: THREE.Object3D; front: boolean; r: number }[] = [];
  private wheelSpin = 0;
  private fxT = 0;
  private steerVis = 0;

  constructor(w: GameWorld, id: string) {
    this.w = w;
    this.def = VEHICLES[id];
    this.occupants = new Array(this.def.seats).fill(null);
    this.health = this.def.health;
    this.exposedSeats = OPEN.has(this.def.id);
  }

  get driver() { return this.occupants[0]; }
  get kind() { return this.def.kind; }
  get isAir() { return this.def.domain === 'air'; }
  get isWater() { return this.def.domain === 'water'; }

  async init(pos: THREE.Vector3, yaw: number) {
    this.model = await this.w.assets.instance(this.def.model);
    this.size.copy(this.model.userData.size ?? new THREE.Vector3(2, 1.5, 4.5));
    this.w.scene.add(this.model);
    const anims: THREE.AnimationClip[] = this.model.userData.animations ?? [];
    if (anims.length && this.isAir) {
      this.mixer = new THREE.AnimationMixer(this.model);
      for (const c of anims) this.mixer.clipAction(c).play();
    }
    this.model.traverse((o) => { if (/rotor|propel|blade|helice/i.test(o.name)) this.rotors.push(o); });
    // visible wheel nodes (when the model has them as separate parts)
    if (this.def.domain === 'land') {
      this.model.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(this.model.matrixWorld).invert();
      this.model.traverse((o) => {
        if (!/wheel|tire|tyre|rim|reifen|rad_/i.test(o.name) || /steer|lenk/i.test(o.name)) return;
        const b = new THREE.Box3().setFromObject(o);
        if (b.isEmpty()) return;
        const c = b.getCenter(new THREE.Vector3()).applyMatrix4(inv);
        const sz = b.getSize(new THREE.Vector3());
        if (Math.max(sz.x, sz.y, sz.z) > this.size.y * 0.9) return; // not a single wheel
        this.wheels.push({ node: o, front: c.z > 0, r: Math.max(sz.y * 0.5, 0.2) });
      });
      if (this.wheels.length > 12) this.wheels = [];
    }
    this.spawnPos.copy(pos);
    this.heading = yaw;
    this.createBody(pos, yaw);
    this.w.registerVehicle(this);
    return this;
  }

  private createBody(pos: THREE.Vector3, yaw: number) {
    const s = this.size;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const land = this.def.domain === 'land';
    const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y + 0.3, pos.z).setRotation(q)
      .setLinearDamping(land ? 0.05 : 0.6).setAngularDamping(land ? 0.8 : 2.5).setCanSleep(true);
    this.body = this.w.physics.world.createRigidBody(desc);
    const air = this.def.domain === 'air';
    // aircraft: fuselage-sized box (wings / rotor discs excluded) lifted off the ground, frictionless
    const hx = air ? Math.min(s.x * 0.45, s.z * 0.16) : s.x * 0.45, hz = s.z * (air ? 0.45 : 0.47);
    const hy = land ? s.y * 0.3 : air ? s.y * 0.28 : s.y * 0.42;
    const cy = land ? Math.max(s.y * 0.55, hy + 0.25) : air ? s.y * 0.62 : s.y * 0.45;
    const cd = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(0, cy, 0).setFriction(land ? 0.3 : air ? 0 : 0.6).setRestitution(0.1)
      .setCollisionGroups(groups(GROUP.VEHICLE, GROUP.WORLD | GROUP.VEHICLE | GROUP.CHAR))
      .setMassProperties(this.def.mass, { x: 0, y: land ? s.y * 0.1 : s.y * 0.2, z: 0 },
        { x: this.def.mass * (s.y * s.y + s.z * s.z) / 12, y: this.def.mass * (s.x * s.x + s.z * s.z) / 12, z: this.def.mass * (s.x * s.x + s.y * s.y) / 12 }, { w: 1, x: 0, y: 0, z: 0 });
    this.collider = this.w.physics.world.createCollider(cd, this.body);
    if (land && this.def.kind !== 'hover') this.createWheels();
    if (this.isAir) this.body.setGravityScale(1, true);
  }

  private createWheels() {
    const s = this.size;
    const vc = this.w.physics.world.createVehicleController(this.body);
    vc.indexUpAxis = 1;
    vc.setIndexForwardAxis = 2;
    const two = this.def.kind === 'moto' || this.def.kind === 'bicycle';
    const r = THREE.MathUtils.clamp(s.y * (this.def.kind === 'truck' ? 0.16 : 0.2), 0.28, 0.65);
    const wx = two ? 0.18 : s.x * 0.4;
    const wz = s.z * (two ? 0.36 : 0.33);
    const y = r + 0.15;
    const rest = this.def.kind === 'tank' ? 0.2 : 0.3;
    for (const [x, z] of [[-wx, wz], [wx, wz], [-wx, -wz], [wx, -wz]]) {
      vc.addWheel({ x, y, z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, rest, r);
    }
    const k = this.def.kind;
    const stiff = k === 'tank' ? 45 : k === 'truck' ? 34 : k === 'moto' || k === 'bicycle' ? 30 : 26;
    const crit = 2 * Math.sqrt(stiff);
    for (let i = 0; i < 4; i++) {
      vc.setWheelSuspensionStiffness(i, stiff);
      vc.setWheelSuspensionCompression(i, crit * 0.32);
      vc.setWheelSuspensionRelaxation(i, crit * 0.48);
      vc.setWheelMaxSuspensionTravel(i, k === 'truck' ? 0.45 : 0.35);
      vc.setWheelFrictionSlip(i, k === 'tank' ? 4.5 : k === 'truck' ? 2.4 : 2.6);
      vc.setWheelSideFrictionStiffness(i, k === 'tank' ? 1.6 : 1.1);
      vc.setWheelMaxSuspensionForce(i, this.def.mass * 32);
    }
    this.vc = vc;
  }

  // ------------------------------------------------------------------ seats
  seatLocal(seat: number, out: THREE.Vector3) {
    const s = this.size;
    if (this.exposedSeats && (this.def.kind === 'moto' || this.def.kind === 'bicycle' || this.def.kind === 'jetski')) return out.set(0, s.y * 0.35, -seat * 0.55);
    const row = Math.floor(seat / 2), side = seat % 2 === 0 ? -1 : 1;
    return out.set(side * s.x * 0.22, s.y * 0.22, s.z * (0.05 - row * 0.22));
  }

  seatTransform(sol: Soldier, out: THREE.Vector3) {
    this.seatLocal(sol.seat, tv);
    tv.applyQuaternion(this.model.quaternion).add(this.model.position);
    out.copy(tv);
    sol.model.root.quaternion.copy(this.model.quaternion);
    sol.model.setVisible(this.exposedSeats);
    sol.vel.copy(this.body.linvel() as any);
  }

  enter(sol: Soldier, seat = -1): boolean {
    if (this.destroyed) return false;
    if (seat < 0) seat = this.occupants.findIndex((o) => o === null);
    if (seat < 0 || this.occupants[seat]) return false;
    this.occupants[seat] = sol;
    sol.inVehicle = this; sol.seat = seat;
    sol.collider?.setEnabled(false);
    sol.freefall = false; sol.parachute = false;
    this.w.audio.play('car_door', { pos: this.model.position, volume: 0.6 });
    if (seat === 0) {
      this.lastDriver = sol;
      this.body.wakeUp();
      if (!this.engineOn) { this.engineOn = true; this.w.audio.play('engine_start', { pos: this.model.position, volume: 0.7 }); }
    }
    this.w.bus.emit('vehicleEnter', { vehicle: this, soldier: sol });
    return true;
  }

  exit(sol: Soldier, eject = false) {
    const i = this.occupants.indexOf(sol);
    if (i < 0) return;
    this.occupants[i] = null;
    sol.inVehicle = null;
    sol.model.root.quaternion.identity();
    sol.model.setVisible(!sol.isPlayer || this.w.player?.thirdPerson !== false);
    // find exit position on the left/right
    const side = new THREE.Vector3((i % 2 === 0 ? -1 : 1) * (this.size.x * 0.5 + 1.2), 0, 0).applyQuaternion(this.model.quaternion);
    const p = this.model.position.clone().add(side);
    const gh = this.w.terrain.getHeight(p.x, p.z);
    p.y = Math.max(p.y, gh) + 0.4;
    if (this.isAir && this.altitude > 8) { sol.freefall = true; sol.parachute = false; p.copy(this.model.position).add(new THREE.Vector3(0, -3, 0)); }
    sol.pos.copy(p);
    sol.vel.copy(this.body.linvel() as any).multiplyScalar(eject ? 0.2 : 0.6);
    sol.collider?.setEnabled(sol.alive);
    sol.body?.setTranslation(sol.capsuleCenter(), true);
    if (i === 0 && !this.occupants.some((o) => o)) { this.engineOn = this.isAir && this.altitude > 5; }
    this.w.bus.emit('vehicleExit', { vehicle: this, soldier: sol });
  }

  // ------------------------------------------------------------------ simulation
  prePhysics(dt: number, c: VehicleControls | null) {
    if (this.destroyed) return;
    const lv = this.body.linvel();
    this.speed = Math.hypot(lv.x, lv.y, lv.z);
    const pos = this.body.translation();
    this.altitude = pos.y - Math.max(this.w.terrain.getHeight(pos.x, pos.z), this.w.waterLevel);
    this.fireCd -= dt;
    if (c && c.fire) this.fireWeapon(c);
    switch (this.def.domain) {
      case 'land': this.def.kind === 'hover' ? this.hover(dt, c) : this.drive(dt, c); break;
      case 'water': this.sail(dt, c); break;
      case 'air': this.def.kind === 'heli' ? this.heli(dt, c) : this.fly(dt, c); break;
    }
  }

  private steerS = 0;
  private drive(dt: number, c: VehicleControls | null) {
    const vc = this.vc!;
    const fwdSpeed = vc.currentVehicleSpeed();
    const m = this.def.mass, k = this.def.kind;
    let engine = 0, brake = 0, steerIn = 0;
    if (c) {
      const t = c.throttle;
      const boost = c.boost && this.boostFuel > 0;
      // torque falls off towards top speed instead of a hard cut (feels like a real gearbox / drag limit)
      const vk = THREE.MathUtils.clamp(Math.abs(fwdSpeed) / (this.def.maxSpeed * (boost ? 1.2 : 1)), 0, 1);
      const maxF = m * this.def.accel * (boost ? 1.6 : 1) * (1.15 - vk * vk * 0.95);
      if (boost) this.boostFuel = Math.max(0, this.boostFuel - dt * 0.25);
      if (t > 0.05) { engine = vk < 1 ? t * maxF : 0; if (fwdSpeed < -1) { brake = m * 0.035; engine = 0; } }
      else if (t < -0.05) { if (fwdSpeed > 1) brake = m * 0.035 * -t; else engine = fwdSpeed > -this.def.maxSpeed * 0.35 ? t * maxF * 0.6 : 0; }
      if (c.handbrake) brake = Math.max(brake, m * 0.02);
      const maxSteer = k === 'tank' ? 0.75 : k === 'truck' ? 0.45 : 0.58;
      steerIn = -c.steer * maxSteer * (1 - Math.min(Math.abs(fwdSpeed) / this.def.maxSpeed, 1) * 0.62);
    } else brake = m * 0.012;
    // steering rack has inertia; returns to centre faster than it turns in
    this.steerS += (steerIn - this.steerS) * Math.min(1, dt * (Math.abs(steerIn) > Math.abs(this.steerS) ? 7 : 10));
    const steer = this.steerS;
    const hb = !!c?.handbrake;
    for (let i = 0; i < 4; i++) {
      const rear = i >= 2;
      // rear-biased drive; handbrake locks the rear wheels and lets the tail slide for drifts
      vc.setWheelEngineForce(i, engine * (k === 'tank' || k === 'truck' ? 0.25 : rear ? 0.32 : 0.18));
      vc.setWheelBrake(i, rear && hb ? m * 0.03 : brake / 4);
      vc.setWheelSideFrictionStiffness(i, rear && hb ? 0.45 : k === 'tank' ? 1.6 : 1.1);
      vc.setWheelSteering(i, i < 2 ? steer : k === 'tank' ? -steer : 0);
    }
    // aerodynamics: quadratic drag + downforce keeps fast cars planted
    this.body.resetForces(true);
    const lv = this.body.linvel();
    const v2 = lv.x * lv.x + lv.z * lv.z;
    const v = Math.sqrt(v2);
    if (v > 0.5) {
      const drag = m * 0.0009 * v;
      this.body.addForce({ x: -lv.x * drag, y: -m * 0.0035 * v2 * (k === 'moto' || k === 'bicycle' ? 0.4 : 1), z: -lv.z * drag }, true);
    }
    // airborne: gentle self-levelling so jumps land on the wheels instead of the roof
    let contact = 0;
    for (let i = 0; i < 4; i++) if (vc.wheelIsInContact(i)) contact++;
    if (contact === 0) {
      const av = this.body.angvel();
      this.body.setAngvel({ x: av.x * (1 - Math.min(1, dt * 1.5)), y: av.y, z: av.z * (1 - Math.min(1, dt * 1.5)) }, true);
    }
    vc.updateVehicle(dt, undefined, groups(0xffff, GROUP.WORLD | GROUP.VEHICLE), (col) => col.handle !== this.collider.handle && !this.w.isCharacterCollider(col));
    // anti-flip / self-right
    const up = tv.set(0, 1, 0).applyQuaternion(this.body.rotation() as any);
    if (up.y < 0.3 && this.speed < 3) { this.flipT += dt; if (this.flipT > 2.5) this.selfRight(); } else this.flipT = 0;
    // two-wheelers stay upright, lean visually
    if (this.def.kind === 'moto' || this.def.kind === 'bicycle') {
      const r = this.body.rotation();
      te.setFromQuaternion(tq.set(r.x, r.y, r.z, r.w), 'YXZ');
      te.z = THREE.MathUtils.lerp(te.z, (c?.steer ?? 0) * Math.min(this.speed / 20, 1) * 0.35, 0.2);
      te.x *= 0.9;
      tq.setFromEuler(te);
      this.body.setRotation(tq, true);
      const av = this.body.angvel(); this.body.setAngvel({ x: av.x * 0.5, y: av.y, z: 0 }, true);
    }
    this.engineSound(Math.abs(fwdSpeed) / this.def.maxSpeed, c ? Math.abs(c.throttle) : 0);
  }

  private selfRight() {
    const t = this.body.translation();
    const yaw = this.heading = new THREE.Euler().setFromQuaternion(this.model.quaternion, 'YXZ').y;
    this.body.setTranslation({ x: t.x, y: t.y + 1.5, z: t.z }, true);
    this.body.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true); this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.flipT = 0;
  }

  private hover(dt: number, c: VehicleControls | null) {
    const p = this.body.translation();
    const r = this.body.rotation(); tq.set(r.x, r.y, r.z, r.w);
    const ground = Math.max(this.w.terrain.getHeight(p.x, p.z), this.w.waterLevel);
    const targetH = ground + 1.3;
    const lv = this.body.linvel();
    const m = this.def.mass;
    const fy = ((targetH - p.y) * 60 - lv.y * 12) * m * 0.1 + m * 9.81;
    this.body.resetForces(true);
    this.body.addForce({ x: 0, y: fy, z: 0 }, true);
    if (c) {
      this.heading += -c.steer * dt * 1.8;
      const f = tv.set(Math.sin(this.heading), 0, Math.cos(this.heading));
      const target = f.multiplyScalar(c.throttle * this.def.maxSpeed);
      this.body.setLinvel({ x: THREE.MathUtils.lerp(lv.x, target.x, dt * 1.5), y: lv.y, z: THREE.MathUtils.lerp(lv.z, target.z, dt * 1.5) }, true);
    }
    tq.setFromEuler(te.set(0, this.heading, (c?.steer ?? 0) * -0.15, 'YXZ'));
    this.body.setRotation(tq, true); this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.engineSound(this.speed / this.def.maxSpeed, c ? Math.abs(c.throttle) : 0, 1.4);
  }

  private sail(dt: number, c: VehicleControls | null) {
    const m = this.def.mass;
    const p = this.body.translation();
    const r = this.body.rotation(); tq.set(r.x, r.y, r.z, r.w);
    const s = this.size;
    const t = this.w.time;
    this.body.resetForces(true); this.body.resetTorques(true);
    let submerged = 0;
    const isSub = this.def.kind === 'sub';
    const pts = [[-s.x * 0.4, -s.z * 0.4], [s.x * 0.4, -s.z * 0.4], [-s.x * 0.4, s.z * 0.4], [s.x * 0.4, s.z * 0.4]];
    const lv = this.body.linvel();
    for (const [lx, lz] of pts) {
      const wp = tv.set(lx, 0.15, lz).applyQuaternion(tq).add(p as any);
      const wh = isSub ? this.w.waterLevel - 6 + (c ? 0 : 5.5) + this.subDepth : this.w.water.heightAt(wp.x, wp.z, t);
      const depth = wh - wp.y;
      if (depth > 0 && (isSub || this.w.terrain.getHeight(wp.x, wp.z) < this.w.waterLevel + 0.4)) {
        submerged++;
        const f = Math.min(depth, 1.2) * m * 9.81 * 0.55 - lv.y * m * 0.4;
        this.body.addForceAtPoint({ x: 0, y: f, z: 0 }, wp, true);
      }
    }
    const inWater = submerged > 0;
    const fwd = tv2.set(0, 0, 1).applyQuaternion(tq);
    if (c && inWater) {
      const fs = fwd.dot(lv as any);
      if (fs < this.def.maxSpeed) this.body.addForce({ x: fwd.x * c.throttle * m * this.def.accel, y: 0, z: fwd.z * c.throttle * m * this.def.accel }, true);
      this.body.addTorque({ x: 0, y: -c.steer * m * (this.def.kind === 'jetski' ? 3.5 : 2.2) * Math.min(1, Math.abs(fs) / 4 + 0.3), z: 0 }, true);
      if (isSub) this.subDepth = THREE.MathUtils.clamp(this.subDepth + c.up * dt * 3, -16, 5);
    }
    if (inWater) {
      // lateral drag (keel)
      const right = tv.set(1, 0, 0).applyQuaternion(tq);
      const lat = right.dot(lv as any);
      this.body.addForce({ x: -right.x * lat * m * 1.5, y: 0, z: -right.z * lat * m * 1.5 }, true);
      // keep upright
      const up = tv.set(0, 1, 0).applyQuaternion(tq);
      const corr = new THREE.Vector3(0, 1, 0).cross(up).multiplyScalar(-m * 8);
      this.body.addTorque(corr, true);
    }
    if (isSub && inWater) this.body.setGravityScale(0.05, true); else this.body.setGravityScale(1, true);
    this.body.setLinearDamping(inWater ? 0.4 : 3);
    this.engineSound(this.speed / this.def.maxSpeed, c ? Math.abs(c.throttle) : 0, this.def.kind === 'jetski' ? 1.5 : 0.9);
  }
  subDepth = 0;

  private heli(dt: number, c: VehicleControls | null) {
    const lv = this.body.linvel();
    const active = !!c || (this.engineOn && this.altitude > 2);
    for (const r of this.rotors) r.rotation.y += dt * (active ? 40 : 2);
    if (!active) { this.body.setGravityScale(1, true); this.engineSound(0, 0); return; }
    this.body.setGravityScale(0, true);
    const ctl = c ?? { throttle: 0, steer: 0, up: -0.4, pitch: 0, roll: 0, aimYaw: this.heading, aimPitch: 0, fire: false, handbrake: false, boost: false };
    // heading follows the camera (controller friendly)
    let dy = ctl.aimYaw - this.heading;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.heading += THREE.MathUtils.clamp(dy, -1.6 * dt, 1.6 * dt);
    const f = tv.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    const rgt = tv2.set(-f.z, 0, f.x).negate();
    const ms = this.def.maxSpeed;
    const target = new THREE.Vector3().addScaledVector(f, ctl.throttle * ms).addScaledVector(rgt, -ctl.steer * ms * 0.45);
    target.y = ctl.up * 14 - (this.altitude > 400 ? 6 : 0);
    const k = Math.min(1, dt * 1.2);
    this.body.setLinvel({ x: lv.x + (target.x - lv.x) * k, y: lv.y + (target.y - lv.y) * Math.min(1, dt * 2.5), z: lv.z + (target.z - lv.z) * k }, true);
    // visual tilt from acceleration
    this.pitchA = THREE.MathUtils.lerp(this.pitchA, ctl.throttle * 0.25, dt * 2);
    this.bank = THREE.MathUtils.lerp(this.bank, ctl.steer * 0.3, dt * 2);
    tq.setFromEuler(te.set(this.pitchA, this.heading, -this.bank, 'YXZ'));
    this.body.setRotation(tq, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.engineSound(0.5 + this.speed / ms * 0.5, 1, 0.6);
  }

  private fly(dt: number, c: VehicleControls | null) {
    const p = this.body.translation();
    const ground = this.w.terrain.getHeight(p.x, p.z);
    const onGround = p.y - ground < 1.5;
    for (const r of this.rotors) r.rotation.z += dt * this.airSpeed * 2;
    const ms = this.def.maxSpeed;
    const stall = this.def.kind === 'jet' ? 55 : 28;
    if (!c && !this.engineOn) { this.body.setGravityScale(1, true); this.airSpeed *= 0.99; this.engineSound(0, 0); return; }
    const ctl = c ?? { throttle: 0, steer: 0, up: 0, pitch: 0, roll: 0, aimYaw: 0, aimPitch: 0, fire: false, handbrake: false, boost: false };
    this.airSpeed = THREE.MathUtils.clamp(this.airSpeed + ctl.throttle * this.def.accel * dt - (ctl.throttle < 0 ? 0 : 0.5 * dt), 0, ms);
    this.body.setGravityScale(0, true);
    if (onGround && this.airSpeed < stall) {
      // taxi
      this.heading += -ctl.steer * dt * 0.9 * Math.min(1, this.airSpeed / 8 + 0.2);
      this.pitchA = THREE.MathUtils.lerp(this.pitchA, 0, dt * 3);
      this.bank = THREE.MathUtils.lerp(this.bank, 0, dt * 3);
      const f = tv.set(Math.sin(this.heading), 0, Math.cos(this.heading)).multiplyScalar(this.airSpeed);
      this.body.setLinvel({ x: f.x, y: (ground + 0.2 - p.y) * 5, z: f.z }, true);
    } else {
      // arcade flight model: pitch & roll rates, banked turns, stall sag
      this.pitchA = THREE.MathUtils.clamp(this.pitchA + ctl.pitch * dt * 1.4, -1.2, 1.2);
      this.bank = THREE.MathUtils.clamp(this.bank + ctl.roll * dt * 2.2, -1.3, 1.3);
      if (Math.abs(ctl.roll) < 0.05) this.bank *= 1 - dt * 1.2;
      this.heading += (-Math.sin(this.bank) * 0.9 - ctl.steer * 0.35) * dt * (this.airSpeed / ms + 0.3);
      const dir = tv.set(0, 0, 1).applyEuler(te.set(-this.pitchA, this.heading, 0, 'YXZ'));
      const sag = this.airSpeed < stall ? (stall - this.airSpeed) * 0.6 : 0;
      this.body.setLinvel({ x: dir.x * this.airSpeed, y: dir.y * this.airSpeed - sag, z: dir.z * this.airSpeed }, true);
      if (this.airSpeed < stall * 0.7) this.pitchA = THREE.MathUtils.lerp(this.pitchA, -0.4, dt);
    }
    tq.setFromEuler(te.set(-this.pitchA, this.heading, -this.bank, 'YXZ'));
    this.body.setRotation(tq, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.engineSound(0.3 + this.airSpeed / ms, 1, this.def.kind === 'jet' ? 1.8 : 0.8);
  }

  postPhysics(dt: number) {
    const t = this.body.translation(), r = this.body.rotation();
    // crash detection for aircraft: big sudden velocity loss
    if (this.isAir && !this.destroyed) {
      const lv = this.body.linvel();
      const sp = Math.hypot(lv.x, lv.y, lv.z);
      if (this.lastSpeed > 25 && sp < this.lastSpeed * 0.4) this.damage(this.def.health * (this.lastSpeed > 45 ? 1.2 : 0.4), null);
      this.lastSpeed = sp;
    } else if (!this.destroyed) {
      const lv = this.body.linvel();
      const sp = Math.hypot(lv.x, lv.y, lv.z);
      if (this.lastSpeed - sp > 14) { this.damage((this.lastSpeed - sp) * 25, null); this.w.audio.play('crash', { pos: this.model.position, volume: 0.9 }); this.w.input.rumble(1, 1, 300); }
      this.lastSpeed = sp;
    }
    this.model.position.set(t.x, t.y, t.z);
    this.model.quaternion.set(r.x, r.y, r.z, r.w);
    const camD = this.model.position.distanceTo(this.w.engine.camera.position);
    this.model.visible = camD < (this.w.lowSpec ? 260 : 520) + this.size.z * 4;
    if (camD < 140 && !this.destroyed) this.vfx(dt);
    if (this.mixer) this.mixer.update(this.engineOn || this.driver ? dt * (this.isAir ? 1.5 : 1) : 0);
    if (this.destroyed) {
      this.wreckT += dt;
      if (this.wreckT < 6 && Math.random() < 0.3) this.w.effects.smoke(this.model.position.clone().add(new THREE.Vector3(0, this.size.y, 0)), 0x222222, 1);
      if (this.wreckT > 60) this.w.removeVehicle(this);
    }
    if (this.def.domain === 'land' && t.y < this.w.waterLevel - 1.5 && !this.destroyed) this.damage(dt * 200, null); // drowned engine
  }
  private lastSpeed = 0;

  /** exhaust, dust trails, water wake & spray, rotor down-wash, afterburner, spinning wheels */
  private vfx(dt: number) {
    const fx = this.w.effects;
    const q = this.model.quaternion, p = this.model.position, s = this.size;
    const lv = this.body.linvel();
    const fwdSpeed = new THREE.Vector3(0, 0, 1).applyQuaternion(q).dot(lv as any);
    if (this.wheels.length) {
      this.wheelSpin += (fwdSpeed / 0.35) * dt;
      const steer = this.driver ? -(this.w.vehicleControls.get(this)?.steer ?? 0) * 0.45 : 0;
      this.steerVis = THREE.MathUtils.lerp(this.steerVis, steer, Math.min(1, dt * 8));
      for (const wh of this.wheels) { wh.node.rotation.x = this.wheelSpin; if (wh.front) wh.node.rotation.y = this.steerVis; }
    }
    this.fxT -= dt;
    if (this.fxT > 0) return;
    this.fxT = 0.06;
    const at = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyQuaternion(q).add(p);
    const sp = Math.abs(fwdSpeed);
    if (this.engineOn || this.driver) {
      if (this.def.domain === 'land' && this.def.kind !== 'bicycle') fx.emit(at(s.x * 0.25, s.y * 0.15, -s.z * 0.5), new THREE.Vector3(0, 0.6, 0), new THREE.Color(0x777777), 0.18, 0.25, 1.4, -0.3, 2.5);
      if (this.def.kind === 'jet') { for (let i = 0; i < 2; i++) fx.emit(at(0, s.y * 0.45, -s.z * 0.52), new THREE.Vector3(0, 0, -6).applyQuaternion(q), new THREE.Color(1, 0.55, 0.2), 0.9, 0.55, 0.08, 0, 0.5, true); }
    }
    if (this.def.domain === 'land' && sp > 7) {
      const surf = this.w.terrain.surfaceAt(p.x, p.z);
      if (surf !== 'asphalt' && surf !== 'water') for (const sx of [-1, 1]) fx.emit(at(sx * s.x * 0.4, 0.2, -s.z * 0.4), new THREE.Vector3((Math.random() - 0.5) * 2, 1 + Math.random(), (Math.random() - 0.5) * 2), new THREE.Color(surf === 'sand' ? 0xd8c690 : 0x9a8a6a), 0.35, 0.7 + sp * 0.03, 1.8, -0.2, 2.2);
    }
    if (this.def.domain === 'water' && sp > 2.5 && p.y < this.w.waterLevel + 1.5) {
      for (const sx of [-1, 1]) fx.emit(at(sx * s.x * 0.45, 0.1, s.z * 0.2), new THREE.Vector3(sx * 2.5, 2 + sp * 0.12, 0).applyQuaternion(q), new THREE.Color(0xeaf6ff), 0.55, 0.35, 0.8, 9.8, 1.2);
      fx.emit(at(0, 0.05, -s.z * 0.55), new THREE.Vector3(0, 0.4, 0), new THREE.Color(0xffffff), 0.45, 0.9, 2.5, 0, 1.5);
    }
    if (this.def.kind === 'heli' && this.engineOn && this.altitude < 14) {
      const g = Math.max(this.w.terrain.getHeight(p.x, p.z), this.w.waterLevel);
      for (let i = 0; i < 3; i++) { const a = Math.random() * 6.28; fx.emit(new THREE.Vector3(p.x + Math.cos(a) * 3, g + 0.3, p.z + Math.sin(a) * 3), new THREE.Vector3(Math.cos(a) * 9, 0.6, Math.sin(a) * 9), new THREE.Color(g <= this.w.waterLevel + 0.1 ? 0xeaf4ff : 0xa89878), 0.4, 1.2, 1.2, 0, 2); }
    }
  }

  private engineSound(rpm: number, load: number, pitchMul = 1) {
    if (!this.driver && !this.engineOn) { if (this.engine) { this.engine.stop(); this.engine = null; } return; }
    const dist = this.model.position.distanceTo(this.w.audio.listener);
    if (dist > 120) { if (this.engine) { this.engine.stop(); this.engine = null; } return; }
    if (!this.engine) this.engine = this.w.audio.loop(rpm > 0.55 ? 'engine_high' : 'engine_mid', 0);
    this.engine?.set(0.25 + load * 0.35, (0.6 + Math.min(rpm, 1.4) * 0.9) * pitchMul, this.model.position);
  }

  fireWeapon(c: VehicleControls) {
    const kind = this.def.weapon;
    if (!kind || kind === 'none' || this.fireCd > 0) return;
    const origin = this.model.position.clone().add(new THREE.Vector3(0, this.size.y * 0.8, 0).add(new THREE.Vector3(0, 0, this.size.z * 0.5).applyQuaternion(this.model.quaternion)));
    const dir = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(-c.aimPitch, c.aimYaw, 0, 'YXZ'));
    const shooter = this.driver as unknown as Actor;
    if (kind === 'mg') {
      this.fireCd = 0.09;
      const st = { ...WEAPONS.warden, damage: 34, silenced: false, thermal: false } as WeaponStats;
      dir.x += (Math.random() - 0.5) * 0.02; dir.y += (Math.random() - 0.5) * 0.02;
      this.w.ballistics.fire(shooter, origin, dir.normalize(), st);
      this.w.effects.muzzle(origin, dir);
      this.w.audio.play('mg_shot', { pos: origin, volume: 0.6 });
    } else {
      this.fireCd = kind === 'cannon' ? 2.2 : 0.6;
      const st = { ...WEAPONS.thumper, velocity: kind === 'cannon' ? 220 : 160, gravity: kind === 'cannon' ? 0.4 : 0.05, explosive: { radius: kind === 'cannon' ? 8 : 6, damage: kind === 'cannon' ? 220 : 130 }, silenced: false, thermal: false } as WeaponStats;
      this.w.ballistics.fire(shooter, origin, dir, st);
      this.w.effects.muzzle(origin, dir, true);
      this.w.audio.play(kind === 'cannon' ? 'explosion_small' : 'rocket_whoosh', { pos: origin, volume: 0.9 });
      this.w.input.rumble(0.8, 0.4, 150);
    }
  }

  damage(amount: number, attacker: Actor | null) {
    if (this.destroyed) return;
    this.health -= amount * (this.def.armored ? 0.5 : 1);
    if (this.health <= 0) this.explode(attacker);
  }

  explode(attacker: Actor | null) {
    if (this.destroyed) return;
    this.destroyed = true;
    const p = this.model.position.clone().add(new THREE.Vector3(0, this.size.y * 0.5, 0));
    for (const o of [...this.occupants]) if (o) { this.exit(o, true); o.damage(200, { attacker, explosive: true, vehicle: true }); }
    this.w.explode(p, 8, 120, attacker, 'vehicle');
    this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { const mat = (m.material as THREE.MeshStandardMaterial).clone(); if (mat.color) mat.color.multiplyScalar(0.18); m.material = mat; }
    });
    this.engine?.stop(); this.engine = null;
    this.body.setGravityScale(1, true);
    this.body.applyImpulse({ x: 0, y: this.def.mass * 4, z: 0 }, true);
    this.body.applyTorqueImpulse({ x: this.def.mass * (Math.random() - 0.5) * 2, y: 0, z: this.def.mass * (Math.random() - 0.5) * 2 }, true);
  }

  dispose() {
    this.engine?.stop();
    this.model.removeFromParent();
    if (this.vc) this.w.physics.world.removeVehicleController(this.vc);
    this.w.physics.world.removeRigidBody(this.body);
  }
}
