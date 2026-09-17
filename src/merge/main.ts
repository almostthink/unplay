import './styles.css';

import { ya } from '../platform/yandex';
import { registerStrings, setLang, t } from '../platform/i18n';
import { MERGE_STRINGS } from './strings';
import { loadGame, installSaveHooks, saveGame } from './storage';
import { sfx } from './audio';
import { burst, floater, toast } from '../platform/fx';
import { el, fmt, vibrate } from '../platform/util';
import { S, store } from './state';
import { LEADERBOARD_NAME, PRODUCTS, TUTORIAL_STEPS } from './config';
import { chain } from './items';
import { onLevelUp } from './economy';
import { tickGenerators, freeCells, spawnFrom } from './board';
import { deliverOrder, ensureOrders, rerollOrder } from './orders';
import { refreshQuests } from './quests';
import { refreshDaily } from './daily';
import { computeOffline } from './offline';
import {
  installAdHooks,
  maybeInterstitial,
  rewardedAd,
  rolloverAdDay,
  syncBanner,
} from './ads';
import { BoardView } from './boardview';
import { mountHud, updateHud } from './ui/hud';
import { mountOrdersBar, renderOrdersBar } from './ui/ordersbar';
import { mountDock, refreshDock } from './ui/dock';
import { closeTop } from './ui/modal';
import {
  grantProduct,
  openItemInfo,
  openLevelUp,
  openOffline,
  setLanguageChangeHandler,
} from './ui/screens';

const SAVE_INTERVAL_MS = 15_000;
const SCORE_INTERVAL_MS = 60_000;
const DAY_CHECK_INTERVAL_MS = 30_000;

let view: BoardView;
let lastSave = 0;
let lastScore = 0;
let lastScoreValue = -1;
let lastDayCheck = 0;

// ---------------------------------------------------------------- boot

function bootProgress(pct: number, hint: string): void {
  const fill = document.getElementById('boot-fill');
  const label = document.getElementById('boot-hint');
  if (fill) fill.style.width = `${pct}%`;
  if (label) label.textContent = hint;
}

async function boot(): Promise<void> {
  registerStrings(MERGE_STRINGS);
  bootProgress(15, t('boot.sdk'));
  await ya.init();

  // The platform language wins until the player picks one explicitly.
  bootProgress(45, t('boot.save'));
  const save = await loadGame();
  store.load(save);
  setLang(save.settings.lang ?? ya.lang);

  // Non-consumable entitlements live on the platform, not in the save file.
  if (ya.paymentsAvailable && (await ya.hasPurchase(PRODUCTS.noAds))) {
    grantProduct(PRODUCTS.noAds);
  }

  rolloverAdDay();
  refreshQuests();
  ensureOrders();

  sfx.setSound(save.settings.sound);
  sfx.setMusic(save.settings.music);
  installAdHooks();
  installSaveHooks();

  bootProgress(85, t('boot.ready'));
  // Yandex requires this as soon as the game can be shown.
  ya.ready();

  showStartGate();
}

/**
 * A single tap before the game starts. It unlocks WebAudio (browsers require
 * a gesture) and doubles as the moment we hand control to the player.
 */
function showStartGate(): void {
  bootProgress(100, t('boot.tapToStart'));
  const bootEl = document.getElementById('boot')!;
  bootEl.style.cursor = 'pointer';

  const start = () => {
    bootEl.removeEventListener('pointerdown', start);
    sfx.unlock();
    bootEl.remove();
    startGame();
  };
  bootEl.addEventListener('pointerdown', start);
  // Desktop players expect the keyboard to work too.
  window.addEventListener('keydown', function onKey(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    window.removeEventListener('keydown', onKey);
    start();
  });
}

// ---------------------------------------------------------------- game

function startGame(): void {
  const app = document.getElementById('app')!;
  app.hidden = false;

  const canvas = document.getElementById('board') as HTMLCanvasElement;
  view = new BoardView(canvas);

  wireBoard();
  mountHud();
  mountOrdersBar({ onDeliver: handleDeliver, onReroll: handleReroll });
  mountDock();
  setLanguageChangeHandler(rebuildUi);

  onLevelUp((info) => {
    openLevelUp(info);
    submitScore(true);
    void maybeInterstitial('levels');
  });

  installResize();
  installBackHandler();
  void syncBanner();
  ya.gameplayStart();

  // Offline settlement comes after the board exists so items can be placed.
  const report = computeOffline();
  if (report) openOffline(report);

  updateTutorial();
  requestAnimationFrame(loop);
}

function wireBoard(): void {
  view.onSpawn = (id) => {
    const result = spawnFrom(id);
    if (!result.ok) {
      sfx.error();
      if (result.reason === 'full') toast(t('board.full'), 'bad');
      else if (result.reason === 'empty') toast(t('gen.empty'), 'bad');
      return;
    }
    sfx.spawn();
    if (S().settings.vibro) vibrate(12);
    view.animateSpawn(result.index, id);
    advanceTutorial(0);
  };

  view.onGenLocked = (id) => {
    sfx.error();
    toast(t('gen.locked', { lvl: chain(id).unlockLevel }), 'bad');
  };

  view.onDrop = (result, target) => {
    if (result.kind === 'merge') {
      sfx.merge(result.tier);
      if (S().settings.vibro) vibrate(result.tier >= 6 ? [18, 40, 18] : 16);
      const p = view.cellCenter(target);
      burst(p.x, p.y, result.tier >= 7 ? '#ffd76a' : '#7ee8ff', result.tier >= 6 ? 16 : 9);
      floater(p.x, p.y, `+${fmt(result.coins)} 🪙`);
      advanceTutorial(1);
    } else if (result.kind === 'maxTier') {
      sfx.error();
      toast(t('board.maxTier'));
    } else if (result.kind !== 'none') {
      sfx.drop();
    }
  };

  view.onLongPress = (index) => {
    sfx.pick();
    openItemInfo(index, () => renderOrdersBar());
  };
}

