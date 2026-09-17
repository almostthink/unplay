import { t } from './i18n';

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const randInt = (min: number, max: number): number =>
  min + Math.floor(Math.random() * (max - min + 1));

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 1234567 -> "1.23M". Keeps HUD numbers short on narrow phones. */
export function fmt(n: number): string {
  const v = Math.floor(n);
  if (v < 1000) return String(v);
  if (v < 1_000_000) return trim(v / 1000) + 'K';
  if (v < 1_000_000_000) return trim(v / 1_000_000) + 'M';
  return trim(v / 1_000_000_000) + 'B';
}

function trim(v: number): string {
  return (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0)).replace(/\.?0+$/, '');
}

/** Human duration, at most two units: "2 ч 15 мин". */
export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${t('time.d', { n: d })} ${t('time.h', { n: h })}`;
  if (h > 0) return `${t('time.h', { n: h })} ${t('time.m', { n: m })}`;
  if (m > 0) return `${t('time.m', { n: m })} ${t('time.s', { n: sec })}`;
  return t('time.s', { n: sec });
}

/** Short mm:ss for timers rendered on the board. */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Local calendar day index, used for daily resets and streaks. */
export function dayIndex(ts: number = Date.now()): number {
  const d = new Date(ts);
  return Math.floor(
    (ts - d.getTimezoneOffset() * 60_000) / 86_400_000,
  );
}

export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): (...args: A) => void {
  let last = 0;
  let timer = 0;
  let pending: A | null = null;
  return (...args: A) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
      return;
    }
    pending = args;
    if (!timer) {
      timer = window.setTimeout(() => {
        timer = 0;
        last = Date.now();
        if (pending) fn(...pending);
        pending = null;
      }, ms - (now - last));
    }
  };
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  html?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

export function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}
