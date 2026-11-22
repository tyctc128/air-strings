// 弦的物理：全部是純函式，單位一律用 SI（公尺、公斤、秒、牛頓、赫茲）。
//
// 模型：兩端固定、有彎曲剛性、有阻尼的弦，以簡正模態疊加求解。
//   基頻        f1 = (1/2L)·√(T/μ)
//   非諧性      fn = n·f1·√(1 + B·n²)，B = π²·E·I / (T·L²)
//   阻尼        αn = 空氣阻力 + 材料內耗 + 端點損耗（每秒的振幅衰減率）
//   撥弦初始形狀為三角形，展開成各模態的振幅

import type { Material } from './materials';

const ETA_AIR = 1.8e-5; // 空氣動黏度 kg/(m·s)
const RHO_AIR = 1.2; // 空氣密度 kg/m³

/** 端點（弦釘）的導納 s/kg：真實的固定點不是完全剛性，每次反射會吸收一點能量。 */
export const SUPPORT_MOBILITY = 2e-3;
/** 指尖寬度 m：撥弦時三角形的尖角其實是被指尖撐圓的，會削弱高次泛音。 */
export const FINGER_WIDTH = 0.012;

/** 承受張力的截面積 m²（纏弦只有芯線受力）。 */
export function loadArea(m: Material, d: number): number {
  const dc = m.wound ? d * m.wound.coreRatio : d;
  return (Math.PI * dc * dc) / 4;
}

/** 線密度 μ，kg/m。 */
export function linearDensity(m: Material, d: number): number {
  const area = (Math.PI * d * d) / 4;
  if (!m.wound) return m.density * area;
  const core = loadArea(m, d);
  return m.density * core + m.wound.wrapDensity * m.wound.fill * (area - core);
}

/** 彎曲剛性 E·I，N·m²（纏弦只算芯線）。 */
export function bendingStiffness(m: Material, d: number): number {
  const dc = m.wound ? d * m.wound.coreRatio : d;
  return (m.youngs * Math.PI * dc ** 4) / 64;
}

/** 斷裂張力 N。 */
export function breakingTension(m: Material, d: number): number {
  return m.strength * loadArea(m, d);
}

/** 目前張力佔斷裂張力的比例（≥1 就會斷）。 */
export function stressRatio(m: Material, d: number, tension: number): number {
  return tension / breakingTension(m, d);
}

/** 理想弦的基頻 Hz。 */
export function fundamental(m: Material, d: number, tension: number, length: number): number {
  return Math.sqrt(tension / linearDensity(m, d)) / (2 * length);
}

/** 非諧性係數 B（無因次）。 */
export function inharmonicity(m: Material, d: number, tension: number, length: number): number {
  return (Math.PI ** 2 * bendingStiffness(m, d)) / (tension * length * length);
}

/** 第 n 個模態的頻率 Hz（n 從 1 起算）。 */
export function modeFrequency(m: Material, d: number, tension: number, length: number, n: number): number {
  const f1 = fundamental(m, d, tension, length);
  const B = inharmonicity(m, d, tension, length);
  return n * f1 * Math.sqrt(1 + B * n * n);
}

/** 第 n 個模態的振幅衰減率 α（1/s），振幅隨 e^(−αt) 衰減。 */
export function modeDecay(m: Material, d: number, tension: number, length: number, n: number): number {
  const mu = linearDensity(m, d);
  const f1 = fundamental(m, d, tension, length);
  const fn = modeFrequency(m, d, tension, length, n);

  // 空氣黏滯阻力（Valette）：單位長度阻力係數 R
  const R = 2 * Math.PI * ETA_AIR + 2 * Math.PI * d * Math.sqrt(Math.PI * ETA_AIR * RHO_AIR * fn);
  const air = R / (2 * mu);

  // 材料內耗（Woodhouse）：張力儲能幾乎無損，彎曲儲能的損耗較大
  const k = (n * Math.PI) / length;
  const bend = bendingStiffness(m, d) * k * k;
  const eta = (tension * m.etaF + bend * m.etaB) / (tension + bend);
  const internal = Math.PI * fn * eta;

  // 端點損耗：每個來回反射兩次，每次反射係數 r = (1−ZG)/(1+ZG)
  const zg = Math.min(Math.sqrt(tension * mu) * SUPPORT_MOBILITY, 0.9);
  const end = -2 * f1 * Math.log((1 - zg) / (1 + zg));

  return air + internal + end;
}

