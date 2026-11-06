export interface LoadoutWeapon { id: string; attachments: string[] }
export interface Loadout { name: string; primary: LoadoutWeapon; secondary: LoadoutWeapon; lethal: 'frag' | 'smoke' | 'flash'; perks: string[] }

export interface Profile {
  id: string;
  name: string;
  level: number;
  xp: number;
  coins: number;
  battlePassTier: number;
  battlePassXp: number;
  premiumPass: boolean;
  unlocked: string[];
  stash: { id: string; rarity: number; attachments: string[] }[];
  loadouts: Loadout[];
  selectedLoadout: number;
  operator: string;
  operatorTint: number;
  emote: string;
  stats: { kills: number; deaths: number; wins: number; matches: number; zombiesBestRound: number; eggs: number; extractions: number };
  chests: number;
  friends: { id: string; name: string; online: boolean; source: 'lumos' | 'supabase' | 'local' }[];
  updatedAt: number;
}

export const XP_PER_LEVEL = (lvl: number) => 1000 + lvl * 250;
export const BP_XP_PER_TIER = 1500;
export const BP_TIERS = 50;

export function defaultProfile(id = 'local', name = 'Operator'): Profile {
  return {
    id, name, level: 1, xp: 0, coins: 500, battlePassTier: 0, battlePassXp: 0, premiumPass: false,
    unlocked: ['char_mannequin', 'char_mannequin_f', 'kestrel', 'vanguard', 'wasp', 'viper', 'brawler', 'longbow', 'reddot', 'acog', 'vgrip', 'suppressor', 'extmag'],
    stash: [],
    loadouts: [
      { name: 'Assault', primary: { id: 'kestrel', attachments: ['reddot', 'vgrip'] }, secondary: { id: 'viper', attachments: [] }, lethal: 'frag', perks: ['staminup'] },
      { name: 'CQB', primary: { id: 'wasp', attachments: ['suppressor', 'extmag'] }, secondary: { id: 'brawler', attachments: [] }, lethal: 'flash', perks: ['speedcola'] },
      { name: 'Recon', primary: { id: 'longbow', attachments: ['sniperscope'] }, secondary: { id: 'viper', attachments: ['suppressor'] }, lethal: 'smoke', perks: ['quickrevive'] },
    ],
    selectedLoadout: 0,
    operator: 'char_mannequin',
    operatorTint: 0x3a6ea5,
    emote: 'dance',
    stats: { kills: 0, deaths: 0, wins: 0, matches: 0, zombiesBestRound: 0, eggs: 0, extractions: 0 },
    chests: 1,
    friends: [],
    updatedAt: Date.now(),
  };
}

/** applies match results: XP, level-ups, battle pass progress, coins, chests */
export function applyMatchResult(p: Profile, r: { xp: number; coins: number; kills: number; win: boolean; mode: string; round?: number; egg?: boolean; extracted?: { id: string; rarity: number; attachments: string[] }[] }) {
  p.xp += r.xp;
  const levels: number[] = [];
  while (p.xp >= XP_PER_LEVEL(p.level)) { p.xp -= XP_PER_LEVEL(p.level); p.level++; levels.push(p.level); if (p.level % 5 === 0) p.chests++; }
  p.battlePassXp += r.xp;
  while (p.battlePassXp >= BP_XP_PER_TIER && p.battlePassTier < BP_TIERS) { p.battlePassXp -= BP_XP_PER_TIER; p.battlePassTier++; if (p.battlePassTier % 3 === 0) p.chests++; }
  p.coins += r.coins;
  p.stats.kills += r.kills;
  p.stats.matches++;
  if (r.win) p.stats.wins++;
  if (r.round) p.stats.zombiesBestRound = Math.max(p.stats.zombiesBestRound, r.round);
  if (r.egg) p.stats.eggs++;
  if (r.extracted?.length) { p.stash.push(...r.extracted); p.stats.extractions++; }
  p.updatedAt = Date.now();
  return levels;
}
