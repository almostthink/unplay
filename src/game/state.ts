import {
  COLS,
  ROWS_MAX,
  ROWS_START,
  SAVE_VERSION,
  type QuestKind,
} from './config';
import type { ChainId } from './items';
import { CHAINS } from './items';
import { dayIndex } from '../core/util';

export interface Cell {
  chain: ChainId;
  tier: number;
}

export interface GenState {
  level: number;
  charges: number;
  /** Timestamp the current partial charge started accumulating from. */
  lastTick: number;
  unlocked: boolean;
}

export interface OrderReq {
  chain: ChainId;
  tier: number;
  count: number;
}

export interface Order {
  id: number;
  /** Emoji of the customer, purely cosmetic. */
  who: string;
  reqs: OrderReq[];
  coins: number;
  xp: number;
  gems: number;
}

export interface Quest {
  kind: QuestKind;
  goal: number;
  progress: number;
  coins: number;
  gems: number;
  claimed: boolean;
}

export interface Settings {
  sound: boolean;
  music: boolean;
  vibro: boolean;
  banner: boolean;
  lang: string | null;
}

export interface Stats {
  merges: number;
  spawns: number;
  ordersDone: number;
  coinsEarned: number;
  maxTier: number;
}

export interface SaveData {
  v: number;
  coins: number;
  gems: number;
  level: number;
  xp: number;
  rows: number;
  /** Flat grid, `row * COLS + col`, always `COLS * ROWS_MAX` long. */
  board: (Cell | null)[];
  gens: Record<ChainId, GenState>;
  orders: (Order | null)[];
  quests: Quest[];
  questDay: number;
  dailyStreak: number;
  dailyClaimedDay: number;
  stats: Stats;
  adDay: number;
  adGemsUsed: number;
  adCoinsUsed: number;
  settings: Settings;
  noAds: boolean;
  tutorial: number;
  lastSeen: number;
  ordersSinceAd: number;
  levelsSinceAd: number;
  nextOrderId: number;
}

export type Topic =
  | 'coins'
  | 'gems'
  | 'xp'
  | 'level'
  | 'board'
  | 'gens'
  | 'orders'
  | 'quests'
  | 'settings'
  | 'rows';

type Listener = (topic: Topic) => void;

export function freshSave(): SaveData {
  const gens = {} as Record<ChainId, GenState>;
  for (const c of CHAINS) {
    gens[c.id] = {
      level: 1,
      charges: 3 + 1,
      lastTick: Date.now(),
      unlocked: c.unlockLevel <= 1,
    };
  }
  return {
    v: SAVE_VERSION,
    coins: 100,
    gems: 10,
    level: 1,
    xp: 0,
    rows: ROWS_START,
    board: new Array(COLS * ROWS_MAX).fill(null),
    gens,
    orders: [null, null, null],
    quests: [],
    questDay: -1,
    dailyStreak: 0,
    dailyClaimedDay: -1,
    stats: { merges: 0, spawns: 0, ordersDone: 0, coinsEarned: 0, maxTier: 1 },
    adDay: dayIndex(),
    adGemsUsed: 0,
    adCoinsUsed: 0,
    settings: { sound: true, music: true, vibro: true, banner: true, lang: null },
    noAds: false,
    tutorial: 0,
    lastSeen: Date.now(),
    ordersSinceAd: 0,
    levelsSinceAd: 0,
    nextOrderId: 1,
  };
}

/**
 * Repairs a save that came from an older build or a corrupted cloud blob.
 * Anything unrecognised is replaced with the default rather than throwing,
 * because a player losing their empire to a parse error is unacceptable.
 */
