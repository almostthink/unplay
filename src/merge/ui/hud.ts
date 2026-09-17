import { S, store } from '../state';
import { xpProgress } from '../economy';
import { el, fmt } from '../../platform/util';
import { t } from '../../platform/i18n';
import { openSettings } from './screens';

let coinsEl: HTMLElement;
let gemsEl: HTMLElement;
let lvlEl: HTMLElement;
let xpFill: HTMLElement;
let xpText: HTMLElement;

let lastCoins = -1;
let lastGems = -1;

export function mountHud(): void {
  const hud = document.getElementById('hud')!;
  hud.textContent = '';

  const coins = el('div', 'res coins');
  coins.appendChild(el('span', 'ico', '🪙'));
  coinsEl = el('span', 'val', '0');
  coins.appendChild(coinsEl);

  const gems = el('div', 'res gems');
  gems.appendChild(el('span', 'ico', '💠'));
  gemsEl = el('span', 'val', '0');
  gems.appendChild(gemsEl);

  const lvl = el('div', 'lvl');
  const top = el('div', 'lvl-top');
  lvlEl = el('span', undefined, `${t('res.level')} 1`);
  xpText = el('span', undefined, '0/0');
  top.appendChild(lvlEl);
  top.appendChild(xpText);
  const bar = el('div', 'xpbar');
  xpFill = el('i');
  bar.appendChild(xpFill);
  lvl.appendChild(top);
  lvl.appendChild(bar);

  const settings = el('button', 'icon-btn', '⚙️');
  settings.addEventListener('click', () => openSettings());

  hud.append(coins, gems, lvl, settings);

  store.on((topic) => {
    if (topic === 'coins' || topic === 'gems' || topic === 'xp' || topic === 'level') updateHud();
  });
  updateHud();
}

export function updateHud(): void {
  const s = S();
  const coins = Math.floor(s.coins);
  const gems = Math.floor(s.gems);

  coinsEl.textContent = fmt(coins);
  gemsEl.textContent = fmt(gems);
  lvlEl.textContent = `${t('res.level')} ${s.level}`;

  const xp = xpProgress();
  xpText.textContent = `${fmt(xp.have)}/${fmt(xp.need)}`;
  xpFill.style.width = `${(xp.pct * 100).toFixed(1)}%`;

  // A short pulse draws the eye to a balance that just changed.
  if (lastCoins >= 0 && coins > lastCoins) pulse(coinsEl.parentElement!);
  if (lastGems >= 0 && gems > lastGems) pulse(gemsEl.parentElement!);
  lastCoins = coins;
  lastGems = gems;
}

function pulse(node: HTMLElement): void {
  node.classList.remove('pop');
  void node.offsetWidth;
  node.classList.add('pop');
}
