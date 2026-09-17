import { S, store } from './state';
import { levelReward, xpToNext } from './config';
import { toast } from '../platform/fx';
import { t } from '../platform/i18n';

export interface LevelUp {
  level: number;
  coins: number;
}

type Handler = (info: LevelUp) => void;
const handlers: Handler[] = [];

export function onLevelUp(fn: Handler): void {
  handlers.push(fn);
}

export function addCoins(n: number): void {
  if (n <= 0) return;
  const s = S();
  s.coins += n;
  s.stats.coinsEarned += n;
  store.emit('coins');
}

export function spendCoins(n: number): boolean {
  const s = S();
  if (s.coins < n) {
    toast(t('common.notEnough'), 'bad');
    return false;
  }
  s.coins -= n;
  store.emit('coins');
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
    const coins = levelReward(s.level);
    s.coins += coins;
    s.stats.coinsEarned += coins;
    for (const fn of handlers) {
      try {
        fn({ level: s.level, coins });
      } catch {
        /* a UI failure must not stop progression */
      }
    }
  }
  store.emit('level');
  store.emit('coins');
}

export function xpProgress(): { pct: number; have: number; need: number } {
  const s = S();
  const need = xpToNext(s.level);
  return { pct: Math.min(1, s.xp / need), have: Math.floor(s.xp), need };
}
