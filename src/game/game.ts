// 遊戲邏輯：拉弦、拖曳端點、搬移、剪斷、勾弦與滑脫、止音、泛音、共鳴、斷弦。
// 座標一律用「舞台座標」（攝影機畫面的像素，已鏡像）；物理量一律用 SI 單位。

import type { AudioEngine } from '../audio/engine';
import { MATERIALS, type Material } from '../physics/materials';
import * as P from '../physics/string';
import type { Grade, PluckRecord } from '../teach/tasks';
import type { TrackedHand } from '../tracking/hands';
import { type Vec, clamp, crossing, dist, project } from '../util/math';

export const MAX_STRINGS = 12;
/** 弦的最短長度（公尺） */
export const MIN_LENGTH = 0.04;
/** 畫面上用來畫波形的模態數 */
export const VIZ_MODES = 20;
/** 撥弦力道的參考值（N）：這麼大的力對應滿刻度音量 */
const FORCE_REF = 10;
/** 振動一開始在畫面上至少要有這麼多像素，太小就放大顯示 */
const VIZ_TARGET_PX = 22;
/** 滑鼠／觸控模式假設畫面寬度相當於幾公尺 */
const POINTER_STAGE_METERS = 1.2;
/** 手部追蹤的抖動量級（公尺）：指尖越過弦至少這麼遠才算真的撥到，避免貼著弦時連續誤觸 */
const TRACK_NOISE = 0.003;
/** 放掉端點後多久之內再捏合可以直接抓回同一個端點（毫秒） */
const REGRAB_MS = 450;
/** 剛撥完弦之後這段時間內出現的捏合視為誤判（毫秒）：撥弦時拇指尖常會在畫面上貼近食指尖 */
const PLUCK_GUARD_MS = 300;
/** 捏住弦身多久之後才開始搬移（毫秒）：這段時間內另一隻手也捏合的話，視為要拉新弦 */
const CARRY_DELAY = 180;
/** 剪刀手勢：兩指尖距離大於 OPEN 算張開、小於 CLOSE 算合起（公尺） */
const CUT_OPEN = 0.045;
const CUT_CLOSE = 0.03;
/** 弦離開兩指之間後，多久之內合起剪刀仍算剪到（毫秒） */
const CUT_MEMORY = 500;
/** 滑鼠在遊戲裡使用的指尖編號（0、1 是兩隻手） */
const POINTER_KEY = 2;
/** 手掌止音：掌心離弦這麼近（公尺）就算按住 */
const PALM_RADIUS = 0.04;
/** 輕觸（泛音）：指尖停在離弦這麼近的範圍內（公尺）、速度低於 MAX_SPEED（m/s）、持續 DWELL 毫秒 */
const TOUCH_BAND = 0.005;
const TOUCH_MAX_SPEED = 0.08;
const TOUCH_DWELL_MS = 180;
/** 輕觸中的指尖離弦超過這個距離（公尺）就算離開 */
const TOUCH_RELEASE = 0.012;
/** 共鳴最多帶動目標弦的前幾個模態 */
const SYMPATHETIC_MODES = 12;
/** 被帶動的弦振幅很小，畫面上放大到至少這麼多像素 */
const SYMPATHETIC_PX = 7;
/** 被帶動的力道至少要達到來源弦最強泛音的這個比例，才算發生共鳴 */
const SYMPATHETIC_MIN_RATIO = 0.02;

export type Mode = 'teach' | 'exhibit';

/** 遊戲裡發生的事（任務卡用來判定完成）。 */
export interface GameEvents {
  onPluck?(rec: PluckRecord): void;
  onBreak?(info: { materialId: string; tension: number }): void;
  onResonate?(): void;
  onMute?(): void;
}

export interface Vib {
  /** 開始振動的時間（秒） */
  t0: number;
  /** 各模態的位移振幅（公尺），對應 t0 時刻 */
  c: Float32Array;
  /** 畫面上的振幅放大倍率 */
  mag: number;
}

export interface Hook {
  key: number;
  /** 指尖原本在弦的哪一側（±1） */
  side: number;
  /** 勾住的位置（0〜1） */
  u: number;
  pos: Vec;
  /** 指尖速度的峰值（m/s） */
  speed: number;
}

let nextId = 1;

export class AirString {
  readonly id = nextId++;
  length = 0;
  f0 = 0;
  modes!: P.ModeSet;
  /** 各模態實際的衰減率：弦本身的阻尼，加上手掌止音與手指輕觸的影響 */
  decay!: Float32Array;
  /** 手掌是否正按在這條弦上 */
  muted = false;
  /** 手指輕觸的位置（key 是哪個指尖） */
  touch: {
    key: number;
    u: number;
    /** 手指是從弦的哪一側靠上來的（±1，0 = 不確定） */
    side: number;
    /** 輕觸期間這條弦有沒有被撥過（有的話就是在做泛音） */
    used: boolean;
  } | null = null;
  /** 滑鼠模式放置的輕觸點（0〜1） */
  pin: number | null = null;
  vib: Vib | null = null;
  hook: Hook | null = null;

  constructor(
    public a: Vec,
    public b: Vec,
    /** 這條弦所在深度的比例尺（每公尺幾個像素） */
    public ppm: number,
    public material: Material,
    public diameter: number,
    public tension: number,
    public born: number,
    private maxModes: number,
  ) {
    this.refresh();
  }

