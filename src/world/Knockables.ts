import * as THREE from 'three';
import { RAPIER, GROUP, groups } from '../physics/Physics';
import type { GameWorld } from '../gameplay/GameWorld';
import type { KitId } from '../assets/manifest';

interface KType { meshes: THREE.InstancedMesh[]; locals: THREE.Matrix4[]; count: number; half: THREE.Vector3; dirty: boolean }
interface KItem { t: KType; idx: number; body: RAPIER.RigidBody; collider: RAPIER.Collider; scale: number; home: THREE.Vector3 }

const UP = new THREE.Vector3(0, 1, 0);
const M = new THREE.Matrix4(), T = new THREE.Matrix4(), TMP = new THREE.Matrix4();
const V = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3();

/**
 * Loose street props with real rigid bodies – trash cans, dumpsters, pallets. They sleep until
 * something touches them: cars plough through them, players shove them (the character
 * controller applies impulses), bullets knock them around and explosions scatter them.
 * Rendering is one InstancedMesh per prop type (and material), so hundreds of props cost a
 * handful of draw calls; only awake bodies update their instance matrices.
 */
export class Knockables {
  private types = new Map<string, Promise<KType>>();
  items: KItem[] = [];
  private byCollider = new Map<number, KItem>();
  root = new THREE.Group();
  private boundsT = 0;

  constructor(private w: GameWorld, private capPer = 120) {
    this.root.name = 'knockables';
    w.root.add(this.root);
  }

  private type(kit: KitId, name: string): Promise<KType> {
    const key = kit + ':' + name;
    let p = this.types.get(key);
    if (!p) {
      p = this.w.assets.kitPiece(kit, name).then((piece) => {
        piece.updateMatrixWorld(true);
        const size = (piece.userData.size as THREE.Vector3) ?? new THREE.Vector3(1, 1, 1);
        const meshes: THREE.InstancedMesh[] = [], locals: THREE.Matrix4[] = [];
        piece.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          const im = new THREE.InstancedMesh(m.geometry, m.material, this.capPer);
          im.count = 0; im.castShadow = name === 'Dumpster'; im.receiveShadow = true;
          im.name = 'knock_' + name;
          meshes.push(im); locals.push(m.matrixWorld.clone());
          this.root.add(im);
        });
        return { meshes, locals, count: 0, half: size.clone().multiplyScalar(0.5), dirty: true };
      });
      this.types.set(key, p);
    }
    return p;
  }

  async add(kit: KitId, name: string, base: THREE.Vector3, yaw: number, scale: number, mass: number) {
    let t: KType;
    try { t = await this.type(kit, name); } catch { return null; }
    if (t.count >= this.capPer) return null;
    const half = t.half.clone().multiplyScalar(scale);
    const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    const world = this.w.physics.world;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(base.x, base.y + half.y + 0.005, base.z)
      .setRotation(q).setLinearDamping(0.2).setAngularDamping(0.45).setCanSleep(true));
    const collider = world.createCollider(RAPIER.ColliderDesc.cuboid(half.x * 0.92, half.y, half.z * 0.92).setMass(mass).setFriction(0.75).setRestitution(0.12)
      .setCollisionGroups(groups(GROUP.WORLD, 0xffff)), body);
    body.sleep();
    const it: KItem = { t, idx: t.count++, body, collider, scale, home: base.clone() };
    for (const m of t.meshes) m.count = t.count;
    this.items.push(it);
    this.byCollider.set(collider.handle, it);
    this.w.registerSurface(collider, mass > 100 ? 'metal' : 'wood');
    this.write(it);
    return it;
  }

  private write(it: KItem) {
    const p = it.body.translation(), r = it.body.rotation();
    M.compose(V.set(p.x, p.y, p.z), Q.set(r.x, r.y, r.z, r.w), S.setScalar(it.scale)).multiply(T.makeTranslation(0, -it.t.half.y, 0));
    for (let k = 0; k < it.t.meshes.length; k++) {
      TMP.multiplyMatrices(M, it.t.locals[k]);
      it.t.meshes[k].setMatrixAt(it.idx, TMP);
      it.t.meshes[k].instanceMatrix.needsUpdate = true;
    }
    it.t.dirty = true;
  }

  isKnockable(c: RAPIER.Collider) { return this.byCollider.has(c.handle); }

  /** bullet / melee impact */
  hit(c: RAPIER.Collider, dir: THREE.Vector3, point: THREE.Vector3, impulse: number) {
    const it = this.byCollider.get(c.handle);
    if (!it) return false;
    it.body.applyImpulseAtPoint({ x: dir.x * impulse, y: dir.y * impulse + impulse * 0.15, z: dir.z * impulse }, { x: point.x, y: point.y, z: point.z }, true);
    return true;
  }

  explode(p: THREE.Vector3, radius: number, power: number) {
    for (const it of this.items) {
      const t = it.body.translation();
      const dx = t.x - p.x, dy = t.y - p.y, dz = t.z - p.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > radius) continue;
      const k = (1 - d / radius) * power * it.body.mass();
      const inv = 1 / Math.max(d, 0.3);
      it.body.applyImpulse({ x: dx * inv * k, y: (Math.abs(dy) * inv + 0.8) * k, z: dz * inv * k }, true);
      it.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * k * 0.3, y: (Math.random() - 0.5) * k * 0.3, z: (Math.random() - 0.5) * k * 0.3 }, true);
    }
  }

  update(dt: number) {
    for (const it of this.items) {
      if (it.body.isSleeping()) continue;
      const t = it.body.translation();
      if (t.y < this.w.waterLevel - 40) { // fell off the world: put it back home
        it.body.setTranslation({ x: it.home.x, y: it.home.y + 1, z: it.home.z }, true);
        it.body.setLinvel({ x: 0, y: 0, z: 0 }, true); it.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
      this.write(it);
    }
    this.boundsT -= dt;
    if (this.boundsT <= 0) {
      this.boundsT = 0.5;
      for (const p of this.types.values()) p.then((t) => { if (t.dirty) { t.dirty = false; for (const m of t.meshes) m.computeBoundingSphere(); } });
    }
  }

  dispose() {
    // bodies die with the physics world
    this.items = [];
    this.byCollider.clear();
    this.root.removeFromParent();
  }
}
