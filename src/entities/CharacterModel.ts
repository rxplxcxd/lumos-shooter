import * as THREE from 'three';
import type { AssetManager } from '../assets/AssetManager';

const UPPER = /^(spine_0[123]|neck_01|Head|clavicle_|upperarm_|lowerarm_|hand_|index_|middle_|pinky_|ring_|thumb_)/;

export type LocoState =
  | 'idle' | 'walk' | 'jog' | 'sprint' | 'crouchIdle' | 'crouchWalk' | 'jump' | 'fall' | 'land' | 'slide'
  | 'swimIdle' | 'swim' | 'drive' | 'sit' | 'freefall' | 'downed' | 'dead' | 'zombieIdle' | 'zombieWalk' | 'zombieRun' | 'dance' | 'lobby' | 'climb' | 'revive'
  | 'talk' | 'phone' | 'rail' | 'carry';
export type UpperState = 'none' | 'aim' | 'hold' | 'shoot' | 'reload' | 'throw' | 'consume' | 'melee' | 'pickup' | 'zombieAttack' | 'hit' | 'hitHead' | 'chest' | 'no' | 'yes';

const LOCO_CLIPS: Record<LocoState, string> = {
  idle: 'Idle_Loop', walk: 'Walk_Loop', jog: 'Jog_Fwd_Loop', sprint: 'Sprint_Loop', crouchIdle: 'Crouch_Idle_Loop', crouchWalk: 'Crouch_Fwd_Loop',
  jump: 'Jump_Start', fall: 'Jump_Loop', land: 'Jump_Land', slide: 'Slide_Loop', swimIdle: 'Swim_Idle_Loop', swim: 'Swim_Fwd_Loop', drive: 'Driving_Loop',
  sit: 'Sitting_Idle_Loop', freefall: 'NinjaJump_Idle_Loop', downed: 'LayToIdle', dead: 'Death01', zombieIdle: 'Zombie_Idle_Loop', zombieWalk: 'Zombie_Walk_Fwd_Loop',
  zombieRun: 'Jog_Fwd_Loop', dance: 'Dance_Loop', lobby: 'Idle_FoldArms_Loop', climb: 'ClimbUp_1m', revive: 'Fixing_Kneeling',
  talk: 'Idle_Talking_Loop', phone: 'Idle_TalkingPhone_Loop', rail: 'Idle_Rail_Loop', carry: 'Walk_Carry_Loop',
};
const UPPER_CLIPS: Record<Exclude<UpperState, 'none'>, string> = {
  aim: 'Pistol_Aim_Neutral', hold: 'Pistol_Idle_Loop', shoot: 'Pistol_Shoot', reload: 'Pistol_Reload', throw: 'OverhandThrow', consume: 'Consume',
  melee: 'Punch_Jab', pickup: 'PickUp_Table', zombieAttack: 'Zombie_Scratch', hit: 'Hit_Chest', hitHead: 'Hit_Head', chest: 'Chest_Open', no: 'Idle_No_Loop', yes: 'Yes',
};
const ONE_SHOT = new Set<string>(['Jump_Start', 'Jump_Land', 'Death01', 'LayToIdle', 'ClimbUp_1m', 'Pistol_Shoot', 'Pistol_Reload', 'OverhandThrow', 'Consume', 'Punch_Jab', 'PickUp_Table', 'Zombie_Scratch', 'Hit_Chest', 'Hit_Head', 'Chest_Open', 'Yes', 'Punch_Cross']);
const LOCOMOTION = new Set<LocoState>(['walk', 'jog', 'sprint', 'crouchWalk']);

interface ClipSet { full: Map<string, THREE.AnimationClip>; upper: Map<string, THREE.AnimationClip>; lower: Map<string, THREE.AnimationClip> }
let clipCache: ClipSet | null = null;

function buildClipSet(clips: THREE.AnimationClip[]): ClipSet {
  const full = new Map<string, THREE.AnimationClip>(), upper = new Map<string, THREE.AnimationClip>(), lower = new Map<string, THREE.AnimationClip>();
  for (const c of clips) {
    full.set(c.name, c);
    upper.set(c.name, new THREE.AnimationClip(c.name + '_U', c.duration, c.tracks.filter((t) => UPPER.test(t.name.split('.')[0]))));
    lower.set(c.name, new THREE.AnimationClip(c.name + '_L', c.duration, c.tracks.filter((t) => !UPPER.test(t.name.split('.')[0]))));
  }
  return { full, upper, lower };
}

