import * as THREE from 'three';
import type { AssetManager } from '../assets/AssetManager';

const UPPER = /^(spine_0[123]|neck_01|Head|clavicle_|upperarm_|lowerarm_|hand_|index_|middle_|pinky_|ring_|thumb_)/;

export type LocoState =
  | 'idle' | 'walk' | 'jog' | 'sprint' | 'crouchIdle' | 'crouchWalk' | 'jump' | 'fall' | 'land' | 'slide'
  | 'swimIdle' | 'swim' | 'drive' | 'sit' | 'freefall' | 'downed' | 'dead' | 'zombieIdle' | 'zombieWalk' | 'zombieRun' | 'dance' | 'lobby' | 'climb' | 'revive';
export type UpperState = 'none' | 'aim' | 'hold' | 'shoot' | 'reload' | 'throw' | 'consume' | 'melee' | 'pickup' | 'zombieAttack' | 'hit';

const LOCO_CLIPS: Record<LocoState, string> = {
  idle: 'Idle_Loop', walk: 'Walk_Loop', jog: 'Jog_Fwd_Loop', sprint: 'Sprint_Loop', crouchIdle: 'Crouch_Idle_Loop', crouchWalk: 'Crouch_Fwd_Loop',
  jump: 'Jump_Start', fall: 'Jump_Loop', land: 'Jump_Land', slide: 'Slide_Loop', swimIdle: 'Swim_Idle_Loop', swim: 'Swim_Fwd_Loop', drive: 'Driving_Loop',
  sit: 'Sitting_Idle_Loop', freefall: 'NinjaJump_Idle_Loop', downed: 'LayToIdle', dead: 'Death01', zombieIdle: 'Zombie_Idle_Loop', zombieWalk: 'Zombie_Walk_Fwd_Loop',
  zombieRun: 'Jog_Fwd_Loop', dance: 'Dance_Loop', lobby: 'Idle_FoldArms_Loop', climb: 'ClimbUp_1m', revive: 'Fixing_Kneeling',
};
const UPPER_CLIPS: Record<Exclude<UpperState, 'none'>, string> = {
  aim: 'Pistol_Aim_Neutral', hold: 'Pistol_Idle_Loop', shoot: 'Pistol_Shoot', reload: 'Pistol_Reload', throw: 'OverhandThrow', consume: 'Consume',
  melee: 'Punch_Jab', pickup: 'PickUp_Table', zombieAttack: 'Zombie_Scratch', hit: 'Hit_Chest',
};
const ONE_SHOT = new Set<string>(['Jump_Start', 'Jump_Land', 'Death01', 'LayToIdle', 'ClimbUp_1m', 'Pistol_Shoot', 'Pistol_Reload', 'OverhandThrow', 'Consume', 'Punch_Jab', 'PickUp_Table', 'Zombie_Scratch', 'Hit_Chest']);

interface ClipSet { full: Map<string, THREE.AnimationClip>; upper: Map<string, THREE.AnimationClip>; lower: Map<string, THREE.AnimationClip> }
let clipCache: ClipSet | null = null;

function buildClipSet(clips: THREE.AnimationClip[]): ClipSet {
  const full = new Map<string, THREE.AnimationClip>(), upper = new Map<string, THREE.AnimationClip>(), lower = new Map<string, THREE.AnimationClip>();
  for (const c of clips) {
    full.set(c.name, c);
    const up = c.tracks.filter((t) => UPPER.test(t.name.split('.')[0]));
    const lo = c.tracks.filter((t) => !UPPER.test(t.name.split('.')[0]));
    upper.set(c.name, new THREE.AnimationClip(c.name + '_U', c.duration, up));
    lower.set(c.name, new THREE.AnimationClip(c.name + '_L', c.duration, lo));
  }
  return { full, upper, lower };
}

const tintCache = new Map<string, THREE.Material>();

