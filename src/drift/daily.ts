import { S, store } from './state';
import { DAILY_REWARDS } from './config';
import { addCoins } from './economy';
import { dayIndex } from '../platform/util';

export interface DailyState {
  day: number;
  streak: number;
  canClaim: boolean;
}

/** A missed day resets the streak; a consecutive day extends it. */
export function refreshDaily(): DailyState {
  const s = S();
  const today = dayIndex();
  if (s.dailyClaimedDay >= 0 && today - s.dailyClaimedDay > 1) s.dailyStreak = 0;
  return {
    day: s.dailyStreak % DAILY_REWARDS.length,
    streak: s.dailyStreak,
    canClaim: s.dailyClaimedDay !== today,
  };
}

export function claimDaily(multiplier = 1): number | null {
  const state = refreshDaily();
  if (!state.canClaim) return null;
  const coins = Math.round(DAILY_REWARDS[state.day] * multiplier);
  addCoins(coins);
  const s = S();
  s.dailyClaimedDay = dayIndex();
  s.dailyStreak += 1;
  store.emit('coins');
  return coins;
}
