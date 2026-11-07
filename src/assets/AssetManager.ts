import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { MODELS, KITS, CHARACTER_ANIMS, type ModelDef, type KitId } from './manifest';
import { settings } from '../core/Settings';

/**
 * AssetManager
 *  - Loads Draco / Meshopt compressed GLB and KTX2 (Basis) textures
 *  - Routes requests through the Lumos Cloud CDN when configured, falling back to the
 *    locally bundled /assets folder (works offline and in Codespaces)
 *  - Normalises third-party models (scale / yaw / pivot) using the manifest
 *  - Hands out cheap clones (shared geometry & materials, SkeletonUtils for skinned meshes)
 */
const settingsQuality = () => settings.data.quality;

export class AssetManager {
  private loader = new GLTFLoader();
  private cache = new Map<string, Promise<GLTF>>();
  private normalized = new Map<string, THREE.Object3D>();
  private kitCache = new Map<string, THREE.Object3D>();
  readonly cdnBases: string[] = [];
  lowSpec = false;
  bytesLoaded = 0;

  constructor(renderer?: THREE.WebGLRenderer) {
    const draco = new DRACOLoader();
    draco.setDecoderPath('./draco/');
    draco.preload();
    this.loader.setDRACOLoader(draco);
    this.loader.setMeshoptDecoder(MeshoptDecoder);
    if (renderer) {
      const ktx2 = new KTX2Loader().setTranscoderPath('./basis/').detectSupport(renderer);
      this.loader.setKTX2Loader(ktx2);
    }
    const cdn = (import.meta.env.VITE_LUMOS_CDN as string | undefined) || (window as any).LumosCloudSDK?.cdnBase;
    if (cdn) this.cdnBases.push(cdn.replace(/\/$/, '') + '/');
  }

