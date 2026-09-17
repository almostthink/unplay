import {
  AD_REWARDS,
  CARS,
  DAILY_REWARDS,
  GAME_VERSION,
  LEADERBOARD_NAME,
  PAINTS,
  PAINT_PRICE,
  PRODUCTS,
  PRODUCT_COINS,
  UPGRADES,
  UPGRADE_MAX,
} from '../config';
import { S, store } from '../state';
import { addCoins } from '../economy';
import {
  applyPaint,
  buyCar,
  buyPaint,
  buyUpgrade,
  carName,
  costOf,
  selectCar,
} from '../garage';
import { claimDaily, refreshDaily } from '../daily';
import { adCoinsLeft, rewardedAd, setBanner } from '../ads';
import { resetGame, saveGame } from '../storage';
import { ya } from '../../platform/yandex';
import { burst, floater, toast } from '../../platform/fx';
import { el, esc, fmt, vibrate } from '../../platform/util';
import { LANG_LABELS, getLang, setLang, t, type Lang } from '../../platform/i18n';
import { sfx } from '../audio';
import { button, closeButton, openSheet, pill, row } from './sheet';
import type { RaceResult } from '../race';

/** Set by main.ts so a language change can rebuild every screen. */
let languageChanged: () => void = () => {};
export function setLanguageChangeHandler(fn: () => void): void {
  languageChanged = fn;
}

/** Set by main.ts so the results sheet can restart or revive a run. */
export interface ResultActions {
  again: () => void;
  revive: () => void;
  menu: () => void;
  canRevive: () => boolean;
}
let resultActions: ResultActions | null = null;
export function setResultActions(a: ResultActions): void {
  resultActions = a;
}

// ----------------------------------------------------------------- garage

export function openGarage(): void {
  openSheet(
    (close, body) => {
      const rebuild = () => {
        body.textContent = '';
        buildGarage(body, rebuild);
        body.appendChild(closeButton(close));
      };
      rebuild();
    },
    { title: `🔧 ${t('garage.title')}`, subtitle: t('garage.sub') },
  );
}

function buildGarage(body: HTMLElement, rebuild: () => void): void {
  const s = S();

  // --- car picker
  const cars = el('div', 'cars');
  for (const def of CARS) {
    const save = s.cars[def.id];
    const tile = el('button', `car-tile ${s.currentCar === def.id ? 'sel' : ''}`.trim());
    const swatch = el('div', 'swatch');
    swatch.style.background = `#${(save.owned ? save.paint : def.color).toString(16).padStart(6, '0')}`;
    if (!save.owned) swatch.style.filter = 'grayscale(1) brightness(.5)';
    tile.appendChild(swatch);
    tile.appendChild(el('div', 'n', carName(def.id)));
    tile.appendChild(
      el('div', 'p', save.owned ? t('garage.select') : `🪙 ${fmt(def.price)}`),
    );
    tile.addEventListener('click', () => {
      sfx.ui();
      if (save.owned) selectCar(def.id);
      else if (buyCar(def.id)) {
        sfx.reward();
        toast(carName(def.id), 'good');
      } else {
        sfx.error();
        return;
      }
      saveGame(true);
      rebuild();
    });
    cars.appendChild(tile);
  }
  body.appendChild(cars);

  // --- paints
  body.appendChild(el('div', 'sub', t('garage.paint')));
  const paints = el('div', 'paints');
  const current = s.cars[s.currentCar];
  for (const color of PAINTS) {
    const owned = s.ownedPaints.includes(color);
    const swatch = el(
      'button',
      `paint ${current.paint === color ? 'sel' : ''} ${owned ? '' : 'locked'}`.trim(),
    );
    swatch.style.background = `#${color.toString(16).padStart(6, '0')}`;
    swatch.title = owned ? '' : `${PAINT_PRICE}`;
    swatch.addEventListener('click', () => {
      sfx.ui();
      if (owned) applyPaint(color);
      else if (buyPaint(color)) {
        applyPaint(color);
        sfx.reward();
      } else {
        sfx.error();
        return;
      }
      saveGame(true);
      rebuild();
    });
    paints.appendChild(swatch);
  }
  body.appendChild(paints);

  // --- upgrades for the selected car
  body.appendChild(el('div', 'sub', t('garage.upgrades')));
  for (const up of UPGRADES) {
    const level = current.upgrades[up.id];
    const cost = costOf(s.currentCar, up.id);
    body.appendChild(
      row(
        up.icon,
        t(`upg.${up.id}`),
        t('upg.level', { n: level, max: UPGRADE_MAX }),
        cost === null
          ? pill(t('upg.max'), 'off')
          : pill(`🪙 ${fmt(cost)}`, s.coins >= cost ? 'buy' : 'off', () => {
              if (!buyUpgrade(s.currentCar, up.id)) {
                sfx.error();
                return;
              }
              sfx.reward();
              saveGame(true);
              rebuild();
            }),
      ),
    );
  }
}

