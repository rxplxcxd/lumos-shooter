import * as THREE from 'three';

/** Cheap animated water: vertex swell + fresnel tint + sun glint, no reflections (low-spec friendly). */
export class Water {
  mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  level: number;
  constructor(size: number, level = 0, segments = 64) {
    this.level = level;
    const g = new THREE.PlaneGeometry(size, size, segments, segments);
    g.rotateX(-Math.PI / 2);
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      uniforms: {
        time: { value: 0 },
        deep: { value: new THREE.Color(0x0b4f6c) },
        shallow: { value: new THREE.Color(0x2fa3b5) },
        sunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2).normalize() },
        fogColor: { value: new THREE.Color(0xa8c8e0) },
        fogNear: { value: 300 }, fogFar: { value: 1400 },
        brightness: { value: 1 },
      },
      vertexShader: /* glsl */ `
        uniform float time; varying vec3 vWorld; varying float vWave;
        void main(){
          vec3 p = position;
          vec4 w = modelMatrix * vec4(p, 1.0);
          float wave = sin(w.x * 0.05 + time * 0.9) * 0.35 + cos(w.z * 0.07 + time * 1.1) * 0.3 + sin((w.x + w.z) * 0.15 + time * 2.0) * 0.08;
          w.y += wave; vWave = wave; vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 deep; uniform vec3 shallow; uniform vec3 sunDir; uniform float time; uniform vec3 fogColor; uniform float fogNear; uniform float fogFar; uniform float brightness;
        varying vec3 vWorld; varying float vWave;
        void main(){
          vec3 V = normalize(cameraPosition - vWorld);
          float nx = cos(vWorld.x * 0.05 + time * 0.9) * 0.02 + sin(vWorld.x * 0.6 + time * 1.7) * 0.03;
          float nz = -sin(vWorld.z * 0.07 + time * 1.1) * 0.02 + cos(vWorld.z * 0.5 - time * 1.3) * 0.03;
          vec3 N = normalize(vec3(nx, 1.0, nz));
          float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
          vec3 col = mix(deep, shallow, 0.35 + vWave * 0.4);
          col = mix(col, vec3(0.55, 0.75, 0.9), fres * 0.4);
          vec3 H = normalize(sunDir + V);
          col += pow(max(dot(N, H), 0.0), 120.0) * vec3(1.0, 0.95, 0.8) * 1.5;
          col *= brightness;
          float d = length(cameraPosition - vWorld);
          col = mix(col, fogColor, smoothstep(fogNear, fogFar, d));
          gl_FragColor = vec4(col, 0.86);
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.position.y = level;
    this.mesh.name = 'water';
    this.mesh.renderOrder = 2;
  }
  update(t: number, sun: THREE.Vector3, fog: THREE.Fog | null, brightness: number, camPos: THREE.Vector3) {
    this.mat.uniforms.time.value = t;
    this.mat.uniforms.sunDir.value.copy(sun);
    this.mat.uniforms.brightness.value = brightness;
    if (fog) { this.mat.uniforms.fogColor.value.copy(fog.color); this.mat.uniforms.fogNear.value = fog.near; this.mat.uniforms.fogFar.value = fog.far; }
    // keep the finite water plane centred on the camera (infinite ocean illusion)
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
}
