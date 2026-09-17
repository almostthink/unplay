import { S, store } from './state';
import { CHAINS, genName, type ChainId } from './items';
import { genCapacity, levelReward, xpToNext } from './config';

export interface LevelUpInfo {
  level: number;
  coins: number;
  gems: number;
  /** Generators that became available at this level. */
  unlocked: ChainId[];
}

type LevelUpHandler = (info: LevelUpInfo) => void;
const levelUpHandlers: LevelUpHandler[] = [];

export function onLevelUp(fn: LevelUpHandler): void {
  levelUpHandlers.push(fn);
}

export function addCoins(n: number): void {
  if (n <= 0) return;
  const s = S();
  s.coins += n;
  s.stats.coinsEarned += n;
  bumpQuest('coins', n);
  store.emit('coins');
}

export function spendCoins(n: number): boolean {
  const s = S();
  if (s.coins < n) return false;
  s.coins -= n;
  store.emit('coins');
  return true;
}

export function addGems(n: number): void {
  if (n <= 0) return;
  S().gems += n;
  store.emit('gems');
}

export function spendGems(n: number): boolean {
  const s = S();
  if (s.gems < n) return false;
  s.gems -= n;
  store.emit('gems');
  return true;
}

export function addXp(n: number): void {
  if (n <= 0) return;
  const s = S();
  s.xp += n;

  let guard = 0;
  while (s.xp >= xpToNext(s.level) && guard++ < 100) {
    s.xp -= xpToNext(s.level);
    s.level += 1;
    s.levelsSinceAd += 1;

    const reward = levelReward(s.level);
    s.coins += reward.coins;
    s.stats.coinsEarned += reward.coins;
    s.gems += reward.gems;

    const unlocked: ChainId[] = [];
    for (const c of CHAINS) {
      if (!s.gens[c.id].unlocked && s.level >= c.unlockLevel) {
        s.gens[c.id].unlocked = true;
        // A freshly unlocked generator starts full so the player can try it now.
        s.gens[c.id].charges = genCapacity(s.gens[c.id].level);
        s.gens[c.id].lastTick = Date.now();
        unlocked.push(c.id);
      }
    }

    const info: LevelUpInfo = { level: s.level, ...reward, unlocked };
    for (const fn of levelUpHandlers) {
      try {
        fn(info);
      } catch {
        /* a UI failure must not stop progression */
      }
    }
    store.emit('gens');
  }

  store.emit('xp');
  store.emit('coins');
  store.emit('gems');
}

export function xpProgress(): { have: number; need: number; pct: number } {
  const s = S();
  const need = xpToNext(s.level);
  return { have: Math.floor(s.xp), need, pct: Math.min(1, s.xp / need) };
}

/** Human label for an unlocked generator, used in the level-up modal. */
export function unlockLabel(id: ChainId): string {
  return genName(id);
}

// ------------------------------------------------------------------ quests

/**
 * Advances every unclaimed daily quest of this kind. Lives here rather than in
 * quests.ts so economy calls do not create an import cycle.
 */
export function bumpQuest(kind: string, amount: number): void {
  const s = S();
  let changed = false;
  for (const q of s.quests) {
    if (q.kind !== kind || q.claimed || q.progress >= q.goal) continue;
    // "tier" quests report the tier reached, not a running total.
    q.progress = kind === 'tier' ? Math.max(q.progress, amount) : q.progress + amount;
    changed = true;
  }
  if (changed) store.emit('quests');
}
