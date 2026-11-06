import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

export type R = typeof RAPIER;
export { RAPIER };

/** Collision groups (membership << 16 | filter). */
export const GROUP = {
  WORLD: 0x0001,
  CHAR: 0x0002,
  VEHICLE: 0x0004,
  DEBRIS: 0x0008,
};
export const groups = (member: number, filter: number) => (member << 16) | filter;

/**
 * Thin Rapier (WASM) wrapper: world stepping, static geometry helpers (heightfield,
 * trimesh, boxes), kinematic character controllers and raycasts used by ballistics.
 */
export class Physics {
  world!: RAPIER.World;
  ready = false;
  private static initP: Promise<void> | null = null;
  eventQueue!: RAPIER.EventQueue;

  static init() {
    if (!this.initP) this.initP = RAPIER.init();
    return this.initP;
  }

  async create() {
    await Physics.init();
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 60;
    this.eventQueue = new RAPIER.EventQueue(true);
    this.ready = true;
  }

  step() { if (this.ready) this.world.step(this.eventQueue); }

  dispose() { if (this.ready) { this.world.free(); this.ready = false; } }

  addHeightfield(nrows: number, ncols: number, heights: Float32Array, scale: { x: number; y: number; z: number }) {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const desc = RAPIER.ColliderDesc.heightfield(nrows, ncols, heights, scale).setFriction(0.9)
      .setCollisionGroups(groups(GROUP.WORLD, 0xffff));
    return this.world.createCollider(desc, body);
  }

  /** Static trimesh collider from all meshes under obj (world transforms baked). */
  addStaticMesh(obj: THREE.Object3D, maxTris = 6000) {
    obj.updateMatrixWorld(true);
    const verts: number[] = [];
    const idx: number[] = [];
    const v = new THREE.Vector3();
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.visible) return;
      const g = m.geometry as THREE.BufferGeometry;
      const pos = g.getAttribute('position');
      if (!pos) return;
      const base = verts.length / 3;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        verts.push(v.x, v.y, v.z);
      }
      if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(base + g.index.getX(i));
      else for (let i = 0; i < pos.count; i++) idx.push(base + i);
    });
    if (!idx.length) return null;
    if (idx.length / 3 > maxTris * 4) {
      // very heavy meshes: fall back to a bounding box
      const b = new THREE.Box3().setFromObject(obj);
      return this.addBox(b.getCenter(new THREE.Vector3()), b.getSize(new THREE.Vector3()).multiplyScalar(0.5));
    }
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const desc = RAPIER.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(idx)).setCollisionGroups(groups(GROUP.WORLD, 0xffff));
    return this.world.createCollider(desc, body);
  }

  addBox(center: THREE.Vector3, half: THREE.Vector3, rotY = 0) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(center.x, center.y, center.z).setRotation(q));
    return this.world.createCollider(RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setCollisionGroups(groups(GROUP.WORLD, 0xffff)), body);
  }

  removeCollider(c: RAPIER.Collider | null | undefined) {
    if (!c) return;
    const b = c.parent();
    this.world.removeCollider(c, true);
    if (b && b.numColliders() === 0) this.world.removeRigidBody(b);
  }

  createCharacter(pos: THREE.Vector3, radius = 0.35, halfHeight = 0.55) {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z));
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(halfHeight, radius).setCollisionGroups(groups(GROUP.CHAR, GROUP.WORLD | GROUP.VEHICLE)), body);
    const ctrl = this.world.createCharacterController(0.05);
    ctrl.setUp({ x: 0, y: 1, z: 0 });
    ctrl.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(50));
    ctrl.setMinSlopeSlideAngle(THREE.MathUtils.degToRad(60));
    ctrl.enableAutostep(0.45, 0.25, true);
    ctrl.enableSnapToGround(0.4);
    ctrl.setApplyImpulsesToDynamicBodies(true);
    ctrl.setCharacterMass(80);
    return { body, collider, ctrl };
  }

  /** Ray against static world + vehicles. Returns hit distance, point, normal and collider. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, exclude?: RAPIER.Collider | null, filterGroups = groups(0xffff, GROUP.WORLD | GROUP.VEHICLE)) {
    const ray = new RAPIER.Ray(origin, dir);
    const hit = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, filterGroups, exclude ?? undefined);
    if (!hit) return null;
    const p = ray.pointAt(hit.timeOfImpact);
    return { dist: hit.timeOfImpact, point: new THREE.Vector3(p.x, p.y, p.z), normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z), collider: hit.collider };
  }
}