// ------------------------------------------------------------------- shop

export function openShop(): void {
  openSheet(
    (close, body) => {
      const rebuild = () => {
        body.textContent = '';
        buildShop(body, rebuild, close);
      };
      rebuild();
    },
    { title: `🛒 ${t('shop.title')}`, subtitle: t('shop.sub') },
  );
}

function buildShop(body: HTMLElement, rebuild: () => void, close: () => void): void {
  const s = S();

  const left = adCoinsLeft();
  const amount = Math.round(AD_REWARDS.coinsBase * Math.pow(1.3, s.level - 1));
  body.appendChild(
    row(
      '🪙',
      `${t('shop.freeCoins')} +${fmt(amount)}`,
      left > 0 ? `${left}/${AD_REWARDS.coinsDailyLimit}` : t('shop.limit'),
      left > 0
        ? pill(`📺 ${t('shop.watch')}`, 'ad', async () => {
            if (!(await rewardedAd())) return;
            s.adCoinsUsed += 1;
            addCoins(amount);
            sfx.reward();
            celebrate();
            toast(`+${fmt(amount)} 🪙`, 'good');
            saveGame(true);
            rebuild();
          })
        : pill(t('shop.limit'), 'off'),
    ),
  );

  if (ya.paymentsAvailable) {
    const packs: [string, string][] = [
      [PRODUCTS.coinsSmall, '💰'],
      [PRODUCTS.coinsMedium, '💎'],
      [PRODUCTS.coinsLarge, '🏆'],
      [PRODUCTS.starter, '🎁'],
    ];
    for (const [id, icon] of packs) {
      const coins = PRODUCT_COINS[id];
      body.appendChild(
        row(
          icon,
          id === PRODUCTS.starter ? t('shop.starter') : `${fmt(coins)} 🪙`,
          '',
          pill('💳', 'buy', () => void runPurchase(id, close)),
        ),
      );
    }
    body.appendChild(
      s.noAds
        ? row('🚫', t('shop.noAds'), t('shop.noAdsOwned'), pill('✓', 'off'))
        : row(
            '🚫',
            t('shop.noAds'),
            t('shop.noAdsDesc'),
            pill('💳', 'buy', () => void runPurchase(PRODUCTS.noAds, close)),
          ),
    );
  } else {
    body.appendChild(el('div', 'empty', t('shop.unavailable')));
  }

  body.appendChild(closeButton(close));
}

async function runPurchase(id: string, close: () => void): Promise<void> {
  if (!(await ya.purchase(id))) {
    toast(t('shop.failed'), 'bad');
    return;
  }
  grantProduct(id);
  sfx.reward();
  celebrate();
  toast(t('shop.purchased'), 'good');
  saveGame(true);
  close();
}

/** Applies a purchased product. Safe to call more than once. */
export function grantProduct(id: string): void {
  if (id === PRODUCTS.noAds) {
    S().noAds = true;
    void setBanner(true);
    store.emit('settings');
    return;
  }
  const coins = PRODUCT_COINS[id];
  if (coins) addCoins(coins);
}

