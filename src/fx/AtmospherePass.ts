import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/** per-frame atmosphere inputs written by the sky / weather systems */
export interface AtmoState {
  sunDir: THREE.Vector3; sunColor: THREE.Color; fogColor: THREE.Color;
  fogDensity: number; fogHeight: number; fogFalloff: number;
  wet: number; rain: number; godrays: number; lightning: number;
}

const VS = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FS = /* glsl */ `
#include <packing>
uniform sampler2D tDiffuse; uniform sampler2D tDepth;
uniform float cameraNear; uniform float cameraFar;
uniform mat4 projInv; uniform mat4 viewInv; uniform mat4 viewProj; uniform vec3 camPos;
uniform vec3 sunDir; uniform vec3 sunColor; uniform vec2 sunUv; uniform float sunVis;
uniform vec3 fogColor; uniform float fogDensity; uniform float fogHeight; uniform float fogFalloff;
uniform float wet; uniform float rain; uniform float time; uniform float godrays; uniform float lightning;
uniform vec2 res;
varying vec2 vUv;

float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }

vec3 worldAt(vec2 uv, float d){
  vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = projInv * ndc; v /= v.w;
  return (viewInv * v).xyz;
}
float viewDist(float d){ return -perspectiveDepthToViewZ(d, cameraNear, cameraFar); }

// expanding rain-drop rings on puddles
vec2 ripples(vec2 p, float t){
  vec2 acc = vec2(0.0);
  for (int k = 0; k < 2; k++) {
    vec2 q = p * (k == 0 ? 1.6 : 2.7) + float(k) * 7.3;
    vec2 id = floor(q), f = fract(q) - 0.5;
    float r = h21(id);
    float ph = fract(t * (0.9 + r) + r * 9.0);
    vec2 c = vec2(h21(id + 1.3), h21(id + 4.1)) - 0.5;
    vec2 d = f - c * 0.5;
    float len = length(d);
    float ring = sin((len - ph * 0.55) * 40.0) * smoothstep(0.0, 0.08, ph) * (1.0 - ph) * smoothstep(0.55, 0.0, abs(len - ph * 0.55) * 6.0);
    acc += d / max(len, 1e-3) * ring;
  }
  return acc * 0.045;
}

void main(){
  vec3 col = texture2D(tDiffuse, vUv).rgb;
  float d = texture2D(tDepth, vUv).r;
  bool sky = d >= 0.99999;
  vec3 wp = sky ? camPos + normalize(worldAt(vUv, 0.5) - camPos) * cameraFar : worldAt(vUv, d);
  vec3 rd = wp - camPos;
  float dist = length(rd);
  vec3 V = rd / max(dist, 1e-4);

  // ---------------------------------------------------------- wet ground: screen-space reflections
  #if SSR_STEPS > 0
  if (wet > 0.01 && !sky) {
    vec3 N = normalize(cross(dFdx(wp), dFdy(wp)));
    if (N.y < 0.0) N = -N;
    float up = smoothstep(0.88, 0.97, N.y);
    float sat = max(col.r, max(col.g, col.b)) - min(col.r, min(col.g, col.b));
    float lum = dot(col, vec3(0.3333));
    float grey = 1.0 - smoothstep(0.05, 0.22, sat / max(lum, 0.02) * 0.5);
    float puddle = smoothstep(0.46, 0.66, vnoise(wp.xz * 0.11) * 0.75 + vnoise(wp.xz * 0.47) * 0.35);
    float k = wet * up * grey * mix(0.2, 1.0, puddle) * smoothstep(110.0, 25.0, dist);
    if (k > 0.01) {
      vec2 rp = rain > 0.01 ? ripples(wp.xz, time) * rain * puddle : vec2(0.0);
      vec3 Np = normalize(vec3(rp.x, 1.0, rp.y));
      vec3 R = reflect(V, Np);
      vec3 p = wp + Np * 0.04;
      vec3 prev = p;
      float stepLen = (0.3 + dist * 0.016) * (0.75 + h21(vUv * res + time) * 0.5);
      vec2 hit = vec2(-1.0);
      for (int i = 0; i < SSR_STEPS; i++) {
        prev = p;
        p += R * stepLen; stepLen *= 1.3;
        vec4 clip = viewProj * vec4(p, 1.0);
        if (clip.w <= 0.0) break;
        vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
        if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;
        float sceneD = viewDist(texture2D(tDepth, suv).r);
        float rayD = clip.w;
        if (rayD > sceneD + 0.05 && rayD - sceneD < 0.6 + stepLen * 1.2) {
          // binary refinement between the last two samples
          vec3 a = prev, b = p;
          for (int j = 0; j < 4; j++) {
            vec3 m = (a + b) * 0.5;
            vec4 cm = viewProj * vec4(m, 1.0);
            vec2 mu = cm.xy / cm.w * 0.5 + 0.5;
            if (cm.w > viewDist(texture2D(tDepth, mu).r)) b = m; else a = m;
          }
          vec4 cb = viewProj * vec4(b, 1.0);
          hit = cb.xy / cb.w * 0.5 + 0.5;
          break;
        }
      }
      vec3 refl;
      float edge = 1.0;
      if (hit.x >= 0.0) {
        // wet asphalt is rough: blur the reflection except in standing water
        float br = (1.0 - puddle * 0.85) * 0.006;
        refl = texture2D(tDiffuse, hit).rgb * 0.36
          + (texture2D(tDiffuse, hit + vec2(br, 0.0)).rgb + texture2D(tDiffuse, hit - vec2(br, 0.0)).rgb) * 0.16
          + (texture2D(tDiffuse, hit + vec2(0.0, br * 2.0)).rgb + texture2D(tDiffuse, hit - vec2(0.0, br * 2.0)).rgb) * 0.16;
        refl *= mix(0.55, 0.95, puddle);
        vec2 e = min(hit, 1.0 - hit);
        edge = smoothstep(0.0, 0.08, min(e.x, e.y));
        refl = mix(fogColor, refl, edge);
      } else refl = fogColor * 0.9 + sunColor * pow(max(dot(R, sunDir), 0.0), 64.0) * 2.0;
      float fres = 0.08 + 0.92 * pow(1.0 - max(dot(-V, Np), 0.0), 4.0);
      // wet surfaces get darker (water fills the pores), puddles mirror the world
      col *= 1.0 - wet * up * grey * 0.32;
      col = mix(col, refl, clamp(k * mix(0.35, 1.0, fres) * mix(0.55, 1.0, puddle), 0.0, 0.92));
    }
  }
  #endif

  // ---------------------------------------------------------- exponential height fog with sun in-scattering
  // (rd is not normalised: kf is the density falloff over the whole ray; both exponents are clamped
  // so a camera far above the fog never produces inf * 0)
  float e1 = clamp(-fogFalloff * (camPos.y - fogHeight), -80.0, 30.0);
  float kf = fogFalloff * rd.y;
  float integ = abs(kf) > 1e-4 ? fogDensity * (exp(e1) - exp(clamp(e1 - kf, -80.0, 30.0))) / kf : fogDensity * exp(e1);
  float fog = 1.0 - exp(-integ * min(dist, cameraFar));
  float mie = pow(max(dot(V, sunDir), 0.0), 7.0);
  vec3 fogCol = fogColor * (1.0 + lightning * 2.5) + sunColor * mie * 0.85;
  col = mix(col, fogCol, clamp(fog, 0.0, sky ? 0.65 : 0.97));

  // ---------------------------------------------------------- godrays: march towards the sun on the depth buffer
  #if GR_SAMPLES > 0
  if (godrays > 0.001 && sunVis > 0.001) {
    vec2 toSun = sunUv - vUv;
    vec2 stepv = toSun / float(GR_SAMPLES);
    vec2 sp = vUv + stepv * h21(vUv * res + fract(time));
    float acc = 0.0, decay = 1.0, wsum = 0.0;
    for (int i = 0; i < GR_SAMPLES; i++) {
      sp += stepv;
      float od = texture2D(tDepth, clamp(sp, 0.001, 0.999)).r;
      acc += step(0.99999, od) * decay;
      wsum += decay;
      decay *= 0.955;
    }
    acc /= wsum;
    float radial = exp(-length(toSun * vec2(res.x / res.y, 1.0)) * 1.35);
    float occluded = sky ? 0.35 : 1.0; // shafts are most visible in front of geometry
    col += sunColor * acc * radial * godrays * sunVis * occluded * 0.95;
  }
  #endif

  // lightning lights the whole scene for a few frames
  col += col * lightning * vec3(0.9, 0.95, 1.2) * 1.6;
  gl_FragColor = vec4(col, 1.0);
}`;