  /** 幾何或參數改變後重算長度與模態。 */
  refresh(): void {
    this.length = Math.max(dist(this.a, this.b) / this.ppm, 1e-3);
    this.modes = P.computeModes(this.material, this.diameter, this.tension, this.length, this.maxModes);
    this.f0 = this.modes.freq[0];
    this.applyDamping();
  }

  /** 目前輕觸點的位置（手指優先，其次是滑鼠放的觸點）。 */
  get touchU(): number | null {
    return this.touch ? this.touch.u : this.pin;
  }

  /** 依目前的止音／輕觸狀態重算各模態的衰減率。 */
  applyDamping(): void {
    this.decay = P.effectiveDecay(this.modes.decay, this.muted ? P.PALM_DAMPING : 0, this.touchU);
  }

  get stressRatio(): number {
    return P.stressRatio(this.material, this.diameter, this.tension);
  }

  /** 把目前的衰減折算進振幅，讓之後可以換一組新的模態參數接著算。 */
  rebase(tSec: number): void {
    const v = this.vib;
    if (!v) return;
    const tau = tSec - v.t0;
    for (let i = 0; i < v.c.length; i++) {
      v.c[i] *= i < this.modes.count ? Math.exp(-this.decay[i] * tau) : 0;
    }
    v.t0 = tSec;
  }

  /** 目前畫面上的最大振幅（像素，含放大倍率）。 */
  vibPeakPx(tSec: number): number {
    const v = this.vib;
    if (!v) return 0;
    const tau = tSec - v.t0;
    let peak = 0;
    const n = Math.min(v.c.length, this.modes.count);
    for (let i = 0; i < n; i++) {
      const a = Math.abs(v.c[i]) * Math.exp(-this.decay[i] * tau);
      if (a > peak) peak = a;
    }
    return peak * this.ppm * v.mag;
  }
}

export interface Preview {
  a: Vec;
  b: Vec;
  ppm: number;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
}

export interface BreakAnim {
  a: Vec;
  b: Vec;
  /** 斷點位置（0〜1） */
  u: number;
  t0: number;
  color: string;
  width: number;
}

export interface FadeAnim {
  a: Vec;
  b: Vec;
  t0: number;
  color: string;
  width: number;
}

interface SlotState {
  active: boolean;
  /** 追蹤器回報的捏合狀態（上一格） */
  rawPinching: boolean;
  /** 這次捏合被判定為撥弦動作造成的誤判，放開之前都不算數 */
  blocked: boolean;
  wasPinching: boolean;
  grab: { s: AirString; end: 0 | 1 } | null;
  /** 剛放掉的端點：短時間內再捏一次可以直接抓回來 */
  lastGrab: { s: AirString; end: 0 | 1; at: number } | null;
  /** 這次捏合沒有抓到任何端點，可以用來拉出新的弦 */
  free: boolean;
  /** 捏在某條弦的弦身上，等一小段時間確認不是要拉新弦 */
  carryCand: { s: AirString; at: number } | null;
  /** 正提著整條弦搬移：off 是端點 a 相對於捏合點的位置 */
  carry: { s: AirString; off: Vec } | null;
  /** 剪刀張開時夾在兩指之間的弦與位置 */
  cut: { s: AirString; u: number; at: number } | null;
}

interface TipState {
  prev: Vec | null;
  /** 指尖開始停在各條弦附近的時間（弦的 id → 毫秒），用來判斷輕觸 */
  near: Map<number, { since: number; side: number }>;
  noPluckUntil: number;
  /** 這個指尖最近一次撥響弦的時間 */
  lastPluckAt: number;
}

export class Game {
  strings: AirString[] = [];
  breaks: BreakAnim[] = [];
  fades: FadeAnim[] = [];
  particles: Particle[] = [];

  material: Material = MATERIALS[0];
  selected: AirString | null = null;
  handPreview: Preview | null = null;
  pointerPreview: Preview | null = null;

  stageW = 1280;
  stageH = 720;
  /** 低階裝置降載：模態數與粒子數 */
  maxModes = 64;
  maxParticles = 420;
  /** 累計撥弦次數（提示文字用） */
  pluckCount = 0;
  /** 剪刀張開且夾著弦的位置（畫面上標示「會剪在這裡」） */
  cutHints: Vec[] = [];
  /** 兩隻手目前是否處於「有效的」捏合（排除撥弦造成的誤判），畫面上的捏合指示用這個 */
  pinchActive: boolean[] = [false, false];
  /** 兩隻手的手掌目前是否正按住某條弦 */
  palmMuting: boolean[] = [false, false];
  /** 教學模式顯示數據與面板；展覽模式只留弦與特效，並把音高吸附到音階 */
  mode: Mode = 'teach';
  /** 放手時要吸附的音階（音級 0〜11）；null = 不吸附 */
  snapScale: number[] | null = null;
  /** 年級：決定畫面上的用詞與數值格式 */
  grade: Grade = 'elementary';
  events: GameEvents = {};

  private settings = new Map<string, { diameter: number; tension: number }>();
  private slots: SlotState[] = [0, 1].map(() => ({
    active: false, rawPinching: false, blocked: false, wasPinching: false, grab: null, lastGrab: null, free: false,
    carryCand: null, carry: null, cut: null,
  }));
  private tips: TipState[] = [0, 1, 2].map(() => ({ prev: null, near: new Map(), noPluckUntil: 0, lastPluckAt: -1e9 }));
  private pointer: {
    anchor: Vec | null;
    grab: { s: AirString; end: 0 | 1 } | null;
    carry: { s: AirString; off: Vec } | null;
    lastT: number;
    last: Vec | null;
    vel: Vec;
  } = { anchor: null, grab: null, carry: null, lastT: 0, last: null, vel: { x: 0, y: 0 } };