// ------------------------------------------------------------ daily chest

export function openDaily(): void {
  openSheet(
    (close, body) => {
      const rebuild = () => {
        body.textContent = '';
        buildDaily(body, rebuild, close);
      };
      rebuild();
    },
    { title: `🎁 ${t('daily.title')}`, subtitle: t('daily.sub') },
  );
}

function buildDaily(body: HTMLElement, rebuild: () => void, close: () => void): void {
  const state = refreshDaily();

  const grid = el('div', 'grid7');
  DAILY_REWARDS.forEach((amount, i) => {
    const claimed = i < state.day || (!state.canClaim && i === state.day);
    const cls = ['day', claimed ? 'claimed' : '', i === state.day && state.canClaim ? 'today' : '']
      .filter(Boolean)
      .join(' ');
    const cell = el('div', cls);
    cell.appendChild(el('small', undefined, String(i + 1)));
    cell.appendChild(el('span', undefined, i === DAILY_REWARDS.length - 1 ? '🏆' : '🪙'));
    cell.title = fmt(amount);
    grid.appendChild(cell);
  });
  body.appendChild(grid);
  body.appendChild(el('p', 'sub', t('daily.streak', { n: state.streak })));

  if (!state.canClaim) {
    body.appendChild(el('div', 'empty', t('daily.claimed')));
    body.appendChild(closeButton(close));
    return;
  }

  body.appendChild(el('p', 'sub', `🪙 ${fmt(DAILY_REWARDS[state.day])}`));
  body.appendChild(
    button(t('daily.claim'), 'primary', () => {
      const got = claimDaily(1);
      if (got) {
        sfx.reward();
        celebrate();
        saveGame(true);
      }
      rebuild();
    }),
  );
  body.appendChild(
    button(`📺 ${t('daily.claimX2')}`, 'ad', async () => {
      const ok = await rewardedAd();
      const got = claimDaily(ok ? 2 : 1);
      if (got) {
        sfx.reward();
        celebrate();
        saveGame(true);
      }
      rebuild();
    }),
  );
}

// ------------------------------------------------------------ leaderboard

export function openLeaderboard(): void {
  openSheet(
    (close, body) => {
      body.appendChild(el('div', 'empty', t('lb.loading')));
      void (async () => {
        const entries = await ya.getLeaderboard(LEADERBOARD_NAME, 10, 3);
        body.textContent = '';
        if (!ya.leaderboardsAvailable) {
          body.appendChild(el('div', 'empty', t('lb.unavailable')));
        } else if (!entries.length) {
          body.appendChild(el('div', 'empty', t('lb.login')));
        } else {
          for (const e of entries) {
            const r = el('div', `lb-row ${e.isMe ? 'me' : ''}`.trim());
            r.appendChild(el('div', `lb-rank ${e.rank <= 3 ? 'top' : ''}`.trim(), medal(e.rank)));
            if (e.photo) {
              const img = el('img', 'lb-av') as HTMLImageElement;
              img.src = e.photo;
              img.alt = '';
              r.appendChild(img);
            } else {
              r.appendChild(el('div', 'lb-av'));
            }
            r.appendChild(el('div', 'lb-name', esc(e.name || t('lb.you'))));
            r.appendChild(el('div', 'lb-score', fmt(e.score)));
            body.appendChild(r);
          }
        }
        body.appendChild(closeButton(close));
      })();
    },
    { title: `🏆 ${t('lb.title')}`, subtitle: t('lb.sub') },
  );
}

function medal(rank: number): string {
  return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : String(rank);
}

// --------------------------------------------------------------- settings

/** Raised when the quality setting changes so the renderer can rebuild. */
let qualityChanged: (q: 'high' | 'medium' | 'low') => void = () => {};
export function setQualityHandler(fn: (q: 'high' | 'medium' | 'low') => void): void {
  qualityChanged = fn;
}

