import * as THREE from 'three';
import { settings } from '../core/Settings';
import { AUDIO } from '../assets/manifest';

/**
 * Web Audio manager: buffer cache, 2D UI sounds, positional 3D sounds (HRTF panner +
 * distance roll-off + vertical occlusion dampening), looping engine sounds and music crossfades.
 */
export class AudioSys {
  ctx: AudioContext;
  master: GainNode;
  sfx: GainNode;
  music: GainNode;
  private buffers = new Map<string, AudioBuffer>();
  private loading = new Map<string, Promise<AudioBuffer | null>>();
  private musicSrc: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private musicName = '';
  listener = new THREE.Vector3();
  private lastPlay = new Map<string, number>();

  constructor() {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.sfx = this.ctx.createGain();
    this.music = this.ctx.createGain();
    this.sfx.connect(this.master);
    this.music.connect(this.master);
    // gentle limiter so 100 players shooting does not clip
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -10; comp.ratio.value = 8;
    this.master.connect(comp).connect(this.ctx.destination);
    this.applyVolumes();
    settings.onChange(() => this.applyVolumes());
    const unlock = () => { if (this.ctx.state !== 'running') this.ctx.resume(); };
    addEventListener('pointerdown', unlock); addEventListener('keydown', unlock); addEventListener('touchstart', unlock);
  }

  applyVolumes() {
    const d = settings.data;
    this.master.gain.value = d.masterVolume;
    this.sfx.gain.value = d.sfxVolume;
    this.music.gain.value = d.musicVolume;
  }

  load(name: string): Promise<AudioBuffer | null> {
    if (this.buffers.has(name)) return Promise.resolve(this.buffers.get(name)!);
    let p = this.loading.get(name);
    if (!p) {
      const url = name.startsWith('music/') ? `./assets/audio/${name}.mp3` : `./assets/audio/${name}.mp3`;
      p = fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
        .then((ab) => this.ctx.decodeAudioData(ab))
        .then((b) => { this.buffers.set(name, b); return b; })
        .catch(() => null);
      this.loading.set(name, p);
    }
    return p;
  }

  async preloadAll(onProgress?: (d: number, t: number) => void) {
    const names = [...AUDIO.sfx];
    for (const s of AUDIO.steps) { for (let i = 1; i <= 4; i++) names.push(`step_${s}_${i}`); names.push(`land_${s}`); }
    let done = 0;
    await Promise.all(names.map((n) => this.load(n).then(() => onProgress?.(++done, names.length))));
  }

  /** pick one of several variants: play('ar_shot', ...) chooses ar_shot_1..3 if present */
  private resolve(name: string): AudioBuffer | undefined {
    const direct = this.buffers.get(name);
    if (direct) return direct;
    const variants: AudioBuffer[] = [];
    for (let i = 1; i <= 5; i++) { const b = this.buffers.get(`${name}_${i}`); if (b) variants.push(b); }
    return variants.length ? variants[(Math.random() * variants.length) | 0] : undefined;
  }

  play(name: string, opts: { volume?: number; rate?: number; pos?: THREE.Vector3; maxDist?: number; throttle?: number } = {}) {
    if (this.ctx.state !== 'running') return null;
    const now = performance.now();
    if (opts.throttle) { const last = this.lastPlay.get(name) ?? 0; if (now - last < opts.throttle) return null; this.lastPlay.set(name, now); }
    const buf = this.resolve(name);
    if (!buf) { this.load(name); return null; }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (opts.rate ?? 1) * (0.96 + Math.random() * 0.08);
    const g = this.ctx.createGain();
    g.gain.value = opts.volume ?? 1;
    if (opts.pos) {
      const maxDist = opts.maxDist ?? 120;
      const d = opts.pos.distanceTo(this.listener);
      if (d > maxDist) return null;
      const p = this.ctx.createPanner();
      p.panningModel = d < 40 ? 'HRTF' : 'equalpower';
      p.distanceModel = 'inverse';
      p.refDistance = 4; p.rolloffFactor = 1.1; p.maxDistance = maxDist;
      p.positionX.value = opts.pos.x; p.positionY.value = opts.pos.y; p.positionZ.value = opts.pos.z;
      // vertical audio filtering: sounds from other floors are muffled
      const dy = Math.abs(opts.pos.y - this.listener.y);
      if (dy > 3) {
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = Math.max(500, 6000 - dy * 500);
        src.connect(lp).connect(g);
      } else src.connect(g);
      g.connect(p).connect(this.sfx);
    } else {
      src.connect(g).connect(this.sfx);
    }
    src.start();
    return { src, gain: g };
  }

