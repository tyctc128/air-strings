// 用假造的手部資料直接驅動遊戲邏輯，驗證拉弦、改長度、搬移、剪斷這些手勢的規則。
import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioEngine } from '../audio/engine';
import { materialById } from '../physics/materials';
import * as P from '../physics/string';
import type { PluckRecord } from '../teach/tasks';
import type { TrackedHand } from '../tracking/hands';
import type { Vec } from '../util/math';
import { Game } from './game';

const PPM = 1000; // 1 公尺 = 1000 像素，方便心算

const calls: string[] = [];
const fakeAudio = {
  pluck: () => calls.push('pluck'),
  retune: () => calls.push('retune'),
  damp: () => calls.push('damp'),
  clear: () => calls.push('clear'),
  snap: () => calls.push('snap'),
  excite: () => calls.push('excite'),
} as unknown as AudioEngine;

function hand(slot: number, over: Partial<TrackedHand> = {}): TrackedHand {
  const pos = over.pinchPos ?? over.tip ?? { x: -500, y: -500 };
  return {
    slot, present: true, lastSeen: 0, lm: Array.from({ length: 21 }, () => ({ ...pos })), ppm: PPM,
    pinchDist: 0.1, pinching: false, pinchSolid: false, pinchPos: { ...pos }, tip: { ...pos },
    tipVel: { x: 0, y: 0 }, label: slot === 0 ? 'Left' : 'Right', vPose: false, vGap: 0.02,
    openPalm: false, palm: { x: -900, y: -900 },
    ...over,
  };
}

const absent = (slot: number) => hand(slot, { present: false });
const pinch = (slot: number, pos: Vec) => hand(slot, { pinching: true, pinchSolid: true, pinchDist: 0.02, pinchPos: pos });

/** 剪刀手：食指尖在 a、中指尖在 b。 */
function scissors(slot: number, a: Vec, b: Vec, gap: number): TrackedHand {
  const h = hand(slot, { vPose: true, vGap: gap, tip: a });
  for (const i of [6, 7, 8]) h.lm[i] = { ...a };
  for (const i of [10, 11, 12]) h.lm[i] = { ...b };
  return h;
}

let game: Game;
let t: number;
/** 餵一格手部資料，時間前進 33 毫秒。 */
function frame(h0: TrackedHand, h1: TrackedHand): void {
  t += 33;
  game.updateHands([h0, h1], t);
}

/** 用兩手拉出一條從 a 到 b 的弦。 */
function make(a: Vec, b: Vec) {
  frame(pinch(0, a), pinch(1, b));
  frame(pinch(0, a), pinch(1, b));
  frame(hand(0), hand(1));
  return game.strings[game.strings.length - 1];
}

beforeEach(() => {
  game = new Game(fakeAudio);
  t = 1000;
  calls.length = 0;
});

describe('拉弦與改長度', () => {
  it('兩手捏合拉開再放開，產生一條長度正確的弦', () => {
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    expect(game.strings).toHaveLength(1);
    expect(s.length).toBeCloseTo(0.4, 6);
  });

  it('只有一隻手捏合不會產生弦', () => {
    frame(pinch(0, { x: 300, y: 400 }), hand(1));
    frame(hand(0), hand(1));
    expect(game.strings).toHaveLength(0);
  });

  it('捏住端點拖動會改變長度與頻率', () => {
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    const f = s.f0;
    frame(pinch(0, { x: 700, y: 400 }), absent(1));
    frame(pinch(0, { x: 500, y: 400 }), absent(1));
    expect(s.length).toBeCloseTo(0.2, 6);
    expect(s.f0 / f).toBeCloseTo(2, 2);
    expect(s.a).toEqual({ x: 300, y: 400 });
  });
});

