import { CHAINS, chain, type ChainId } from './items';
import { COLS, genCapacity } from './config';
import { S, cellCount, type Cell } from './state';
import { boardRows, dropOn, genProgress, type DropResult } from './board';
import { clamp } from '../platform/util';

interface Layout {
  cell: number;
  gap: number;
  gridX: number;
  gridY: number;
  genY: number;
  genSize: number;
  genSlots: { id: ChainId; x: number; y: number }[];
}

type AnimKind = 'spawn' | 'merge' | 'reject';

interface Anim {
  kind: AnimKind;
  index: number;
  start: number;
  dur: number;
  fromX?: number;
  fromY?: number;
}

const LONG_PRESS_MS = 420;
const DRAG_THRESHOLD = 7;

export class BoardView {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private layout: Layout = {
    cell: 48,
    gap: 6,
    gridX: 0,
    gridY: 0,
    genY: 0,
    genSize: 56,
    genSlots: [],
  };

  private anims: Anim[] = [];

  private pointerId: number | null = null;
  private downAt = { x: 0, y: 0 };
  private pointer = { x: 0, y: 0 };
  private dragIndex: number | null = null;
  private dragging = false;
  private pendingGen: ChainId | null = null;
  private longPressTimer = 0;
  private hoverIndex: number | null = null;

  /** Cell the tutorial arrow should point at, or `null`. */
  highlightGen: ChainId | null = null;

