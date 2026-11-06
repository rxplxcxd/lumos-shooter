import * as THREE from 'three';
import type { GameWorld } from '../gameplay/GameWorld';
import type { Soldier } from '../entities/Soldier';
import { RARITY } from '../weapons/WeaponDefs';
import { settings } from '../core/Settings';
import type { HitZone } from '../gameplay/types';

const h = (tag: string, cls = '', html = '') => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };

/** Warzone-style HUD: vitals/plates, ammo, minimap & compass, killfeed, hitmarkers, damage
 * direction, prompts with device-specific glyphs, vehicle HUD, scope overlay, buy menu, pause. */
export class HUD {
  root = h('div', 'hud');
  private w: GameWorld;
  private els: Record<string, HTMLElement> = {};
  private mapCanvas: HTMLCanvasElement;
  private mapCtx: CanvasRenderingContext2D;
  private terrainImg: HTMLCanvasElement | null = null;
  private hitT = 0;
  private dmgDirs: { el: HTMLElement; ang: number; t: number; from: THREE.Vector3 }[] = [];
  private bigMap = false;
  private uiAccum = 0;
  private unsub: (() => void)[] = [];
  onPause: (() => void) | null = null;
  onQuit: (() => void) | null = null;
  paused = false;

  constructor(w: GameWorld, parent: HTMLElement) {
    this.w = w;
    const R = this.root;
    const add = (k: string, cls: string, html = '') => { const e = h('div', cls, html); this.els[k] = e; R.appendChild(e); return e; };
    add('fps', 'fps');
    add('top', 'topinfo', '<div class="title"></div><div class="big"></div><div class="obj"></div>');
    add('scores', 'scores');
    add('compass', 'compass', '<div class="strip"></div>');
    const mm = add('minimap', 'minimap');
    this.mapCanvas = document.createElement('canvas'); this.mapCanvas.width = 256; this.mapCanvas.height = 256;
    mm.appendChild(this.mapCanvas);
    this.mapCtx = this.mapCanvas.getContext('2d')!;
    add('killfeed', 'killfeed');
    add('scope', 'scope hidden');
    add('reticle', 'reticle hidden');
    add('cross', 'crosshair', '<i class="t"></i><i class="b"></i><i class="l"></i><i class="r"></i><i class="dot"></i>');
    add('hit', 'hitmarker');
    add('dmg', 'dmg-dir');
    add('vitals', 'vitals', '<div class="armor"></div><div class="hp"><i></i></div><div class="items"></div>');
    add('ammo', 'ammo', '<div class="wname"></div><div class="count"></div><div class="slots"></div>');
    add('prompt', 'prompt hidden');
    add('veh', 'vehicle-hud hidden');
    add('zone', 'zone-timer');
    add('round', 'round hidden');
    add('points', 'points hidden');
    add('toast', 'toast');
    add('story', 'story hidden');
    add('down', 'down-msg hidden');
    add('end', 'end hidden');
    add('buy', 'buy card hidden');
    add('pause', 'pause hidden');
    parent.appendChild(R);
    this.bind();
  }

