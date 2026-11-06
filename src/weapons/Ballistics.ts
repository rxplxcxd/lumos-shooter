import * as THREE from 'three';
import type { GameWorld } from '../gameplay/GameWorld';
import type { Actor, HitZone } from '../gameplay/types';
import type { WeaponStats } from './Weapon';

interface Bullet {
  pos: THREE.Vector3; vel: THREE.Vector3; owner: Actor | null; stats: WeaponStats; life: number; dmgMul: number; travelled: number; tracer: boolean; pellet: boolean;
}

const HARDNESS: Record<string, number> = { wood: 1, glass: 0, metal: 1, vehicle: 2, concrete: 2, stone: 3, terrain: 9, water: 9 };

/**
 * True projectile simulation: per-step segment raycasts against the Rapier world and
 * analytic hit-capsules of actors, with gravity drop, air drag, damage falloff and
 * material penetration (wall-bangs through wood / thin metal for heavy calibres).
 */
export class Ballistics {
  bullets: Bullet[] = [];
  private w: GameWorld;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  constructor(w: GameWorld) { this.w = w; }

  fire(owner: Actor | null, origin: THREE.Vector3, dir: THREE.Vector3, stats: WeaponStats, opts: { tracer?: boolean; pellet?: boolean } = {}) {
    if (stats.velocity <= 0) { this.hitscan(owner, origin, dir, stats); return; }
    this.bullets.push({ pos: origin.clone(), vel: dir.clone().multiplyScalar(stats.velocity), owner, stats, life: 3, dmgMul: 1, travelled: 0, tracer: opts.tracer ?? true, pellet: !!opts.pellet });
  }

  private hitscan(owner: Actor | null, origin: THREE.Vector3, dir: THREE.Vector3, stats: WeaponStats) {
    const end = this.tmp.copy(origin).addScaledVector(dir, stats.range);
    this.segment({ pos: origin.clone(), vel: dir.clone(), owner, stats, life: 0, dmgMul: 1, travelled: 0, tracer: false, pellet: false }, origin, end);
  }

  update(dt: number) {
    const g = 9.81;
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      const start = this.tmp2.copy(b.pos);
      b.vel.y -= g * b.stats.gravity * dt;
      b.vel.multiplyScalar(1 - 0.02 * dt); // drag
      const end = b.pos.clone().addScaledVector(b.vel, dt);
      const segLen = start.distanceTo(end);
      const done = this.segment(b, start, end);
      b.travelled += segLen;
      b.life -= dt;
      if (done || b.life <= 0 || b.pos.y < -60) { this.bullets.splice(i, 1); continue; }
      b.pos.copy(end);
    }
  }

  /** returns true when the bullet stopped */
  private segment(b: Bullet, a: THREE.Vector3, c: THREE.Vector3): boolean {
    const w = this.w;
    const dir = this.tmp.copy(c).sub(a);
    const len = dir.length();
    if (len < 1e-5) return false;
    dir.divideScalar(len);
    if (b.tracer && b.travelled < 2 && b.travelled === 0) w.effects.tracer(a, a.clone().addScaledVector(dir, Math.min(len * 4, 60)), b.owner?.isPlayer ? 0xffe0a0 : 0xffb070);
    else if (b.tracer && Math.random() < 0.25) w.effects.tracer(a, c);
    // actors
    let bestActor: Actor | null = null, bestD = len, bestZone: HitZone = 'body';
    for (const act of w.actorsNear(a, len + 4)) {
      if (act === b.owner || !act.alive) continue;
      if (b.owner && w.mode?.friendlyFire === false && act.team === b.owner.team && act.kind === 'soldier' && b.owner.kind === 'soldier') continue;
      const h = act.hitTest(a, dir, bestD);
      if (h && h.dist < bestD) { bestD = h.dist; bestActor = act; bestZone = h.zone; }
    }
    // world
    const hit = w.physics.raycast(a, dir, bestD, (b.owner as any)?.collider ?? null);
    if (hit && hit.dist < bestD) {
      const surf = w.surfaceOfCollider(hit.collider);
      w.effects.impact(hit.point, hit.normal, surf);
      if (Math.random() < 0.3) w.audio.play(surf === 'metal' || surf === 'vehicle' ? 'metal_crash' : 'debris', { pos: hit.point, volume: 0.12, maxDist: 40, throttle: 60 });
      const veh = w.vehicleOfCollider(hit.collider);
      if (veh) veh.damage(b.stats.damage * b.dmgMul * (b.stats.explosive ? 1 : 0.6), b.owner);
      if (b.stats.explosive) { w.explode(hit.point, b.stats.explosive.radius, b.stats.explosive.damage, b.owner, b.stats.id); return true; }
      w.destructibleHit(hit.collider, b.stats.damage * b.dmgMul, hit.point);
      // penetration
      const hard = HARDNESS[surf] ?? 2;
      if (b.stats.penetration >= hard && b.dmgMul > 0.4) {
        b.dmgMul *= 0.55;
        b.pos.copy(hit.point).addScaledVector(dir, 0.35);
        b.vel.multiplyScalar(0.7);
        return false;
      }
      return true;
    }
    if (bestActor) {
      const p = a.clone().addScaledVector(dir, bestD);
      const s = b.stats;
      const dist = b.travelled + bestD;
      const fall = dist <= s.range ? 1 : Math.max(s.minDamageMul, 1 - (dist - s.range) / (s.range * 2) * (1 - s.minDamageMul));
      const zoneMul = bestZone === 'head' ? s.headMul : bestZone === 'legs' ? 0.85 : 1;
      const dmg = s.damage * fall * zoneMul * b.dmgMul;
      if (s.explosive) { w.explode(p, s.explosive.radius, s.explosive.damage, b.owner, s.id); return true; }
      const dealt = bestActor.damage(dmg, { attacker: b.owner, weapon: s.id, zone: bestZone, dir: dir.clone(), point: p });
      w.effects.impact(p, dir.clone().negate(), 'flesh');
      if (b.owner?.isPlayer) w.onPlayerHit(bestActor, dealt, bestZone, !bestActor.alive || bestActor.downed);
      return true;
    }
    // water surface
    if (a.y > w.waterLevel && c.y <= w.waterLevel) {
      const t = (a.y - w.waterLevel) / (a.y - c.y);
      const p = a.clone().lerp(c, t);
      if (w.terrain.getHeight(p.x, p.z) < w.waterLevel) { w.effects.impact(p, new THREE.Vector3(0, 1, 0), 'water'); b.vel.multiplyScalar(0.15); }
    }
    return false;
  }
}
