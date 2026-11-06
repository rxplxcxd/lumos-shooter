import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { settings, QUALITY_PRESETS } from './Settings';

export type PostMode = 'none' | 'nvg' | 'thermal' | 'underwater';

/** final grading / effect pass – runs on the linear HDR buffer before tone mapping */
const GRADE_FRAG = /* glsl */ `
uniform sampler2D tDiffuse; uniform float time; uniform int mode; uniform float damage; uniform float flash; uniform float grade; uniform vec2 res;
varying vec2 vUv;
float rand(vec2 c){ return fract(sin(dot(c, vec2(12.9898,78.233))) * 43758.5453); }
void main(){
  vec2 uv = vUv;
  if (mode == 3) { uv.x += sin(uv.y * 30.0 + time * 2.0) * 0.003; uv.y += cos(uv.x * 25.0 + time * 1.7) * 0.003; }
  vec2 dc = uv - 0.5;
  float d = length(dc);
  // subtle chromatic aberration towards the edges
  float ca = grade * 0.0018 * d * d * 4.0;
  vec3 c = vec3(texture2D(tDiffuse, uv + dc * ca).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - dc * ca).b);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  if (mode == 1) {
    float n = rand(uv * time) * 0.15;
    l = pow(clamp(l * 3.2 + n, 0.0, 1.0), 0.8);
    c = vec3(0.12, 1.0, 0.25) * l * (0.92 + 0.08 * sin(uv.y * 800.0));
  } else if (mode == 2) {
    float t = clamp(l * 1.4, 0.0, 1.0);
    c = mix(vec3(0.02, 0.02, 0.18), vec3(0.6, 0.0, 0.6), smoothstep(0.0, 0.35, t));
    c = mix(c, vec3(1.0, 0.45, 0.0), smoothstep(0.35, 0.7, t));
    c = mix(c, vec3(1.0, 1.0, 0.85), smoothstep(0.7, 1.0, t));
  } else if (mode == 3) {
    c = mix(c, vec3(0.0, 0.25, 0.35), 0.45) * vec3(0.6, 0.9, 1.0);
  } else if (grade > 0.0) {
    // filmic grade: gentle saturation, warm highlights, cool shadows
    c = mix(vec3(l), c, 1.0 + 0.12 * grade);
    c *= mix(vec3(0.96, 0.98, 1.04), vec3(1.04, 1.0, 0.95), smoothstep(0.0, 1.2, l));
  }
  if (mode == 1 || mode == 2) c *= smoothstep(0.75, 0.35, d);
  else c *= mix(1.0, smoothstep(0.95, 0.35, d), 0.35 * grade);
  c = mix(c, vec3(0.6, 0.0, 0.0), damage * smoothstep(0.25, 0.75, d));
  c += vec3(flash);
  c += (rand(uv * res + time) - 0.5) * 0.018 * grade;
  gl_FragColor = vec4(c, 1.0);
}`;

/** legacy single-pass post for low-spec (includes tone mapping) */
const POST_FRAG = GRADE_FRAG.replace('gl_FragColor = vec4(c, 1.0);\n}', 'gl_FragColor = vec4(c, 1.0);\n  #include <tonemapping_fragment>\n  #include <colorspace_fragment>\n}');

