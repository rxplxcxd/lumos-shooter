import * as THREE from 'three';
import { SoldierMode, TEAM_COLORS } from '../SoldierMode';
import type { ModeOptions, HudInfo } from '../Mode';
import type { GameWorld } from '../GameWorld';
import { buildArena, type MapInfo } from '../../world/Maps';
import type { Actor, DamageInfo } from '../types';
import type { Soldier } from '../../entities/Soldier';
import { Weapon } from '../../weapons/Weapon';

type Sub = 'tdm' | 'ffa' | 'ctf' | 'snd';

/**
 * CoD-style multiplayer on a compact 3-lane map: Team Deathmatch, Free-for-All,
 * Capture the Flag and Search & Destroy. Tactical respawns, scorestreaks
 * (UAV / Care Package / Cluster Strike), loadouts from the Gunsmith.
 */
export class Multiplayer extends SoldierMode {
  readonly id = 'mp';
  readonly name: string;
  sub: Sub;
  map!: MapInfo;
  scores = [0, 0];
  scoreLimit: number;
  timeLimit = 600;
  elapsed = 0;
  streak = 0;
  streakReady: string | null = null;
  uavUntil = 0;
  private respawnQ: { s: Soldier; t: number }[] = [];
  flags: { team: number; home: THREE.Vector3; pos: THREE.Vector3; carrier: Soldier | null; obj: THREE.Object3D | null }[] = [];
  bomb = { planted: false, site: '', timer: 0, defuse: 0, carrier: null as Soldier | null, pos: new THREE.Vector3() };
  sites: { id: string; pos: THREE.Vector3 }[] = [];
  round = 1;
  roundWins = [0, 0];

  constructor(w: GameWorld, opts: ModeOptions = {}) {
    super(w, opts);
    this.sub = (opts.sub as Sub) ?? 'tdm';
    this.name = { tdm: 'Team Deathmatch', ffa: 'Free-for-All', ctf: 'Capture the Flag', snd: 'Search & Destroy' }[this.sub];
    this.respawns = this.sub !== 'snd';
    this.scoreLimit = this.sub === 'tdm' ? 50 : this.sub === 'ffa' ? 25 : this.sub === 'ctf' ? 3 : 4;
    this.healthRegen = true;
  }

  async setup(progress: (p: number, l: string) => void) {
    const w = this.w;
    this.map = await buildArena(w, 99, (p, l) => progress(p * 0.7, l), this.opts.night);
    this.listenShots();
    const perTeam = this.opts.bots ?? 6;
    progress(0.75, 'Teams');
    const team = (i: number) => (this.sub === 'ffa' ? i : i % 2);
    const pc = await this.spawnPlayer(this.spawnPoint(0), 0);
    pc.yaw = Math.PI; // face the enemy side
    const lanes: THREE.Vector3[] = [];
    for (const x of [-52, -18, 0, 18, 52]) for (const z of [-70, -35, 0, 35, 70]) lanes.push(new THREE.Vector3(x, 5, z));
    const total = perTeam * 2 - 1;
    for (let i = 1; i <= total; i++) {
      const t = team(i);
      const b = await this.spawnBot(t, this.spawnPoint(t), 0.35 + this.rng.next() * 0.45, this.sub === 'ffa' ? TEAM_COLORS[i % TEAM_COLORS.length] : TEAM_COLORS[t]);
      this.giveRandomKit(b.s, 2);
      b.roamRadius = 90;
      b.home.set(0, 0, 0);
      b.aggressive = 0.8;
      b.waypoints = lanes;
      b.pickRoam();
    }
    if (this.sub === 'ctf') await this.setupFlags();
    if (this.sub === 'snd') this.setupBombSites();
    w.audio.playMusic('tension');
    progress(1, 'Bereit');
  }

  private spawnPoint(team: number) {
    const ts = this.map.teamSpawns!;
    if (this.sub === 'ffa') {
      // farthest from enemies
      let best = this.map.spawnPoints[0], bd = -1;
      for (const p of this.map.spawnPoints) {
        let md = 1e9;
        for (const s of this.w.soldiers) if (s.alive) md = Math.min(md, s.pos.distanceTo(p));
        if (md > bd) { bd = md; best = p; }
      }
      return best.clone();
    }
    const list = ts[team % 2];
    return list[Math.floor(this.rng.next() * list.length)].clone();
  }