/**
 * Atmosphere post pass (medium+): renders after the scene pass, reads colour + depth and adds
 *  - screen-space reflections on wet, upward facing, grey surfaces (roads, sidewalks, roofs) with
 *    a world-space puddle mask and animated rain ripples,
 *  - exponential height fog with a Mie-like sun in-scattering lobe (morning ground fog, rain mist),
 *  - godrays: the sun is ray-marched against the depth buffer so shafts break through buildings,
 *    trees and clouds of debris,
 *  - a lightning flash that lights the whole frame.
 */
export class AtmospherePass extends Pass {
  private quad: FullScreenQuad;
  mat: THREE.ShaderMaterial;
  depth: THREE.DepthTexture | null = null;
  constructor(private camera: THREE.PerspectiveCamera, public state: AtmoState, opts: { ssr: number; godrays: number }) {
    super();
    this.mat = new THREE.ShaderMaterial({
      defines: { SSR_STEPS: opts.ssr, GR_SAMPLES: opts.godrays },
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: null }, cameraNear: { value: 0.1 }, cameraFar: { value: 1000 },
        projInv: { value: new THREE.Matrix4() }, viewInv: { value: new THREE.Matrix4() }, viewProj: { value: new THREE.Matrix4() }, camPos: { value: new THREE.Vector3() },
        sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Color() }, sunUv: { value: new THREE.Vector2(0.5, 0.5) }, sunVis: { value: 0 },
        fogColor: { value: new THREE.Color() }, fogDensity: { value: 0 }, fogHeight: { value: 0 }, fogFalloff: { value: 0.05 },
        wet: { value: 0 }, rain: { value: 0 }, time: { value: 0 }, godrays: { value: 0 }, lightning: { value: 0 }, res: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: VS, fragmentShader: FS, depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);
  }

  private tmp = new THREE.Vector3();
  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const u = this.mat.uniforms, cam = this.camera, s = this.state;
    u.tDiffuse.value = readBuffer.texture;
    u.tDepth.value = this.depth ?? readBuffer.depthTexture;
    u.cameraNear.value = cam.near; u.cameraFar.value = cam.far;
    u.projInv.value.copy(cam.projectionMatrixInverse);
    u.viewInv.value.copy(cam.matrixWorld);
    u.viewProj.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    u.camPos.value.setFromMatrixPosition(cam.matrixWorld);
    u.sunDir.value.copy(s.sunDir).normalize();
    u.sunColor.value.copy(s.sunColor);
    u.fogColor.value.copy(s.fogColor);
    u.fogDensity.value = s.fogDensity; u.fogHeight.value = s.fogHeight; u.fogFalloff.value = s.fogFalloff;
    u.wet.value = s.wet; u.rain.value = s.rain; u.godrays.value = s.godrays; u.lightning.value = s.lightning;
    u.time.value = performance.now() / 1000;
    u.res.value.set(readBuffer.width, readBuffer.height);
    // sun position on screen + visibility (above the horizon and in front of the camera)
    const sp = this.tmp.copy(u.camPos.value).addScaledVector(s.sunDir, 1000).project(cam);
    const front = s.sunDir.dot(cam.getWorldDirection(new THREE.Vector3()));
    u.sunUv.value.set(sp.x * 0.5 + 0.5, sp.y * 0.5 + 0.5);
    const onScreen = 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(sp.x), Math.abs(sp.y)), 1.0, 1.8);
    u.sunVis.value = THREE.MathUtils.smoothstep(front, 0.05, 0.45) * onScreen * THREE.MathUtils.smoothstep(s.sunDir.y, -0.02, 0.12);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() { this.mat.dispose(); this.quad.dispose(); }
}