describe('整條搬移', () => {
  it('單手捏住弦的中段可以提著整條弦走，長度與頻率不變', () => {
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    const f = s.f0;
    const at = { x: 500, y: 405 };
    for (let i = 0; i < 8; i++) frame(pinch(0, at), absent(1)); // 捏住不動，等搬移啟動
    expect(s.a).toEqual({ x: 300, y: 400 });
    frame(pinch(0, { x: 560, y: 325 }), absent(1));
    expect(s.a).toEqual({ x: 360, y: 320 });
    expect(s.b).toEqual({ x: 760, y: 320 });
    frame(hand(0), absent(1));
    frame(hand(0, { tip: { x: 100, y: 100 } }), absent(1));
    expect(s.a).toEqual({ x: 360, y: 320 }); // 放開後留在原地
    expect(s.length).toBeCloseTo(0.4, 6);
    expect(s.f0).toBeCloseTo(f, 6);
    expect(game.selected).toBe(s);
  });

  it('搬到畫面邊緣會被擋住，不會改變長度', () => {
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    for (let i = 0; i < 8; i++) frame(pinch(0, { x: 500, y: 400 }), absent(1));
    frame(pinch(0, { x: 5000, y: -3000 }), absent(1));
    expect(s.b.x).toBe(game.stageW);
    expect(s.a.y).toBe(0);
    expect(s.length).toBeCloseTo(0.4, 6);
  });

  it('兩手同時捏合時，即使一手剛好捏在既有的弦上，也是拉新弦而不是搬移', () => {
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    const a = { x: 500, y: 400 };
    for (let i = 0; i < 8; i++) frame(pinch(0, a), pinch(1, { x: 500, y: 150 }));
    frame(hand(0), hand(1));
    expect(game.strings).toHaveLength(2);
    expect(s.a).toEqual({ x: 300, y: 400 });
    expect(s.b).toEqual({ x: 700, y: 400 });
  });

  it('捏在端點是改長度，不是搬移', () => {
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    for (let i = 0; i < 8; i++) frame(pinch(0, { x: 702, y: 398 }), absent(1));
    frame(pinch(0, { x: 800, y: 400 }), absent(1));
    expect(s.a).toEqual({ x: 300, y: 400 });
    expect(s.b).toEqual({ x: 800, y: 400 });
  });
});

describe('剪斷', () => {
  it('剪刀張開夾住弦再合起來，那條弦被剪斷，其他弦不受影響', () => {
    const s1 = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    const s2 = make({ x: 300, y: 600 }, { x: 700, y: 600 });
    frame(scissors(0, { x: 500, y: 370 }, { x: 500, y: 430 }, 0.06), absent(1));
    expect(game.cutHints).toHaveLength(1);
    expect(game.cutHints[0].x).toBeCloseTo(500, 3);
    expect(game.strings).toHaveLength(2);
    frame(scissors(0, { x: 500, y: 392 }, { x: 500, y: 410 }, 0.018), absent(1));
    expect(game.strings).toEqual([s2]);
    expect(game.strings).not.toContain(s1);
    expect(game.breaks).toHaveLength(1);
    expect(game.breaks[0].u).toBeCloseTo(0.5, 3);
    expect(calls).toContain('snap');
  });

  it('剪刀沒有夾到弦時合起來不會剪到東西', () => {
    make({ x: 300, y: 400 }, { x: 700, y: 400 });
    frame(scissors(0, { x: 500, y: 100 }, { x: 500, y: 160 }, 0.06), absent(1));
    frame(scissors(0, { x: 500, y: 120 }, { x: 500, y: 140 }, 0.018), absent(1));
    expect(game.strings).toHaveLength(1);
  });

  it('比剪刀時手指穿過弦不會撥響它', () => {
    make({ x: 300, y: 400 }, { x: 700, y: 400 });
    frame(scissors(0, { x: 500, y: 300 }, { x: 560, y: 300 }, 0.06), absent(1));
    frame(scissors(0, { x: 500, y: 500 }, { x: 560, y: 500 }, 0.06), absent(1));
    expect(game.pluckCount).toBe(0);
  });

  it('一般伸出食指穿過弦會撥響', () => {
    make({ x: 300, y: 400 }, { x: 700, y: 400 });
    for (let i = 0; i < 12; i++) frame(hand(0, { tip: { x: 500, y: 300 } }), absent(1)); // 等放手後的緩衝時間過去
    frame(hand(0, { tip: { x: 500, y: 500 }, tipVel: { x: 0, y: 3000 } }), absent(1));
    expect(game.pluckCount).toBe(1);
    expect(calls).toContain('pluck');
  });

  it('Delete 只刪除選取的那條弦', () => {
    const s1 = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    const s2 = make({ x: 300, y: 600 }, { x: 700, y: 600 });
    game.select(s1);
    game.deleteSelected(t);
    expect(game.strings).toEqual([s2]);
    game.deleteSelected(t); // 沒有選取時不做事
    expect(game.strings).toEqual([s2]);
  });
});

