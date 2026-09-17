import {
  CARS,
  PAINT_PRICE,
  UPGRADES,
  UPGRADE_MAX,
  engineBonus,
  nitroCapacity,
  tiresBonus,
  turboBonus,
  upgradeCost,
  type CarDef,
  type UpgradeId,
} from './config';
import { S, store } from './state';
import { spendCoins } from './economy';
import type { CarStats } from './car';
import { getLang } from '../platform/i18n';

export function carDef(id: string): CarDef {
  return CARS.find((c) => c.id === id) ?? CARS[0];
}

export function carName(id: string): string {
  const lang = getLang();
  const i = lang === 'ru' ? 0 : lang === 'en' ? 1 : 2;
  return carDef(id).name[i];
}

/** Base stats with the car's purchased upgrades folded in. */
export function effectiveStats(id: string): CarStats {
  const def = carDef(id);
  const up = S().cars[id]?.upgrades;
  const engine = up?.engine ?? 0;
  const turbo = up?.turbo ?? 0;
  const tires = up?.tires ?? 0;
  return {
    topSpeed: def.topSpeed * engineBonus(engine),
    accel: def.accel * turboBonus(turbo),
    grip: def.grip * tiresBonus(tires),
    steer: def.steer,
  };
}

export function nitroMax(id: string): number {
  return nitroCapacity(S().cars[id]?.upgrades.nitro ?? 0);
}

export function costOf(id: string, upgrade: UpgradeId): number | null {
  const level = S().cars[id]?.upgrades[upgrade] ?? 0;
  if (level >= UPGRADE_MAX) return null;
  const def = UPGRADES.find((u) => u.id === upgrade)!;
  // Later cars are faster, so their upgrades cost proportionally more.
  const carIndex = CARS.findIndex((c) => c.id === id);
  return Math.round(upgradeCost(def.baseCost, level) * (1 + carIndex * 0.6));
}

export function buyUpgrade(id: string, upgrade: UpgradeId): boolean {
  const cost = costOf(id, upgrade);
  if (cost === null) return false;
  if (!spendCoins(cost)) return false;
  S().cars[id].upgrades[upgrade] += 1;
  store.emit('garage');
  return true;
}

export function buyCar(id: string): boolean {
  const s = S();
  const def = carDef(id);
  if (s.cars[id].owned) return false;
  if (!spendCoins(def.price)) return false;
  s.cars[id].owned = true;
  s.currentCar = id;
  store.emit('garage');
  return true;
}

export function selectCar(id: string): void {
  const s = S();
  if (!s.cars[id]?.owned) return;
  s.currentCar = id;
  store.emit('garage');
}

export function buyPaint(color: number): boolean {
  const s = S();
  if (s.ownedPaints.includes(color)) return false;
  if (!spendCoins(PAINT_PRICE)) return false;
  s.ownedPaints.push(color);
  store.emit('garage');
  return true;
}

export function applyPaint(color: number): void {
  const s = S();
  if (!s.ownedPaints.includes(color)) return;
  s.cars[s.currentCar].paint = color;
  store.emit('garage');
}

/** 0..1 fill for the garage stat bars. */
export function statBars(id: string): { speed: number; accel: number; grip: number } {
  const st = effectiveStats(id);
  return {
    speed: Math.min(1, st.topSpeed / 100),
    accel: Math.min(1, st.accel / 42),
    grip: Math.min(1, st.grip / 7.5),
  };
}
