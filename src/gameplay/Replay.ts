import * as THREE from 'three';
import type { GameWorld } from './GameWorld';
import type { Actor } from './types';
import type { Vehicle } from '../vehicles/Vehicle';
import type { Weapon } from '../weapons/Weapon';
import { CharacterModel, type LocoState, type UpperState } from '../entities/CharacterModel';

/** one actor in one recorded frame */
interface AF {
  a: Actor; x: number; y: number; z: number; ex: number; ey: number; ez: number;
  yaw: number; pitch: number; loco: LocoState; upper: UpperState; alive: boolean; vis: boolean;
  weapon: Weapon | null; health: number; scale: number;
}
interface VF { v: Vehicle; x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number }
interface Frame { t: number; actors: AF[]; vehicles: VF[] }
type EvFn = 'tracer' | 'muzzle' | 'impact' | 'explosion' | 'blood' | 'sound' | 'hit';
interface Ev { t: number; fn: EvFn; args: unknown[] }

const SOUND_RE = /shot|suppressed|smg_|explosion|rocket|grenade|bone|splat|metal_crash|debris|bolt|pump|reload|mag_|knife|glass|wood_break|crate/;
const REC_RADIUS = 380;
const cloneArg = (a: unknown) => (a instanceof THREE.Vector3 || a instanceof THREE.Color ? a.clone() : a);

/**
 * Always-on recorder for the killcam: 20 Hz snapshots of every actor / vehicle near the player
 * (position, eye, aim, animation state, weapon, health) plus every visual / audio combat event
 * (tracers, muzzle flashes, impacts, explosions, blood, positional sounds, hits) in a ring buffer
 * of the last 9 seconds. Effects and positional sounds are captured by wrapping the effect /
 * audio entry points, so nothing in the game logic has to know about the replay.
 */
export class ReplayRecorder {
  frames: Frame[] = [];
  events: Ev[] = [];
  readonly keep = 9;
  private acc = 0;
  private tmp = new THREE.Vector3();
  /** the unwrapped functions: replayed events must not be recorded again */
  orig: Partial<Record<EvFn, (...a: any[]) => unknown>> = {};

