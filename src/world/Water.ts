import * as THREE from 'three';
import type { Terrain } from './Terrain';

/**
 * Animated water without reflections (low-spec friendly):
 *  - layered vertex swell, procedural ripple normals, fresnel sky tint, sun glint
 *  - depth colouring + animated shoreline foam from the terrain heightmap (Half-float texture)
 *  - the finite plane follows the camera and scales with fog distance (endless ocean)
 */
export class Water {
  mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  level: number;
  constructor(size: number, level = 0, segments = 64, high = false) {
    this.level = level;
    const g = new THREE.PlaneGeometry(size, size, segments, segments);
    g.rotateX(-Math.PI / 2);
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      defines: high ? { HIGH: 1 } : {},
      uniforms: {
        time: { value: 0 },
        deep: { value: new THREE.Color(0x07405a) },
        shallow: { value: new THREE.Color(0x2fb0b8) },
        sunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2).normalize() },
        sky: { value: new THREE.Color(0x8fb8d8) },
        fogColor: { value: new THREE.Color(0xa8c8e0) },
        fogNear: { value: 300 }, fogFar: { value: 1400 },
        brightness: { value: 1 },
        tHeight: { value: null },
        terrainSize: { value: 1600 },
        hasHeight: { value: 0 },
      },
      vertexShader: /* glsl */ `
        uniform float time; varying vec3 vWorld; varying float vWave;
        void main(){
          vec4 w = modelMatrix * vec4(position, 1.0);
          float wave = sin(w.x * 0.05 + time * 0.9) * 0.35 + cos(w.z * 0.07 + time * 1.1) * 0.3 + sin((w.x + w.z) * 0.15 + time * 2.0) * 0.08;
          #ifdef HIGH
          wave += sin(w.x * 0.21 - w.z * 0.17 + time * 2.6) * 0.06;
          #endif
          w.y += wave; vWave = wave; vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 deep; uniform vec3 shallow; uniform vec3 sunDir; uniform float time; uniform vec3 sky; uniform vec3 fogColor; uniform float fogNear; uniform float fogFar; uniform float brightness;
        uniform sampler2D tHeight; uniform float terrainSize; uniform float hasHeight;
        varying vec3 vWorld; varying float vWave;
        float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), f.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), f.x), f.y); }
        void main(){
          vec3 V = normalize(cameraPosition - vWorld);
          float nx = cos(vWorld.x * 0.05 + time * 0.9) * 0.02 + sin(vWorld.x * 0.6 + time * 1.7) * 0.03;
          float nz = -sin(vWorld.z * 0.07 + time * 1.1) * 0.02 + cos(vWorld.z * 0.5 - time * 1.3) * 0.03;
          #ifdef HIGH
          nx += (vn(vWorld.xz * 0.8 + time * 0.6) - 0.5) * 0.08; nz += (vn(vWorld.zx * 0.9 - time * 0.5) - 0.5) * 0.08;
          #endif
          vec3 N = normalize(vec3(nx, 1.0, nz));
          float depth = 30.0;
          if (hasHeight > 0.5) {
            vec2 tuv = vWorld.xz / terrainSize + 0.5;
            if (tuv.x > 0.0 && tuv.y > 0.0 && tuv.x < 1.0 && tuv.y < 1.0) depth = max(0.0, vWorld.y - texture2D(tHeight, tuv).r);
          }
          float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
          vec3 col = mix(shallow, deep, smoothstep(0.5, 9.0, depth));
          col = mix(col, sky, fres * 0.55);
          vec3 H = normalize(sunDir + V);
          col += pow(max(dot(N, H), 0.0), 160.0) * vec3(1.0, 0.95, 0.8) * 2.0;
          // shoreline foam (animated bands + noise)
          float foam = smoothstep(1.6, 0.0, depth) * (0.55 + 0.45 * sin(depth * 9.0 - time * 2.2 + vn(vWorld.xz * 0.7) * 6.0));
          foam = clamp(foam + smoothstep(0.35, 0.0, depth), 0.0, 1.0) * smoothstep(0.35, 0.65, vn(vWorld.xz * 1.3 + time * 0.3) + 0.25);
          col = mix(col, vec3(0.92, 0.96, 1.0), foam * 0.85);
          col *= brightness;
          float d = length(cameraPosition - vWorld);
          col = mix(col, fogColor, smoothstep(fogNear, fogFar, d));
          float alpha = mix(0.6, 0.9, smoothstep(0.0, 3.0, depth)) + foam * 0.1;
          gl_FragColor = vec4(col, alpha);
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.position.y = level;
    this.mesh.name = 'water';
    this.mesh.renderOrder = 2;
  }

  /** upload the terrain heights for depth tint + shoreline foam */
  setTerrain(t: Terrain) {
    const n1 = t.N + 1;
    const data = new Uint16Array(n1 * n1);
    for (let i = 0; i < n1 * n1; i++) data[i] = THREE.DataUtils.toHalfFloat(t.heights[i]);
    const tex = new THREE.DataTexture(data, n1, n1, THREE.RedFormat, THREE.HalfFloatType);
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.mat.uniforms.tHeight.value = tex;
    this.mat.uniforms.terrainSize.value = t.size;
    this.mat.uniforms.hasHeight.value = 1;
  }

  update(t: number, sun: THREE.Vector3, fog: THREE.Fog | null, brightness: number, camPos: THREE.Vector3) {
    const u = this.mat.uniforms;
    u.time.value = t;
    u.sunDir.value.copy(sun);
    u.brightness.value = brightness;
    if (fog) { u.fogColor.value.copy(fog.color); u.fogNear.value = fog.near; u.fogFar.value = fog.far; u.sky.value.copy(fog.color); }
    const half = (this.mesh.geometry as THREE.PlaneGeometry).parameters.width / 2;
    const need = fog ? fog.far * 1.15 : half;
    const k = Math.max(1, need / half);
    this.mesh.scale.set(k, 1, k);
    const step = 50;
    this.mesh.position.x = Math.round(camPos.x / step) * step;
    this.mesh.position.z = Math.round(camPos.z / step) * step;
  }

  /** approximate wave height for buoyancy */
  heightAt(x: number, z: number, t: number) {
    return this.level + Math.sin(x * 0.05 + t * 0.9) * 0.35 + Math.cos(z * 0.07 + t * 1.1) * 0.3;
  }

  dispose() { this.mesh.geometry.dispose(); this.mat.uniforms.tHeight.value?.dispose(); this.mat.dispose(); }
}