  private bind() {
    const b = this.w.bus;
    this.unsub.push(
      b.on('hitmarker', (e: { zone: HitZone; kill: boolean; armor: boolean }) => {
        const el = this.els.hit;
        el.style.color = e.kill ? '#ff3b3b' : e.zone === 'head' ? '#ffd23b' : e.armor ? '#8fd0ff' : '#ffffff';
        el.style.transform = e.kill ? 'scale(1.4)' : 'scale(1)';
        el.classList.add('show');
        this.hitT = e.kill ? 0.35 : 0.12;
      }),
      b.on('kill', (e: { victim: any; killer: any; info: any }) => {
        const k = e.killer?.name ?? (e.info?.storm ? 'Zone' : 'Welt');
        const me = e.killer?.isPlayer || e.victim?.isPlayer;
        if (e.victim.kind === 'zombie' && !e.killer?.isPlayer) return;
        const weapon = e.info?.weapon ? `[${e.info.weapon}]` : e.info?.explosive ? '[💥]' : '';
        const d = h('div', me ? 'me' : '', `${k} <span style="opacity:.6">${weapon}${e.info?.zone === 'head' ? ' ⊕' : ''}</span> ${e.victim.name}`);
        this.els.killfeed.prepend(d);
        while (this.els.killfeed.children.length > 6) this.els.killfeed.lastElementChild?.remove();
        setTimeout(() => d.remove(), 6000);
        if (e.killer?.isPlayer && e.victim.kind === 'soldier') this.toast(`ELIMINIERT: ${e.victim.name}${e.info?.zone === 'head' ? ' (Kopfschuss)' : ''}`);
      }),
      b.on('damage', (e: { target: Soldier; amount: number; info: any }) => {
        if (!e.target.isPlayer) return;
        this.w.engine.damageVignette = Math.min(0.8, this.w.engine.damageVignette + e.amount / 120);
        this.w.input.rumble(Math.min(1, e.amount / 40), 0.6, 120);
        const from = e.info?.attacker?.pos ?? e.info?.point;
        if (from) {
          const el = h('i'); this.els.dmg.appendChild(el);
          this.dmgDirs.push({ el, ang: 0, t: 1.4, from: from.clone() });
        }
      }),
      b.on('toast', (m: string) => this.toast(m)),
      b.on('story', (m: string) => { const s = this.els.story; s.textContent = m; s.classList.remove('hidden'); setTimeout(() => s.classList.add('hidden'), 9000); }),
      b.on('pickup', (e: { label: string }) => this.toast(`+ ${e.label}`, 1200)),
      b.on('round', (r: number) => { this.toast(`RUNDE ${r}`, 2500); }),
      b.on('downed', (e: { target: Soldier }) => { if (e.target.isPlayer) this.els.down.classList.remove('hidden'); else if (e.target.team === this.w.player?.soldier.team) this.toast(`${e.target.name} ist am Boden!`); }),
      b.on('revived', (s: Soldier) => { if (s.isPlayer) this.els.down.classList.add('hidden'); }),
      b.on('armorBroken', (s: Soldier) => { if ((s as any).lastAttacker?.isPlayer) this.toast('🛡 RÜSTUNG ZERSTÖRT', 900); }),
      b.on('openBuy', (mode: any) => this.openBuy(mode)),
      b.on('matchOver', (r: { win: boolean; text: string; xp: number; coins: number }) => this.showEnd(r)),
    );
  }

  toast(msg: string, ms = 3000) {
    const d = h('div', '', msg);
    d.style.animationDuration = `${ms}ms`;
    this.els.toast.appendChild(d);
    setTimeout(() => d.remove(), ms);
  }

  private openBuy(mode: any) {
    const b = this.els.buy;
    const items = [['plates', 'Panzerplatten x3', 500], ['armor', 'Weste Stufe 3', 3000], ['uav', 'UAV-Drohne', 3500], ['revive', 'Teammitglied absetzen', 4500], ['supply', 'Versorgungsabwurf', 6000], ['loadout', 'Loadout-Drop', 9000]];
    b.innerHTML = `<h3>Kaufstation</h3><p>Guthaben: $${this.w.player?.soldier.cash ?? 0}</p><div class="list" style="margin-top:10px"></div><div class="play-row"><button class="btn ghost small" data-close>Schließen</button></div>`;
    const list = b.querySelector('.list')!;
    for (const [id, name, price] of items) {
      const r = h('div', 'row', `<span>${name}</span><span class="r">$${price}</span>`);
      r.onclick = () => { if (mode.buy(id)) this.openBuy(mode); };
      list.appendChild(r);
    }
    (b.querySelector('[data-close]') as HTMLElement).onclick = () => { b.classList.add('hidden'); this.w.input.lock(); };
    b.classList.remove('hidden');
    this.w.input.unlock();
  }

