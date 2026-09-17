import { el, fmt } from '../../platform/util';
import { t } from '../../platform/i18n';
import { S, store } from '../state';
import { xpProgress } from '../economy';
import { carName, statBars } from '../garage';
import { refreshDaily } from '../daily';
import { sfx } from '../audio';
import {
  openDaily,
  openGarage,
  openLeaderboard,
  openSettings,
  openShop,
} from './screens';

/** The front screen: balance, the selected car's stats and the play button. */
export class Menu {
  private root: HTMLElement;
  private coinsEl!: HTMLElement;
  private lvlEl!: HTMLElement;
  private xpText!: HTMLElement;
  private xpFill!: HTMLElement;
  private carNameEl!: HTMLElement;
  private bestEl!: HTMLElement;
  private bars: Record<string, HTMLElement> = {};
  private dailyBtn!: HTMLElement;
  private lastCoins = -1;

  constructor(private onPlay: () => void) {
    this.root = document.getElementById('menu')!;
    this.build();
    store.on(() => this.update());
    this.update();
  }

  private build(): void {
    const r = this.root;
    r.textContent = '';

    // --- top chips
    const top = el('div', 'chip-row');
    const coins = el('div', 'chip coins');
    coins.appendChild(el('span', undefined, '🪙'));
    this.coinsEl = el('span', undefined, '0');
    coins.appendChild(this.coinsEl);

    const lvl = el('div', 'lvl');
    const lvlTop = el('div', 'lvl-top');
    this.lvlEl = el('span', undefined, 'Lv. 1');
    this.xpText = el('span', undefined, '0/0');
    lvlTop.append(this.lvlEl, this.xpText);
    const bar = el('div', 'xpbar');
    this.xpFill = el('i');
    bar.appendChild(this.xpFill);
    lvl.append(lvlTop, bar);

    const settings = el('button', 'icon-btn', '⚙️');
    settings.addEventListener('click', () => {
      sfx.ui();
      openSettings();
    });

    top.append(coins, lvl, settings);
    r.appendChild(top);

    // --- title
    r.appendChild(el('div', 'title', t('app.title')));
    r.appendChild(el('div', 'subtitle', t('lb.sub')));

    // --- car card
    const card = el('div', 'car-card');
    const nameRow = el('div', 'car-name');
    this.carNameEl = el('span', undefined, '');
    this.bestEl = el('span', 'best', '');
    nameRow.append(this.carNameEl, this.bestEl);
    card.appendChild(nameRow);

    for (const [key, label] of [
      ['speed', 'stat.topSpeed'],
      ['accel', 'stat.accel'],
      ['grip', 'stat.grip'],
    ] as const) {
      const line = el('div', 'stat');
      line.appendChild(el('b', undefined, t(label)));
      const track = el('div', 'bar');
      const fill = el('i');
      track.appendChild(fill);
      line.appendChild(track);
      card.appendChild(line);
      this.bars[key] = fill;
    }
    r.appendChild(card);

    // --- play
    const play = el('button', 'play', t('menu.play'));
    play.addEventListener('click', () => {
      sfx.ui();
      this.onPlay();
    });
    r.appendChild(play);

    // --- secondary buttons
    const row = el('div', 'row-btns');
    const buttons: [string, string, () => void][] = [
      ['🔧', 'menu.garage', openGarage],
      ['🛒', 'menu.shop', openShop],
      ['🎁', 'menu.daily', openDaily],
      ['🏆', 'menu.top', openLeaderboard],
    ];
    for (const [icon, label, open] of buttons) {
      const b = el('button', 'menu-btn');
      b.appendChild(el('span', 'ico', icon));
      b.appendChild(el('span', undefined, t(label)));
      b.addEventListener('click', () => {
        sfx.ui();
        open();
      });
      row.appendChild(b);
      if (label === 'menu.daily') this.dailyBtn = b;
    }
    r.appendChild(row);
  }

  update(): void {
    const s = S();
    const coins = Math.floor(s.coins);
    this.coinsEl.textContent = fmt(coins);
    if (this.lastCoins >= 0 && coins > this.lastCoins) {
      const chip = this.coinsEl.parentElement!;
      chip.classList.remove('pop');
      void chip.offsetWidth;
      chip.classList.add('pop');
    }
    this.lastCoins = coins;

    this.lvlEl.textContent = `Lv. ${s.level}`;
    const xp = xpProgress();
    this.xpText.textContent = `${fmt(xp.have)}/${fmt(xp.need)}`;
    this.xpFill.style.width = `${xp.pct * 100}%`;

    this.carNameEl.textContent = carName(s.currentCar);
    this.bestEl.textContent = s.stats.bestScore
      ? `${t('menu.best')}: ${fmt(s.stats.bestScore)}`
      : '';

    const bars = statBars(s.currentCar);
    this.bars.speed.style.width = `${bars.speed * 100}%`;
    this.bars.accel.style.width = `${bars.accel * 100}%`;
    this.bars.grip.style.width = `${bars.grip * 100}%`;

    this.dailyBtn?.classList.toggle('hot', refreshDaily().canClaim);
  }

  show(): void {
    this.root.hidden = false;
    this.update();
  }

  hide(): void {
    this.root.hidden = true;
  }
}
