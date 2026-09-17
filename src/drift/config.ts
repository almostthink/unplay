export const GAME_VERSION = '1.0.0';

export const SAVE_VERSION = 1;
export const SAVE_KEY = 'driftLegend.save.v1';

/** Leaderboard technical name, as created in the Yandex developer console. */
export const LEADERBOARD_NAME = 'drift';

export const PRODUCTS = {
  coinsSmall: 'coins_small',
  coinsMedium: 'coins_medium',
  coinsLarge: 'coins_large',
  starter: 'starter_pack',
  noAds: 'no_ads',
} as const;

export const PRODUCT_COINS: Record<string, number> = {
  [PRODUCTS.coinsSmall]: 5_000,
  [PRODUCTS.coinsMedium]: 30_000,
  [PRODUCTS.coinsLarge]: 120_000,
  [PRODUCTS.starter]: 15_000,
};

// ------------------------------------------------------------------- race

/** Seconds on the clock at the start of a run. */
export const START_TIME = 32;
/** Seconds added by each checkpoint. */
export const CHECKPOINT_TIME = 9;
/** Seconds lost when the car hits an obstacle. */
export const CRASH_PENALTY = 3;
/** Seconds granted by a rewarded-video revive. */
export const REVIVE_TIME = 15;
/** How many revives a single run may use. */
export const MAX_REVIVES = 2;

/** Distance in metres between checkpoints. */
export const CHECKPOINT_SPACING = 420;

// ---------------------------------------------------------------- scoring

/** Score per metre travelled. */
export const SCORE_PER_METRE = 1;
/** Drift score per second at multiplier 1. */
export const DRIFT_SCORE_RATE = 60;
/** Drift multiplier gained per second of continuous sliding. */
export const DRIFT_MULT_RATE = 0.55;
export const DRIFT_MULT_MAX = 8;
/** Sideways angle, in radians, above which the car counts as drifting. */
export const DRIFT_ANGLE_MIN = 0.22;
/** Below this speed a slide does not count as a drift. */
export const DRIFT_SPEED_MIN = 14;
/** Coins earned per 1000 score points. */
export const COINS_PER_SCORE = 0.035;

// ------------------------------------------------------------------- cars

export interface CarDef {
  id: string;
  name: readonly [string, string, string];
  /** Unlock price in coins; 0 means available from the start. */
  price: number;
  /** Top speed in metres per second before upgrades. */
  topSpeed: number;
  /** Forward acceleration in m/s². */
  accel: number;
  /** Lateral grip; higher sticks more, lower slides more readily. */
  grip: number;
  /** Steering response in radians per second at full lock. */
  steer: number;
  /** Body colour, overridden by the paint the player picks. */
  color: number;
  /** Rough body proportions in metres: length, width, height. */
  size: readonly [number, number, number];
}

export const CARS: readonly CarDef[] = [
  {
    id: 'hatch',
    name: ['Стартер', 'Starter', 'Başlangıç'],
    price: 0,
    topSpeed: 42,
    accel: 15,
    grip: 5.4,
    steer: 2.1,
    color: 0xe8483f,
    size: [3.9, 1.72, 1.32],
  },
  {
    id: 'coupe',
    name: ['Купе', 'Coupe', 'Kupe'],
    price: 12_000,
    topSpeed: 50,
    accel: 18,
    grip: 4.8,
    steer: 2.3,
    color: 0x2f7dff,
    size: [4.3, 1.8, 1.24],
  },
  {
    id: 'muscle',
    name: ['Маслкар', 'Muscle', 'Kas araba'],
    price: 45_000,
    topSpeed: 56,
    accel: 21,
    grip: 4.2,
    steer: 2.0,
    color: 0xffb02e,
    size: [4.7, 1.9, 1.28],
  },
  {
    id: 'proto',
    name: ['Прототип', 'Prototype', 'Prototip'],
    price: 160_000,
    topSpeed: 64,
    accel: 26,
    grip: 4.6,
    steer: 2.5,
    color: 0x27e0c4,
    size: [4.5, 1.94, 1.1],
  },
];

export const PAINTS: readonly number[] = [
  0xe8483f, 0x2f7dff, 0xffb02e, 0x27e0c4, 0xb44dff, 0x2ecc71, 0xf5f5f5, 0x2b2f3a,
];

/** Paints beyond the first three cost coins. */
export const PAINT_PRICE = 3_000;

// --------------------------------------------------------------- upgrades

export type UpgradeId = 'engine' | 'turbo' | 'tires' | 'nitro';

export const UPGRADE_MAX = 6;

export interface UpgradeDef {
  id: UpgradeId;
  icon: string;
  baseCost: number;
}

export const UPGRADES: readonly UpgradeDef[] = [
  { id: 'engine', icon: '🔧', baseCost: 1_200 },
  { id: 'turbo', icon: '🌀', baseCost: 1_000 },
  { id: 'tires', icon: '🛞', baseCost: 900 },
  { id: 'nitro', icon: '🔥', baseCost: 1_500 },
];

export function upgradeCost(base: number, level: number): number {
  return Math.round(base * Math.pow(2.1, level));
}

/** Multipliers applied to the car's base stats, per upgrade level. */
export function engineBonus(level: number): number {
  return 1 + level * 0.07;
}
export function turboBonus(level: number): number {
  return 1 + level * 0.1;
}
export function tiresBonus(level: number): number {
  return 1 + level * 0.06;
}
export function nitroCapacity(level: number): number {
  return 2.2 + level * 0.5;
}

// ---------------------------------------------------------------- nitro

/** Extra forward acceleration while nitro is held, as a multiplier. */
export const NITRO_BOOST = 1.9;
/** Nitro refilled per second of drifting. */
export const NITRO_PER_DRIFT_SECOND = 0.75;
/** Nitro refilled per coin picked up. */
export const NITRO_PER_COIN = 0.25;

// ---------------------------------------------------------------- track

/** Length of one generated road segment, in metres. */
export const SEG_LEN = 7;
/** Half-width of the drivable road. */
export const ROAD_HALF = 9;
/** Segments kept alive ahead of and behind the car. */
export const SEG_AHEAD = 150;
export const SEG_BEHIND = 40;

// ------------------------------------------------------------ progression

export function xpToNext(level: number): number {
  return Math.round(2500 * Math.pow(level, 1.45));
}

export function levelReward(level: number): number {
  return Math.round(1200 * Math.pow(level, 1.3));
}

// ------------------------------------------------------------- ad policy

export const AD_REWARDS = {
  coinsBase: 1_500,
  coinsDailyLimit: 6,
} as const;

/** An interstitial is considered only after this many finished runs. */
export const INTERSTITIAL_EVERY_RUNS = 3;

export const DAILY_REWARDS: readonly number[] = [
  1_000, 2_000, 3_500, 6_000, 10_000, 18_000, 40_000,
];
