// 畫面繪製：鏡像的攝影機畫面、手部骨架、發光的弦、火花。
// 弦的波形直接由物理模組的模態參數算出來，和聲音是同一組數字。

import { type AirString, type Game, VIZ_MODES } from '../game/game';
import * as P from '../physics/string';
import { fmtFreq, fmtLength, fmtNote, stringLabel } from '../teach/wording';
import type { HandTracker } from '../tracking/hands';
import { type Vec, clamp } from '../util/math';

/** 每條弦取樣幾個點來畫波形 */
const NPTS = 65;
/** 波形以慢動作呈現：不論弦的實際頻率多高，基音在畫面上都以這個頻率擺動（Hz） */
const VIS_HZ = 7;
/** 「慢動作」開啟時更慢，並拿掉電弧效果，只留真實的波形 */
const SLOW_HZ = 1.2;
/** 電弧的鋸齒多久換一次（毫秒）——真實放電的閃爍節奏 */
const ARC_HOLD_MS = 45;
/** 振幅達到這麼多像素時電弧效果全開 */
const ARC_FULL_PX = 14;

/** 光暈各層：[加寬的像素, 不透明度] */
const HALO: [number, number][] = [[30, 0.035], [21, 0.05], [14, 0.075], [8, 0.12], [4, 0.2]];

/** 選取的弦上標出的節點位置（k/n） */
const NODES: [number, number][] = [[1, 2], [1, 3], [2, 3], [1, 4], [3, 4]];

/** 中點位移法產生一條兩端為 0 的碎形折線（長度必須是 2^k + 1），閃電就是這種形狀。 */
function fractal(out: Float32Array, rough = 0.72): void {
  const n = out.length - 1;
  out[0] = 0;
  out[n] = 0;
  let amp = 1;
  for (let step = n; step > 1; step >>= 1) {
    const half = step >> 1;
    for (let i = half; i < n; i += step) {
      out[i] = (out[i - half] + out[i + half]) / 2 + (Math.random() * 2 - 1) * amp;
    }
    amp *= rough;
  }
}

/** SIN[n·NPTS + i] = sin((n+1)·π·i/(NPTS−1))：各模態的駐波形狀 */
const SIN = new Float32Array(VIZ_MODES * NPTS);
for (let n = 0; n < VIZ_MODES; n++) {
  for (let i = 0; i < NPTS; i++) SIN[n * NPTS + i] = Math.sin(((n + 1) * Math.PI * i) / (NPTS - 1));
}

const BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

export class Renderer {
  /** 舞台 → 螢幕的轉換：screen = offset + stage × scale */
  scale = 1;
  ox = 0;
  oy = 0;
  /** 兩隻手在材質盤上停留的進度（0〜1） */
  dwell: number[] = [0, 0];
  showVideo = true;
  /** 慢動作：只畫真實波形（不加電弧鋸齒），並放得更慢，方便看清楚波怎麼來回跑 */
  slowMo = false;
  /** 電弧是否加上柔光（shadowBlur 較吃效能，低階裝置關閉） */
  softGlow = true;
  /** 畫布解析度上限（相對於 CSS 像素） */
  dprCap = 2;
  /** 光暈疊幾層（1〜5，越少越省效能） */
  haloLayers = 5;
  mirror = true;
  debug = false;
  debugLines: string[] = [];

  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private cw = 0;
  private ch = 0;
  private amp = new Float32Array(VIZ_MODES);
  private shape = new Float32Array(NPTS);
  private echo = new Float32Array(NPTS);
  /** 每條弦各自的電弧鋸齒（主線與殘影各一條），每隔 ARC_HOLD_MS 重新產生 */
  private arcs = new WeakMap<AirString, { at: number; main: Float32Array; echo: Float32Array }>();

