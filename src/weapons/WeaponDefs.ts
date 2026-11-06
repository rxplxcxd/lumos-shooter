export type WeaponClass = 'ar' | 'smg' | 'shotgun' | 'sniper' | 'marksman' | 'lmg' | 'pistol' | 'launcher' | 'melee';
export type AmmoType = 'light' | 'heavy' | 'shells' | 'sniper' | 'rockets' | 'none';
export type Rarity = 0 | 1 | 2 | 3 | 4 | 5; // common .. mythic (pack-a-punch)

export const RARITY = [
  { name: 'Common', color: '#b8c0cc', dmg: 1.0, mag: 1.0 },
  { name: 'Uncommon', color: '#5fd068', dmg: 1.05, mag: 1.0 },
  { name: 'Rare', color: '#4aa8ff', dmg: 1.1, mag: 1.1 },
  { name: 'Epic', color: '#b46cff', dmg: 1.16, mag: 1.2 },
  { name: 'Legendary', color: '#ffb52e', dmg: 1.22, mag: 1.3 },
  { name: 'Mythic', color: '#ff3df2', dmg: 1.8, mag: 1.6 }, // Pack-a-Punched
];

export interface WeaponDef {
  id: string;
  name: string;
  cls: WeaponClass;
  /** manifest model id, or `kit:<PieceName>` from the Quaternius gun kit */
  model: string;
  /** model length in metres (kit guns are normalised to this) */
  length: number;
  damage: number;
  headMul: number;
  rpm: number;
  mag: number;
  reload: number; // seconds
  auto: boolean;
  burst?: number;
  pellets?: number;
  hipSpread: number; // degrees
  adsSpread: number;
  recoilV: number; // degrees per shot
  recoilH: number;
  adsTime: number; // seconds
  adsFov: number; // degrees
  scope?: boolean; // full-screen scope overlay
  velocity: number; // m/s (0 = hitscan)
  gravity: number; // multiplier on 9.81
  range: number; // damage falloff start (m)
  minDamageMul: number;
  ammo: AmmoType;
  sound: string;
  moveMul: number;
  penetration: number; // 0 none, 1 wood/thin metal, 2 concrete-ish
  explosive?: { radius: number; damage: number };
  cost: number; // zombies wall-buy / buy station price
}

const D = (d: Partial<WeaponDef> & Pick<WeaponDef, 'id' | 'name' | 'cls' | 'model'>): WeaponDef => ({
  length: 0.9, damage: 25, headMul: 1.6, rpm: 600, mag: 30, reload: 2.2, auto: true, hipSpread: 3.5, adsSpread: 0.6, recoilV: 0.55, recoilH: 0.25,
  adsTime: 0.22, adsFov: 55, velocity: 720, gravity: 1, range: 60, minDamageMul: 0.65, ammo: 'light', sound: 'ar_shot', moveMul: 0.95, penetration: 1, cost: 1200, ...d,
});

