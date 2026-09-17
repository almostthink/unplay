import { getLang } from '../i18n';

export type ChainId = 'mine' | 'garden' | 'wood' | 'magic';

/** [emoji, ru, en, tr] — kept as a tuple so the content table stays readable. */
type TierRow = readonly [string, string, string, string];

export interface ChainDef {
  id: ChainId;
  /** Emoji of the generator that feeds this chain. */
  gen: string;
  genName: readonly [string, string, string];
  /** Empire level required before the generator appears on the board. */
  unlockLevel: number;
  /** Cost of the first generator upgrade; each level multiplies it. */
  upgradeBase: number;
  /** Accent colour used for the tile gradient. */
  hue: number;
  tiers: readonly TierRow[];
}

export const CHAINS: readonly ChainDef[] = [
  {
    id: 'mine',
    gen: '⛏️',
    genName: ['Шахта', 'Mine', 'Maden'],
    unlockLevel: 1,
    upgradeBase: 120,
    hue: 28,
    tiers: [
      ['🪨', 'Камень', 'Stone', 'Taş'],
      ['🧱', 'Медная руда', 'Copper ore', 'Bakır cevheri'],
      ['🔩', 'Железный слиток', 'Iron ingot', 'Demir külçe'],
      ['⚙️', 'Стальной механизм', 'Steel gear', 'Çelik dişli'],
      ['🥈', 'Серебряный слиток', 'Silver bar', 'Gümüş külçe'],
      ['🥇', 'Золотой слиток', 'Gold bar', 'Altın külçe'],
      ['💎', 'Кристалл', 'Crystal', 'Kristal'],
      ['🔮', 'Сфера силы', 'Orb of power', 'Güç küresi'],
      ['👑', 'Корона империи', 'Imperial crown', 'İmparatorluk tacı'],
    ],
  },
  {
    id: 'garden',
    gen: '🌱',
    genName: ['Грядка', 'Garden bed', 'Bahçe'],
    unlockLevel: 3,
    upgradeBase: 260,
    hue: 130,
    tiers: [
      ['🌰', 'Семечко', 'Seed', 'Tohum'],
      ['🌱', 'Росток', 'Sprout', 'Filiz'],
      ['🌿', 'Побег', 'Shoot', 'Sürgün'],
      ['🍀', 'Клевер', 'Clover', 'Yonca'],
      ['🌸', 'Цветок', 'Blossom', 'Çiçek'],
      ['🌻', 'Подсолнух', 'Sunflower', 'Ayçiçeği'],
      ['🌳', 'Дерево', 'Tree', 'Ağaç'],
      ['🍎', 'Золотое яблоко', 'Golden apple', 'Altın elma'],
      ['🌴', 'Древо жизни', 'Tree of life', 'Hayat ağacı'],
    ],
  },
  {
    id: 'wood',
    gen: '🧰',
    genName: ['Мастерская', 'Workshop', 'Atölye'],
    unlockLevel: 7,
    upgradeBase: 600,
    hue: 200,
    tiers: [
      ['🪵', 'Бревно', 'Log', 'Kütük'],
      ['🪑', 'Табурет', 'Stool', 'Tabure'],
      ['🚪', 'Дверь', 'Door', 'Kapı'],
      ['🛏️', 'Кровать', 'Bed', 'Yatak'],
      ['🏠', 'Дом', 'House', 'Ev'],
      ['🏡', 'Усадьба', 'Manor', 'Konak'],
      ['🏰', 'Замок', 'Castle', 'Kale'],
      ['🏯', 'Цитадель', 'Citadel', 'Hisar'],
      ['🌆', 'Столица', 'Capital', 'Başkent'],
    ],
  },
  {
    id: 'magic',
    gen: '✨',
    genName: ['Алтарь', 'Altar', 'Sunak'],
    unlockLevel: 14,
    upgradeBase: 1500,
    hue: 285,
    tiers: [
      ['✨', 'Искра', 'Spark', 'Kıvılcım'],
      ['🔥', 'Огонёк', 'Flame', 'Alev'],
      ['⚡', 'Молния', 'Lightning', 'Şimşek'],
      ['🌟', 'Звезда', 'Star', 'Yıldız'],
      ['☄️', 'Комета', 'Comet', 'Kuyruklu yıldız'],
      ['🪐', 'Планета', 'Planet', 'Gezegen'],
      ['🌌', 'Галактика', 'Galaxy', 'Galaksi'],
      ['🕳️', 'Сингулярность', 'Singularity', 'Tekillik'],
      ['🦄', 'Единорог', 'Unicorn', 'Tek boynuzlu at'],
    ],
  },
];

export const MAX_TIER = 9;

const CHAIN_BY_ID = new Map<ChainId, ChainDef>(CHAINS.map((c) => [c.id, c]));

export function chain(id: ChainId): ChainDef {
  const c = CHAIN_BY_ID.get(id);
  if (!c) throw new Error(`unknown chain ${id}`);
  return c;
}

function langIndex(): 0 | 1 | 2 {
  const l = getLang();
  return l === 'ru' ? 0 : l === 'en' ? 1 : 2;
}

export function itemEmoji(id: ChainId, tier: number): string {
  return chain(id).tiers[clampTier(tier) - 1][0];
}

export function itemName(id: ChainId, tier: number): string {
  return chain(id).tiers[clampTier(tier) - 1][1 + langIndex()];
}

export function genName(id: ChainId): string {
  return chain(id).genName[langIndex()];
}

function clampTier(tier: number): number {
  return tier < 1 ? 1 : tier > MAX_TIER ? MAX_TIER : tier;
}

/** Coin worth of a tier. Growth is steep enough that high tiers feel special. */
export function itemValue(tier: number): number {
  return Math.round(4 * Math.pow(2.15, clampTier(tier) - 1));
}

/** XP granted for creating an item of this tier through a merge. */
export function itemXp(tier: number): number {
  return Math.max(1, Math.round(itemValue(tier) / 3));
}

/** Coins trickled on every merge, so the board itself feels rewarding. */
export function mergeCoins(tier: number): number {
  return Math.max(1, Math.round(itemValue(tier) / 6));
}

/** Selling is deliberately worse than fulfilling an order. */
export function sellValue(tier: number): number {
  return Math.max(1, Math.round(itemValue(tier) * 0.55));
}