  onSpawn: (id: ChainId) => void = () => {};
  onGenLocked: (id: ChainId) => void = () => {};
  onDrop: (result: DropResult, target: number) => void = () => {};
  onLongPress: (index: number) => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d unavailable');
    this.ctx = ctx;
    this.bindPointer();
  }

  // ---------------------------------------------------------------- layout

  resize(availW: number, availH: number): void {
    this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const rows = boardRows();
    const pad = 10;
    const gap = 6;

    const w = Math.max(120, availW - pad * 2);
    const h = Math.max(120, availH - pad * 2);

    // The generator strip takes roughly one extra row of vertical space.
    const byWidth = (w - gap * (COLS - 1)) / COLS;
    const byHeight = (h - gap * rows) / (rows + 1.3);
    const cell = Math.floor(Math.max(34, Math.min(byWidth, byHeight)));

    const gridW = cell * COLS + gap * (COLS - 1);
    const genSize = Math.floor(cell * 1.15);
    const gridH = cell * rows + gap * (rows - 1);

    // In portrait the width is the binding constraint, which leaves a lot of
    // vertical slack. Spend some of it on breathing room between the
    // generator strip and the grid rather than one large empty margin.
    const minGap = gap * 2;
    const slack = Math.max(0, availH - (genSize + minGap + gridH) - pad * 2);
    const stripGap = minGap + Math.min(slack * 0.45, cell * 0.9);
    const totalH = genSize + stripGap + gridH;

    this.w = availW;
    this.h = availH;
    this.canvas.width = Math.floor(availW * this.dpr);
    this.canvas.height = Math.floor(availH * this.dpr);
    this.canvas.style.width = `${availW}px`;
    this.canvas.style.height = `${availH}px`;

    // Sit a little above centre; the orders strip below draws the eye down.
    const top = Math.max(pad, (availH - totalH) * 0.42);
    const left = (availW - gridW) / 2;

    const visible = CHAINS.filter((c) => S().gens[c.id].unlocked || c.unlockLevel <= S().level + 3);
    const slotGap = Math.floor(genSize * 0.35);
    const stripW = visible.length * genSize + (visible.length - 1) * slotGap;
    const stripX = (availW - stripW) / 2;

    this.layout = {
      cell,
      gap,
      gridX: left,
      gridY: top + genSize + stripGap,
      genY: top,
      genSize,
      genSlots: visible.map((c, i) => ({
        id: c.id,
        x: stripX + i * (genSize + slotGap),
        y: top,
      })),
    };
  }

  // -------------------------------------------------------------- geometry

  private cellRect(i: number): { x: number; y: number; s: number } {
    const { cell, gap, gridX, gridY } = this.layout;
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    return { x: gridX + col * (cell + gap), y: gridY + row * (cell + gap), s: cell };
  }

  /** Viewport-space centre of a board cell, for DOM effects. */
  cellCenter(i: number): { x: number; y: number } {
    const r = this.cellRect(i);
    const box = this.canvas.getBoundingClientRect();
    return { x: box.left + r.x + r.s / 2, y: box.top + r.y + r.s / 2 };
  }

  /** Bottom edge of a generator tile, so a label can sit under it. */
  genBottom(id: ChainId): { x: number; y: number } {
    const slot = this.layout.genSlots.find((s) => s.id === id);
    const box = this.canvas.getBoundingClientRect();
    const size = this.layout.genSize;
    if (!slot) return { x: box.left + this.w / 2, y: box.top + size };
    return { x: box.left + slot.x + size / 2, y: box.top + slot.y + size + 8 };
  }

  genCenter(id: ChainId): { x: number; y: number } {
    const slot = this.layout.genSlots.find((s) => s.id === id);
    const box = this.canvas.getBoundingClientRect();
    if (!slot) return { x: box.left + this.w / 2, y: box.top + 40 };
    const s = this.layout.genSize;
    return { x: box.left + slot.x + s / 2, y: box.top + slot.y + s / 2 };
  }

  private hitCell(x: number, y: number): number | null {
    const { cell, gap, gridX, gridY } = this.layout;
    const rows = boardRows();
    const col = Math.floor((x - gridX) / (cell + gap));
    const row = Math.floor((y - gridY) / (cell + gap));
    if (col < 0 || col >= COLS || row < 0 || row >= rows) return null;
    return row * COLS + col;
  }

  private hitGen(x: number, y: number): ChainId | null {
    const s = this.layout.genSize;
    for (const slot of this.layout.genSlots) {
      if (x >= slot.x && x <= slot.x + s && y >= slot.y && y <= slot.y + s) return slot.id;
    }
    return null;
  }

  // --------------------------------------------------------------- pointer

  private localPoint(e: PointerEvent): { x: number; y: number } {
    const box = this.canvas.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  }

  private bindPointer(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    c.addEventListener('pointermove', (e) => this.onPointerMove(e));
    c.addEventListener('pointerup', (e) => this.onPointerUp(e));
    c.addEventListener('pointercancel', () => this.cancelGesture());
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onPointerDown(e: PointerEvent): void {
    if (this.pointerId !== null) return;
    this.pointerId = e.pointerId;
    const p = this.localPoint(e);
    this.downAt = p;
    this.pointer = p;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }

    const gen = this.hitGen(p.x, p.y);
    if (gen) {
      this.pendingGen = gen;
      return;
    }

    const i = this.hitCell(p.x, p.y);
    if (i !== null && i < cellCount() && S().board[i]) {
      this.dragIndex = i;
      this.longPressTimer = window.setTimeout(() => {
        if (this.dragging || this.dragIndex === null) return;
        const index = this.dragIndex;
        this.cancelGesture();
        this.onLongPress(index);
      }, LONG_PRESS_MS);
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.pointerId !== e.pointerId) return;
    const p = this.localPoint(e);
    this.pointer = p;
    if (this.dragIndex === null) return;

    if (!this.dragging) {
      const dx = p.x - this.downAt.x;
      const dy = p.y - this.downAt.y;
      if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      this.dragging = true;
      window.clearTimeout(this.longPressTimer);
      this.longPressTimer = 0;
    }
    const over = this.hitCell(p.x, p.y);
    this.hoverIndex = over !== null && over < cellCount() ? over : null;
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.pointerId !== e.pointerId) return;
    const p = this.localPoint(e);

    if (this.pendingGen) {
      const id = this.pendingGen;
      const still = this.hitGen(p.x, p.y) === id;
      this.cancelGesture();
      if (still) {
        if (S().gens[id].unlocked) this.onSpawn(id);
        else this.onGenLocked(id);
      }
      return;
    }

    if (this.dragIndex !== null && this.dragging) {
      const target = this.hitCell(p.x, p.y);
      const from = this.dragIndex;
      this.cancelGesture();
      if (target !== null && target < cellCount()) {
        const result = dropOn(from, target);
        if (result.kind === 'merge') this.push({ kind: 'merge', index: target, start: performance.now(), dur: 320 });
        else if (result.kind === 'maxTier') this.push({ kind: 'reject', index: target, start: performance.now(), dur: 260 });
        this.onDrop(result, target);
      }
      return;
    }

    this.cancelGesture();
  }

  private cancelGesture(): void {
    if (this.pointerId !== null) {
      try {
        this.canvas.releasePointerCapture(this.pointerId);
      } catch {
        /* already released */
      }
    }
    if (this.longPressTimer) {
      window.clearTimeout(this.longPressTimer);
      this.longPressTimer = 0;
    }
    this.pointerId = null;
    this.dragIndex = null;
    this.dragging = false;
    this.pendingGen = null;
    this.hoverIndex = null;
  }

  // ------------------------------------------------------------ animations

  private push(a: Anim): void {
    this.anims = this.anims.filter((x) => !(x.index === a.index && x.kind === a.kind));
    this.anims.push(a);
  }

  animateSpawn(index: number, from: ChainId): void {
    const slot = this.layout.genSlots.find((s) => s.id === from);
    const r = this.cellRect(index);
    this.push({
      kind: 'spawn',
      index,
      start: performance.now(),
      dur: 300,
      fromX: (slot ? slot.x + this.layout.genSize / 2 : this.w / 2) - (r.x + r.s / 2),
      fromY: (slot ? slot.y + this.layout.genSize / 2 : 0) - (r.y + r.s / 2),
    });
  }

  private animFor(index: number, now: number): { scale: number; dx: number; dy: number } {
    let scale = 1;
    let dx = 0;
    let dy = 0;
    for (const a of this.anims) {
      if (a.index !== index) continue;
      const p = (now - a.start) / a.dur;
      if (p >= 1) continue;
      if (a.kind === 'spawn') {
        const e = 1 - Math.pow(1 - p, 3);
        dx += (a.fromX ?? 0) * (1 - e);
        dy += (a.fromY ?? 0) * (1 - e);
        scale *= 0.4 + 0.6 * e;
      } else if (a.kind === 'merge') {
        scale *= 1 + Math.sin(p * Math.PI) * 0.45;
      } else if (a.kind === 'reject') {
        dx += Math.sin(p * Math.PI * 5) * 6 * (1 - p);
      }
    }
    return { scale, dx, dy };
  }

  // ----------------------------------------------------------------- paint

  render(now: number): void {
    const ctx = this.ctx;
    this.anims = this.anims.filter((a) => now - a.start < a.dur);

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, this.w, this.h);

    this.drawGenerators(ctx, now);
    this.drawGrid(ctx, now);
    this.drawDragged(ctx);

    ctx.restore();
  }

  private drawGrid(ctx: CanvasRenderingContext2D, now: number): void {
    const s = S();
    const total = cellCount();
    for (let i = 0; i < total; i++) {
      const r = this.cellRect(i);
      const isHover = this.dragging && this.hoverIndex === i;
      const cell = s.board[i];
      const isSource = this.dragging && this.dragIndex === i;

      // Empty slot plate
      roundRect(ctx, r.x, r.y, r.s, r.s, r.s * 0.22);
      ctx.fillStyle = isHover ? 'rgba(255,215,106,0.16)' : 'rgba(255,255,255,0.055)';
      ctx.fill();
      ctx.lineWidth = isHover ? 2 : 1;
      ctx.strokeStyle = isHover ? 'rgba(255,215,106,0.85)' : 'rgba(255,255,255,0.09)';
      ctx.stroke();

      if (!cell || isSource) continue;
      const a = this.animFor(i, now);
      this.drawItem(ctx, cell, r.x + r.s / 2 + a.dx, r.y + r.s / 2 + a.dy, r.s * a.scale);
    }
  }

  private drawItem(
    ctx: CanvasRenderingContext2D,
    cell: Cell,
    cx: number,
    cy: number,
    size: number,
  ): void {
    const def = chain(cell.chain);
    const half = size / 2;
    const pad = size * 0.06;

    ctx.save();
    roundRect(ctx, cx - half + pad, cy - half + pad, size - pad * 2, size - pad * 2, size * 0.2);
    const g = ctx.createLinearGradient(cx, cy - half, cx, cy + half);
    const light = 26 + cell.tier * 3.4;
    g.addColorStop(0, `hsl(${def.hue} 62% ${light + 12}%)`);
    g.addColorStop(1, `hsl(${def.hue} 58% ${light}%)`);
    ctx.fillStyle = g;
    ctx.fill();

    // Higher tiers get a brighter rim so value reads at a glance.
    ctx.lineWidth = cell.tier >= 7 ? 2 : 1;
    ctx.strokeStyle =
      cell.tier >= 7
        ? 'rgba(255,225,140,0.95)'
        : cell.tier >= 4
          ? 'rgba(255,255,255,0.38)'
          : 'rgba(255,255,255,0.18)';
    ctx.stroke();

    ctx.font = `${Math.round(size * 0.52)}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(def.tiers[cell.tier - 1][0], cx, cy + size * 0.02);

    // Tier pip
    const pipR = size * 0.15;
    const px = cx + half - pipR - pad;
    const py = cy + half - pipR - pad;
    ctx.beginPath();
    ctx.arc(px, py, pipR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10,6,26,0.82)';
    ctx.fill();
    ctx.font = `700 ${Math.round(pipR * 1.35)}px system-ui,sans-serif`;
    ctx.fillStyle = cell.tier >= 7 ? '#ffd76a' : '#efeaff';
    ctx.fillText(String(cell.tier), px, py + pipR * 0.06);
    ctx.restore();
  }

  private drawGenerators(ctx: CanvasRenderingContext2D, now: number): void {
    const s = S();
    const size = this.layout.genSize;
    for (const slot of this.layout.genSlots) {
      const def = chain(slot.id);
      const g = s.gens[slot.id];
      const cx = slot.x + size / 2;
      const cy = slot.y + size / 2;
      const locked = !g.unlocked;

      ctx.save();
      roundRect(ctx, slot.x, slot.y, size, size, size * 0.26);
      const grad = ctx.createLinearGradient(cx, slot.y, cx, slot.y + size);
      if (locked) {
        grad.addColorStop(0, 'rgba(255,255,255,0.07)');
        grad.addColorStop(1, 'rgba(255,255,255,0.03)');
      } else {
        grad.addColorStop(0, `hsl(${def.hue} 55% 34%)`);
        grad.addColorStop(1, `hsl(${def.hue} 55% 22%)`);
      }
      ctx.fillStyle = grad;
      ctx.fill();

      const ready = !locked && g.charges > 0;
      const pulse = ready ? 0.5 + 0.5 * Math.sin(now / 420) : 0;
      ctx.lineWidth = ready ? 2 : 1;
      ctx.strokeStyle = ready
        ? `rgba(255,215,106,${0.5 + pulse * 0.5})`
        : 'rgba(255,255,255,0.12)';
      ctx.stroke();

      ctx.globalAlpha = locked ? 0.32 : 1;
      ctx.font = `${Math.round(size * 0.46)}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(def.gen, cx, cy - size * 0.05);
      ctx.globalAlpha = 1;

      if (locked) {
        ctx.font = `800 ${Math.round(size * 0.2)}px system-ui,sans-serif`;
        ctx.fillStyle = '#b3a8dd';
        ctx.fillText(`🔒 ${def.unlockLevel}`, cx, cy + size * 0.32);
        ctx.restore();
        continue;
      }

      // Charge counter
      const cap = genCapacity(g.level);
      ctx.font = `800 ${Math.round(size * 0.21)}px system-ui,sans-serif`;
      ctx.fillStyle = g.charges > 0 ? '#ffd76a' : '#8d82b5';
      ctx.fillText(`${g.charges}/${cap}`, cx, cy + size * 0.33);

      // Refill arc along the top edge of the tile
      if (g.charges < cap) {
        const p = genProgress(slot.id);
        ctx.beginPath();
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(126,232,255,0.9)';
        ctx.lineCap = 'round';
        const r = size * 0.5 - 3;
        ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
        ctx.stroke();
      }

      if (this.highlightGen === slot.id) {
        const glow = 0.4 + 0.6 * Math.abs(Math.sin(now / 350));
        roundRect(ctx, slot.x - 4, slot.y - 4, size + 8, size + 8, size * 0.3);
        ctx.lineWidth = 3;
        ctx.strokeStyle = `rgba(255,215,106,${glow})`;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawDragged(ctx: CanvasRenderingContext2D): void {
    if (!this.dragging || this.dragIndex === null) return;
    const cell = S().board[this.dragIndex];
    if (!cell) return;
    const size = this.layout.cell * 1.18;
    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 6;
    this.drawItem(
      ctx,
      cell,
      clamp(this.pointer.x, 0, this.w),
      clamp(this.pointer.y - size * 0.35, 0, this.h),
      size,
    );
    ctx.restore();
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}