export function openSettings(): void {
  openSheet(
    (close, body) => {
      const rebuild = () => {
        body.textContent = '';
        buildSettings(body, rebuild, close);
      };
      rebuild();
    },
    { title: `⚙️ ${t('settings.title')}` },
  );
}

function buildSettings(body: HTMLElement, rebuild: () => void, close: () => void): void {
  const s = S();

  const toggle = (icon: string, label: string, value: boolean, set: (v: boolean) => void) =>
    row(
      icon,
      label,
      value ? t('common.on') : t('common.off'),
      pill(value ? '✓' : '✕', value ? 'on' : '', () => {
        set(!value);
        saveGame(true);
        rebuild();
      }),
    );

  body.appendChild(
    toggle('🔊', t('settings.sound'), s.settings.sound, (v) => {
      s.settings.sound = v;
      sfx.setSound(v);
    }),
  );
  body.appendChild(
    toggle('🎵', t('settings.music'), s.settings.music, (v) => {
      s.settings.music = v;
      sfx.setMusic(v);
    }),
  );
  body.appendChild(
    toggle('📳', t('settings.vibro'), s.settings.vibro, (v) => {
      s.settings.vibro = v;
      if (v) vibrate(20);
    }),
  );
  if (!s.noAds && ya.available) {
    body.appendChild(
      toggle('📰', t('settings.banner'), s.settings.banner, (v) => {
        s.settings.banner = v;
        void setBanner(true);
      }),
    );
  }

  // Graphics quality
  const qRow = el('div', 'row');
  qRow.appendChild(el('div', 'ico', '🎚️'));
  const qBody = el('div', 'body');
  qBody.appendChild(el('div', 'name', t('settings.quality')));
  const qChips = el('div', 'chips2');
  qChips.style.marginBottom = '0';
  for (const q of ['high', 'medium', 'low'] as const) {
    const chip = el('button', `chip2 ${s.settings.quality === q ? 'on' : ''}`.trim(), t(`quality.${q}`));
    chip.addEventListener('click', () => {
      sfx.ui();
      s.settings.quality = q;
      qualityChanged(q);
      saveGame(true);
      rebuild();
    });
    qChips.appendChild(chip);
  }
  qBody.appendChild(qChips);
  qRow.appendChild(qBody);
  body.appendChild(qRow);

  // Language
  const lRow = el('div', 'row');
  lRow.appendChild(el('div', 'ico', '🌐'));
  const lBody = el('div', 'body');
  lBody.appendChild(el('div', 'name', t('settings.lang')));
  const lChips = el('div', 'chips2');
  lChips.style.marginBottom = '0';
  for (const code of Object.keys(LANG_LABELS) as Lang[]) {
    const chip = el('button', `chip2 ${getLang() === code ? 'on' : ''}`.trim(), LANG_LABELS[code]);
    chip.addEventListener('click', () => {
      s.settings.lang = code;
      setLang(code);
      saveGame(true);
      close();
      languageChanged();
    });
    lChips.appendChild(chip);
  }
  lBody.appendChild(lChips);
  lRow.appendChild(lBody);
  body.appendChild(lRow);

  // Platform extras, only offered when the SDK says they are possible.
  void (async () => {
    if (await ya.canReview()) {
      body.insertBefore(
        row('⭐', t('settings.rate'), '', pill('→', 'buy', () => void ya.requestReview())),
        body.lastElementChild,
      );
    }
    if (await ya.canAddShortcut()) {
      body.insertBefore(
        row('📌', t('settings.shortcut'), '', pill('→', 'buy', () => void ya.addShortcut())),
        body.lastElementChild,
      );
    }
  })();

  body.appendChild(el('p', 'sub', t('settings.version', { v: GAME_VERSION })));
  body.appendChild(
    button(t('settings.reset'), 'ghost', () => {
      openSheet(
        (close2, b2) => {
          b2.appendChild(el('p', 'sub', t('settings.resetConfirm')));
          b2.appendChild(
            button(t('settings.resetYes'), 'primary', () => {
              resetGame();
              void ya.saveData('__reset__', Date.now(), true);
              location.reload();
            }),
          );
          b2.appendChild(button(t('common.cancel'), 'ghost', close2));
        },
        { title: t('settings.reset') },
      );
    }),
  );
  body.appendChild(closeButton(close));
}

