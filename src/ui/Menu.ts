import { settings, type Quality } from '../core/Settings';
import type { AudioSys } from '../audio/Audio';
import type { Input } from '../input/Input';
import type { Backend } from '../net/Backend';
import { type Profile, XP_PER_LEVEL, BP_XP_PER_TIER, BP_TIERS } from '../net/Profile';
import { WEAPONS, ATTACHMENTS, RARITY, type WeaponDef } from '../weapons/WeaponDefs';
import { Weapon } from '../weapons/Weapon';
import { VEHICLES } from '../vehicles/VehicleDefs';

export interface PlayRequest { mode: 'br' | 'zombieroyale' | 'mp' | 'zombies'; sub: string; night: boolean; party: string[] }
type Tab = 'play' | 'loadout' | 'operator' | 'pass' | 'store' | 'career' | 'settings' | 'credits';

const MODES = [
  { id: 'br', name: 'Battle Royale', tag: '100 SPIELER', desc: 'Absprung aus dem Flugzeug, Loot, Sturm, Fahrzeuge zu Land, Wasser & Luft. Letztes Team gewinnt.', subs: [['solos', 'Solo'], ['duos', 'Duos'], ['trios', 'Trios'], ['quads', 'Quads'], ['sniper', 'Nur Sniper'], ['cqb', 'CQB'], ['hightier', 'High-Tier Loot'], ['extraction', 'Extraktion']] },
  { id: 'zombieroyale', name: 'Zombie Royale', tag: 'NEU', desc: 'Battle Royale mit Zombie-Horden an den POIs. Gefallene Spieler erheben sich wieder.', subs: [['solos', 'Solo'], ['duos', 'Duos'], ['quads', 'Quads']] },
  { id: 'mp', name: 'Multiplayer', tag: '6v6', desc: 'Kompakte 3-Lane-Map, Loadouts, Scorestreaks, taktische Respawns.', subs: [['tdm', 'Team Deathmatch'], ['ffa', 'Free-for-All'], ['ctf', 'Capture the Flag'], ['snd', 'Search & Destroy']] },
  { id: 'zombies', name: 'Zombies', tag: 'STORY', desc: 'Rundenbasiert: Türen kaufen, Perks, Mystery Box, Pack-a-Punch und ein Easter Egg mit Ende.', subs: [['outpost', 'Outpost 9']] },
] as const;

const OPERATORS = [
  { id: 'char_mannequin', name: 'Vanguard', desc: 'Standard-Operator' },
  { id: 'char_mannequin_f', name: 'Nova', desc: 'Aufklärung' },
  { id: 'char_hero_m', name: 'Titan', desc: 'Schwere Infanterie' },
  { id: 'char_hero_f', name: 'Raven', desc: 'Spezialkräfte' },
];
const TINTS = [0x3a6ea5, 0x2e8b57, 0x8b3a3a, 0x6b6b6b, 0xc9a227, 0x5b3a8b, 0x1f1f1f, 0xd8d8d8];
const TIPS = [
  'Tipp: Sprinten + Ducken = Rutschen. Lass Ducken früh los für einen Slide-Cancel.',
  'Tipp: Kaliber ab 7.62 schießen durch Holz und dünnes Blech.',
  'Tipp: Mit Q/E lehnst du dich um Ecken.',
  'Tipp: Gedrückt halten [G] zeigt die Wurfbahn der Granate.',
  'Tipp: Schallgedämpfte Waffen erscheinen nicht auf dem Radar.',
  'Tipp: Fahrzeuge findest du an Straßen, Häfen, Flugfeldern und der Militärbasis.',
  'Tipp: Im Zombie-Modus brauchst du Strom für Perks und Pack-a-Punch.',
];

export class Menu {
  root = document.createElement('div');
  private tab: Tab = 'play';
  private mode: (typeof MODES)[number]['id'] = 'br';
  private sub = 'solos';
  private night = false;
  private party: string[] = [];
  private editSlot: 'primary' | 'secondary' = 'primary';
  onPlay: ((r: PlayRequest) => void) | null = null;
  onProfileChange: (() => void) | null = null;
  private focusIdx = 0;
  private navT = 0;