  private async fetchGLTF(file: string): Promise<GLTF> {
    const bases = [...this.cdnBases, './assets/'];
    let lastErr: unknown;
    for (const base of bases) {
      try {
        return await this.loader.loadAsync(`${base}${file}.glb`, (e) => { if (e.total) this.bytesLoaded += 0; });
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  load(file: string): Promise<GLTF> {
    let p = this.cache.get(file);
    if (!p) {
      p = this.fetchGLTF(file).then((g) => { this.prepare(g.scene, file.startsWith('env/'), file.startsWith('vehicles/')); return g; });
      this.cache.set(file, p);
    }
    return p;
  }

  /** Shadow flags + optional low-spec material conversion (Lambert is ~3x cheaper than PBR). */
  private triTex: THREE.Texture | null = null;
  private lambertCache = new Map<string, THREE.MeshLambertMaterial>();
  private paintCache = new Map<string, THREE.MeshPhysicalMaterial>();
  /** untextured (flat white) building materials from some Sketchfab exports get world-space
   *  triplanar concrete so they read as real surfaces instead of clay renders */
  private triplanar(mat: THREE.Material) {
    if (!this.triTex) {
      this.triTex = new THREE.TextureLoader().load('./assets/textures/concrete.webp');
      this.triTex.wrapS = this.triTex.wrapT = THREE.RepeatWrapping;
      this.triTex.colorSpace = THREE.SRGBColorSpace;
      this.triTex.anisotropy = 4;
    }
    const tex = this.triTex;
    const tint = (mat as THREE.MeshStandardMaterial).color.clone().multiplyScalar(0.92);
    (mat as THREE.MeshStandardMaterial).color.setRGB(1, 1, 1);
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.triTex = { value: tex };
      sh.uniforms.triTint = { value: tint };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vTriP; varying vec3 vTriN;')
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
  vec4 triW = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  triW = instanceMatrix * triW;
  #endif
  triW = modelMatrix * triW;
  vTriP = triW.xyz;
  vTriN = normalize(mat3(modelMatrix) * objectNormal);`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D triTex; uniform vec3 triTint; varying vec3 vTriP; varying vec3 vTriN;')
        .replace('#include <map_fragment>', `#include <map_fragment>
  {
    vec3 bw = pow(abs(normalize(vTriN)), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
    vec3 P = vTriP * 0.22;
    vec3 tc = texture2D(triTex, P.zy).rgb * bw.x + texture2D(triTex, P.xz).rgb * bw.y + texture2D(triTex, P.xy).rgb * bw.z;
    // large-scale variation (stains / weathering) so walls don't tile visibly
    float grime = texture2D(triTex, vTriP.xz * 0.013 + vTriP.y * 0.02).g;
    diffuseColor.rgb *= triTint * tc * (0.75 + grime * 0.5) * 1.35;
  }`);
    };
    mat.customProgramCacheKey = () => 'triplanar';
    mat.needsUpdate = true;
  }

  /** physically plausible defaults per material class (exports rarely ship good roughness / metalness) */
  private pbr(sm: THREE.MeshStandardMaterial, vehicle: boolean) {
    const n = sm.name.toLowerCase();
    const hasRM = !!(sm.roughnessMap || sm.metalnessMap);
    if (/glass|window|windshield|windscreen|lens/.test(n)) { sm.roughness = 0.04; sm.metalness = 0.1; sm.envMapIntensity = 1.25; return; }
    if (hasRM) return;
    if (/chrome|steel|iron|metal|alu|rim|pipe|rail/.test(n)) { sm.metalness = Math.max(sm.metalness, 0.72); sm.roughness = Math.min(sm.roughness, 0.36); sm.envMapIntensity = 0.95; return; }
    if (/tire|tyre|rubber|wheel/.test(n)) { sm.roughness = 0.94; sm.metalness = 0; return; }
    if (/asphalt|road|concrete|stone|brick|plaster|cladding|roof|wall|dirt|ground/.test(n)) { sm.roughness = Math.max(sm.roughness, 0.84); sm.metalness = 0; return; }
    if (/wood|plank|bark|leaf|leaves|grass|cloth|fabric|tarp/.test(n)) { sm.roughness = Math.max(sm.roughness, 0.88); sm.metalness = 0; return; }
    if (vehicle) { sm.roughness = Math.min(sm.roughness, 0.42); sm.metalness = Math.min(Math.max(sm.metalness, 0.18), 0.4); sm.envMapIntensity = 0.85; }
  }

  private prepare(root: THREE.Object3D, env = false, vehicle = false) {
    const physical = !this.lowSpec && (settingsQuality() === 'high' || settingsQuality() === 'ultra');
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      if ((m as THREE.SkinnedMesh).isSkinnedMesh) m.frustumCulled = false;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        const sm = mat as THREE.MeshStandardMaterial;
        if (sm.isMeshStandardMaterial) {
          // many Sketchfab exports ship fully metallic materials that render black without an env map
          if (sm.metalness > 0.6 && !sm.metalnessMap) sm.metalness = 0.4;
          sm.envMapIntensity = 0.6;
          // the modular city kit stores blend masks in COLOR_0 – not meant as albedo tint (red curbs)
          if (sm.name.startsWith('MI_') && sm.vertexColors) { sm.vertexColors = false; sm.needsUpdate = true; }
          if (env && !sm.map && sm.color.r > 0.7 && sm.color.g > 0.7 && sm.color.b > 0.7 && !sm.transparent && !this.lowSpec) this.triplanar(sm);
          if (!this.lowSpec) this.pbr(sm, vehicle);
        }
      }
      if (vehicle && physical) {
        const up = mats.map((mat) => {
          const sm = mat as THREE.MeshStandardMaterial;
          if (!sm.isMeshStandardMaterial || (sm as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial || /glass|window|tire|tyre|rubber|light|lamp/i.test(sm.name)) return mat;
          let p = this.paintCache.get(sm.uuid);
          if (!p) {
            p = new THREE.MeshPhysicalMaterial();
            THREE.MeshStandardMaterial.prototype.copy.call(p, sm);
            p.defines = { STANDARD: '', PHYSICAL: '' }; // the standard copy() drops the physical define
            p.clearcoat = 0.85; p.clearcoatRoughness = 0.12; p.roughness = Math.min(sm.roughness, 0.45);
            p.name = sm.name;
            this.paintCache.set(sm.uuid, p);
          }
          return p;
        });
        m.material = Array.isArray(m.material) ? up : up[0];
      }
      if (this.lowSpec) {
        const conv = mats.map((mat) => {
          const sm = mat as THREE.MeshStandardMaterial;
          if (!sm.isMeshStandardMaterial) return mat;
          // keep shared materials shared, otherwise the static batcher cannot merge them (draw calls)
          let l = this.lambertCache.get(sm.uuid);
          if (!l) {
            l = new THREE.MeshLambertMaterial({ map: sm.map, color: sm.color, transparent: sm.transparent, opacity: sm.opacity, alphaTest: sm.alphaTest, side: sm.side, vertexColors: sm.vertexColors, emissive: sm.emissive, emissiveMap: sm.emissiveMap });
            l.name = sm.name;
            this.lambertCache.set(sm.uuid, l);
          }
          return l;
        });
        m.material = Array.isArray(m.material) ? conv : conv[0];
      }
    });
  }

  /** Builds (once) the normalised template for a manifest id. */
  async template(id: string): Promise<THREE.Object3D> {
    const hit = this.normalized.get(id);
    if (hit) return hit;
    const def: ModelDef | undefined = MODELS[id];
    if (!def) throw new Error(`Unknown model id ${id}`);
    const gltf = await this.load(def.file);
    const inner = gltf.scene;
    for (const h of def.hide ?? []) inner.getObjectByName(h)?.removeFromParent();
    const pivot = new THREE.Group();
    pivot.name = id;
    const yawGroup = new THREE.Group();
    yawGroup.rotation.y = THREE.MathUtils.degToRad(def.yaw ?? 0);
    yawGroup.add(inner);
    pivot.add(yawGroup);
    pivot.updateMatrixWorld(true);
    const box = this.visibleBox(def.lengthNode ? (inner.getObjectByName(def.lengthNode) ?? pivot) : pivot);
    const size = box.getSize(new THREE.Vector3());
    let s = 1;
    if (def.length) s = def.length / Math.max(size.z, 1e-6);
    else if (def.height) s = def.height / Math.max(size.y, 1e-6);
    else if (def.width) s = def.width / Math.max(size.x, 1e-6);
    yawGroup.scale.setScalar(s);
    pivot.updateMatrixWorld(true);
    const fb = this.visibleBox(pivot);
    if (!def.keepOrigin) {
      const c = fb.getCenter(new THREE.Vector3());
      yawGroup.position.set(-c.x, -fb.min.y, -c.z);
    } else {
      yawGroup.position.y = -fb.min.y;
    }
    pivot.updateMatrixWorld(true);
    pivot.userData.animations = gltf.animations;
    pivot.userData.size = this.visibleBox(pivot).getSize(new THREE.Vector3());
    this.normalized.set(id, pivot);
    return pivot;
  }

  visibleBox(obj: THREE.Object3D) {
    const box = new THREE.Box3();
    obj.updateMatrixWorld(true);
    obj.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh) box.expandByObject(o, true); });
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
    return box;
  }

  /** Returns a new instance of a model (skinned meshes get their own skeleton). */
  async instance(id: string): Promise<THREE.Object3D> {
    const t = await this.template(id);
    let skinned = false;
    t.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = true; });
    const c = skinned ? SkeletonUtils.clone(t) : t.clone(true);
    c.userData = { ...t.userData };
    return c;
  }

  async kit(kit: KitId): Promise<THREE.Object3D> {
    const g = await this.load(KITS[kit]);
    return g.scene;
  }

  /** Clone of a named kit piece with its pivot on the ground. */
  async kitPiece(kit: KitId, name: string): Promise<THREE.Object3D> {
    const key = `${kit}:${name}`;
    let t = this.kitCache.get(key);
    if (!t) {
      const scene = await this.kit(kit);
      const src = scene.getObjectByName(name);
      if (!src) throw new Error(`kit piece ${key} missing`);
      const piece = src.clone(true);
      piece.position.set(0, 0, 0);
      const wrap = new THREE.Group();
      wrap.add(piece);
      wrap.updateMatrixWorld(true);
      const b = this.visibleBox(wrap);
      const bc = b.getCenter(new THREE.Vector3());
      piece.position.set(-bc.x, -b.min.y, -bc.z);
      wrap.userData.size = b.getSize(new THREE.Vector3());
      wrap.userData.center = b.getCenter(new THREE.Vector3());
      wrap.name = name;
      t = wrap;
      this.kitCache.set(key, t);
    }
    const c = t.clone(true);
    c.userData = { ...t.userData };
    return c;
  }

  kitNames(kit: KitId): Promise<string[]> {
    return this.kit(kit).then((s) => s.children.map((c) => c.name));
  }

  async characterClips(): Promise<THREE.AnimationClip[]> {
    const g = await this.load(CHARACTER_ANIMS);
    return g.animations;
  }

  /** Preloads a list of model ids / files with progress feedback. */
  async preload(ids: string[], onProgress?: (done: number, total: number) => void) {
    let done = 0;
    const total = ids.length;
    await Promise.all(ids.map(async (id) => {
      try {
        if (id.startsWith('kit:')) await this.kit(id.slice(4) as KitId);
        else if (id === 'anims') await this.characterClips();
        else await this.template(id);
      } catch (e) {
        console.warn('asset failed', id, e);
      }
      onProgress?.(++done, total);
    }));
  }
}