export const WEAPONS: Record<string, WeaponDef> = Object.fromEntries([
  // --- assault rifles
  D({ id: 'kestrel', name: 'Kestrel AR', cls: 'ar', model: 'w_ar', length: 0.9, damage: 27, rpm: 640, mag: 30, recoilV: 0.6, sound: 'ar_shot', ammo: 'heavy', penetration: 2 }),
  D({ id: 'vanguard', name: 'Vanguard BP', cls: 'ar', model: 'w_bullpup', length: 0.75, damage: 24, rpm: 760, mag: 32, recoilV: 0.5, adsTime: 0.2, sound: 'ar_shot' }),
  D({ id: 'raptor', name: 'Raptor 47', cls: 'ar', model: 'kit:AssaultRifle_1', length: 0.88, damage: 30, rpm: 590, mag: 30, recoilV: 0.75, recoilH: 0.35, sound: 'br_shot', ammo: 'heavy', penetration: 2 }),
  D({ id: 'ranger', name: 'Ranger M4', cls: 'ar', model: 'kit:AssaultRifle2_1', length: 0.86, damage: 25, rpm: 700, mag: 30, recoilV: 0.45, sound: 'ar_shot' }),
  // --- SMG
  D({ id: 'wasp', name: 'Wasp SMG', cls: 'smg', model: 'w_smg', length: 0.62, damage: 21, rpm: 860, mag: 32, hipSpread: 2.4, recoilV: 0.38, adsTime: 0.15, range: 25, minDamageMul: 0.55, velocity: 520, sound: 'smg_burst', moveMul: 1.03, cost: 1000 }),
  D({ id: 'hornet', name: 'Hornet PDW', cls: 'smg', model: 'kit:SubmachineGun_2', length: 0.55, damage: 19, rpm: 950, mag: 40, hipSpread: 2.2, recoilV: 0.32, adsTime: 0.14, range: 22, minDamageMul: 0.5, velocity: 500, sound: 'pistol_shot', moveMul: 1.04, cost: 1000 }),
  D({ id: 'stinger', name: 'Stinger', cls: 'smg', model: 'kit:SubmachineGun_4', length: 0.5, damage: 23, rpm: 780, mag: 30, hipSpread: 2.6, recoilV: 0.42, adsTime: 0.15, range: 24, minDamageMul: 0.55, velocity: 500, sound: 'smg_burst', moveMul: 1.03, cost: 1000 }),
  // --- shotguns
  D({ id: 'brawler', name: 'Brawler 12', cls: 'shotgun', model: 'w_shotgun', length: 1.0, damage: 14, pellets: 9, rpm: 75, mag: 6, reload: 3.4, auto: false, hipSpread: 6, adsSpread: 4.2, recoilV: 4.5, recoilH: 1.2, range: 9, minDamageMul: 0.2, velocity: 380, ammo: 'shells', sound: 'shotgun_shot', penetration: 0, cost: 1500 }),
  D({ id: 'sawedoff', name: 'Sawed-Off', cls: 'shotgun', model: 'kit:Shotgun_SawedOff', length: 0.62, damage: 15, pellets: 10, rpm: 180, mag: 2, reload: 2.2, auto: false, hipSpread: 8, adsSpread: 6, recoilV: 5, recoilH: 2, range: 6, minDamageMul: 0.15, velocity: 350, ammo: 'shells', sound: 'shotgun_shot', moveMul: 1.02, penetration: 0, cost: 900 }),
  // --- marksman / sniper
  D({ id: 'longbow', name: 'Longbow .338', cls: 'sniper', model: 'w_sniper', length: 1.2, damage: 105, headMul: 2.5, rpm: 45, mag: 5, reload: 3.2, auto: false, hipSpread: 9, adsSpread: 0.02, recoilV: 4, recoilH: 0.6, adsTime: 0.38, adsFov: 14, scope: true, velocity: 950, gravity: 1, range: 500, minDamageMul: 0.9, ammo: 'sniper', sound: 'sniper_shot', moveMul: 0.88, penetration: 2, cost: 2500 }),
  D({ id: 'tempest', name: 'Tempest SR', cls: 'sniper', model: 'kit:SniperRifle_1', length: 1.25, damage: 92, headMul: 2.4, rpm: 55, mag: 6, reload: 3.0, auto: false, hipSpread: 8, adsSpread: 0.03, recoilV: 3.6, adsTime: 0.36, adsFov: 18, scope: true, velocity: 900, range: 400, minDamageMul: 0.85, ammo: 'sniper', sound: 'sniper_shot', moveMul: 0.9, penetration: 2, cost: 2200 }),
  D({ id: 'dmr', name: 'Sentinel DMR', cls: 'marksman', model: 'kit:AssaultRifle_4', length: 1.05, damage: 46, headMul: 2, rpm: 260, mag: 15, auto: false, hipSpread: 4, adsSpread: 0.15, recoilV: 1.4, adsTime: 0.27, adsFov: 30, velocity: 850, range: 150, minDamageMul: 0.8, ammo: 'heavy', sound: 'br_shot', moveMul: 0.92, penetration: 2, cost: 1800 }),
  // --- LMG
  D({ id: 'warden', name: 'Warden LMG', cls: 'lmg', model: 'kit:AssaultRifle_5', length: 1.1, damage: 26, rpm: 680, mag: 75, reload: 4.6, recoilV: 0.5, adsTime: 0.34, velocity: 760, range: 70, ammo: 'heavy', sound: 'mg_shot', moveMul: 0.86, penetration: 2, cost: 2000 }),
  // --- pistols
  D({ id: 'viper', name: 'Viper 1911', cls: 'pistol', model: 'w_pistol', length: 0.22, damage: 32, rpm: 380, mag: 8, reload: 1.5, auto: false, hipSpread: 2, adsSpread: 0.5, recoilV: 1.6, adsTime: 0.12, adsFov: 65, velocity: 400, range: 20, minDamageMul: 0.6, ammo: 'light', sound: 'pistol_shot', moveMul: 1.06, cost: 500 }),
  D({ id: 'magnum', name: 'Magnum .44', cls: 'pistol', model: 'kit:Revolver_1', length: 0.3, damage: 58, headMul: 1.8, rpm: 150, mag: 6, reload: 2.6, auto: false, hipSpread: 2.6, adsSpread: 0.4, recoilV: 4, recoilH: 0.8, adsTime: 0.14, adsFov: 62, velocity: 450, range: 30, minDamageMul: 0.6, ammo: 'heavy', sound: 'revolver_shot', moveMul: 1.05, cost: 750 }),
  // --- launcher
  D({ id: 'thumper', name: 'Thumper RPG', cls: 'launcher', model: 'w_rpg', length: 1.1, damage: 140, headMul: 1, rpm: 40, mag: 1, reload: 3.8, auto: false, hipSpread: 2, adsSpread: 0.4, recoilV: 5, adsTime: 0.4, adsFov: 50, velocity: 90, gravity: 0.25, range: 300, minDamageMul: 1, ammo: 'rockets', sound: 'rocket_whoosh', moveMul: 0.85, penetration: 0, explosive: { radius: 7, damage: 150 }, cost: 3000 }),
  // --- melee
  D({ id: 'knife', name: 'Combat Knife', cls: 'melee', model: 'w_knife', length: 0.3, damage: 60, headMul: 1, rpm: 100, mag: 0, reload: 0, auto: false, hipSpread: 0, adsSpread: 0, recoilV: 0, recoilH: 0, velocity: 0, gravity: 0, range: 2.2, minDamageMul: 1, ammo: 'none', sound: 'knife', moveMul: 1.1, penetration: 0, cost: 0 }),
].map((w) => [w.id, w]));