  private showEnd(r: { win: boolean; text: string; xp: number; coins: number }) {
    const e = this.els.end;
    e.innerHTML = `<div class="box"><h1 class="${r.win ? 'win' : ''}">${r.win ? 'SIEG' : 'MATCH VORBEI'}</h1><p style="font-size:22px">${r.text}</p>
      <p style="color:var(--muted)">+${r.xp} XP · +${r.coins} Lumos Coins · Kills: ${this.w.player?.soldier.kills ?? 0}</p>
      <div class="play-row" style="justify-content:center"><button class="btn" data-quit>Zurück zur Lobby</button></div></div>`;
    setTimeout(() => { e.classList.remove('hidden'); this.w.input.unlock(); }, r.win ? 2500 : 4000);
    (e.querySelector('[data-quit]') as HTMLElement).onclick = () => this.onQuit?.();
  }

  setPaused(p: boolean) {
    this.paused = p;
    const el = this.els.pause;
    if (p) {
      el.innerHTML = `<div class="box card"><h3>Pausiert</h3><button class="btn" data-resume>Weiter</button><button class="btn ghost" data-tps>Kamera: ${this.w.player?.thirdPerson ? '3rd Person' : '1st Person'}</button><button class="btn ghost" data-quit>Match verlassen</button></div>`;
      (el.querySelector('[data-resume]') as HTMLElement).onclick = () => this.onPause?.();
      (el.querySelector('[data-tps]') as HTMLElement).onclick = () => { if (this.w.player) { this.w.player.thirdPerson = !this.w.player.thirdPerson; settings.set('thirdPerson', this.w.player.thirdPerson); } this.setPaused(true); };
      (el.querySelector('[data-quit]') as HTMLElement).onclick = () => this.onQuit?.();
      el.classList.remove('hidden');
    } else el.classList.add('hidden');
  }

  /** pre-render the terrain into a minimap image */
  private buildTerrainImage() {
    const t = this.w.terrain;
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(512, 512);
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
      const wx = (x / 512 - 0.5) * t.size, wz = (y / 512 - 0.5) * t.size;
      const hh = t.getHeight(wx, wz);
      const i = (y * 512 + x) * 4;
      let r, g, b;
      if (hh < this.w.waterLevel) { r = 20; g = 70 + Math.max(-20, hh) * 1.5; b = 110 + Math.max(-20, hh) * 2; }
      else if (t.roadAt(wx, wz) > 0.5) { r = g = b = 70; }
      else if (hh < this.w.waterLevel + 2.2) { r = 200; g = 185; b = 130; }
      else { const k = Math.min(1, hh / 80); r = 60 + k * 90; g = 110 + k * 40; b = 55 + k * 60; }
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    this.terrainImg = c;
  }

