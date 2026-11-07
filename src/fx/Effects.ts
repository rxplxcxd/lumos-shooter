import * as THREE from 'three';

const MAX_TRACERS = 256;
const MAX_STREAKS = 512;

/** one pooled point-sprite system (additive glow or alpha-blended smoke/dust) */
class Points {
  geo = new THREE.BufferGeometry();
  pos: Float32Array; col: Float32Array; size: Float32Array; seed: Float32Array;
  vel: Float32Array; life: Float32Array; maxLife: Float32Array; grav: Float32Array; grow: Float32Array; baseSize: Float32Array; baseAlpha: Float32Array; drag: Float32Array;
  next = 0; points: THREE.Points; max: number;
  constructor(scene: THREE.Scene, max: number, additive: boolean) {
    this.max = max;
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 4); this.size = new Float32Array(max); this.seed = new Float32Array(max);
    this.vel = new Float32Array(max * 3); this.life = new Float32Array(max); this.maxLife = new Float32Array(max); this.grav = new Float32Array(max);
    this.grow = new Float32Array(max); this.baseSize = new Float32Array(max); this.baseAlpha = new Float32Array(max); this.drag = new Float32Array(max);
    for (let i = 0; i < max; i++) this.seed[i] = Math.random();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('seed', new THREE.BufferAttribute(this.seed, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { scale: { value: innerHeight / 2 }, maxPx: { value: additive ? innerHeight * 0.09 : innerHeight * 0.6 }, nearFade: { value: additive ? 1.2 : 0.5 } },
      vertexShader: `attribute float size; attribute vec4 color; attribute float seed; varying vec4 vC; varying float vS; uniform float scale;
        uniform float maxPx; uniform float nearFade;
        void main(){ vC = color; vS = seed; vec4 mv = modelViewMatrix * vec4(position,1.0);
          float z = max(-mv.z, 0.1);
          gl_PointSize = min(size * scale / z, maxPx);
          // particles right in front of the lens fade out instead of becoming screen-sized blobs
          vC.a *= smoothstep(nearFade * 0.3, nearFade, z);
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: additive
        ? `varying vec4 vC; varying float vS; void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d); if (r > 0.5) discard; float core = smoothstep(0.5, 0.0, r); gl_FragColor = vec4(vC.rgb * (core * core * 2.0 + core), vC.a * core); }`
        : `varying vec4 vC; varying float vS;
          float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + vS * 91.7) * 43758.5453); }
          float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
          void main(){
            vec2 d = gl_PointCoord - 0.5;
            float a = vS * 6.283; d = mat2(cos(a), -sin(a), sin(a), cos(a)) * d;
            float r = length(d);
            float puff = n(d * 5.0 + vS * 10.0) * 0.6 + n(d * 11.0 - vS * 7.0) * 0.4;
            float m = smoothstep(0.5, 0.12, r + (puff - 0.5) * 0.28);
            if (m <= 0.01) discard;
            float shade = 0.75 + 0.25 * (0.5 - d.y) + (puff - 0.5) * 0.2;
            gl_FragColor = vec4(vC.rgb * shade, vC.a * m);
          }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 6 : 5;
    scene.add(this.points);
    addEventListener('resize', () => { mat.uniforms.scale.value = innerHeight / 2; mat.uniforms.maxPx.value = additive ? innerHeight * 0.09 : innerHeight * 0.6; });
  }
  emit(p: THREE.Vector3, v: THREE.Vector3, c: THREE.Color, alpha: number, size: number, life: number, gravity = 0, grow = 0, drag = 0.98) {
    const i = this.next; this.next = (this.next + 1) % this.max;
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z;
    this.col[i * 4] = c.r; this.col[i * 4 + 1] = c.g; this.col[i * 4 + 2] = c.b; this.col[i * 4 + 3] = alpha;
    this.size[i] = size; this.baseSize[i] = size; this.baseAlpha[i] = alpha;
    this.life[i] = life; this.maxLife[i] = life; this.grav[i] = gravity; this.grow[i] = grow; this.drag[i] = drag;
  }
  update(dt: number) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { if (this.size[i] !== 0) this.size[i] = 0; continue; }
      this.life[i] -= dt;
      const k = Math.max(this.life[i] / this.maxLife[i], 0);
      this.vel[i * 3 + 1] -= this.grav[i] * dt;
      const dr = Math.pow(this.drag[i], dt * 60);
      this.vel[i * 3] *= dr; this.vel[i * 3 + 2] *= dr; if (this.grav[i] < 0) this.vel[i * 3 + 1] *= dr;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.baseSize[i] * (1 + (1 - k) * this.grow[i]);
      // fade in quickly, fade out smoothly
      const fin = Math.min(1, (1 - k) * 12);
      this.col[i * 4 + 3] = this.baseAlpha[i] * k * fin;
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.size as THREE.BufferAttribute).needsUpdate = true;
  }
}