  updateListener(cam: THREE.Camera) {
    const l = this.ctx.listener;
    const p = cam.getWorldPosition(new THREE.Vector3());
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    this.listener.copy(p);
    if (l.positionX) {
      l.positionX.value = p.x; l.positionY.value = p.y; l.positionZ.value = p.z;
      l.forwardX.value = f.x; l.forwardY.value = f.y; l.forwardZ.value = f.z;
      l.upX.value = u.x; l.upY.value = u.y; l.upZ.value = u.z;
    } else (l as any).setPosition(p.x, p.y, p.z);
  }

  /** Looping positional sound (vehicle engines, wind, storm hum). */
  loop(name: string, volume = 1): { set: (vol: number, rate: number, pos?: THREE.Vector3) => void; stop: () => void } | null {
    const buf = this.buffers.get(name);
    if (!buf) { this.load(name); return null; }
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const g = this.ctx.createGain(); g.gain.value = volume;
    const p = this.ctx.createPanner(); p.distanceModel = 'inverse'; p.refDistance = 6; p.rolloffFactor = 1;
    src.connect(g).connect(p).connect(this.sfx);
    src.start();
    return {
      set: (vol, rate, pos) => {
        g.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.05);
        src.playbackRate.setTargetAtTime(rate, this.ctx.currentTime, 0.05);
        if (pos) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; }
        else { p.positionX.value = this.listener.x; p.positionY.value = this.listener.y; p.positionZ.value = this.listener.z; }
      },
      stop: () => { try { src.stop(); } catch { /* */ } src.disconnect(); },
    };
  }

  /**
   * Procedural weather ambience bed: looping noise through filters – a low "wash" and a bright
   * "patter" layer for rain, a resonant hail layer and a slowly wobbling wind band. Gains follow
   * the weather intensities smoothly (sampled drips / thunder are layered on top by the weather).
   */
  weatherBed(): { set: (rain: number, hail: number, wind: number) => void; stop: () => void } | null {
    const ctx = this.ctx;
    const len = Math.floor(4 * ctx.sampleRate);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // pink-ish noise (Paul Kellet's filter) – more natural than white noise for rain
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    }
    const layer = (type: BiquadFilterType, freq: number, q: number) => {
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f).connect(g).connect(this.sfx);
      src.start(0, Math.random() * 3.5);
      return { src, f, g };
    };
    const wash = layer('lowpass', 1500, 0.4), patter = layer('bandpass', 4200, 0.8), hail = layer('bandpass', 2700, 2.2), wind = layer('bandpass', 380, 0.7);
    const t0 = ctx.currentTime;
    return {
      set: (rain, hl, wd) => {
        const t = ctx.currentTime;
        wash.g.gain.setTargetAtTime(Math.pow(rain, 1.2) * 0.55, t, 0.6);
        patter.g.gain.setTargetAtTime(rain * (0.18 + Math.random() * 0.06), t, 0.25);
        wash.f.frequency.setTargetAtTime(900 + rain * 1600, t, 0.8);
        hail.g.gain.setTargetAtTime(hl * (0.3 + Math.random() * 0.12), t, 0.15);
        wind.g.gain.setTargetAtTime(Math.max(0, wd - 0.35) * 0.2, t, 0.8);
        wind.f.frequency.setTargetAtTime(260 + 220 * (0.5 + 0.5 * Math.sin((t - t0) * 0.35)) + wd * 120, t, 1.2);
      },
      stop: () => { for (const l of [wash, patter, hail, wind]) { try { l.src.stop(); } catch { /* */ } l.src.disconnect(); } },
    };
  }

  async playMusic(name: string, fade = 1.5) {
    if (this.musicName === name) return;
    this.musicName = name;
    const buf = await this.load(`music/${name}`);
    if (!buf || this.musicName !== name) return;
    const t = this.ctx.currentTime;
    if (this.musicSrc) {
      const old = this.musicSrc;
      old.gain.gain.setTargetAtTime(0, t, fade / 3);
      setTimeout(() => { try { old.src.stop(); } catch { /* */ } }, fade * 1500);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const g = this.ctx.createGain(); g.gain.value = 0;
    g.gain.setTargetAtTime(1, t, fade / 3);
    src.connect(g).connect(this.music);
    src.start();
    this.musicSrc = { src, gain: g };
  }

  stopMusic() {
    this.musicName = '';
    if (this.musicSrc) { this.musicSrc.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4); const s = this.musicSrc.src; setTimeout(() => { try { s.stop(); } catch { /* */ } }, 1500); this.musicSrc = null; }
  }

  ui(name: 'cursor' | 'select' | 'confirm' | 'cancel' | 'error' | 'popup_open' | 'popup_close' | 'swipe') { this.play(`ui_${name}`, { volume: 0.6 }); }
}
