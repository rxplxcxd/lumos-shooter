import * as THREE from 'three';
import { Mode, type ModeOptions } from './Mode';
import type { GameWorld } from './GameWorld';
import { Soldier } from '../entities/Soldier';
import { BotBrain } from '../entities/BotBrain';
import { PlayerController } from '../entities/PlayerController';
import { Weapon } from '../weapons/Weapon';
import type { Loadout } from '../net/Profile';
import { Rng } from '../world/Noise';
import { QUALITY_PRESETS, settings } from '../core/Settings';
import type { Actor, DamageInfo } from './types';

export const TEAM_COLORS = [0x3a6ea5, 0xc0392b, 0x27ae60, 0xd4a017, 0x8e44ad, 0x16a085, 0xd35400, 0x7f8c8d];
const BOT_NAMES = ['Viper', 'Ghost', 'Rook', 'Nova', 'Blitz', 'Echo', 'Havoc', 'Onyx', 'Raven', 'Saber', 'Talon', 'Wraith', 'Kilo', 'Jinx', 'Maverick', 'Nyx', 'Orion', 'Pyro', 'Quill', 'Rogue', 'Spectre', 'Titan', 'Ursa', 'Vex', 'Warden', 'Xeno', 'Yeti', 'Zulu', 'Atlas', 'Bishop', 'Cipher', 'Dagger', 'Ember', 'Falcon', 'Gunner', 'Hex', 'Iris', 'Jett', 'Kodiak', 'Lynx'];

/** shared plumbing for modes with soldiers: player + bot spawning, AI ticking, loadouts. */
export abstract class SoldierMode extends Mode {
  bots: BotBrain[] = [];
  rng = new Rng(Date.now() & 0xffff);
  loadout: Loadout | null = null;
  playerName = 'You';
  playerModel = 'char_mannequin';
  playerTint = 0x3a6ea5;
  private aiAccum = 0;

  constructor(w: GameWorld, opts: ModeOptions & { seed?: number } = {}) { super(w, opts); if (opts.seed !== undefined) this.rng = new Rng(opts.seed); }

  async spawnPlayer(pos: THREE.Vector3, team = 0): Promise<PlayerController> {
    if (this.w.net) team = this.w.net.myTeam;
    const s = new Soldier(this.w, this.playerName, team, this.playerTint);
    s.isPlayer = true;
    await s.init(this.playerModel);
    s.spawnAt(pos);
    this.w.addActor(s);
    const pc = new PlayerController(this.w, s);
    this.w.player = pc;
    if (this.loadout) this.applyLoadout(s, this.loadout);
    return pc;
  }

  applyLoadout(s: Soldier, l: Loadout) {
    s.weapons[0] = new Weapon(l.primary.id, 1, l.primary.attachments);
    s.weapons[1] = new Weapon(l.secondary.id, 1, l.secondary.attachments);
    s.current = 0;
    for (const w of s.weapons) if (w) s.reserve[w.def.ammo] = Math.max(s.reserve[w.def.ammo] ?? 0, w.stats.mag * 3);
    s.perks = new Set(l.perks);
  }

  async spawnBot(team: number, pos: THREE.Vector3, skill = this.rng.range(0.25, 0.85), tint = TEAM_COLORS[team % TEAM_COLORS.length]): Promise<BotBrain> {
    const name = BOT_NAMES[this.bots.length % BOT_NAMES.length] + (this.bots.length >= BOT_NAMES.length ? `_${Math.floor(this.bots.length / BOT_NAMES.length)}` : '');
    const s = new Soldier(this.w, name, team, tint);
    // low-spec: distant bots use the simplified LOD mesh
    const lod = QUALITY_PRESETS[settings.data.quality].lowSpecMaterials;
    await s.init(lod ? 'char_mannequin_lod' : this.rng.pick(['char_mannequin', 'char_mannequin', 'char_mannequin_f']));
    if (!lod) await s.model.addLod(this.w.assets);
    s.spawnAt(pos);
    this.w.addActor(s);
    const b = new BotBrain(s, this.w, skill);
    b.home.copy(pos);
    this.bots.push(b);
    return b;
  }

  giveRandomKit(s: Soldier, tier = 1) {
    const loot = (this.w as any).loot;
    if (loot) {
      s.weapons[0] = loot.randomWeapon(Math.min(4, tier) as any);
      if (this.rng.chance(0.6)) s.weapons[1] = loot.randomWeapon(Math.max(0, tier - 1) as any);
    } else {
      s.weapons[0] = new Weapon(this.rng.pick(['kestrel', 'vanguard', 'raptor', 'ranger', 'wasp', 'hornet', 'brawler', 'dmr']), 1);
      s.weapons[1] = new Weapon(this.rng.pick(['viper', 'magnum']), 0);
    }
    for (const w of s.weapons) if (w) s.reserve[w.def.ammo] = w.stats.mag * 4;
  }

  /** per-frame: player + bots (AI thinking is staggered inside BotBrain) */
  tickSoldiers(dt: number) {
    const w = this.w;
    w.player?.update(dt);
    const cam = w.engine.camera.position;
    const far = QUALITY_PRESETS[settings.data.quality].drawDistance;
    this.aiAccum += dt;
    for (const b of this.bots) {
      const s = b.s;
      if (s.alive) b.update(dt);
      const d = s.pos.distanceTo(cam);
      const visible = d < far;
      s.model.root.visible = visible && (s.alive || d < 120);
      if (visible) s.animate(dt, d);
      else s.syncModel();
    }
    if (w.player) w.player.soldier.animate(dt, w.player.thirdPerson ? 3 : 0);
  }

  onKill(victim: Actor, info: DamageInfo) {
    // let bots hear the fight
    for (const b of this.bots) if (b.s.alive && b.s !== victim) b.hear(victim.pos, 90);
    if (victim === this.w.player?.soldier) {
      this.w.player.spectateTarget = info.attacker ?? null;
    }
  }

  /** gunshots alert bots */
  listenShots() {
    this.w.bus.on('shot', (e: { pos: THREE.Vector3; silenced: boolean }) => { for (const b of this.bots) b.hear(e.pos, e.silenced ? 25 : 140); });
    this.w.bus.on('playerFired', (s: Soldier) => { const loud = s.weapon.stats.silenced ? 25 : 150; for (const b of this.bots) b.hear(s.pos, loud); });
  }
}
