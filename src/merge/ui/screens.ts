import { S, store } from '../state';
import {
  AD_REWARDS,
  DAILY_REWARDS,
  GAME_VERSION,
  GEN_MAX_LEVEL,
  LEADERBOARD_NAME,
  PRODUCTS,
  PRODUCT_GEMS,
  REFILL_GEM_COST,
  genCapacity,
  genMaxTier,
  genRefillMs,
  genUpgradeCost,
} from '../config';
import { CHAINS, chain, genName, itemEmoji, itemName, sellValue } from '../items';
import { addCoins, addGems, spendCoins, spendGems, type LevelUpInfo } from '../economy';
import {
  expandBoard,
  nextRowCost,
  refillAllGenerators,
  sellAt,
} from '../board';
import { claimQuest, questDone } from '../quests';
import { claimDaily, refreshDaily } from '../daily';
import { collectOffline, type OfflineReport } from '../offline';
import { adUsesLeft, consumeAdUse, rewardedAd, syncBanner } from '../ads';
import { button, closeButton, openModal, pill, row } from './modal';
import { el, esc, fmt, fmtTime, vibrate } from '../../platform/util';
import { burst, floater, toast } from '../../platform/fx';
import { sfx } from '../audio';
import { LANG_LABELS, getLang, setLang, t, type Lang } from '../../platform/i18n';
import { ya } from '../../platform/yandex';
import { resetGame, saveGame } from '../storage';

/** Set by main.ts so screens can trigger a full UI rebuild after a relaunch. */
export let onLanguageChange: () => void = () => {};
export function setLanguageChangeHandler(fn: () => void): void {
  onLanguageChange = fn;
}

// ------------------------------------------------------------------- shop