  constructor(private w: GameWorld) {
    const fx = w.effects as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const fn of ['tracer', 'muzzle', 'impact', 'explosion', 'blood'] as const) {
      const o = fx[fn]?.bind(w.effects);
      if (!o) continue;
      this.orig[fn] = o;
      fx[fn] = (...args: unknown[]) => { this.events.push({ t: w.time, fn, args: args.map(cloneArg) }); return o(...args); };
    }
    const audio = w.audio as unknown as { play: (name: string, opts?: { pos?: THREE.Vector3 }) => unknown };
    const ap = audio.play.bind(w.audio);
    this.orig.sound = ap;
    audio.play = (name: string, opts: { pos?: THREE.Vector3 } = {}) => {
      if (opts.pos && SOUND_RE.test(name)) this.events.push({ t: w.time, fn: 'sound', args: [name, { ...opts, pos: opts.pos.clone() }] });
      return ap(name, opts);
    };
    w.bus.on('damage', (e: { target: Actor; amount: number; info?: { attacker?: Actor | null; zone?: string } }) => {
      this.events.push({ t: w.time, fn: 'hit', args: [e.target, e.amount, e.info?.attacker ?? null, e.info?.zone ?? 'body'] });
    });
  }

  /** the audio system outlives the match: unwrap it again */
  dispose() {
    if (this.orig.sound) (this.w.audio as unknown as { play: unknown }).play = this.orig.sound;
    this.frames = []; this.events = [];
  }

  record(dt: number) {
    this.acc += dt;
    if (this.acc < 0.05) return;
    this.acc = 0;
    const w = this.w;
    const c = w.player?.soldier.pos ?? w.engine.camera.position;
    const r2 = REC_RADIUS * REC_RADIUS;
    const actors: AF[] = [];
    for (const a of w.actors) {
      if (a.pos.distanceToSquared(c) > r2) continue;
      const s = a as unknown as { model?: CharacterModel; yaw?: number; pitch?: number; weapon?: Weapon; health?: number };
      const m = s.model;
      if (!m || !m.root) continue;
      a.eyePos(this.tmp);
      actors.push({
        a, x: a.pos.x, y: a.pos.y, z: a.pos.z, ex: this.tmp.x, ey: this.tmp.y, ez: this.tmp.z,
        yaw: s.yaw ?? 0, pitch: s.pitch ?? 0, loco: m.loco, upper: m.upper, alive: a.alive, vis: m.root.visible,
        weapon: a.kind === 'soldier' ? s.weapon ?? null : null, health: s.health ?? 0, scale: m.root.scale.x,
      });
    }
    const vehicles: VF[] = [];
    for (const v of w.vehicles) {
      const p = v.model.position;
      if (p.distanceToSquared(c) > r2) continue;
      const q = v.model.quaternion;
      vehicles.push({ v, x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w });
    }
    this.frames.push({ t: w.time, actors, vehicles });
    const cut = w.time - this.keep;
    while (this.frames.length && this.frames[0].t < cut) this.frames.shift();
    while (this.events.length && this.events[0].t < cut) this.events.shift();
  }

  /** frames bracketing t (f0.t <= t <= f1.t) and the blend factor */
  sample(t: number): { f0: Frame; f1: Frame; k: number } | null {
    const fr = this.frames;
    if (fr.length < 2) return null;
    let lo = 0, hi = fr.length - 1;
    if (t <= fr[0].t) return { f0: fr[0], f1: fr[0], k: 0 };
    if (t >= fr[hi].t) return { f0: fr[hi], f1: fr[hi], k: 0 };
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fr[mid].t <= t) lo = mid; else hi = mid; }
    const f0 = fr[lo], f1 = fr[hi];
    return { f0, f1, k: (t - f0.t) / Math.max(1e-4, f1.t - f0.t) };
  }
}

const lerpAngle = (a: number, b: number, k: number) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * k; };

interface Ghost { m: CharacterModel; loco: string; upper: string; held: Weapon | null; ready: boolean }

/**
 * Killcam: after the player is killed by a soldier, the last ~5 seconds are replayed from the
 * killer's eyes (killer's weapon as view-model, recorded aim). Everybody else is shown as ghost
 * characters animated from the recorded states; vehicles, tracers, muzzle flashes, impacts,
 * explosions, positional sounds and hit markers are replayed in sync. The fatal shot runs in slow
 * motion. Live actors keep simulating underneath and are hidden while the replay runs.
 */