describe('撥弦時的誤判捏合', () => {
  /** 讓放手後的緩衝時間過去，再用食指由上往下掃過 x 處的弦。 */
  function pluckAt(x: number): void {
    for (let i = 0; i < 12; i++) frame(hand(0, { tip: { x, y: 300 } }), absent(1));
    frame(hand(0, { tip: { x, y: 500 }, tipVel: { x: 0, y: 3000 } }), absent(1));
  }

  it('剛撥完弦就冒出來的捏合不會抓住端點、不會改變弦長', () => {
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    pluckAt(680);
    expect(game.pluckCount).toBe(1);
    frame(pinch(0, { x: 690, y: 420 }), absent(1));
    expect(game.pinchActive[0]).toBe(false);
    frame(pinch(0, { x: 640, y: 420 }), absent(1));
    frame(pinch(0, { x: 600, y: 420 }), absent(1));
    expect(s.b).toEqual({ x: 700, y: 400 });
    expect(s.length).toBeCloseTo(0.4, 6);
  });

  it('被擋下的捏合要先放開，之後刻意去捏端點仍然有效', () => {
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    pluckAt(680);
    for (let i = 0; i < 20; i++) frame(pinch(0, { x: 690, y: 420 }), absent(1)); // 一直捏著也不算
    expect(s.b).toEqual({ x: 700, y: 400 });
    for (let i = 0; i < 12; i++) frame(hand(0, { tip: { x: 690, y: 300 } }), absent(1));
    frame(pinch(0, { x: 696, y: 404 }), absent(1));
    expect(game.pinchActive[0]).toBe(true);
    frame(pinch(0, { x: 600, y: 400 }), absent(1));
    expect(s.b).toEqual({ x: 600, y: 400 });
  });

  it('食指正勾著弦的時候，捏合不會把弦搬走', () => {
    game.setMaterial(materialById('rubber')); // 橡皮筋張力低，可以勾著拉開好幾公分
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    for (let i = 0; i < 12; i++) frame(hand(0, { tip: { x: 500, y: 395 } }), absent(1));
    frame(hand(0, { tip: { x: 500, y: 410 } }), absent(1));
    expect(s.hook).not.toBeNull();
    for (let i = 0; i < 10; i++) frame(pinch(0, { x: 500, y: 410 }), absent(1));
    frame(pinch(0, { x: 560, y: 300 }), absent(1));
    expect(game.pinchActive[0]).toBe(false);
    expect(s.a).toEqual({ x: 300, y: 400 });
    expect(s.b).toEqual({ x: 700, y: 400 });
  });
});

describe('手掌止音', () => {
  const palmOn = (pos: Vec) => hand(0, { openPalm: true, palm: pos, tip: { x: pos.x, y: pos.y - 150 } });

  it('張開的手掌按在弦上，所有模態衰減加快；手拿開就恢復', () => {
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    const base = s.decay[0];
    frame(palmOn({ x: 500, y: 410 }), absent(1));
    expect(s.muted).toBe(true);
    expect(game.palmMuting[0]).toBe(true);
    expect(s.decay[0]).toBeCloseTo(base + P.PALM_DAMPING, 3);
    frame(palmOn({ x: 500, y: 200 }), absent(1));
    expect(s.muted).toBe(false);
    expect(s.decay[0]).toBeCloseTo(base, 5);
  });

  it('正在響的弦被手掌按住後，振幅很快掉下來', () => {
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    game.pluck(s, 0.3, 0.004, t);
    const before = s.vibPeakPx(t / 1000);
    frame(palmOn({ x: 500, y: 400 }), absent(1));
    expect(calls).toContain('retune');
    expect(s.vibPeakPx((t + 150) / 1000)).toBeLessThan(before * 0.05);
  });

  it('沒有張開的手（例如握拳）經過弦不會止音', () => {
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    frame(hand(0, { openPalm: false, palm: { x: 500, y: 400 }, tip: { x: 500, y: 250 } }), absent(1));
    expect(s.muted).toBe(false);
  });
});

