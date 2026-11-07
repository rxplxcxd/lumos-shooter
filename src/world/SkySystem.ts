import * as THREE from 'three';
import { WeatherSystem, type WeatherKind } from './Weather';
import type { AudioSys } from '../audio/Audio';
import type { AtmoState } from '../fx/AtmospherePass';

/**
 * Dynamic sky (one draw call): gradient dome with sun disc + glow, a realistic night sky
 * (magnitude-weighted twinkling stars with colour temperatures, Milky Way band with dust lanes,
 * moon disc with phase, maria and halo), fbm clouds driven by the weather (coverage, storm
 * darkness, lightning-lit undersides), sun / moon directional light with a texel-snapped shadow
 * frustum, hemisphere ambient, distance fog, IBL environment from the live sky, and the
 * per-frame inputs of the atmosphere post pass (height fog, godrays, wet streets, lightning).
 */
export type Weather = 'clear' | 'overcast' | 'fog' | 'rain' | WeatherKind;

const SKY_VS = /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`;
const SKY_FS = /* glsl */ `
uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; uniform vec3 sunDir; uniform vec3 sunColor; uniform vec3 moonDir;
uniform float night; uniform float time; uniform float moonPhase; uniform float flash;
uniform float cloudOn; uniform float coverage; uniform float dark; uniform vec3 cloudLit; uniform vec3 cloudDark;
varying vec3 vDir;
float hash3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
vec3 hash33(vec3 p){ return vec3(hash3(p), hash3(p + 17.31), hash3(p + 41.7)); }
float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), f.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), f.x), f.y); }
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vn(p); p = p * 2.03 + 1.7; a *= 0.5; } return s; }
vec3 stars(vec3 d){
  vec3 acc = vec3(0.0);
  for (int l = 0; l < 2; l++) {
    vec3 p = d * (l == 0 ? 170.0 : 340.0);
    vec3 id = floor(p), f = fract(p) - 0.5;
    float h = hash3(id + float(l) * 13.0);
    float th = l == 0 ? 0.972 : 0.955;
    if (h > th) {
      vec3 off = (hash33(id) - 0.5) * 0.6;
      float r = length(f - off);
      float mag = pow((h - th) / (1.0 - th), 4.0);              // few bright, many faint
      float tw = 0.7 + 0.3 * sin(time * (1.5 + h * 7.0) + h * 91.0);
      float s = smoothstep(0.11 + mag * 0.07, 0.0, r) * (0.12 + mag * 2.6) * tw * (l == 0 ? 1.0 : 0.45);
      vec3 tint = mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.85, 0.66), fract(h * 73.1));
      acc += tint * s;
    }
  }
  return acc;
}
float milky(vec3 d){
  vec3 n = normalize(vec3(0.42, 0.5, 0.76));
  float b = 1.0 - abs(dot(d, n));
  float band = pow(smoothstep(0.78, 1.0, b), 2.4);
  vec2 uv = vec2(atan(d.z, d.x) * 2.0, d.y * 4.0);
  float neb = fbm(uv * 2.0) * 0.75 + fbm(uv * 6.0) * 0.25;
  float dust = smoothstep(0.48, 0.7, fbm(uv * 3.3 + 5.0));
  return band * neb * (1.0 - dust * 0.7);
}
void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = h > 0.0 ? mix(horizon, top, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(horizon, ground, clamp(-h * 4.0, 0.0, 1.0));
  float s = max(dot(d, normalize(sunDir)), 0.0);
  col += sunColor * (pow(s, 1200.0) * 9.0 + pow(s, 14.0) * 0.28 + pow(s, 3.0) * 0.05) * (1.0 - coverage * 0.85);
  float hor = smoothstep(-0.04, 0.22, h);
  float clearSky = 1.0 - smoothstep(0.35, 0.95, coverage);
  if (night > 0.0) {
    col += stars(d) * night * hor * clearSky;
    col += vec3(0.36, 0.4, 0.58) * milky(d) * 0.16 * night * hor * clearSky;
  }
  // moon: disc with phase terminator, maria and a soft halo
  vec3 mn = normalize(moonDir);
  float md = dot(d, mn);
  if (mn.y > -0.05) {
    vec3 rgt = normalize(cross(mn, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));
    vec3 upv = cross(rgt, mn);
    vec2 q = vec2(dot(d, rgt), dot(d, upv)) / 0.03;
    float r = length(q);
    if (md > 0.0 && r < 1.0) {
      vec3 sp = vec3(q, sqrt(max(0.0, 1.0 - r * r)));
      vec3 L = normalize(vec3(sin(moonPhase * 6.2831), 0.15, -cos(moonPhase * 6.2831)));
      float lit = clamp(dot(sp, L) * 3.0 + 0.5, 0.0, 1.0);
      float maria = 0.72 + 0.28 * fbm(q * 2.6 + 3.0) - 0.18 * smoothstep(0.55, 0.7, vn(q * 3.5 + 9.0));
      vec3 moonCol = vec3(1.0, 0.98, 0.92) * maria * (lit * 1.7 + 0.03);
      float edge = smoothstep(1.0, 0.94, r);
      col = mix(col, moonCol + col * 0.15, edge * (0.25 + night * 0.75) * (1.0 - coverage * 0.75));
    }
    col += vec3(0.55, 0.62, 0.8) * pow(max(md, 0.0), 900.0) * 0.6 * night * (1.0 - coverage * 0.7);
    col += vec3(0.35, 0.4, 0.55) * pow(max(md, 0.0), 60.0) * 0.08 * night * (1.0 - coverage * 0.6);
  }
  if (cloudOn > 0.5 && h > 0.0) {
    vec2 cuv = d.xz / (h + 0.09) * 0.55 + vec2(time * 0.006, time * 0.002);
    float n = fbm(cuv);
    float cov = smoothstep(1.0 - coverage, 1.25 - coverage, n);
    float lit = clamp(0.55 + (fbm(cuv * 1.9 + 4.0) - 0.5) * 1.2, 0.0, 1.0);
    vec3 cc = mix(cloudDark, cloudLit, lit * (1.0 - dark * 0.6)) + sunColor * pow(s, 6.0) * 0.6 * (1.0 - dark);
    cc += vec3(0.75, 0.8, 1.0) * flash * (0.6 + lit) * 1.4;
    col = mix(col, cc, cov * smoothstep(0.0, 0.2, h) * 0.95);
  }
  col += vec3(0.6, 0.65, 0.8) * flash * 0.25;
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
  moonDir = new THREE.Vector3();
  time = 13;
  speed = 0;
  brightness = 1;
  /** height of the ground fog layer (world y), set by the map */
  fogBase = 0;
  wx: WeatherSystem | null = null;
  private fixedWeather: Weather = 'clear';
  private shadowSize: number;
  private baseFar: number;
  private camera: THREE.PerspectiveCamera | null = null;
  private envScene: THREE.Scene | null = null;
  private pmrem: THREE.PMREMGenerator | null = null;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envKey = '';
  private envT = 0;
  private scene: THREE.Scene;
  private atmo: AtmoState | null = null;
  private atmoOn = false;
  /** 0..1 raindrops on the lens (read by the engine) */
  lens = 0;
  /** match clock (drives the weather forecast) */
  clock = 0;
  private c1 = new THREE.Color(); private c2 = new THREE.Color();

  constructor(scene: THREE.Scene, shadowMap: number, far: number, opts: { clouds?: boolean; renderer?: THREE.WebGLRenderer; envMap?: boolean; shadowRange?: number; atmo?: AtmoState; atmoOn?: boolean } = {}) {
    this.baseFar = far;
    this.scene = scene;
    this.atmo = opts.atmo ?? null;
    this.atmoOn = !!opts.atmoOn;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        top: { value: new THREE.Color(0x2f6fc4) }, horizon: { value: new THREE.Color(0xbcd6ec) }, ground: { value: new THREE.Color(0x6a7a86) },
        sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Color(1, 0.95, 0.85) }, moonDir: { value: new THREE.Vector3(0, -1, 0) },
        night: { value: 0 }, time: { value: 0 }, moonPhase: { value: 0.42 }, flash: { value: 0 },
        cloudOn: { value: 0 }, coverage: { value: 0.4 }, dark: { value: 0 }, cloudLit: { value: new THREE.Color(1, 1, 1) }, cloudDark: { value: new THREE.Color(0.6, 0.65, 0.72) },
      },
      vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
    });
    this.mat.uniforms.cloudOn.value = opts.clouds ? 1 : 0;
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.mat);
    if (opts.envMap && opts.renderer) {
      // image-based lighting generated from the live sky (follows time of day & weather)
      this.pmrem = new THREE.PMREMGenerator(opts.renderer);
      this.envScene = new THREE.Scene();
      const d = new THREE.Mesh(this.dome.geometry, this.mat); d.scale.setScalar(50); this.envScene.add(d);
    }
    this.dome.scale.setScalar(far * 0.5);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    scene.add(this.dome);
    scene.add(this.hemi);
    this.shadowSize = shadowMap;
    this.sun.castShadow = shadowMap > 0;
    if (shadowMap > 0) {
      this.sun.shadow.mapSize.set(shadowMap, shadowMap);
      const s = opts.shadowRange ?? 70;
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

  /** dynamic weather (needs audio + seed); `auto` follows the seeded forecast */
  initWeather(audio: AudioSys, seed: number, start: Weather, maxDrops: number, auto: boolean, matchTime = 0) {
    this.wx?.dispose();
    this.wx = new WeatherSystem(this.scene, audio, seed, start as WeatherKind, maxDrops, matchTime);
    this.wx.auto = auto;
    this.mat.uniforms.moonPhase.value = 0.25 + (seed % 97) / 97 * 0.5; // waxing gibbous .. waning
  }

  /** legacy name of the current weather (clear / overcast / fog / rain) */
  get weather(): 'clear' | 'overcast' | 'fog' | 'rain' { return this.wx ? this.wx.legacy : (this.fixedWeather === 'clear' || this.fixedWeather === 'overcast' || this.fixedWeather === 'fog' || this.fixedWeather === 'rain' ? this.fixedWeather : 'overcast'); }

  setWeather(w: Weather, _scene?: THREE.Scene, instant = true) {
    this.fixedWeather = w;
    if (this.wx) this.wx.set(w as WeatherKind, instant);
  }

  get isNight() { return this.time < 5.5 || this.time > 19.5; }

  update(dt: number, focus: THREE.Vector3) {
    this.time = (this.time + dt * this.speed) % 24;
    const dayT = (this.time - 6) / 12;
    const elev = Math.sin(dayT * Math.PI) * 68;
    const azim = 120 + dayT * 120;
    const phi = THREE.MathUtils.degToRad(90 - Math.max(elev, -12));
    const theta = THREE.MathUtils.degToRad(azim);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    // the moon runs roughly opposite the sun on a slightly tilted path
    const moonElev = -elev * 0.85 + 6;
    this.moonDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - moonElev), theta + Math.PI + 0.3);
    const nightK = 1 - THREE.MathUtils.smoothstep(elev, -9, 1);
    const night = elev < -2;
    const dayK = THREE.MathUtils.smoothstep(elev, -4, 14);
    const dusk = 1 - THREE.MathUtils.smoothstep(Math.abs(elev - 5), 0, 15);
    // weather
    const wx = this.wx;
    if (wx && this.camera) wx.update(dt, this.clock, this.camera.position, this.brightness, () => { /* bolt */ });
    const p = wx?.p ?? { cover: this.fixedWeather === 'clear' ? 0.25 : this.fixedWeather === 'fog' ? 0.6 : 0.85, dark: this.fixedWeather === 'rain' ? 0.5 : 0.2, fog: this.fixedWeather === 'fog' ? 0.85 : 0.05, rain: this.fixedWeather === 'rain' ? 0.7 : 0, hail: 0, wind: 1, storm: 0 };
    const flash = wx?.flash ?? 0;
    const overcast = 1 - p.cover * 0.42 - p.dark * 0.28;
    // sky colours
    const u = this.mat.uniforms;
    const dayTop = this.c1.set(0x2a66c0), dayHor = this.c2.set(0xb9d4ea);
    const nightTop = new THREE.Color(0x020510), nightHor = new THREE.Color(0x0b1424);
    const duskHor = new THREE.Color(0xf2915a), duskTop = new THREE.Color(0x4a4a8a);
    const grey = new THREE.Color(0x8a96a2).multiplyScalar(1 - p.dark * 0.55);
    u.top.value.copy(nightTop).lerp(dayTop, dayK).lerp(duskTop, dusk * 0.35 * (1 - p.cover)).lerp(grey, THREE.MathUtils.clamp(p.cover * 1.1 - 0.2, 0, 1) * dayK);
    u.horizon.value.copy(nightHor).lerp(dayHor, dayK).lerp(duskHor, dusk * 0.62 * (1 - p.cover * 0.7)).lerp(grey.clone().multiplyScalar(1.12), THREE.MathUtils.clamp(p.cover * 1.1 - 0.2, 0, 1) * dayK);
    u.ground.value.copy(u.horizon.value).multiplyScalar(0.55);
    u.sunDir.value.copy(this.sunDir);
    u.moonDir.value.copy(this.moonDir);
    u.sunColor.value.setRGB(1, 0.92 - dusk * 0.3, 0.8 - dusk * 0.42).multiplyScalar(night ? 0.0 : overcast);
    u.night.value = nightK;
    u.time.value += dt;
    u.coverage.value = 0.22 + p.cover * 0.74;
    u.dark.value = p.dark;
    u.flash.value = flash;
    (u.cloudLit.value as THREE.Color).setRGB(1, 0.97, 0.92).multiplyScalar(night ? 0.07 + (1 - p.cover) * 0.03 : 0.35 + dayK * 0.75 * (1 - p.dark * 0.6)).lerp(new THREE.Color(1, 0.6, 0.4), dusk * 0.5 * (1 - p.dark));
    (u.cloudDark.value as THREE.Color).copy(u.cloudLit.value).multiplyScalar(0.68 - p.dark * 0.3);
    // refresh the IBL environment when the sky changed noticeably (cheap: 6 tiny renders)
    this.envT -= dt;
    const key = `${Math.round(this.time * 4)}|${Math.round(p.cover * 6)}|${Math.round(p.dark * 4)}`;
    if (this.pmrem && this.envScene && (key !== this.envKey) && this.envT <= 0) {
      this.envKey = key; this.envT = 1.5;
      const old = this.envRT;
      u.flash.value = 0;
      this.envRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 200);
      u.flash.value = flash;
      this.scene.environment = this.envRT.texture;
      (this.scene as THREE.Scene & { environmentIntensity: number }).environmentIntensity = night ? 0.22 : (0.55 + dayK * 0.35) * (1 - p.dark * 0.35);
      old?.dispose();
    }
    // lights: sun by day, moon by night (bluish, follows the phase), lightning lights the ambience
    const moonUp = THREE.MathUtils.smoothstep(this.moonDir.y, -0.02, 0.2);
    const lightDir = night ? this.moonDir : this.sunDir;
    this.sun.intensity = night ? (0.32 + 0.4 * Math.abs(Math.sin(u.moonPhase.value * Math.PI))) * moonUp * (1 - p.cover * 0.7) : (this.pmrem ? 3.3 : 2.8) * dayK * overcast;
    this.sun.color.set(night ? 0x9fb4ff : elev < 12 ? 0xffb070 : 0xfff1dc);
    this.hemi.intensity = ((night ? 0.8 : this.pmrem ? 0.2 + dayK * 0.5 : 0.35 + dayK * 0.85) * (p.cover > 0.5 ? 1.25 : 1)) + flash * 3.5;
    this.hemi.color.set(night ? 0x5a6a9a : 0xbfd8ff);
    if (flash > 0) this.hemi.color.lerp(new THREE.Color(0xdde6ff), Math.min(1, flash));
    this.hemi.groundColor.set(night ? 0x2a2a3a : 0x50603a);
    this.brightness = 0.25 + dayK * 0.75 * overcast;
    // fog = horizon colour; extend with altitude so the island is visible from the drop plane
    this.fog.color.copy(u.horizon.value);
    const alt = Math.max(0, focus.y - 40);
    const far = this.baseFar + alt * 1.6;
    if (this.atmoOn) {
      // the atmosphere pass does ground fog / mist: keep the linear fog for distant haze only
      this.fog.near = far * (0.35 - p.fog * 0.25);
      this.fog.far = far * (0.98 - p.fog * 0.45 - p.rain * 0.3);
    } else {
      this.fog.near = p.fog > 0.5 ? 15 + (1 - p.fog) * 60 : far * 0.3 * (1 - p.rain * 0.5);
      this.fog.far = p.fog > 0.5 ? 160 + (1 - p.fog) * 500 : far * (0.98 - p.rain * 0.38);
    }
    if (this.camera && Math.abs(this.camera.far - far) > 5) { this.camera.far = far; this.camera.updateProjectionMatrix(); }
    this.dome.scale.setScalar(far * 0.5);
    this.dome.position.copy(focus);
    // shadow frustum follows the focus point – texel-snapped to avoid shimmering
    const snap = this.shadowSize ? (this.sun.shadow.camera.right * 2) / this.shadowSize : 1;
    const fx = Math.round(focus.x / snap) * snap, fz = Math.round(focus.z / snap) * snap;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx + lightDir.x * 200, focus.y + Math.max(lightDir.y, 0.25) * 200, fz + lightDir.z * 200);
    // atmosphere pass inputs
    if (this.atmo) {
      const a = this.atmo;
      a.sunDir.copy(this.sunDir);
      a.sunColor.copy(u.sunColor.value).multiplyScalar(1.4);
      a.fogColor.copy(u.horizon.value).lerp(new THREE.Color(0x9aa4ae), p.fog * 0.3 * dayK);
      a.fogDensity = (0.0015 + p.fog * 0.028 + p.rain * 0.006 + nightK * 0.002) * (1 - THREE.MathUtils.smoothstep(alt, 0, 300) * 0.8);
      a.fogHeight = this.fogBase;
      a.fogFalloff = 0.055 - p.fog * 0.035;
      a.wet = wx?.wet ?? (p.rain > 0.2 ? 0.8 : 0);
      a.rain = p.rain;
      a.godrays = dayK * (1 - p.cover * 0.75) * (0.6 + p.fog * 0.8) * (1 - nightK);
      a.lightning = flash;
    }
    // raindrops on the lens: more when looking up, none in the drop plane
    if (this.camera) {
      const dir = this.camera.getWorldDirection(new THREE.Vector3());
      const want = p.rain > 0.05 ? THREE.MathUtils.clamp(p.rain * (0.45 + Math.max(0, dir.y) * 1.2), 0, 1) : 0;
      this.lens += (want - this.lens) * Math.min(1, dt * (want > this.lens ? 0.5 : 0.25));
    }
  }

  dispose() { this.wx?.dispose(); this.wx = null; }
}