// ---------------------------------------------------------------- results

export function openResults(result: RaceResult, coinsGranted: number): void {
  if (result.newBest) {
    sfx.reward();
    celebrate();
  }
  let doubled = false;

  openSheet(
    (close, body) => {
      if (result.newBest) body.appendChild(el('div', 'newbest', t('result.newBest')));

      const line = (label: string, value: string, big = false) => {
        const node = el('div', `result-line ${big ? 'big' : ''}`.trim());
        node.appendChild(el('span', undefined, label));
        node.appendChild(el('b', undefined, value));
        return node;
      };
      body.appendChild(line(t('result.score'), fmt(result.score), true));
      body.appendChild(line(t('result.distance'), `${fmt(result.distance)} ${t('common.m')}`));
      body.appendChild(line(t('result.drift'), `x${result.bestMult.toFixed(1)}`));
      const coinsLine = line(t('result.coins'), `🪙 ${fmt(coinsGranted)}`);
      body.appendChild(coinsLine);

      const actions = resultActions;

      if (actions?.canRevive()) {
        body.appendChild(
          button(`📺 ${t('result.revive')}`, 'ad', async () => {
            if (!(await rewardedAd())) return;
            close();
            actions.revive();
          }),
        );
      }

      const x2 = button(`📺 ${t('result.x2')}`, 'ad', async () => {
        if (doubled) return;
        if (!(await rewardedAd())) return;
        doubled = true;
        addCoins(coinsGranted);
        sfx.reward();
        celebrate();
        coinsLine.querySelector('b')!.textContent = `🪙 ${fmt(coinsGranted * 2)}`;
        x2.remove();
        saveGame(true);
      });
      body.appendChild(x2);

      body.appendChild(
        button(t('result.again'), 'primary', () => {
          close();
          actions?.again();
        }),
      );
      body.appendChild(
        button(t('result.garage'), 'ghost', () => {
          close();
          actions?.menu();
        }),
      );
    },
    { title: t('result.title'), dismissable: false },
  );
}

// --------------------------------------------------------------- level up

export function openLevelUp(level: number, coins: number): void {
  sfx.levelUp();
  celebrate();
  openSheet(
    (close, body) => {
      body.appendChild(el('p', 'sub', `${t('levelup.reward')}: 🪙 ${fmt(coins)}`));
      body.appendChild(button(t('common.ok'), 'primary', close));
    },
    { title: `🎉 ${t('levelup.title', { n: level })}` },
  );
}

// --------------------------------------------------------------- tutorial

export function openTutorial(touch: boolean, onDone: () => void): void {
  openSheet(
    (close, body) => {
      const lines: [string, string][] = [
        ['👈', touch ? t('tutor.steer') : t('tutor.steerPc')],
        ['💨', t('tutor.drift')],
        ['🔥', touch ? t('tutor.nitro') : t('tutor.nitroPc')],
        ['⏱️', t('tutor.time')],
      ];
      for (const [icon, text] of lines) {
        body.appendChild(row(icon, text, '', el('span')));
      }
      body.appendChild(
        button(t('tutor.go'), 'primary', () => {
          close();
          onDone();
        }),
      );
    },
    { title: `🏁 ${t('tutor.title')}`, dismissable: false },
  );
}

// -------------------------------------------------------------- confetti

export function celebrate(): void {
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const colors = ['#ffc247', '#45e6ff', '#4ee79a', '#ff8fd6'];
  colors.forEach((c, i) => window.setTimeout(() => burst(cx, cy, c, 14), i * 70));
  floater(cx, cy - 60, '✨', '#ffc247');
}