  constructor(private parent: HTMLElement, private profile: Profile, private backend: Backend, private audio: AudioSys, private input: Input) {
    this.root.className = 'menu';
    parent.appendChild(this.root);
    this.render();
    addEventListener('keydown', (e) => { if (!this.root.classList.contains('hidden') && e.key === 'Enter' && document.activeElement === document.body) this.activateFocus(); });
  }

  show() { this.root.classList.remove('hidden'); this.render(); this.audio.playMusic('menu'); }
  hide() { this.root.classList.add('hidden'); }
  get visible() { return !this.root.classList.contains('hidden'); }

  private g(a: Parameters<Input['glyph']>[0]) { return `<span class="glyph">${this.input.glyph(a)}</span>`; }

  render() {
    const p = this.profile;
    const tabs: [Tab, string][] = [['play', 'Spielen'], ['loadout', 'Loadout'], ['operator', 'Operator'], ['pass', 'Battle Pass'], ['store', 'Kisten'], ['career', 'Karriere'], ['settings', 'Einstellungen'], ['credits', 'Credits']];
    this.root.innerHTML = `
      <div class="topbar">
        <div class="logo">LUMOS <b>STRIKE</b></div>
        <div class="tabs">${tabs.map(([id, n]) => `<button class="tab ${this.tab === id ? 'active' : ''}" data-tab="${id}">${n}</button>`).join('')}</div>
        <div class="wallet"><span class="pill">LVL ${p.level}</span><span class="pill">◈ ${p.coins}</span><span class="pill">🎁 ${p.chests}</span><span class="pill" title="Backend">☁ ${this.backend.label}</span></div>
      </div>
      <div class="content">${this.renderTab()}</div>
      <div class="footer"><span>${this.g('jump')} Auswählen · ${this.g('crouch')} Zurück · LB/RB Tabs · Controller: ${this.input.padType}</span><span>${TIPS[Math.floor(Date.now() / 8000) % TIPS.length]}</span></div>`;
    this.root.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => (b.onclick = () => { this.tab = b.dataset.tab as Tab; this.audio.ui('swipe'); this.focusIdx = 0; this.render(); }));
    this.wire();
    this.applyFocus();
  }

  private renderTab(): string {
    switch (this.tab) {
      case 'play': return this.renderPlay();
      case 'loadout': return this.renderLoadout();
      case 'operator': return this.renderOperator();
      case 'pass': return this.renderPass();
      case 'store': return this.renderStore();
      case 'career': return this.renderCareer();
      case 'settings': return this.renderSettings();
      case 'credits': return this.renderCredits();
    }
  }

  private renderPlay() {
    const m = MODES.find((x) => x.id === this.mode)!;
    const p = this.profile;
    const lo = p.loadouts[p.selectedLoadout];
    const partySize = this.mode === 'br' || this.mode === 'zombieroyale' ? ({ solos: 1, duos: 2, trios: 3, quads: 4 } as Record<string, number>)[this.sub] ?? 1 : 4;
    return `
      <div class="grid cols-2">
        <div class="card lobby-stage">
          <div style="position:absolute;top:14px;left:16px"><h3>Lobby</h3><p>${p.name} · Operator ${OPERATORS.find((o) => o.id === p.operator)?.name ?? ''}</p></div>
          <div class="party">
            <div class="member"><b>${p.name}</b><small>LVL ${p.level} · Leader</small></div>
            ${this.party.map((n, i) => `<div class="member"><b>${n}</b><small>KI-Squad · <a href="#" data-kick="${i}" style="color:var(--danger)">Kick</a></small></div>`).join('')}
            ${this.party.length + 1 < partySize ? `<button class="chip" data-invite>+ Einladen</button><button class="chip" data-addbot>+ KI-Squadmate</button>` : ''}
          </div>
          <div class="play-row"><button class="btn" data-play>${this.g('jump')} Spielen</button><span style="color:var(--muted)">Loadout: <b style="color:var(--text)">${lo.name}</b> (${WEAPONS[lo.primary.id].name} / ${WEAPONS[lo.secondary.id].name})</span></div>
        </div>
        <div class="grid">
          ${MODES.map((x) => `<div class="card mode ${x.id === this.mode ? 'selected' : ''}" data-mode="${x.id}"><span class="tag">${x.tag}</span><h3>${x.name}</h3><p>${x.desc}</p></div>`).join('')}
        </div>
      </div>
      <div class="card" style="margin-top:14px"><h3>${m.name} – Modus</h3>
        <div class="chips">${m.subs.map(([id, n]) => `<button class="chip ${this.sub === id ? 'active' : ''}" data-sub="${id}">${n}</button>`).join('')}
        ${this.mode === 'mp' ? `<button class="chip ${this.night ? 'active' : ''}" data-night>Nachtkarte (NVG)</button>` : ''}</div>
      </div>`;
  }

  private renderLoadout() {
    const p = this.profile;
    const lo = p.loadouts[p.selectedLoadout];
    const slot = lo[this.editSlot];
    const def = WEAPONS[slot.id];
    const wpn = new Weapon(slot.id, 1, slot.attachments);
    const st = wpn.stats;
    const bar = (label: string, v: number, max: number) => `<div class="lbl"><span>${label}</span><span>${Math.round(v * 10) / 10}</span></div><div class="bar"><i style="width:${Math.min(100, (v / max) * 100)}%"></i></div>`;
    const weapons = Object.values(WEAPONS).filter((w) => w.cls !== 'melee' && (this.editSlot === 'secondary' || w.cls !== 'pistol' || true));
    const slots = ['optic', 'muzzle', 'underbarrel', 'magazine', 'stock', 'laser'];
    return `
      <div class="chips" style="margin-bottom:12px">${p.loadouts.map((l, i) => `<button class="chip ${i === p.selectedLoadout ? 'active' : ''}" data-lo="${i}">${l.name}</button>`).join('')}
        <button class="chip ${this.editSlot === 'primary' ? 'active' : ''}" data-slot="primary">Primär</button><button class="chip ${this.editSlot === 'secondary' ? 'active' : ''}" data-slot="secondary">Sekundär</button></div>
      <div class="grid cols-3">
        <div class="card"><h3>Waffe</h3><div class="list">${weapons.map((w) => `<div class="row ${w.id === slot.id ? 'active' : ''}" data-weapon="${w.id}"><span>${w.name}</span><span class="r">${w.cls.toUpperCase()}${p.unlocked.includes(w.id) ? '' : ' 🔒 ' + unlockLevel(w) + '+'}</span></div>`).join('')}</div></div>
        <div class="card"><h3>Gunsmith – ${def.name}</h3>
          ${slots.map((s) => { const opts = ATTACHMENTS.filter((a) => a.slot === s); const cur = slot.attachments.find((id) => opts.some((o) => o.id === id)); return `<div class="setting"><span>${s.toUpperCase()}</span><select data-att="${s}"><option value="">– keins –</option>${opts.map((o) => `<option value="${o.id}" ${cur === o.id ? 'selected' : ''}>${o.name}</option>`).join('')}</select></div>`; }).join('')}
          <p style="margin-top:8px">${slot.attachments.map((id) => ATTACHMENTS.find((a) => a.id === id)?.desc).filter(Boolean).join(' · ') || 'Aufsätze verändern das 3D-Modell, Rückstoß, ADS-Zeit und Lautstärke.'}</p>
        </div>
        <div class="card statbars"><h3>Werte</h3>
          ${bar('Schaden', st.damage * (st.pellets ?? 1), 140)}${bar('Feuerrate (RPM)', st.rpm, 1000)}${bar('Reichweite (m)', st.range, 500)}
          ${bar('Kontrolle', 10 - st.recoilV * 2, 10)}${bar('ADS-Tempo', 1 / st.adsTime, 8)}${bar('Magazin', st.mag, 80)}${bar('Mobilität', st.moveMul * 10, 11)}
          <p style="margin-top:10px">${st.silenced ? '🔇 Schallgedämpft – kein Radar-Ping. ' : ''}${st.thermal ? '🔥 Wärmebild. ' : ''}Durchschlag: ${['keiner', 'Holz/Blech', 'Beton-leicht'][st.penetration]}</p>
        </div>
      </div>`;
  }

  private renderOperator() {
    const p = this.profile;
    return `<div class="grid cols-4">${OPERATORS.map((o) => `<div class="card mode ${p.operator === o.id ? 'selected' : ''}" data-op="${o.id}"><h3>${o.name}</h3><p>${o.desc}</p></div>`).join('')}</div>
      <div class="card" style="margin-top:14px"><h3>Skin-Farbe</h3><div class="chips">${TINTS.map((t) => `<button class="chip ${p.operatorTint === t ? 'active' : ''}" data-tint="${t}" style="background:#${t.toString(16).padStart(6, '0')};width:44px;height:30px"></button>`).join('')}</div>
      <p style="margin-top:8px">Emote im Spiel: ${this.g('emote')} · Die Lobby zeigt deinen Operator in 3D.</p></div>`;
  }

  private renderPass() {
    const p = this.profile;
    const tiers = Array.from({ length: BP_TIERS }, (_, i) => i + 1);
    const reward = (t: number) => (t % 10 === 0 ? 'Legendäre Kiste' : t % 3 === 0 ? 'Kiste' : t % 5 === 0 ? 'Waffen-Unlock' : `${100 + t * 10} ◈`);
    return `<div class="card"><h3>Battle Pass – Season 1 "Lumos Dawn"</h3><p>Stufe ${p.battlePassTier}/${BP_TIERS} · ${p.battlePassXp}/${BP_XP_PER_TIER} XP ${p.premiumPass ? '· PREMIUM' : ''}</p>
      <div class="bar" style="margin:10px 0"><i style="width:${(p.battlePassXp / BP_XP_PER_TIER) * 100}%"></i></div>
      <div class="bp">${tiers.map((t) => `<div class="tier ${t <= p.battlePassTier ? 'done' : t === p.battlePassTier + 1 ? 'cur' : ''}"><b>${t}</b><span>${reward(t)}</span><span style="color:var(--muted)">${t <= p.battlePassTier ? '✔ freigeschaltet' : ''}</span></div>`).join('')}</div>
      ${!p.premiumPass ? `<div class="play-row"><button class="btn small" data-premium>Premium Pass (1000 ◈)</button></div>` : ''}</div>`;
  }

  private renderStore() {
    const p = this.profile;
    return `<div class="grid cols-2"><div class="card"><h3>Kisten</h3><p>Du hast ${p.chests} Kiste(n). Kisten gibt es alle 5 Level und alle 3 Battle-Pass-Stufen.</p>
      <div class="chest-stage"><div class="chest" id="chest"><div class="lid"></div><div class="face"></div><div class="glow"></div></div></div><div class="reward" id="reward"></div>
      <div class="play-row"><button class="btn" data-open ${p.chests <= 0 ? 'disabled' : ''}>Kiste öffnen</button><button class="btn ghost small" data-buychest>Kiste kaufen (300 ◈)</button></div></div>
      <div class="card"><h3>Waffenkiste / Extraktions-Beute</h3><div class="list">${p.stash.length ? p.stash.map((s) => `<div class="row"><span class="rarity-${s.rarity}">${WEAPONS[s.id]?.name ?? s.id}</span><span class="r">${RARITY[s.rarity].name}</span></div>`).join('') : '<p>Extrahiere im BR-Modus "Extraktion", um Beute dauerhaft zu behalten.</p>'}</div>
      <h3 style="margin-top:14px">Freigeschaltet</h3><p>${p.unlocked.map((u) => WEAPONS[u]?.name ?? ATTACHMENTS.find((a) => a.id === u)?.name ?? u).join(', ')}</p></div></div>`;
  }

  private renderCareer() {
    const s = this.profile.stats, p = this.profile;
    const kd = s.kills / Math.max(1, s.deaths || s.matches);
    return `<div class="grid cols-2"><div class="card"><h3>${p.name}</h3><p>Level ${p.level} · ${p.xp}/${XP_PER_LEVEL(p.level)} XP</p><div class="bar" style="margin:10px 0"><i style="width:${(p.xp / XP_PER_LEVEL(p.level)) * 100}%"></i></div>
      <div class="stat-row">${[['Matches', s.matches], ['Siege', s.wins], ['Kills', s.kills], ['K/D', kd.toFixed(2)], ['Zombies Rekord', `R${s.zombiesBestRound}`], ['Easter Eggs', s.eggs], ['Extraktionen', s.extractions]].map(([l, v]) => `<div class="stat"><b>${v}</b><small>${l}</small></div>`).join('')}</div>
      <div class="setting" style="margin-top:14px"><span>Spielername</span><input data-name value="${p.name}" maxlength="16" /></div></div>
      <div class="card"><h3>Freunde (${this.backend.label})</h3><div class="list" id="friends"><p>Lade…</p></div></div></div>
      <div class="card" style="margin-top:14px"><h3>Fahrzeuge im Spiel (${Object.keys(VEHICLES).length})</h3><p>${Object.values(VEHICLES).map((v) => v.name).join(' · ')}</p></div>`;
  }

  private renderSettings() {
    const d = settings.data;
    const sel = (k: string, opts: [string, string][], v: string) => `<select data-set="${k}">${opts.map(([o, n]) => `<option value="${o}" ${v === o ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
    const rng = (k: string, min: number, max: number, step: number, v: number) => `<input type="range" data-set="${k}" min="${min}" max="${max}" step="${step}" value="${v}" />`;
    const chk = (k: string, v: boolean) => `<input type="checkbox" data-set="${k}" ${v ? 'checked' : ''} />`;
    return `<div class="card"><div class="settings-grid">
      <div class="setting"><span>Grafikqualität</span>${sel('quality', [['potato', 'Potato (Handheld)'], ['low', 'Niedrig'], ['medium', 'Mittel'], ['high', 'Hoch']], d.quality)}</div>
      <div class="setting"><span>Dynamische Auflösung</span>${chk('autoQuality', d.autoQuality)}</div>
      <div class="setting"><span>Min. Render-Skalierung</span>${rng('drsMin', 0.4, 1, 0.05, d.drsMin)}</div>
      <div class="setting"><span>Ziel-FPS</span>${sel('targetFps', [['30', '30'], ['45', '45'], ['60', '60'], ['90', '90'], ['120', '120']], String(d.targetFps))}</div>
      <div class="setting"><span>Sichtfeld (FOV)</span>${rng('fov', 60, 110, 1, d.fov)}</div>
      <div class="setting"><span>FPS anzeigen</span>${chk('showFps', d.showFps)}</div>
      <div class="setting"><span>Maus-Empfindlichkeit</span>${rng('mouseSens', 0.2, 3, 0.05, d.mouseSens)}</div>
      <div class="setting"><span>Controller-Empfindlichkeit</span>${rng('padSens', 0.2, 3, 0.05, d.padSens)}</div>
      <div class="setting"><span>ADS-Multiplikator</span>${rng('adsSensMul', 0.2, 1.5, 0.05, d.adsSensMul)}</div>
      <div class="setting"><span>Y-Achse invertieren</span>${chk('invertY', d.invertY)}</div>
      <div class="setting"><span>Gyro-Zielen (Lumos/Handheld)</span>${chk('gyroAim', d.gyroAim)}</div>
      <div class="setting"><span>Gyro-Empfindlichkeit</span>${rng('gyroSens', 0.2, 3, 0.05, d.gyroSens)}</div>
      <div class="setting"><span>Aim Assist (Controller)</span>${chk('aimAssist', d.aimAssist)}</div>
      <div class="setting"><span>Haptik / Vibration</span>${chk('haptics', d.haptics)}</div>
      <div class="setting"><span>Tasten-Symbole</span>${sel('glyphs', [['auto', 'Automatisch'], ['keyboard', 'Tastatur'], ['xbox', 'Xbox'], ['playstation', 'PlayStation'], ['lumos', 'Lumos']], d.glyphs)}</div>
      <div class="setting"><span>Touch-Steuerung</span>${sel('touchControls', [['auto', 'Automatisch'], ['on', 'An'], ['off', 'Aus']], d.touchControls)}</div>
      <div class="setting"><span>Third Person</span>${chk('thirdPerson', d.thirdPerson)}</div>
      <div class="setting"><span>Gesamtlautstärke</span>${rng('masterVolume', 0, 1, 0.05, d.masterVolume)}</div>
      <div class="setting"><span>Musik</span>${rng('musicVolume', 0, 1, 0.05, d.musicVolume)}</div>
      <div class="setting"><span>Effekte</span>${rng('sfxVolume', 0, 1, 0.05, d.sfxVolume)}</div>
    </div><p style="margin-top:10px">Qualitätsänderungen gelten ab dem nächsten Match. Tastatur: WASD, Maus, Shift Sprint, C Ducken, Space Sprung, F Nutzen, R Nachladen, G Granate, H Heilen, X Platte, Q/E Lehnen, V Messer, T Kamera, N Nachtsicht, I Inspizieren, B Scorestreak, M Karte.</p></div>`;
  }

  private renderCredits() {
    return `<div class="card"><h3>Credits & Lizenzen</h3><p>Alle 3D-Modelle, Sounds und Musik stammen von Sketchfab und itch.io. Vollständige Liste mit Autoren und Lizenzen: <a href="./CREDITS.html" target="_blank" style="color:var(--accent)">CREDITS</a>. Quaternius (CC0), Tallbeard Studios (CC0), Sketchfab-Künstler (CC-BY 4.0) und weitere.</p>
      <p style="margin-top:10px">Engine: three.js · Physik: Rapier (WASM) · Backend: Lumos Cloud / Supabase.</p></div>`;
  }

  private wire() {
    const q = <T extends HTMLElement>(sel: string) => [...this.root.querySelectorAll<T>(sel)];
    const p = this.profile;
    const save = () => { this.backend.saveProfile(p); this.onProfileChange?.(); };
    q('[data-mode]').forEach((e) => (e.onclick = () => { this.mode = e.dataset.mode as any; const m = MODES.find((x) => x.id === this.mode)!; this.sub = m.subs[0][0]; this.audio.ui('select'); this.render(); }));
    q('[data-sub]').forEach((e) => (e.onclick = () => { this.sub = e.dataset.sub!; this.audio.ui('cursor'); this.render(); }));
    q('[data-night]').forEach((e) => (e.onclick = () => { this.night = !this.night; this.render(); }));
    q('[data-play]').forEach((e) => (e.onclick = () => { this.audio.ui('confirm'); this.onPlay?.({ mode: this.mode, sub: this.sub, night: this.night, party: this.party }); }));
    q('[data-addbot]').forEach((e) => (e.onclick = () => { this.party.push(['Ghost', 'Rook', 'Nova', 'Echo'][this.party.length % 4]); this.render(); }));
    q('[data-kick]').forEach((e) => (e.onclick = (ev) => { ev.preventDefault(); this.party.splice(+e.dataset.kick!, 1); this.render(); }));
    q('[data-invite]').forEach((e) => (e.onclick = async () => {
      const fr = await this.backend.friends();
      const online = fr.filter((f) => f.online);
      if (!online.length) { alert(`Keine Freunde online (${this.backend.label}). Verbinde Lumos Cloud oder Supabase, um Freunde einzuladen.`); return; }
      const ok = await this.backend.invite(online[0].id);
      alert(ok ? `Einladung an ${online[0].name} gesendet` : 'Einladung fehlgeschlagen');
    }));
    q('[data-lo]').forEach((e) => (e.onclick = () => { p.selectedLoadout = +e.dataset.lo!; save(); this.render(); }));
    q('[data-slot]').forEach((e) => (e.onclick = () => { this.editSlot = e.dataset.slot as any; this.render(); }));
    q('[data-weapon]').forEach((e) => (e.onclick = () => {
      const id = e.dataset.weapon!;
      if (!p.unlocked.includes(id) && p.level < unlockLevel(WEAPONS[id])) { this.audio.ui('error'); return; }
      if (!p.unlocked.includes(id)) p.unlocked.push(id);
      p.loadouts[p.selectedLoadout][this.editSlot] = { id, attachments: [] };
      this.audio.ui('select'); save(); this.render();
    }));
    q<HTMLSelectElement>('[data-att]').forEach((e) => (e.onchange = () => {
      const slot = p.loadouts[p.selectedLoadout][this.editSlot];
      const opts = ATTACHMENTS.filter((a) => a.slot === e.dataset.att).map((a) => a.id);
      slot.attachments = slot.attachments.filter((a) => !opts.includes(a));
      if (e.value) slot.attachments.push(e.value);
      save(); this.render();
    }));
    q('[data-op]').forEach((e) => (e.onclick = () => { p.operator = e.dataset.op!; save(); this.render(); }));
    q('[data-tint]').forEach((e) => (e.onclick = () => { p.operatorTint = +e.dataset.tint!; save(); this.render(); }));
    q('[data-premium]').forEach((e) => (e.onclick = () => { if (p.coins >= 1000) { p.coins -= 1000; p.premiumPass = true; save(); this.render(); } else this.audio.ui('error'); }));
    q('[data-buychest]').forEach((e) => (e.onclick = () => { if (p.coins >= 300) { p.coins -= 300; p.chests++; save(); this.render(); } else this.audio.ui('error'); }));
    q('[data-open]').forEach((e) => (e.onclick = () => this.openChest()));
    q<HTMLInputElement>('[data-name]').forEach((e) => (e.onchange = () => { p.name = e.value.slice(0, 16) || 'Operator'; settings.set('playerName', p.name); save(); }));
    q<HTMLInputElement>('[data-set]').forEach((e) => (e.oninput = e.onchange = () => {
      const k = e.dataset.set as keyof typeof settings.data;
      const cur = settings.data[k];
      const v = e.type === 'checkbox' ? e.checked : typeof cur === 'number' ? +e.value : e.value;
      settings.set(k, v as never);
      if (k === 'quality') settings.set('quality', e.value as Quality);
    }));
    const fl = this.root.querySelector('#friends');
    if (fl) this.backend.friends().then((f) => { fl.innerHTML = f.length ? f.map((x) => `<div class="row"><span>${x.name}</span><span class="r">${x.online ? '🟢 online' : 'offline'} · ${x.source}</span></div>`).join('') : `<p>Keine Freunde gefunden. Mit Lumos Cloud oder Supabase verbunden erscheinen hier deine Freunde.</p>`; });
  }

  private openChest() {
    const p = this.profile;
    if (p.chests <= 0) return;
    p.chests--;
    const chest = this.root.querySelector('#chest') as HTMLElement;
    const out = this.root.querySelector('#reward') as HTMLElement;
    chest.classList.remove('open'); chest.classList.add('shake');
    this.audio.play('crate_smash', { volume: 0.4 });
    setTimeout(() => {
      chest.classList.remove('shake');
      const roll = Math.random();
      const rarity = roll > 0.95 ? 4 : roll > 0.8 ? 3 : roll > 0.5 ? 2 : 1;
      const locked = [...Object.keys(WEAPONS).filter((w) => !p.unlocked.includes(w) && w !== 'knife'), ...ATTACHMENTS.map((a) => a.id).filter((a) => !p.unlocked.includes(a))];
      let text: string;
      if (locked.length && Math.random() < 0.6) {
        const id = locked[Math.floor(Math.random() * locked.length)];
        p.unlocked.push(id);
        text = `${WEAPONS[id]?.name ?? ATTACHMENTS.find((a) => a.id === id)?.name} freigeschaltet!`;
      } else { const c = 50 * (rarity + 1) * (rarity + 1); p.coins += c; text = `${c} Lumos Coins`; }
      chest.style.setProperty('--glow', RARITY[rarity].color + 'cc');
      chest.classList.add('open');
      out.innerHTML = `<span class="rarity-${rarity}">${RARITY[rarity].name}: ${text}</span>`;
      this.audio.play('coin', { volume: 0.8 });
      this.backend.saveProfile(p);
      setTimeout(() => this.render(), 2600);
    }, 1000);
  }

  // ------------------------------------------------------------------ controller navigation
  private focusables() { return [...this.root.querySelectorAll<HTMLElement>('button:not([disabled]), [data-mode], [data-weapon], [data-op], select, input, [data-lo]')].filter((e) => e.offsetParent !== null); }
  private applyFocus() { if (this.input.device !== 'gamepad') return; const f = this.focusables(); f.forEach((e) => e.classList.remove('focus')); const el = f[Math.min(this.focusIdx, f.length - 1)]; el?.classList.add('focus'); el?.scrollIntoView({ block: 'nearest' }); }
  private activateFocus() { const f = this.focusables(); const el = f[this.focusIdx]; if (!el) return; if (el.tagName === 'SELECT') { const s = el as HTMLSelectElement; s.selectedIndex = (s.selectedIndex + 1) % s.options.length; s.dispatchEvent(new Event('change')); } else if ((el as HTMLInputElement).type === 'checkbox') { (el as HTMLInputElement).checked = !(el as HTMLInputElement).checked; el.dispatchEvent(new Event('change')); } else el.click(); }

  /** poll the gamepad for menu navigation (called every frame while the menu is visible) */
  update(dt: number) {
    if (!this.visible) return;
    const inp = this.input;
    this.navT -= dt;
    const y = inp.moveY, x = inp.moveX;
    if (this.navT <= 0 && (Math.abs(y) > 0.5 || Math.abs(x) > 0.5)) {
      this.navT = 0.18;
      const f = this.focusables();
      const el = f[this.focusIdx];
      if (el && el.getAttribute('type') === 'range' && Math.abs(x) > 0.5) {
        const r = el as HTMLInputElement; r.value = String(+r.value + Math.sign(x) * +r.step); r.dispatchEvent(new Event('input'));
      } else this.focusIdx = (this.focusIdx + (y < -0.5 || x > 0.5 ? 1 : -1) + f.length) % Math.max(1, f.length);
      this.audio.ui('cursor');
      this.applyFocus();
    }
    if (inp.pressed('jump')) this.activateFocus();
    const tabs: Tab[] = ['play', 'loadout', 'operator', 'pass', 'store', 'career', 'settings', 'credits'];
    if (inp.pressed('grenade') || inp.pressed('melee')) { const i = tabs.indexOf(this.tab); this.tab = tabs[(i + (inp.pressed('melee') ? 1 : tabs.length - 1)) % tabs.length]; this.focusIdx = 0; this.audio.ui('swipe'); this.render(); }
    if (inp.pressed('crouch') && this.tab !== 'play') { this.tab = 'play'; this.render(); }
  }
}

function unlockLevel(w: WeaponDef) { const order = Object.keys(WEAPONS); return Math.max(1, order.indexOf(w.id) * 2 - 6); }