function handleDeliver(slot: number): void {
  const order = S().orders[slot];
  if (!order) return;

  const result = deliverOrder(slot, 1);
  if (!result) {
    sfx.error();
    return;
  }

  sfx.coin();
  if (S().settings.vibro) vibrate([12, 30, 12]);

  const target = { x: window.innerWidth / 2, y: 40 };
  for (const i of result.from) {
    const from = view.cellCenter(i);
    burst(from.x, from.y, '#6ee7a8', 6);
  }
  floater(target.x, target.y + 40, `+${fmt(result.coins)} 🪙`, '#ffd76a');
  if (result.gems > 0) floater(target.x + 60, target.y + 60, `+${result.gems} 💠`, '#7ee8ff');
  toast(t('order.done'), 'good');

  advanceTutorial(2);
  saveGame();
  void maybeInterstitial('orders');
}

async function handleReroll(slot: number): Promise<void> {
  if (await rewardedAd()) {
    rerollOrder(slot);
    sfx.ui();
    toast(t('order.new'), 'good');
    saveGame();
  }
}

// ------------------------------------------------------------- main loop

function loop(now: number): void {
  tickGenerators();
  view.render(now);

  const wall = Date.now();
  if (wall - lastSave > SAVE_INTERVAL_MS) {
    lastSave = wall;
    saveGame();
  }
  if (wall - lastScore > SCORE_INTERVAL_MS) {
    lastScore = wall;
    submitScore(false);
  }
  if (wall - lastDayCheck > DAY_CHECK_INTERVAL_MS) {
    lastDayCheck = wall;
    checkDayRollover();
  }

  requestAnimationFrame(loop);
}

/**
 * Sessions can span midnight, so daily tasks, the login chest and the ad
 * quotas are re-evaluated periodically rather than only at boot.
 */
function checkDayRollover(): void {
  rolloverAdDay();
  if (refreshQuests()) toast(t('quest.title'), 'good');
  refreshDaily();
  refreshDock();
}

/** Empire power: level dominates, XP breaks ties. */
function empireScore(): number {
  const s = S();
  return s.level * 1000 + Math.floor(s.xp);
}

function submitScore(force: boolean): void {
  const score = empireScore();
  if (!force && score === lastScoreValue) return;
  lastScoreValue = score;
  void ya.submitScore(LEADERBOARD_NAME, score);
}

// --------------------------------------------------------------- layout

function installResize(): void {
  const stage = document.getElementById('stage')!;
  const apply = () => {
    const box = stage.getBoundingClientRect();
    if (box.width < 10 || box.height < 10) return;
    view.resize(box.width, box.height);
  };

  if ('ResizeObserver' in window) {
    new ResizeObserver(apply).observe(stage);
  }
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', () => window.setTimeout(apply, 250));
  store.on((topic) => {
    if (topic === 'rows') apply();
  });
  apply();
}

/** The platform back gesture should close a sheet, not exit the game. */
function installBackHandler(): void {
  window.addEventListener('popstate', () => {
    if (closeTop()) history.pushState(null, '');
  });
  history.pushState(null, '');
}

function rebuildUi(): void {
  mountHud();
  mountOrdersBar({ onDeliver: handleDeliver, onReroll: handleReroll });
  mountDock();
  updateHud();
  renderOrdersBar();
  refreshDock();
  updateTutorial();
}

// ------------------------------------------------------------- tutorial

function advanceTutorial(step: number): void {
  const s = S();
  if (s.tutorial !== step) return;
  s.tutorial = step + 1;
  if (s.tutorial >= TUTORIAL_STEPS) view.highlightGen = null;
  updateTutorial();
  saveGame();
}

function updateTutorial(): void {
  const overlay = document.getElementById('board-overlay');
  if (!overlay) return;
  overlay.textContent = '';

  const step = S().tutorial;
  if (step >= TUTORIAL_STEPS) {
    view.highlightGen = null;
    return;
  }

  // Step 0 points at the mine; later steps just narrate.
  view.highlightGen = step === 0 ? 'mine' : null;

  // Step 0 sits under the mine; later hints hug the bottom of the stage so
  // they never cover the items the player is being asked to drag.
  const below = step === 0;
  const bubble = el('div', `hint-bubble ${below ? 'below' : ''}`.trim(), t(`tutor.${step + 1}`));
  const box = overlay.getBoundingClientRect();
  const anchor = below
    ? view.genBottom('mine')
    : { x: box.left + box.width / 2, y: box.top + box.height * 0.97 };
  bubble.style.left = `${anchor.x - box.left}px`;
  bubble.style.top = `${anchor.y - box.top}px`;
  overlay.appendChild(bubble);
}

// Free-cell pressure is worth surfacing before the board deadlocks.
store.on((topic) => {
  if (topic !== 'board') return;
  if (freeCells() === 0) toast(t('board.full'), 'bad');
});

void boot();

window.addEventListener('pagehide', () => ya.gameplayStop());
