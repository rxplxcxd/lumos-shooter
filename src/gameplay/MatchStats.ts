import * as THREE from 'three';
import type { GameWorld } from './GameWorld';
import type { Actor } from './types';

export interface Medal { id: string; name: string; xp: number; icon: string; sub?: string }

const MEDALS: Record<string, Omit<Medal, 'id'>> = {
  firstblood: { name: 'FIRST BLOOD', xp: 100, icon: '✶' },
  double: { name: 'DOPPEL-KILL', xp: 75, icon: '✦✦' },
  triple: { name: 'TRIPLE-KILL', xp: 150, icon: '✦✦✦' },
  quad: { name: 'MULTI-KILL', xp: 250, icon: '✸' },
  frenzy: { name: 'KILL-RAUSCH', xp: 400, icon: '☄' },
  spree: { name: 'SERIE ×5', xp: 200, icon: '🔥' },
  rampage: { name: 'UNAUFHALTBAR', xp: 500, icon: '⚡' },
  headshot: { name: 'KOPFSCHUSS', xp: 25, icon: '⊕' },
  longshot: { name: 'WEITSCHUSS', xp: 75, icon: '◎' },
  pointblank: { name: 'NAHDISTANZ', xp: 25, icon: '✚' },
  knife: { name: 'HINRICHTUNG', xp: 75, icon: '†' },
  collateral: { name: 'KOLLATERAL', xp: 150, icon: '💥' },
  revenge: { name: 'RACHE', xp: 75, icon: '↺' },
  clutch: { name: 'ÜBERLEBENSKÜNSTLER', xp: 100, icon: '♥' },
  horde: { name: 'HORDENBRECHER', xp: 50, icon: '☠' },
};

/**
 * Per-match player statistics and the medal system: multi-kills, streaks, head- and long shots,
 * revenge, collateral explosions, clutch kills… Medals pop on the HUD (bus 'medal') and add
 * bonus XP; the summary feeds the end-of-match screen.
 */
export class MatchStats {
  shots = 0; hits = 0; headshots = 0; damage = 0; kills = 0; zombieKills = 0;
  longest = 0; travelled = 0; drove = 0;
  medals: Medal[] = [];
  bonusXp = 0;
  startT = 0; deathT = -1;
  private chain = 0; private chainT = -10; private zChain = 0; private zChainT = -10;
  private streak = 0; private anyKill = false; private lastKiller: Actor | null = null;
  private boomT = -10; private boomN = 0;
  private lastPos = new THREE.Vector3(); private hasPos = false;

  constructor(private w: GameWorld) {
    const b = w.bus;
    b.on('playerFired', () => { this.shots++; });
    b.on('hitmarker', (e: { dealt: number; zone: string }) => { this.hits++; this.damage += e.dealt; if (e.zone === 'head') this.headshots++; });
    b.on('kill', (e: { victim: Actor; killer: Actor | null; info?: { zone?: string; explosive?: boolean; weapon?: string } }) => this.onKill(e));
  }

  private onKill(e: { victim: Actor; killer: Actor | null; info?: { zone?: string; explosive?: boolean; weapon?: string } }) {
    const w = this.w, p = w.player?.soldier;
    if (!p) return;
    if (e.victim === p) { this.streak = 0; this.lastKiller = e.killer; this.deathT = w.time; return; }
    const soldier = e.victim.kind === 'soldier';
    if (soldier && e.killer && !this.anyKill) { this.anyKill = true; if (e.killer === p) this.medal('firstblood'); }
    if (e.killer !== p) return;
    if (!soldier) {
      // zombies: only reward big chains, otherwise every round would be medal spam
      this.zombieKills++;
      this.zChain = w.time - this.zChainT < 3 ? this.zChain + 1 : 1; this.zChainT = w.time;
      if (this.zChain === 5 || this.zChain === 10) this.medal('horde', `${this.zChain} in Folge`);
      return;
    }
    this.kills++;
    const dist = e.victim.pos.distanceTo(p.pos);
    this.longest = Math.max(this.longest, dist);
    this.chain = w.time - this.chainT < 4.5 ? this.chain + 1 : 1; this.chainT = w.time;
    if (this.chain === 2) this.medal('double'); else if (this.chain === 3) this.medal('triple'); else if (this.chain === 4) this.medal('quad'); else if (this.chain >= 5) this.medal('frenzy');
    this.streak++;
    if (this.streak === 5) this.medal('spree'); else if (this.streak === 10) this.medal('rampage');
    if (e.info?.zone === 'head') this.medal('headshot');
    if (dist > 120) this.medal('longshot', `${Math.round(dist)} m`);
    if (e.info?.weapon === 'knife') this.medal('knife');
    else if (dist < 3) this.medal('pointblank');
    if (e.info?.explosive) {
      if (w.time - this.boomT < 0.2) { this.boomN++; if (this.boomN === 2) this.medal('collateral'); } else { this.boomT = w.time; this.boomN = 1; }
    }
    if (this.lastKiller && e.victim === this.lastKiller) { this.medal('revenge'); this.lastKiller = null; }
    if (p.alive && p.health < 25) this.medal('clutch');
  }

  medal(id: string, sub?: string) {
    const def = MEDALS[id];
    if (!def) return;
    const m: Medal = { id, ...def, sub };
    this.medals.push(m);
    this.bonusXp += m.xp;
    this.w.bus.emit('medal', m);
  }

  update() {
    const p = this.w.player?.soldier;
    if (!p || !p.alive) return;
    if (this.hasPos && !p.freefall) {
      const d = Math.hypot(p.pos.x - this.lastPos.x, p.pos.z - this.lastPos.z);
      if (d < 30) { if (p.inVehicle) this.drove += d; else this.travelled += d; }
    }
    this.lastPos.copy(p.pos); this.hasPos = true;
  }

  get accuracy() { return this.shots ? Math.min(1, this.hits / this.shots) : 0; }
}
