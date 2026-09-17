import { el } from './util';

const fxRoot = () => document.getElementById('fx-root')!;
const toastRoot = () => document.getElementById('toast-root')!;

/** Rising "+120" style label at a viewport position. */
export function floater(x: number, y: number, text: string, color = '#ffd76a'): void {
  const node = el('div', 'floater', text);
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  node.style.color = color;
  fxRoot().appendChild(node);
  window.setTimeout(() => node.remove(), 1000);
}

/** Radial particle burst, used on merges and rewards. */
export function burst(x: number, y: number, color = '#ffd76a', count = 10): void {
  const root = fxRoot();
  for (let i = 0; i < count; i++) {
    const p = el('div', 'burst');
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const dist = 28 + Math.random() * 42;
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    p.style.background = color;
    p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    p.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
    root.appendChild(p);
    window.setTimeout(() => p.remove(), 620);
  }
}

let lastToast = '';
let lastToastAt = 0;

export function toast(text: string, kind: 'info' | 'good' | 'bad' = 'info'): void {
  // Spamming the same message (e.g. "board full") adds noise, not information.
  const now = Date.now();
  if (text === lastToast && now - lastToastAt < 1200) return;
  lastToast = text;
  lastToastAt = now;

  const node = el('div', `toast ${kind === 'info' ? '' : kind}`.trim(), text);
  const root = toastRoot();
  root.appendChild(node);
  while (root.childElementCount > 3) root.firstElementChild!.remove();
  window.setTimeout(() => node.remove(), 2100);
}

/** Emoji flying from one screen point to another, used for order payouts. */
export function fly(
  from: { x: number; y: number },
  to: { x: number; y: number },
  emoji: string,
  delay = 0,
): void {
  const node = el('div', '', emoji);
  node.style.cssText =
    'position:absolute;font-size:24px;will-change:transform,opacity;pointer-events:none;';
  node.style.left = `${from.x}px`;
  node.style.top = `${from.y}px`;
  node.style.opacity = '0';
  fxRoot().appendChild(node);

  window.setTimeout(() => {
    node.style.transition = 'transform .55s cubic-bezier(.4,0,.2,1), opacity .55s ease';
    node.style.opacity = '1';
    node.style.transform = `translate(${to.x - from.x}px, ${to.y - from.y}px) scale(.5)`;
    window.setTimeout(() => {
      node.style.opacity = '0';
      window.setTimeout(() => node.remove(), 300);
    }, 520);
  }, delay);
}