  constructor(private audio: AudioEngine) {}

  setStage(w: number, h: number): void {
    this.stageW = w;
    this.stageH = h;
  }

  // ───────── 材質與參數 ─────────

  /** 某材質「下一條弦」要用的直徑與張力。 */
  settingsFor(m: Material): { diameter: number; tension: number } {
    let s = this.settings.get(m.id);
    if (!s) {
      s = { diameter: m.defaultDiameter, tension: m.defaultTension };
      this.settings.set(m.id, s);
    }
    return s;
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.snapScale = mode === 'exhibit' ? P.PENTATONIC : null;
  }

  setMaterial(m: Material): void {
    this.material = m;
    this.selected = null;
  }

  select(s: AirString | null): void {
    this.selected = s;
  }

  /** 設定張力：有選取的弦就改那條（超過強度會斷），否則改下一條弦的設定。 */
  setTension(tension: number, now: number): void {
    const s = this.selected;
    if (s) {
      s.rebase(now / 1000);
      s.tension = tension;
      if (s.stressRatio >= 1) {
        this.breakString(s, now);
        return;
      }
      this.settingsFor(s.material).tension = tension;
      this.paramsChanged(s);
    } else {
      const set = this.settingsFor(this.material);
      set.tension = Math.min(tension, P.breakingTension(this.material, set.diameter) * 0.95);
    }
  }

  /** 設定直徑：變細會讓同樣的張力產生更大的應力，可能因此斷掉。 */
  setDiameter(diameter: number, now: number): void {
    const s = this.selected;
    if (s) {
      s.rebase(now / 1000);
      s.diameter = diameter;
      if (s.stressRatio >= 1) {
        this.breakString(s, now);
        return;
      }
      this.settingsFor(s.material).diameter = diameter;
      this.paramsChanged(s);
    } else {
      const set = this.settingsFor(this.material);
      set.diameter = diameter;
      set.tension = Math.min(set.tension, P.breakingTension(this.material, diameter) * 0.95);
    }
  }

  private paramsChanged(s: AirString): void {
    s.refresh();
    if (s.vib) this.audio.retune(s.id, s.modes.freq, s.decay, this.pan(s));
  }

  /** 止音或輕觸的狀態改變：衰減率變了，但頻率不變。 */
  private dampingChanged(s: AirString, now: number): void {
    s.rebase(now / 1000);
    s.applyDamping();
    if (s.vib) this.audio.retune(s.id, s.modes.freq, s.decay, this.pan(s));
  }

