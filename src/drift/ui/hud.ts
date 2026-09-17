import { el, fmt } from '../../platform/util';
import { t } from '../../platform/i18n';
import type { HudState } from '../race';
import type { InputController } from '../input';

/** The in-race overlay: timer, score, drift meter, speed, nitro and pedals. */
export class Hud {
  private root: HTMLElement;
  private timer!: HTMLElement;
  private score!: HTMLElement;
  private dist!: HTMLElement;
  private driftBox!: HTMLElement;
  private driftPts!: HTMLElement;
  private driftMult!: HTMLElement;
  private speed!: HTMLElement;
  private nitroFill!: HTMLElement;
  private nitroPedal!: HTMLElement;
  private countdown!: HTMLElement;

  constructor(private input: InputController) {
    this.root = document.getElementById('hud')!;
    this.build();
  }

  private build(): void {
    const r = this.root;
    r.textContent = '';

    this.timer = el('div', 'hud-timer', '0.0');
    this.score = el('div', 'hud-score', '0');
    this.dist = el('div', 'hud-dist', '0 m');

    this.driftBox = el('div', 'hud-drift');
    this.driftBox.appendChild(el('div', 'label', t('hud.drift')));
    this.driftPts = el('div', 'pts', '0');
    this.driftMult = el('div', 'mult', 'x1.0');
    this.driftBox.append(this.driftPts, this.driftMult);

    const speedBox = el('div', 'hud-speed');
    this.speed = el('b', undefined, '0');
    speedBox.append(this.speed, el('span', undefined, t('hud.speed')));

    const nitroBar = el('div', 'hud-nitro');
    this.nitroFill = el('i');
    nitroBar.appendChild(this.nitroFill);

    const pedals = el('div', 'pedals');
    const brake = this.makePedal('🅿️', t('hud.drift'), 'handbrake');
    this.nitroPedal = this.makePedal('🔥', t('hud.nitro'), 'nitro');
    this.nitroPedal.classList.add('nitro');
    pedals.append(brake, this.nitroPedal);

    this.countdown = el('div', 'countdown', '');

    r.append(this.timer, this.score, this.dist, this.driftBox, speedBox, nitroBar, pedals, this.countdown);
  }

  /** A hold-to-act button; pointer capture keeps it held if the finger slides. */
  private makePedal(icon: string, label: string, which: 'handbrake' | 'nitro'): HTMLElement {
    const b = el('button', 'pedal');
    b.appendChild(el('span', 'ico', icon));
    b.appendChild(el('span', undefined, label));

    const set = (down: boolean) => {
      this.input.setTouchButton(which, down);
      b.classList.toggle('active', down);
    };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        b.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
      set(true);
    });
    const up = (e: PointerEvent) => {
      e.stopPropagation();
      set(false);
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    // Steering listens on the whole surface, so pedals must not leak through.
    b.addEventListener('pointermove', (e) => e.stopPropagation());
    return b;
  }

  show(): void {
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }

  update(s: HudState): void {
    this.timer.textContent = s.time.toFixed(1);
    this.timer.classList.toggle('low', s.time <= 5);

    this.score.textContent = fmt(Math.floor(s.score));
    this.dist.textContent = `${fmt(Math.floor(s.distance))} ${t('common.m')}`;
    this.speed.textContent = String(Math.round(s.speedKmh));

    this.driftBox.classList.toggle('on', s.drifting);
    if (s.drifting) {
      this.driftPts.textContent = `+${fmt(Math.floor(s.pending))}`;
      this.driftMult.textContent = `x${s.mult.toFixed(1)}`;
    }

    const pct = Math.max(0, Math.min(1, s.nitro));
    this.nitroFill.style.width = `${pct * 100}%`;
    this.nitroPedal.classList.toggle('ready', pct > 0.15);

    this.countdown.textContent = s.countdown ?? '';
  }

  /** Short centred message: checkpoint gained, crash, back on track. */
  banner(text: string, kind: 'good' | 'bad' | '' = ''): void {
    const node = el('div', `banner ${kind}`.trim(), text);
    this.root.appendChild(node);
    window.setTimeout(() => node.remove(), 1250);
  }
}
