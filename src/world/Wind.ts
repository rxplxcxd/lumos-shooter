import * as THREE from 'three';

/** shared wind uniforms – one update per frame drives every patched foliage material */
export const wind = { uTime: { value: 0 }, uStrength: { value: 1 } };
const patched = new WeakSet<THREE.Material>();

/**
 * Injects a vertex sway into foliage materials (trees, bushes, grass). Works for instanced and
 * regular meshes: displacement grows with height inside the plant, phase varies per instance.
 */
export function applyWind(mat: THREE.Material, amount: number) {
  if (patched.has(mat)) return;
  patched.add(mat);
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    prev?.call(mat, shader, r);
    shader.uniforms.uWindTime = wind.uTime;
    shader.uniforms.uWindStrength = wind.uStrength;
    shader.vertexShader = 'uniform float uWindTime; uniform float uWindStrength;\n' + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        vec4 wOrigin = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        #ifdef USE_INSTANCING
          wOrigin = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        #endif
        float hgt = max(position.y, 0.0);
        float ph = wOrigin.x * 0.11 + wOrigin.z * 0.07;
        float gust = 0.6 + 0.4 * sin(uWindTime * 0.35 + ph * 0.2);
        float sway = (sin(uWindTime * 1.6 + ph) * 0.7 + sin(uWindTime * 3.7 + ph * 2.3 + position.x) * 0.3) * gust;
        float k = ${amount.toFixed(4)} * uWindStrength * pow(hgt, 1.35);
        transformed.x += sway * k;
        transformed.z += sway * k * 0.55 + sin(uWindTime * 2.3 + ph) * k * 0.25;
      }`);
  };
  mat.customProgramCacheKey = () => 'wind' + amount;
  mat.needsUpdate = true;
}
