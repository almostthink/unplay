import { S, store, cellCount, type Cell } from './state';
import {
  chain,
  itemXp,
  mergeCoins,
  sellValue,
  MAX_TIER,
  type ChainId,
} from './items';
import {
  COLS,
  ROWS_MAX,
  ROW_COSTS,
  ROWS_START,
  genCapacity,
  genMaxTier,
  genRefillMs,
} from './config';
import { addCoins, addXp, bumpQuest, spendCoins } from './economy';

/** Chance that a spawn rolls one tier higher, applied repeatedly. */
const TIER_BUMP_CHANCE = 0.28;

// ------------------------------------------------------------- generators

/**
 * Accrues generator charges up to capacity. Safe to call with a huge `now`
 * gap, which is exactly what happens when returning from an offline session.
 */
export function tickGenerators(now = Date.now()): number {
  const s = S();
  let gained = 0;
  for (const id of Object.keys(s.gens) as ChainId[]) {
    const g = s.gens[id];
    if (!g.unlocked) {
      g.lastTick = now;
      continue;
    }
    const cap = genCapacity(g.level);
    if (g.charges >= cap) {
      g.lastTick = now;
      continue;
    }
    const step = genRefillMs(g.level);
    const elapsed = now - g.lastTick;
    if (elapsed < step) continue;

    const ticks = Math.floor(elapsed / step);
    const add = Math.min(ticks, cap - g.charges);
    g.charges += add;
    gained += add;
    // Keep the remainder so charges do not silently reset on every tick.
    g.lastTick = g.charges >= cap ? now : g.lastTick + ticks * step;
  }
  if (gained) store.emit('gens');
  return gained;
}

/** 0..1 progress towards the next charge, for the generator ring. */
export function genProgress(id: ChainId, now = Date.now()): number {
  const g = S().gens[id];
  if (g.charges >= genCapacity(g.level)) return 1;
  const step = genRefillMs(g.level);
  return Math.min(1, Math.max(0, (now - g.lastTick) / step));
}

export function msToNextCharge(id: ChainId, now = Date.now()): number {
  const g = S().gens[id];
  if (g.charges >= genCapacity(g.level)) return 0;
  return Math.max(0, genRefillMs(g.level) - (now - g.lastTick));
}

export function refillAllGenerators(): void {
  const s = S();
  for (const id of Object.keys(s.gens) as ChainId[]) {
    const g = s.gens[id];
    if (!g.unlocked) continue;
    g.charges = genCapacity(g.level);
    g.lastTick = Date.now();
  }
  store.emit('gens');
}

export type SpawnResult =
  | { ok: true; index: number; cell: Cell }
  | { ok: false; reason: 'locked' | 'empty' | 'full' };

export function spawnFrom(id: ChainId): SpawnResult {
  const s = S();
  const g = s.gens[id];
  if (!g.unlocked) return { ok: false, reason: 'locked' };
  if (g.charges <= 0) return { ok: false, reason: 'empty' };

  const slot = firstFreeCell();
  if (slot < 0) return { ok: false, reason: 'full' };

  const wasFull = g.charges >= genCapacity(g.level);
  g.charges -= 1;
  // Only restart the timer if the generator had been sitting at capacity.
  if (wasFull) g.lastTick = Date.now();

  const cell: Cell = { chain: id, tier: rollTier(genMaxTier(g.level)) };
  s.board[slot] = cell;
  s.stats.spawns += 1;
  bumpQuest('spawn', 1);

  store.emit('gens');
  store.emit('board');
  return { ok: true, index: slot, cell };
}

function rollTier(maxTier: number): number {
  let tier = 1;
  while (tier < maxTier && Math.random() < TIER_BUMP_CHANCE) tier++;
  return tier;
}

// ------------------------------------------------------------------ board

export function firstFreeCell(): number {
  const s = S();
  const n = cellCount();
  for (let i = 0; i < n; i++) if (!s.board[i]) return i;
  return -1;
}

export function freeCells(): number {
  const s = S();
  const n = cellCount();
  let free = 0;
  for (let i = 0; i < n; i++) if (!s.board[i]) free++;
  return free;
}

