import * as THREE from 'three';
import { settings, QUALITY_PRESETS } from './Settings';

export type PostMode = 'none' | 'nvg' | 'thermal' | 'underwater';

const POST_FRAG = /* glsl */ `
uniform sampler2D tDiffuse; uniform float time; uniform int mode; uniform float damage; uniform float flash;
varying vec2 vUv;
float rand(vec2 c){ return fract(sin(dot(c, vec2(12.9898,78.233))) * 43758.5453); }
void main(){
  vec2 uv = vUv;
  if (mode == 3) { uv.x += sin(uv.y * 30.0 + time * 2.0) * 0.003; uv.y += cos(uv.x * 25.0 + time * 1.7) * 0.003; }
  vec3 c = texture2D(tDiffuse, uv).rgb;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  if (mode == 1) { // night vision: amplified luminance, green phosphor, noise, vignette
    float n = rand(uv * time) * 0.15;
    l = pow(clamp(l * 3.2 + n, 0.0, 1.0), 0.8);
    c = vec3(0.12, 1.0, 0.25) * l;
    float scan = 0.92 + 0.08 * sin(uv.y * 800.0);
    c *= scan;
  } else if (mode == 2) { // thermal: luminance remapped to iron-bow palette (warm = emissive)
    float t = clamp(l * 1.4, 0.0, 1.0);
    c = mix(vec3(0.02, 0.02, 0.18), vec3(0.6, 0.0, 0.6), smoothstep(0.0, 0.35, t));
    c = mix(c, vec3(1.0, 0.45, 0.0), smoothstep(0.35, 0.7, t));
    c = mix(c, vec3(1.0, 1.0, 0.85), smoothstep(0.7, 1.0, t));
  } else if (mode == 3) {
    c = mix(c, vec3(0.0, 0.25, 0.35), 0.45) * vec3(0.6, 0.9, 1.0);
  }
  float d = distance(vUv, vec2(0.5));
  if (mode == 1 || mode == 2) c *= smoothstep(0.75, 0.35, d);
  c = mix(c, vec3(0.6, 0.0, 0.0), damage * smoothstep(0.25, 0.75, d));
  c += vec3(flash);
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * Renderer / loop owner.
 *  - Fixed-step simulation callback (60 Hz) + variable render callback
 *  - Dynamic Resolution Scaling: lowers the internal 3D render scale when the frame
 *    rate drops below target (UI is DOM and therefore always native resolution)
 *  - Lightweight post pass for NVG / thermal / underwater / damage vignette
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly clock = new THREE.Clock();
  /** first-person view-model layer (rendered after the world with a cleared depth buffer) */
  readonly overlay = new THREE.Scene();
  readonly overlayCam = new THREE.PerspectiveCamera(58, 1, 0.01, 20);
  drsScale = 1;
  fps = 60;
  frameMs = 16;
  postMode: PostMode = 'none';
  damageVignette = 0;
  flash = 0;
  private rt: THREE.WebGLRenderTarget | null = null;
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private postMat: THREE.ShaderMaterial;
  private updateFns: ((dt: number, t: number) => void)[] = [];
  private fixedFns: ((dt: number) => void)[] = [];
  private acc = 0;
  private running = false;
  private drsTimer = 0;
  private emaMs = 16.6;
  readonly fixedDt = 1 / 60;
  paused = false;
  timeScale = 1;
  stats = { calls: 0, tris: 0 };

  constructor(canvasParent: HTMLElement) {
    const q = QUALITY_PRESETS[settings.data.quality];
    this.renderer = new THREE.WebGLRenderer({ antialias: q.antialias, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = q.shadows > 0;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.id = 'game-canvas';
    canvasParent.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(settings.data.fov, innerWidth / innerHeight, 0.05, q.far);
    this.postMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, time: { value: 0 }, mode: { value: 0 }, damage: { value: 0 }, flash: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: POST_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMat));
    this.applyQuality();
    addEventListener('resize', () => this.resize());
    settings.onChange(() => { this.camera.fov = settings.data.fov; this.applyQuality(); });
  }

  applyQuality() {
    const q = QUALITY_PRESETS[settings.data.quality];
    this.renderer.shadowMap.enabled = q.shadows > 0;
    this.camera.far = q.far;
    this.camera.updateProjectionMatrix();
    this.resize();
  }

  get basePixelRatio() {
    return Math.min(devicePixelRatio || 1, 2) * QUALITY_PRESETS[settings.data.quality].pixelRatio;
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setPixelRatio(this.basePixelRatio * this.drsScale);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.overlayCam.aspect = w / h;
    this.overlayCam.updateProjectionMatrix();
    if (this.rt) {
      const s = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.rt.setSize(s.x, s.y);
    }
  }

  onUpdate(fn: (dt: number, t: number) => void) { this.updateFns.push(fn); return () => { this.updateFns = this.updateFns.filter((f) => f !== fn); }; }
  onFixed(fn: (dt: number) => void) { this.fixedFns.push(fn); return () => { this.fixedFns = this.fixedFns.filter((f) => f !== fn); }; }
  clearCallbacks() { this.updateFns = []; this.fixedFns = []; }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  stop() { this.running = false; this.renderer.setAnimationLoop(null); }

  private tick() {
    const rawDt = Math.min(this.clock.getDelta(), 0.1);
    this.emaMs = this.emaMs * 0.92 + rawDt * 1000 * 0.08;
    this.fps = 1000 / this.emaMs;
    this.frameMs = this.emaMs;
    const dt = this.paused ? 0 : rawDt * this.timeScale;
    const t = this.clock.elapsedTime;
    if (!this.paused) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= this.fixedDt && steps < 4) {
        for (const f of this.fixedFns) f(this.fixedDt);
        this.acc -= this.fixedDt;
        steps++;
      }
      if (steps === 4) this.acc = 0;
    }
    for (const f of this.updateFns) f(dt, t);
    this.updateDRS(rawDt);
    this.render(t);
  }

  private updateDRS(dt: number) {
    if (!settings.data.autoQuality) { if (this.drsScale !== 1) { this.drsScale = 1; this.resize(); } return; }
    this.drsTimer += dt;
    if (this.drsTimer < 0.5) return;
    this.drsTimer = 0;
    const target = settings.data.targetFps;
    const { drsMin, drsMax } = settings.data;
    let s = this.drsScale;
    if (this.fps < target * 0.75) s -= 0.08;
    else if (this.fps < target * 0.9) s -= 0.03;
    else if (this.fps > target * 0.97) s += 0.02;
    s = THREE.MathUtils.clamp(s, drsMin, drsMax);
    if (Math.abs(s - this.drsScale) > 0.005) { this.drsScale = s; this.resize(); }
  }

  setPost(mode: PostMode) { this.postMode = mode; }

  private renderOverlay() {
    if (!this.overlay.children.length || !this.overlay.visible) return;
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.overlay, this.overlayCam);
    this.renderer.autoClear = true;
  }

  private render(t: number) {
    const needPost = this.postMode !== 'none' || this.damageVignette > 0.01 || this.flash > 0.01;
    if (!needPost) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      this.stats.calls = this.renderer.info.render.calls; this.stats.tris = this.renderer.info.render.triangles;
      this.renderOverlay();
      return;
    }
    if (!this.rt) {
      const s = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.rt = new THREE.WebGLRenderTarget(s.x, s.y, { type: THREE.HalfFloatType });
    }
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.camera);
    this.renderOverlay();
    this.renderer.setRenderTarget(null);
    const u = this.postMat.uniforms;
    u.tDiffuse.value = this.rt.texture;
    u.time.value = t;
    u.mode.value = { none: 0, nvg: 1, thermal: 2, underwater: 3 }[this.postMode];
    u.damage.value = this.damageVignette;
    u.flash.value = this.flash;
    this.renderer.render(this.postScene, this.postCam);
  }

  /** Compile every material once so the first gunfight does not hitch (shader warm-up). */
  warmup() {
    try { this.renderer.compile(this.scene, this.camera); } catch { /* older drivers */ }
  }
}
