// Asset manifest: every model used by the game, with the normalisation needed
// to bring third-party assets (Sketchfab / itch.io) into game space.
// Convention after normalisation: +Z = forward, Y-up, bottom at y = 0, metres.

export interface ModelDef {
  /** path below /assets without extension */
  file: string;
  /** yaw (degrees) applied so the model faces +Z */
  yaw?: number;
  /** target size in metres along the forward axis (after yaw) */
  length?: number;
  /** target height in metres (used when length is not given) */
  height?: number;
  /** target width (X) in metres */
  width?: number;
  /** measure length using only this node (e.g. fuselage instead of rotor) */
  lengthNode?: string;
  /** node names (three.js-sanitised) to remove */
  hide?: string[];
  /** don't recentre on XZ */
  keepOrigin?: boolean;
  castShadow?: boolean;
}

export const MODELS: Record<string, ModelDef> = {
  // ---------------------------------------------------------------- vehicles
  car_sedan: { file: 'vehicles/NormalCar1', length: 4.5 },
  car_hatch: { file: 'vehicles/NormalCar2', length: 4.1 },
  car_suv: { file: 'vehicles/SUV', length: 4.8 },
  car_sport: { file: 'vehicles/SportsCar', length: 4.5 },
  car_sport2: { file: 'vehicles/SportsCar2', length: 4.5 },
  car_taxi: { file: 'vehicles/Taxi', length: 4.6 },
  car_cop: { file: 'vehicles/Cop', length: 4.8 },
  car_police: { file: 'vehicles/police', yaw: -90, length: 4.9 },
  car_classic: { file: 'vehicles/sedan', length: 5.6 },
  car_muscle: { file: 'vehicles/muscle', length: 4.8 },
  car_roadster: { file: 'vehicles/sportscar', length: 4.4 },
  jeep: { file: 'vehicles/jeep', yaw: -90, length: 3.7, hide: ['ground__0'] },
  truck: { file: 'vehicles/truck', length: 11 },
  bus: { file: 'vehicles/bus', length: 10 },
  tractor: { file: 'vehicles/tractor', length: 3.8 },
  golfcart: { file: 'vehicles/golfcart', length: 2.6 },
  tank: { file: 'vehicles/tank', length: 7 },
  apc: { file: 'vehicles/apc', length: 7.5 },
  motorcycle: { file: 'vehicles/motorcycle', yaw: -90, length: 2.3 },
  bicycle: { file: 'vehicles/bicycle', yaw: -90, length: 1.8 },
  hovercar: { file: 'vehicles/hovercar', yaw: -90, length: 4.5 },
  jetski: { file: 'vehicles/jetski', yaw: 180, length: 3.0 },
  speedboat: { file: 'vehicles/speedboat', yaw: 90, length: 7 },
  boat: { file: 'vehicles/boats', length: 4.8, hide: ['Cube001_cv_boat_0', 'Cube002_cv_boat_0'] },
  submarine: { file: 'vehicles/submarine', yaw: 180, length: 14 },
  heli_huey: { file: 'vehicles/heli_huey', length: 13 },
  heli_apache: { file: 'vehicles/heli_apache', length: 15 },
  heli_small: { file: 'vehicles/heli_small', yaw: 90, length: 9, lengthNode: 'Copter_Palette_0' },
  plane_prop: { file: 'vehicles/plane_prop', length: 8 },
  jet_f16: { file: 'vehicles/jet_f16', yaw: -90, length: 15 },
  plane_cargo: { file: 'vehicles/plane_cargo', yaw: 180, length: 30 },

  // ---------------------------------------------------------------- weapons (muzzle -> +Z)
  w_pistol: { file: 'weapons/pistol', length: 0.22 },
  w_ar: { file: 'weapons/ar', length: 0.9 },
  w_bullpup: { file: 'weapons/bullpup', length: 0.75 },
  w_smg: { file: 'weapons/smg', length: 0.62, hide: ['base_2_smg_0', 'sling_smg_0', 'release_smg_0', 'mag_2_smg_0', 'bullet_2_smg_0', 'trigger_smg_0', 'bolt_2_smg_0'] },
  w_shotgun: { file: 'weapons/shotgun', length: 1.0 },
  w_sniper: { file: 'weapons/sniper', length: 1.2 },
  w_rpg: { file: 'weapons/rpg', length: 1.1 },
  w_grenade: { file: 'weapons/grenade', height: 0.11 },
  w_knife: { file: 'weapons/knife', length: 0.3 },

  // ---------------------------------------------------------------- characters
  char_mannequin: { file: 'characters/mannequin', height: 1.8, keepOrigin: true },
  char_mannequin_lod: { file: 'characters/mannequin_lod1', height: 1.8, keepOrigin: true },
  char_mannequin_f: { file: 'characters/mannequin_f', height: 1.75, keepOrigin: true },
  char_hero_m: { file: 'characters/hero_m', height: 1.82, keepOrigin: true },
  char_hero_f: { file: 'characters/hero_f', height: 1.76, keepOrigin: true },
  zombie_hazmat: { file: 'zombies/hazmat', height: 1.8, keepOrigin: true },

  // ---------------------------------------------------------------- items
  item_medkit: { file: 'items/medkit', length: 0.5 },
  item_syringe: { file: 'items/syringe', height: 0.25 },
  item_vest: { file: 'items/vest', height: 0.55 },
  item_ammo: { file: 'items/ammo', width: 0.7 },
  item_crate: { file: 'items/crate', width: 1.1 },
  item_supply: { file: 'items/supply', width: 1.2 },
  item_parachute: { file: 'items/parachute', height: 4.2 },

  // ---------------------------------------------------------------- soldier gear & wildlife
  gear_helmet: { file: 'gear/helmet', width: 0.29 },
  gear_backpack: { file: 'gear/backpack', yaw: 180, height: 0.5 },
  gear_vest: { file: 'items/vest', height: 0.52 },
  birds_seagulls: { file: 'gear/seagull', length: 16 },
  bird_raven: { file: 'gear/raven', length: 0.6 },

  // ---------------------------------------------------------------- environment
  env_building_shop: { file: 'env/building1', height: 11 },
  env_skyscraper: { file: 'env/building_large', height: 48 },
  env_apartment: { file: 'env/gamecity', height: 30 },
  env_house: { file: 'env/house', width: 10 },
  env_factory: { file: 'env/factory', length: 34 },
  env_warehouse: { file: 'env/warehouse_ind', length: 30 },
  env_warehouses: { file: 'env/warehouses', width: 48 },
  env_bunker: { file: 'env/bunker', length: 14 },
  env_barrier: { file: 'env/barrier', length: 3 },
  env_boxes: { file: 'env/boxes', width: 1.6 },
  env_door: { file: 'env/door', height: 2.3 },
  env_vending: { file: 'env/vending', height: 2.1 },
  env_vending2: { file: 'env/vending2', height: 2.1 },
  env_mysterybox: { file: 'env/mysterybox', width: 1.5 },
  env_rocks: { file: 'env/rocks', width: 4 },
  env_sandbag: { file: 'env/sandbags', length: 0.9 },
};