export function cellAt(i: number): Cell | null {
  if (i < 0 || i >= cellCount()) return null;
  return S().board[i];
}

export type DropResult =
  | { kind: 'merge'; tier: number; chain: ChainId; coins: number; xp: number }
  | { kind: 'move' }
  | { kind: 'swap' }
  | { kind: 'maxTier' }
  | { kind: 'none' };

/**
 * Resolves dropping the item at `from` onto `to`: merge when the pair matches,
 * otherwise move into an empty cell or swap two different items.
 */
export function dropOn(from: number, to: number): DropResult {
  const s = S();
  if (from === to) return { kind: 'none' };
  const n = cellCount();
  if (from < 0 || to < 0 || from >= n || to >= n) return { kind: 'none' };

  const a = s.board[from];
  if (!a) return { kind: 'none' };
  const b = s.board[to];

  if (!b) {
    s.board[to] = a;
    s.board[from] = null;
    store.emit('board');
    return { kind: 'move' };
  }

  if (a.chain === b.chain && a.tier === b.tier) {
    if (a.tier >= MAX_TIER) return { kind: 'maxTier' };
    const tier = a.tier + 1;
    s.board[to] = { chain: a.chain, tier };
    s.board[from] = null;
    s.stats.merges += 1;
    s.stats.maxTier = Math.max(s.stats.maxTier, tier);

    const coins = mergeCoins(tier);
    const xp = itemXp(tier);
    addCoins(coins);
    addXp(xp);
    bumpQuest('merge', 1);
    bumpQuest('tier', tier);
    store.emit('board');
    return { kind: 'merge', tier, chain: a.chain, coins, xp };
  }

  s.board[to] = a;
  s.board[from] = b;
  store.emit('board');
  return { kind: 'swap' };
}

export function sellAt(i: number): number {
  const s = S();
  const cell = s.board[i];
  if (!cell) return 0;
  const value = sellValue(cell.tier);
  s.board[i] = null;
  addCoins(value);
  store.emit('board');
  return value;
}

export function placeItem(item: Cell): number {
  const slot = firstFreeCell();
  if (slot < 0) return -1;
  S().board[slot] = item;
  S().stats.maxTier = Math.max(S().stats.maxTier, item.tier);
  store.emit('board');
  return slot;
}

export function countItems(id: ChainId, tier: number): number {
  const s = S();
  const n = cellCount();
  let found = 0;
  for (let i = 0; i < n; i++) {
    const c = s.board[i];
    if (c && c.chain === id && c.tier === tier) found++;
  }
  return found;
}

/** Removes up to `count` matching items and returns the indices freed. */
export function consumeItems(id: ChainId, tier: number, count: number): number[] {
  const s = S();
  const n = cellCount();
  const taken: number[] = [];
  for (let i = 0; i < n && taken.length < count; i++) {
    const c = s.board[i];
    if (c && c.chain === id && c.tier === tier) {
      s.board[i] = null;
      taken.push(i);
    }
  }
  if (taken.length) store.emit('board');
  return taken;
}

/** Highest tier the player currently owns in a chain, 0 when none. */
export function highestTier(id: ChainId): number {
  const s = S();
  const n = cellCount();
  let best = 0;
  for (let i = 0; i < n; i++) {
    const c = s.board[i];
    if (c && c.chain === id && c.tier > best) best = c.tier;
  }
  return best;
}

// --------------------------------------------------------------- expansion

export function nextRowCost(): number | null {
  const s = S();
  if (s.rows >= ROWS_MAX) return null;
  return ROW_COSTS[s.rows - ROWS_START] ?? null;
}

export function expandBoard(): boolean {
  const cost = nextRowCost();
  if (cost === null) return false;
  if (!spendCoins(cost)) return false;
  S().rows += 1;
  store.emit('rows');
  store.emit('board');
  return true;
}

export const boardCols = COLS;
export const boardRows = (): number => S().rows;

/** Emoji for a cell, or an empty string for a hole. */
export function cellEmoji(c: Cell | null): string {
  return c ? chain(c.chain).tiers[c.tier - 1][0] : '';
}