export class Killcam {
  active = false;
  /** killer / kill time waiting for the short death pause before the replay starts */
  pending: { killer: Actor; victim: Actor; killT: number; startAt: number } | null = null;
  t = 0;
  private t0 = 0; private t1 = 0; private killT = 0;
  killer: Actor | null = null;
  victim: Actor | null = null;
  private ghosts = new Map<Actor, Ghost>();
  private evIdx = 0;
  private lastT = 0;
  /** killer weapon + firing state for the first-person view-model */
  view = { weapon: null as Weapon | null, ads: 0, fired: 0, eye: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1) };
  onEnd: (() => void) | null = null;
  private tmpQ = new THREE.Quaternion();

  constructor(private w: GameWorld, private rec: ReplayRecorder) {}

  /** queue a killcam (starts after a short pause so the death itself still registers) */
  schedule(killer: Actor | null, victim: Actor, killT: number) {
    if (!killer || killer === victim || killer.kind !== 'soldier') return;
    if (this.rec.frames.length < 20 || !this.rec.frames.some((f) => f.actors.some((x) => x.a === killer))) return;
    this.pending = { killer, victim, killT, startAt: killT + 1.4 };
  }

  get busy() { return this.active || !!this.pending; }

  private async begin() {
    const p = this.pending!;
    this.pending = null;
    const fr = this.rec.frames;
    this.killer = p.killer; this.victim = p.victim; this.killT = p.killT;
    this.t0 = Math.max(fr[0].t, p.killT - 5.2);
    this.t1 = Math.min(p.killT + 1.1, fr[fr.length - 1].t);
    if (this.t1 - this.t0 < 1.5) return;
    this.t = this.lastT = this.t0;
    this.evIdx = this.rec.events.findIndex((e) => e.t >= this.t0);
    if (this.evIdx < 0) this.evIdx = this.rec.events.length;
    // ghosts: the victim plus everybody close to the killer during the replay window
    const kp = fr.find((f) => f.t >= p.killT)?.actors.find((x) => x.a === p.killer) ?? fr[fr.length - 1].actors.find((x) => x.a === p.killer);
    const wanted = new Set<Actor>();
    for (const f of fr) {
      if (f.t < this.t0 || f.t > this.t1) continue;
      for (const x of f.actors) {
        if (x.a === p.killer) continue;
        if (x.a === p.victim || (kp && Math.hypot(x.x - kp.x, x.z - kp.z) < 110)) wanted.add(x.a);
      }
    }
    const list = [...wanted].slice(0, 14);
    for (const a of list) this.ghosts.set(a, { m: new CharacterModel(), loco: '', upper: '', held: null, ready: false });
    this.active = true;
    this.w.bus.emit('killcam', { active: true, killer: p.killer, victim: p.victim, dist: kp ? Math.hypot(kp.x - p.victim.pos.x, kp.z - p.victim.pos.z) : 0, hp: kp?.health ?? 0, weapon: kp?.weapon?.def.name ?? '' });
    await Promise.all(list.map(async (a) => {
      const g = this.ghosts.get(a)!;
      const src = a as unknown as { modelId?: string; useModel?: string; tint?: number };
      try {
        await g.m.init(this.w.assets, src.modelId ?? src.useModel ?? 'char_mannequin', src.tint);
        g.m.root.visible = false;
        this.w.scene.add(g.m.root);
        g.ready = true;
      } catch { /* ghost optional */ }
    }));
  }

  skip() { if (this.active) this.end(); else this.pending = null; }

  private end() {
    this.active = false;
    for (const g of this.ghosts.values()) { g.m.dispose(); }
    // live models come back (their own updates fix distance culling next frame)
    for (const a of this.w.actors) { const m = (a as unknown as { model?: CharacterModel }).model; if (m?.root && a !== this.w.player?.soldier) m.root.visible = true; }
    this.ghosts.clear();
    this.killer = null; this.victim = null;
    this.w.bus.emit('killcam', { active: false });
    this.onEnd?.();
  }

  /** advance the replay clock, fire events; returns the playback rate (slow-mo near the kill) */
  update(dt: number) {
    if (this.pending && !this.active && this.w.time >= this.pending.startAt) this.begin();
    if (!this.active) return;
    const inp = this.w.input;
    if (inp.pressed('jump') || inp.pressed('interact')) { this.end(); return; }
    const slow = this.t > this.killT - 0.45 && this.t < this.killT + 0.35;
    const rate = slow ? 0.28 : 1;
    this.lastT = this.t;
    this.t += dt * rate;
    this.replayEvents(this.lastT, this.t);
    if (this.t >= this.t1) { this.end(); return; }
    this.apply(dt * rate);
  }

  private replayEvents(a: number, b: number) {
    const ev = this.rec.events, o = this.rec.orig;
    while (this.evIdx < ev.length && ev[this.evIdx].t <= b) {
      const e = ev[this.evIdx++];
      if (e.t < a) continue;
      if (e.fn === 'hit') {
        const [target, amount, attacker, zone] = e.args as [Actor, number, Actor | null, string];
        if (attacker === this.killer && target === this.victim) this.w.bus.emit('killcamHit', { amount, zone, kill: e.t >= this.killT - 0.05 });
        continue;
      }
      if (e.fn === 'muzzle' && this.killer) {
        const p = e.args[0] as THREE.Vector3;
        if (p.distanceTo(this.view.eye) < 2.5) { this.view.fired = 1; continue; } // first-person flash comes from the view-model
      }
      const fn = o[e.fn];
      if (fn) (fn as (...x: unknown[]) => unknown)(...e.args);
    }
  }

  /** pose ghosts, vehicles and the camera for the current replay time (after the live update) */
  apply(dt: number) {
    const s = this.rec.sample(this.t);
    if (!s) return;
    const { f0, f1, k } = s;
    const cam = this.w.engine.camera;
    // hide every live actor: only the recorded past is on screen
    for (const a of this.w.actors) { const m = (a as unknown as { model?: CharacterModel }).model; if (m?.root) m.root.visible = false; }
    const idx1 = new Map<Actor, AF>(); for (const x of f1.actors) idx1.set(x.a, x);
    for (const x0 of f0.actors) {
      const x1 = idx1.get(x0.a) ?? x0;
      if (x0.a === this.killer) {
        this.view.eye.set(THREE.MathUtils.lerp(x0.ex, x1.ex, k), THREE.MathUtils.lerp(x0.ey, x1.ey, k), THREE.MathUtils.lerp(x0.ez, x1.ez, k));
        const yaw = lerpAngle(x0.yaw, x1.yaw, k), pitch = THREE.MathUtils.lerp(x0.pitch, x1.pitch, k);
        this.view.dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
        this.view.weapon = x0.weapon;
        continue;
      }
      const g = this.ghosts.get(x0.a);
      if (!g || !g.ready) continue;
      const m = g.m;
      m.root.visible = x0.vis || x0.a === this.victim;
      m.root.position.set(THREE.MathUtils.lerp(x0.x, x1.x, k), THREE.MathUtils.lerp(x0.y, x1.y, k), THREE.MathUtils.lerp(x0.z, x1.z, k));
      m.root.rotation.y = lerpAngle(x0.yaw, x1.yaw, k);
      m.root.scale.setScalar(x0.scale);
      if (g.loco !== x0.loco) { g.loco = x0.loco; m.setLoco(x0.loco, 0.18); }
      if (g.upper !== x0.upper) { g.upper = x0.upper; m.setUpper(x0.upper, 0.12); }
      if (g.held !== x0.weapon) {
        g.held = x0.weapon;
        if (x0.weapon && x0.alive) this.w.weaponModel(x0.weapon).then((obj) => { if (g.held === x0.weapon && this.active) m.attach(obj); });
        else m.attach(null);
      }
      m.update(dt, m.root.position.distanceTo(this.view.eye));
    }
    // vehicles at their recorded transforms
    const v1 = new Map<Vehicle, VF>(); for (const x of f1.vehicles) v1.set(x.v, x);
    for (const a0 of f0.vehicles) {
      const a1 = v1.get(a0.v) ?? a0;
      a0.v.model.position.set(THREE.MathUtils.lerp(a0.x, a1.x, k), THREE.MathUtils.lerp(a0.y, a1.y, k), THREE.MathUtils.lerp(a0.z, a1.z, k));
      a0.v.model.quaternion.set(a0.qx, a0.qy, a0.qz, a0.qw).slerp(this.tmpQ.set(a1.qx, a1.qy, a1.qz, a1.qw), k);
    }
    // the killer's eyes
    cam.position.copy(this.view.eye);
    cam.lookAt(this.view.eye.clone().add(this.view.dir));
    const firing = this.view.fired > 0;
    this.view.ads += ((firing || (this.t > this.killT - 1.2 && this.t < this.killT + 0.2) ? 1 : 0) - this.view.ads) * Math.min(1, dt * 6);
    this.view.fired = Math.max(0, this.view.fired - dt * 6);
  }

  /** seconds into the replay and length, for the HUD timeline */
  get progress() { return this.active ? THREE.MathUtils.clamp((this.t - this.t0) / Math.max(0.1, this.t1 - this.t0), 0, 1) : 0; }
  get slowMo() { return this.active && this.t > this.killT - 0.45 && this.t < this.killT + 0.35; }

  dispose() { if (this.active) this.end(); this.pending = null; }
}
