/**
 * Yandex.Games SDK wrapper.
 *
 * Every call is guarded so the game runs identically outside the Yandex frame
 * (local dev, itch.io, a plain static host): the SDK simply reports itself as
 * unavailable and callers fall back to local behaviour.
 *
 * Docs: https://yandex.ru/dev/games/doc/en/sdk/sdk-about
 */

const SDK_URL = 'https://yandex.ru/games/sdk/v2';
const SDK_LOAD_TIMEOUT = 8000;

/** Yandex enforces its own interstitial cooldown; we keep a slightly safer one. */
const INTERSTITIAL_COOLDOWN_MS = 75_000;

type AnySdk = any;

export interface PlayerInfo {
  id: string;
  name: string;
  photo: string;
  /** `true` when the visitor has not signed into a Yandex account. */
  isLite: boolean;
}

export interface LeaderboardEntry {
  rank: number;
  score: number;
  name: string;
  photo: string;
  isMe: boolean;
}

export interface CatalogProduct {
  id: string;
  title: string;
  description: string;
  price: string;
  priceValue: string;
  imageURI: string;
}

export type RewardResult = 'rewarded' | 'closed' | 'error';

class YandexSDK {
  private sdk: AnySdk = null;
  private player: AnySdk = null;
  private leaderboards: AnySdk = null;
  private payments: AnySdk = null;

  private lastInterstitial = 0;
  private adInProgress = false;
  private bannerVisible = false;

  /** Raised while an ad covers the game so the loop can pause audio/timers. */
  onAdStateChange: ((busy: boolean) => void) | null = null;

  get available(): boolean {
    return this.sdk !== null;
  }
  get paymentsAvailable(): boolean {
    return this.payments !== null;
  }
  get leaderboardsAvailable(): boolean {
    return this.leaderboards !== null;
  }
  get isAdBusy(): boolean {
    return this.adInProgress;
  }

  // ---------------------------------------------------------------- init

  async init(): Promise<boolean> {
    try {
      await loadScript(SDK_URL, SDK_LOAD_TIMEOUT);
      const YaGames = (window as any).YaGames;
      if (!YaGames) return false;
      this.sdk = await YaGames.init();
      // These three are optional; a failure in one must not block the others.
      await Promise.all([
        this.initPlayer(),
        this.initLeaderboards(),
        this.initPayments(),
      ]);
      return true;
    } catch {
      this.sdk = null;
      return false;
    }
  }

  private async initPlayer(): Promise<void> {
    try {
      // `scopes: false` avoids the personal-data consent dialog on first launch.
      this.player = await this.sdk.getPlayer({ scopes: false, signed: false });
    } catch {
      this.player = null;
    }
  }

  private async initLeaderboards(): Promise<void> {
    try {
      this.leaderboards = await this.sdk.getLeaderboards();
    } catch {
      this.leaderboards = null;
    }
  }

  private async initPayments(): Promise<void> {
    try {
      this.payments = await this.sdk.getPayments({ signed: false });
    } catch {
      this.payments = null;
    }
  }

  /** Tell Yandex the loading screen is over. Required by the platform review. */
  ready(): void {
    try {
      this.sdk?.features?.LoadingAPI?.ready?.();
    } catch {
      /* non-fatal */
    }
  }

  /** Marks the start of interactive gameplay (pauses platform-side overlays). */
  gameplayStart(): void {
    try {
      this.sdk?.features?.GameplayAPI?.start?.();
    } catch {
      /* non-fatal */
    }
  }

  gameplayStop(): void {
    try {
      this.sdk?.features?.GameplayAPI?.stop?.();
    } catch {
      /* non-fatal */
    }
  }

  // ------------------------------------------------------------ environment

  get lang(): string {
    try {
      return this.sdk?.environment?.i18n?.lang || navigator.language || 'ru';
    } catch {
      return navigator.language || 'ru';
    }
  }

  get isMobile(): boolean {
    try {
      if (this.sdk?.deviceInfo?.isMobile?.()) return true;
      if (this.sdk?.deviceInfo?.isTablet?.()) return true;
    } catch {
      /* fall through to UA sniff */
    }
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  }

  getPlayerInfo(): PlayerInfo | null {
    if (!this.player) return null;
    try {
      const isLite = this.player.getMode?.() === 'lite';
      return {
        id: this.player.getUniqueID?.() || '',
        name: isLite ? '' : this.player.getName?.() || '',
        photo: isLite ? '' : this.player.getPhoto?.('small') || '',
        isLite,
      };
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ ads

  private setAdBusy(busy: boolean): void {
    this.adInProgress = busy;
    try {
      this.onAdStateChange?.(busy);
    } catch {
      /* listener errors must not break ad flow */
    }
  }

  /** `true` when enough time has passed since the last interstitial. */
  canShowInterstitial(): boolean {
    return this.available && Date.now() - this.lastInterstitial >= INTERSTITIAL_COOLDOWN_MS;
  }

  /**
   * Shows an interstitial. Resolves with `true` only when an ad was actually
   * rendered, so callers can decide whether the moment "counted".
   */
  showInterstitial(): Promise<boolean> {
    if (!this.available || this.adInProgress || !this.canShowInterstitial()) {
      return Promise.resolve(false);
    }
    this.lastInterstitial = Date.now();
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (shown: boolean) => {
        if (settled) return;
        settled = true;
        this.setAdBusy(false);
        resolve(shown);
      };
      this.setAdBusy(true);
      try {
        this.sdk.adv.showFullscreenAdv({
          callbacks: {
            onClose: (wasShown: boolean) => done(!!wasShown),
            onError: () => done(false),
            onOffline: () => done(false),
          },
        });
      } catch {
        done(false);
      }
      // The SDK occasionally never calls back (blocked frame, adblock).
      window.setTimeout(() => done(false), 30_000);
    });
  }

