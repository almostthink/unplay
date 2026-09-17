import { ya } from '../platform/yandex';
import { S } from './state';
import { AD_REWARDS, INTERSTITIAL_EVERY_RUNS } from './config';
import { sfx } from './audio';
import { toast } from '../platform/fx';
import { dayIndex } from '../platform/util';
import { t } from '../platform/i18n';

let adRunning = false;

/** Mirrors ad visibility into audio so nothing plays over an ad. */
export function installAdHooks(): void {
  ya.onAdStateChange = (busy) => sfx.setSuspended(busy);
  document.addEventListener('visibilitychange', () => {
    sfx.setSuspended(document.visibilityState === 'hidden' || ya.isAdBusy);
  });
}

export function isAdRunning(): boolean {
  return adRunning;
}

/** Resolves `true` only when the reward was earned. */
export async function rewardedAd(): Promise<boolean> {
  if (adRunning) {
    toast(t('ad.wait'));
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
 * Interstitials fire between runs only, never during one, and only after
 * enough runs have passed to keep the pacing tolerable.
 */
export async function maybeInterstitial(): Promise<void> {
  const s = S();
  if (s.noAds || adRunning) return;
  if (s.runsSinceAd < INTERSTITIAL_EVERY_RUNS) return;
  if (!ya.canShowInterstitial()) return;

  adRunning = true;
  try {
    if (await ya.showInterstitial()) s.runsSinceAd = 0;
  } finally {
    adRunning = false;
  }
}

/** The banner is hidden during a run so it never covers the road. */
export async function setBanner(visible: boolean): Promise<void> {
  const s = S();
  if (!visible || s.noAds || !s.settings.banner) await ya.hideBanner();
  else await ya.showBanner();
}

export function rolloverAdDay(): void {
  const s = S();
  const today = dayIndex();
  if (s.adDay === today) return;
  s.adDay = today;
  s.adCoinsUsed = 0;
}

export function adCoinsLeft(): number {
  rolloverAdDay();
  return Math.max(0, AD_REWARDS.coinsDailyLimit - S().adCoinsUsed);
}