describe('泛音', () => {
  /** 手指停在弦上 u 的位置幾格，讓輕觸成立。 */
  function touchAt(x: number): void {
    for (let i = 0; i < 20; i++) frame(hand(0, { tip: { x, y: 401 } }), absent(1));
  }

  it('手指靜靜停在弦的中點 → 成為輕觸點，而且不會把弦撥響', () => {
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    touchAt(500);
    expect(s.touch).not.toBeNull();
    expect(s.touchU).toBeCloseTo(0.5, 3);
    expect(game.pluckCount).toBe(0);
  });

  it('輕觸中點時撥弦：基音與奇數泛音立刻被吸收，只剩偶數泛音（高八度）', () => {
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    touchAt(500);
    game.pluck(s, 0.2, 0.004, t);
    const tau = 0.03; // 30 毫秒後
    const left = (i: number) => Math.abs(s.vib!.c[i]) * Math.exp(-s.decay[i] * tau);
    expect(left(0)).toBeLessThan(left(1) * 0.01); // 基音 << 第 2 泛音
    expect(left(2)).toBeLessThan(left(1) * 0.01); // 第 3 泛音 << 第 2 泛音
    expect(left(1)).toBeGreaterThan(Math.abs(s.vib!.c[1]) * 0.9); // 第 2 泛音幾乎沒被影響
  });

  it('手指離開後，輕觸解除，衰減率恢復', () => {
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    const base = s.decay[0];
    touchAt(500);
    expect(s.decay[0]).toBeGreaterThan(base + 250);
    frame(hand(0, { tip: { x: 500, y: 300 } }), absent(1));
    expect(s.touch).toBeNull();
    expect(s.decay[0]).toBeCloseTo(base, 5);
    expect(game.pluckCount).toBe(0);
  });

  it('手指慢慢停在弦上、沒有做泛音，接著從另一側穿出去 → 算一次撥弦', () => {
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    for (let i = 0; i < 12; i++) frame(hand(0, { tip: { x: 500, y: 380 } }), absent(1)); // 從上方靠近
    touchAt(500);
    expect(s.touch).not.toBeNull();
    frame(hand(0, { tip: { x: 500, y: 420 }, tipVel: { x: 0, y: 500 } }), absent(1)); // 往下穿出去
    expect(s.touch).toBeNull();
    expect(game.pluckCount).toBe(1);
  });

  it('停在弦上之後退回原本那一側 → 不發聲', () => {
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    for (let i = 0; i < 12; i++) frame(hand(0, { tip: { x: 500, y: 380 } }), absent(1));
    touchAt(500);
    frame(hand(0, { tip: { x: 500, y: 370 }, tipVel: { x: 0, y: -500 } }), absent(1));
    expect(s.touch).toBeNull();
    expect(game.pluckCount).toBe(0);
  });

  it('做完泛音之後，輕觸的手指穿過弦離開也不會把泛音蓋掉', () => {
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    for (let i = 0; i < 12; i++) frame(hand(0, { tip: { x: 500, y: 380 } }), absent(1));
    touchAt(500);
    game.pluck(s, 0.2, 0.004, t); // 另一隻手撥弦
    expect(game.pluckCount).toBe(1);
    frame(hand(0, { tip: { x: 500, y: 420 }, tipVel: { x: 0, y: 500 } }), absent(1));
    expect(game.pluckCount).toBe(1);
  });

  it('手指快速穿過弦是撥弦，不是輕觸', () => {
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    for (let i = 0; i < 12; i++) frame(hand(0, { tip: { x: 500, y: 300 } }), absent(1));
    frame(hand(0, { tip: { x: 500, y: 500 }, tipVel: { x: 0, y: 3000 } }), absent(1));
    expect(s.touch).toBeNull();
    expect(game.pluckCount).toBe(1);
  });

  it('滑鼠右鍵在弦上放置觸點，靠近 1/3 會對齊；再按一次移除', () => {
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    expect(game.togglePin({ x: 436, y: 403 }, t)).toBe(true);
    expect(s.pin).toBeCloseTo(1 / 3, 9);
    expect(s.decay[2] - s.modes.decay[2]).toBeLessThan(1e-3); // 第 3 泛音不受影響
    expect(s.decay[0] - s.modes.decay[0]).toBeGreaterThan(200);
    game.togglePin({ x: 434, y: 400 }, t);
    expect(s.pin).toBeNull();
    expect(game.togglePin({ x: 100, y: 100 }, t)).toBe(false);
  });
});