const tintCache = new Map<string, THREE.Material>();
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qc = new THREE.Quaternion(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();

/** damped spring (critically-ish damped), used for flinch / recoil / landing impulses */
class Spring { x = 0; v = 0; constructor(public k = 120, public c = 14) {} kick(i: number) { this.v += i; } step(dt: number) { this.v += (-this.k * this.x - this.c * this.v) * dt; this.x += this.v * dt; return this.x; } }

/** per-frame procedural animation inputs (set by Soldier / Zombie / Lobby) */
export interface ProcInput {
  move: THREE.Vector2; // local velocity (x = right, y = forward) m/s
  yawRate: number;
  aimPitch: number;
  lookAt: THREE.Vector3 | null;
  breath: number; // 0 calm .. 1 out of breath
  kind: 'soldier' | 'zombie' | 'lobby';
}

/**
 * Skinned character with layered animation (lower body locomotion + upper body overrides) and a
 * procedural layer on top of the clips that makes characters feel alive:
 *  - directional locomotion: hips twist toward the movement direction, spine counter-twists to keep
 *    aiming, backwards walking plays the cycle in reverse
 *  - breathing (stronger after sprinting), shoulder rise, idle weight shifts & glances
 *  - head look-at, aim pitch through the spine, body lean into turns and acceleration
 *  - spring-driven hit flinches, upper-body recoil, landing compression
 *  - zombie lurch & head tilt, directional deaths and explosion knock-back with tumble
 * Gear (helmet / vest / backpack) is attached to bones in bind pose so it follows any rig.
 */
export class CharacterModel {
  root = new THREE.Group();
  inner!: THREE.Object3D;
  mixer!: THREE.AnimationMixer;
  private lowerActions = new Map<string, THREE.AnimationAction>();
  private upperActions = new Map<string, THREE.AnimationAction>();
  private curLower: THREE.AnimationAction | null = null;
  private curUpper: THREE.AnimationAction | null = null;
  loco: LocoState = 'idle';
  upper: UpperState = 'none';
  handR: THREE.Object3D | null = null;
  spine: THREE.Object3D | null = null;
  head: THREE.Object3D | null = null;
  held: THREE.Object3D | null = null;
  aimPitch = 0;
  private accum = 0;
  private upperTimer = 0;
  ready = false;
  facingFix = 0;
  meshes: THREE.Mesh[] = [];
  upperBase: UpperState = 'none';
  private own: Record<string, string> | null = null;
  private bones: Record<string, THREE.Object3D | null> = {};
  proc: ProcInput = { move: new THREE.Vector2(), yawRate: 0, aimPitch: 0, lookAt: null, breath: 0, kind: 'soldier' };
  private t = Math.random() * 100;
  private twist = 0;
  private reversed = false;
  private headYaw = 0; private headPitch = 0;
  private glanceT = 2 + Math.random() * 4; private glanceYaw = 0;
  private flinchP = new Spring(160, 16); private flinchR = new Spring(160, 16); private recoil = new Spring(220, 22); private dip = new Spring(140, 14);
  private lean = 0;
  // death physics
  private deathVel: THREE.Vector3 | null = null;
  private deathSpin = new THREE.Vector3();
  groundFn: ((x: number, z: number) => number) | null = null;
  gear: THREE.Object3D[] = [];

  static async preload(assets: AssetManager) {
    if (!clipCache) clipCache = buildClipSet(await assets.characterClips());
  }

  async init(assets: AssetManager, modelId: string, tint?: number, extraClips?: THREE.AnimationClip[]) {
    await CharacterModel.preload(assets);
    this.inner = await assets.instance(modelId);
    const ownClips: THREE.AnimationClip[] = this.inner.userData.animations ?? [];
    if (modelId === 'zombie_hazmat' && ownClips.length) {
      this.own = { zombieWalk: 'Zombie_Walk_Root', zombieRun: 'Zombie_Walk_Root', zombieIdle: 'Zombie_Idle', idle: 'Zombie_Idle', zombieAttack: 'Zombie_Skill', dead: 'Zombie_EnemySpotted', downed: 'Zombie_Idle' };
    }
    this.inner.rotation.y = this.facingFix;
    this.root.add(this.inner);
    this.inner.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        this.meshes.push(m);
        if ((m as THREE.SkinnedMesh).isSkinnedMesh) {
          // frustum culling with a generous bound (cheap, big win with 100 characters)
          m.frustumCulled = true;
          (m as THREE.SkinnedMesh).computeBoundingSphere();
          const bs = (m as THREE.SkinnedMesh).boundingSphere;
          if (bs) bs.radius *= 1.8;
        }
        if (tint !== undefined) {
          const key = `${(m.material as THREE.Material).uuid}:${tint}`;
          let mat = tintCache.get(key);
          if (!mat) {
            mat = (m.material as THREE.Material).clone();
            const mm = mat as THREE.MeshStandardMaterial;
            if (mm.color) mm.color.setHex(tint);
            if (mm.isMeshStandardMaterial) { mm.roughness = 0.62; mm.metalness = 0.05; }
            tintCache.set(key, mat);
          }
          m.material = mat;
        }
      }
      if (o.name === 'hand_r') this.handR = o;
      if (o.name === 'spine_03') this.spine = o;
      if (o.name === 'Head') this.head = o;
      if (['pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'Head', 'clavicle_l', 'clavicle_r'].includes(o.name)) this.bones[o.name] = o;
    });
    this.mixer = new THREE.AnimationMixer(this.inner);
    if (this.own) {
      for (const c of ownClips) {
        const clip = c.clone();
        clip.tracks = clip.tracks.filter((t) => !(t.name.endsWith('.position') && /root|hips|pelvis|armature/i.test(t.name)));
        this.lowerActions.set(c.name, this.mixer.clipAction(clip));
      }
      this.setLoco('zombieWalk', 0);
      this.ready = true;
      return this;
    }
    const set = clipCache!;
    for (const [name, clip] of set.lower) {
      const a = this.mixer.clipAction(clip);
      if (ONE_SHOT.has(name)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      this.lowerActions.set(name, a);
    }
    for (const [name, clip] of set.upper) {
      const a = this.mixer.clipAction(clip);
      if (ONE_SHOT.has(name)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      this.upperActions.set(name, a);
    }
    if (extraClips) for (const c of extraClips) this.lowerActions.set(c.name, this.mixer.clipAction(c));
    this.setLoco('idle', 0);
    this.ready = true;
    return this;
  }

  /** helmet / plate carrier / backpack, placed in bind pose and re-parented to the bones */
  async addGear(assets: AssetManager, tint = 0x4a5236) {
    if (!this.bones.Head || !this.bones.spine_03 || this.own) return;
    this.root.updateMatrixWorld(true);
    const mat = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.8, metalness: 0.05 });
    const add = async (id: string, bone: THREE.Object3D, offset: THREE.Vector3, scale = 1) => {
      try {
        const g = await assets.instance(id);
        g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { const src = m.material as THREE.MeshStandardMaterial; const nm = mat.clone(); nm.map = src.map ?? null; nm.normalMap = src.normalMap ?? null; nm.color.setHex(tint); m.material = nm; m.castShadow = true; } });
        const bp = bone.getWorldPosition(new THREE.Vector3());
        const rootQ = this.root.getWorldQuaternion(new THREE.Quaternion());
        g.position.copy(bp).add(offset.clone().applyQuaternion(rootQ));
        g.quaternion.copy(rootQ);
        g.scale.multiplyScalar(scale);
        this.root.add(g); g.updateMatrixWorld(true);
        bone.attach(g);
        this.gear.push(g);
      } catch { /* optional */ }
    };
    const s = this.root.scale.y;
    await add('gear_helmet', this.bones.Head, new THREE.Vector3(0, 0.11 * s, 0.012 * s), 1.05);
    await add('gear_vest', this.bones.spine_03, new THREE.Vector3(0, -0.2 * s, 0.035 * s), 0.98);
    await add('gear_backpack', this.bones.spine_03, new THREE.Vector3(0, -0.2 * s, -0.2 * s), 0.85);
  }

  private play(map: Map<string, THREE.AnimationAction>, name: string, cur: THREE.AnimationAction | null, fade: number, speed = 1) {
    const a = map.get(name);
    if (!a) return cur;
    if (a === cur) { a.timeScale = speed; return cur; }
    a.reset();
    a.timeScale = speed;
    a.enabled = true;
    a.setEffectiveWeight(1);
    a.play();
    if (cur && fade > 0) cur.crossFadeTo(a, fade, false);
    else if (cur) cur.stop();
    return a;
  }

  setLoco(s: LocoState, fade = 0.2, speed = 1) {
    const sp = this.reversed && LOCOMOTION.has(s) ? -speed : speed;
    if (this.own) {
      if (s === this.loco && this.curLower) { this.curLower.timeScale = speed; return; }
      this.loco = s;
      const name = this.own[s] ?? this.own.zombieWalk;
      this.curLower = this.play(this.lowerActions, name, this.curLower, fade, speed);
      if (s === 'dead' && this.curLower) { this.curLower.setLoop(THREE.LoopOnce, 1); this.curLower.clampWhenFinished = true; }
      return;
    }
    if (s === this.loco && this.curLower) { this.curLower.timeScale = sp; if (this.upper === 'none' && this.curUpper) this.curUpper.timeScale = sp; return; }
    this.loco = s;
    const clip = LOCO_CLIPS[s];
    this.curLower = this.play(this.lowerActions, clip, this.curLower, fade, sp);
    if (this.upper === 'none') this.curUpper = this.play(this.upperActions, clip, this.curUpper, fade, sp);
  }

  setUpper(s: UpperState, fade = 0.12, duration = 0, speed = 1) {
    if (this.own) { if (s === 'zombieAttack') { const a = this.lowerActions.get(this.own.zombieAttack); if (a) { a.reset().setLoop(THREE.LoopOnce, 1).play(); a.weight = 1; } } return; }
    if (s === this.upper && duration === 0) return;
    this.upper = s;
    this.upperTimer = duration;
    const clip = s === 'none' ? LOCO_CLIPS[this.loco] : UPPER_CLIPS[s];
    this.curUpper = this.play(this.upperActions, clip, this.curUpper, fade, speed);
    if (s !== 'none' && this.curUpper && duration > 0) {
      const dur = this.curUpper.getClip().duration;
      this.curUpper.timeScale = speed * (dur / duration);
    }
  }

  attach(obj: THREE.Object3D | null, pos = new THREE.Vector3(0.02, 0.06, 0.03), rot = new THREE.Euler(0, Math.PI / 2, Math.PI / 2)) {
    if (this.held) this.held.removeFromParent();
    this.held = obj;
    if (obj && this.handR) {
      obj.position.copy(pos);
      obj.rotation.copy(rot);
      const ws = new THREE.Vector3();
      this.handR.getWorldScale(ws);
      const rs = new THREE.Vector3(); this.root.getWorldScale(rs);
      obj.scale.setScalar(rs.x / (ws.x || 1));
      this.handR.add(obj);
    }
  }

  // ------------------------------------------------------------------ procedural impulses
  flinch(dirWorld: THREE.Vector3, strength = 1) {
    const inv = this.root.getWorldQuaternion(qa).invert();
    const d = v1.copy(dirWorld).applyQuaternion(inv);
    this.flinchP.kick(-d.z * 6 * strength); // shot from the front pushes the chest back
    this.flinchR.kick(d.x * 6 * strength);
  }
  recoilKick(k = 1) { this.recoil.kick(-5 * k); }
  landKick(k = 1) { this.dip.kick(4 * k); }
  /** knock the body away (explosions / vehicle hits) – tumbles until it settles on the ground */
  launch(vel: THREE.Vector3) { this.deathVel = vel.clone(); this.deathSpin.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 8); }

  /** rotate a bone around an axis given in character space (independent of the rig's bone axes) */
  private rotBone(b: THREE.Object3D | null | undefined, axis: THREE.Vector3, angle: number) {
    if (!b || !angle || !b.parent) return;
    const rootQ = this.inner.getWorldQuaternion(qa);
    const parentQ = b.parent.getWorldQuaternion(qb);
    const worldAxis = v2.copy(axis).applyQuaternion(rootQ);
    const r = qc.setFromAxisAngle(worldAxis, angle);
    // local = parent^-1 * R * parent * local
    const pInv = qb.clone().invert();
    b.quaternion.premultiply(pInv.multiply(r).multiply(parentQ));
    b.updateMatrixWorld(true);
  }

  private procedural(dt: number) {
    const p = this.proc, B = this.bones;
    this.t += dt;
    const speed = p.move.length();
    const dead = this.loco === 'dead' || this.loco === 'downed';
    this.inner.updateMatrixWorld(true);
    // -- directional locomotion (hip twist + spine counter twist)
    let twistT = 0;
    const moving = LOCOMOTION.has(this.loco) && speed > 0.4;
    if (moving && p.kind !== 'zombie') {
      const ang = Math.atan2(p.move.x, p.move.y); // 0 fwd, +right
      const back = Math.abs(ang) > 1.95;
      if (back !== this.reversed) { this.reversed = back; const l = this.loco; this.loco = 'idle'; this.setLoco(l, 0.15, Math.abs(this.curLower?.timeScale ?? 1)); }
      twistT = THREE.MathUtils.clamp(back ? Math.atan2(Math.sin(ang - Math.PI), Math.cos(ang - Math.PI)) : ang, -1.2, 1.2);
    } else if (this.reversed) { this.reversed = false; const l = this.loco; this.loco = 'idle'; this.setLoco(l, 0.15); }
    this.twist = THREE.MathUtils.lerp(this.twist, twistT, Math.min(1, dt * 8));
    if (Math.abs(this.twist) > 0.01) {
      this.rotBone(B.pelvis, AY, -this.twist);
      this.rotBone(B.spine_01, AY, this.twist * 0.5);
      this.rotBone(B.spine_02, AY, this.twist * 0.3);
      this.rotBone(B.spine_03, AY, this.twist * 0.2);
    }
    // -- body lean into turns & acceleration (whole body around the feet)
    const leanT = THREE.MathUtils.clamp(-p.yawRate * Math.min(speed, 8) * 0.035, -0.22, 0.22);
    this.lean = THREE.MathUtils.lerp(this.lean, dead ? 0 : leanT, Math.min(1, dt * 5));
    this.inner.rotation.z = this.lean;
    // -- breathing & shoulders
    const rate = 1.4 + p.breath * 2.4;
    const amp = (0.012 + p.breath * 0.035) * (speed < 1 ? 1 : 0.4);
    const br = Math.sin(this.t * rate);
    if (!dead) {
      this.rotBone(B.spine_02, AX, -br * amp);
      this.rotBone(B.clavicle_l, AZ, br * amp * 0.8);
      this.rotBone(B.clavicle_r, AZ, -br * amp * 0.8);
    }
    // -- aim pitch through the spine
    if (p.aimPitch && !dead && this.loco !== 'drive') {
      this.rotBone(B.spine_02, AX, -p.aimPitch * 0.3);
      this.rotBone(B.spine_03, AX, -p.aimPitch * 0.35);
    }
    // -- springs: flinch, recoil, landing
    const fp = this.flinchP.step(dt), fr = this.flinchR.step(dt), rc = this.recoil.step(dt), dp = this.dip.step(dt);
    if (!dead) {
      this.rotBone(B.spine_02, AX, fp * 0.08 + dp * 0.05);
      this.rotBone(B.spine_02, AZ, fr * 0.08);
      this.rotBone(B.spine_03, AX, rc * 0.04);
    }
    // -- zombie lurch
    if (p.kind === 'zombie' && !dead) {
      this.rotBone(B.spine_02, AZ, Math.sin(this.t * 1.3) * 0.1);
      this.rotBone(B.spine_01, AY, Math.sin(this.t * 0.9 + 1.7) * 0.12);
      this.rotBone(B.neck_01, AZ, 0.2 + Math.sin(this.t * 0.7) * 0.15);
      this.rotBone(B.Head, AX, Math.sin(this.t * 2.3) * 0.08);
    }
    // -- head look / idle glances
    let wantYaw = 0, wantPitch = 0;
    if (p.lookAt && B.Head && !dead) {
      const hp = B.Head.getWorldPosition(v1);
      const d = v2.copy(p.lookAt).sub(hp).applyQuaternion(this.inner.getWorldQuaternion(qa).invert());
      wantYaw = THREE.MathUtils.clamp(Math.atan2(d.x, d.z), -1.1, 1.1);
      wantPitch = THREE.MathUtils.clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)), -0.6, 0.5);
      if (Math.abs(Math.atan2(d.x, d.z)) > 2.2) wantYaw = 0;
    } else if (speed < 0.3 && p.kind !== 'zombie' && !dead) {
      this.glanceT -= dt;
      if (this.glanceT <= 0) { this.glanceT = 2 + Math.random() * 5; this.glanceYaw = Math.random() < 0.4 ? 0 : (Math.random() - 0.5) * 1.6; }
      wantYaw = this.glanceYaw;
      this.inner.rotation.z += Math.sin(this.t * 0.45) * 0.015; // weight shift
    }
    this.headYaw = THREE.MathUtils.lerp(this.headYaw, wantYaw, Math.min(1, dt * 4));
    this.headPitch = THREE.MathUtils.lerp(this.headPitch, wantPitch, Math.min(1, dt * 4));
    if (Math.abs(this.headYaw) > 0.005 || Math.abs(this.headPitch) > 0.005) {
      this.rotBone(B.neck_01, AY, this.headYaw * 0.4);
      this.rotBone(B.Head, AY, this.headYaw * 0.6);
      this.rotBone(B.Head, AX, -this.headPitch * 0.7);
    }
  }

  update(dt: number, distToCam: number) {
    if (!this.ready) return;
    if (this.upperTimer > 0) {
      this.upperTimer -= dt;
      if (this.upperTimer <= 0) this.setUpper(this.upperBase, 0.15);
    }
    // death knock-back / tumble
    if (this.deathVel) {
      this.deathVel.y -= 18 * dt;
      this.inner.position.addScaledVector(this.deathVel, dt);
      this.inner.rotation.x += this.deathSpin.x * dt; this.inner.rotation.z += this.deathSpin.z * dt;
      const wp = this.inner.getWorldPosition(v1);
      const g = this.groundFn ? this.groundFn(wp.x, wp.z) : this.root.position.y;
      if (wp.y <= g + 0.05 && this.deathVel.y < 0) {
        this.inner.position.y += g + 0.05 - wp.y;
        this.deathVel.multiplyScalar(0.35); this.deathVel.y = Math.abs(this.deathVel.y) * 0.3; this.deathSpin.multiplyScalar(0.4);
        if (this.deathVel.length() < 0.6) { this.deathVel = null; this.inner.rotation.x = THREE.MathUtils.clamp(this.inner.rotation.x, -0.3, 0.3); this.inner.rotation.z = THREE.MathUtils.clamp(this.inner.rotation.z, -0.3, 0.3); }
      }
    }
    this.setLod(distToCam > (this.lodOn ? 30 : 36));
    const interval = distToCam < 30 ? 0 : distToCam < 80 ? 1 / 30 : distToCam < 160 ? 1 / 12 : 1 / 5;
    this.accum += dt;
    if (this.accum < interval) return;
    this.mixer.update(this.accum);
    if (distToCam < 45 && !this.own) this.procedural(this.accum);
    else if (this.spine && this.aimPitch && this.loco !== 'dead' && this.loco !== 'drive') this.spine.rotateX(-this.aimPitch * 0.6);
    for (const g of this.gear) g.visible = distToCam < 70;
    this.accum = 0;
  }

  /** low-poly body bound to this character's own skeleton, shown instead of the full mesh at range */
  private lodMesh: THREE.SkinnedMesh | null = null;
  private fullMeshes: THREE.Mesh[] = [];
  private lodOn = false;
  async addLod(assets: AssetManager, lodId = 'char_mannequin_lod') {
    const main = this.meshes.find((m) => (m as THREE.SkinnedMesh).isSkinnedMesh) as THREE.SkinnedMesh | undefined;
    if (!main || this.own) return;
    let src: THREE.SkinnedMesh | null = null;
    try { (await assets.instance(lodId)).traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh && !src) src = o as THREE.SkinnedMesh; }); } catch { return; }
    if (!src) return;
    const s = src as THREE.SkinnedMesh;
    if (s.skeleton.bones.length !== main.skeleton.bones.length) return;
    const lm = new THREE.SkinnedMesh(s.geometry, main.material);
    lm.position.copy(main.position); lm.quaternion.copy(main.quaternion); lm.scale.copy(main.scale);
    lm.bind(main.skeleton, main.bindMatrix);
    lm.castShadow = false; lm.receiveShadow = true;
    lm.frustumCulled = true;
    lm.computeBoundingSphere();
    if (lm.boundingSphere) lm.boundingSphere.radius *= 1.8;
    lm.visible = false;
    main.parent!.add(lm);
    this.lodMesh = lm;
    this.fullMeshes = this.meshes.filter((m) => (m as THREE.SkinnedMesh).isSkinnedMesh);
  }
  private setLod(on: boolean) {
    if (!this.lodMesh || on === this.lodOn) return;
    this.lodOn = on;
    this.lodMesh.visible = on;
    for (const m of this.fullMeshes) m.visible = !on;
  }

  resetPose() { this.inner.position.set(0, 0, 0); this.inner.rotation.set(0, this.facingFix, 0); this.deathVel = null; }
  setVisible(v: boolean) { this.root.visible = v; }
  dispose() { this.mixer?.stopAllAction(); this.root.removeFromParent(); }
}
