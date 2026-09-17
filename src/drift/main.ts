import './styles.css';

import { ya } from '../platform/yandex';
import { registerStrings, setLang, t } from '../platform/i18n';
import { DRIFT_STRINGS } from './strings';
import { toast } from '../platform/fx';
import { fmt, vibrate } from '../platform/util';
import { S, store } from './state';
import { LEADERBOARD_NAME, PRODUCTS } from './config';
import { loadGame, installSaveHooks, saveGame } from './storage';
import { addCoins, addXp, onLevelUp } from './economy';
import { sfx } from './audio';
import {
  installAdHooks,
  maybeInterstitial,
  rolloverAdDay,
  setBanner,
} from './ads';
import { World, detectQuality, type Quality } from './scene';
import { InputController } from './input';
import { Race, type RaceResult } from './race';
import { Hud } from './ui/hud';
import { Menu } from './ui/menu';
import { closeTopSheet } from './ui/sheet';
import {
  grantProduct,
  openLevelUp,
  openResults,
  openTutorial,
  setLanguageChangeHandler,
  setQualityHandler,
  setResultActions,
} from './ui/screens';

type Mode = 'menu' | 'race';

const SAVE_INTERVAL_MS = 15_000;

let world: World;
let input: InputController;
let race: Race;
let hud: Hud;
let menu: Menu;
let mode: Mode = 'menu';
let lastFrame = 0;
let lastSave = 0;
/** Coins banked from the run that just ended, for the x2 offer. */
let pendingCoins = 0;

// ----------------------------------------------------------------- boot

function bootProgress(pct: number, hint: string): void {
  const fill = document.getElementById('boot-fill');
  const label = document.getElementById('boot-hint');
  if (fill) fill.style.width = `${pct}%`;
  if (label) label.textContent = hint;
}

async function boot(): Promise<void> {
  registerStrings(DRIFT_STRINGS);
  bootProgress(15, t('boot.sdk'));
  await ya.init();

  bootProgress(45, t('boot.assets'));
  const save = await loadGame();
  store.load(save);
  setLang(save.settings.lang ?? ya.lang);

  // A fresh save has no quality preference, so pick one from the device.
  if (!save.settings.lang && save.stats.runs === 0) {
    save.settings.quality = detectQuality();
  }

  if (ya.paymentsAvailable && (await ya.hasPurchase(PRODUCTS.noAds))) {
    grantProduct(PRODUCTS.noAds);
  }

  rolloverAdDay();
  sfx.setSound(save.settings.sound);
  sfx.setMusic(save.settings.music);
  installAdHooks();
  installSaveHooks();

  bootProgress(85, t('boot.ready'));
  // Yandex requires this as soon as the game can be shown.
  ya.ready();
  showStartGate();
}

/** One tap unlocks WebAudio and hands control to the player. */
function showStartGate(): void {
  bootProgress(100, t('boot.tap'));
  const bootEl = document.getElementById('boot')!;
  bootEl.style.cursor = 'pointer';

  const start = () => {
    bootEl.removeEventListener('pointerdown', start);
    window.removeEventListener('keydown', onKey);
    sfx.unlock();
    bootEl.remove();
    startGame();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') start();
  };
  bootEl.addEventListener('pointerdown', start);
  window.addEventListener('keydown', onKey);
}

// ----------------------------------------------------------------- game

function startGame(): void {
  const canvas = document.getElementById('gl') as HTMLCanvasElement;
  world = new World(canvas, S().settings.quality as Quality);
  input = new InputController(canvas);
  race = new Race(world, input);
  hud = new Hud(input);
  menu = new Menu(onPlayPressed);

  race.onEnd = handleRunEnd;
  race.onCheckpoint = (seconds) => {
    hud.banner(t('hud.checkpoint', { n: seconds }), 'good');
    if (S().settings.vibro) vibrate(20);
  };
  race.onCrash = () => {
    hud.banner(t('hud.crash'), 'bad');
    if (S().settings.vibro) vibrate([25, 40, 25]);
  };

  onLevelUp((info) => openLevelUp(info.level, info.coins));

  setResultActions({
    again: () => beginRace(),
    revive: () => {
      race.revive();
      hud.show();
      mode = 'race';
      void setBanner(false);
    },
    menu: () => toMenu(),
    canRevive: () => race.revivesLeft > 0,
  });
  setLanguageChangeHandler(() => location.reload());
  setQualityHandler((q) => world.setQuality(q));

  // Re-park so a car or paint bought in the garage shows up immediately.
  store.on((topic) => {
    if (topic === 'garage' && mode === 'menu') race.parkForMenu();
  });

  installResize();
  installBackHandler();

  race.parkForMenu();
  toMenu();

  lastFrame = performance.now();
  requestAnimationFrame(frame);
}

function onPlayPressed(): void {
  if (!S().tutorialSeen) {
    openTutorial(input.usedTouch || ya.isMobile, () => {
      S().tutorialSeen = true;
      saveGame(true);
      beginRace();
    });
    return;
  }
  beginRace();
}

function beginRace(): void {
  mode = 'race';
  menu.hide();
  hud.show();
  race.start();
  // The banner must never cover the road during a run.
  void setBanner(false);
  ya.gameplayStart();
}

function toMenu(): void {
  mode = 'menu';
  hud.hide();
  menu.show();
  race.parkForMenu();
  void setBanner(true);
  ya.gameplayStop();
}

function handleRunEnd(result: RaceResult): void {
  const s = S();
  s.stats.runs += 1;
  s.runsSinceAd += 1;
  s.stats.bestScore = Math.max(s.stats.bestScore, result.score);
  s.stats.bestDistance = Math.max(s.stats.bestDistance, result.distance);
  s.stats.totalDistance += result.distance;
  s.stats.bestDriftMult = Math.max(s.stats.bestDriftMult, result.bestMult);

  pendingCoins = result.coins;
  addCoins(result.coins);
  addXp(Math.round(result.score * 0.35));

  void ya.submitScore(LEADERBOARD_NAME, s.stats.bestScore);
  saveGame(true);

  hud.hide();
  void setBanner(true);
  ya.gameplayStop();

  if (result.newBest) toast(`${t('result.newBest')} ${fmt(result.score)}`, 'good');
  openResults(result, pendingCoins);

  // Interstitials only ever fire here, between runs.
  void maybeInterstitial();
}

// ------------------------------------------------------------ main loop

function frame(now: number): void {
  // Clamp the step so a backgrounded tab does not teleport the car.
  const dt = Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000));
  lastFrame = now;

  if (mode === 'race') {
    hud.update(race.update(dt));
  } else {
    race.orbit(dt);
  }
  world.render();

  const wall = Date.now();
  if (wall - lastSave > SAVE_INTERVAL_MS) {
    lastSave = wall;
    saveGame();
  }

  requestAnimationFrame(frame);
}

// --------------------------------------------------------------- layout

function installResize(): void {
  const apply = () => world.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', () => window.setTimeout(apply, 250));
  apply();
}

/** The platform back gesture should close a sheet, not exit the game. */
function installBackHandler(): void {
  window.addEventListener('popstate', () => {
    if (closeTopSheet()) history.pushState(null, '');
    else if (mode === 'race') {
      race.stop();
      toMenu();
      history.pushState(null, '');
    }
  });
  history.pushState(null, '');
}

void boot();

window.addEventListener('pagehide', () => ya.gameplayStop());