  constructor(
    private canvas: HTMLCanvasElement,
    private video: HTMLVideoElement,
    private game: Game,
    private tracker: HandTracker,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);
    this.cw = window.innerWidth;
    this.ch = window.innerHeight;
    this.canvas.width = Math.round(this.cw * this.dpr);
    this.canvas.height = Math.round(this.ch * this.dpr);
    this.layout();
  }

  /** 讓舞台以「填滿並置中」的方式鋪滿視窗。 */
  layout(): void {
    const { stageW, stageH } = this.game;
    this.scale = Math.max(this.cw / stageW, this.ch / stageH);
    this.ox = (this.cw - stageW * this.scale) / 2;
    this.oy = (this.ch - stageH * this.scale) / 2;
  }

  toScreen(p: Vec): Vec {
    return { x: this.ox + p.x * this.scale, y: this.oy + p.y * this.scale };
  }

  toStage(x: number, y: number): Vec {
    return { x: (x - this.ox) / this.scale, y: (y - this.oy) / this.scale };
  }

  draw(now: number): void {
    const ctx = this.ctx;
    const g = this.game;
    const t = now / 1000;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#0b0d14';
    ctx.fillRect(0, 0, this.cw, this.ch);

    ctx.save();
    ctx.translate(this.ox, this.oy);
    ctx.scale(this.scale, this.scale);

    if (this.showVideo && this.video.readyState >= 2 && this.video.videoWidth > 0) {
      ctx.save();
      if (this.mirror) {
        ctx.translate(g.stageW, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(this.video, 0, 0, g.stageW, g.stageH);
      ctx.restore();
      ctx.fillStyle = 'rgba(8, 10, 20, 0.38)';
      ctx.fillRect(0, 0, g.stageW, g.stageH);
    } else {
      const grad = ctx.createRadialGradient(g.stageW / 2, g.stageH * 0.45, 40, g.stageW / 2, g.stageH / 2, g.stageW * 0.7);
      grad.addColorStop(0, '#1b2136');
      grad.addColorStop(1, '#0b0d14');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, g.stageW, g.stageH);
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const f of g.fades) this.drawFade(f, now);
    for (const s of g.strings) this.drawString(s, t);
    for (const b of g.breaks) this.drawBreak(b, now);
    for (const pv of [g.handPreview, g.pointerPreview]) if (pv) this.drawPreview(pv);
    this.drawParticles();
    this.drawHands();
    // 剪刀張開且夾著弦：標出會剪斷的位置
    for (const p of g.cutHints) {
      ctx.strokeStyle = '#ffd25a';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
      ctx.moveTo(p.x - 6, p.y - 6);
      ctx.lineTo(p.x + 6, p.y + 6);
      ctx.moveTo(p.x + 6, p.y - 6);
      ctx.lineTo(p.x - 6, p.y + 6);
      ctx.stroke();
    }
    if (g.mode === 'teach') for (const s of g.strings) this.drawLabel(s);

    ctx.restore();
    if (this.debug) this.drawDebug();
  }

  // ───────── 弦 ─────────

  private stringColor(s: AirString): string {
    const r = s.stressRatio;
    if (r < 0.8) return s.material.color;
    // 接近斷裂強度時逐漸變紅
    return mix(s.material.color, '#ff2d3d', clamp((r - 0.8) / 0.2, 0, 1));
  }

  private drawString(s: AirString, t: number): void {
    const ctx = this.ctx;
    const w = this.game.lineWidth(s);
    const color = this.stringColor(s);
    const selected = this.game.selected === s;
    const dx = s.b.x - s.a.x;
    const dy = s.b.y - s.a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dy / len;
    const ny = -dx / len;

    if (s.hook) {
      const path = new Path2D();
      path.moveTo(s.a.x, s.a.y);
      path.lineTo(s.hook.pos.x, s.hook.pos.y);
      path.lineTo(s.b.x, s.b.y);
      this.glowStroke(path, color, w, 0.5);
    } else if (s.vib) {
      const v = s.vib;
      const tau = t - v.t0;
      const n = Math.min(v.c.length, s.modes.count);
      let peak = 0;
      for (let i = 0; i < n; i++) {
        this.amp[i] = v.c[i] * Math.exp(-s.decay[i] * tau);
        peak = Math.max(peak, Math.abs(this.amp[i]));
      }
      const k = s.ppm * v.mag;
      const energy = clamp((peak * k) / ARC_FULL_PX, 0, 1);

      // 弦的真實波形（各簡正模態的疊加），用慢動作呈現：
      // 把時間放慢到基音每秒擺動 VIS_HZ 次，各泛音之間的頻率比例維持不變。
      const slow = (this.slowMo ? SLOW_HZ : VIS_HZ) / s.f0;
      this.shape.fill(0);
      this.echo.fill(0);
      for (let m = 0; m < n; m++) {
        const phase = 2 * Math.PI * s.modes.freq[m] * slow * tau;
        const a = this.amp[m] * Math.cos(phase) * k;
        const b = this.amp[m] * Math.cos(phase + 2.2 * (m + 1)) * k; // 殘影：稍早一點的波形
        const row = m * NPTS;
        for (let i = 0; i < NPTS; i++) {
          this.shape[i] += a * SIN[row + i];
          this.echo[i] += b * SIN[row + i];
        }
      }

      // 電弧：在波形上疊一層碎形鋸齒，強度跟著振動能量走，能量衰減後就平滑成單純的波。
      let arc = this.arcs.get(s);
      if (!arc) {
        arc = { at: -1e9, main: new Float32Array(NPTS), echo: new Float32Array(NPTS) };
        this.arcs.set(s, arc);
      }
      const ms = t * 1000;
      if (ms - arc.at > ARC_HOLD_MS || ms < arc.at) {
        fractal(arc.main);
        fractal(arc.echo);
        arc.at = ms;
      }
      // 放大倍率很高的弦（例如被共鳴帶動的弦）實際振幅極小，電弧效果跟著收斂，不要喧賓奪主
      const calm = clamp(10 / v.mag, 0.2, 1);
      const jag = this.slowMo ? 0 : Math.min(26, 5 + 0.5 * peak * k) * Math.pow(energy, 0.7) * calm;
      const main = new Path2D();
      const ghost = new Path2D();
      for (let i = 0; i < NPTS; i++) {
        const u = i / (NPTS - 1);
        const bx = s.a.x + dx * u;
        const by = s.a.y + dy * u;
        const y1 = this.shape[i] + arc.main[i] * jag;
        const y2 = this.echo[i] * 0.8 + arc.echo[i] * jag * 1.3;
        if (i === 0) {
          main.moveTo(bx, by);
          ghost.moveTo(bx, by);
        } else {
          main.lineTo(bx + nx * y1, by + ny * y1);
          ghost.lineTo(bx + nx * y2, by + ny * y2);
        }
      }

      ctx.globalCompositeOperation = 'lighter';
      ctx.lineJoin = 'miter';
      ctx.miterLimit = 3;
      ctx.strokeStyle = color;
      // 外圈光暈 → 內圈光暈 → 有顏色的弧（帶柔光）→ 白熱的芯
      // 光暈用幾層由寬到窄、由淡到濃的線疊出柔和的漸層，不留硬邊
      for (const [extra, alpha] of HALO.slice(HALO.length - this.haloLayers)) {
        ctx.globalAlpha = alpha * (0.45 + 0.55 * energy);
        ctx.lineWidth = w * 1.6 + extra * (0.35 + 0.65 * energy);
        ctx.stroke(main);
      }
      if (this.softGlow) {
        ctx.shadowColor = color;
        ctx.shadowBlur = (6 + 20 * energy) * this.scale * this.dpr;
      }
      ctx.globalAlpha = 1;
      ctx.lineWidth = w + 2.2 * energy;
      ctx.stroke(main);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#ffffff';
      ctx.globalAlpha = 0.45 + 0.55 * energy;
      ctx.lineWidth = Math.max(1.1, w * 0.6 + 0.8 * energy);
      ctx.stroke(main);
      // 細的殘影弧
      ctx.strokeStyle = color;
      ctx.globalAlpha = this.slowMo ? 0 : 0.65 * energy;
      ctx.lineWidth = 1.3;
      ctx.stroke(ghost);
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    } else {
      const path = new Path2D();
      path.moveTo(s.a.x, s.a.y);
      path.lineTo(s.b.x, s.b.y);
      this.glowStroke(path, color, w, selected ? 0.35 : 0.15);
    }

    if (this.game.mode === 'teach') this.drawRuler(s, color, selected, dx, dy, len, nx, ny);

    // 輕觸點：手指（或滑鼠放的觸點）碰著弦的位置
    const tu = s.touchU;
    if (tu !== null) {
      const px = s.a.x + dx * tu;
      const py = s.a.y + dy * tu;
      ctx.strokeStyle = '#ffffff';
      ctx.fillStyle = 'rgba(255, 210, 90, 0.95)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(px, py - 8);
      ctx.lineTo(px + 6, py);
      ctx.lineTo(px, py + 8);
      ctx.lineTo(px - 6, py);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // 端點：小圓加一道垂直短線
    ctx.strokeStyle = color;
    ctx.fillStyle = '#0b0d14';
    ctx.lineWidth = 1.6;
    for (const e of [s.a, s.b]) {
      ctx.beginPath();
      ctx.moveTo(e.x + nx * 9, e.y + ny * 9);
      ctx.lineTo(e.x - nx * 9, e.y - ny * 9);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(e.x, e.y, selected ? 5 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  /**
   * 教學模式的尺規：從 a 端起每 5 公分一小格、每 10 公分一大格（真實長度）；
   * 選取中或正被輕觸的弦再標出 1/2、1/3、1/4 等節點位置。
   */
  private drawRuler(
    s: AirString, color: string, selected: boolean, dx: number, dy: number, len: number, nx: number, ny: number,
  ): void {
    const ctx = this.ctx;
    // 刻度一律畫在弦的下方（標籤在上方）
    const sx = ny > 0 ? nx : -nx;
    const sy = ny > 0 ? ny : -ny;
    const ux = dx / len;
    const uy = dy / len;
    const step = 0.05 * s.ppm;
    if (step >= 7) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 1, d = step; d < len - 3; i++, d += step) {
        const h = i % 2 === 0 ? 9 : 5;
        const x = s.a.x + ux * d;
        const y = s.a.y + uy * d;
        ctx.moveTo(x, y);
        ctx.lineTo(x + sx * h, y + sy * h);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    const tu = s.touchU;
    if (!selected && tu === null) return;
    const hit = tu === null ? null : P.nearestNode(tu);
    const fs = 12 / this.scale;
    ctx.font = `600 ${fs}px system-ui, "Noto Sans TC", "Microsoft JhengHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [k, n] of NODES) {
      const x = s.a.x + dx * (k / n);
      const y = s.a.y + dy * (k / n);
      const on = hit !== null && hit.k === k && hit.n === n;
      ctx.beginPath();
      ctx.arc(x, y, on ? 5 : 3.4, 0, Math.PI * 2);
      ctx.fillStyle = on ? '#ffd25a' : '#0b0d14';
      ctx.fill();
      ctx.strokeStyle = on ? '#ffffff' : '#ffd25a';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      const tx = x + sx * (22 / this.scale);
      const ty = y + sy * (22 / this.scale);
      ctx.lineWidth = 3 / this.scale;
      ctx.strokeStyle = 'rgba(8, 10, 20, 0.8)';
      ctx.strokeText(`${k}/${n}`, tx, ty);
      ctx.fillStyle = on ? '#ffffff' : 'rgba(255, 210, 90, 0.9)';
      ctx.fillText(`${k}/${n}`, tx, ty);
    }
  }

  private glowStroke(path: Path2D, color: string, w: number, glow: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.globalAlpha = glow * 0.5;
    ctx.lineWidth = w * 5;
    ctx.stroke(path);
    ctx.globalAlpha = glow;
    ctx.lineWidth = w * 2.4;
    ctx.stroke(path);
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = w;
    ctx.stroke(path);
    ctx.globalAlpha = 1;
  }

  private drawLabel(s: AirString): void {
    const ctx = this.ctx;
    const selected = this.game.selected === s;
    let text = stringLabel(
      { materialName: s.material.name, length: s.length, tension: s.tension, f0: s.f0 }, this.game.grade, selected,
    );
    if (s.muted) text += ' · 止音中';
    if (s.vib && s.vib.mag > 1.5) text += ` · 振幅 ×${s.vib.mag.toFixed(0)}`;
    if (s.vib && this.slowMo) text += ` · 慢動作 1/${Math.max(1, Math.round(s.f0 / SLOW_HZ))}`;

    const mx = (s.a.x + s.b.x) / 2;
    const my = (s.a.y + s.b.y) / 2;
    const dx = s.b.x - s.a.x;
    const dy = s.b.y - s.a.y;
    const len = Math.hypot(dx, dy) || 1;
    // 標籤放在弦的上方
    let nx = dy / len;
    let ny = -dx / len;
    if (ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    const fs = (selected ? 14 : 12) / this.scale;
    const off = (s.vib ? 30 : 18) / this.scale;
    ctx.font = `${selected ? 600 : 500} ${fs}px system-ui, "Noto Sans TC", "Microsoft JhengHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const x = mx + nx * off;
    const y = my + ny * off;
    ctx.lineWidth = 3 / this.scale;
    ctx.strokeStyle = 'rgba(8, 10, 20, 0.75)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = selected ? '#ffffff' : 'rgba(255, 255, 255, 0.72)';
    ctx.fillText(text, x, y);
  }

  private drawPreview(pv: { a: Vec; b: Vec; ppm: number }): void {
    const ctx = this.ctx;
    const g = this.game;
    const m = g.material;
    ctx.save();
    ctx.setLineDash([8, 7]);
    ctx.strokeStyle = m.color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(pv.a.x, pv.a.y);
    ctx.lineTo(pv.b.x, pv.b.y);
    ctx.stroke();
    ctx.restore();

    if (g.mode !== 'teach') return;
    const set = g.settingsFor(m);
    const L = Math.hypot(pv.b.x - pv.a.x, pv.b.y - pv.a.y) / pv.ppm;
    if (L < 0.01) return;
    const f = P.fundamental(m, set.diameter, set.tension, L);
    const pitch = g.grade === 'elementary' ? fmtNote(f, g.grade) : `${fmtFreq(f, g.grade)} · ${fmtNote(f, g.grade)}`;
    const text = `${m.name} ${fmtLength(L, g.grade)} → ${pitch}`;
    const fs = 15 / this.scale;
    ctx.font = `600 ${fs}px system-ui, "Noto Sans TC", "Microsoft JhengHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const x = (pv.a.x + pv.b.x) / 2;
    const y = Math.min(pv.a.y, pv.b.y) - 26 / this.scale;
    ctx.lineWidth = 3.5 / this.scale;
    ctx.strokeStyle = 'rgba(8, 10, 20, 0.8)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x, y);
  }

  private drawBreak(b: { a: Vec; b: Vec; u: number; t0: number; color: string; width: number }, now: number): void {
    const ctx = this.ctx;
    const k = clamp((now - b.t0) / 700, 0, 1);
    const recoil = 1 - Math.pow(1 - Math.min(k * 2.2, 1), 3); // 兩截弦迅速縮回端點
    const bx = b.a.x + (b.b.x - b.a.x) * b.u;
    const by = b.a.y + (b.b.y - b.a.y) * b.u;
    const len = Math.hypot(b.b.x - b.a.x, b.b.y - b.a.y) || 1;
    const nx = (b.b.y - b.a.y) / len;
    const ny = -(b.b.x - b.a.x) / len;
    ctx.strokeStyle = b.color;
    ctx.lineWidth = b.width;
    ctx.globalAlpha = 1 - k;
    for (const end of [b.a, b.b]) {
      const tipX = bx + (end.x - bx) * recoil * 0.85;
      const tipY = by + (end.y - by) * recoil * 0.85;
      ctx.beginPath();
      ctx.moveTo(end.x, end.y);
      const whip = Math.sin(k * 40) * 14 * (1 - k);
      ctx.quadraticCurveTo((end.x + tipX) / 2 + nx * whip, (end.y + tipY) / 2 + ny * whip, tipX, tipY);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawFade(f: { a: Vec; b: Vec; t0: number; color: string; width: number }, now: number): void {
    const ctx = this.ctx;
    ctx.globalAlpha = 1 - clamp((now - f.t0) / 450, 0, 1);
    ctx.strokeStyle = f.color;
    ctx.lineWidth = f.width;
    ctx.beginPath();
    ctx.moveTo(f.a.x, f.a.y);
    ctx.lineTo(f.b.x, f.b.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawParticles(): void {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.game.particles) {
      ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 0.025, p.y - p.vy * 0.025);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ───────── 手 ─────────

  private drawHands(): void {
    const ctx = this.ctx;
    for (const h of this.tracker.hands) {
      if (!h.present || h.lm.length < 21) continue;
      // 張開的手掌：畫出掌心的止音範圍，真的按住弦時填滿
      if (h.openPalm) {
        const muting = this.game.palmMuting[h.slot];
        ctx.beginPath();
        ctx.arc(h.palm.x, h.palm.y, 0.04 * h.ppm, 0, Math.PI * 2);
        ctx.fillStyle = muting ? 'rgba(255, 255, 255, 0.28)' : 'rgba(255, 255, 255, 0.07)';
        ctx.fill();
        ctx.strokeStyle = muting ? 'rgba(255, 255, 255, 0.9)' : 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(64, 255, 122, 0.9)';
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      for (const [a, b] of BONES) {
        ctx.moveTo(h.lm[a].x, h.lm[a].y);
        ctx.lineTo(h.lm[b].x, h.lm[b].y);
      }
      ctx.stroke();
      ctx.fillStyle = '#ff2f45';
      for (const p of h.lm) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.4, 0, Math.PI * 2);
        ctx.fill();
      }

      if (this.game.pinchActive[h.slot]) {
        ctx.strokeStyle = '#ffffff';
        ctx.fillStyle = 'rgba(255, 210, 90, 0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(h.pinchPos.x, h.pinchPos.y, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else if (h.vPose) {
        // 剪刀：把食指和中指畫成兩片刀刃
        ctx.strokeStyle = '#ffd25a';
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.moveTo(h.lm[6].x, h.lm[6].y);
        ctx.lineTo(h.lm[8].x, h.lm[8].y);
        ctx.moveTo(h.lm[10].x, h.lm[10].y);
        ctx.lineTo(h.lm[12].x, h.lm[12].y);
        ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(h.tip.x, h.tip.y, 6.5, 0, Math.PI * 2);
        ctx.stroke();
        const d = this.dwell[h.slot];
        if (d > 0) {
          ctx.strokeStyle = '#ffd25a';
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.arc(h.tip.x, h.tip.y, 15, -Math.PI / 2, -Math.PI / 2 + d * Math.PI * 2);
          ctx.stroke();
        }
      }
    }
  }

  private drawDebug(): void {
    const ctx = this.ctx;
    ctx.font = '12px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(8, this.ch - 20 - this.debugLines.length * 15, 430, this.debugLines.length * 15 + 12);
    ctx.fillStyle = '#9dffb0';
    this.debugLines.forEach((line, i) => ctx.fillText(line, 14, this.ch - 14 - (this.debugLines.length - i) * 15));
  }
}

function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) =>
    Math.round((((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t));
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}