/**
 * Skinned character with layered animation: lower body plays locomotion, upper body can be
 * overridden by aim / reload / throw / consume clips. Supports tint (team colours), weapon
 * attachment to the right hand, procedural aim pitch on the spine, LOD + update throttling.
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

  static async preload(assets: AssetManager) {
    if (!clipCache) clipCache = buildClipSet(await assets.characterClips());
  }

  /** models with their own skeleton + clips (e.g. Sketchfab hazmat zombie): state -> clip name */
  private own: Record<string, string> | null = null;

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
        if (tint !== undefined) {
          const key = `${(m.material as THREE.Material).uuid}:${tint}`;
          let mat = tintCache.get(key);
          if (!mat) {
            mat = (m.material as THREE.Material).clone();
            const mm = mat as THREE.MeshStandardMaterial;
            if (mm.color) mm.color.setHex(tint);
            tintCache.set(key, mat);
          }
          m.material = mat;
        }
      }
      if (o.name === 'hand_r') this.handR = o;
      if (o.name === 'spine_03') this.spine = o;
      if (o.name === 'Head') this.head = o;
    });
    this.mixer = new THREE.AnimationMixer(this.inner);
    if (this.own) {
      for (const c of ownClips) {
        // strip root translation so the walk cycle stays in place
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
    if (extraClips) for (const c of extraClips) { const a = this.mixer.clipAction(c); this.lowerActions.set(c.name, a); }
    this.setLoco('idle', 0);
    this.ready = true;
    return this;
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
    if (this.own) {
      if (s === this.loco && this.curLower) { this.curLower.timeScale = speed; return; }
      this.loco = s;
      const name = this.own[s] ?? this.own.zombieWalk;
      this.curLower = this.play(this.lowerActions, name, this.curLower, fade, speed);
      if (s === 'dead' && this.curLower) { this.curLower.setLoop(THREE.LoopOnce, 1); this.curLower.clampWhenFinished = true; }
      return;
    }
    if (s === this.loco && this.curLower) { this.curLower.timeScale = speed; if (this.upper === 'none' && this.curUpper) this.curUpper.timeScale = speed; return; }
    this.loco = s;
    const clip = LOCO_CLIPS[s];
    this.curLower = this.play(this.lowerActions, clip, this.curLower, fade, speed);
    if (this.upper === 'none') this.curUpper = this.play(this.upperActions, clip, this.curUpper, fade, speed);
  }

  /** upper body override; duration>0 returns to `none` (or aim/hold) after that time */
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

  /** base upper pose when no one-shot is active */
  upperBase: UpperState = 'none';

  attach(obj: THREE.Object3D | null, pos = new THREE.Vector3(0.02, 0.06, 0.03), rot = new THREE.Euler(0, Math.PI / 2, Math.PI / 2)) {
    if (this.held) this.held.removeFromParent();
    this.held = obj;
    if (obj && this.handR) {
      obj.position.copy(pos);
      obj.rotation.copy(rot);
      // hand bone lives inside a scaled armature – compensate so weapons keep metric size
      const ws = new THREE.Vector3();
      this.handR.getWorldScale(ws);
      const rs = new THREE.Vector3(); this.root.getWorldScale(rs);
      obj.scale.setScalar(rs.x / (ws.x || 1));
      this.handR.add(obj);
    }
  }

  update(dt: number, distToCam: number) {
    if (!this.ready) return;
    if (this.upperTimer > 0) {
      this.upperTimer -= dt;
      if (this.upperTimer <= 0) this.setUpper(this.upperBase, 0.15);
    }
    // animation LOD: update far characters at reduced rate
    const interval = distToCam < 30 ? 0 : distToCam < 80 ? 1 / 30 : distToCam < 160 ? 1 / 12 : 1 / 5;
    this.accum += dt;
    if (this.accum < interval) return;
    this.mixer.update(this.accum);
    this.accum = 0;
    if (this.spine && this.aimPitch && this.loco !== 'dead' && this.loco !== 'drive') {
      this.spine.rotateX(-this.aimPitch * 0.6);
    }
  }

  setVisible(v: boolean) { this.root.visible = v; }
  dispose() { this.mixer?.stopAllAction(); this.root.removeFromParent(); }
}
