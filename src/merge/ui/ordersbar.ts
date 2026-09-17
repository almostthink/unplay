import { S, store, type Order } from '../state';
import { itemEmoji, itemName } from '../items';
import { orderReady, reqProgress } from '../orders';
import { countItems } from '../board';
import { el, fmt } from '../../platform/util';
import { t } from '../../platform/i18n';
import { sfx } from '../audio';

export interface OrdersBarHandlers {
  onDeliver: (slot: number) => void;
  onReroll: (slot: number) => void;
}

let handlers: OrdersBarHandlers = { onDeliver: () => {}, onReroll: () => {} };

export function mountOrdersBar(h: OrdersBarHandlers): void {
  handlers = h;
  store.on((topic) => {
    // Board changes can complete an order, so they repaint the strip too.
    if (topic === 'orders' || topic === 'board') renderOrdersBar();
  });
  renderOrdersBar();
}

export function renderOrdersBar(): void {
  const root = document.getElementById('orders');
  if (!root) return;
  root.textContent = '';
  S().orders.forEach((order, slot) => {
    if (!order) return;
    root.appendChild(orderCard(order, slot));
  });
}

function orderCard(order: Order, slot: number): HTMLElement {
  const ready = orderReady(order);
  const card = el('div', `order ${ready ? 'ready' : ''}`.trim());

  const who = el('div', 'order-who');
  who.appendChild(el('span', undefined, order.who));
  who.appendChild(el('span', undefined, `#${order.id}`));
  card.appendChild(who);

  const items = el('div', 'order-items');
  for (const r of order.reqs) {
    const have = Math.min(r.count, reqProgress(r));
    const cell = el('div', `order-item ${have >= r.count ? 'done' : ''}`.trim());
    cell.title = itemName(r.chain, r.tier);
    cell.appendChild(el('span', undefined, itemEmoji(r.chain, r.tier)));
    cell.appendChild(el('b', undefined, `${Math.min(countItems(r.chain, r.tier), r.count)}/${r.count}`));
    items.appendChild(cell);
  }
  card.appendChild(items);

  const reward = el('div', 'order-reward');
  reward.appendChild(el('span', 'c', `🪙 ${fmt(order.coins)}`));
  if (order.gems > 0) reward.appendChild(el('span', undefined, `💠 ${order.gems}`));
  reward.appendChild(el('span', 'x', `✦ ${fmt(order.xp)}`));
  card.appendChild(reward);

  const btn = el('button', `order-btn ${ready ? 'go' : ''}`.trim(),
    ready ? t('order.deliver') : `📺 ${t('order.reroll')}`);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    sfx.ui();
    if (ready) handlers.onDeliver(slot);
    else handlers.onReroll(slot);
  });
  card.appendChild(btn);

  return card;
}