describe('共鳴', () => {
  it('撥一條弦，音高相同的另一條弦會被帶動；音高不相干的不會', () => {
    const a = make({ x: 300, y: 300 }, { x: 700, y: 300 });
    const same = make({ x: 300, y: 450 }, { x: 700, y: 450 });
    const other = make({ x: 300, y: 600 }, { x: 592, y: 600 }); // 長度 0.73 倍，頻率不成簡單比例
    calls.length = 0;
    game.pluck(a, 0.2, 0.004, t);
    expect(same.vib).not.toBeNull();
    expect(other.vib).toBeNull();
    expect(calls.filter((c) => c === 'excite')).toHaveLength(1);
    // 被帶動的振幅遠小於被撥的那條
    const peak = (s: typeof a) => Math.max(...[...s.vib!.c].map(Math.abs));
    expect(peak(same)).toBeLessThan(peak(a) * 0.2);
    expect(peak(same)).toBeGreaterThan(0);
  });

  it('低八度的弦會帶動高八度的弦', () => {
    const low = make({ x: 200, y: 300 }, { x: 1000, y: 300 });
    const high = make({ x: 200, y: 450 }, { x: 600, y: 450 });
    expect(high.f0 / low.f0).toBeCloseTo(2, 1);
    game.pluck(low, 0.2, 0.004, t);
    expect(high.vib).not.toBeNull();
  });
});

describe('展覽模式的音階吸附', () => {
  const centsOff = (f: number) => Math.abs(1200 * Math.log2(f / P.snapFrequency(f, P.PENTATONIC)));

  it('教學模式不吸附：拉多長就是多長', () => {
    const s = make({ x: 300, y: 400 }, { x: 733, y: 400 });
    expect(s.length).toBeCloseTo(0.433, 6);
  });

  it('展覽模式放手時，弦長微調到五聲音階上', () => {
    game.setMode('exhibit');
    const s = make({ x: 300, y: 400 }, { x: 733, y: 400 });
    expect(centsOff(s.f0)).toBeLessThan(1);
    expect(Math.abs(s.length - 0.433)).toBeLessThan(0.433 * 0.1); // 只是微調
    expect((s.a.x + s.b.x) / 2).toBeCloseTo(516.5, 0); // 以中點為準伸縮
  });

  it('展覽模式拖完端點放手也會吸附，另一端不動', () => {
    game.setMode('exhibit');
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    const a0 = { ...s.a }; // 建立時已經吸附過一次，端點不在原本捏的位置
    for (let i = 0; i < 12; i++) frame(hand(0), absent(1));
    frame(pinch(0, { x: s.b.x, y: 400 }), absent(1));
    frame(pinch(0, { x: 640, y: 400 }), absent(1));
    frame(hand(0), absent(1));
    expect(centsOff(s.f0)).toBeLessThan(1);
    expect(s.b.x).toBeGreaterThan(600);
    expect(s.b.x).toBeLessThan(680);
    expect(s.a).toEqual(a0);
  });
});