export const LOOT_WEAPONS = Object.values(WEAPONS).filter((w) => w.cls !== 'melee');

// ---------------------------------------------------------------- attachments (Gunsmith)
export type Slot = 'optic' | 'muzzle' | 'underbarrel' | 'magazine' | 'stock' | 'laser';
export interface AttachmentDef {
  id: string; name: string; slot: Slot; piece?: string; desc: string;
  mods: Partial<{ adsFov: number; adsTime: number; recoilV: number; recoilH: number; hipSpread: number; mag: number; reload: number; velocity: number; range: number; moveMul: number; silenced: boolean; thermal: boolean; scope: boolean }>;
}
export const ATTACHMENTS: AttachmentDef[] = [
  { id: 'reddot', name: 'Reflex Sight', slot: 'optic', piece: 'Scope_3', desc: 'Klares Visier, schnelleres ADS', mods: { adsTime: 0.9, adsFov: 1.0 } },
  { id: 'acog', name: '3.5x Combat Scope', slot: 'optic', piece: 'Scope_2', desc: 'Mittlere Distanz, 3.5x Zoom', mods: { adsFov: 0.55, adsTime: 1.15 } },
  { id: 'sniperscope', name: '8x Recon Scope', slot: 'optic', piece: 'Scope_1', desc: 'Weite Distanz, volles Zielfernrohr', mods: { adsFov: 0.28, adsTime: 1.3, scope: true } },
  { id: 'thermal', name: 'Thermal Optic', slot: 'optic', piece: 'Scope_2', desc: 'Wärmebild beim Zielen', mods: { adsFov: 0.6, adsTime: 1.2, thermal: true } },
  { id: 'suppressor', name: 'Monolith Suppressor', slot: 'muzzle', piece: 'Silencer_long', desc: 'Leise, kein Radar-Ping, -5% Velocity', mods: { silenced: true, velocity: 0.95, range: 1.1 } },
  { id: 'compensator', name: 'Compensator', slot: 'muzzle', piece: 'Silencer_Short', desc: '-18% vertikaler Rückstoß', mods: { recoilV: 0.82 } },
  { id: 'vgrip', name: 'Vertical Grip', slot: 'underbarrel', piece: 'Grip', desc: '-22% Rückstoß, langsameres ADS', mods: { recoilV: 0.78, recoilH: 0.7, adsTime: 1.08 } },
  { id: 'bipod', name: 'Bipod', slot: 'underbarrel', piece: 'Bipod', desc: 'Stabil in der Hocke', mods: { recoilV: 0.85, hipSpread: 0.9 } },
  { id: 'flashlight', name: 'Tactical Light', slot: 'laser', piece: 'Flashlight', desc: 'Licht für Nachtkarten, -15% Hip-Spread', mods: { hipSpread: 0.85 } },
  { id: 'extmag', name: 'Extended Mag', slot: 'magazine', desc: '+50% Magazin, langsamer nachladen', mods: { mag: 1.5, reload: 1.15 } },
  { id: 'fastmag', name: 'Fast Mag', slot: 'magazine', desc: '-30% Nachladezeit', mods: { reload: 0.7 } },
  { id: 'stock', name: 'Tactical Stock', slot: 'stock', piece: 'Stock', desc: '+8% Bewegung beim Zielen', mods: { moveMul: 1.08, recoilH: 0.9 } },
];
export const attachmentById = (id: string) => ATTACHMENTS.find((a) => a.id === id);