export function openShop(): void {
  openModal(
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

  // --- free rewarded offers
  const gemsLeft = adUsesLeft('gems');
  body.appendChild(
    row(
      '💠',
      `${t('shop.gems')} +${AD_REWARDS.gems}`,
      gemsLeft > 0 ? `${t('shop.free')} · ${gemsLeft}/${AD_REWARDS.gemsDailyLimit}` : t('shop.dailyLimit'),
      gemsLeft > 0
        ? pill(`📺 ${t('shop.watchAd')}`, 'ad', async () => {
            if (await rewardedAd()) {
              consumeAdUse('gems');
              addGems(AD_REWARDS.gems);
              sfx.reward();
              toast(`+${AD_REWARDS.gems} 💠`, 'good');
              saveGame(true);
              rebuild();
            }
          })
        : pill(t('shop.dailyLimit'), 'off'),
    ),
  );

  const coinsLeft = adUsesLeft('coins');
  const adCoins = Math.round(AD_REWARDS.coinsBase * Math.pow(1.35, s.level - 1));
  body.appendChild(
    row(
      '🪙',
      `${t('res.coins')} +${fmt(adCoins)}`,
      coinsLeft > 0 ? `${t('shop.free')} · ${coinsLeft}/${AD_REWARDS.coinsDailyLimit}` : t('shop.dailyLimit'),
      coinsLeft > 0
        ? pill(`📺 ${t('shop.watchAd')}`, 'ad', async () => {
            if (await rewardedAd()) {
              consumeAdUse('coins');
              addCoins(adCoins);
              sfx.coin();
              toast(`+${fmt(adCoins)} 🪙`, 'good');
              saveGame(true);
              rebuild();
            }
          })
        : pill(t('shop.dailyLimit'), 'off'),
    ),
  );

  // --- generator refill
  const refillActions = el('div');
  refillActions.style.cssText = 'display:flex;gap:6px;';
  refillActions.appendChild(
    pill(`📺`, 'ad', async () => {
      if (await rewardedAd()) {
        refillAllGenerators();
        sfx.reward();
        toast(t('shop.energyPack'), 'good');
        saveGame(true);
        rebuild();
      }
    }),
  );
  refillActions.appendChild(
    pill(`💠 ${REFILL_GEM_COST}`, s.gems >= REFILL_GEM_COST ? 'buy' : 'off', () => {
      if (!spendGems(REFILL_GEM_COST)) return toast(t('common.notEnough'), 'bad');
      refillAllGenerators();
      sfx.reward();
      saveGame(true);
      rebuild();
    }),
  );
  body.appendChild(row('⚡', t('shop.energyPack'), t('shop.energyPackDesc'), refillActions));

  // --- board expansion
  const rowCost = nextRowCost();
  body.appendChild(
    row(
      '🧩',
      t('shop.expand'),
      rowCost === null ? t('shop.expandMax') : t('shop.expandDesc'),
      rowCost === null
        ? pill(t('upg.max'), 'off')
        : pill(`🪙 ${fmt(rowCost)}`, s.coins >= rowCost ? 'buy' : 'off', () => {
            if (!expandBoard()) return toast(t('common.notEnough'), 'bad');
            sfx.reward();
            toast(t('shop.expand'), 'good');
            saveGame(true);
            rebuild();
          }),
    ),
  );

  // --- real-money products
  if (ya.paymentsAvailable) {
    const gemPacks: [string, string, number][] = [
      [PRODUCTS.gemsSmall, '💠', PRODUCT_GEMS[PRODUCTS.gemsSmall]],
      [PRODUCTS.gemsMedium, '💎', PRODUCT_GEMS[PRODUCTS.gemsMedium]],
      [PRODUCTS.gemsLarge, '🔷', PRODUCT_GEMS[PRODUCTS.gemsLarge]],
    ];
    for (const [id, icon, amount] of gemPacks) {
      body.appendChild(
        row(
          icon,
          `${amount} ${t('shop.gems')}`,
          t('shop.sub'),
          pill('💳', 'buy', () => runPurchase(id, close)),
        ),
      );
    }
    if (!s.noAds) {
      body.appendChild(
        row('🚫', t('shop.noAds'), t('shop.noAdsDesc'), pill('💳', 'buy', () => runPurchase(PRODUCTS.noAds, close))),
      );
    } else {
      body.appendChild(row('🚫', t('shop.noAds'), t('shop.noAdsOwned'), pill('✓', 'off')));
    }
  } else {
    body.appendChild(el('div', 'empty', t('shop.unavailable')));
  }

  body.appendChild(closeButton(close));
}

async function runPurchase(id: string, close: () => void): Promise<void> {
  const ok = await ya.purchase(id);
  if (!ok) {
    toast(t('shop.purchaseFailed'), 'bad');
    return;
  }
  grantProduct(id);
  sfx.reward();
  toast(t('shop.purchased'), 'good');
  saveGame(true);
  close();
}

/** Applies the effect of a purchased product. Safe to call more than once. */
export function grantProduct(id: string): void {
  const s = S();
  if (id === PRODUCTS.noAds) {
    s.noAds = true;
    void syncBanner();
    store.emit('settings');
    return;
  }
  const gems = PRODUCT_GEMS[id];
  if (gems) addGems(gems);
  if (id === PRODUCTS.starter) {
    addCoins(2500);
    refillAllGenerators();
  }
}

// -------------------------------------------------------------- upgrades

export function openUpgrades(): void {
  openModal(
    (close, body) => {
      const rebuild = () => {
        body.textContent = '';
        buildUpgrades(body, rebuild);
        body.appendChild(closeButton(close));
      };
      rebuild();
    },
    { title: `🔧 ${t('upg.title')}`, subtitle: t('upg.sub') },
  );
}

function buildUpgrades(body: HTMLElement, rebuild: () => void): void {
  const s = S();
  for (const def of CHAINS) {
    const g = s.gens[def.id];

    if (!g.unlocked) {
      body.appendChild(
        row(def.gen, genName(def.id), t('upg.unlockAt', { lvl: def.unlockLevel }), pill('🔒', 'off')),
      );
      continue;
    }

    const maxed = g.level >= GEN_MAX_LEVEL;
    const cost = genUpgradeCost(def.upgradeBase, g.level);
    const desc = [
      t('upg.capacity', { n: genCapacity(g.level) }),
      t('upg.speed', { t: fmtTime(genRefillMs(g.level)) }),
      t('upg.quality', { n: genMaxTier(g.level) }),
    ].join(' · ');

    body.appendChild(
      row(
        def.gen,
        `${genName(def.id)} · ${t('upg.level', { n: g.level })}`,
        desc,
        maxed
          ? pill(t('upg.max'), 'off')
          : pill(`🪙 ${fmt(cost)}`, s.coins >= cost ? 'buy' : 'off', () => {
              if (!spendCoins(cost)) return toast(t('common.notEnough'), 'bad');
              g.level += 1;
              g.charges = genCapacity(g.level);
              g.lastTick = Date.now();
              store.emit('gens');
              sfx.reward();
              saveGame(true);
              rebuild();
            }),
      ),
    );
  }
}

// ---------------------------------------------------------------- quests

export function openQuests(): void {
  openModal(
    (close, body) => {
      const rebuild = () => {
        body.textContent = '';
        buildQuests(body, rebuild);
        body.appendChild(closeButton(close));
      };
      rebuild();
    },
    { title: `📋 ${t('quest.title')}`, subtitle: t('quest.sub') },
  );
}

function buildQuests(body: HTMLElement, rebuild: () => void): void {
  const s = S();
  if (!s.quests.length) {
    body.appendChild(el('div', 'empty', t('quest.allDone')));
    return;
  }

  s.quests.forEach((q, i) => {
    const done = questDone(q);
    const label = t(`quest.${q.kind}`, { n: fmt(q.goal) });
    const reward = [q.coins ? `🪙 ${fmt(q.coins)}` : '', q.gems ? `💠 ${q.gems}` : '']
      .filter(Boolean)
      .join('  ');
    const progress = `${fmt(Math.min(q.progress, q.goal))} / ${fmt(q.goal)} · ${reward}`;

    const action = q.claimed
      ? pill(`✓ ${t('quest.done')}`, 'off')
      : done
        ? pill(t('quest.claim'), 'buy', () => {
            const got = claimQuest(i);
            if (got) {
              sfx.reward();
              toast(`+${fmt(got.coins)} 🪙`, 'good');
              saveGame(true);
              rebuild();
            }
          })
        : pill(`${Math.round((q.progress / q.goal) * 100)}%`, 'off');

    body.appendChild(row(done ? '✅' : '🎯', label, progress, action));
  });
}

// ----------------------------------------------------------- daily reward

export function openDaily(): void {
  openModal(
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
  DAILY_REWARDS.forEach((r, i) => {
    const claimed = i < state.day || (!state.canClaim && i === state.day);
    const cls = ['day', claimed ? 'claimed' : '', i === state.day && state.canClaim ? 'today' : '']
      .filter(Boolean)
      .join(' ');
    const cellNode = el('div', cls);
    cellNode.appendChild(el('small', undefined, String(i + 1)));
    cellNode.appendChild(el('span', undefined, r.gems > 0 ? '💠' : r.item ? '🎁' : '🪙'));
    grid.appendChild(cellNode);
  });
  body.appendChild(grid);

  body.appendChild(el('p', 'sub', t('daily.streak', { n: state.streak })));

  if (!state.canClaim) {
    body.appendChild(el('div', 'empty', t('daily.claimed')));
    body.appendChild(closeButton(close));
    return;
  }

  const reward = DAILY_REWARDS[state.day];
  const summary = [
    reward.coins ? `🪙 ${fmt(reward.coins)}` : '',
    reward.gems ? `💠 ${reward.gems}` : '',
    reward.item ? itemEmoji(reward.item.chain, reward.item.tier) : '',
  ]
    .filter(Boolean)
    .join('   ');
  body.appendChild(el('p', 'sub', summary));

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
      if (await rewardedAd()) {
        const got = claimDaily(2);
        if (got) {
          sfx.reward();
          celebrate();
          saveGame(true);
        }
      }
      rebuild();
    }),
  );
}