/** Kits: one GLB with many named top-level pieces (CC0 Quaternius packs). */
export const KITS = {
  city: 'kits/city',
  city_lod: 'kits/city_lod',
  nature: 'kits/nature',
  nature_lod: 'kits/nature_lod',
  nature_lod2: 'kits/nature_lod2',
  guns: 'kits/guns',
  street: 'kits/streetprops',
  cityprops: 'kits/cityprops',
  euro_a: 'kits/euro_a',
  euro_b: 'kits/euro_b',
  attachments: 'kits/attachments',
} as const;
export type KitId = keyof typeof KITS;

export const CHARACTER_ANIMS = 'characters/anims';

export const AUDIO = {
  sfx: [
    'ar_shot_1', 'ar_shot_2', 'ar_shot_3', 'br_shot_1', 'mg_shot_1', 'mg_shot_2', 'pistol_shot_1', 'pistol_shot_2', 'revolver_shot_1',
    'shotgun_shot_1', 'shotgun_shot_2', 'shotgun_pump', 'sniper_shot_1', 'sniper_shot_2', 'sniper_bolt', 'smg_burst', 'suppressed_1', 'suppressed_2',
    'reload_ar', 'reload_pistol', 'mag_out', 'mag_in', 'bolt_pull', 'shell_drop', 'knife', 'grenade_pin', 'grenade_bounce', 'grenade_explode',
    'smoke_hiss', 'flashbang', 'explosion_large', 'explosion_medium', 'explosion_small', 'explosion_far', 'rocket_whoosh', 'bomb_whistle',
    'glass_break', 'wood_break', 'crate_smash', 'metal_crash', 'debris', 'zombie_groan_1', 'zombie_groan_2', 'zombie_snarl', 'zombie_attack',
    'zombie_swipe', 'zombie_death', 'zombie_fall', 'bone_crack', 'splat', 'splat_heavy', 'engine_idle', 'engine_low', 'engine_mid', 'engine_high',
    'engine_start', 'horn', 'skid', 'brake', 'crash', 'gear_shift', 'turbo', 'car_door', 'coin', 'cash', 'land_heavy', 'wind_loop',
    'ui_cursor', 'ui_select', 'ui_confirm', 'ui_cancel', 'ui_error', 'ui_popup_open', 'ui_popup_close', 'ui_swipe',
  ],
  steps: ['grass', 'dirt', 'stone', 'wood', 'metal', 'sand', 'water', 'gravel', 'snow'],
  music: ['menu', 'lobby', 'drop', 'zombies', 'tension', 'victory'],
};
