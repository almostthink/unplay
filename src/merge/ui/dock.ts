import { store } from '../state';
import { claimableQuests } from '../quests';
import { refreshDaily } from '../daily';
import { el } from '../../platform/util';
import { t } from '../../platform/i18n';
import { sfx } from '../audio';
import {
  openDaily,
  openLeaderboard,
  openQuests,
  openShop,
  openUpgrades,
} from './screens';

interface DockItem {
  id: string;
  icon: string;
  label: string;
  open: () => void;
  badge?: () => number;
  hot?: () => boolean;
}

const ITEMS: DockItem[] = [
  { id: 'shop', icon: '🛒', label: 'dock.shop', open: openShop },
  { id: 'upg', icon: '🔧', label: 'dock.upgrades', open: openUpgrades },
  {
    id: 'quests',
    icon: '📋',
    label: 'dock.quests',
    open: openQuests,
    badge: claimableQuests,
  },
  {
    id: 'daily',
    icon: '🎁',
    label: 'dock.daily',
    open: openDaily,
    hot: () => refreshDaily().canClaim,
  },
  { id: 'top', icon: '🏆', label: 'dock.top', open: openLeaderboard },
];

export function mountDock(): void {
  const root = document.getElementById('dock')!;
  root.textContent = '';

  for (const item of ITEMS) {
    const btn = el('button', 'dock-btn');
    btn.dataset.id = item.id;
    btn.appendChild(el('span', 'ico', item.icon));
    btn.appendChild(el('span', undefined, t(item.label)));
    btn.addEventListener('click', () => {
      sfx.ui();
      item.open();
    });
    root.appendChild(btn);
  }

  store.on((topic) => {
    if (topic === 'quests' || topic === 'coins' || topic === 'gems') refreshDock();
  });
  refreshDock();
}

export function refreshDock(): void {
  const root = document.getElementById('dock');
  if (!root) return;
  for (const item of ITEMS) {
    const btn = root.querySelector<HTMLElement>(`[data-id="${item.id}"]`);
    if (!btn) continue;

    btn.querySelector('.badge')?.remove();
    const count = item.badge?.() ?? 0;
    if (count > 0) btn.appendChild(el('span', 'badge', String(count)));

    btn.classList.toggle('hot', !!item.hot?.());
  }
}
