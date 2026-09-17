import { S } from './state';
import { OFFLINE_CAP_MS, offlineCoinsPerMinute } from './config';
import { tickGenerators } from './board';
import { addCoins } from './economy';

/** Anything shorter than this is not worth interrupting the player for. */
const MIN_OFFLINE_MS = 2 * 60 * 1000;

export interface OfflineReport {
  ms: number;
  coins: number;
  charges: number;
}

/**
 * Settles time spent away. Generator charges are credited immediately (they
 * are just timers), while coins are held back so the player can double them
 * with a rewarded ad.
 */
export function computeOffline(): OfflineReport | null {
  const s = S();
  const now = Date.now();
  const elapsed = Math.min(OFFLINE_CAP_MS, Math.max(0, now - s.lastSeen));

  const charges = tickGenerators(now);

  if (elapsed < MIN_OFFLINE_MS) return null;

  const minutes = elapsed / 60_000;
  const coins = Math.floor(minutes * offlineCoinsPerMinute(s.level));
  if (coins <= 0 && charges <= 0) return null;

  return { ms: elapsed, coins, charges };
}

export function collectOffline(report: OfflineReport, multiplier = 1): number {
  const coins = Math.round(report.coins * multiplier);
  addCoins(coins);
  return coins;
}