describe('給任務卡的事件', () => {
  it('撥弦時回報那條弦當下的材質、張力、長度與頻率', () => {
    const got: PluckRecord[] = [];
    game.events.onPluck = (r) => got.push(r);
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    game.pluck(s, 0.3, 0.004, t);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ stringId: s.id, materialId: 'steel', tension: 80, touchNode: null });
    expect(got[0].length).toBeCloseTo(0.4, 6);
    expect(got[0].f0).toBeCloseTo(s.f0, 6);
  });

  it('輕觸在 1/2 處撥弦時，回報的節點是 1/2', () => {
    const got: PluckRecord[] = [];
    game.events.onPluck = (r) => got.push(r);
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    game.togglePin({ x: 500, y: 400 }, t);
    game.pluck(s, 0.2, 0.004, t);
    expect(got[0].touchNode).toEqual({ k: 1, n: 2 });
  });

  it('拉斷、共鳴、按停正在響的弦各回報一次', () => {
    const seen: string[] = [];
    game.events.onBreak = (b) => seen.push(`break:${b.materialId}`);
    game.events.onResonate = () => seen.push('resonate');
    game.events.onMute = () => seen.push('mute');
    const a = make({ x: 300, y: 300 }, { x: 700, y: 300 });
    make({ x: 300, y: 450 }, { x: 700, y: 450 });
    game.pluck(a, 0.2, 0.004, t);
    expect(seen).toEqual(['resonate']);
    frame(hand(0, { openPalm: true, palm: { x: 500, y: 300 }, tip: { x: 500, y: 150 } }), absent(1));
    expect(seen).toContain('mute');
    game.select(a);
    game.setTension(500, t);
    expect(seen).toContain('break:steel');
  });

  it('按住一條沒在響的弦不算止音', () => {
    let mutes = 0;
    game.events.onMute = () => mutes++;
    make({ x: 300, y: 400 }, { x: 700, y: 400 });
    frame(hand(0, { openPalm: true, palm: { x: 500, y: 400 }, tip: { x: 500, y: 250 } }), absent(1));
    expect(mutes).toBe(0);
  });
});

describe('觸控', () => {
  it('單指拖曳不會拉出新弦；兩指之間才會', () => {
    game.pointerDown({ x: 300, y: 400 }, true);
    game.pointerMove({ x: 700, y: 400 }, true, true, t);
    game.pointerUp({ x: 700, y: 400 }, t);
    expect(game.strings).toHaveLength(0);

    game.pointerDown({ x: 300, y: 400 }, true);
    expect(game.pointerBusy).toBe(false);
    game.setPointerPreview({ x: 300, y: 400 }, { x: 700, y: 400 });
    game.setPointerPreview({ x: 300, y: 400 }, { x: 800, y: 400 });
    game.commitPointerPreview(t);
    expect(game.strings).toHaveLength(1);
    expect(game.strings[0].b).toEqual({ x: 800, y: 400 });
    expect(game.pointerPreview).toBeNull();
  });

  it('單指劃過弦會撥響它', () => {
    make({ x: 300, y: 400 }, { x: 700, y: 400 });
    game.pointerDown({ x: 500, y: 300 }, true);
    game.pointerMove({ x: 500, y: 320 }, true, true, t + 500);
    game.pointerMove({ x: 500, y: 480 }, true, true, t + 520);
    expect(game.pluckCount).toBe(1);
  });

  it('單指按在端點上可以拖動改長度', () => {
    const s = make({ x: 300, y: 400 }, { x: 700, y: 400 });
    game.pointerDown({ x: 715, y: 410 }, true);
    expect(game.pointerBusy).toBe(true);
    game.pointerMove({ x: 600, y: 400 }, true, true, t);
    game.pointerUp({ x: 600, y: 400 }, t);
    expect(s.b).toEqual({ x: 600, y: 400 });
  });
});

describe('滑鼠', () => {
  it('拖曳弦身會整條搬移，拖曳空白處會拉出新弦', () => {
    game.pointerDown({ x: 300, y: 400 });
    game.pointerMove({ x: 700, y: 400 }, true, false, t);
    game.pointerUp({ x: 700, y: 400 }, t);
    const s = game.strings[0];
    const len = s.length;

    game.pointerDown({ x: 500, y: 402 });
    game.pointerMove({ x: 520, y: 302 }, true, false, t + 10);
    game.pointerUp({ x: 520, y: 302 }, t + 20);
    expect(game.strings).toHaveLength(1);
    expect(s.a).toEqual({ x: 320, y: 300 });
    expect(s.b).toEqual({ x: 720, y: 300 });
    expect(s.length).toBeCloseTo(len, 9);
  });
});
