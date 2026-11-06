import type * as THREE from 'three';

export type HitZone = 'head' | 'body' | 'legs';
export interface DamageInfo {
  attacker?: Actor | null;
  weapon?: string;
  zone?: HitZone;
  dir?: THREE.Vector3;
  point?: THREE.Vector3;
  explosive?: boolean;
  melee?: boolean;
  storm?: boolean;
  vehicle?: boolean;
}

export interface Actor {
  id: number;
  name: string;
  team: number;
  kind: 'soldier' | 'zombie';
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  alive: boolean;
  downed: boolean;
  health: number;
  maxHealth: number;
  armor: number;
  isPlayer: boolean;
  radius: number;
  height: number;
  /** ray vs. hit-capsules; returns nearest hit */
  hitTest(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { dist: number; zone: HitZone } | null;
  damage(amount: number, info: DamageInfo): number;
  eyePos(out: THREE.Vector3): THREE.Vector3;
  /** set by AI / match for minimap + scoreboard */
  kills: number;
  score: number;
  lastHitTime: number;
  inVehicle: unknown | null;
  silencedUntil?: number;
  lastShotTime?: number;
}
