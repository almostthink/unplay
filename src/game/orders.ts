import { S, store, type Order, type OrderReq } from './state';
import { CHAINS, MAX_TIER, itemValue, type ChainId } from './items';
import {
  ORDER_GEM_CHANCE,
  ORDER_PAYOUT_MULT,
  ORDER_SLOTS,
  genMaxTier,
} from './config';
import { countItems, consumeItems } from './board';
import { addCoins, addGems, addXp, bumpQuest } from './economy';
import { pick, randInt } from '../core/util';

const CUSTOMERS = [
  '🧙', '👸', '🤴', '🧝', '🧜', '🦸', '🕵️', '👩‍🌾', '👨‍🍳', '🧚',
  '🐉', '🦊', '🐻', '🦉', '🐼', '🤖', '👻', '🧛',
];

function unlockedChains(): ChainId[] {
  const s = S();
  return CHAINS.filter((c) => s.gens[c.id].unlocked).map((c) => c.id);
}

/** Tier a player can realistically reach with their current generators. */
function reachableTier(id: ChainId): number {
  const g = S().gens[id];
  const base = genMaxTier(g.level);
  return Math.min(MAX_TIER - 1, Math.max(2, base + randInt(0, 2)));
}

function makeRequirement(): OrderReq {
  const chains = unlockedChains();
  const id = pick(chains.length ? chains : (['mine'] as ChainId[]));
  const tier = reachableTier(id);
  const count = tier <= 3 ? randInt(1, 3) : tier <= 5 ? randInt(1, 2) : 1;
  return { chain: id, tier, count };
}

export function makeOrder(): Order {
  const s = S();
  const reqCount = s.level < 3 ? 1 : s.level < 8 ? randInt(1, 2) : randInt(1, 3);

  const reqs: OrderReq[] = [];
  for (let i = 0; i < reqCount; i++) {
    const r = makeRequirement();
    // Fold duplicates together instead of showing the same item twice.
    const existing = reqs.find((x) => x.chain === r.chain && x.tier === r.tier);
    if (existing) existing.count = Math.min(5, existing.count + r.count);
    else reqs.push(r);
  }

  const raw = reqs.reduce((sum, r) => sum + itemValue(r.tier) * r.count, 0);
  return {
    id: s.nextOrderId++,
    who: pick(CUSTOMERS),
    reqs,
    coins: Math.round(raw * ORDER_PAYOUT_MULT + s.level * 15),
    xp: Math.max(2, Math.round(raw * 0.6)),
    gems: Math.random() < ORDER_GEM_CHANCE ? randInt(1, 3) : 0,
  };
}

/** Fills every empty order slot. Called on boot and after each delivery. */
export function ensureOrders(): void {
  const s = S();
  let changed = false;
  for (let i = 0; i < ORDER_SLOTS; i++) {
    if (!s.orders[i]) {
      s.orders[i] = makeOrder();
      changed = true;
    }
  }
  if (changed) store.emit('orders');
}

export function reqProgress(req: OrderReq): number {
  return Math.min(req.count, countItems(req.chain, req.tier));
}

export function orderReady(order: Order): boolean {
  // Counts are checked against a running tally so two requirements for the
  // same item cannot both claim the same board pieces.
  const used = new Map<string, number>();
  for (const r of order.reqs) {
    const key = `${r.chain}:${r.tier}`;
    const already = used.get(key) ?? 0;
    if (countItems(r.chain, r.tier) - already < r.count) return false;
    used.set(key, already + r.count);
  }
  return true;
}

export interface DeliveryResult {
  coins: number;
  gems: number;
  xp: number;
  /** Board indices the delivered items came from, for the fly-away effect. */
  from: number[];
}

export function deliverOrder(slot: number, multiplier = 1): DeliveryResult | null {
  const s = S();
  const order = s.orders[slot];
  if (!order || !orderReady(order)) return null;

  const from: number[] = [];
  for (const r of order.reqs) from.push(...consumeItems(r.chain, r.tier, r.count));

  const coins = Math.round(order.coins * multiplier);
  const gems = Math.round(order.gems * multiplier);
  const xp = order.xp;

  addCoins(coins);
  addGems(gems);
  addXp(xp);

  s.stats.ordersDone += 1;
  s.ordersSinceAd += 1;
  bumpQuest('orders', 1);

  s.orders[slot] = makeOrder();
  store.emit('orders');

  return { coins, gems, xp, from };
}

export function rerollOrder(slot: number): void {
  const s = S();
  if (slot < 0 || slot >= ORDER_SLOTS) return;
  s.orders[slot] = makeOrder();
  store.emit('orders');
}

/** Number of orders that could be delivered right now, for the dock badge. */
export function readyOrderCount(): number {
  return S().orders.filter((o) => o && orderReady(o)).length;
}
