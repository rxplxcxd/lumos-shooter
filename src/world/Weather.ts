import * as THREE from 'three';
import { Rng } from './Noise';
import { Precipitation } from '../fx/Precipitation';
import type { AudioSys } from '../audio/Audio';

export type WeatherKind = 'clear' | 'cloudy' | 'overcast' | 'fog' | 'drizzle' | 'rain' | 'storm' | 'hail';
export interface WeatherParams {
  /** cloud coverage 0..1 */ cover: number;
  /** storm-cloud darkness 0..1 */ dark: number;
  /** ground fog 0..1 */ fog: number;
  /** rain 0..1 */ rain: number;
  /** hail 0..1 */ hail: number;
  /** wind strength 0..2 */ wind: number;
  /** thunderstorm activity 0..1 */ storm: number;
}

export const WEATHER_PRESETS: Record<WeatherKind, WeatherParams> = {
  clear: { cover: 0.22, dark: 0, fog: 0.04, rain: 0, hail: 0, wind: 0.6, storm: 0 },
  cloudy: { cover: 0.55, dark: 0.12, fog: 0.07, rain: 0, hail: 0, wind: 0.9, storm: 0 },
  overcast: { cover: 0.86, dark: 0.32, fog: 0.14, rain: 0, hail: 0, wind: 1.0, storm: 0 },
  fog: { cover: 0.62, dark: 0.18, fog: 0.85, rain: 0, hail: 0, wind: 0.25, storm: 0 },
  drizzle: { cover: 0.9, dark: 0.4, fog: 0.26, rain: 0.32, hail: 0, wind: 0.9, storm: 0 },
  rain: { cover: 0.96, dark: 0.55, fog: 0.3, rain: 0.72, hail: 0, wind: 1.3, storm: 0.1 },
  storm: { cover: 1, dark: 0.88, fog: 0.34, rain: 1, hail: 0, wind: 1.9, storm: 1 },
  hail: { cover: 0.97, dark: 0.72, fog: 0.24, rain: 0.35, hail: 1, wind: 1.6, storm: 0.45 },
};
export const WEATHER_NAMES: Record<WeatherKind, string> = {
  clear: 'Sonnig', cloudy: 'Bewölkt', overcast: 'Bedeckt', fog: 'Nebel', drizzle: 'Nieselregen', rain: 'Regen', storm: 'Gewitter', hail: 'Hagel',
};
// plausible successors (a little meteorology: storms come out of rain, hail out of storms…)
const NEXT: Record<WeatherKind, WeatherKind[]> = {
  clear: ['clear', 'cloudy', 'cloudy', 'fog'],
  cloudy: ['clear', 'overcast', 'drizzle', 'cloudy'],
  overcast: ['cloudy', 'drizzle', 'rain', 'fog'],
  fog: ['cloudy', 'overcast', 'clear'],
  drizzle: ['overcast', 'rain', 'cloudy'],
  rain: ['drizzle', 'storm', 'overcast', 'rain'],
  storm: ['rain', 'hail', 'rain'],
  hail: ['storm', 'rain'],
};

/**
 * Dynamic weather: the forecast is a seeded sequence of states (every client of an online match
 * derives the same one from the match seed), parameters blend continuously towards the current
 * state so transitions are seamless. Drives clouds / light / fog (via SkySystem), GPU rain and
 * hail, wet streets, lens drops, wind, lightning + delayed thunder and the ambience audio.
 */
export class WeatherSystem {
  p: WeatherParams = { ...WEATHER_PRESETS.clear };
  kind: WeatherKind = 'clear';
  /** surface wetness 0..1 (builds up in rain, dries afterwards) */
  wet = 0;
  /** 0..1 lightning flash brightness this frame */
  flash = 0;
  /** wind vector in m/s (x, z) */
  windVec = new THREE.Vector2(2, 1);
  auto = true;
  private schedule: { kind: WeatherKind; until: number }[] = [];
  private rng: Rng;
  private rain: Precipitation;
  private hailFx: Precipitation;
  private boltT = 8;
  private flashSeq: number[] = [];
  private thunderQ: { t: number; near: boolean; pos: THREE.Vector3 }[] = [];
  private bed: { set: (rain: number, hail: number, wind: number) => void; stop: () => void } | null = null;
  private dripT = 0;
  private windAng = Math.random() * 6.28;
  /** last lightning bolt position (for scene lighting) */
  boltPos = new THREE.Vector3();

  constructor(private scene: THREE.Scene, private audio: AudioSys, seed: number, start: WeatherKind, maxDrops: number, private matchTime = 0) {
    this.rng = new Rng(seed * 13 + 7);
    this.kind = start;
    this.p = { ...WEATHER_PRESETS[start] };
    if (start === 'rain' || start === 'storm' || start === 'drizzle') this.wet = 0.8;
    // forecast: ~4-7 minutes per state for the whole match
    let t = matchTime + 160 + this.rng.next() * 200;
    let k = start;
    this.schedule.push({ kind: start, until: t });
    for (let i = 0; i < 24; i++) {
      k = this.rng.pick(NEXT[k]);
      t += 200 + this.rng.next() * 220;
      this.schedule.push({ kind: k, until: t });
    }
    this.rain = new Precipitation(scene, maxDrops, false);
    this.hailFx = new Precipitation(scene, Math.round(maxDrops * 0.35), true);
  }