  update(dt: number) {
    const w = this.w, p = w.player;
    if (!p) return;
    const s = p.soldier;
    // hitmarker & damage indicators every frame
    if (this.hitT > 0) { this.hitT -= dt; if (this.hitT <= 0) this.els.hit.classList.remove('show'); }
    for (let i = this.dmgDirs.length - 1; i >= 0; i--) {
      const d = this.dmgDirs[i];
      d.t -= dt;
      const to = d.from.clone().sub(s.pos);
      const ang = Math.atan2(to.x, to.z) - (p.yaw + Math.PI);
      d.el.style.transform = `rotate(${-ang}rad)`;
      d.el.style.opacity = String(Math.max(0, d.t));
      if (d.t <= 0) { d.el.remove(); this.dmgDirs.splice(i, 1); }
    }
    w.engine.damageVignette = Math.max(0, w.engine.damageVignette - dt * 0.6) + (s.alive && s.health < 35 && !s.downed ? 0.004 : 0);
    w.engine.flash = Math.max(0, w.engine.flash - dt * 0.5);
    // crosshair spread
    const wp = s.weapon;
    const spread = wp.spread(s.ads, Math.min(1, Math.hypot(s.vel.x, s.vel.z) / 4), !s.grounded, s.crouching);
    const px = 4 + spread * 5;
    const ch = this.els.cross;
    const hideCross = s.ads > 0.8 || p.thirdPerson && s.ads > 0.8 || s.inVehicle && s.seat === 0 && !s.inVehicle.def.weapon;
    ch.style.display = hideCross || !s.alive ? 'none' : '';
    (ch.children[0] as HTMLElement).style.top = `${-px - 8}px`; (ch.children[1] as HTMLElement).style.top = `${px}px`;
    (ch.children[2] as HTMLElement).style.left = `${-px - 8}px`; (ch.children[3] as HTMLElement).style.left = `${px}px`;
    this.els.scope.classList.toggle('hidden', !(wp.stats.scope && s.ads > 0.92 && !p.thirdPerson));
    const optic = wp.attachments.find((a) => a === 'reddot' || a === 'acog' || a === 'thermal');
    const ret = this.els.reticle;
    ret.classList.toggle('hidden', !(optic && !wp.stats.scope && s.ads > 0.8 && !p.thirdPerson && s.alive));
    ret.className = `reticle ${optic ?? ''}${ret.classList.contains('hidden') ? ' hidden' : ''}`;
    // throttled DOM updates
    this.uiAccum += dt;
    if (this.uiAccum < 0.1) return;
    this.uiAccum = 0;
    this.els.fps.textContent = settings.data.showFps ? `${Math.round(w.engine.fps)} FPS · ${Math.round(w.engine.drsScale * 100)}% · ${settings.data.quality}` : '';
    const info = w.mode?.hud() ?? {};
    const top = this.els.top;
    (top.children[0] as HTMLElement).textContent = info.title ?? '';
    (top.children[1] as HTMLElement).textContent = info.alive !== undefined ? `${info.alive} ${info.round ? 'Zombies' : 'am Leben'}` : '';
    (top.children[2] as HTMLElement).textContent = info.objective ?? '';
    this.els.scores.innerHTML = info.teams ? info.teams.map((t) => `<span style="border-color:${t.color}">${t.name} ${t.score}</span>`).join('') + (info.timer !== undefined ? `<span style="border-color:#888">${fmt(info.timer)}</span>` : '') : '';
    this.els.zone.textContent = info.zone ? `${info.zone.shrinking ? 'Zone schließt' : 'Nächste Zone'}: ${fmt(info.zone.next)}` : '';
    if (info.round !== undefined) { this.els.round.classList.remove('hidden'); this.els.round.textContent = String(info.round); this.els.points.classList.remove('hidden'); this.els.points.textContent = `${info.points} Punkte`; }
    // vitals
    const armor = this.els.vitals.children[0] as HTMLElement;
    const plates = s.armorTier;
    if (armor.children.length !== plates) armor.innerHTML = '<i></i>'.repeat(plates);
    [...armor.children].forEach((el, i) => el.classList.toggle('on', s.armor > i * 50 + 1));
    const hp = this.els.vitals.children[1] as HTMLElement;
    (hp.children[0] as HTMLElement).style.width = `${Math.max(0, (s.health / s.maxHealth) * 100)}%`;
    hp.classList.toggle('low', s.health < 35);
    const g = (a: Parameters<typeof w.input.glyph>[0]) => `<span class="glyph">${w.input.glyph(a)}</span>`;
    (this.els.vitals.children[2] as HTMLElement).innerHTML = `${g('plate')}🛡 ${s.plates} &nbsp; ${g('heal')}✚ ${s.medkits}${s.syringes ? ` 💉${s.syringes}` : ''} &nbsp; ${g('grenade')}● ${s.grenades} &nbsp; $${s.cash}${s.perks.size ? ' &nbsp; ' + [...s.perks].map((k) => `<span class="glyph">${k.slice(0, 3).toUpperCase()}</span>`).join('') : ''}`;
    // ammo
    const a = this.els.ammo;
    (a.children[0] as HTMLElement).innerHTML = `<span style="color:${wp.color}">${wp.name}</span>${wp.reloading > 0 ? ' · NACHLADEN' : ''}`;
    (a.children[1] as HTMLElement).innerHTML = wp.def.cls === 'melee' ? '∞' : `${wp.ammo}<small> / ${w.mode?.infiniteAmmo ? '∞' : s.reserve[wp.def.ammo] ?? 0}</small>`;
    (a.children[2] as HTMLElement).innerHTML = [0, 1].map((i) => s.weapons[i] ? `<span class="${s.current === i ? 'on' : ''} rarity-${s.weapons[i]!.rarity}">${i + 1} ${s.weapons[i]!.def.name}</span>` : '').join('') + `<span class="${s.current === 2 ? 'on' : ''}">3 Messer</span>`;
    // prompt
    const pr = this.els.prompt;
    const focus = p.focus;
    if (s.alive && (focus || p.focusVehicle || s.inVehicle)) {
      pr.classList.remove('hidden');
      const txt = focus ? focus.label() : s.inVehicle ? `Aussteigen` : `${p.focusVehicle!.def.name} – ${p.focusVehicle!.driver ? 'Mitfahren' : 'Fahren'}`;
      pr.innerHTML = `${g('interact')} ${txt}${focus?.hold ? `<span class="hold" style="width:${p.holdProgress * 100}%"></span>` : ''}`;
      pr.style.top = s.inVehicle && !focus ? '76%' : '62%';
    } else pr.classList.add('hidden');
    // vehicle hud
    const v = s.inVehicle;
    const vh = this.els.veh;
    if (v) {
      vh.classList.remove('hidden');
      vh.innerHTML = `<div class="spd">${Math.round(v.speed * 3.6)} <small>km/h</small></div><div>${v.def.name} · ${Math.max(0, Math.round((v.health / v.def.health) * 100))}%${v.isAir ? ` · ALT ${Math.round(v.altitude)}m` : ''}${v.def.weapon !== 'none' ? ` · ${g('fire')} ${v.def.weapon}` : ''}</div>`;
    } else vh.classList.add('hidden');
    this.els.down.textContent = s.downed ? `AM BODEN – Ausbluten in ${Math.max(0, Math.ceil(s.bleedOut - (w.time - s.downedTime)))}s` : '';
    if (!s.downed) this.els.down.classList.add('hidden');
    // compass
    const deg = ((-(p.yaw) * 180) / Math.PI + 360 * 10) % 360;
    const labels = ['N', '15', '30', 'NO', '60', '75', 'O', '105', '120', 'SO', '150', '165', 'S', '195', '210', 'SW', '240', '255', 'W', '285', '300', 'NW', '330', '345'];
    const strip = this.els.compass.children[0] as HTMLElement;
    if (!strip.dataset.built) { strip.innerHTML = [...labels, ...labels, ...labels].map((l) => `<span style="display:inline-block;width:35px;text-align:center;${l.length < 3 ? 'color:var(--accent)' : 'opacity:.6'}">${l}</span>`).join(''); strip.dataset.built = '1'; }
    strip.style.left = `${210 - (deg / 15) * 35 - 24 * 35 - 17}px`;
    this.drawMinimap(info.zone ?? null);
  }