  /**
   * 展覽模式：把弦長微調到音階上最近的音。
   * fixed 是保持不動的那一端（null = 兩端一起往中點伸縮）。
   */
  private snapLength(s: AirString, fixed: 0 | 1 | null, now: number): void {
    if (!this.snapScale) return;
    s.rebase(now / 1000);
    // 泛音略偏高（非諧性）使頻率不完全與弦長成反比，多修正幾次就會收斂
    for (let i = 0; i < 3; i++) {
      const k = s.f0 / P.snapFrequency(s.f0, this.snapScale);
      const { a, b } = s;
      if (fixed === 0) {
        s.b = this.clampToStage({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
      } else if (fixed === 1) {
        s.a = this.clampToStage({ x: b.x + (a.x - b.x) * k, y: b.y + (a.y - b.y) * k });
      } else {
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        s.a = this.clampToStage({ x: mx + (a.x - mx) * k, y: my + (a.y - my) * k });
        s.b = this.clampToStage({ x: mx + (b.x - mx) * k, y: my + (b.y - my) * k });
      }
      s.refresh();
    }
    this.paramsChanged(s);
  }

  // ───────── 弦的生滅 ─────────

  createString(a: Vec, b: Vec, ppm: number, now: number): AirString | null {
    const pa = this.clampToStage(a);
    const pb = this.clampToStage(b);
    if (dist(pa, pb) / ppm < MIN_LENGTH) return null;
    const set = this.settingsFor(this.material);
    const s = new AirString(pa, pb, ppm, this.material, set.diameter, set.tension, now, this.maxModes);
    this.snapLength(s, null, now);
    this.strings.push(s);
    while (this.strings.length > MAX_STRINGS) this.retire(this.strings[0], now);
    this.selected = s;
    this.burst((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, s.material.color, 10, 90);
    return s;
  }

  /** 讓一條弦淡出消失（超過數量上限或全部清除時）。 */
  private retire(s: AirString, now: number): void {
    this.detach(s);
    this.audio.damp(s.id, 40);
    this.fades.push({ a: s.a, b: s.b, t0: now, color: s.material.color, width: this.lineWidth(s) });
  }

  clearAll(now: number): void {
    for (const s of [...this.strings]) this.retire(s, now);
    this.audio.clear();
  }

  /** 弦在位置 u 斷成兩截彈開。 */
  private sever(s: AirString, u: number, now: number, loud: boolean): void {
    this.detach(s);
    this.audio.damp(s.id, 400);
    this.audio.snap(loud ? 0.65 : 0.4);
    this.breaks.push({ a: s.a, b: s.b, u, t0: now, color: s.material.color, width: this.lineWidth(s) });
    const x = s.a.x + (s.b.x - s.a.x) * u;
    const y = s.a.y + (s.b.y - s.a.y) * u;
    if (loud) this.burst(x, y, '#ffffff', 36, 420);
    else this.burst(x, y, s.material.color, 18, 260);
  }

  /** 用剪刀在位置 u 把弦剪斷。 */
  cutString(s: AirString, u: number, now: number): void {
    if (this.strings.includes(s)) this.sever(s, clamp(u, 0.02, 0.98), now, false);
  }

  /** 剪斷目前選取的弦（Delete 鍵、面板按鈕）。 */
  deleteSelected(now: number): void {
    if (this.selected) this.cutString(this.selected, 0.5, now);
  }

  /** 張力超過強度而繃斷。 */
  breakString(s: AirString, now: number): void {
    this.sever(s, 0.15 + Math.random() * 0.7, now, true);
    this.events.onBreak?.({ materialId: s.material.id, tension: s.tension });
    // 斷掉之後把這個材質的張力設定退回預設值，下一條弦才不會一拉出來就斷
    const set = this.settingsFor(s.material);
    set.tension = Math.min(s.material.defaultTension, P.breakingTension(s.material, set.diameter) * 0.6);
  }

  private detach(s: AirString): void {
    const i = this.strings.indexOf(s);
    if (i >= 0) this.strings.splice(i, 1);
    if (this.selected === s) this.selected = null;
    for (const st of this.slots) {
      if (st.grab?.s === s) st.grab = null;
      if (st.carry?.s === s) st.carry = null;
      if (st.carryCand?.s === s) st.carryCand = null;
      if (st.cut?.s === s) st.cut = null;
    }
    if (this.pointer.grab?.s === s) this.pointer.grab = null;
    if (this.pointer.carry?.s === s) this.pointer.carry = null;
    s.hook = null;
    s.vib = null;
  }

  lineWidth(s: AirString): number {
    return clamp(0.9 + s.diameter * 1000 * 1.3, 1.3, 5.5);
  }

  private pan(s: AirString): number {
    return clamp((((s.a.x + s.b.x) / 2 / this.stageW) * 2 - 1) * 0.7, -1, 1);
  }

  private clampToStage(p: Vec): Vec {
    return { x: clamp(p.x, 0, this.stageW), y: clamp(p.y, 0, this.stageH) };
  }

  private findEndpoint(pos: Vec, radius: number): { s: AirString; end: 0 | 1 } | null {
    let best: { s: AirString; end: 0 | 1 } | null = null;
    let bestD = radius;
    for (const s of this.strings) {
      const da = dist(pos, s.a);
      const db = dist(pos, s.b);
      if (da < bestD) {
        bestD = da;
        best = { s, end: 0 };
      }
      if (db < bestD) {
        bestD = db;
        best = { s, end: 1 };
      }
    }
    return best;
  }

  /** 找出離 pos 最近的弦身（不含靠近端點的部分，端點優先用來改長度）。 */
  private findBody(pos: Vec, radius: number): AirString | null {
    let best: AirString | null = null;
    let bestD = radius;
    for (const s of this.strings) {
      const { u, d } = project(pos, s.a, s.b);
      if (u < 0.05 || u > 0.95) continue;
      if (Math.abs(d) < bestD) {
        bestD = Math.abs(d);
        best = s;
      }
    }
    return best;
  }

  /** 整條弦平移到端點 a 位於 target 的位置；長度與方向不變，且不會被推出畫面。 */
  private translate(s: AirString, target: Vec): void {
    const vx = s.b.x - s.a.x;
    const vy = s.b.y - s.a.y;
    const ax = clamp(target.x, Math.max(0, -vx), Math.min(this.stageW, this.stageW - vx));
    const ay = clamp(target.y, Math.max(0, -vy), Math.min(this.stageH, this.stageH - vy));
    s.a = { x: ax, y: ay };
    s.b = { x: ax + vx, y: ay + vy };
  }

  private moveEndpoint(s: AirString, end: 0 | 1, target: Vec, now: number): void {
    const other = end === 0 ? s.b : s.a;
    let p = this.clampToStage(target);
    const minPx = MIN_LENGTH * s.ppm;
    const d = dist(p, other);
    if (d < minPx) {
      if (d < 1e-3) return;
      p = { x: other.x + ((p.x - other.x) / d) * minPx, y: other.y + ((p.y - other.y) / d) * minPx };
    }
    s.rebase(now / 1000);
    if (end === 0) s.a = p;
    else s.b = p;
    this.paramsChanged(s);
  }

  // ───────── 手勢 ─────────

  /** 每次手部追蹤有新結果時呼叫。 */
  updateHands(hands: TrackedHand[], now: number): void {
    for (const h of hands) {
      const st = this.slots[h.slot];
      if (!h.present) {
        this.pinchActive[h.slot] = false;
        if (st.active) {
          st.active = false;
          st.rawPinching = false;
          st.blocked = false;
          st.wasPinching = false;
          if (st.grab) {
            st.lastGrab = { ...st.grab, at: now };
            this.snapLength(st.grab.s, st.grab.end === 0 ? 1 : 0, now);
          }
          st.grab = null;
          st.free = false;
          st.carry = null;
          st.carryCand = null;
          st.cut = null;
          this.tipGone(h.slot, true, now);
        }
        continue;
      }
      st.active = true;

      // 剛撥完弦、或食指正勾著弦的時候冒出來的捏合，是撥弦動作造成的誤判
      if (h.pinching && !st.rawPinching) {
        st.blocked =
          now - this.tips[h.slot].lastPluckAt < PLUCK_GUARD_MS || this.strings.some((s) => s.hook?.key === h.slot);
      } else if (!h.pinching) {
        st.blocked = false;
      }
      st.rawPinching = h.pinching;
      const pinching = h.pinching && !st.blocked;
      this.pinchActive[h.slot] = pinching;

      if (pinching && !st.wasPinching) {
        const radius = Math.max(24, 0.035 * h.ppm);
        let g = this.findEndpoint(h.pinchPos, radius);
        const lg = st.lastGrab;
        if (!g && lg && now - lg.at < REGRAB_MS && this.strings.includes(lg.s)) {
          const end = lg.end === 0 ? lg.s.a : lg.s.b;
          if (dist(h.pinchPos, end) < radius * 3.5) g = { s: lg.s, end: lg.end };
        }
        if (g) {
          st.grab = g;
          this.selected = g.s;
        } else {
          st.free = true;
          const body = this.findBody(h.pinchPos, Math.max(22, 0.03 * h.ppm));
          st.carryCand = body ? { s: body, at: now } : null;
        }
        st.cut = null;
        this.tipGone(h.slot, false, now);
      } else if (!pinching && st.wasPinching) {
        if (st.grab) {
          st.lastGrab = { ...st.grab, at: now };
          this.snapLength(st.grab.s, st.grab.end === 0 ? 1 : 0, now);
        }
        st.grab = null;
        st.free = false;
        st.carry = null;
        st.carryCand = null;
        // 手指張開的瞬間食指會掃過剛放下的弦，給一小段緩衝時間不撥弦
        this.tips[h.slot].noPluckUntil = now + 300;
        this.tips[h.slot].prev = null;
      }
      st.wasPinching = pinching;

      if (st.grab && h.pinchSolid) this.moveEndpoint(st.grab.s, st.grab.end, h.pinchPos, now);

      // 單手捏住弦身：等一下確認另一隻手沒有要一起拉新弦，就提著整條弦走
      if (st.carryCand && pinching) {
        const cand = st.carryCand;
        if (this.handPreview || !this.strings.includes(cand.s)) {
          st.carryCand = null;
        } else if (now - cand.at >= CARRY_DELAY) {
          st.carry = { s: cand.s, off: { x: cand.s.a.x - h.pinchPos.x, y: cand.s.a.y - h.pinchPos.y } };
          st.carryCand = null;
          st.free = false;
          this.selected = cand.s;
        }
      }
      if (st.carry && h.pinchSolid) {
        this.translate(st.carry.s, { x: h.pinchPos.x + st.carry.off.x, y: h.pinchPos.y + st.carry.off.y });
      }

      if (pinching) continue;
      if (h.vPose) {
        // 比剪刀時食指不撥弦
        this.tipGone(h.slot, false, now);
        this.updateScissors(h, st, now);
      } else {
        if (st.cut && now - st.cut.at > CUT_MEMORY) st.cut = null;
        this.tipMove(h.slot, h.tip, h.tipVel, now);
      }
    }

    // 手掌止音：張開的手掌（掌心）按在弦上，那條弦的所有模態都加速衰減
    this.palmMuting = [false, false];
    for (const s of this.strings) {
      let muted = false;
      for (const h of hands) {
        if (!h.present || !h.openPalm || this.pinchActive[h.slot]) continue;
        const { u, d } = project(h.palm, s.a, s.b);
        if (u > 0 && u < 1 && Math.abs(d) < PALM_RADIUS * h.ppm) {
          muted = true;
          this.palmMuting[h.slot] = true;
        }
      }
      if (muted !== s.muted) {
        if (muted && s.vib && s.vibPeakPx(now / 1000) > 1) this.events.onMute?.();
        s.muted = muted;
        this.dampingChanged(s, now);
      }
    }

    this.cutHints = [];
    for (const st of this.slots) {
      if (!st.active || !st.cut) continue;
      const { s, u } = st.cut;
      this.cutHints.push({ x: s.a.x + (s.b.x - s.a.x) * u, y: s.a.y + (s.b.y - s.a.y) * u });
    }

    // 兩手同時捏合且都沒有抓著端點 → 拉出新弦；任何一手放開就定住
    const [h0, h1] = hands;
    const both =
      h0.present && h1.present && this.pinchActive[0] && this.pinchActive[1] && this.slots[0].free && this.slots[1].free;
    if (both) {
      // 判定不穩的那幾格（手指正在張開）不更新位置，弦才會定在放手前的地方
      const pv = this.handPreview ?? { a: { ...h0.pinchPos }, b: { ...h1.pinchPos }, ppm: 0 };
      if (h0.pinchSolid) pv.a = { ...h0.pinchPos };
      if (h1.pinchSolid) pv.b = { ...h1.pinchPos };
      pv.ppm = (h0.ppm + h1.ppm) / 2;
      this.handPreview = pv;
    } else if (this.handPreview) {
      const pv = this.handPreview;
      this.handPreview = null;
      this.slots[0].free = false;
      this.slots[1].free = false;
      this.createString(pv.a, pv.b, pv.ppm, now);
    }
  }

  /** 剪刀張開時記住夾在兩指之間的弦，合起來就剪斷它。 */
  private updateScissors(h: TrackedHand, st: SlotState, now: number): void {
    if (h.vGap > CUT_OPEN) {
      // 依序檢查指尖、第一指節、第二指節之間的連線，弦夾得深一點也算
      let found: { s: AirString; u: number; at: number } | null = null;
      for (const [i, j] of [[8, 12], [7, 11], [6, 10]]) {
        for (const s of this.strings) {
          const hit = crossing(h.lm[i], h.lm[j], s.a, s.b);
          if (hit && hit.u > 0 && hit.u < 1) {
            found = { s, u: hit.u, at: now };
            break;
          }
        }
        if (found) break;
      }
      if (found) st.cut = found;
      else if (st.cut && now - st.cut.at > CUT_MEMORY) st.cut = null;
    } else if (h.vGap < CUT_CLOSE && st.cut) {
      const c = st.cut;
      st.cut = null;
      if (now - c.at <= CUT_MEMORY) this.cutString(c.s, c.u, now);
    }
  }

  // ───────── 勾弦與滑脫 ─────────

  private tipMove(key: number, tip: Vec, vel: Vec, now: number): void {
    const st = this.tips[key];
    const prev = st.prev;
    for (const s of this.strings) {
      // 輕觸（泛音）：指尖幾乎不動地停在弦上。滑鼠沒有第二根手指，改用右鍵放置觸點。
      if (key !== POINTER_KEY) {
        const { u, d } = project(tip, s.a, s.b);
        const off = Math.abs(d) / s.ppm;
        const speed = Math.hypot(vel.x, vel.y) / s.ppm;
        if (s.touch?.key === key) {
          if (u < 0.02 || u > 0.98 || off > TOUCH_RELEASE) {
            const was = s.touch;
            s.touch = null;
            st.near.delete(s.id);
            this.dampingChanged(s, now);
            // 手指只是停在弦上（沒有拿來做泛音），接著從另一側穿出去 → 這是一次慢慢的撥弦
            if (!was.used && was.side !== 0 && Math.sign(d) === -was.side && u > 0.02 && u < 0.98) {
              const grip = clamp(1 + 3 * speed, 1, FORCE_REF);
              const hSlip = Math.min(P.slipDisplacement(grip, s.tension, s.length, u), 0.35 * s.length);
              st.lastPluckAt = now;
              this.pluck(s, clamp(u, 0.03, 0.97), Math.min(off, hSlip), now);
            }
          } else if (Math.abs(u - s.touch.u) > 0.004) {
            s.touch.u = u;
            this.dampingChanged(s, now);
          }
          continue;
        }
        if (!s.touch && u > 0.02 && u < 0.98 && off < TOUCH_BAND && speed < TOUCH_MAX_SPEED) {
          let near = st.near.get(s.id);
          if (!near) {
            // 記下手指是從哪一側靠上來的：上一格還在範圍外時的那一側最可靠
            const before = prev ? project(prev, s.a, s.b).d : 0;
            near = { since: now, side: Math.abs(before) > TRACK_NOISE * s.ppm * 0.5 ? Math.sign(before) : 0 };
            st.near.set(s.id, near);
          }
          if (now - near.since >= TOUCH_DWELL_MS) {
            const side = s.hook?.key === key ? s.hook.side : near.side;
            if (s.hook?.key === key) s.hook = null;
            s.touch = { key, u, side, used: false };
            this.dampingChanged(s, now);
            continue;
          }
        } else {
          st.near.delete(s.id);
        }
      }

      if (s.hook) {
        if (s.hook.key === key) this.updateHook(s, tip, vel, now);
        continue;
      }
      if (!prev || now < st.noPluckUntil) continue;
      const hit = crossing(prev, tip, s.a, s.b);
      if (hit && hit.u > 0.02 && hit.u < 0.98) {
        // 手指一碰到弦，原本的振動就被手指吸收掉
        s.hook = { key, side: hit.side, u: hit.u, pos: { ...tip }, speed: 0 };
        s.vib = null;
        this.audio.damp(s.id, 150);
        this.updateHook(s, tip, vel, now);
      }
    }
    st.prev = { x: tip.x, y: tip.y };
  }

  private updateHook(s: AirString, tip: Vec, vel: Vec, now: number): void {
    const hk = s.hook;
    if (!hk) return;
    const { u, d } = project(tip, s.a, s.b);
    // 手指退回原本那一側 → 弦回到原位，不發聲
    if (d * hk.side > 0 && Math.abs(d) > TRACK_NOISE * s.ppm) {
      s.hook = null;
      return;
    }
    const speed = Math.hypot(vel.x, vel.y) / s.ppm;
    hk.speed = Math.max(hk.speed * 0.85, speed);
    // 指尖能勾住弦的最大力量：慢慢拉約 1 N，動作越快（越用力）越大
    const grip = clamp(1 + 3 * hk.speed, 1, FORCE_REF);
    const p = clamp(u, 0.03, 0.97);
    const hNow = Math.abs(d) / s.ppm;
    const hSlip = Math.min(P.slipDisplacement(grip, s.tension, s.length, p), 0.35 * s.length);
    // 指尖幾乎不動時把門檻放寬到輕觸的範圍，才分得出「停在弦上」和「撥過去」
    const floor = speed < TOUCH_MAX_SPEED && hk.key !== POINTER_KEY ? TOUCH_BAND : TRACK_NOISE;
    if (u <= 0 || u >= 1 || hNow >= Math.max(hSlip, floor)) {
      this.pluck(s, p, Math.min(hNow, hSlip), now);
      return;
    }
    hk.u = p;
    hk.pos = { x: tip.x, y: tip.y };
  }

  /** 指尖消失（手離開畫面或開始捏合）：sound = true 時把勾著的弦放開發聲。 */
  private tipGone(key: number, sound: boolean, now: number): void {
    for (const s of this.strings) {
      const hk = s.hook;
      if (!hk || hk.key !== key) continue;
      if (sound) {
        const { d } = project(hk.pos, s.a, s.b);
        this.pluck(s, hk.u, Math.abs(d) / s.ppm, now);
      } else {
        s.hook = null;
      }
    }
    for (const s of this.strings) {
      if (s.touch?.key === key) {
        s.touch = null;
        this.dampingChanged(s, now);
      }
    }
    this.tips[key].near.clear();
    this.tips[key].prev = null;
  }

  /** 在位置 p（0〜1）把弦拉開 h 公尺後放手。 */
  pluck(s: AirString, p: number, h: number, now: number): void {
    if (s.hook) this.tips[s.hook.key].lastPluckAt = now;
    if (s.touch) s.touch.used = true;
    const touchU = s.touchU;
    s.hook = null;
    if (h <= 1e-6) return;
    const L = s.length;
    const force = Math.min(P.holdForce(h, s.tension, L, p), FORCE_REF);
    const m = s.modes;

    const forceN = P.forceAmplitudes(force, p, L, m.count);
    this.audio.pluck(s.id, m.freq, forceN.map((x) => x / FORCE_REF), s.decay, this.pan(s));
    this.resonate(s, forceN, now);
    this.events.onPluck?.({
      stringId: s.id,
      materialId: s.material.id,
      tension: s.tension,
      diameter: s.diameter,
      length: s.length,
      f0: s.f0,
      touchNode: touchU === null ? null : P.nearestNode(touchU, 0.03),
    });

    s.vib = {
      t0: now / 1000,
      c: P.displacementAmplitudes(h, p, L, Math.min(VIZ_MODES, m.count)),
      mag: clamp(VIZ_TARGET_PX / (h * s.ppm), 1, 25),
    };
    this.selected = s;
    this.pluckCount++;

    const x = s.a.x + (s.b.x - s.a.x) * p;
    const y = s.a.y + (s.b.y - s.a.y) * p;
    this.burst(x, y, s.material.color, Math.round(6 + force * 4), 120 + force * 40);
  }

  /** 共鳴：剛被撥動的弦，把頻率相近的其他弦也微微帶動起來。 */
  private resonate(src: AirString, force: Float32Array, now: number): void {
    const t = now / 1000;
    let srcForce = 0;
    for (const x of force) srcForce = Math.max(srcForce, Math.abs(x));
    let resonated = false;
    for (const o of this.strings) {
      if (o === src || o.hook) continue;
      const k = Math.min(o.modes.count, SYMPATHETIC_MODES);
      const f = P.sympatheticForces(src.modes.freq, force, o.modes.freq, k);
      let peakF = 0;
      for (const x of f) peakF = Math.max(peakF, Math.abs(x));
      // 只有明顯的共鳴才算數：高次泛音之間偶然很接近的微弱耦合聽不到也看不到
      if (peakF < Math.max(0.005, SYMPATHETIC_MIN_RATIO * srcForce)) continue;

      this.audio.excite(
        o.id, o.modes.freq.subarray(0, k), f.map((x) => x / FORCE_REF), o.decay.subarray(0, k), this.pan(o),
      );

      o.rebase(t);
      const fresh = !o.vib;
      const v = o.vib ?? { t0: t, c: new Float32Array(Math.min(VIZ_MODES, o.modes.count)), mag: 1 };
      let peak = 0;
      for (let i = 0; i < v.c.length; i++) {
        // 端點受力振幅 → 位移振幅：c = F·L / (T·nπ)
        if (i < k) v.c[i] += (f[i] * o.length) / (o.tension * (i + 1) * Math.PI);
        peak = Math.max(peak, Math.abs(v.c[i]));
      }
      if (fresh) v.mag = clamp(SYMPATHETIC_PX / (peak * o.ppm), 1, 150);
      o.vib = v;
      resonated = true;
    }
    if (resonated) this.events.onResonate?.();
  }

  // ───────── 滑鼠／觸控備援 ─────────

  private get pointerPpm(): number {
    return this.stageW / POINTER_STAGE_METERS;
  }

  /** 滑鼠或單指是否正抓著端點、提著弦或正在拉新弦。 */
  get pointerBusy(): boolean {
    const pt = this.pointer;
    return pt.grab !== null || pt.carry !== null || pt.anchor !== null;
  }

  /** 觸控：兩指之間預覽一條新弦（相當於兩手捏合）。 */
  setPointerPreview(a: Vec, b: Vec): void {
    this.pointerPreview = { a: { ...a }, b: { ...b }, ppm: this.pointerPpm };
  }

  /** 觸控：任一指放開，把預覽中的弦定下來。 */
  commitPointerPreview(now: number): void {
    const pv = this.pointerPreview;
    this.pointerPreview = null;
    if (pv) this.createString(pv.a, pv.b, pv.ppm, now);
    this.tips[POINTER_KEY].prev = null;
    this.tips[POINTER_KEY].noPluckUntil = now + 250;
  }

  /**
   * 按下。滑鼠：拖曳空白處會拉出新弦。
   * 觸控（touch = true）：單指是「指尖」，可以撥弦、拖端點、搬弦身；拉新弦要用兩指。
   */
  pointerDown(pos: Vec, touch = false): void {
    const g = this.findEndpoint(pos, touch ? 30 : 16);
    this.tipGone(POINTER_KEY, false, 0);
    if (g) {
      this.pointer.grab = g;
      this.selected = g.s;
      return;
    }
    // 觸控時單指碰到弦身是撥弦（手指本來就會直接落在弦上），所以只有滑鼠能拖弦身搬移
    const body = touch ? null : this.findBody(pos, 10);
    if (body) {
      this.pointer.carry = { s: body, off: { x: body.a.x - pos.x, y: body.a.y - pos.y } };
      this.selected = body;
    } else if (!touch) {
      this.pointer.anchor = { ...pos };
    }
  }

  pointerMove(pos: Vec, pressed: boolean, hover: boolean, now: number): void {
    const pt = this.pointer;
    if (pt.last && now > pt.lastT) {
      const dt = (now - pt.lastT) / 1000;
      pt.vel = { x: (pos.x - pt.last.x) / dt, y: (pos.y - pt.last.y) / dt };
    }
    pt.last = { ...pos };
    pt.lastT = now;

    if (pt.grab) {
      this.moveEndpoint(pt.grab.s, pt.grab.end, pos, now);
    } else if (pt.carry) {
      this.translate(pt.carry.s, { x: pos.x + pt.carry.off.x, y: pos.y + pt.carry.off.y });
    } else if (pressed && pt.anchor) {
      this.pointerPreview = dist(pt.anchor, pos) > 8 ? { a: pt.anchor, b: { ...pos }, ppm: this.pointerPpm } : null;
    } else if (hover) {
      this.tipMove(POINTER_KEY, pos, pt.vel, now);
    }
  }

  pointerUp(pos: Vec, now: number): void {
    const pt = this.pointer;
    if (pt.grab) {
      this.snapLength(pt.grab.s, pt.grab.end === 0 ? 1 : 0, now);
      pt.grab = null;
    } else if (pt.carry) {
      pt.carry = null;
    } else if (this.pointerPreview) {
      const pv = this.pointerPreview;
      this.createString(pv.a, pv.b, pv.ppm, now);
    } else if (pt.anchor) {
      // 單純點一下：選取附近的弦，點空白處取消選取
      let best: AirString | null = null;
      let bestD = 14;
      for (const s of this.strings) {
        const { u, d } = project(pos, s.a, s.b);
        if (u >= 0 && u <= 1 && Math.abs(d) < bestD) {
          bestD = Math.abs(d);
          best = s;
        }
      }
      this.selected = best;
    }
    pt.anchor = null;
    this.pointerPreview = null;
    this.tips[POINTER_KEY].prev = null;
    this.tips[POINTER_KEY].noPluckUntil = now + 150;
  }

  /**
   * 滑鼠右鍵：在弦上放一個「輕觸點」（相當於另一根手指輕輕碰著），再按一次就拿掉。
   * 靠近 1/2、1/3 這類節點時會自動對齊。回傳是否有點到弦。
   */
  togglePin(pos: Vec, now: number): boolean {
    let best: AirString | null = null;
    let bestD = 14;
    let bestU = 0;
    for (const s of this.strings) {
      const { u, d } = project(pos, s.a, s.b);
      if (u > 0.02 && u < 0.98 && Math.abs(d) < bestD) {
        bestD = Math.abs(d);
        best = s;
        bestU = u;
      }
    }
    if (!best) return false;
    if (best.pin !== null && Math.abs(best.pin - bestU) < 0.04) {
      best.pin = null;
    } else {
      const node = P.nearestNode(bestU, 0.025);
      best.pin = node ? node.k / node.n : bestU;
    }
    this.dampingChanged(best, now);
    this.selected = best;
    return true;
  }

  pointerLeave(now: number): void {
    this.tipGone(POINTER_KEY, true, now);
    this.pointer.last = null;
  }

  // ───────── 每格更新 ─────────

  step(now: number, dt: number): void {
    const t = now / 1000;
    for (const s of this.strings) {
      if (!s.vib) continue;
      const peak = s.vibPeakPx(t);
      if (peak < 0.25) {
        s.vib = null;
      } else if (peak > 2.5 && Math.random() < dt * 14) {
        const u = Math.random();
        this.spawn(s.a.x + (s.b.x - s.a.x) * u, s.a.y + (s.b.y - s.a.y) * u, s.material.color, 60);
      }
    }

    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) {
        ps[i] = ps[ps.length - 1];
        ps.pop();
        continue;
      }
      p.vy += 260 * dt;
      p.vx *= 1 - 1.5 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.breaks = this.breaks.filter((b) => now - b.t0 < 700);
    this.fades = this.fades.filter((f) => now - f.t0 < 450);
  }

  private spawn(x: number, y: number, color: string, speed: number): void {
    if (this.particles.length >= this.maxParticles) return;
    const ang = Math.random() * Math.PI * 2;
    const v = speed * (0.3 + Math.random() * 0.7);
    const max = 0.35 + Math.random() * 0.55;
    this.particles.push({ x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v - speed * 0.3, life: max, max, color });
  }

  private burst(x: number, y: number, color: string, count: number, speed: number): void {
    for (let i = 0; i < count; i++) this.spawn(x, y, color, speed);
  }
}
