import * as THREE from 'three';
import type { GameWorld } from '../gameplay/GameWorld';

interface Lamp { p: THREE.Vector3; delay: number; flicker: boolean; d2: number }

/**
 * Street lighting that follows the day/night cycle: lamps switch on one after another at dusk
 * (or in fog / rain), lamp heads and building windows start to glow, and a small pool of real
 * point lights is moved to the lamps nearest to the camera so the streets get actual light
 * pools without paying for hundreds of lights. A few lamps flicker.
 */
export class StreetLights {
  private lamps: Lamp[] = [];
  private pool: THREE.PointLight[] = [];
  private glow: THREE.Points | null = null;
  private glowMat: THREE.ShaderMaterial | null = null;
  private heads: THREE.MeshStandardMaterial[] = [];
  private windows: THREE.MeshStandardMaterial[] = [];
  private on = 0;
  private t = 0;
  private sortT = 0;

  constructor(private w: GameWorld, lights: number) {
    for (let i = 0; i < lights; i++) {
      const l = new THREE.PointLight(0xffc98a, 0, 28, 1.7);
      l.castShadow = false;
      w.root.add(l);
      this.pool.push(l);
    }
  }

  add(p: THREE.Vector3) { this.lamps.push({ p: p.clone(), delay: Math.random(), flicker: Math.random() < 0.05, d2: 0 }); }

  async build() {
    if (!this.lamps.length) return;
    const pos = new Float32Array(this.lamps.length * 3);
    const seed = new Float32Array(this.lamps.length);
    this.lamps.forEach((l, i) => { pos.set([l.p.x, l.p.y, l.p.z], i * 3); seed[i] = l.flicker ? 1 + l.delay : l.delay; });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    this.glowMat = new THREE.ShaderMaterial({
      uniforms: { on: { value: 0 }, time: { value: 0 }, scale: { value: 900 } },
      vertexShader: `attribute float seed; uniform float on; uniform float time; uniform float scale; varying float vA;
        void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float lit = clamp(on * 1.6 - fract(seed) * 0.6, 0.0, 1.0);
          if (seed >= 1.0) lit *= step(0.35, fract(sin(floor(time * 9.0) * 12.9898 + seed * 78.233) * 43758.5453));
          vA = lit; gl_PointSize = scale * 1.6 / max(1.0, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vA; void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d) * 2.0; if (r > 1.0 || vA <= 0.0) discard;
          float core = exp(-r * r * 9.0) * 1.6 + exp(-r * r * 2.5) * 0.35; gl_FragColor = vec4(vec3(1.0, 0.82, 0.55) * core * vA, 1.0); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.glow = new THREE.Points(g, this.glowMat);
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 5;
    this.w.root.add(this.glow);
    // emissive lamp heads (street kit) and lit windows (city kit fake interiors)
    const grab = (root: THREE.Object3D, test: (n: string) => boolean, out: THREE.MeshStandardMaterial[]) => root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[] | undefined;
      if (!m) return;
      for (const mm of Array.isArray(m) ? m : [m]) if (test(mm.name) && 'emissive' in mm && !out.includes(mm)) out.push(mm);
    });
    try { grab(await this.w.assets.kit('street'), (n) => n === 'Light' || n === 'Glass', this.heads); } catch { /* optional */ }
    try {
      grab(await this.w.assets.kit('city'), (n) => /FakeInterior/.test(n), this.windows);
      for (const m of this.windows) { if (m.map && !m.emissiveMap) { m.emissiveMap = m.map; m.needsUpdate = true; } m.emissive.setRGB(1, 0.78, 0.5); }
    } catch { /* optional */ }
    for (const m of this.heads) m.emissive.setRGB(1, 0.85, 0.6);
  }

  private target() {
    const sky = this.w.sky;
    const t = sky.time;
    const dusk = THREE.MathUtils.smoothstep(t, 18.2, 19.3), dawn = 1 - THREE.MathUtils.smoothstep(t, 5.4, 6.6);
    const dark = Math.max(dusk, dawn);
    const gloom = sky.weather === 'fog' || sky.weather === 'rain' ? 0.75 : sky.weather === 'overcast' ? 0.25 : 0;
    return Math.max(dark, gloom);
  }

  update(dt: number) {
    if (!this.lamps.length) return;
    this.t += dt;
    const tg = this.target();
    this.on += (tg - this.on) * Math.min(1, dt * 0.6);
    if (this.glowMat) {
      this.glowMat.uniforms.on.value = this.on;
      this.glowMat.uniforms.time.value = this.t;
      this.glowMat.uniforms.scale.value = this.w.engine.renderer.domElement.height * 1.4;
      this.glow!.visible = this.on > 0.02;
    }
    for (const m of this.heads) m.emissiveIntensity = this.on * 4;
    for (const m of this.windows) m.emissiveIntensity = this.on * 0.9;
    // real lights on the nearest lamps
    if (this.on < 0.03) { for (const l of this.pool) l.visible = false; return; }
    const cam = this.w.engine.camera.position;
    this.sortT -= dt;
    if (this.sortT <= 0) {
      this.sortT = 0.25;
      for (const l of this.lamps) l.d2 = l.p.distanceToSquared(cam);
      this.lamps.sort((a, b) => a.d2 - b.d2);
    }
    for (let i = 0; i < this.pool.length; i++) {
      const lamp = this.lamps[i], light = this.pool[i];
      if (!lamp || lamp.d2 > 140 * 140) { light.visible = false; continue; }
      light.visible = true;
      light.position.copy(lamp.p).y -= 0.4;
      let k = Math.min(1, this.on * 1.6 - lamp.delay * 0.6);
      if (lamp.flicker) k *= Math.sin(this.t * 37 + lamp.delay * 10) > -0.3 && Math.sin(this.t * 3.1) > -0.6 ? 1 : 0.1;
      light.intensity = Math.max(0, k) * 55;
    }
  }

  dispose() {
    for (const m of this.heads) m.emissiveIntensity = 0;
    for (const m of this.windows) m.emissiveIntensity = 0;
  }
}
