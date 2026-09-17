import { S, store } from './state';
import { DAILY_REWARDS } from './config';
import { addCoins, addGems } from './economy';
import { placeItem } from './board';
import { dayIndex } from '../platform/util';

export interface DailyState {
  /** 0-based index into `DAILY_REWARDS`. */
  day: number;
  streak: number;
  canClaim: boolean;
}

/**
 * Updates the streak on launch: a missed day resets it to zero, a consecutive
 * day extends it, and the same day leaves everything alone.
 */
export function refreshDaily(): DailyState {
  const s = S();
  const today = dayIndex();

  if (s.dailyClaimedDay >= 0 && today - s.dailyClaimedDay > 1) {
    s.dailyStreak = 0;
  }
  const canClaim = s.dailyClaimedDay !== today;
  return {
    day: s.dailyStreak % DAILY_REWARDS.length,
    streak: s.dailyStreak,
    canClaim,
  };
}

export function claimDaily(multiplier = 1): { coins: number; gems: number; item: boolean } | null {
  const s = S();
  const state = refreshDaily();
  if (!state.canClaim) return null;

  const reward = DAILY_REWARDS[state.day];
  const coins = Math.round(reward.coins * multiplier);
  const gems = Math.round(reward.gems * multiplier);

  addCoins(coins);
  addGems(gems);

  let itemPlaced = false;
  if (reward.item) {
    itemPlaced = placeItem({ chain: reward.item.chain, tier: reward.item.tier }) >= 0;
  }

  s.dailyClaimedDay = dayIndex();
  s.dailyStreak += 1;
  store.emit('coins');
  store.emit('gems');

  return { coins, gems, item: itemPlaced };
}