export function migrate(raw: unknown): SaveData {
  const base = freshSave();
  if (!raw || typeof raw !== 'object') return base;
  const s = raw as Partial<SaveData>;

  const num = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : d;
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);

  base.coins = Math.max(0, num(s.coins, base.coins));
  base.gems = Math.max(0, num(s.gems, base.gems));
  base.level = Math.max(1, Math.floor(num(s.level, 1)));
  base.xp = Math.max(0, num(s.xp, 0));
  base.rows = Math.min(ROWS_MAX, Math.max(ROWS_START, Math.floor(num(s.rows, ROWS_START))));

  if (Array.isArray(s.board)) {
    for (let i = 0; i < base.board.length; i++) {
      const c = s.board[i];
      if (c && typeof c === 'object' && typeof (c as Cell).tier === 'number') {
        const cell = c as Cell;
        if (CHAINS.some((ch) => ch.id === cell.chain)) {
          base.board[i] = { chain: cell.chain, tier: Math.min(9, Math.max(1, cell.tier | 0)) };
        }
      }
    }
  }

  if (s.gens && typeof s.gens === 'object') {
    for (const c of CHAINS) {
      const g = (s.gens as Record<string, GenState>)[c.id];
      if (!g) continue;
      base.gens[c.id] = {
        level: Math.min(8, Math.max(1, Math.floor(num(g.level, 1)))),
        charges: Math.max(0, Math.floor(num(g.charges, 0))),
        lastTick: num(g.lastTick, Date.now()),
        unlocked: bool(g.unlocked, c.unlockLevel <= base.level),
      };
    }
  }
  // A level gained on another device may have unlocked generators already.
  for (const c of CHAINS) {
    if (base.level >= c.unlockLevel) base.gens[c.id].unlocked = true;
  }

  if (Array.isArray(s.orders)) {
    base.orders = base.orders.map((_, i) => {
      const o = s.orders![i];
      return o && typeof o === 'object' && Array.isArray((o as Order).reqs) ? (o as Order) : null;
    });
  }
  if (Array.isArray(s.quests)) base.quests = s.quests as Quest[];
  base.questDay = num(s.questDay, -1);
  base.dailyStreak = Math.max(0, num(s.dailyStreak, 0));
  base.dailyClaimedDay = num(s.dailyClaimedDay, -1);

  if (s.stats && typeof s.stats === 'object') {
    base.stats = {
      merges: num(s.stats.merges, 0),
      spawns: num(s.stats.spawns, 0),
      ordersDone: num(s.stats.ordersDone, 0),
      coinsEarned: num(s.stats.coinsEarned, 0),
      maxTier: Math.max(1, num(s.stats.maxTier, 1)),
    };
  }

  base.adDay = num(s.adDay, dayIndex());
  base.adGemsUsed = num(s.adGemsUsed, 0);
  base.adCoinsUsed = num(s.adCoinsUsed, 0);

  if (s.settings && typeof s.settings === 'object') {
    base.settings = {
      sound: bool(s.settings.sound, true),
      music: bool(s.settings.music, true),
      vibro: bool(s.settings.vibro, true),
      banner: bool(s.settings.banner, true),
      lang: typeof s.settings.lang === 'string' ? s.settings.lang : null,
    };
  }

  base.noAds = bool(s.noAds, false);
  base.tutorial = num(s.tutorial, 0);
  base.lastSeen = num(s.lastSeen, Date.now());
  base.ordersSinceAd = num(s.ordersSinceAd, 0);
  base.levelsSinceAd = num(s.levelsSinceAd, 0);
  base.nextOrderId = Math.max(1, num(s.nextOrderId, 1));

  base.v = SAVE_VERSION;
  return base;
}

class Store {
  s: SaveData = freshSave();
  private listeners = new Set<Listener>();
  private dirty = new Set<Topic>();
  private flushQueued = false;

  load(data: SaveData): void {
    this.s = data;
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Queues a change notification. Batching to a microtask means a single
   * gesture that touches coins, XP and the board only repaints the UI once.
   */
  emit(topic: Topic): void {
    this.dirty.add(topic);
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      const topics = Array.from(this.dirty);
      this.dirty.clear();
      for (const topic2 of topics) {
        for (const fn of this.listeners) {
          try {
            fn(topic2);
          } catch {
            /* a broken listener must not stall the rest */
          }
        }
      }
    });
  }
}

export const store = new Store();

/** Shorthand for the live save object. */
export const S = (): SaveData => store.s;

export const idx = (col: number, row: number): number => row * COLS + col;
export const colOf = (i: number): number => i % COLS;
export const rowOf = (i: number): number => Math.floor(i / COLS);
export const cellCount = (): number => store.s.rows * COLS;