export interface ModeSet {
  count: number;
  freq: Float32Array;
  decay: Float32Array;
}

/** 算出可聽範圍內的所有模態（至少 1 個、最多 maxModes 個）。 */
export function computeModes(
  m: Material, d: number, tension: number, length: number, maxModes = 64, maxFreq = 16000,
): ModeSet {
  const freq = new Float32Array(maxModes);
  const decay = new Float32Array(maxModes);
  let count = 0;
  for (let n = 1; n <= maxModes; n++) {
    const f = modeFrequency(m, d, tension, length, n);
    if (n > 1 && f > maxFreq) break;
    freq[count] = f;
    decay[count] = modeDecay(m, d, tension, length, n);
    count++;
  }
  return { count, freq: freq.subarray(0, count), decay: decay.subarray(0, count) };
}

function fingerFilter(n: number, length: number, width: number): number {
  const x = (n * Math.PI * width) / (2 * length);
  return x < 1e-6 ? 1 : Math.sin(x) / x;
}

/**
 * 撥弦後各模態的位移振幅 cn（m）。
 * 初始形狀是高度 h、頂點在 p·L 的三角形：cn = 2h·sin(nπp) / (n²π²·p·(1−p))
 */
export function displacementAmplitudes(
  h: number, p: number, length: number, count: number, width = FINGER_WIDTH,
): Float32Array {
  const out = new Float32Array(count);
  const k = (2 * h) / (Math.PI * Math.PI * p * (1 - p));
  for (let i = 0; i < count; i++) {
    const n = i + 1;
    out[i] = ((k * Math.sin(n * Math.PI * p)) / (n * n)) * fingerFilter(n, length, width);
  }
  return out;
}

/**
 * 撥弦後弦對端點施力的各模態振幅 An（N）——這就是虛擬拾音器收到的訊號。
 * An = T·cn·nπ/L = 2F·sin(nπp)/(nπ)，只跟撥弦力道 F 與位置 p 有關。
 */
export function forceAmplitudes(
  force: number, p: number, length: number, count: number, width = FINGER_WIDTH,
): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const n = i + 1;
    out[i] = ((2 * force * Math.sin(n * Math.PI * p)) / (n * Math.PI)) * fingerFilter(n, length, width);
  }
  return out;
}

/** 用力 F 把弦在 p 處勾開，平衡時的位移 h（m）：F = T·h·(1/a + 1/(L−a))。 */
export function slipDisplacement(force: number, tension: number, length: number, p: number): number {
  return (force * length * p * (1 - p)) / tension;
}

/** 把弦在 p 處拉開 h 所需的力（N）。 */
export function holdForce(h: number, tension: number, length: number, p: number): number {
  return (tension * h) / (length * p * (1 - p));
}

// ───────── 止音與泛音：外加的阻尼 ─────────

/** 手掌整個按在弦上時，所有模態額外增加的衰減率（1/s）。 */
export const PALM_DAMPING = 28;
/** 手指輕觸弦上一點時，該點振幅最大的模態額外增加的衰減率（1/s）。 */
export const TOUCH_DAMPING = 300;

/**
 * 手指輕觸在位置 q（0〜1）時，第 n 個模態額外的衰減率：γ = Γ·sin²(nπq)。
 * 手指吸收能量的快慢正比於該模態在觸點的振動能量——
 * 觸點剛好是節點的模態（sin = 0）完全不受影響，這就是泛音的原理。
 */
export function touchDamping(n: number, q: number): number {
  const s = Math.sin(n * Math.PI * q);
  return TOUCH_DAMPING * s * s;
}

