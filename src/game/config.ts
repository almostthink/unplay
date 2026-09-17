import type { ChainId } from './items';

export const GAME_VERSION = '1.0.0';

/** Bump when the save shape changes incompatibly. */
export const SAVE_VERSION = 1;
export const SAVE_KEY = 'mergeEmpire.save.v1';

/** Name of the leaderboard created in the Yandex developer console. */
export const LEADERBOARD_NAME = 'empire';

/** In-app product IDs, as configured in the Yandex developer console. */
export const PRODUCTS = {
  gemsSmall: 'gems_small',
  gemsMedium: 'gems_medium',
  gemsLarge: 'gems_large',
  starter: 'starter_pack',
  noAds: 'no_ads',
} as const;

/** Gems granted per product, keyed by product ID. */
export const PRODUCT_GEMS: Record<string, number> = {
  [PRODUCTS.gemsSmall]: 60,
  [PRODUCTS.gemsMedium]: 350,
  [PRODUCTS.gemsLarge]: 1200,
  [PRODUCTS.starter]: 150,
};

// ------------------------------------------------------------------ board

export const COLS = 6;
export const ROWS_START = 4;
export const ROWS_MAX = 7;

/** Coin cost to unlock each row beyond `ROWS_START`. */
export const ROW_COSTS = [600, 3200, 15000];

// ------------------------------------------------------------- generators

export const GEN_MAX_LEVEL = 8;

export function genCapacity(level: number): number {
  return 3 + level;
}

/** Milliseconds to regenerate one charge. */
export function genRefillMs(level: number): number {
  return Math.round(Math.max(9, 42 - level * 3.8) * 1000);
}

/** Highest item tier this generator can drop. */
export function genMaxTier(level: number): number {
  return 1 + Math.floor((level - 1) / 2);
}

export function genUpgradeCost(base: number, level: number): number {
  return Math.round(base * Math.pow(2.35, level - 1));
}

// ------------------------------------------------------------ progression

/** Cumulative XP needed to go from `level` to `level + 1`. */
export function xpToNext(level: number): number {
  return Math.round(40 * Math.pow(level, 1.7));
}

/** Coins + gems handed out on each level-up. */
export function levelReward(level: number): { coins: number; gems: number } {
  return {
    coins: Math.round(80 * Math.pow(level, 1.5)),
    gems: level % 3 === 0 ? 5 : 2,
  };
}

// ---------------------------------------------------------------- orders

export const ORDER_SLOTS = 3;

/** Multiplier applied to the raw item value when an order is paid out. */
export const ORDER_PAYOUT_MULT = 2.4;
export const ORDER_GEM_CHANCE = 0.18;

// ------------------------------------------------------------- offline

/** Offline progress stops accruing past this window. */
export const OFFLINE_CAP_MS = 4 * 60 * 60 * 1000;

export function offlineCoinsPerMinute(level: number): number {
  return 2 + level * 1.6;
}

// --------------------------------------------------------------- energy

/** Gem price of an instant full refill of every generator. */
export const REFILL_GEM_COST = 25;

// ------------------------------------------------------------ ad rewards

export const AD_REWARDS = {
  /** Free gems from the shop, limited per day. */
  gems: 15,
  gemsDailyLimit: 5,
  /** Coins from the shop ad, scaled by empire level. */
  coinsBase: 250,
  coinsDailyLimit: 8,
} as const;

/** Interstitials only fire on these milestones, never mid-drag. */
export const INTERSTITIAL_EVERY_ORDERS = 6;
export const INTERSTITIAL_EVERY_LEVELS = 3;

// --------------------------------------------------------- daily rewards

export interface DailyReward {
  coins: number;
  gems: number;
  /** Optional free item dropped straight onto the board. */
  item?: { chain: ChainId; tier: number };
}

export const DAILY_REWARDS: readonly DailyReward[] = [
  { coins: 150, gems: 0 },
  { coins: 300, gems: 3 },
  { coins: 600, gems: 0, item: { chain: 'mine', tier: 3 } },
  { coins: 1000, gems: 6 },
  { coins: 1800, gems: 0, item: { chain: 'garden', tier: 4 } },
  { coins: 3000, gems: 12 },
  { coins: 6000, gems: 30, item: { chain: 'mine', tier: 5 } },
];

// ----------------------------------------------------------- daily quests

export type QuestKind = 'merge' | 'orders' | 'spawn' | 'tier' | 'coins';

export interface QuestTemplate {
  kind: QuestKind;
  /** Goal is scaled by empire level so tasks stay meaningful. */
  goal: (level: number) => number;
  reward: (level: number) => { coins: number; gems: number };
}

export const QUEST_POOL: readonly QuestTemplate[] = [
  {
    kind: 'merge',
    goal: (l) => 15 + l * 3,
    reward: (l) => ({ coins: 120 + l * 40, gems: 2 }),
  },
  {
    kind: 'orders',
    goal: (l) => 3 + Math.floor(l / 4),
    reward: (l) => ({ coins: 200 + l * 60, gems: 3 }),
  },
  {
    kind: 'spawn',
    goal: (l) => 25 + l * 4,
    reward: (l) => ({ coins: 100 + l * 30, gems: 2 }),
  },
  {
    kind: 'tier',
    goal: (l) => Math.min(8, 3 + Math.floor(l / 5)),
    reward: (l) => ({ coins: 250 + l * 70, gems: 4 }),
  },
  {
    kind: 'coins',
    goal: (l) => 500 + l * 250,
    reward: () => ({ coins: 0, gems: 5 }),
  },
];

export const QUESTS_PER_DAY = 3;

// ---------------------------------------------------------------- tutorial

export const TUTORIAL_STEPS = 4;
