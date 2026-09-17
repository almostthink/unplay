import { SAVE_KEY } from '../game/config';
import { migrate, S, type SaveData } from '../game/state';
import { ya } from '../sdk/yandex';

/** Yandex rate-limits player.setData, so cloud writes are coalesced. */
const CLOUD_INTERVAL_MS = 12_000;

let lastCloudWrite = 0;
let cloudTimer = 0;
let cloudPending = false;

function readLocal(): SaveData | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    return migrate(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeLocal(data: SaveData): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch {
    /* private mode / quota — the cloud copy is still attempted */
  }
}

/**
 * Loads the newest of the cloud and local saves. The cloud copy wins ties
 * because it is the one shared between the player's devices.
 */
export async function loadGame(): Promise<SaveData> {
  const local = readLocal();
  const cloudRaw = await ya.loadData<unknown>(SAVE_KEY);
  const cloud = cloudRaw ? migrate(cloudRaw) : null;

  if (cloud && local) return cloud.lastSeen >= local.lastSeen ? cloud : local;
  return cloud ?? local ?? migrate(null);
}

/** Persists locally right away and schedules a cloud write. */
export function saveGame(force = false): void {
  const data = S();
  data.lastSeen = Date.now();
  writeLocal(data);

  if (!ya.available) return;

  const elapsed = Date.now() - lastCloudWrite;
  if (force || elapsed >= CLOUD_INTERVAL_MS) {
    flushCloud(force);
    return;
  }
  if (cloudTimer) return;
  cloudPending = true;
  cloudTimer = window.setTimeout(() => {
    cloudTimer = 0;
    if (cloudPending) flushCloud(false);
  }, CLOUD_INTERVAL_MS - elapsed);
}

function flushCloud(flush: boolean): void {
  lastCloudWrite = Date.now();
  cloudPending = false;
  const data = S();
  void ya.saveData(SAVE_KEY, data, flush);
  void ya.saveStats({
    level: data.level,
    coins: Math.floor(data.coins),
    orders: data.stats.ordersDone,
    maxTier: data.stats.maxTier,
  });
}

export function resetGame(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}

/** Flush on any signal that the tab might be going away. */
export function installSaveHooks(): void {
  const flush = () => saveGame(true);
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}