/** 把弦本身的衰減率加上手掌止音（mute，1/s）與輕觸點（touch，0〜1 或 null）的影響。 */
export function effectiveDecay(base: Float32Array, mute: number, touch: number | null): Float32Array {
  const out = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) {
    out[i] = base[i] + mute + (touch === null ? 0 : touchDamping(i + 1, touch));
  }
  return out;
}

/** 位置 u 是否落在某個簡單節點（k/n，n ≤ 6）附近；是的話回傳最簡分數。 */
export function nearestNode(u: number, tolerance = 0.02): { k: number; n: number } | null {
  for (let n = 2; n <= 6; n++) {
    for (let k = 1; k < n; k++) {
      if (gcd(k, n) === 1 && Math.abs(u - k / n) <= tolerance) return { k, n };
    }
  }
  return null;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

// ───────── 共鳴 ─────────

/**
 * 共鳴的耦合強度（假設值）：真實樂器的弦透過琴橋與面板互相傳遞振動，
 * 我們的弦懸在空中沒有琴身，所以假設所有弦的端點共用一個微弱的耦合，
 * 被驅動的模態大約得到來源泛音受力的這個比例。
 */
export const SYMPATHETIC_COUPLING = 0.12;
/** 頻率相差多少音分時響應降為一半／完全不響應。 */
const SYMPATHETIC_WIDTH = 10;
const SYMPATHETIC_CUTOFF = 40;

/** 以頻率 fDrive 驅動固有頻率 fMode 的模態時的相對響應（0〜1）：越接近越強。 */
export function sympatheticGain(fDrive: number, fMode: number): number {
  const cents = Math.abs(1200 * Math.log2(fDrive / fMode));
  if (cents >= SYMPATHETIC_CUTOFF) return 0;
  const x = cents / SYMPATHETIC_WIDTH;
  return 1 / (1 + x * x);
}

/**
 * 來源弦被撥動後，目標弦各模態被帶動的端點受力振幅（N）。
 * 目標弦的每個模態只認來源弦裡頻率最接近、響應最強的那個泛音。
 */
export function sympatheticForces(
  srcFreq: Float32Array, srcForce: Float32Array, dstFreq: Float32Array, count: number,
): Float32Array {
  const n = Math.min(count, dstFreq.length);
  const out = new Float32Array(n);
  for (let m = 0; m < n; m++) {
    let best = 0;
    for (let i = 0; i < srcFreq.length && i < srcForce.length; i++) {
      const g = sympatheticGain(srcFreq[i], dstFreq[m]) * srcForce[i];
      if (Math.abs(g) > Math.abs(best)) best = g;
    }
    out[m] = SYMPATHETIC_COUPLING * best;
  }
  return out;
}

// ───────── 音階 ─────────

/** 大調五聲音階（Do Re Mi Sol La）的音級。 */
export const PENTATONIC = [0, 2, 4, 7, 9];

/** 把頻率移到指定音階裡最接近的音（十二平均律，A4 = 440 Hz）。 */
export function snapFrequency(freq: number, pitchClasses: number[]): number {
  const exact = 69 + 12 * Math.log2(freq / 440);
  let best = Math.round(exact);
  let bestD = Infinity;
  for (let m = Math.floor(exact) - 6; m <= Math.ceil(exact) + 6; m++) {
    if (!pitchClasses.includes(((m % 12) + 12) % 12)) continue;
    const d = Math.abs(m - exact);
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return 440 * Math.pow(2, (best - 69) / 12);
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const SOLFEGE = ['Do', 'Do♯', 'Re', 'Re♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];

export interface NoteInfo {
  /** 例：C♯4 */
  name: string;
  /** 例：Do♯ */
  solfege: string;
  octave: number;
  /** 與最近的十二平均律音高差幾音分（−50〜+50） */
  cents: number;
  midi: number;
}

/** 頻率對應的最近音名（A4 = 440 Hz）。 */
export function noteInfo(freq: number): NoteInfo {
  const exact = 69 + 12 * Math.log2(freq / 440);
  const midi = Math.round(exact);
  const idx = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return {
    name: `${NOTE_NAMES[idx]}${octave}`,
    solfege: SOLFEGE[idx],
    octave,
    cents: Math.round((exact - midi) * 100),
    midi,
  };
}
