import { ya } from '../sdk/yandex';
import { S } from './state';
import { AD_REWARDS, INTERSTITIAL_EVERY_LEVELS, INTERSTITIAL_EVERY_ORDERS } from './config';
import { sfx } from '../core/audio';
import { toast } from '../core/fx';
import { dayIndex } from '../core/util';
import { t } from '../i18n';

let adRunning = false;

/** Mirrors ad visibility into the audio engine so nothing plays over an ad. */
export function installAdHooks(): void {
  ya.onAdStateChange = (busy) => sfx.setSuspended(busy);
  document.addEventListener('visibilitychange', () => {
    sfx.setSuspended(document.visibilityState === 'hidden' || ya.isAdBusy);
  });
}

/**
 * Runs a rewarded video. Resolves `true` only when the reward was earned, so
 * callers can grant it exactly once.
 */
export async function rewardedAd(): Promise<boolean> {
  if (adRunning) {
    toast(t('ad.cooldown'));
    return false;
  }
  adRunning = true;
  try {
    const result = await ya.showRewarded();
    if (result === 'rewarded') return true;
    toast(result === 'closed' ? t('ad.noReward') : t('ad.failed'), 'bad');
    return false;
  } finally {
    adRunning = false;
  }
}

/**
 * Shows an interstitial at a natural break, subject to the player's purchase,
 * the SDK cooldown and a milestone counter so it never feels spammy.
 */
export async function maybeInterstitial(reason: 'orders' | 'levels'): Promise<void> {
  const s = S();
  if (s.noAds || adRunning) return;

  if (reason === 'orders') {
    if (s.ordersSinceAd < INTERSTITIAL_EVERY_ORDERS) return;
  } else if (s.levelsSinceAd < INTERSTITIAL_EVERY_LEVELS) {
    return;
  }
  if (!ya.canShowInterstitial()) return;

  adRunning = true;
  try {
    const shown = await ya.showInterstitial();
    if (shown) {
      s.ordersSinceAd = 0;
      s.levelsSinceAd = 0;
    }
  } finally {
    adRunning = false;
  }
}

export async function syncBanner(): Promise<void> {
  const s = S();
  if (s.noAds || !s.settings.banner) await ya.hideBanner();
  else await ya.showBanner();
}

// ------------------------------------------------------- daily ad quotas

export type AdQuota = 'gems' | 'coins';

/** Resets the per-day rewarded-ad counters when the calendar day rolls over. */
export function rolloverAdDay(): void {
  const s = S();
  const today = dayIndex();
  if (s.adDay === today) return;
  s.adDay = today;
  s.adGemsUsed = 0;
  s.adCoinsUsed = 0;
}

export function adUsesLeft(kind: AdQuota): number {
  rolloverAdDay();
  const s = S();
  return kind === 'gems'
    ? Math.max(0, AD_REWARDS.gemsDailyLimit - s.adGemsUsed)
    : Math.max(0, AD_REWARDS.coinsDailyLimit - s.adCoinsUsed);
}

export function consumeAdUse(kind: AdQuota): void {
  const s = S();
  if (kind === 'gems') s.adGemsUsed += 1;
  else s.adCoinsUsed += 1;
}
