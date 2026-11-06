import * as THREE from 'three';

const MAX_P = 4000;
const MAX_TRACERS = 256;

/**
 * Pooled GPU particle + tracer system (single draw call each):
 * muzzle flashes, sparks (metal), splinters (wood), dust (concrete/ground), blood, explosions,
 * smoke, water splashes and bullet tracers. Plus a single pooled muzzle light.
 */
export class Effects {
  private geo = new THREE.BufferGeometry();
  private pos = new Float32Array(MAX_P * 3);
  private col = new Float32Array(MAX_P * 4);
  private size = new Float32Array(MAX_P);
  private vel = new Float32Array(MAX_P * 3);
  private life = new Float32Array(MAX_P);
  private maxLife = new Float32Array(MAX_P);
  private grav = new Float32Array(MAX_P);
  private grow = new Float32Array(MAX_P);
  private baseSize = new Float32Array(MAX_P);
  private baseAlpha = new Float32Array(MAX_P);
  private next = 0;
  points: THREE.Points;
  tracers: THREE.LineSegments;
  private tPos = new Float32Array(MAX_TRACERS * 6);
  private tCol = new Float32Array(MAX_TRACERS * 8);
  private tLife = new Float32Array(MAX_TRACERS);
  private tVel: THREE.Vector3[] = [];
  private tNext = 0;
  light = new THREE.PointLight(0xffc070, 0, 12, 2);
  private lightT = 0;
  constructor(scene: THREE.Scene) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { scale: { value: innerHeight / 2 } },
      vertexShader: `attribute float size; attribute vec4 color; varying vec4 vC; uniform float scale;
        void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * scale / max(-mv.z, 0.1); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec4 vC; void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d,d); if (r > 0.25) discard; gl_FragColor = vec4(vC.rgb, vC.a * smoothstep(0.25, 0.05, r)); }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.tPos, 3).setUsage(THREE.DynamicDrawUsage));
    tg.setAttribute('color', new THREE.BufferAttribute(this.tCol, 4).setUsage(THREE.DynamicDrawUsage));
    this.tracers = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    (this.tracers.material as THREE.LineBasicMaterial).blending = THREE.AdditiveBlending;
    this.tracers.frustumCulled = false;
    scene.add(this.tracers);
    for (let i = 0; i < MAX_TRACERS; i++) this.tVel.push(new THREE.Vector3());
    scene.add(this.light);
    addEventListener('resize', () => { mat.uniforms.scale.value = innerHeight / 2; });
  }

  emit(p: THREE.Vector3, v: THREE.Vector3, color: THREE.Color, alpha: number, size: number, life: number, gravity = 0, grow = 0) {
    const i = this.next; this.next = (this.next + 1) % MAX_P;
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z;
    this.col[i * 4] = color.r; this.col[i * 4 + 1] = color.g; this.col[i * 4 + 2] = color.b; this.col[i * 4 + 3] = alpha;
    this.size[i] = size; this.baseSize[i] = size; this.baseAlpha[i] = alpha;
    this.life[i] = life; this.maxLife[i] = life; this.grav[i] = gravity; this.grow[i] = grow;
  }

  private tmpV = new THREE.Vector3();
  private tmpC = new THREE.Color();
  burst(p: THREE.Vector3, n: number, speed: number, color: number | THREE.Color, size: number, life: number, gravity = 9.8, spread = 1, up = 0, grow = 0, alpha = 1) {
    const c = color instanceof THREE.Color ? color : this.tmpC.setHex(color);
    for (let k = 0; k < n; k++) {
      this.tmpV.set((Math.random() - 0.5) * 2 * spread, Math.random() * spread + up, (Math.random() - 0.5) * 2 * spread).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.6));
      this.emit(p, this.tmpV, c, alpha, size * (0.6 + Math.random() * 0.8), life * (0.6 + Math.random() * 0.6), gravity, grow);
    }
  }

  muzzle(p: THREE.Vector3, dir: THREE.Vector3, big = false, silenced = false) {
    if (!silenced) {
      this.burst(p, big ? 6 : 3, 2, 0xffd27a, big ? 0.5 : 0.28, 0.05, 0, 0.3);
      this.light.position.copy(p);
      this.light.intensity = big ? 30 : 14;
      this.lightT = 0.05;
    }
    this.tmpV.copy(dir).multiplyScalar(1.2);
    this.emit(p, this.tmpV, this.tmpC.setHex(0xb0b0b0), 0.25, 0.25, 0.4, -0.5, 1.5);
  }

  impact(p: THREE.Vector3, n: THREE.Vector3, surface: string) {
    const up = this.tmpV.copy(n);
    if (surface === 'metal' || surface === 'vehicle') { this.burst(p, 8, 7, 0xffc060, 0.06, 0.35, 9.8, 1, 0.5); }
    else if (surface === 'wood') { this.burst(p, 6, 4, 0x8a6a40, 0.08, 0.6, 9.8, 1, 0.6); }
    else if (surface === 'water') { this.burst(p, 10, 4, 0xdff4ff, 0.18, 0.6, 9.8, 0.4, 2); }
    else if (surface === 'flesh') { this.burst(p, 8, 3, 0x9a0a0a, 0.12, 0.5, 9.8, 1, 0.3); }
    else { this.burst(p, 5, 2.5, 0xb8a888, 0.22, 0.8, 1, 1, 0.8, 1.2, 0.6); }
    void up;
  }

  explosion(p: THREE.Vector3, scale = 1) {
    this.burst(p, Math.round(40 * scale), 14 * scale, 0xffa030, 1.1 * scale, 0.5, 2, 1, 0.3, 2, 1);
    this.burst(p, Math.round(25 * scale), 6 * scale, 0x444444, 2.2 * scale, 2.2, -1, 1, 0.6, 2.5, 0.55);
    this.burst(p, Math.round(30 * scale), 22 * scale, 0x3a2a1a, 0.15, 1.2, 9.8, 1, 0.8);
    this.light.position.copy(p); this.light.intensity = 300 * scale; this.light.distance = 40 * scale; this.lightT = 0.18;
  }

  smoke(p: THREE.Vector3, color = 0xd8d8d8, n = 3) { this.burst(p, n, 1.2, color, 3, 5, -0.15, 1, 0.4, 1.5, 0.5); }

  tracer(from: THREE.Vector3, to: THREE.Vector3, color = 0xffd890) {
    const i = this.tNext; this.tNext = (this.tNext + 1) % MAX_TRACERS;
    const dir = this.tmpV.copy(to).sub(from);
    const len = Math.min(dir.length(), 8);
    dir.normalize();
    this.tPos.set([from.x, from.y, from.z, from.x + dir.x * len, from.y + dir.y * len, from.z + dir.z * len], i * 6);
    const c = this.tmpC.setHex(color);
    this.tCol.set([c.r, c.g, c.b, 0, c.r, c.g, c.b, 0.9], i * 8);
    this.tLife[i] = Math.min(0.25, from.distanceTo(to) / 600 + 0.02);
    this.tVel[i].copy(dir).multiplyScalar(600);
  }

  update(dt: number) {
    for (let i = 0; i < MAX_P; i++) {
      if (this.life[i] <= 0) { if (this.size[i] !== 0) this.size[i] = 0; continue; }
      this.life[i] -= dt;
      const k = Math.max(this.life[i] / this.maxLife[i], 0);
      this.vel[i * 3 + 1] -= this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3] *= 0.98; this.vel[i * 3 + 2] *= 0.98;
      this.size[i] = this.baseSize[i] * (1 + (1 - k) * this.grow[i]);
      this.col[i * 4 + 3] = this.baseAlpha[i] * k;
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    for (let i = 0; i < MAX_TRACERS; i++) {
      if (this.tLife[i] <= 0) { this.tCol[i * 8 + 3] = 0; this.tCol[i * 8 + 7] = 0; continue; }
      this.tLife[i] -= dt;
      const v = this.tVel[i];
      for (let j = 0; j < 2; j++) { this.tPos[i * 6 + j * 3] += v.x * dt; this.tPos[i * 6 + j * 3 + 1] += v.y * dt; this.tPos[i * 6 + j * 3 + 2] += v.z * dt; }
      if (this.tLife[i] <= 0) { this.tCol[i * 8 + 3] = 0; this.tCol[i * 8 + 7] = 0; }
    }
    const tg = this.tracers.geometry;
    (tg.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (tg.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    if (this.lightT > 0) { this.lightT -= dt; if (this.lightT <= 0) { this.light.intensity = 0; this.light.distance = 12; } }
  }

  /** draw everything once so shaders compile before the first fight */
  warm(p: THREE.Vector3) { this.explosion(p.clone().setY(-500), 0.1); this.tracer(p.clone().setY(-500), p.clone().setY(-490)); }
}
