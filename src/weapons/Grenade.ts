import * as THREE from 'three';
import type { GameWorld } from '../gameplay/GameWorld';
import type { Actor } from '../gameplay/types';

export type GrenadeKind = 'frag' | 'smoke' | 'flash' | 'molotov';

/** Thrown grenade: ballistic arc with bounces (Rapier raycasts), cook timer, kind-specific effect. */
export class Grenade {
  pos: THREE.Vector3; vel: THREE.Vector3; fuse: number; owner: Actor | null; kind: GrenadeKind;
  mesh: THREE.Object3D; done = false; private w: GameWorld; private smokeT = 0;
  constructor(w: GameWorld, mesh: THREE.Object3D, pos: THREE.Vector3, vel: THREE.Vector3, owner: Actor | null, kind: GrenadeKind = 'frag', fuse = 3) {
    this.w = w; this.mesh = mesh; this.pos = pos.clone(); this.vel = vel.clone(); this.owner = owner; this.kind = kind; this.fuse = fuse;
    w.scene.add(mesh);
  }
  static predict(w: GameWorld, pos: THREE.Vector3, vel: THREE.Vector3, steps = 60, dt = 1 / 30) {
    const pts: THREE.Vector3[] = [];
    const p = pos.clone(), v = vel.clone();
    for (let i = 0; i < steps; i++) {
      pts.push(p.clone());
      v.y -= 9.81 * dt;
      const np = p.clone().addScaledVector(v, dt);
      const d = np.clone().sub(p); const len = d.length();
      const hit = w.physics.raycast(p, d.normalize(), len);
      if (hit) { pts.push(hit.point); break; }
      p.copy(np);
      if (p.y < w.terrain.getHeight(p.x, p.z)) break;
    }
    return pts;
  }
  update(dt: number) {
    if (this.done) return;
    this.fuse -= dt;
    if (this.smokeT > 0) {
      this.smokeT -= dt;
      if (Math.random() < 0.6) this.w.effects.smoke(this.pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, 0.5, (Math.random() - 0.5) * 4)), 0xe0e0e0, 2);
      if (this.smokeT <= 0) { this.done = true; this.mesh.removeFromParent(); }
      return;
    }
    if (this.fuse <= 0) { this.detonate(); return; }
    this.vel.y -= 9.81 * dt;
    const step = this.vel.clone().multiplyScalar(dt);
    const len = step.length();
    if (len > 1e-5) {
      const hit = this.w.physics.raycast(this.pos, step.clone().normalize(), len + 0.05);
      if (hit) {
        this.pos.copy(hit.point).addScaledVector(hit.normal, 0.06);
        this.vel.reflect(hit.normal).multiplyScalar(0.38);
        if (this.vel.length() > 1.5) this.w.audio.play('grenade_bounce', { pos: this.pos, volume: 0.5 });
      } else this.pos.add(step);
    }
    const gh = this.w.terrain.getHeight(this.pos.x, this.pos.z);
    if (this.pos.y < gh + 0.05) { this.pos.y = gh + 0.05; this.vel.y = Math.abs(this.vel.y) * 0.3; this.vel.x *= 0.6; this.vel.z *= 0.6; }
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.x += dt * 8; this.mesh.rotation.z += dt * 5;
  }
  private detonate() {
    const w = this.w;
    if (this.kind === 'smoke') { this.smokeT = 14; w.audio.play('smoke_hiss', { pos: this.pos }); return; }
    this.done = true;
    this.mesh.removeFromParent();
    if (this.kind === 'flash') {
      w.audio.play('flashbang', { pos: this.pos, volume: 1 });
      w.effects.burst(this.pos, 30, 6, 0xffffff, 0.6, 0.3, 0);
      const p = w.player;
      if (p) {
        const eye = p.soldier.eyePos(new THREE.Vector3());
        const d = eye.distanceTo(this.pos);
        const toG = this.pos.clone().sub(eye).normalize();
        const facing = toG.dot(p.forward());
        if (d < 25 && !w.physics.raycast(eye, toG, d - 0.3)) w.engine.flash = Math.max(w.engine.flash, (1 - d / 25) * (facing > 0.2 ? 1.6 : 0.6));
      }
      return;
    }
    w.explode(this.pos.clone(), 7.5, 140, this.owner, 'frag');
  }
}
