import { S, store, type Quest } from './state';
import { QUESTS_PER_DAY, QUEST_POOL } from './config';
import { addCoins, addGems } from './economy';
import { dayIndex, shuffle } from '../platform/util';
import { highestTier } from './board';
import { CHAINS } from './items';

/** Rolls a fresh set of daily tasks when the calendar day has changed. */
export function refreshQuests(): boolean {
  const s = S();
  const today = dayIndex();
  if (s.questDay === today && s.quests.length) return false;

  const pool = shuffle([...QUEST_POOL]).slice(0, QUESTS_PER_DAY);
  s.quests = pool.map((tpl): Quest => {
    const reward = tpl.reward(s.level);
    return {
      kind: tpl.kind,
      goal: tpl.goal(s.level),
      progress: 0,
      coins: reward.coins,
      gems: reward.gems,
      claimed: false,
    };
  });

  // "Reach tier N" starts from what the player already has on the board,
  // otherwise it would silently ask them to re-do work.
  const best = Math.max(0, ...CHAINS.map((c) => highestTier(c.id)));
  for (const q of s.quests) if (q.kind === 'tier') q.progress = best;

  s.questDay = today;
  store.emit('quests');
  return true;
}

export function questDone(q: Quest): boolean {
  return q.progress >= q.goal;
}

export function claimQuest(i: number): { coins: number; gems: number } | null {
  const s = S();
  const q = s.quests[i];
  if (!q || q.claimed || !questDone(q)) return null;
  q.claimed = true;
  addCoins(q.coins);
  addGems(q.gems);
  store.emit('quests');
  return { coins: q.coins, gems: q.gems };
}

/** Count of quests waiting to be collected, for the dock badge. */
export function claimableQuests(): number {
  return S().quests.filter((q) => !q.claimed && questDone(q)).length;
}
