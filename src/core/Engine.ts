import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { AtmospherePass, type AtmoState } from '../fx/AtmospherePass';
import { settings, QUALITY_PRESETS } from './Settings';

export type PostMode = 'none' | 'nvg' | 'thermal' | 'underwater';

/** final grading / effect pass – runs on the linear HDR buffer before tone mapping */
const GRADE_FRAG = /* glsl */ `
uniform sampler2D tDiffuse; uniform float time; uniform int mode; uniform float damage; uniform float flash; uniform float grade; uniform vec2 res; uniform int look; uniform float rainLens;
varying vec2 vUv;
float rand(vec2 c){ return fract(sin(dot(c, vec2(12.9898,78.233))) * 43758.5453); }
// rain on the lens / visor: drops that fade in, some slide down leaving a trail, all refract the image
vec2 lensDrops(vec2 uv, float t, float amt){
  vec2 off = vec2(0.0);
  float aspect = res.x / max(res.y, 1.0);
  for (int l = 0; l < 3; l++) {
    float sc = l == 0 ? 5.0 : l == 1 ? 9.0 : 16.0;
    vec2 st = vec2(uv.x * aspect, uv.y) * sc + float(l) * 3.7;
    vec2 id = floor(st); vec2 f = fract(st) - 0.5;
    float r = rand(id + float(l) * 11.0);
    if (r > amt * 0.85 + 0.08) continue;
    float spd = 0.05 + rand(id + 2.0) * 0.12;
    float life = fract(t * spd + r * 13.0);
    float slide = step(0.55, rand(id + 5.0)) * (l == 0 ? 1.0 : 0.4);
    vec2 c = vec2((rand(id + 3.1) - 0.5) * 0.55, 0.3 - life * 0.75 * slide);
    float rad = (0.1 + r * 0.12) * (l == 2 ? 0.7 : 1.0);
    vec2 dd = f - c;
    dd.y *= 1.0 + slide * 0.6;
    float m = smoothstep(rad, rad * 0.45, length(dd)) * smoothstep(0.0, 0.08, life) * (1.0 - smoothstep(0.8, 1.0, life));
    // trail left behind a sliding drop
    float trail = slide * smoothstep(0.05, 0.0, abs(f.x - c.x)) * step(c.y, f.y) * smoothstep(0.45, 0.0, f.y - c.y) * 0.35;
    off += (dd * m * 0.9 + vec2(0.0, trail * 0.02)) / sc;
  }
  return off;
}
void main(){
  vec2 uv = vUv;
  if (rainLens > 0.001) uv += lensDrops(vUv, time, rainLens);
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
    // cold world, hot bodies (characters get an emissive boost while the optic is active)
    float t = clamp(pow(clamp(l, 0.0, 1.6), 1.7) * 1.05, 0.0, 1.0);
    c = mix(vec3(0.02, 0.02, 0.18), vec3(0.6, 0.0, 0.6), smoothstep(0.0, 0.35, t));
    c = mix(c, vec3(1.0, 0.45, 0.0), smoothstep(0.35, 0.7, t));
    c = mix(c, vec3(1.0, 1.0, 0.85), smoothstep(0.7, 1.0, t));
  } else if (mode == 3) {
    c = mix(c, vec3(0.0, 0.25, 0.35), 0.45) * vec3(0.6, 0.9, 1.0);
  } else if (grade > 0.0) {
    // filmic grade: contrast around mid-grey, gentle saturation, warm highlights, cool shadows
    c = 0.18 * pow(max(c, vec3(0.0)) / 0.18, vec3(1.0 + 0.09 * grade));
    l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, 1.0 + 0.16 * grade);
    c *= mix(vec3(0.96, 0.98, 1.04), vec3(1.04, 1.0, 0.95), smoothstep(0.0, 1.2, l));
  }
  // photo-mode looks
  if (look == 1) { // cinematic: teal shadows / orange highlights, stronger vignette
    float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(c * vec3(0.86, 1.0, 1.08), c * vec3(1.12, 1.0, 0.84), smoothstep(0.05, 0.6, L));
    c *= mix(1.0, smoothstep(0.85, 0.25, d), 0.55);
  } else if (look == 2) { // noir
    float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = vec3(smoothstep(0.02, 0.85, pow(L, 0.9)));
    c += (rand(uv * res + time) - 0.5) * 0.05;
    c *= mix(1.0, smoothstep(0.9, 0.3, d), 0.6);
  } else if (look == 3) { // vivid
    float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(L), c, 1.38);
    c = 0.18 * pow(max(c, vec3(0.0)) / 0.18, vec3(1.08));
  } else if (look == 5) { // killcam replay: cool, partly desaturated, grainy, heavy vignette
    float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(L), c, 0.55) * vec3(0.92, 0.98, 1.08);
    c = 0.18 * pow(max(c, vec3(0.0)) / 0.18, vec3(1.08));
    c += (rand(uv * res + time) - 0.5) * 0.06;
    c *= mix(1.0, smoothstep(0.85, 0.2, d), 0.7);
  } else if (look == 4) { // vintage: warm, faded blacks, soft
    float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(L), c, 0.7) * vec3(1.1, 1.0, 0.82) + vec3(0.025, 0.02, 0.01);
    c *= mix(1.0, smoothstep(0.95, 0.3, d), 0.5);
    c += (rand(uv * res + time) - 0.5) * 0.03;
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
  private atmoPass: AtmospherePass | null = null;
  /** written every frame by the sky / weather systems, read by the atmosphere pass */
  readonly atmo: AtmoState = { sunDir: new THREE.Vector3(0, 1, 0), sunColor: new THREE.Color(1, 1, 1), fogColor: new THREE.Color(0.7, 0.8, 0.9), fogDensity: 0, fogHeight: 0, fogFalloff: 0.05, wet: 0, rain: 0, godrays: 0, lightning: 0 };
  /** 0..1 raindrops on the lens / visor */
  rainLens = 0;
  get hasAtmosphere() { return !!this.atmoPass; }
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
      uniforms: { tDiffuse: { value: null }, time: { value: 0 }, mode: { value: 0 }, damage: { value: 0 }, flash: { value: 0 }, grade: { value: 0 }, res: { value: new THREE.Vector2(1, 1) }, look: { value: 0 }, rainLens: { value: 0 } },
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
    this.composer = null; this.gradePass = null; this.bloomPass = null; this.atmoPass?.dispose(); this.atmoPass = null;
    this.composerEnabled = on;
    if (!on) return;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), { type: THREE.HalfFloatType, samples: q.msaa });
    if (q.atmo) rt.depthTexture = new THREE.DepthTexture(Math.max(1, size.x), Math.max(1, size.y));
    const c = new EffectComposer(this.renderer, rt);
    c.addPass(new RenderPass(this.scene, this.camera));
    // remember which buffer holds the scene depth (GTAO swaps buffers before the atmosphere pass)
    const atmo = q.atmo ? new AtmospherePass(this.camera, this.atmo, { ssr: q.ssr, godrays: q.godrays }) : null;
    if (atmo) {
      const grab = new Pass(); grab.needsSwap = false;
      grab.render = (_r: THREE.WebGLRenderer, _w: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget) => { atmo.depth = read.depthTexture; };
      c.addPass(grab);
    }
    if (q.ao) {
      const ao = new GTAOPass(this.scene, this.camera, size.x, size.y);
      ao.blendIntensity = 0.75;
      c.addPass(ao);
    }
    if (atmo) { c.addPass(atmo); this.atmoPass = atmo; }
    const ov = new RenderPass(this.overlay, this.overlayCam);
    ov.clear = false; ov.clearDepth = true;
    c.addPass(ov);
    if (q.bloom > 0) {
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), q.bloom, 0.55, 0.92);
      c.addPass(this.bloomPass);
    }
    this.gradePass = new ShaderPass(new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, time: { value: 0 }, mode: { value: 0 }, damage: { value: 0 }, flash: { value: 0 }, grade: { value: 1 }, res: { value: new THREE.Vector2(size.x, size.y) }, look: { value: 0 }, rainLens: { value: 0 } },
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
      u.time.value = t; u.mode.value = modeId; u.damage.value = this.damageVignette; u.flash.value = this.flash; u.look.value = this.look; u.rainLens.value = this.rainLens;
      if (this.bloomPass) this.bloomPass.strength = QUALITY_PRESETS[settings.data.quality].bloom * (modeId === 1 ? 0.3 : 1);
      // count every pass of the frame, not just the last full-screen quad
      this.renderer.info.autoReset = false;
      this.renderer.info.reset();
      this.composer.render();
      this.stats.calls = this.renderer.info.render.calls; this.stats.tris = this.renderer.info.render.triangles;
      return;
    }
    this.renderer.info.autoReset = true;
    const needPost = this.postMode !== 'none' || this.damageVignette > 0.01 || this.flash > 0.01 || this.look > 0 || this.rainLens > 0.01;
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
    u.time.value = t; u.mode.value = modeId; u.damage.value = this.damageVignette; u.flash.value = this.flash; u.look.value = this.look; u.rainLens.value = this.rainLens;
    this.renderer.render(this.postScene, this.postCam);
  }

  /** photo mode: 0 none, 1 cinematic, 2 noir, 3 vivid, 4 vintage, 5 replay (killcam) */
  look = 0;
  /** render one frame right now and grab it as PNG (same task, so the drawing buffer is still intact) */
  capture(): string {
    this.render(performance.now() / 1000);
    return this.renderer.domElement.toDataURL('image/png');
  }

  /**
   * Compile every material of the world and of the view-model overlay (in parallel where
   * KHR_parallel_shader_compile exists), then render one frame while the loading screen still
   * covers the canvas, so the fullscreen passes and the draw-time pipeline state are built too.
   * Without this the first visible frames stall on shader compilation.
   */
  async warmup() {
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
      await this.renderer.compileAsync(this.overlay, this.overlayCam);
      this.render(0);
    } catch { /* older drivers */ }
  }
}
