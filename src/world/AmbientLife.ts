import * as THREE from 'three';
import type { GameWorld } from '../gameplay/GameWorld';

interface Flock { obj: THREE.Object3D; mixer: THREE.AnimationMixer | null; center: THREE.Vector3; radius: number; speed: number; phase: number; height: number; alarm: number; lift: number; ang: number }

/**
 * Makes the world feel inhabited: animated bird flocks (Sketchfab seagulls / ravens) circling over
 * coasts and POIs, drifting leaves near vegetation, sun-lit dust motes, fireflies at night and rain
 * splashes – all through the pooled particle system, so the cost stays tiny.
 */
export class AmbientLife {
  private w: GameWorld;
  private flocks: Flock[] = [];
  private t = 0;
  private spawnT = 0;
  private c = new THREE.Color();
  constructor(w: GameWorld) { this.w = w; }

  async addFlock(center: THREE.Vector3, radius: number, height: number, kind: 'seagulls' | 'raven' = 'seagulls', count = 1) {
    for (let i = 0; i < count; i++) {
      try {
        const obj = await this.w.assets.instance(kind === 'seagulls' ? 'birds_seagulls' : 'bird_raven');
        const anims: THREE.AnimationClip[] = obj.userData.animations ?? [];
        let mixer: THREE.AnimationMixer | null = null;
        if (anims.length) { mixer = new THREE.AnimationMixer(obj); const a = mixer.clipAction(anims[0]); a.play(); a.time = Math.random() * anims[0].duration; }
        this.w.root.add(obj);
        this.flocks.push({ obj, mixer, center: center.clone(), radius: radius * (0.7 + Math.random() * 0.6), speed: (kind === 'raven' ? 0.25 : 0.12) * (Math.random() < 0.5 ? -1 : 1), phase: Math.random() * 6.28, height: height + Math.random() * 10, alarm: 0, lift: 0, ang: 0 });
      } catch { /* optional */ }
    }
  }

  /** gunshots / explosions nearby startle the birds */
  scare(p: THREE.Vector3, radius = 160) {
    for (const f of this.flocks) {
      const dx = f.obj.position.x - p.x, dz = f.obj.position.z - p.z;
      if (dx * dx + dz * dz < radius * radius) f.alarm = 8 + Math.random() * 4;
    }
  }

  update(dt: number) {
    const w = this.w;
    this.t += dt;
    const cam = w.engine.camera.position;
    for (const f of this.flocks) {
      // startled flocks climb, widen their circle and beat their wings faster for a while
      f.alarm = Math.max(0, f.alarm - dt);
      const scared = Math.min(1, f.alarm / 3);
      f.lift += ((scared * 28) - f.lift) * Math.min(1, dt * (scared > 0 ? 1.2 : 0.15));
      f.ang += dt * f.speed * (1 + scared * 2.5);
      const a = f.phase + f.ang;
      const rad = f.radius * (1 + f.lift / 60);
      f.obj.position.set(f.center.x + Math.cos(a) * rad, f.center.y + f.height + f.lift + Math.sin(this.t * 0.4 + f.phase) * 3, f.center.z + Math.sin(a) * rad);
      if (f.mixer) f.mixer.timeScale = 1 + scared * 1.5;
      f.obj.rotation.y = -a + (f.speed > 0 ? Math.PI : 0);
      const d = f.obj.position.distanceTo(cam);
      f.obj.visible = d < 500;
      if (f.mixer && d < 300) f.mixer.update(dt);
    }
    // particles around the camera
    this.spawnT -= dt;
    if (this.spawnT > 0) return;
    this.spawnT = 0.08;
    const fx = w.effects, sky = w.sky;
    const rnd = (r: number) => (Math.random() - 0.5) * 2 * r;
    const night = sky.isNight;
    const ground = w.terrain.getHeight(cam.x, cam.z);
    if (cam.y - ground > 60) return;
    // drifting leaves / pollen near vegetation (not on asphalt / in cities)
    if (!night && w.terrain.surfaceAt(cam.x, cam.z) === 'grass' && Math.random() < 0.6) {
      const p = new THREE.Vector3(cam.x + rnd(22), 0, cam.z + rnd(22));
      p.y = w.terrain.getHeight(p.x, p.z) + 4 + Math.random() * 6;
      this.c.setHSL(0.12 + Math.random() * 0.15, 0.6, 0.35);
      fx.emit(p, new THREE.Vector3(rnd(0.8) + 0.6, -0.6, rnd(0.8)), this.c, 0.9, 0.09, 7, 0.05, 0);
    }
    // sun-lit dust motes
    if (!night && sky.weather === 'clear' && Math.random() < 0.5) {
      const p = cam.clone().add(new THREE.Vector3(rnd(6), rnd(2) - 0.5, rnd(6)));
      fx.emit(p, new THREE.Vector3(rnd(0.1), rnd(0.05), rnd(0.1)), this.c.setRGB(1, 0.95, 0.8), 0.25, 0.025, 4, 0, 0, true);
    }
    // fireflies at night
    if (night && Math.random() < 0.7) {
      const p = new THREE.Vector3(cam.x + rnd(18), 0, cam.z + rnd(18));
      p.y = w.terrain.getHeight(p.x, p.z) + 0.5 + Math.random() * 2;
      if (p.y > w.waterLevel + 0.5) fx.emit(p, new THREE.Vector3(rnd(0.4), rnd(0.2), rnd(0.4)), this.c.setRGB(0.75, 1, 0.3), 0.9, 0.06, 3 + Math.random() * 3, 0, 0, true);
    }
    // rain splashes
    if (sky.weather === 'rain') for (let i = 0; i < 6; i++) {
      const p = new THREE.Vector3(cam.x + rnd(14), 0, cam.z + rnd(14));
      p.y = Math.max(w.terrain.getHeight(p.x, p.z), w.waterLevel) + 0.05;
      fx.emit(p, new THREE.Vector3(rnd(0.5), 1.2, rnd(0.5)), this.c.setRGB(0.8, 0.85, 0.95), 0.5, 0.05, 0.25, 6, 1);
    }
  }

  dispose() { for (const f of this.flocks) f.obj.removeFromParent(); this.flocks = []; }
}
