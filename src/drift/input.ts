import type { CarInput } from './car';

/**
 * Steering, handbrake and nitro from either a touch screen or a keyboard.
 *
 * On touch the screen is split in half: holding a side steers that way, and
 * how far from the centre you hold sets how hard. Two on-screen buttons cover
 * handbrake and nitro.
 */
export class InputController {
  private keys = new Set<string>();
  private touchSteer = 0;
  private touchHandbrake = false;
  private touchNitro = false;
  private pointers = new Map<number, { x: number; startX: number }>();
  private enabled = false;
  private smoothed = 0;

  /** True once the player has used a touch screen, which switches the hints. */
  usedTouch = false;

  constructor(private surface: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    surface.addEventListener('pointerdown', this.onPointerDown);
    surface.addEventListener('pointermove', this.onPointerMove);
    surface.addEventListener('pointerup', this.onPointerUp);
    surface.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('blur', () => this.releaseAll());
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.releaseAll();
  }

  setTouchButton(which: 'handbrake' | 'nitro', down: boolean): void {
    if (which === 'handbrake') this.touchHandbrake = down;
    else this.touchNitro = down;
  }

  private releaseAll(): void {
    this.keys.clear();
    this.pointers.clear();
    this.touchSteer = 0;
    this.touchHandbrake = false;
    this.touchNitro = false;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    this.keys.add(e.key.toLowerCase());
    if ([' ', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(e.key.toLowerCase())) {
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    if (e.pointerType === 'touch') this.usedTouch = true;
    this.pointers.set(e.pointerId, { x: e.clientX, startX: e.clientX });
    this.updateTouchSteer();
  };

  private onPointerMove = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    this.updateTouchSteer();
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.updateTouchSteer();
  };

  /** Averages every held pointer so a second finger cannot fight the first. */
  private updateTouchSteer(): void {
    if (!this.pointers.size) {
      this.touchSteer = 0;
      return;
    }
    const width = this.surface.clientWidth || window.innerWidth;
    let sum = 0;
    for (const p of this.pointers.values()) {
      const rel = (p.x / width) * 2 - 1;
      // A dead zone in the middle stops a centred tap from twitching the car.
      const dead = 0.08;
      const mag = Math.abs(rel) < dead ? 0 : (Math.abs(rel) - dead) / (1 - dead);
      sum += Math.sign(rel) * Math.min(1, mag * 1.35);
    }
    this.touchSteer = Math.max(-1, Math.min(1, sum / this.pointers.size));
  }

  /** Reads the current input, smoothing steering so it does not snap. */
  read(dt: number): CarInput {
    if (!this.enabled) return { steer: 0, handbrake: false, nitro: false };

    let raw = this.touchSteer;
    if (this.keys.has('a') || this.keys.has('arrowleft') || this.keys.has('ф')) raw = -1;
    if (this.keys.has('d') || this.keys.has('arrowright') || this.keys.has('в')) raw = 1;

    const rate = 1 - Math.exp(-11 * dt);
    this.smoothed += (raw - this.smoothed) * rate;

    return {
      steer: this.smoothed,
      handbrake: this.touchHandbrake || this.keys.has(' '),
      nitro: this.touchNitro || this.keys.has('shift'),
    };
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }
}
