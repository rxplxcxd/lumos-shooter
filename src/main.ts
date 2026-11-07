import './ui/ui.css';
import { Engine } from './core/Engine';
import { settings, QUALITY_PRESETS } from './core/Settings';
import { Input } from './input/Input';
import { AudioSys } from './audio/Audio';
import { AssetManager } from './assets/AssetManager';
import { Physics } from './physics/Physics';
import { createBackend, type Backend } from './net/Backend';
import { applyMatchResult, type Profile } from './net/Profile';
import { NetClient, type StartInfo } from './net/NetClient';
import { NetSync } from './net/NetSync';
import { Menu, type PlayRequest } from './ui/Menu';
import { Lobby3D } from './ui/Lobby3D';
import { HUD } from './ui/HUD';
import { TouchControls } from './ui/Touch';
import { PhotoMode } from './ui/PhotoMode';
import { GameWorld } from './gameplay/GameWorld';
import { BattleRoyale } from './gameplay/modes/BattleRoyale';
import { Multiplayer } from './gameplay/modes/Multiplayer';
import { ZombiesMode } from './gameplay/modes/Zombies';
import type { SoldierMode } from './gameplay/SoldierMode';
import { CharacterModel } from './entities/CharacterModel';

const TIPS = [
  'Panzerplatten mit [X] / ↓ einsetzen – bis zu 3 Platten mit Weste Stufe 3.',
  'Fahrzeuge: Autos, Panzer, Motorräder, Jetskis, Boote, U-Boot, Helis, Flugzeuge & Jets.',
  'Gyro-Zielen in den Einstellungen aktivieren (Lumos Handheld / Steam Deck / Smartphone).',
  'Low-End-Gerät? Die dynamische Auflösung hält die FPS stabil.',
  'Zombies: Kopfschüsse bringen mehr Punkte, Beintreffer machen Kriecher.',
];

class App {
  engine: Engine;
  input: Input;
  audio: AudioSys;
  assets: AssetManager;
  backend!: Backend;
  profile!: Profile;
  menu!: Menu;
  lobby!: Lobby3D;
  ui = document.getElementById('ui')!;
  world: GameWorld | null = null;
  hud: HUD | null = null;
  touch: TouchControls | null = null;
  net = new NetClient();
  private loadingEl: HTMLElement | null = null;

  constructor() {
    this.engine = new Engine(document.getElementById('game')!);
    this.input = new Input(this.engine.renderer.domElement);
    this.audio = new AudioSys();
    this.assets = new AssetManager(this.engine.renderer);
    this.assets.lowSpec = QUALITY_PRESETS[settings.data.quality].lowSpecMaterials;
    (window as any).app = this; // debugging & automated tests
  }

  loading(show: boolean, p = 0, label = '') {
    if (show && !this.loadingEl) {
      this.loadingEl = document.createElement('div');
      this.loadingEl.className = 'loading';
      this.loadingEl.innerHTML = `<div class="box"><div class="logo" style="font-size:44px">LUMOS <b>STRIKE</b></div><div class="lbl" style="margin-top:12px;color:var(--muted)"></div><div class="bar"><i style="width:0%"></i></div><div class="tip">${TIPS[Math.floor(Math.random() * TIPS.length)]}</div></div>`;
      this.ui.appendChild(this.loadingEl);
    }
    if (!show) { this.loadingEl?.remove(); this.loadingEl = null; return; }
    (this.loadingEl!.querySelector('.bar i') as HTMLElement).style.width = `${Math.round(p * 100)}%`;
    (this.loadingEl!.querySelector('.lbl') as HTMLElement).textContent = label;
  }

  async boot() {
    this.loading(true, 0.02, 'Initialisiere Physik (WASM)…');
    await Physics.init();
    this.loading(true, 0.08, 'Verbinde Lumos Cloud / Supabase…');
    this.backend = await createBackend();
    this.profile = await this.backend.loadProfile();
    if (settings.data.playerName) this.profile.name = settings.data.playerName;
    this.loading(true, 0.15, 'Lade Assets…');
    await this.assets.preload(['anims', 'char_mannequin', 'char_mannequin_f', 'w_ar', 'w_pistol', 'car_muscle', 'item_crate', 'heli_huey', this.profile.operator], (d, t) => this.loading(true, 0.15 + (d / t) * 0.5, `Lade Assets ${d}/${t}`));
    await CharacterModel.preload(this.assets);
    this.loading(true, 0.7, 'Lade Sounds…');
    await this.audio.preloadAll((d, t) => this.loading(true, 0.7 + (d / t) * 0.28, `Lade Sounds ${d}/${t}`));
    this.lobby = new Lobby3D(this.engine, this.assets);
    await this.lobby.build(this.profile);
    this.menu = new Menu(this.ui, this.profile, this.backend, this.audio, this.input);
    this.menu.onPlay = (r) => this.startMatch(r);
    this.menu.attachNet(this.net);
    this.net.on('start', (m: StartInfo) => { if (!this.world) this.startMatch({ mode: m.mode as PlayRequest['mode'], sub: m.sub, night: m.night, party: [] }, m); });
    this.menu.onProfileChange = () => this.lobby.setOperator(this.profile);
    this.loading(false);
    this.enterMenu();
    this.engine.start();
    // realtime relay (same-origin /ws via the Vite proxy, or VITE_REALTIME_URL) – optional
    this.net.connect(this.profile.name).then((ok) => { console.info('[net]', ok ? 'online' : 'offline', NetClient.url()); this.menu.render(); });
  }

