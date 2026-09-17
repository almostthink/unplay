import { SAVE_KEY } from './config';
import { migrate, S, type SaveData } from './state';
import { ya } from '../platform/yandex';

/** Yandex rate-limits player.setData, so cloud writes are coalesced. */
const CLOUD_INTERVAL_MS = 12_000;

let lastCloudWrite = 0;
let cloudTimer = 0;

function readLocal(): SaveData | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? migrate(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Loads the newer of the cloud and local saves; the cloud wins ties. */
export async function loadGame(): Promise<SaveData> {
  const local = readLocal();
  const cloudRaw = await ya.loadData<unknown>(SAVE_KEY);
  const cloud = cloudRaw ? migrate(cloudRaw) : null;
  if (cloud && local) return cloud.lastSeen >= local.lastSeen ? cloud : local;
  return cloud ?? local ?? migrate(null);
}

export function saveGame(force = false): void {
  const data = S();
  data.lastSeen = Date.now();
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch {
    /* private mode or quota; the cloud copy is still attempted */
  }

  if (!ya.available) return;
  const elapsed = Date.now() - lastCloudWrite;
  if (force || elapsed >= CLOUD_INTERVAL_MS) {
    flushCloud(force);
    return;
  }
  if (cloudTimer) return;
  cloudTimer = window.setTimeout(() => {
    cloudTimer = 0;
    flushCloud(false);
  }, CLOUD_INTERVAL_MS - elapsed);
}

function flushCloud(flush: boolean): void {
  lastCloudWrite = Date.now();
  const data = S();
  void ya.saveData(SAVE_KEY, data, flush);
  void ya.saveStats({
    level: data.level,
    coins: Math.floor(data.coins),
    bestScore: Math.floor(data.stats.bestScore),
    runs: data.stats.runs,
  });
}

export function resetGame(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}

export function installSaveHooks(): void {
  const flush = () => saveGame(true);
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}