  /**
   * Shows a rewarded video. `'rewarded'` means the reward must be granted.
   * Outside Yandex this resolves to `'rewarded'` immediately so the feature
   * stays playable in dev builds.
   */
  showRewarded(): Promise<RewardResult> {
    if (!this.available) return Promise.resolve('rewarded');
    if (this.adInProgress) return Promise.resolve('error');

    return new Promise<RewardResult>((resolve) => {
      let rewarded = false;
      let settled = false;
      const done = (r: RewardResult) => {
        if (settled) return;
        settled = true;
        this.setAdBusy(false);
        resolve(r);
      };
      this.setAdBusy(true);
      try {
        this.sdk.adv.showRewardedVideo({
          callbacks: {
            onRewarded: () => {
              rewarded = true;
            },
            onClose: () => done(rewarded ? 'rewarded' : 'closed'),
            onError: () => done(rewarded ? 'rewarded' : 'error'),
          },
        });
      } catch {
        done('error');
      }
      window.setTimeout(() => done(rewarded ? 'rewarded' : 'error'), 120_000);
    });
  }

  async showBanner(): Promise<void> {
    if (!this.available || this.bannerVisible) return;
    try {
      await this.sdk.adv.showBannerAdv();
      this.bannerVisible = true;
    } catch {
      /* banner is best-effort */
    }
  }

  async hideBanner(): Promise<void> {
    if (!this.available || !this.bannerVisible) return;
    try {
      await this.sdk.adv.hideBannerAdv();
      this.bannerVisible = false;
    } catch {
      /* banner is best-effort */
    }
  }

  // ------------------------------------------------------------- cloud save

  async loadData<T>(key: string): Promise<T | null> {
    if (!this.player) return null;
    try {
      const data = await this.player.getData([key]);
      return (data?.[key] as T) ?? null;
    } catch {
      return null;
    }
  }

  async saveData(key: string, value: unknown, flush = false): Promise<boolean> {
    if (!this.player) return false;
    try {
      await this.player.setData({ [key]: value }, flush);
      return true;
    } catch {
      return false;
    }
  }

  /** Numeric stats are what Yandex indexes for in-platform sorting. */
  async saveStats(stats: Record<string, number>): Promise<void> {
    if (!this.player) return;
    try {
      await this.player.setStats(stats);
    } catch {
      /* non-fatal */
    }
  }

  // ------------------------------------------------------------ leaderboard

  async submitScore(board: string, score: number): Promise<void> {
    if (!this.leaderboards) return;
    try {
      await this.leaderboards.setLeaderboardScore(board, Math.floor(score));
    } catch {
      /* the board may not exist yet in the developer console */
    }
  }

  async getLeaderboard(board: string, top = 10, around = 3): Promise<LeaderboardEntry[]> {
    if (!this.leaderboards) return [];
    try {
      const res = await this.leaderboards.getLeaderboardEntries(board, {
        quantityTop: top,
        includeUser: true,
        quantityAround: around,
      });
      const myId = this.getPlayerInfo()?.id ?? '';
      return (res?.entries ?? []).map((e: AnySdk) => ({
        rank: e.rank,
        score: e.score,
        name: e.player?.publicName || '',
        photo: e.player?.getAvatarSrc?.('small') || '',
        isMe: !!myId && e.player?.uniqueID === myId,
      }));
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------- payments

  async getCatalog(): Promise<CatalogProduct[]> {
    if (!this.payments) return [];
    try {
      const list = await this.payments.getCatalog();
      return (list ?? []).map((p: AnySdk) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        price: p.price,
        priceValue: p.priceValue,
        imageURI: p.getPriceCurrencyImage?.('medium') || '',
      }));
    } catch {
      return [];
    }
  }

  /** Buys a product and immediately consumes it (consumables only). */
  async purchase(id: string): Promise<boolean> {
    if (!this.payments) return false;
    try {
      const p = await this.payments.purchase({ id });
      if (p?.purchaseToken) {
        try {
          await this.payments.consumePurchase(p.purchaseToken);
        } catch {
          /* already consumed */
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Non-consumable check, used for the permanent "remove ads" product. */
  async hasPurchase(id: string): Promise<boolean> {
    if (!this.payments) return false;
    try {
      const list = await this.payments.getPurchases();
      return (list ?? []).some((p: AnySdk) => p.productID === id);
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- extras

  async canReview(): Promise<boolean> {
    if (!this.available) return false;
    try {
      const r = await this.sdk.feedback.canReview();
      return !!r?.value;
    } catch {
      return false;
    }
  }

  async requestReview(): Promise<boolean> {
    if (!this.available) return false;
    try {
      const r = await this.sdk.feedback.requestReview();
      return !!r?.feedbackSent;
    } catch {
      return false;
    }
  }

  async canAddShortcut(): Promise<boolean> {
    if (!this.available) return false;
    try {
      const r = await this.sdk.shortcut.canShowPrompt();
      return !!r?.canShow;
    } catch {
      return false;
    }
  }

  async addShortcut(): Promise<boolean> {
    if (!this.available) return false;
    try {
      const r = await this.sdk.shortcut.showPrompt();
      return r?.outcome === 'accepted';
    } catch {
      return false;
    }
  }
}

function loadScript(src: string, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as any).YaGames) return resolve();
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    const timer = window.setTimeout(() => reject(new Error('sdk timeout')), timeout);
    el.onload = () => {
      window.clearTimeout(timer);
      resolve();
    };
    el.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('sdk failed'));
    };
    document.head.appendChild(el);
  });
}

export const ya = new YandexSDK();
