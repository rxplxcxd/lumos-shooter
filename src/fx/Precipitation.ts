import * as THREE from 'three';

const VS = /* glsl */ `
attribute vec3 seed; attribute float rnd;
uniform float time; uniform vec3 box; uniform vec3 center; uniform float speed; uniform vec3 wind; uniform float streak; uniform float width; uniform float count;
varying vec2 vUv; varying float vFade;
void main(){
  // instances beyond the current intensity are collapsed (no CPU work to change the count)
  if (rnd > count) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 vel = vec3(wind.x, -speed * (0.82 + rnd * 0.36), wind.z);
  vec3 p = seed * box + vel * time;
  p = mod(p - center + box * 0.5, box) + center - box * 0.5;          // wrap around the camera
  vec3 dir = normalize(vel);
  vec3 toCam = normalize(cameraPosition - p);
  vec3 side = normalize(cross(dir, toCam));
  float len = length(vel) * streak;                                     // motion blur length
  vec3 pos = p + side * position.x * width + dir * position.y * len;
  vUv = vec2(position.x + 0.5, -position.y);
  float dist = distance(p, cameraPosition);
  vFade = smoothstep(0.4, 2.0, dist) * (1.0 - smoothstep(box.x * 0.3, box.x * 0.5, dist));
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}`;
const FS = /* glsl */ `
uniform vec3 color; uniform float opacity; uniform float hail;
varying vec2 vUv; varying float vFade;
void main(){
  float across = 1.0 - abs(vUv.x - 0.5) * 2.0;
  float a;
  if (hail > 0.5) { vec2 q = vUv - 0.5; a = smoothstep(0.5, 0.2, length(q * vec2(1.0, 0.6))); }
  else a = pow(across, 1.6) * smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.6, vUv.y);
  gl_FragColor = vec4(color, a * opacity * vFade);
}`;

/**
 * GPU precipitation: one instanced quad per drop / hail stone, positions wrap inside a box that
 * follows the camera and fall + drift with the wind entirely in the vertex shader (no per-frame
 * buffer updates). Rain renders as motion-blurred streaks facing the camera, hail as small icy
 * stones. Intensity only changes a uniform.
 */
export class Precipitation {
  mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  intensity = 0;
  constructor(scene: THREE.Scene, max: number, private hail = false) {
    const quad = new THREE.PlaneGeometry(1, 1).translate(0, -0.5, 0); // y: 0 (head) .. -1 (tail)
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index; g.setAttribute('position', quad.getAttribute('position'));
    const seed = new Float32Array(max * 3), rnd = new Float32Array(max);
    for (let i = 0; i < max; i++) { seed[i * 3] = Math.random(); seed[i * 3 + 1] = Math.random(); seed[i * 3 + 2] = Math.random(); rnd[i] = Math.random(); }
    g.setAttribute('seed', new THREE.InstancedBufferAttribute(seed, 3));
    g.setAttribute('rnd', new THREE.InstancedBufferAttribute(rnd, 1));
    g.instanceCount = max;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 }, box: { value: new THREE.Vector3(hail ? 40 : 46, 26, hail ? 40 : 46) }, center: { value: new THREE.Vector3() },
        speed: { value: hail ? 15 : 11 }, wind: { value: new THREE.Vector3() }, streak: { value: hail ? 0.004 : 0.032 }, width: { value: hail ? 0.035 : 0.014 },
        count: { value: 0 }, color: { value: new THREE.Color(hail ? 0xe8f0ff : 0xb8c8dc) }, opacity: { value: hail ? 0.9 : 0.42 }, hail: { value: hail ? 1 : 0 },
      },
      vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, fog: false,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  update(dt: number, cam: THREE.Vector3, intensity: number, wind: THREE.Vector2, brightness: number) {
    this.intensity = intensity;
    this.mesh.visible = intensity > 0.01;
    if (!this.mesh.visible) return;
    const u = this.mat.uniforms;
    u.time.value += dt;
    // keep the wrap phase small so float precision stays good
    if (u.time.value > 600) u.time.value -= 600;
    (u.center.value as THREE.Vector3).set(cam.x, cam.y + 4, cam.z);
    (u.wind.value as THREE.Vector3).set(wind.x * (this.hail ? 0.6 : 1), 0, wind.y * (this.hail ? 0.6 : 1));
    u.count.value = Math.min(1, intensity);
    u.opacity.value = (this.hail ? 0.85 : 0.22 + intensity * 0.28) * (0.35 + brightness * 0.65);
  }

  dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mat.dispose(); }
}