  private async setupFlags() {
    for (const t of [0, 1]) {
      const home = new THREE.Vector3(0, 5, t === 0 ? -92 : 92);
      const obj = await this.w.assets.instance('item_supply');
      obj.scale.setScalar(1.4);
      obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { const mat = (m.material as THREE.MeshStandardMaterial).clone(); mat.emissive = new THREE.Color(TEAM_COLORS[t]); mat.emissiveIntensity = 0.7; m.material = mat; } });
      obj.position.copy(home);
      this.w.root.add(obj);
      this.flags.push({ team: t, home, pos: home.clone(), carrier: null, obj });
    }
  }

  private setupBombSites() {
    this.sites = [{ id: 'A', pos: new THREE.Vector3(-45, 5, 60) }, { id: 'B', pos: new THREE.Vector3(45, 5, 55) }];
    for (const s of this.sites) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(4, 4.4, 48), new THREE.MeshBasicMaterial({ color: 0xff4040, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.copy(s.pos).setY(5.05);
      this.w.root.add(ring);
      this.w.interactables.push({
        pos: s.pos, radius: 4, hold: 3,
        label: () => (this.bomb.planted ? (this.w.player!.soldier.team === 1 ? 'Bombe entschärfen (halten)' : 'Bombe scharf!') : 'Bombe platzieren (halten)'),
        enabled: () => this.w.player!.soldier.alive && ((!this.bomb.planted && this.w.player!.soldier.team === 0) || (this.bomb.planted && this.bomb.site === s.id && this.w.player!.soldier.team === 1)),
        use: (sol) => this.bombAction(sol, s.id),
      });
    }
  }

  private bombAction(sol: Soldier, site: string) {
    if (!this.bomb.planted && sol.team === 0) {
      this.bomb.planted = true; this.bomb.site = site; this.bomb.timer = 40;
      this.bomb.pos.copy(this.sites.find((s) => s.id === site)!.pos);
      this.w.bus.emit('toast', `Bombe an ${site} platziert!`);
      this.w.audio.play('ui_popup_open');
    } else if (this.bomb.planted && sol.team === 1) {
      this.endRound(1, 'Bombe entschärft');
    }
  }

  private endRound(winner: number, why: string) {
    this.roundWins[winner]++;
    this.scores = [...this.roundWins];
    this.w.bus.emit('toast', `Runde ${this.round}: ${winner === this.w.player!.soldier.team ? 'GEWONNEN' : 'VERLOREN'} – ${why}`);
    this.bomb.planted = false;
    this.round++;
    if (this.roundWins[winner] >= this.scoreLimit) { this.finish(winner === this.w.player!.soldier.team, winner === this.w.player!.soldier.team ? 'MATCH GEWONNEN' : 'MATCH VERLOREN'); return; }
    // reset everyone
    for (const s of this.w.soldiers) { s.spawnAt(this.spawnPoint(s.team)); if (s.isPlayer && this.loadout) this.applyLoadout(s, this.loadout); }
  }

  update(dt: number) {
    const w = this.w;
    this.elapsed += dt;
    this.tickSoldiers(dt);
    // respawns
    for (let i = this.respawnQ.length - 1; i >= 0; i--) {
      const r = this.respawnQ[i];
      r.t -= dt;
      if (r.t <= 0) {
        this.respawnQ.splice(i, 1);
        r.s.spawnAt(this.spawnPoint(r.s.team));
        r.s.armorTier = 1; r.s.armor = 50; r.s.plates = 1;
        if (r.s.isPlayer) { if (this.loadout) this.applyLoadout(r.s, this.loadout); w.player!.spectateTarget = null; w.player!.yaw = r.s.team === 0 ? Math.PI : 0; }
        else this.giveRandomKit(r.s, 2);
      }
    }
    // CTF
    if (this.sub === 'ctf') this.updateFlags(dt);
    if (this.sub === 'snd' && this.bomb.planted) {
      this.bomb.timer -= dt;
      if (Math.floor(this.bomb.timer * 2) % 2 === 0 && Math.random() < 0.1) w.audio.play('ui_cursor', { pos: this.bomb.pos, volume: 0.7 });
      if (this.bomb.timer <= 0) { w.explode(this.bomb.pos.clone().setY(6), 18, 400, null, 'bomb'); this.endRound(0, 'Ziel zerstört'); }
    }
    if (this.sub === 'snd') {
      const alive = [0, 1].map((t) => w.soldiers.some((s) => s.team === t && s.alive));
      if (!alive[0] && !this.bomb.planted) this.endRound(1, 'Angreifer eliminiert');
      else if (!alive[1]) this.endRound(0, 'Verteidiger eliminiert');
    }
    // scorestreak usage
    if (w.input.pressed('killstreak') && this.streakReady) this.useStreak();
    if (!this.over && this.elapsed > this.timeLimit) {
      const me = w.player!.soldier.team;
      const mine = this.sub === 'ffa' ? w.player!.soldier.kills : this.scores[me];
      const best = this.sub === 'ffa' ? Math.max(...w.soldiers.map((s) => s.kills)) : Math.max(...this.scores);
      this.finish(mine >= best, mine >= best ? 'SIEG – Zeit abgelaufen' : 'NIEDERLAGE – Zeit abgelaufen');
    }
  }

  private updateFlags(_dt: number) {
    for (const f of this.flags) {
      if (f.carrier) {
        if (!f.carrier.alive) { this.w.bus.emit('toast', 'Flagge fallen gelassen'); f.pos.copy(f.carrier.pos); f.carrier = null; }
        else f.pos.copy(f.carrier.pos).add(new THREE.Vector3(0, 2.2, 0));
      }
      if (f.obj) f.obj.position.copy(f.pos);
      for (const s of this.w.soldiers) {
        if (!s.alive || f.carrier) continue;
        if (s.pos.distanceTo(f.pos) < 2.5) {
          if (s.team !== f.team) { f.carrier = s; this.w.bus.emit('toast', `${s.name} hat die ${f.team === 0 ? 'blaue' : 'rote'} Flagge!`); }
          else if (f.pos.distanceTo(f.home) > 1) { f.pos.copy(f.home); this.w.bus.emit('toast', 'Flagge zurückgebracht'); }
        }
      }
      // capture: carrier reaches own home while own flag is at home
      if (f.carrier) {
        const own = this.flags.find((o) => o.team === f.carrier!.team)!;
        if (f.carrier.pos.distanceTo(own.home) < 4 && own.pos.distanceTo(own.home) < 1) {
          this.scores[f.carrier.team]++;
          this.w.bus.emit('toast', `${f.carrier.name} erobert die Flagge!`);
          f.carrier = null; f.pos.copy(f.home);
          if (this.scores[0] >= this.scoreLimit || this.scores[1] >= this.scoreLimit) this.finish(this.scores[this.w.player!.soldier.team] >= this.scoreLimit, 'Flaggen-Sieg');
        }
      }
    }
    // bots: go for the enemy flag / bring it home
    for (const b of this.bots) {
      if (b.state === 'engage') continue;
      const enemyFlag = this.flags.find((f) => f.team !== b.s.team)!;
      if (enemyFlag.carrier === b.s) b.goal.copy(this.flags.find((f) => f.team === b.s.team)!.home);
      else if (b.s.id % 2 === 0) b.goal.copy(enemyFlag.pos);
    }
  }

  private useStreak() {
    const w = this.w, me = w.player!.soldier, s = this.streakReady;
    this.streakReady = null;
    if (s === 'UAV') { this.uavUntil = w.time + 30; w.bus.emit('toast', 'UAV online'); }
    else if (s === 'Care Package') {
      const p = me.pos.clone().add(w.player!.forward().setY(0).normalize().multiplyScalar(10));
      w.bus.emit('toast', 'Care Package angefordert');
      setTimeout(() => { me.give(new Weapon('warden', 4, ['acog', 'extmag'])); me.grenades = 4; me.plates = 4; w.bus.emit('toast', 'Care Package: Warden LMG + Ausrüstung'); w.effects.smoke(p, 0xff3030, 6); }, 3500);
    } else if (s === 'Cluster Strike') {
      const eye = me.eyePos(new THREE.Vector3());
      const hit = w.physics.raycast(eye, w.player!.forward(), 250);
      const target = hit?.point ?? eye.clone().add(w.player!.forward().multiplyScalar(80));
      w.bus.emit('toast', 'Cluster Strike im Anflug!');
      w.audio.play('bomb_whistle', { volume: 0.8 });
      for (let i = 0; i < 6; i++) setTimeout(() => {
        const p = target.clone().add(new THREE.Vector3((Math.random() - 0.5) * 18, 0, (Math.random() - 0.5) * 18));
        p.y = w.terrain.getHeight(p.x, p.z) + 0.5;
        w.explode(p, 9, 160, me, 'cluster');
      }, 2200 + i * 260);
    }
  }

  onKill(victim: Actor, info: DamageInfo) {
    super.onKill(victim, info);
    const killer = info.attacker as Soldier | undefined;
    if (victim.kind !== 'soldier') return;
    const v = victim as Soldier;
    if (this.sub === 'tdm' && killer && killer.team !== v.team) this.scores[killer.team]++;
    if (this.sub === 'ffa' && killer) this.scores[0] = Math.max(this.scores[0], killer.kills);
    if (killer?.isPlayer) {
      this.streak++;
      const streaks: Record<number, string> = { 3: 'UAV', 5: 'Care Package', 7: 'Cluster Strike' };
      if (streaks[this.streak]) { this.streakReady = streaks[this.streak]; w_emit(this.w, `Scorestreak bereit: ${this.streakReady} [B / →]`); }
    }
    if (v.isPlayer) this.streak = 0;
    if (this.respawns) this.respawnQ.push({ s: v, t: v.isPlayer ? 4 : 3 + Math.random() * 2 });
    if (this.sub === 'tdm' && (this.scores[0] >= this.scoreLimit || this.scores[1] >= this.scoreLimit)) {
      const me = this.w.player!.soldier.team;
      this.finish(this.scores[me] >= this.scoreLimit, this.scores[me] >= this.scoreLimit ? 'SIEG' : 'NIEDERLAGE');
    }
    if (this.sub === 'ffa' && killer && killer.kills >= this.scoreLimit) this.finish(killer.isPlayer, killer.isPlayer ? 'SIEG – Platz 1' : `${killer.name} gewinnt`);
  }

  canDamage(t: Actor, i: DamageInfo) {
    if (this.sub === 'ffa') return true;
    return !(i.attacker && i.attacker !== t && i.attacker.kind === 'soldier' && i.attacker.team === t.team);
  }

  hud(): HudInfo {
    const ffa = this.sub === 'ffa';
    return {
      title: this.name,
      timer: Math.max(0, this.timeLimit - this.elapsed),
      teams: ffa ? [{ name: 'Du', score: this.w.player?.soldier.kills ?? 0, color: '#4aa8ff' }, { name: 'Bester', score: Math.max(0, ...this.w.soldiers.filter((s) => !s.isPlayer).map((s) => s.kills)), color: '#ff6b5a' }]
        : [{ name: 'BLAU', score: this.scores[0], color: '#4aa8ff' }, { name: 'ROT', score: this.scores[1], color: '#ff6b5a' }],
      objective: this.sub === 'snd' ? (this.bomb.planted ? `Bombe: ${Math.ceil(this.bomb.timer)}s` : this.w.player?.soldier.team === 0 ? 'Platziere die Bombe an A oder B' : 'Verteidige A und B') : this.sub === 'ctf' ? 'Erobere die feindliche Flagge' : `Erreiche ${this.scoreLimit} Punkte`,
    };
  }
}

function w_emit(w: GameWorld, msg: string) { w.bus.emit('toast', msg); }