  private drawMinimap(zone: { x: number; z: number; r: number; nx: number; nz: number; nr: number } | null) {
    const w = this.w, p = w.player!, s = p.soldier;
    if (!this.terrainImg) this.buildTerrainImage();
    const ctx = this.mapCtx, size = 256;
    const t = w.terrain;
    const range = s.inVehicle?.isAir ? 600 : 220; // metres shown across
    const scale = size / range;
    ctx.save();
    ctx.fillStyle = '#0a0e14'; ctx.fillRect(0, 0, size, size);
    ctx.translate(size / 2, size / 2);
    ctx.rotate(p.yaw);
    // terrain
    const pxPerM = 512 / t.size;
    ctx.drawImage(this.terrainImg!, (s.pos.x + t.size / 2) * pxPerM - (range / 2) * pxPerM, (s.pos.z + t.size / 2) * pxPerM - (range / 2) * pxPerM, range * pxPerM, range * pxPerM, -size / 2, -size / 2, size, size);
    const toMap = (x: number, z: number) => [(x - s.pos.x) * scale, (z - s.pos.z) * scale];
    if (zone) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(190,80,255,0.9)';
      let [x, y] = toMap(zone.x, zone.z); ctx.beginPath(); ctx.arc(x, y, zone.r * scale, 0, 6.29); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.setLineDash([5, 4]);
      [x, y] = toMap(zone.nx, zone.nz); ctx.beginPath(); ctx.arc(x, y, zone.nr * scale, 0, 6.29); ctx.stroke(); ctx.setLineDash([]);
    }
    const uav = (w.mode as any)?.uavActive || w.time < ((w.mode as any)?.uavUntil ?? 0);
    for (const a of w.actors) {
      if (!a.alive || a === s) continue;
      const d = a.pos.distanceTo(s.pos);
      if (d > range) continue;
      const friendly = a.kind === 'soldier' && a.team === s.team;
      const fired = a.kind === 'soldier' && w.time - (a.lastShotTime ?? -100) < 1.5 && (a.silencedUntil ?? 0) < w.time - 1;
      if (!friendly && !uav && !fired && !(a.kind === 'zombie' && d < 40)) continue;
      const [x, y] = toMap(a.pos.x, a.pos.z);
      ctx.fillStyle = friendly ? '#5fd068' : a.kind === 'zombie' ? '#c0ff7a' : '#ff4d4d';
      ctx.beginPath(); ctx.arc(x, y, friendly ? 4 : 3.5, 0, 6.29); ctx.fill();
    }
    for (const v of w.vehicles) {
      if (v.destroyed || v.model.position.distanceTo(s.pos) > range) continue;
      const [x, y] = toMap(v.model.position.x, v.model.position.z);
      ctx.fillStyle = v.driver && v.driver.team !== s.team ? '#ff9a4d' : '#d8e2ee';
      ctx.fillRect(x - 3, y - 3, 6, 6);
    }
    ctx.restore();
    // player arrow (always pointing up)
    ctx.fillStyle = '#ffb52e';
    ctx.beginPath(); ctx.moveTo(size / 2, size / 2 - 8); ctx.lineTo(size / 2 - 6, size / 2 + 6); ctx.lineTo(size / 2 + 6, size / 2 + 6); ctx.closePath(); ctx.fill();
    // POI labels
    const pois = (w.mode as any)?.map?.pois ?? [];
    ctx.font = '600 11px Rajdhani, sans-serif'; ctx.fillStyle = '#e8eef5'; ctx.textAlign = 'center';
    for (const poi of pois) {
      const dx = (poi.x - s.pos.x) * scale, dz = (poi.z - s.pos.z) * scale;
      const c = Math.cos(p.yaw), sn = Math.sin(p.yaw);
      const rx = dx * c - dz * sn, ry = dx * sn + dz * c;
      if (Math.abs(rx) < size / 2 && Math.abs(ry) < size / 2) ctx.fillText(poi.name, size / 2 + rx, size / 2 + ry);
    }
  }

  dispose() { this.unsub.forEach((u) => u()); this.root.remove(); }
}

function fmt(t: number) { const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${s.toString().padStart(2, '0')}`; }
export { RARITY };
