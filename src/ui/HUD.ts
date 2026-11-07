import * as THREE from 'three';
import type { GameWorld } from '../gameplay/GameWorld';
import type { Soldier } from '../entities/Soldier';
import { RARITY } from '../weapons/WeaponDefs';
import { settings } from '../core/Settings';
import type { Actor, HitZone } from '../gameplay/types';
import type { Ping } from '../gameplay/GameWorld';
import type { Medal } from '../gameplay/MatchStats';

const h = (tag: string, cls = '', html = '') => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };

/** Warzone-style HUD: vitals/plates, ammo, minimap & compass, killfeed, hitmarkers, damage
 * direction, prompts with device-specific glyphs, vehicle HUD, scope overlay, buy menu, pause. */
const THREE_clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

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
  private lensX = 0;
  private lensY = 0;
  private unsub: (() => void)[] = [];
  onPause: (() => void) | null = null;
  onQuit: (() => void) | null = null;
  onPhoto: (() => void) | null = null;
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
    // sniper scope: lens with parallax shadow + mil-dot reticle (SVG)
    const md = [8, 16, 24, 32].flatMap((d) => [`<circle cx="${d}" cy="0" r="0.9"/>`, `<circle cx="${-d}" cy="0" r="0.9"/>`, `<circle cx="0" cy="${d}" r="0.9"/>`, `<circle cx="0" cy="${-d}" r="0.9"/>`]).join('');
    add('scope', 'scope hidden', `<div class="lens"></div><svg viewBox="-100 -100 200 200" class="ret"><g fill="#060606" stroke="#060606"><path d="M-100 0H-38M38 0H100M0 -100V-38M0 38V100" stroke-width="2.6"/><path d="M-38 0H38M0 -38V38" stroke-width="0.32"/>${md}<path d="M-3 46H3M-2.4 54H2.4M-1.8 62H1.8" stroke-width="0.5"/></g><circle r="0.75" fill="#ff2a1a"/></svg>`);
    // magnified optics (3.5x / thermal): smaller eyepiece with a BDC chevron
    add('optic', 'optic hidden', `<div class="lens"></div><svg viewBox="-100 -100 200 200" class="ret"><path class="chev" d="M-5 7L0 0L5 7" fill="none" stroke-width="1.6"/><g class="bdc" stroke-width="0.6"><path d="M-3 18H3M-2.2 28H2.2M-1.6 37H1.6M0 9V40"/></g></svg>`);
    add('blink', 'scope-blink');
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
    add('medals', 'medals');
    add('killcam', 'killcam hidden', `<div class="bars"><i></i><i></i></div><div class="kc-top"><span class="rec">●</span> KILLCAM <b class="slow hidden">ZEITLUPE</b></div>
      <div class="kc-bottom"><div class="who"></div><div class="meta"></div><div class="prog"><i></i></div><div class="skip"></div></div>`);
    add('dmgnums', 'dmgnums');
    add('pings', 'pings');
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
      b.on('medal', (m: Medal) => this.showMedal(m)),
      b.on('hitmarker', (e: { target: Actor; dealt: number; zone: HitZone; kill: boolean; armor: boolean }) => this.dmgNumber(e)),
      b.on('ping', (p: Ping) => this.addPingEl(p)),
      b.on('killcam', (e: { active: boolean; killer?: Actor; weapon?: string; dist?: number; hp?: number }) => {
        const el = this.els.killcam;
        el.classList.toggle('hidden', !e.active);
        this.root.classList.toggle('kc', e.active);
        this.w.engine.look = e.active ? 5 : 0;
        if (e.active && e.killer) {
          (el.querySelector('.who') as HTMLElement).innerHTML = `Getötet von <b>${e.killer.name}</b>`;
          (el.querySelector('.meta') as HTMLElement).textContent = `${e.weapon ?? ''} · ${Math.round(e.dist ?? 0)} m · ${Math.max(0, Math.round(e.hp ?? 0))} HP übrig`;
          (el.querySelector('.skip') as HTMLElement).innerHTML = `<span class="glyph">${this.w.input.glyph('jump')}</span> Überspringen`;
        }
      }),
      b.on('killcamHit', (e: { zone: string; kill: boolean }) => {
        const el = this.els.hit;
        el.style.color = e.kill ? '#ff3b3b' : e.zone === 'head' ? '#ffd23b' : '#ffffff';
        el.style.transform = e.kill ? 'scale(1.5)' : 'scale(1)';
        el.classList.add('show');
        this.hitT = e.kill ? 0.5 : 0.12;
        this.w.audio.ui(e.kill ? 'confirm' : 'cursor');
      }),
    );
  }

  // ------------------------------------------------------------------ medals
  private medalQ: Medal[] = [];
  private medalBusy = false;
  private showMedal(m: Medal) {
    this.medalQ.push(m);
    if (!this.medalBusy) this.nextMedal();
  }
  private nextMedal() {
    const m = this.medalQ.shift();
    if (!m) { this.medalBusy = false; return; }
    this.medalBusy = true;
    const el = h('div', `medal m-${m.id}`, `<div class="ico">${m.icon}</div><div class="txt"><b>${m.name}</b>${m.sub ? `<i>${m.sub}</i>` : ''}<span>+${m.xp} XP</span></div>`);
    this.els.medals.appendChild(el);
    this.w.audio.play(m.xp >= 150 ? 'cash' : 'coin', { volume: 0.55 });
    setTimeout(() => el.classList.add('out'), 1700);
    setTimeout(() => { el.remove(); }, 2100);
    setTimeout(() => this.nextMedal(), this.medalQ.length > 2 ? 450 : 700);
  }

  // ------------------------------------------------------------------ floating damage numbers (stack per target)
  private nums: { el: HTMLElement; target: Actor; amount: number; t: number; off: number; color: string }[] = [];
  private dmgNumber(e: { target: Actor; dealt: number; zone: HitZone; kill: boolean; armor: boolean }) {
    if (!settings.data.damageNumbers) return;
    const color = e.kill ? '#ff5a4a' : e.zone === 'head' ? '#ffd23a' : e.armor ? '#7ec8ff' : '#ffffff';
    const cur = this.nums.find((n) => n.target === e.target && n.t > 0.45);
    if (cur) { cur.amount += e.dealt; cur.t = 1; cur.color = color; cur.el.style.color = color; cur.el.textContent = String(Math.round(cur.amount)); cur.el.classList.remove('pop'); void cur.el.offsetWidth; cur.el.classList.add('pop'); return; }
    const el = h('div', 'dnum pop', String(Math.round(e.dealt)));
    el.style.color = color;
    this.els.dmgnums.appendChild(el);
    this.nums.push({ el, target: e.target, amount: e.dealt, t: 1, off: (Math.random() - 0.5) * 0.5, color });
    if (this.nums.length > 14) { this.nums[0].el.remove(); this.nums.shift(); }
  }

  // ------------------------------------------------------------------ pings
  private pingEls = new Map<number, HTMLElement>();
  private addPingEl(p: Ping) {
    const icon = { go: '◆', enemy: '▲', loot: '★', vehicle: '⬢', danger: '⚠' }[p.kind];
    const el = h('div', `ping k-${p.kind}`, `<div class="pi">${icon}</div><div class="pl">${p.label}</div><div class="pd"></div>`);
    this.els.pings.appendChild(el);
    this.pingEls.set(p.id, el);
    if (p.owner !== this.w.player?.soldier.name) this.toast(`${p.owner}: ${p.label}`, 1500);
  }
  private tmpV = new THREE.Vector3();
  private project(p: THREE.Vector3) {
    const v = this.tmpV.copy(p).project(this.w.engine.camera);
    return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, behind: v.z > 1 };
  }
  private updateWorldMarkers(dt: number) {
    // damage numbers float up from the target's head and fade
    for (let i = this.nums.length - 1; i >= 0; i--) {
      const n = this.nums[i];
      n.t -= dt * 1.15;
      if (n.t <= 0) { n.el.remove(); this.nums.splice(i, 1); continue; }
      const q = this.project(this.tmpV.copy(n.target.pos).add(new THREE.Vector3(n.off, 2.0 + (1 - n.t) * 0.6, 0)));
      if (q.behind) { n.el.style.opacity = '0'; continue; }
      n.el.style.opacity = String(Math.min(1, n.t * 2.2));
      n.el.style.transform = `translate(${q.x.toFixed(0)}px, ${q.y.toFixed(0)}px) translate(-50%, -50%)`;
    }
    // pings: world markers, clamped to the screen edge when off-screen
    const me = this.w.player!.soldier;
    for (const [id, el] of this.pingEls) {
      const p = this.w.pings.find((x) => x.id === id);
      if (!p) { el.remove(); this.pingEls.delete(id); continue; }
      const q = this.project(p.pos);
      let x = q.x, y = q.y;
      const m = 40;
      const off = q.behind || x < m || y < m || x > innerWidth - m || y > innerHeight - m;
      if (q.behind) { x = innerWidth - x; y = innerHeight - m; }
      x = THREE_clamp(x, m, innerWidth - m); y = THREE_clamp(y, m, innerHeight - m);
      el.classList.toggle('edge', off);
      el.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%, -100%)`;
      el.style.opacity = String(Math.min(1, p.t * 2));
      (el.lastElementChild as HTMLElement).textContent = `${Math.round(p.pos.distanceTo(me.pos))} m`;
    }
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
    const st = this.w.stats;
    const tm = Math.max(0, (st.deathT > 0 ? st.deathT : this.w.time) - st.startT);
    const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
    const cell = (v: string, l: string) => `<div class="st"><b>${v}</b><span>${l}</span></div>`;
    const medals = st.medals.reduce((acc, m) => { acc[m.name] = (acc[m.name] ?? 0) + 1; return acc; }, {} as Record<string, number>);
    e.innerHTML = `<div class="box"><h1 class="${r.win ? 'win' : ''}">${r.win ? 'SIEG' : 'MATCH VORBEI'}</h1><p style="font-size:22px">${r.text}</p>
      <div class="stats-grid">${cell(String(st.kills + st.zombieKills), 'Kills')}${cell(String(Math.round(st.damage)), 'Schaden')}${cell(String(st.headshots), 'Kopftreffer')}${cell(`${Math.round(st.accuracy * 100)}%`, 'Trefferquote')}
        ${cell(`${Math.round(st.longest)} m`, 'Weitester Kill')}${cell(`${(st.travelled / 1000).toFixed(2)} km`, 'Zu Fuß')}${cell(`${(st.drove / 1000).toFixed(2)} km`, 'Gefahren')}${cell(fmt(tm), 'Überlebt')}</div>
      ${Object.keys(medals).length ? `<div class="medal-list">${Object.entries(medals).map(([n, c]) => `<span>${n}${c > 1 ? ` ×${c}` : ''}</span>`).join('')}</div>` : ''}
      <p style="color:var(--muted)">+${r.xp + st.bonusXp} XP${st.bonusXp ? ` (inkl. ${st.bonusXp} Medaillen-XP)` : ''} · +${r.coins} Lumos Coins</p>
      <div class="play-row" style="justify-content:center"><button class="btn" data-quit>Zurück zur Lobby</button></div></div>`;
    const reveal = () => { if (this.w.killcam?.busy) { setTimeout(reveal, 300); return; } e.classList.remove('hidden'); this.w.input.unlock(); };
    setTimeout(reveal, r.win ? 2500 : 4000);
    (e.querySelector('[data-quit]') as HTMLElement).onclick = () => this.onQuit?.();
  }

  setPaused(p: boolean) {
    this.paused = p;
    const el = this.els.pause;
    if (p) {
      el.innerHTML = `<div class="box card"><h3>Pausiert</h3><button class="btn" data-resume>Weiter</button><button class="btn ghost" data-photo>📷 Fotomodus</button><button class="btn ghost" data-tps>Kamera: ${this.w.player?.thirdPerson ? '3rd Person' : '1st Person'}</button><button class="btn ghost" data-quit>Match verlassen</button></div>`;
      (el.querySelector('[data-resume]') as HTMLElement).onclick = () => this.onPause?.();
      (el.querySelector('[data-photo]') as HTMLElement).onclick = () => { el.classList.add('hidden'); this.onPhoto?.(); };
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
    this.updateWorldMarkers(dt);
    if (this.w.killcam?.active) {
      (this.els.killcam.querySelector('.prog i') as HTMLElement).style.width = `${(this.w.killcam.progress * 100).toFixed(1)}%`;
      (this.els.killcam.querySelector('.slow') as HTMLElement).classList.toggle('hidden', !this.w.killcam.slowMo);
    }
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
    const optic = wp.attachments.find((a) => a === 'reddot' || a === 'acog' || a === 'thermal');
    const canScope = !p.thirdPerson && s.alive && !s.inVehicle;
    const sst = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const sniper = !!wp.stats.scope && canScope;
    const magnified = !sniper && (optic === 'acog' || optic === 'thermal' || wp.def.cls === 'launcher') && canScope;
    // scope-in: brief dark "blink" hides the swap from view-model to eyepiece
    this.els.blink.style.opacity = sniper || magnified ? String(Math.max(0, 1 - Math.abs(s.ads - 0.9) / 0.08) * (sniper ? 0.95 : 0.6)) : '0';
    // lens shadow drifts with look / move inertia (reticle stays centred = where the bullet goes)
    const lx = THREE_clamp(-w.input.lookX * 0.9 + (s.vel.x * Math.cos(p.yaw) - s.vel.z * Math.sin(p.yaw)) * -2.2, -48, 48);
    const ly = THREE_clamp(w.input.lookY * 0.9 + (s.grounded ? 0 : s.vel.y * 2), -40, 40);
    this.lensX += (lx - this.lensX) * Math.min(1, dt * 7); this.lensY += (ly - this.lensY) * Math.min(1, dt * 7);
    const lensT = `translate(${this.lensX.toFixed(1)}px, ${this.lensY.toFixed(1)}px)`;
    this.els.scope.classList.toggle('hidden', !(sniper && s.ads > 0.86));
    if (sniper) { this.els.scope.style.opacity = String(sst(s.ads, 0.86, 0.95)); (this.els.scope.firstChild as HTMLElement).style.transform = lensT; }
    this.els.optic.classList.toggle('hidden', !(magnified && s.ads > 0.86));
    if (magnified) {
      this.els.optic.style.opacity = String(sst(s.ads, 0.86, 0.95));
      this.els.optic.classList.toggle('thermal', optic === 'thermal');
      (this.els.optic.firstChild as HTMLElement).style.transform = lensT;
    }
    const ret = this.els.reticle;
    ret.classList.toggle('hidden', !(optic === 'reddot' && !wp.stats.scope && s.ads > 0.8 && canScope));
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
    for (const pg of w.pings) {
      const [x, y] = toMap(pg.pos.x, pg.pos.z);
      const r = Math.hypot(x, y), lim = size / 2 - 8;
      const k = r > lim ? lim / r : 1;
      ctx.fillStyle = pg.kind === 'enemy' || pg.kind === 'danger' ? '#ff5a4a' : pg.kind === 'loot' ? '#ffd23a' : pg.kind === 'vehicle' ? '#7ec8ff' : '#ffffff';
      ctx.save(); ctx.translate(x * k, y * k); ctx.rotate(Math.PI / 4); ctx.fillRect(-4.5, -4.5, 9, 9); ctx.restore();
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