  enterMenu() {
    this.engine.clearCallbacks();
    this.engine.setPost('none');
    this.engine.overlay.clear();
    this.input.unlock();
    this.menu.show();
    this.engine.onUpdate((dt) => {
      this.input.poll(dt);
      this.menu.update(dt);
      this.lobby.update(dt);
      this.input.endFrame();
    });
  }

  async startMatch(r: PlayRequest, netStart?: StartInfo) {
    this.menu.hide();
    this.loading(true, 0, 'Matchmaking…');
    this.engine.clearCallbacks();
    this.lobby.dispose();
    this.engine.scene.clear();
    this.assets.lowSpec = QUALITY_PRESETS[settings.data.quality].lowSpecMaterials;
    this.engine.applyQuality();
    const w = new GameWorld(this.engine, this.assets, this.audio, this.input);
    this.world = w;
    if (netStart && this.net.connected) w.net = new NetSync(w, this.net, netStart);
    const seed = netStart?.seed;
    let mode: SoldierMode;
    if (r.mode === 'br' || r.mode === 'zombieroyale') mode = new BattleRoyale(w, { sub: r.sub, zombies: r.mode === 'zombieroyale', seed });
    else if (r.mode === 'mp') mode = new Multiplayer(w, { sub: r.sub, night: r.night, seed });
    else mode = new ZombiesMode(w, { sub: r.sub, seed });
    mode.loadout = this.profile.loadouts[this.profile.selectedLoadout];
    mode.playerName = this.profile.name;
    mode.playerModel = this.profile.operator;
    mode.playerTint = this.profile.operatorTint;
    w.mode = mode;
    try {
      await mode.setup((p, l) => this.loading(true, p, l));
      if (w.net && w.player) { this.loading(true, 0.99, 'Synchronisiere Mitspieler…'); await w.net.init(w.player.soldier.pos.clone()); }
    } catch (e) {
      console.error(e);
      alert('Fehler beim Laden des Matches: ' + (e as Error).message);
      this.quitMatch();
      return;
    }
    // build all shaders behind the loading screen (no hitches once the match is visible)
    this.loading(true, 0.995, 'Shader werden vorbereitet…');
    await this.engine.warmup();
    this.loading(false);
    this.hud = new HUD(w, this.ui);
    this.hud.onQuit = () => this.quitMatch();
    this.hud.onPause = () => this.setPaused(false);
    const photo = new PhotoMode(w, this.input, this.ui);
    this.hud.onPhoto = () => photo.enter();
    photo.onExit = () => this.setPaused(true);
    if (TouchControls.wanted()) { this.touch = new TouchControls(this.input, this.ui); }
    this.engine.onFixed((dt) => w.fixedUpdate(dt));
    let resultApplied = false;
    this.engine.onUpdate((dt) => {
      this.input.poll(dt);
      if (photo.active) { photo.update(dt); this.input.endFrame(); return; }
      if (this.input.pressed('pause') && !mode.over) this.setPaused(!this.engine.paused);
      if (!this.engine.paused) {
        w.update(dt);
        this.hud!.update(dt);

      }
      if (mode.over && mode.result && !resultApplied) {
        resultApplied = true;
        const res = mode.result;
        const extracted = r.sub === 'extraction' && res.win ? (mode as BattleRoyale).extractedLoot?.() : undefined;
        applyMatchResult(this.profile, { xp: res.xp + w.stats.bonusXp, coins: res.coins, kills: w.player?.soldier.kills ?? 0, win: res.win, mode: r.mode, round: (mode as any).round, egg: (mode as any).eggStage === 3 && res.win, extracted });
        this.backend.saveProfile(this.profile);
        this.backend.pushMatch({ mode: r.mode, sub: r.sub, ...res, kills: w.player?.soldier.kills ?? 0 });
      }
      this.input.endFrame();
    });
    this.input.lock();
  }

  setPaused(p: boolean) {
    this.engine.paused = p;
    this.hud?.setPaused(p);
    if (p) this.input.unlock(); else this.input.lock();
  }

  async quitMatch() {
    if (this.world?.net?.host) this.net.send({ t: 'end' });
    this.engine.clearCallbacks();
    this.engine.paused = false;
    this.hud?.dispose(); this.hud = null;
    this.touch?.dispose(); this.touch = null;
    this.world?.dispose(); this.world = null;
    this.engine.overlay.clear();
    this.engine.setPost('none');
    this.engine.damageVignette = 0; this.engine.flash = 0;
    this.audio.stopMusic();
    this.loading(true, 0.5, 'Zurück zur Lobby…');
    this.engine.scene.clear();
    await this.lobby.build(this.profile);
    this.loading(false);
    this.enterMenu();
  }
}

const app = new App();
app.boot().catch((e) => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;inset:20px;color:#f66;z-index:99">${(e as Error).stack}</pre>`); });