/**
 * Renderer / loop owner.
 *  - Fixed-step simulation callback (60 Hz) + variable render callback
 *  - Dynamic Resolution Scaling (3D render scale follows the frame-rate, DOM UI stays crisp)
 *  - Medium+: EffectComposer (MSAA HDR buffer, optional GTAO, bloom, filmic grade, NVG/thermal)
 *  - Low/Potato: single cheap post pass only when an effect is active
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly timer = new THREE.Timer();
  /** first-person view-model layer (rendered after the world with a cleared depth buffer) */
  readonly overlay = new THREE.Scene();
  readonly overlayCam = new THREE.PerspectiveCamera(58, 1, 0.01, 20);
  drsScale = 1;
  fps = 60;
  frameMs = 16;
  postMode: PostMode = 'none';
  damageVignette = 0;
  flash = 0;
  stats = { calls: 0, tris: 0 };
  private rt: THREE.WebGLRenderTarget | null = null;
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private postMat: THREE.ShaderMaterial;
  private composer: EffectComposer | null = null;
  private gradePass: ShaderPass | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private updateFns: ((dt: number, t: number) => void)[] = [];
  private fixedFns: ((dt: number) => void)[] = [];
  private acc = 0;
  private running = false;
  private drsTimer = 0;
  private emaMs = 16.6;
  readonly fixedDt = 1 / 60;
  paused = false;
  timeScale = 1;
  composerEnabled = false;

  constructor(canvasParent: HTMLElement) {
    const q = QUALITY_PRESETS[settings.data.quality];
    this.renderer = new THREE.WebGLRenderer({ antialias: q.antialias && !q.post, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = q.shadows > 0;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.id = 'game-canvas';
    canvasParent.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(settings.data.fov, innerWidth / innerHeight, 0.05, q.far);
    this.postMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, time: { value: 0 }, mode: { value: 0 }, damage: { value: 0 }, flash: { value: 0 }, grade: { value: 0 }, res: { value: new THREE.Vector2(1, 1) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: POST_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMat));
    this.timer.connect(document);
    this.applyQuality();
    addEventListener('resize', () => this.resize());
    settings.onChange(() => { this.camera.fov = settings.data.fov; this.applyQuality(); });
  }

  applyQuality() {
    const q = QUALITY_PRESETS[settings.data.quality];
    this.renderer.shadowMap.enabled = q.shadows > 0;
    this.camera.far = q.far;
    this.camera.updateProjectionMatrix();
    this.setupComposer(q.post);
    this.resize();
  }

  private setupComposer(on: boolean) {
    const q = QUALITY_PRESETS[settings.data.quality];
    this.composer?.dispose();
    this.composer = null; this.gradePass = null; this.bloomPass = null;
    this.composerEnabled = on;
    if (!on) return;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), { type: THREE.HalfFloatType, samples: q.msaa });
    const c = new EffectComposer(this.renderer, rt);
    c.addPass(new RenderPass(this.scene, this.camera));
    if (q.ao) {
      const ao = new GTAOPass(this.scene, this.camera, size.x, size.y);
      ao.blendIntensity = 0.75;
      c.addPass(ao);
    }
    const ov = new RenderPass(this.overlay, this.overlayCam);
    ov.clear = false; ov.clearDepth = true;
    c.addPass(ov);
    if (q.bloom > 0) {
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), q.bloom, 0.55, 0.92);
      c.addPass(this.bloomPass);
    }
    this.gradePass = new ShaderPass(new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, time: { value: 0 }, mode: { value: 0 }, damage: { value: 0 }, flash: { value: 0 }, grade: { value: 1 }, res: { value: new THREE.Vector2(size.x, size.y) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: GRADE_FRAG,
    }));
    c.addPass(this.gradePass);
    c.addPass(new OutputPass());
    this.composer = c;
  }

  get basePixelRatio() {
    return Math.min(devicePixelRatio || 1, 2) * QUALITY_PRESETS[settings.data.quality].pixelRatio;
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    const pr = this.basePixelRatio * this.drsScale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.overlayCam.aspect = w / h;
    this.overlayCam.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(pr);
      this.composer.setSize(w, h);
      (this.gradePass!.uniforms.res.value as THREE.Vector2).set(w * pr, h * pr);
    }
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
    this.renderer.setAnimationLoop((t) => this.tick(t));
  }

  stop() { this.running = false; this.renderer.setAnimationLoop(null); }

  private tick(timestamp: number) {
    this.timer.update(timestamp);
    const rawDt = Math.min(this.timer.getDelta(), 0.1);
    this.emaMs = this.emaMs * 0.92 + rawDt * 1000 * 0.08;
    this.fps = 1000 / Math.max(this.emaMs, 1);
    this.frameMs = this.emaMs;
    const dt = this.paused ? 0 : rawDt * this.timeScale;
    const t = this.timer.getElapsed();
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
    const modeId = { none: 0, nvg: 1, thermal: 2, underwater: 3 }[this.postMode];
    if (this.composer && this.gradePass) {
      const u = this.gradePass.uniforms;
      u.time.value = t; u.mode.value = modeId; u.damage.value = this.damageVignette; u.flash.value = this.flash;
      if (this.bloomPass) this.bloomPass.strength = QUALITY_PRESETS[settings.data.quality].bloom * (modeId === 1 ? 0.3 : 1);
      this.composer.render();
      this.stats.calls = this.renderer.info.render.calls; this.stats.tris = this.renderer.info.render.triangles;
      return;
    }
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
    u.time.value = t; u.mode.value = modeId; u.damage.value = this.damageVignette; u.flash.value = this.flash;
    this.renderer.render(this.postScene, this.postCam);
  }

  /** Compile every material up-front (async where KHR_parallel_shader_compile exists) so the first fight does not hitch. */
  async warmup() {
    try {
      const r = this.renderer as THREE.WebGLRenderer & { compileAsync?: (s: THREE.Object3D, c: THREE.Camera) => Promise<unknown> };
      if (r.compileAsync) await r.compileAsync(this.scene, this.camera);
      else this.renderer.compile(this.scene, this.camera);
      this.renderer.compile(this.overlay, this.overlayCam);
    } catch { /* older drivers */ }
  }
}