  /** force a state (photo mode / debug / mode scripts); `instant` skips the blend */
  set(kind: WeatherKind, instant = false) {
    this.kind = kind;
    this.auto = false;
    if (instant) { this.p = { ...WEATHER_PRESETS[kind] }; if (WEATHER_PRESETS[kind].rain > 0.3) this.wet = Math.max(this.wet, 0.85); }
  }

  /** compatibility name for systems that only know the old four states */
  get legacy(): 'clear' | 'overcast' | 'fog' | 'rain' {
    if (this.p.rain > 0.15 || this.p.hail > 0.2) return 'rain';
    if (this.p.fog > 0.5) return 'fog';
    if (this.p.cover > 0.7) return 'overcast';
    return 'clear';
  }

  update(dt: number, time: number, cam: THREE.Vector3, brightness: number, onBolt: (pos: THREE.Vector3, k: number) => void) {
    if (this.auto) {
      while (this.schedule.length > 1 && time > this.schedule[0].until) this.schedule.shift();
      this.kind = this.schedule[0].kind;
    }
    // seamless blend (time constant ~40 s; rain starts a bit faster than clouds clear)
    const tgt = WEATHER_PRESETS[this.kind];
    const k = 1 - Math.exp(-dt / 40);
    const kr = 1 - Math.exp(-dt / 22);
    const P = this.p as unknown as Record<string, number>, T = tgt as unknown as Record<string, number>;
    for (const key of Object.keys(P)) P[key] += (T[key] - P[key]) * (key === 'rain' || key === 'hail' ? kr : k);
    // wetness: soaks within ~half a minute of real rain, dries in a few minutes
    this.wet = THREE.MathUtils.clamp(this.wet + (this.p.rain > 0.08 ? this.p.rain * dt / 25 : -dt / 160), 0, 1);
    // gusty wind that slowly changes direction
    this.windAng += (Math.sin(time * 0.013) * 0.002 + 0.0004) * dt * 60;
    const gust = 1 + Math.sin(time * 0.9) * 0.18 + Math.sin(time * 2.3 + 1) * 0.1;
    const ws = (1.2 + this.p.wind * 5.5) * gust;
    this.windVec.set(Math.cos(this.windAng) * ws, Math.sin(this.windAng) * ws);
    // precipitation
    this.rain.update(dt, cam, this.p.rain, this.windVec, brightness);
    this.hailFx.update(dt, cam, this.p.hail, this.windVec, brightness);
    // lightning: flicker sequence (main flash + re-strikes), thunder after the light (343 m/s)
    this.flash = 0;
    if (this.p.storm > 0.2) {
      this.boltT -= dt * this.p.storm;
      if (this.boltT <= 0) {
        this.boltT = 4 + this.rng.next() * 14;
        const dist = 250 + this.rng.next() * 2200;
        const a = this.rng.next() * Math.PI * 2;
        this.boltPos.set(cam.x + Math.cos(a) * dist, cam.y + 300, cam.z + Math.sin(a) * dist);
        const strength = THREE.MathUtils.clamp(1.4 - dist / 2000, 0.25, 1);
        this.flashSeq = [strength, strength * 0.35, strength * 0.9, 0, strength * 0.5].map((v, i) => v * (i === 3 ? 0 : 1));
        this.flashTimer = 0;
        this.thunderQ.push({ t: time + dist / 343, near: dist < 700, pos: this.boltPos.clone() });
        onBolt(this.boltPos, strength);
      }
    }
    if (this.flashSeq.length) {
      this.flashTimer += dt;
      const idx = Math.floor(this.flashTimer / 0.06);
      if (idx >= this.flashSeq.length) this.flashSeq = [];
      else this.flash = this.flashSeq[idx];
    }
    for (let i = this.thunderQ.length - 1; i >= 0; i--) {
      const q = this.thunderQ[i];
      if (time < q.t) continue;
      this.thunderQ.splice(i, 1);
      this.audio.play(q.near ? 'thunder_close' : 'thunder_far', { volume: q.near ? 1 : 0.8, rate: 0.85 + Math.random() * 0.25 });
    }
    // ambience bed (procedural noise layers) + sampled drips / ice clicks near the listener
    if (!this.bed) this.bed = this.audio.weatherBed();
    this.bed?.set(this.p.rain, this.p.hail, this.p.wind);
    this.dripT -= dt;
    if (this.dripT <= 0 && (this.p.rain > 0.15 || this.p.hail > 0.2)) {
      this.dripT = 0.08 + Math.random() * (0.6 - Math.max(this.p.rain, this.p.hail) * 0.45);
      const off = new THREE.Vector3(cam.x + (Math.random() - 0.5) * 14, cam.y - 1, cam.z + (Math.random() - 0.5) * 14);
      if (this.p.hail > 0.2 && Math.random() < this.p.hail) this.audio.play('ice_crack', { pos: off, volume: 0.18 + Math.random() * 0.2, rate: 1.4 + Math.random() * 0.8, maxDist: 25 });
      else this.audio.play(Math.random() < 0.6 ? 'rain_drip' : 'splash', { pos: off, volume: 0.12 + this.p.rain * 0.2, rate: 0.8 + Math.random() * 0.5, maxDist: 25 });
    }
  }
  private flashTimer = 0;

  /** seconds until the next forecast change and what comes next (HUD) */
  forecast(time: number) {
    const cur = this.schedule[0], nxt = this.schedule[1];
    return { now: this.kind, next: nxt?.kind ?? cur.kind, inS: Math.max(0, (cur?.until ?? time) - time) };
  }

  dispose() { this.rain.dispose(); this.hailFx.dispose(); this.bed?.stop(); this.bed = null; }
}
