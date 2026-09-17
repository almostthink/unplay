import { el } from '../core/util';
import { sfx } from '../core/audio';
import { t } from '../i18n';

const stack: HTMLElement[] = [];

export interface ModalOptions {
  title?: string;
  subtitle?: string;
  /** Tapping the backdrop closes the sheet unless this is `false`. */
  dismissable?: boolean;
  onClose?: () => void;
}

/**
 * Opens a bottom-sheet style modal. `build` receives a `close` callback so
 * buttons inside can dismiss their own sheet.
 */
export function openModal(
  build: (close: () => void, body: HTMLElement) => void,
  opts: ModalOptions = {},
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
  }

  if (opts.title) sheet.appendChild(el('h2', undefined, opts.title));
  if (opts.subtitle) sheet.appendChild(el('p', 'sub', opts.subtitle));

  const body = el('div', 'modal-body');
  sheet.appendChild(body);
  backdrop.appendChild(sheet);

  if (dismissable) {
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) close();
    });
  }

  build(close, body);
  document.getElementById('modal-root')!.appendChild(backdrop);
  stack.push(backdrop);
  return close;
}

export function anyModalOpen(): boolean {
  return stack.length > 0;
}

/** Closes the topmost sheet; wired to the platform back gesture. */
export function closeTop(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.remove();
  stack.pop();
  return true;
}

export function button(
  label: string,
  kind: 'primary' | 'ad' | 'gem' | 'ghost' | '' = '',
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

export function row(
  icon: string,
  name: string,
  desc: string,
  action: HTMLElement,
): HTMLElement {
  const r = el('div', 'row');
  r.appendChild(el('div', 'ico', icon));
  const body = el('div', 'body');
  body.appendChild(el('div', 'name', name));
  body.appendChild(el('div', 'desc', desc));
  r.appendChild(body);
  const act = el('div', 'act');
  act.appendChild(action);
  r.appendChild(act);
  return r;
}

export function pill(
  label: string,
  kind: 'buy' | 'ad' | 'off' | '' = '',
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

export function closeButton(close: () => void): HTMLButtonElement {
  return button(t('common.close'), 'ghost', close);
}
