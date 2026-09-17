import { el } from '../../platform/util';
import { sfx } from '../audio';
import { t } from '../../platform/i18n';

const stack: HTMLElement[] = [];

export interface SheetOptions {
  title?: string;
  subtitle?: string;
  dismissable?: boolean;
  onClose?: () => void;
}

/** Opens a modal sheet. `build` gets a `close` callback and the body element. */
export function openSheet(
  build: (close: () => void, body: HTMLElement) => void,
  opts: SheetOptions = {},
): () => void {
  const { dismissable = true } = opts;
  const backdrop = el('div', 'backdrop');
  const sheet = el('div', 'sheet');

  const close = () => {
    const i = stack.indexOf(backdrop);
    if (i >= 0) stack.splice(i, 1);
    backdrop.remove();
    opts.onClose?.();
  };

  if (dismissable) {
    const x = el('button', 'sheet-close', '✕');
    x.addEventListener('click', () => {
      sfx.ui();
      close();
    });
    sheet.appendChild(x);
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) close();
    });
  }

  if (opts.title) sheet.appendChild(el('h2', undefined, opts.title));
  if (opts.subtitle) sheet.appendChild(el('p', 'sub', opts.subtitle));

  const body = el('div');
  sheet.appendChild(body);
  backdrop.appendChild(sheet);

  build(close, body);
  document.getElementById('modal-root')!.appendChild(backdrop);
  stack.push(backdrop);
  return close;
}

export function anySheetOpen(): boolean {
  return stack.length > 0;
}

/** Closes the topmost sheet; wired to the platform back gesture. */
export function closeTopSheet(): boolean {
  const top = stack.pop();
  if (!top) return false;
  top.remove();
  return true;
}

export function button(
  label: string,
  kind: 'primary' | 'ad' | 'ghost' | '' = '',
  onClick?: () => void,
): HTMLButtonElement {
  const b = el('button', `btn ${kind}`.trim(), label);
  if (onClick) {
    b.addEventListener('click', () => {
      sfx.ui();
      onClick();
    });
  }
  return b;
}

export function pill(
  label: string,
  kind: 'buy' | 'ad' | 'on' | 'off' | '' = '',
  onClick?: () => void,
): HTMLButtonElement {
  const p = el('button', `pill ${kind}`.trim(), label);
  if (kind === 'off') p.disabled = true;
  if (onClick) {
    p.addEventListener('click', () => {
      sfx.ui();
      onClick();
    });
  }
  return p;
}

export function row(icon: string, name: string, desc: string, action: HTMLElement): HTMLElement {
  const r = el('div', 'row');
  r.appendChild(el('div', 'ico', icon));
  const body = el('div', 'body');
  body.appendChild(el('div', 'name', name));
  if (desc) body.appendChild(el('div', 'desc', desc));
  r.appendChild(body);
  r.appendChild(action);
  return r;
}

export function closeButton(close: () => void): HTMLButtonElement {
  return button(t('common.close'), 'ghost', close);
}
