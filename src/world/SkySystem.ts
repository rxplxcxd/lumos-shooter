import * as THREE from 'three';

/**
 * Dynamic sky: cheap gradient dome with sun/moon disc + stars (one draw call, no
 * Preetham integration – friendly to integrated GPUs), sun/moon directional light with a
 * camera-following shadow frustum, hemisphere ambient, distance fog, day/night cycle
 * and weather presets (clear / overcast / fog / rain).
 */
export type Weather = 'clear' | 'overcast' | 'fog' | 'rain';

const SKY_VS = /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`;
const SKY_FS = /* glsl */ `
uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; uniform vec3 sunDir; uniform vec3 sunColor; uniform float night; uniform float time;
varying vec3 vDir;
float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = h > 0.0 ? mix(horizon, top, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(horizon, ground, clamp(-h * 4.0, 0.0, 1.0));
  float s = max(dot(d, normalize(sunDir)), 0.0);
  col += sunColor * (pow(s, 900.0) * 6.0 + pow(s, 12.0) * 0.25);
  if (night > 0.0 && h > 0.0) { float st = step(0.9985, hash(floor(d * 300.0))); col += vec3(st) * night * (0.6 + 0.4 * sin(time * 3.0 + d.x * 50.0)); }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export class SkySystem {
  dome: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  hemi = new THREE.HemisphereLight(0xbfd8ff, 0x50603a, 1.1);
  fog: THREE.Fog;
  sunDir = new THREE.Vector3();
  time = 13;
  speed = 0;
  weather: Weather = 'clear';
  brightness = 1;
  private rain: THREE.Points | null = null;
  private shadowSize: number;
  private baseFar: number;
  private camera: THREE.PerspectiveCamera | null = null;

  constructor(scene: THREE.Scene, shadowMap: number, far: number) {
    this.baseFar = far;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        top: { value: new THREE.Color(0x2f6fc4) }, horizon: { value: new THREE.Color(0xbcd6ec) }, ground: { value: new THREE.Color(0x6a7a86) },
        sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Color(1, 0.95, 0.85) }, night: { value: 0 }, time: { value: 0 },
      },
      vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.mat);
    this.dome.scale.setScalar(far * 0.5);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    scene.add(this.dome);
    scene.add(this.hemi);
    this.shadowSize = shadowMap;
    this.sun.castShadow = shadowMap > 0;
    if (shadowMap > 0) {
      this.sun.shadow.mapSize.set(shadowMap, shadowMap);
      const s = 70;
      const c = this.sun.shadow.camera;
      c.left = -s; c.right = s; c.top = s; c.bottom = -s; c.near = 1; c.far = 500;
      this.sun.shadow.bias = -0.0006;
      this.sun.shadow.normalBias = 0.03;
    }
    scene.add(this.sun, this.sun.target);
    this.fog = new THREE.Fog(0xa8c8e0, far * 0.3, far * 0.98);
    scene.fog = this.fog;
    this.update(0, new THREE.Vector3());
  }

  attachCamera(cam: THREE.PerspectiveCamera) { this.camera = cam; }

  setWeather(w: Weather, scene: THREE.Scene) {
    this.weather = w;
    if (w === 'rain' && !this.rain) {
      const n = 3000;
      const g = new THREE.BufferGeometry();
      const p = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { p[i * 3] = (Math.random() - 0.5) * 80; p[i * 3 + 1] = Math.random() * 40; p[i * 3 + 2] = (Math.random() - 0.5) * 80; }
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      this.rain = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xaaccff, size: 0.08, transparent: true, opacity: 0.6 }));
      this.rain.frustumCulled = false;
      scene.add(this.rain);
    } else if (w !== 'rain' && this.rain) { scene.remove(this.rain); this.rain = null; }
  }

  get isNight() { return this.time < 5.5 || this.time > 19.5; }

  update(dt: number, focus: THREE.Vector3) {
    this.time = (this.time + dt * this.speed) % 24;
    const dayT = (this.time - 6) / 12;
    const elev = Math.sin(dayT * Math.PI) * 68;
    const azim = 120 + dayT * 120;
    const night = elev < -2;
    const phi = THREE.MathUtils.degToRad(90 - (night ? 35 : Math.max(elev, -5)));
    const theta = THREE.MathUtils.degToRad(night ? azim + 180 : azim);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    const dayK = THREE.MathUtils.smoothstep(elev, -4, 14);
    const dusk = 1 - THREE.MathUtils.smoothstep(Math.abs(elev - 6), 0, 14);
    const overcast = this.weather === 'overcast' || this.weather === 'rain' ? 0.55 : this.weather === 'fog' ? 0.7 : 1;
    // sky colours
    const u = this.mat.uniforms;
    const dayTop = new THREE.Color(0x2a66c0), dayHor = new THREE.Color(0xb9d4ea);
    const nightTop = new THREE.Color(0x02040c), nightHor = new THREE.Color(0x0e1626);
    const duskHor = new THREE.Color(0xf09a5a);
    const grey = new THREE.Color(0x8a96a2);
    u.top.value.copy(nightTop).lerp(dayTop, dayK).lerp(grey, (1 - overcast) * 1.3 * dayK);
    u.horizon.value.copy(nightHor).lerp(dayHor, dayK).lerp(duskHor, dusk * 0.6 * overcast).lerp(grey.clone().multiplyScalar(1.15), (1 - overcast) * dayK);
    u.ground.value.copy(u.horizon.value).multiplyScalar(0.55);
    u.sunDir.value.copy(this.sunDir);
    u.sunColor.value.setRGB(1, 0.92 - dusk * 0.3, 0.8 - dusk * 0.4).multiplyScalar(night ? 0.25 : overcast);
    u.night.value = night ? 1 : 0;
    u.time.value += dt;
    // lights
    this.sun.intensity = (night ? 0.35 : 2.8 * dayK) * overcast;
    this.sun.color.set(night ? 0x8fa8ff : elev < 12 ? 0xffb070 : 0xfff1dc);
    this.hemi.intensity = (0.3 + dayK * 0.9) * (overcast < 1 ? 1.1 : 1);
    this.hemi.color.set(night ? 0x3a4a7a : 0xbfd8ff);
    this.brightness = 0.25 + dayK * 0.75 * overcast;
    // fog = horizon colour; extend with altitude so the island is visible from the drop plane
    this.fog.color.copy(u.horizon.value);
    const alt = Math.max(0, focus.y - 40);
    const far = this.baseFar + alt * 1.6;
    this.fog.near = this.weather === 'fog' ? 15 : far * 0.3;
    this.fog.far = this.weather === 'fog' ? 160 : this.weather === 'rain' ? far * 0.6 : far * 0.98;
    if (this.camera && Math.abs(this.camera.far - far) > 5) { this.camera.far = far; this.camera.updateProjectionMatrix(); }
    this.dome.scale.setScalar(far * 0.5);
    this.dome.position.copy(focus);
    // shadow frustum follows the focus point – texel-snapped to avoid shimmering
    const snap = this.shadowSize ? 140 / this.shadowSize : 1;
    const fx = Math.round(focus.x / snap) * snap, fz = Math.round(focus.z / snap) * snap;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx + this.sunDir.x * 200, focus.y + Math.max(this.sunDir.y, 0.25) * 200, fz + this.sunDir.z * 200);
    if (this.rain) {
      this.rain.position.set(focus.x, focus.y - 5, focus.z);
      const p = this.rain.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) { let y = p.getY(i) - dt * 25; if (y < 0) y += 40; p.setY(i, y); }
      p.needsUpdate = true;
    }
  }
}
