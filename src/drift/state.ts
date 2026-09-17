import { CARS, PAINTS, SAVE_VERSION, UPGRADES, type UpgradeId } from './config';
import { dayIndex } from '../platform/util';

export interface CarSave {
  owned: boolean;
  paint: number;
  upgrades: Record<UpgradeId, number>;
}

export interface Settings {
  sound: boolean;
  music: boolean;
  vibro: boolean;
  banner: boolean;
  /** Rendering tier: 'high' | 'medium' | 'low'. Auto-picked, overridable. */
  quality: 'high' | 'medium' | 'low';
  lang: string | null;
}

export interface Stats {
  runs: number;
  bestScore: number;
  bestDistance: number;
  totalDistance: number;
  bestDriftMult: number;
  coinsEarned: number;
}

export interface SaveData {
  v: number;
  coins: number;
  level: number;
  xp: number;
  currentCar: string;
  cars: Record<string, CarSave>;
  ownedPaints: number[];
  stats: Stats;
  settings: Settings;
  noAds: boolean;
  runsSinceAd: number;
  adDay: number;
  adCoinsUsed: number;
  dailyStreak: number;
  dailyClaimedDay: number;
  tutorialSeen: boolean;
  lastSeen: number;
}

function freshCar(owned: boolean, paint: number): CarSave {
  const upgrades = {} as Record<UpgradeId, number>;
  for (const u of UPGRADES) upgrades[u.id] = 0;
  return { owned, paint, upgrades };
}

export function freshSave(): SaveData {
  const cars: Record<string, CarSave> = {};
  for (const c of CARS) cars[c.id] = freshCar(c.price === 0, c.color);
  return {
    v: SAVE_VERSION,
    coins: 0,
    level: 1,
    xp: 0,
    currentCar: CARS[0].id,
    cars,
    ownedPaints: PAINTS.slice(0, 3),
    stats: {
      runs: 0,
      bestScore: 0,
      bestDistance: 0,
      totalDistance: 0,
      bestDriftMult: 1,
      coinsEarned: 0,
    },
    settings: {
      sound: true,
      music: true,
      vibro: true,
      banner: true,
      quality: 'high',
      lang: null,
    },
    noAds: false,
    runsSinceAd: 0,
    adDay: dayIndex(),
    adCoinsUsed: 0,
    dailyStreak: 0,
    dailyClaimedDay: -1,
    tutorialSeen: false,
    lastSeen: Date.now(),
  };
}

/**
 * Rebuilds a save from untrusted input. A cloud blob written by an older
 * build, or a truncated one, must never cost the player their garage, so
 * every field falls back to the default instead of throwing.
 */
export function migrate(raw: unknown): SaveData {
  const base = freshSave();
  if (!raw || typeof raw !== 'object') return base;
  const s = raw as Partial<SaveData>;

  const num = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : d;
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);

  base.coins = Math.max(0, num(s.coins, 0));
  base.level = Math.max(1, Math.floor(num(s.level, 1)));
  base.xp = Math.max(0, num(s.xp, 0));

  if (s.cars && typeof s.cars === 'object') {
    for (const c of CARS) {
      const saved = (s.cars as Record<string, CarSave>)[c.id];
      if (!saved) continue;
      const target = base.cars[c.id];
      target.owned = bool(saved.owned, c.price === 0);
      target.paint = num(saved.paint, c.color);
      if (saved.upgrades && typeof saved.upgrades === 'object') {
        for (const u of UPGRADES) {
          target.upgrades[u.id] = Math.max(
            0,
            Math.min(6, Math.floor(num(saved.upgrades[u.id], 0))),
          );
        }
      }
    }
  }

  if (typeof s.currentCar === 'string' && base.cars[s.currentCar]?.owned) {
    base.currentCar = s.currentCar;
  }

  if (Array.isArray(s.ownedPaints)) {
    const valid = s.ownedPaints.filter((p) => PAINTS.includes(p));
    if (valid.length) base.ownedPaints = Array.from(new Set(valid));
  }

  if (s.stats && typeof s.stats === 'object') {
    base.stats = {
      runs: num(s.stats.runs, 0),
      bestScore: num(s.stats.bestScore, 0),
      bestDistance: num(s.stats.bestDistance, 0),
      totalDistance: num(s.stats.totalDistance, 0),
      bestDriftMult: Math.max(1, num(s.stats.bestDriftMult, 1)),
      coinsEarned: num(s.stats.coinsEarned, 0),
    };
  }

  if (s.settings && typeof s.settings === 'object') {
    const q = s.settings.quality;
    base.settings = {
      sound: bool(s.settings.sound, true),
      music: bool(s.settings.music, true),
      vibro: bool(s.settings.vibro, true),
      banner: bool(s.settings.banner, true),
      quality: q === 'low' || q === 'medium' || q === 'high' ? q : 'high',
      lang: typeof s.settings.lang === 'string' ? s.settings.lang : null,
    };
  }

  base.noAds = bool(s.noAds, false);
  base.runsSinceAd = num(s.runsSinceAd, 0);
  base.adDay = num(s.adDay, dayIndex());
  base.adCoinsUsed = num(s.adCoinsUsed, 0);
  base.dailyStreak = Math.max(0, num(s.dailyStreak, 0));
  base.dailyClaimedDay = num(s.dailyClaimedDay, -1);
  base.tutorialSeen = bool(s.tutorialSeen, false);
  base.lastSeen = num(s.lastSeen, Date.now());
  base.v = SAVE_VERSION;
  return base;
}

export type Topic = 'coins' | 'garage' | 'level' | 'settings';

class Store {
  s: SaveData = freshSave();
  private listeners = new Set<(topic: Topic) => void>();

  load(data: SaveData): void {
    this.s = data;
  }

  on(fn: (topic: Topic) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(topic: Topic): void {
    for (const fn of this.listeners) {
      try {
        fn(topic);
      } catch {
        /* a broken listener must not stall the rest */
      }
    }
  }
}

export const store = new Store();
export const S = (): SaveData => store.s;

export function currentCarSave(): CarSave {
  return S().cars[S().currentCar];
}