// ------------------------------------------------------------ leaderboard

export function openLeaderboard(): void {
  openModal(
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
              const img = el('img', 'lb-av');
              (img as HTMLImageElement).src = e.photo;
              (img as HTMLImageElement).alt = '';
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

export function openSettings(): void {
  openModal(
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

  const toggle = (
    icon: string,
    label: string,
    value: boolean,
    set: (v: boolean) => void,
  ): HTMLElement =>
    row(
      icon,
      label,
      value ? t('common.on') : t('common.off'),
      pill(value ? '✓' : '✕', value ? 'buy' : '', () => {
        set(!value);
        store.emit('settings');
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
        void syncBanner();
      }),
    );
  }

  // Language
  const langRow = el('div', 'row');
  langRow.appendChild(el('div', 'ico', '🌐'));
  const langBody = el('div', 'body');
  langBody.appendChild(el('div', 'name', t('settings.lang')));
  const chips = el('div', 'chips');
  chips.style.marginBottom = '0';
  (Object.keys(LANG_LABELS) as Lang[]).forEach((code) => {
    const chip = el('button', `chip ${getLang() === code ? 'on' : ''}`.trim(), LANG_LABELS[code]);
    chip.addEventListener('click', () => {
      s.settings.lang = code;
      setLang(code);
      saveGame(true);
      close();
      onLanguageChange();
    });
    chips.appendChild(chip);
  });
  langBody.appendChild(chips);
  langRow.appendChild(langBody);
  body.appendChild(langRow);

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
      openModal(
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

// ------------------------------------------------------------- level up

export function openLevelUp(info: LevelUpInfo): void {
  sfx.levelUp();
  celebrate();
  openModal(
    (close, body) => {
      const lines = [
        `🪙 ${fmt(info.coins)}`,
        info.gems ? `💠 ${info.gems}` : '',
      ]
        .filter(Boolean)
        .join('   ');
      body.appendChild(el('p', 'sub', `${t('levelup.reward')}: ${lines}`));
      for (const id of info.unlocked) {
        body.appendChild(
          row(chain(id).gen, t('levelup.unlocked', { name: genName(id) }), '', pill('✨', 'off')),
        );
      }
      body.appendChild(button(t('levelup.ok'), 'primary', close));
    },
    { title: `🎉 ${t('levelup.title', { n: info.level })}`, subtitle: t('levelup.sub') },
  );
}

// -------------------------------------------------------- offline report

export function openOffline(report: OfflineReport): void {
  openModal(
    (close, body) => {
      const lines = el('div');
      if (report.coins > 0) lines.appendChild(row('🪙', fmt(report.coins), '', pill('', 'off')));
      if (report.charges > 0) {
        lines.appendChild(row('⚡', `+${report.charges}`, t('offline.charges'), pill('', 'off')));
      }
      body.appendChild(lines);

      body.appendChild(
        button(t('offline.collect'), 'primary', () => {
          collectOffline(report, 1);
          sfx.coin();
          saveGame(true);
          close();
        }),
      );
      if (report.coins > 0) {
        body.appendChild(
          button(`📺 ${t('offline.collectX2')}`, 'ad', async () => {
            const ok = await rewardedAd();
            collectOffline(report, ok ? 2 : 1);
            sfx.reward();
            if (ok) celebrate();
            saveGame(true);
            close();
          }),
        );
      }
    },
    {
      title: `👋 ${t('offline.title')}`,
      subtitle: t('offline.sub', { t: fmtTime(report.ms) }),
      dismissable: false,
    },
  );
}

// ------------------------------------------------------------- item info

export function openItemInfo(index: number, onSold: () => void): void {
  const cellData = S().board[index];
  if (!cellData) return;
  const value = sellValue(cellData.tier);

  openModal(
    (close, body) => {
      const big = el('div', undefined, itemEmoji(cellData.chain, cellData.tier));
      big.style.cssText = 'font-size:64px;text-align:center;margin:4px 0 10px;';
      body.appendChild(big);
      body.appendChild(
        button(`🪙 ${fmt(value)}`, 'primary', () => {
          const got = sellAt(index);
          if (got > 0) {
            sfx.coin();
            toast(`+${fmt(got)} 🪙`, 'good');
            onSold();
            saveGame();
          }
          close();
        }),
      );
      body.appendChild(closeButton(close));
    },
    {
      title: itemName(cellData.chain, cellData.tier),
      subtitle: `${t('upg.level', { n: cellData.tier })}`,
    },
  );
}

// ----------------------------------------------------------------- confetti

export function celebrate(): void {
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const colors = ['#ffd76a', '#ff8fd6', '#7ee8ff', '#6ee7a8'];
  colors.forEach((c, i) => window.setTimeout(() => burst(cx, cy, c, 14), i * 70));
  floater(cx, cy - 60, '✨', '#ffd76a');
}
