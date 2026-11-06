import * as THREE from 'three';
import type { Engine } from '../core/Engine';
import type { AssetManager } from '../assets/AssetManager';
import { CharacterModel } from '../entities/CharacterModel';
import type { Profile } from '../net/Profile';

/** 3D lobby backdrop: your operator in an idle pose next to a vehicle, slow orbit camera. */
export class Lobby3D {
  group = new THREE.Group();
  private op: CharacterModel | null = null;
  private opKey = '';
  private t = 0;
  private vehicle: THREE.Object3D | null = null;
  private idleT = 6;
  private idleIdx = 0;
  constructor(private engine: Engine, private assets: AssetManager) {}

  async build(profile: Profile) {
    const s = this.engine.scene;
    s.add(this.group);
    s.background = new THREE.Color(0x0b0f14);
    s.fog = new THREE.Fog(0x0b0f14, 12, 40);
    const hemi = new THREE.HemisphereLight(0x9fc0ff, 0x202020, 1.2);
    const key = new THREE.DirectionalLight(0xffe2b0, 2.2); key.position.set(4, 8, 5); key.castShadow = true; key.shadow.mapSize.set(1024, 1024);
    const rim = new THREE.PointLight(0x4aa8ff, 30, 12); rim.position.set(-3, 2.5, -2);
    const warm = new THREE.PointLight(0xffb52e, 18, 10); warm.position.set(3, 1.5, 2);
    this.group.add(hemi, key, rim, warm);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(14, 48), new THREE.MeshStandardMaterial({ color: 0x1a2230, roughness: 0.6, metalness: 0.3 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
    this.group.add(floor);
    try {
      const v = await this.assets.instance('car_muscle');
      v.position.set(2.4, 0, -1.8); v.rotation.y = -0.7;
      this.group.add(v); this.vehicle = v;
      const crate = await this.assets.instance('item_crate');
      crate.position.set(-1.6, 0, -0.8); crate.rotation.y = 0.4; this.group.add(crate);
      const heli = await this.assets.instance('heli_huey');
      heli.position.set(-6, 0, -7); heli.rotation.y = 0.9; this.group.add(heli);
    } catch (e) { console.warn(e); }
    await this.setOperator(profile);
  }

  async setOperator(p: Profile) {
    const key = p.operator + p.operatorTint;
    if (key === this.opKey) return;
    this.opKey = key;
    const m = new CharacterModel();
    await m.init(this.assets, p.operator, p.operatorTint);
    this.op?.dispose();
    this.op = m;
    m.root.position.set(0, 0, 0);
    m.root.rotation.y = 0.35;
    m.setLoco('lobby', 0);
    await m.addGear(this.assets, 0x4b5a3a);
    m.proc.kind = 'lobby';
    this.group.add(m.root);
  }

  update(dt: number) {
    this.t += dt;
    const cam = this.engine.camera;
    const a = 0.35 + Math.sin(this.t * 0.15) * 0.25;
    cam.position.set(Math.sin(a) * 4.2 + 0.6, 1.55, Math.cos(a) * 4.2);
    cam.lookAt(0.6, 1.0, 0);
    cam.fov = 45; cam.updateProjectionMatrix();
    if (this.op) {
      // idle variety: arms folded -> talking -> phone -> stretch/look around
      this.idleT -= dt;
      if (this.idleT <= 0) { this.idleT = 7 + Math.random() * 5; const seq = ['lobby', 'idle', 'talk', 'lobby', 'phone', 'idle'] as const; this.idleIdx = (this.idleIdx + 1) % seq.length; this.op.setLoco(seq[this.idleIdx], 0.6); }
      this.op.proc.lookAt = cam.position;
      this.op.update(dt, 2);
    }
    if (this.vehicle) this.vehicle.rotation.y = -0.7 + Math.sin(this.t * 0.2) * 0.05;
  }

  dispose() {
    this.op?.dispose(); this.op = null; this.opKey = '';
    this.group.removeFromParent();
    this.group.clear();
    this.engine.scene.background = null;
    this.engine.scene.fog = null;
  }
}
