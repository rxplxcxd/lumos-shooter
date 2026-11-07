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

  private bells: THREE.Vector3[] = [];
  private chimneys: THREE.Vector3[] = [];
  private lastHour = -1;
  private tolls: number[] = [];
  private birdT = 4; private owlT = 15; private waveT = 2; private smokeT = 0; private litterT = 0;
  setLandmarks(bells: THREE.Vector3[], chimneys: THREE.Vector3[]) { this.bells = bells; this.chimneys = chimneys; }

  /** ambience: birdsong by day, owls at night, the town-hall bell strikes the hours, surf at the coast */
  private soundscape(dt: number) {
    const w = this.w, sky = w.sky, cam = w.engine.camera.position;
    const wxp = sky.wx?.p;
    const rain = wxp?.rain ?? 0;
    const night = sky.isNight;
    // hourly bell (1..4 strokes, a few seconds apart)
    const hour = Math.floor(sky.time);
    if (this.lastHour >= 0 && hour !== this.lastHour && this.bells.length) {
      const n = Math.min(4, (hour % 12) || 12);
      for (let i = 0; i < n; i++) this.tolls.push(this.t + i * 2.6);
    }
    this.lastHour = hour;
    for (let i = this.tolls.length - 1; i >= 0; i--) {
      if (this.t < this.tolls[i]) continue;
      this.tolls.splice(i, 1);
      for (const b of this.bells) if (b.distanceTo(cam) < 600) w.audio.play('church_bell', { pos: b, volume: 0.9, maxDist: 650 });
    }
    // birds (not in rain), owls at night
    this.birdT -= dt;
    if (this.birdT <= 0) {
      this.birdT = 6 + Math.random() * 14;
      if (!night && rain < 0.1) {
        const a = Math.random() * Math.PI * 2, r = 10 + Math.random() * 20;
        const p = new THREE.Vector3(cam.x + Math.cos(a) * r, 0, cam.z + Math.sin(a) * r);
        p.y = w.terrain.getHeight(p.x, p.z) + 6;
        if (p.y > w.waterLevel + 2) w.audio.play('birdsong', { pos: p, volume: 0.32 + Math.random() * 0.2, rate: 0.9 + Math.random() * 0.25, maxDist: 60 });
      }
    }
    this.owlT -= dt;
    if (this.owlT <= 0) {
      this.owlT = 18 + Math.random() * 26;
      if (night && rain < 0.2) {
        const a = Math.random() * Math.PI * 2;
        const p = new THREE.Vector3(cam.x + Math.cos(a) * 35, cam.y + 8, cam.z + Math.sin(a) * 35);
        w.audio.play('owl', { pos: p, volume: 0.45, rate: 0.95 + Math.random() * 0.1, maxDist: 90 });
      }
    }
    // surf: if the shoreline is near, waves roll in every few seconds
    this.waveT -= dt;
    if (this.waveT <= 0) {
      this.waveT = 3.5 + Math.random() * 3;
      for (let k = 0; k < 6; k++) {
        const a = Math.random() * Math.PI * 2, r = 12 + Math.random() * 40;
        const x = cam.x + Math.cos(a) * r, z = cam.z + Math.sin(a) * r;
        const hgt = w.terrain.getHeight(x, z);
        if (hgt < w.waterLevel + 0.3 && hgt > w.waterLevel - 2.5) { w.audio.play('waves', { pos: new THREE.Vector3(x, w.waterLevel, z), volume: 0.5 + (wxp?.wind ?? 1) * 0.2, rate: 0.9 + Math.random() * 0.2, maxDist: 70 }); break; }
      }
    }
  }

  /** chimney smoke drifting with the wind, litter and dust carried along the streets */
  private windFx(dt: number) {
    const w = this.w, fx = w.effects, cam = w.engine.camera.position;
    const wind = w.sky.wx?.windVec ?? new THREE.Vector2(1.5, 0.5);
    const wk = w.sky.wx?.p.wind ?? 1;
    this.smokeT -= dt;
    if (this.smokeT <= 0 && this.chimneys.length) {
      this.smokeT = 0.35;
      for (const c of this.chimneys) {
        if (c.distanceToSquared(cam) > 260 * 260) continue;
        this.c.setRGB(0.55, 0.55, 0.57);
        fx.emit(c.clone().add(new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).multiplyScalar(0.4)),
          new THREE.Vector3(wind.x * 0.35, 0.9 + Math.random() * 0.4, wind.y * 0.35), this.c, 0.28, 1.1, 7, -0.06, 1.7);
      }
    }
    // litter + dust in strong wind (paper scraps tumbling along the ground)
    this.litterT -= dt;
    if (this.litterT <= 0 && wk > 0.9) {
      this.litterT = 0.25 / wk;
      const rnd = (r: number) => (Math.random() - 0.5) * 2 * r;
      const p = new THREE.Vector3(cam.x + rnd(18) - wind.x * 1.5, 0, cam.z + rnd(18) - wind.y * 1.5);
      const g = w.terrain.getHeight(p.x, p.z);
      if (g > w.waterLevel + 0.4) {
        p.y = g + 0.15 + Math.random() * 0.5;
        if (Math.random() < 0.55) fx.emit(p, new THREE.Vector3(wind.x * 0.8 + rnd(0.5), 0.4 + Math.random() * 0.8, wind.y * 0.8 + rnd(0.5)), this.c.setRGB(0.92, 0.9, 0.84), 0.9, 0.08, 3.2, 1.2, 0);
        else fx.emit(p, new THREE.Vector3(wind.x * 0.9, 0.2, wind.y * 0.9), this.c.setRGB(0.62, 0.56, 0.45), 0.14, 0.9, 2.5, -0.02, 1.4);
      }
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
    this.soundscape(dt);
    this.windFx(dt);
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
    if (!night && (sky.wx ? sky.wx.p.cover < 0.5 && sky.wx.p.rain < 0.05 : sky.weather === 'clear') && Math.random() < 0.5) {
      const p = cam.clone().add(new THREE.Vector3(rnd(6), rnd(2) - 0.5, rnd(6)));
      fx.emit(p, new THREE.Vector3(rnd(0.1), rnd(0.05), rnd(0.1)), this.c.setRGB(1, 0.95, 0.8), 0.25, 0.025, 4, 0, 0, true);
    }
    // fireflies at night
    if (night && Math.random() < 0.7) {
      const p = new THREE.Vector3(cam.x + rnd(18), 0, cam.z + rnd(18));
      p.y = w.terrain.getHeight(p.x, p.z) + 0.5 + Math.random() * 2;
      if (p.y > w.waterLevel + 0.5) fx.emit(p, new THREE.Vector3(rnd(0.4), rnd(0.2), rnd(0.4)), this.c.setRGB(0.75, 1, 0.3), 0.9, 0.06, 3 + Math.random() * 3, 0, 0, true);
    }
    // rain splashes and bouncing hail stones (rate follows the intensity)
    const wxp = sky.wx?.p;
    const rainK = wxp ? wxp.rain : sky.weather === 'rain' ? 0.7 : 0;
    for (let i = 0; i < Math.round(rainK * 10); i++) {
      const p = new THREE.Vector3(cam.x + rnd(14), 0, cam.z + rnd(14));
      p.y = Math.max(w.terrain.getHeight(p.x, p.z), w.waterLevel) + 0.05;
      fx.emit(p, new THREE.Vector3(rnd(0.5), 1.2, rnd(0.5)), this.c.setRGB(0.8, 0.85, 0.95), 0.5, 0.05, 0.25, 6, 1);
    }
    if (wxp && wxp.hail > 0.15) for (let i = 0; i < Math.round(wxp.hail * 7); i++) {
      const p = new THREE.Vector3(cam.x + rnd(12), 0, cam.z + rnd(12));
      p.y = Math.max(w.terrain.getHeight(p.x, p.z), w.waterLevel) + 0.08;
      fx.emit(p, new THREE.Vector3(rnd(1.2), 2.2 + Math.random() * 1.5, rnd(1.2)), this.c.setRGB(0.92, 0.95, 1), 0.85, 0.06, 0.5, 9.8, 0);
    }
  }

  dispose() { for (const f of this.flocks) f.obj.removeFromParent(); this.flocks = []; }
}
