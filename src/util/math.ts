export interface Vec {
  x: number;
  y: number;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * 把點 p 投影到線段 a→b。
 * u：沿線段的位置（0 = a、1 = b，可超出範圍）；d：帶正負號的垂直距離。
 * 垂直方向單位向量為 n = (dy, −dx)/len，所以 p = a + (b−a)·u + n·d。
 */
export function project(p: Vec, a: Vec, b: Vec): { u: number; d: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1e-9;
  const u = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const d = ((p.x - a.x) * dy - (p.y - a.y) * dx) / Math.sqrt(len2);
  return { u, d };
}

/** 點 from→to 的移動是否穿過線段 a→b；回傳穿過位置 u 與原本所在的那一側（±1）。 */
export function crossing(from: Vec, to: Vec, a: Vec, b: Vec): { u: number; side: number } | null {
  const p0 = project(from, a, b);
  const p1 = project(to, a, b);
  if (p0.d === 0 || p0.d * p1.d >= 0) return null;
  const t = p0.d / (p0.d - p1.d);
  return { u: lerp(p0.u, p1.u, t), side: Math.sign(p0.d) };
}

/** One-Euro 濾波器：慢動作時強力去抖，快動作時幾乎不延遲。 */
export class OneEuro {
  private prev: number | null = null;
  private dPrev = 0;

  constructor(private minCutoff = 1.5, private beta = 0.02, private dCutoff = 1) {}

  reset(): void {
    this.prev = null;
    this.dPrev = 0;
  }

  filter(x: number, dt: number): number {
    if (this.prev === null || dt <= 0) {
      this.prev = x;
      this.dPrev = 0;
      return x;
    }
    const dx = (x - this.prev) / dt;
    const ad = alpha(this.dCutoff, dt);
    const dHat = ad * dx + (1 - ad) * this.dPrev;
    const a = alpha(this.minCutoff + this.beta * Math.abs(dHat), dt);
    const out = a * x + (1 - a) * this.prev;
    this.prev = out;
    this.dPrev = dHat;
    return out;
  }
}

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}
