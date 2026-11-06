export type Quality = 'potato' | 'low' | 'medium' | 'high';
export type GlyphSet = 'auto' | 'keyboard' | 'xbox' | 'playstation' | 'lumos';

export interface SettingsData {
  quality: Quality;
  autoQuality: boolean;
  /** dynamic resolution: internal render scale floor/ceiling */
  drsMin: number;
  drsMax: number;
  targetFps: number;
  fov: number;
  mouseSens: number;
  padSens: number;
  adsSensMul: number;
  invertY: boolean;
  gyroAim: boolean;
  gyroSens: number;
  haptics: boolean;
  aimAssist: boolean;
  glyphs: GlyphSet;
  touchControls: 'auto' | 'on' | 'off';
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  showFps: boolean;
  thirdPerson: boolean;
  colorblind: boolean;
  playerName: string;
}

const DEFAULTS: SettingsData = {
  quality: 'medium',
  autoQuality: true,
  drsMin: 0.6,
  drsMax: 1,
  targetFps: 60,
  fov: 80,
  mouseSens: 1,
  padSens: 1,
  adsSensMul: 0.6,
  invertY: false,
  gyroAim: false,
  gyroSens: 1,
  haptics: true,
  aimAssist: true,
  glyphs: 'auto',
  touchControls: 'auto',
  masterVolume: 0.8,
  musicVolume: 0.45,
  sfxVolume: 0.9,
  showFps: true,
  thirdPerson: false,
  colorblind: false,
  playerName: '',
};

const KEY = 'lumos-strike-settings-v1';

class SettingsStore {
  data: SettingsData;
  private listeners = new Set<(d: SettingsData) => void>();
  constructor() {
    let saved: Partial<SettingsData> = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* private mode */ }
    this.data = { ...DEFAULTS, ...saved };
    if (!saved.quality) this.data.quality = SettingsStore.detectQuality();
  }
  /** crude hardware heuristic for the first launch */
  static detectQuality(): Quality {
    const mobile = /Android|iPhone|iPad|Mobile|SteamDeck/i.test(navigator.userAgent) || matchMedia('(pointer: coarse)').matches;
    const cores = navigator.hardwareConcurrency || 4;
    const mem = (navigator as any).deviceMemory || 4;
    if (mobile && (cores <= 4 || mem <= 3)) return 'potato';
    if (mobile || cores <= 4 || mem <= 4) return 'low';
    if (cores >= 12 && mem >= 8) return 'high';
    return 'medium';
  }
  set<K extends keyof SettingsData>(k: K, v: SettingsData[K]) {
    this.data[k] = v;
    this.save();
    this.listeners.forEach((l) => l(this.data));
  }
  patch(p: Partial<SettingsData>) { Object.assign(this.data, p); this.save(); this.listeners.forEach((l) => l(this.data)); }
  onChange(fn: (d: SettingsData) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  save() { try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* ignore */ } }
}

export const settings = new SettingsStore();

export const QUALITY_PRESETS: Record<Quality, { shadows: number; pixelRatio: number; far: number; treeDensity: number; grass: boolean; antialias: boolean; lowSpecMaterials: boolean; drawDistance: number }> = {
  potato: { shadows: 0, pixelRatio: 0.6, far: 650, treeDensity: 0.35, grass: false, antialias: false, lowSpecMaterials: true, drawDistance: 280 },
  low: { shadows: 0, pixelRatio: 0.8, far: 900, treeDensity: 0.55, grass: false, antialias: false, lowSpecMaterials: true, drawDistance: 420 },
  medium: { shadows: 1024, pixelRatio: 1, far: 1300, treeDensity: 0.8, grass: true, antialias: true, lowSpecMaterials: false, drawDistance: 650 },
  high: { shadows: 2048, pixelRatio: 1.5, far: 1800, treeDensity: 1, grass: true, antialias: true, lowSpecMaterials: false, drawDistance: 900 },
};
