import type { GameWorld } from './GameWorld';
import type { Actor, DamageInfo } from './types';
import type { Soldier } from '../entities/Soldier';

export interface HudInfo {
  title?: string;
  objective?: string;
  timer?: number;
  alive?: number;
  teams?: { name: string; score: number; color: string }[];
  round?: number;
  points?: number;
  zone?: { x: number; z: number; r: number; nx: number; nz: number; nr: number; shrinking: boolean; next: number } | null;
}

export interface ModeOptions {
  sub?: string; // solos / duos / trios / quads / sniper / cqb / hightier / extraction / tdm / ffa / ctf / snd
  map?: string;
  bots?: number;
  night?: boolean;
  /** shared match seed (multiplayer) */
  seed?: number;
}

/** Base class for all game modes (BR, Zombie Royale, MP, round-based Zombies). */
export abstract class Mode {
  abstract readonly id: string;
  abstract readonly name: string;
  friendlyFire = false;
  infiniteAmmo = false;
  healthRegen = true;
  allowDBNO = false;
  respawns = false;
  over = false;
  result: { win: boolean; place?: number; text: string; xp: number; coins: number } | null = null;
  w: GameWorld;
  opts: ModeOptions;
  constructor(w: GameWorld, opts: ModeOptions = {}) { this.w = w; this.opts = opts; }
  abstract setup(onProgress: (p: number, label: string) => void): Promise<void>;
  update(_dt: number) {}
  onKill(_victim: Actor, _info: DamageInfo) {}
  canDamage(_t: Actor, _i: DamageInfo) { return true; }
  allowDowned(s: Soldier) {
    if (!this.allowDBNO) return false;
    return this.w.soldiers.some((o) => o !== s && o.alive && !o.downed && o.team === s.team);
  }
  hud(): HudInfo { return {}; }
  /** multiplayer: does this client run the simulation (host or offline)? */
  get authority() { return !this.w.net || this.w.net.host; }
  /** host -> clients mode state (snapshot) */
  netState(): Record<string, unknown> | null { return null; }
  applyNetState(_s: Record<string, unknown>) {}
  /** what happens when the local player dies */
  playerDied(): 'respawn' | 'spectate' { return this.respawns ? 'respawn' : 'spectate'; }
  respawnPlayer() {}
  finish(win: boolean, text: string, place?: number) {
    if (this.over) return;
    this.over = true;
    const kills = this.w.player?.soldier.kills ?? 0;
    const xp = 250 + kills * 120 + (win ? 1500 : 0) + (place ? Math.max(0, 100 - place) * 8 : 0);
    const coins = Math.round(xp / 25);
    this.result = { win, place, text, xp, coins };
    this.w.bus.emit('matchOver', this.result);
  }
}