interface Body { pos: THREE.Vector3; vel: THREE.Vector3; rot: THREE.Euler; spin: THREE.Vector3; life: number; scale: number; bounced: number }

/**
 * Pooled VFX (few draw calls): additive glow sprites (fire, muzzle, sparks), noise-shaped smoke &
 * dust, velocity streak sparks, bullet tracers, instanced decals (bullet holes, blood, scorch marks),
 * physical debris & ejected shell casings, explosion shockwaves and a pooled flash light.
 * Particle budgets scale with the quality preset.
 */
export class Effects {
  private glow: Points;
  private soft: Points;
  tracers: THREE.LineSegments;
  private tPos = new Float32Array(MAX_TRACERS * 6);
  private tCol = new Float32Array(MAX_TRACERS * 8);
  private tLife = new Float32Array(MAX_TRACERS);
  private tVel: THREE.Vector3[] = [];
  private tNext = 0;
  private streaks: THREE.LineSegments;
  private sPos = new Float32Array(MAX_STREAKS * 6);
  private sCol = new Float32Array(MAX_STREAKS * 8);
  private sVel = new Float32Array(MAX_STREAKS * 3);
  private sLife = new Float32Array(MAX_STREAKS);
  private sNext = 0;
  private decals: THREE.InstancedMesh;
  private decalKind: THREE.InstancedBufferAttribute;
  private decalBirth: THREE.InstancedBufferAttribute;
  private decalNext = 0;
  private decalMax: number;
  private decalMat: THREE.ShaderMaterial;
  private debris: THREE.InstancedMesh | null = null;
  private debrisBodies: Body[] = [];
  private casings: THREE.InstancedMesh | null = null;
  private casingBodies: Body[] = [];
  private rings: { mesh: THREE.Mesh; t: number; scale: number }[] = [];
  light = new THREE.PointLight(0xffc070, 0, 12, 2);
  private lightT = 0;
  private time = 0;
  private scene: THREE.Scene;
  q: number; // particle multiplier
  ground: (x: number, z: number) => number = () => -1e9;
  onCasingLand?: (p: THREE.Vector3) => void;

  constructor(scene: THREE.Scene, quality = 1, decals = 128) {
    this.scene = scene;
    this.q = quality;
    const maxP = Math.round(3000 * Math.max(0.6, quality));
    this.glow = new Points(scene, maxP, true);
    this.soft = new Points(scene, maxP, false);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.tPos, 3).setUsage(THREE.DynamicDrawUsage));
    tg.setAttribute('color', new THREE.BufferAttribute(this.tCol, 4).setUsage(THREE.DynamicDrawUsage));
    this.tracers = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.tracers.frustumCulled = false;
    scene.add(this.tracers);
    for (let i = 0; i < MAX_TRACERS; i++) this.tVel.push(new THREE.Vector3());
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(this.sPos, 3).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('color', new THREE.BufferAttribute(this.sCol, 4).setUsage(THREE.DynamicDrawUsage));
    this.streaks = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.streaks.frustumCulled = false;
    scene.add(this.streaks);
    // decals: procedural bullet holes / blood / scorch, instanced quads
    this.decalMax = decals;
    const dg = new THREE.PlaneGeometry(1, 1);
    this.decalKind = new THREE.InstancedBufferAttribute(new Float32Array(decals), 1);
    this.decalBirth = new THREE.InstancedBufferAttribute(new Float32Array(decals).fill(-1e4), 1);
    dg.setAttribute('aKind', this.decalKind); dg.setAttribute('aBirth', this.decalBirth);
    this.decalMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      uniforms: { time: { value: 0 } },
      vertexShader: `attribute float aKind; attribute float aBirth; varying vec2 vUv; varying float vKind; varying float vAge; uniform float time;
        void main(){ vUv = uv; vKind = aKind; vAge = time - aBirth; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec2 vUv; varying float vKind; varying float vAge;
        float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
        void main(){
          vec2 d = vUv - 0.5; float r = length(d) * 2.0;
          float fade = 1.0 - smoothstep(40.0, 60.0, vAge);
          vec4 c;
          if (vKind < 0.5) { // bullet hole: dark core, burnt ring
            float core = smoothstep(0.35, 0.2, r); float ring = smoothstep(1.0, 0.4, r) * 0.55;
            c = vec4(vec3(0.03), max(core, ring * (0.6 + 0.4 * n(d * 18.0))));
          } else if (vKind < 1.5) { // blood splat
            float m = smoothstep(0.85, 0.5, r + (n(d * 7.0) - 0.5) * 0.7);
            c = vec4(0.32, 0.01, 0.01, m * 0.85);
          } else { // scorch
            float m = smoothstep(1.0, 0.2, r + (n(d * 5.0) - 0.5) * 0.5);
            c = vec4(vec3(0.02), m * 0.8);
          }
          c.a *= fade;
          if (c.a < 0.01) discard;
          gl_FragColor = c;
        }`,
    });
    this.decals = new THREE.InstancedMesh(dg, this.decalMat, decals);
    this.decals.frustumCulled = false;
    this.decals.renderOrder = 1;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < decals; i++) this.decals.setMatrixAt(i, zero);
    scene.add(this.decals);
    // shockwave rings
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffe0b0, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2; m.visible = false; scene.add(m);
      this.rings.push({ mesh: m, t: 0, scale: 1 });
    }
    scene.add(this.light);
  }

  /** debris + casings use real asset geometry (rock piece from the nature kit, bullet from the SMG model) */
  setDebrisSource(obj: THREE.Object3D | null, casing: THREE.Object3D | null) {
    const mk = (o: THREE.Object3D, n: number) => {
      let mesh: THREE.Mesh | null = null;
      o.traverse((c) => { if (!mesh && (c as THREE.Mesh).isMesh) mesh = c as THREE.Mesh; });
      if (!mesh) return null;
      const m = mesh as THREE.Mesh;
      const g = m.geometry.clone();
      g.computeBoundingBox();
      const s = g.boundingBox!.getSize(new THREE.Vector3());
      const k = 1 / Math.max(s.x, s.y, s.z, 1e-4);
      g.center(); g.scale(k, k, k);
      const im = new THREE.InstancedMesh(g, m.material as THREE.Material, n);
      im.frustumCulled = false; im.castShadow = false;
      const zero = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < n; i++) im.setMatrixAt(i, zero);
      this.scene.add(im);
      return im;
    };
    if (obj) this.debris = mk(obj, Math.round(48 * this.q));
    if (casing) this.casings = mk(casing, Math.round(40 * this.q));
  }

  private tmpV = new THREE.Vector3();
  private tmpC = new THREE.Color();
  emit(p: THREE.Vector3, v: THREE.Vector3, color: THREE.Color, alpha: number, size: number, life: number, gravity = 0, grow = 0, additive = false) {
    (additive ? this.glow : this.soft).emit(p, v, color, alpha, size, life, gravity, grow);
  }

  burst(p: THREE.Vector3, n: number, speed: number, color: number | THREE.Color, size: number, life: number, gravity = 9.8, spread = 1, up = 0, grow = 0, alpha = 1, additive = false) {
    const c = color instanceof THREE.Color ? color : this.tmpC.setHex(color);
    const cnt = Math.max(1, Math.round(n * this.q));
    const sys = additive ? this.glow : this.soft;
    for (let k = 0; k < cnt; k++) {
      this.tmpV.set((Math.random() - 0.5) * 2 * spread, Math.random() * spread + up, (Math.random() - 0.5) * 2 * spread).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.6));
      sys.emit(p, this.tmpV, c, alpha, size * (0.6 + Math.random() * 0.8), life * (0.6 + Math.random() * 0.6), gravity, grow);
    }
  }

  sparks(p: THREE.Vector3, normal: THREE.Vector3, n: number, speed = 9, color = 0xffc060) {
    const c = this.tmpC.setHex(color);
    for (let k = 0; k < Math.round(n * this.q); k++) {
      const i = this.sNext; this.sNext = (this.sNext + 1) % MAX_STREAKS;
      const v = new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2).add(normal.clone().multiplyScalar(1.4)).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      this.sPos.set([p.x, p.y, p.z, p.x, p.y, p.z], i * 6);
      this.sVel.set([v.x, v.y, v.z], i * 3);
      this.sCol.set([c.r, c.g, c.b, 1, c.r, c.g * 0.7, c.b * 0.4, 0], i * 8);
      this.sLife[i] = 0.25 + Math.random() * 0.35;
    }
  }

  decal(p: THREE.Vector3, normal: THREE.Vector3, kind: 0 | 1 | 2, size = 0.12) {
    const i = this.decalNext; this.decalNext = (this.decalNext + 1) % this.decalMax;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.clone().normalize());
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.random() * 6.28));
    const s = size * (0.8 + Math.random() * 0.5);
    this.decals.setMatrixAt(i, new THREE.Matrix4().compose(p.clone().addScaledVector(normal, 0.01), q, new THREE.Vector3(s, s, s)));
    this.decals.instanceMatrix.needsUpdate = true;
    (this.decalKind.array as Float32Array)[i] = kind; this.decalKind.needsUpdate = true;
    (this.decalBirth.array as Float32Array)[i] = this.time; this.decalBirth.needsUpdate = true;
  }

  private spawnBody(list: Body[], max: number, p: THREE.Vector3, v: THREE.Vector3, scale: number, life: number) {
    if (list.length >= max) list.shift();
    list.push({ pos: p.clone(), vel: v.clone(), rot: new THREE.Euler(Math.random() * 6, Math.random() * 6, 0), spin: new THREE.Vector3((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20), life, scale, bounced: 0 });
  }

  casing(p: THREE.Vector3, v: THREE.Vector3) { if (this.casings) this.spawnBody(this.casingBodies, this.casings.count, p, v, 0.025, 3); }

  debrisBurst(p: THREE.Vector3, n: number, speed: number, scale = 0.25) {
    if (!this.debris) return;
    for (let k = 0; k < Math.round(n * this.q); k++) {
      const v = new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 1.5 + 0.4, (Math.random() - 0.5) * 2).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.7));
      this.spawnBody(this.debrisBodies, this.debris.count, p, v, scale * (0.4 + Math.random()), 4 + Math.random() * 2);
    }
  }

  muzzle(p: THREE.Vector3, dir: THREE.Vector3, big = false, silenced = false) {
    if (!silenced) {
      const c = this.tmpC.setHex(0xffc870);
      for (let k = 0; k < (big ? 5 : 3); k++) { this.tmpV.copy(dir).multiplyScalar(4 + k * 3).add(new THREE.Vector3((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)).multiplyScalar(1.5)); this.glow.emit(p.clone().addScaledVector(dir, k * 0.06), this.tmpV, c, 1, (big ? 0.45 : 0.22) * (1 - k * 0.15), 0.05, 0, 0.6); }
      this.light.position.copy(p);
      this.light.intensity = big ? 30 : 14;
      this.lightT = 0.05;
    }
    this.tmpV.copy(dir).multiplyScalar(1.2).add(new THREE.Vector3(0, 0.3, 0));
    this.soft.emit(p, this.tmpV, this.tmpC.setHex(0xc8c8c8), 0.22, 0.2, 0.6, -0.6, 2.2);
  }

  impact(p: THREE.Vector3, n: THREE.Vector3, surface: string) {
    if (surface === 'metal' || surface === 'vehicle') {
      this.sparks(p, n, 10, 10); this.burst(p, 3, 1, 0xffd090, 0.1, 0.12, 0, 1, 0, 0, 1, true);
      this.decal(p, n, 0, 0.08);
    } else if (surface === 'wood') {
      this.burst(p, 7, 4, 0x8a6a40, 0.07, 0.7, 9.8, 1, 0.6); this.burst(p, 2, 0.6, 0x9a8a70, 0.35, 0.9, -0.2, 0.6, 0.3, 1.5, 0.5);
      this.decal(p, n, 0, 0.1);
    } else if (surface === 'water') {
      this.burst(p, 12, 4.5, 0xdff4ff, 0.18, 0.7, 9.8, 0.35, 2.4); this.burst(p, 3, 0.8, 0xffffff, 0.6, 0.8, 0, 0.6, 0.2, 1.5, 0.45);
    } else if (surface === 'flesh') {
      this.burst(p, 8, 2.6, 0x8a0606, 0.11, 0.45, 9.8, 1, 0.4); this.burst(p, 2, 0.6, 0x6a0505, 0.32, 0.5, 0.5, 0.6, 0, 1.2, 0.7);
    } else {
      this.burst(p, 4, 2.2, 0xb8a888, 0.24, 0.9, 1, 1, 0.8, 1.6, 0.55);
      this.burst(p, 5, 5, 0x6a5a4a, 0.05, 0.5, 9.8, 1, 0.5);
      if (surface !== 'terrain') this.decal(p, n, 0, 0.1);
      else if (Math.random() < 0.3) this.decal(p, n, 0, 0.14);
    }
  }

  blood(p: THREE.Vector3, ground: number) { this.decal(new THREE.Vector3(p.x + (Math.random() - 0.5) * 0.6, ground + 0.02, p.z + (Math.random() - 0.5) * 0.6), new THREE.Vector3(0, 1, 0), 1, 0.5 + Math.random() * 0.5); }

  explosion(p: THREE.Vector3, scale = 1) {
    const s = scale;
    // fireball: bright core + orange shell (additive), then rolling smoke
    this.burst(p, 14 * s, 3 * s, 0xfff2c0, 1.6 * s, 0.25, -1, 1, 0.2, 1.6, 1, true);
    this.burst(p, 36 * s, 11 * s, 0xff8a20, 1.2 * s, 0.6, 1, 1, 0.4, 2.2, 1, true);
    this.burst(p, 26 * s, 5 * s, 0x3a3634, 2.6 * s, 3.2, -1.2, 1, 0.7, 2.8, 0.6);
    this.burst(p, 12 * s, 2 * s, 0x5a5450, 3.2 * s, 6, -0.6, 0.6, 1, 2.2, 0.35);
    this.sparks(p, new THREE.Vector3(0, 1, 0), 40 * s, 22 * s, 0xffb050);
    this.debrisBurst(p, 10 * s, 14 * s, 0.22 * s);
    const g = this.ground(p.x, p.z);
    if (p.y - g < 2) this.decal(new THREE.Vector3(p.x, g + 0.03, p.z), new THREE.Vector3(0, 1, 0), 2, 4 * s);
    const ring = this.rings.find((r) => r.t <= 0) ?? this.rings[0];
    ring.t = 0.5; ring.scale = 9 * s; ring.mesh.visible = true; ring.mesh.position.set(p.x, Math.max(g, p.y - 0.5) + 0.2, p.z);
    this.light.position.copy(p); this.light.intensity = 320 * s; this.light.distance = 45 * s; this.lightT = 0.2;
  }

  smoke(p: THREE.Vector3, color = 0xd8d8d8, n = 3) { this.burst(p, n, 1.2, color, 3, 5, -0.15, 1, 0.4, 1.5, 0.5); }

  tracer(from: THREE.Vector3, to: THREE.Vector3, color = 0xffd890) {
    const i = this.tNext; this.tNext = (this.tNext + 1) % MAX_TRACERS;
    const dir = this.tmpV.copy(to).sub(from);
    const len = Math.min(dir.length(), 9);
    dir.normalize();
    this.tPos.set([from.x, from.y, from.z, from.x + dir.x * len, from.y + dir.y * len, from.z + dir.z * len], i * 6);
    const c = this.tmpC.setHex(color);
    this.tCol.set([c.r, c.g, c.b, 0, c.r * 1.5, c.g * 1.5, c.b * 1.5, 1], i * 8);
    this.tLife[i] = Math.min(0.25, from.distanceTo(to) / 600 + 0.02);
    this.tVel[i].copy(dir).multiplyScalar(650);
  }

  private updateBodies(list: Body[], im: THREE.InstancedMesh | null, dt: number, bounce: boolean) {
    if (!im) return;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      b.life -= dt;
      if (b.life <= 0) { list.splice(i, 1); continue; }
      b.vel.y -= 9.81 * dt;
      b.pos.addScaledVector(b.vel, dt);
      const g = this.ground(b.pos.x, b.pos.z);
      if (b.pos.y < g + b.scale * 0.3) {
        b.pos.y = g + b.scale * 0.3;
        if (b.vel.y < -1 && b.bounced < 3) { b.vel.y = -b.vel.y * 0.35; b.vel.x *= 0.6; b.vel.z *= 0.6; b.spin.multiplyScalar(0.5); b.bounced++; if (bounce) this.onCasingLand?.(b.pos); }
        else { b.vel.set(0, 0, 0); b.spin.multiplyScalar(0.8); }
      }
      b.rot.x += b.spin.x * dt; b.rot.y += b.spin.y * dt; b.rot.z += b.spin.z * dt;
    }
    for (let i = 0; i < im.count; i++) {
      const b = list[i];
      if (!b) { m.makeScale(0, 0, 0); im.setMatrixAt(i, m); continue; }
      const k = Math.min(1, b.life * 2) * b.scale;
      m.compose(b.pos, q.setFromEuler(b.rot), s.set(k, k, k));
      im.setMatrixAt(i, m);
    }
    im.instanceMatrix.needsUpdate = true;
  }

  update(dt: number) {
    this.time += dt;
    this.decalMat.uniforms.time.value = this.time;
    this.glow.update(dt);
    this.soft.update(dt);
    for (let i = 0; i < MAX_TRACERS; i++) {
      if (this.tLife[i] <= 0) { this.tCol[i * 8 + 3] = 0; this.tCol[i * 8 + 7] = 0; continue; }
      this.tLife[i] -= dt;
      const v = this.tVel[i];
      for (let j = 0; j < 2; j++) { this.tPos[i * 6 + j * 3] += v.x * dt; this.tPos[i * 6 + j * 3 + 1] += v.y * dt; this.tPos[i * 6 + j * 3 + 2] += v.z * dt; }
      if (this.tLife[i] <= 0) { this.tCol[i * 8 + 3] = 0; this.tCol[i * 8 + 7] = 0; }
    }
    (this.tracers.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.tracers.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    for (let i = 0; i < MAX_STREAKS; i++) {
      if (this.sLife[i] <= 0) { this.sCol[i * 8 + 3] = 0; continue; }
      this.sLife[i] -= dt;
      this.sVel[i * 3 + 1] -= 9.81 * dt;
      // tail follows head
      this.sPos[i * 6 + 3] = this.sPos[i * 6]; this.sPos[i * 6 + 4] = this.sPos[i * 6 + 1]; this.sPos[i * 6 + 5] = this.sPos[i * 6 + 2];
      this.sPos[i * 6] += this.sVel[i * 3] * dt * 1.6; this.sPos[i * 6 + 1] += this.sVel[i * 3 + 1] * dt * 1.6; this.sPos[i * 6 + 2] += this.sVel[i * 3 + 2] * dt * 1.6;
      this.sCol[i * 8 + 3] = Math.min(1, this.sLife[i] * 4);
    }
    (this.streaks.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.streaks.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    this.updateBodies(this.debrisBodies, this.debris, dt, false);
    this.updateBodies(this.casingBodies, this.casings, dt, true);
    for (const r of this.rings) {
      if (r.t <= 0) { r.mesh.visible = false; continue; }
      r.t -= dt;
      const k = 1 - r.t / 0.5;
      r.mesh.scale.setScalar(0.5 + k * r.scale);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.6;
    }
    if (this.lightT > 0) { this.lightT -= dt; if (this.lightT <= 0) { this.light.intensity = 0; this.light.distance = 12; } }
  }

  /** draw everything once so shaders compile before the first fight */
  warm(p: THREE.Vector3) { const w = p.clone().setY(-500); this.explosion(w, 0.1); this.tracer(w, w.clone().setY(-490)); this.decal(w, new THREE.Vector3(0, 1, 0), 0); }
}
